// ESP8266EX firmware (this board is not an ESP32).
// Joins office Wi-Fi, long-polls the Worker, scans the Xerox over eSCL and
// streams queued PDFs into it on port 9100.
// Nothing is stored on the board. Scans and prints are relayed a buffer at a
// time, in one pass, so neither RAM nor flash puts a ceiling on a document.

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <Ticker.h>
#include "secrets.h"
#include "snmp.h"

// ---- status LED ------------------------------------------------------------
// The onboard LED is GPIO2 and active LOW. It is driven off a timer rather than
// from loop(), because loop() spends most of its life parked in a 20-second
// long-poll; a light driven from there would sit still for 20 seconds at a time
// and tell you nothing. On a timer, a still LED means the board is dead or
// unpowered, and nothing else.
//
// One 100 ms step per bit, so each pattern is a 1.6 s cycle. The rhythms form a
// ladder you can read across a room: solid means idle, and the busier the board
// is the faster it blinks. Dark-with-a-blip is the only unhappy one.
static const uint8_t STATUS_LED = LED_BUILTIN;
static const uint16_t LED_IDLE       = 0b1111111111111111;  // solid: powered, online, nothing to do
static const uint16_t LED_SCANNING   = 0b1111111100000000;  // slow, 800 on 800 off
static const uint16_t LED_PRINTING   = 0b1111000011110000;  // medium, 400 on 400 off
static const uint16_t LED_CONNECTING = 0b1010101010101010;  // fast, joining Wi-Fi
static const uint16_t LED_OFFLINE    = 0b1000000000000000;  // a blip in the dark: no Wi-Fi

static Ticker statusTicker;
static volatile uint16_t ledPattern = LED_CONNECTING;
static volatile uint8_t ledStep = 0;

void tickStatusLed() {
  bool on = (ledPattern >> (15 - ledStep)) & 1;
  digitalWrite(STATUS_LED, on ? LOW : HIGH);  // active LOW
  ledStep = (ledStep + 1) & 15;
}

void setLedPattern(uint16_t pattern) {
  if (ledPattern != pattern) {
    ledPattern = pattern;
    ledStep = 0;
  }
}

// The printer can stall mid-document while it renders the next band. Eight
// seconds was cutting scans short; a stall this long is a real fault.
static const uint32_t SCAN_IDLE_TIMEOUT_MS = 25000;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("nexdash-bridge boot");
  // A crash and a power-on look identical in the log without this. "Soft WDT
  // reset" or an exception here means the firmware died rather than the mains.
  Serial.printf("reset reason: %s  heap %u\n", ESP.getResetReason().c_str(),
                (unsigned)ESP.getFreeHeap());
  // Started before anything that can block, so the light proves power even if
  // Wi-Fi never comes up.
  pinMode(STATUS_LED, OUTPUT);
  setLedPattern(LED_CONNECTING);
  statusTicker.attach_ms(100, tickStatusLed);
  // TLS is CPU-bound on this chip; the relay rate roughly tracks this number.
  Serial.printf("cpu %u MHz\n", ESP.getCpuFreqMHz());
  WiFi.mode(WIFI_STA);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("wifi ");
  Serial.println(WIFI_SSID);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    setLedPattern(LED_IDLE);
    Serial.print("ip ");
    Serial.println(WiFi.localIP());
  } else {
    setLedPattern(LED_OFFLINE);
    Serial.println("wifi failed");
  }
}

String jsonField(String body, const char *key) {
  String needle = String("\"") + key + "\":\"";
  int i = body.indexOf(needle);
  if (i < 0) {
    needle = String("\"") + key + "\": \"";
    i = body.indexOf(needle);
  }
  if (i < 0) {
    return "";
  }
  int start = i + needle.length();
  int end = body.indexOf("\"", start);
  if (end < 0) {
    return "";
  }
  return body.substring(start, end);
}

bool isHttps(String url) { return url.startsWith("https://"); }

void addAuth(HTTPClient &http) {
  http.addHeader("Authorization", String("Bearer ") + BRIDGE_TOKEN);
}

int httpGetSmall(String url, String &out, bool auth) {
  HTTPClient http;
  int code = -1;
  out = "";
  http.setTimeout(25000);
  http.setReuse(true);
  if (isHttps(url)) {
    BearSSL::WiFiClientSecure client;
    client.setInsecure();
    if (!http.begin(client, url)) {
      return -1;
    }
    if (auth) {
      addAuth(http);
    }
    code = http.GET();
    if (code > 0) {
      out = http.getString();
    }
    http.end();
    return code;
  }
  WiFiClient client;
  if (!http.begin(client, url)) {
    return -1;
  }
  if (auth) {
    addAuth(http);
  }
  code = http.GET();
  if (code > 0) {
    out = http.getString();
  }
  http.end();
  return code;
}

int httpPostBytes(String url, const char *ctype, uint8_t *data, size_t len, String &out, bool auth) {
  HTTPClient http;
  int code = -1;
  out = "";
  http.setTimeout(180000);
  http.setReuse(true);
  if (isHttps(url)) {
    BearSSL::WiFiClientSecure client;
    client.setInsecure();
    if (!http.begin(client, url)) {
      return -1;
    }
    if (auth) {
      addAuth(http);
    }
    http.addHeader("Content-Type", ctype);
    code = http.POST(data, len);
    if (code > 0) {
      out = http.getString();
    }
    http.end();
    return code;
  }
  WiFiClient client;
  if (!http.begin(client, url)) {
    return -1;
  }
  if (auth) {
    addAuth(http);
  }
  http.addHeader("Content-Type", ctype);
  code = http.POST(data, len);
  if (code > 0) {
    out = http.getString();
  }
  http.end();
  return code;
}

bool collectLocation(HTTPClient &http, String printerBase, String &loc) {
  loc = http.header("Location");
  if (loc.length() == 0) {
    return false;
  }
  if (loc.startsWith("/")) {
    loc = printerBase + loc;
  }
  return true;
}

int startScanJob(String printerBase, const char *xml, String &loc) {
  loc = "";
  HTTPClient http;
  http.setTimeout(30000);
  WiFiClient client;
  if (!http.begin(client, printerBase + "/eSCL/ScanJobs")) {
    return -1;
  }
  const char *keys[] = {"Location"};
  http.collectHeaders(keys, 1);
  http.addHeader("Content-Type", "text/xml");
  int code = http.POST((uint8_t *)xml, strlen(xml));
  if (code == 200 || code == 201) {
    collectLocation(http, printerBase, loc);
  }
  http.end();
  return code;
}

void postError(String resultUrl, const char *encoded) {
  String unused;
  httpPostBytes(resultUrl + "&error=" + encoded, "text/plain", NULL, 0, unused, true);
}

static const char *HR_DEVICE_STATUS = "1.3.6.1.2.1.25.3.5.1.1.1";  // 3 idle, 4 printing, 5 warmup
static uint32_t lastTelemetry = 0;
// The feeder state the Worker last accepted, so a change can be sent at once
// instead of waiting out the 60 s telemetry interval.
static String lastAdf;

// True while bytes are being relayed to port 9100 or the printer is being
// waited on. Nothing optional runs in that window.
static bool printInFlight = false;

/**
 * pwg:State from the printer's eSCL endpoint: "Idle", "Processing", or empty
 * if it cannot be reached.
 *
 * Asked over HTTP/1.0 deliberately. Over 1.1 this printer answers
 * Transfer-Encoding: chunked, and ESP8266HTTPClient only de-chunks inside
 * getString(), so a 1.1 response arrives with chunk-size lines mixed in.
 */
/**
 * Reads the scanner's own status: whether it is idle, and whether there is
 * paper in the feeder.
 *
 * The feeder state has no other source. SNMP does not carry it, so before this
 * the dashboard showed "ADF unknown" permanently -- and since the Scan screen
 * disables the Feeder option when it knows the tray is empty, "unknown" meant
 * that guard never fired and someone could start a feeder scan with nothing
 * in it.
 *
 * Asked over HTTP/1.0 deliberately. Over 1.1 this printer answers
 * Transfer-Encoding: chunked, and ESP8266HTTPClient only de-chunks inside
 * getString(), so a 1.1 response would arrive with chunk-size lines mixed in.
 */
static String tagValue(const String &body, const char *tag) {
  const String open = String("<") + tag + ">";
  const int a = body.indexOf(open);
  if (a < 0) {
    return "";
  }
  const int b = body.indexOf('<', a + open.length());
  if (b <= a) {
    return "";
  }
  String v = body.substring(a + open.length(), b);
  v.trim();
  return v;
}

void scannerStatus(const String &printer, String &state, String &adf) {
  state = "";
  adf = "";
  HTTPClient http;
  WiFiClient client;
  http.setTimeout(6000);
  http.useHTTP10(true);
  if (!http.begin(client, "http://" + printer + "/eSCL/ScannerStatus")) {
    return;
  }
  if (http.GET() == 200) {
    const String body = http.getString();
    state = tagValue(body, "pwg:State");
    adf = tagValue(body, "scan:AdfState");
  }
  http.end();
}

/**
 * Is the printer there, and is it busy. That is the whole job now.
 *
 * This used to gather toner levels, tray levels, alerts, the model, the
 * serial, the console message and the page count, for a Supplies screen that
 * no longer exists: 33 SNMP queries and, whenever SNMP was quiet, a 32 KB
 * JSON document streamed off the printer's web interface and parsed a field
 * at a time -- every minute. The only consumer left is the dashboard deciding
 * whether to show the printing animation, and that needs one word.
 *
 * SNMP answers it in a single query. When SNMP is quiet, which this printer
 * does for hours at a stretch, eSCL's ScannerStatus is asked instead: 4 KB,
 * and it at least proves the printer is on the network.
 */
bool postTelemetry(const String &printer, bool force = false) {
  if (!force && millis() - lastTelemetry < 60000 && lastTelemetry != 0) {
    return false;
  }
  lastTelemetry = millis();

  const int statusN = snmpInt(printer.c_str(), HR_DEVICE_STATUS);
  bool online = statusN != -999999;
  const char *status = "Unknown";
  if (statusN == 3) status = "Idle";
  else if (statusN == 4) status = "Printing";
  else if (statusN == 5) status = "Warmup";
  else if (statusN == 6) status = "Stopped";
  else if (statusN == 7) status = "Offline";

  // Asked every cycle now, not only when SNMP is quiet: the feeder state has
  // no other source. Skipped during a print, when the relay socket is open and
  // nothing optional should run.
  String adf;
  if (!printInFlight) {
    String state;
    scannerStatus(printer, state, adf);
    if (!online && state.length()) {
      // Answering over HTTP means it is on the network whatever SNMP thinks.
      // The scanner's state says nothing about the print engine, so this never
      // claims Printing -- only that the printer is answering.
      online = true;
      status = state == "Idle" ? "Idle" : "Busy";
    }
  }

  String json = "{\"online\":";
  json += online ? "true" : "false";
  json += ",\"status\":\"" + String(status) + "\"";
  if (adf.length()) {
    json += ",\"adf\":\"" + adf + "\"";
  }
  json += ",\"checked_at\":" + String((uint32_t)(millis() / 1000)) + "}";

  String unused;
  const String url = String(API_BASE) + "/bridge/telemetry";
  const int posted = httpPostBytes(url.c_str(), "application/json",
                                   (uint8_t *)json.c_str(), json.length(), unused, true);
  // The answer was thrown away before, which is how a Worker rejecting every
  // report with 400 went unnoticed for hours: the board kept posting happily
  // into a bin.
  if (posted != 200) {
    Serial.printf("telemetry REJECTED %d %s\n", posted, unused.c_str());
  } else if (adf.length()) {
    lastAdf = adf;
  }
  Serial.printf("telemetry %s  adf=%s  heap=%u\n", online ? status : "offline",
                adf.length() ? adf.c_str() : "-", (unsigned)ESP.getFreeHeap());
  return true;
}

/**
 * Sends a report now if the feeder has changed since the last one.
 *
 * Loading paper used to take up to 80 s to reach the dashboard: telemetry
 * goes at most once a minute, and only between 20 s long-polls. The Scan
 * screen keeps Feeder disabled while it thinks the tray is empty, so that
 * whole wait was spent unable to start the scan. This asks the printer
 * directly each idle pass, a LAN request the Worker never sees, and reports
 * only on a change, so the Worker gets no extra traffic.
 */
void reportIfFeederChanged(const String &printer) {
  if (printInFlight) {
    return;
  }
  String state, adf;
  scannerStatus(printer, state, adf);
  if (adf.length() && adf != lastAdf) {
    Serial.printf("feeder %s -> %s\n", lastAdf.length() ? lastAdf.c_str() : "-", adf.c_str());
    postTelemetry(printer, true);
  }
}

// ---- print queue -----------------------------------------------------------
// Pulls the next queued PDF from the Worker and streams it straight into the
// Xerox on port 9100. Never holds the file: 80 KB of RAM against PDFs up to
// 25 MB, so it is a relay, chunk in and chunk out.
static const uint16_t RAW_PRINT_PORT = 9100;


bool printerBusy(const String &printer) {
  int st = snmpInt(printer.c_str(), HR_DEVICE_STATUS);
  return st == 4 || st == 5;
}

// Once the bytes are in, stay with the job until the Xerox says it is done, so
// "printing" on the dashboard means paper moving and the next job waits for the
// real finish. Status is posted every pass so the page sees Printing within
// seconds instead of on the minute.
void waitForPrinter(const String &printer) {
  uint32_t start = millis();
  bool sawPrinting = false;
  int idleRuns = 0;
  int blindRuns = 0;
  while (millis() - start < 5UL * 60UL * 1000UL) {
    int st = snmpInt(printer.c_str(), HR_DEVICE_STATUS);
    if (st == -999999) {
      // SNMP is not answering at all, which this printer does for hours at a
      // time. Waiting cannot learn anything, and holding the queue blind for
      // the full five minutes is worse than calling it done: the bytes are
      // already inside the printer. Give it ~9 s in case it is a blip.
      if (++blindRuns >= 3) {
        break;
      }
    } else if (st == 4 || st == 5) {
      sawPrinting = true;
      idleRuns = 0;
    } else if (st == 3) {
      idleRuns++;
      // Seen it print and now idle: done. Never saw it print for ~12 s: a tiny
      // job finished between polls, also done.
      if (sawPrinting || idleRuns >= 4) {
        break;
      }
    }
    postTelemetry(printer, true);
    delay(3000);
    yield();
  }
  postTelemetry(printer, true);
}

void postPrintResult(const String &job, const char *encodedError) {
  String url = String(API_BASE) + "/bridge/print/result?job=" + job;
  if (encodedError && encodedError[0]) {
    url += String("&error=") + encodedError;
  }
  String unused;
  httpPostBytes(url, "text/plain", NULL, 0, unused, true);
}

bool streamPrintJob(const String &job, const String &printer, bool duplex) {
  printInFlight = true;
  struct ClearOnExit {
    ~ClearOnExit() { printInFlight = false; }
  } clearOnExit;
  HTTPClient http;
  http.setTimeout(180000);
  // Same trap as the scan download: this relays getStreamPtr() straight into
  // the printer's port 9100, so a chunked response would push chunk-size lines
  // into the print data. Nothing has been seen doing that here, but the cost
  // of being wrong is a corrupt print, and the fix is one line.
  http.useHTTP10(true);
  BearSSL::WiFiClientSecure client;
  client.setInsecure();
  String url = String(API_BASE) + "/bridge/print/file?job=" + job;
  if (!http.begin(client, url)) {
    postPrintResult(job, "file%20request%20failed");
    return false;
  }
  addAuth(http);
  int code = http.GET();
  if (code != 200) {
    http.end();
    postPrintResult(job, "file%20unavailable");
    return false;
  }

  WiFiClient tcp;
  if (!tcp.connect(printer.c_str(), RAW_PRINT_PORT)) {
    http.end();
    postPrintResult(job, "printer%20refused%20port%209100");
    return false;
  }
  // Ship each chunk as soon as it lands rather than letting Nagle hold it.
  tcp.setNoDelay(true);

  // Two-sided is asked for in PJL, ahead of the document. Port 9100 has no
  // way to carry job options otherwise -- it is a raw byte pipe.
  //
  // Only written when duplex was requested, so a one-sided job is still the
  // exact bytes of the PDF and cannot regress. The printer confirms it can do
  // this: an IPP Validate-Job with sides=two-sided-long-edge returns
  // successful-ok. Long edge is the binding people mean by "both sides" for
  // portrait pages.
  if (duplex) {
    static const char PJL_DUPLEX[] =
        "\x1B%-12345X@PJL JOB\r\n"
        "@PJL SET DUPLEX=ON\r\n"
        "@PJL SET BINDING=LONGEDGE\r\n"
        "@PJL ENTER LANGUAGE=PDF\r\n";
    tcp.write((const uint8_t *)PJL_DUPLEX, sizeof(PJL_DUPLEX) - 1);
  }

  WiFiClient *stream = http.getStreamPtr();
  int total = http.getSize();  // -1 when the server sends no Content-Length
  // One full TCP segment per write. Static so it is not on the 4 KB task stack.
  static uint8_t buf[1460];
  long sent = 0;
  uint32_t idleSince = millis();
  uint32_t started = millis();
  while (http.connected() && (total < 0 || sent < total)) {
    size_t avail = stream->available();
    if (avail) {
      size_t chunk = avail > sizeof(buf) ? sizeof(buf) : avail;
      int n = stream->readBytes(buf, chunk);
      if (n <= 0) {
        break;
      }
      if (tcp.write(buf, n) != (size_t)n) {
        tcp.stop();
        http.end();
        postPrintResult(job, "printer%20stopped%20accepting%20data");
        return false;
      }
      sent += n;
      idleSince = millis();
    } else {
      if (millis() - idleSince > 8000) {
        break;
      }
      yield();
    }
  }
  if (duplex) {
    // Close the job so DUPLEX=ON does not leak into whatever prints next.
    static const char PJL_END[] =
        "\x1B%-12345X@PJL EOJ\r\n"
        "\x1B%-12345X";
    tcp.write((const uint8_t *)PJL_END, sizeof(PJL_END) - 1);
  }
  uint32_t ms = millis() - started;
  if (ms > 0) {
    // Logged so the real relay rate is known the first time this runs.
    Serial.printf("relay %ld bytes in %lu ms (%lu KB/s)\n", sent, (unsigned long)ms, (unsigned long)(sent / ms));
  }
  waitForPrinter(printer);
  tcp.flush();
  tcp.stop();
  http.end();
  if (total > 0 && sent < total) {
    postPrintResult(job, "transfer%20incomplete");
    return false;
  }
  if (sent <= 4) {
    postPrintResult(job, "empty%20file");
    return false;
  }
  Serial.printf("printed %ld bytes\n", sent);
  postPrintResult(job, "");
  return true;
}

/**
 * Relay the scan straight from the printer to the Worker.
 *
 * The board is a bridge, so it should carry bytes, not keep them. It used to
 * download the whole PDF to the board's flash and only then upload it, which made the
 * board the bottleneck three ways: the two transfers ran one after the other
 * instead of together, every byte was written to flash and read back, and the
 * filesystem put a hard ceiling on a scan -- fine for one page, hopeless for a
 * feeder full of them.
 *
 * Now one pass. Bytes arrive from the printer and leave for the Worker in the
 * same loop, so nothing larger than the buffer is ever held and there is no
 * size limit left to hit.
 *
 * Chunked going out, because the size is not known when the request starts:
 * the printer streams the document while it is still rendering it and sends no
 * Content-Length. HTTPClient cannot POST a body of unknown length, so the
 * request is written by hand over a TLS socket.
 *
 * Asks the printer in HTTP/1.0 for the reason spelled out at the top of this
 * file: over 1.1 it answers chunked, and reading that raw would fold the
 * chunk-size lines into the PDF.
 */
bool relayScan(const String &docUrl, const String &job, uint32_t &bytesOut) {
  bytesOut = 0;

  HTTPClient src;
  WiFiClient srcClient;
  src.setTimeout(180000);
  src.useHTTP10(true);
  if (!src.begin(srcClient, docUrl)) {
    Serial.println("scan: cannot open the document");
    return false;
  }
  const int code = src.GET();
  if (code != 200) {
    Serial.printf("scan: document GET -> %d\n", code);
    src.end();
    return false;
  }
  WiFiClient *in = src.getStreamPtr();

  // The Worker end. Host is parsed off API_BASE rather than hardcoded so the
  // two cannot drift apart.
  String host = String(API_BASE);
  host.replace("https://", "");
  host.replace("http://", "");
  const int slash = host.indexOf('/');
  if (slash > 0) {
    host = host.substring(0, slash);
  }

  BearSSL::WiFiClientSecure out;
  out.setInsecure();
  if (!out.connect(host.c_str(), 443)) {
    Serial.println("scan: cannot reach the worker");
    src.end();
    return false;
  }
  out.setNoDelay(true);

  String head = "POST /bridge/result?job=" + job + " HTTP/1.1\r\n";
  head += "Host: " + host + "\r\n";
  head += "Authorization: Bearer " + String(BRIDGE_TOKEN) + "\r\n";
  head += "Content-Type: application/pdf\r\n";
  head += "Transfer-Encoding: chunked\r\n";
  head += "Connection: close\r\n\r\n";
  out.print(head);

  // Header, payload and trailer in one buffer, written once.
  //
  // Three separate writes per chunk meant three TLS records, each paying its
  // own header and MAC, for 512 bytes of payload. One write per chunk with a
  // full TCP segment of payload cuts that overhead by roughly a factor of
  // nine, and on this chip the encryption is the cost that matters.
  //
  // 1460 is one segment; 16 bytes of slack covers the longest hex length plus
  // both CRLFs.
  static uint8_t buf[1476];
  const size_t PAYLOAD = 1460;
  uint32_t idleSince = millis();
  const uint32_t started = millis();
  bool wentQuiet = false;
  while (src.connected() || in->available()) {
    const size_t avail = in->available();
    if (avail) {
      // Leave room at the front for the chunk header so the whole chunk is
      // one contiguous write. The header is written backwards from the
      // payload, then the write starts wherever it began.
      const size_t want = avail > PAYLOAD ? PAYLOAD : avail;
      const int n = in->readBytes(buf + 10, want);
      if (n <= 0) {
        break;
      }
      char hex[10];
      const int hl = snprintf(hex, sizeof(hex), "%x\r\n", (unsigned)n);
      uint8_t *start = buf + 10 - hl;
      memcpy(start, hex, hl);
      start[hl + n] = '\r';
      start[hl + n + 1] = '\n';
      const size_t total = hl + n + 2;
      if (out.write(start, total) != total) {
        Serial.println("scan: worker stopped accepting data");
        out.stop();
        src.end();
        return false;
      }
      bytesOut += n;
      idleSince = millis();
    } else {
      if (millis() - idleSince > SCAN_IDLE_TIMEOUT_MS) {
        wentQuiet = true;
        break;
      }
      delay(1);
      yield();
    }
  }
  src.end();

  if (wentQuiet || bytesOut <= 4) {
    // Never close the chunked body on a short read: an unterminated request is
    // rejected, which is what should happen. Finishing it cleanly would hand
    // the Worker a truncated PDF and call it a success.
    Serial.printf("scan: incomplete after %u bytes, abandoning\n", (unsigned)bytesOut);
    out.stop();
    return false;
  }
  out.print("0\r\n\r\n");

  // Read just the status line; the body is a small JSON ack.
  String status;
  const uint32_t deadline = millis() + 30000;
  while (millis() < deadline && out.connected()) {
    if (out.available()) {
      status = out.readStringUntil('\n');
      break;
    }
    delay(5);
    yield();
  }
  out.stop();

  const uint32_t took = millis() - started;
  const bool ok = status.indexOf("200") > 0;
  Serial.printf("scan: relayed %u bytes in %lu ms (%lu KB/s) -> %s\n",
                (unsigned)bytesOut, (unsigned long)took,
                (unsigned long)(took > 0 ? ((uint32_t)bytesOut / took) * 1000 / 1024 : 0),
                ok ? "ok" : status.c_str());
  return ok;
}

/** Ask for the next print job. Returns true if one was handled, so the caller skips telemetry this pass. */
bool checkPrintQueue(const String &printer) {
  // Someone may be printing straight from a laptop. Do not pile a job on top.
  if (printerBusy(printer)) {
    return false;
  }
  String body;
  int code = httpGetSmall(String(API_BASE) + "/bridge/print/next", body, true);
  if (code != 200) {
    return false;
  }
  String job = jsonField(body, "job");
  if (job.length() == 0) {
    return false;
  }
  // jsonField returns the raw token, so this is "1" or "0" from the Worker.
  bool duplex = jsonField(body, "duplex") == "1";
  setLedPattern(LED_PRINTING);
  Serial.printf("print job %s%s\n", job.c_str(), duplex ? " (two-sided)" : "");
  return streamPrintJob(job, printer, duplex);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    setLedPattern(LED_OFFLINE);
    Serial.println("wifi reconnect");
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    delay(3000);
    return;
  }

  setLedPattern(LED_IDLE);
  String pollUrl = String(API_BASE) + "/bridge/poll";
  String body;
  int code = httpGetSmall(pollUrl, body, true);
  if (code != 200) {
    Serial.printf("poll %d\n", code);
    delay(2000);
    return;
  }
  String job = jsonField(body, "job");
  if (job.length() == 0) {
    String printer = jsonField(body, "printer");
    if (printer.length() == 0) {
      printer = "192.168.68.52";
    }
    // Refresh was pressed and a page is waiting on this report, so it goes
    // before anything else. Then a print job, if any, takes this pass;
    // otherwise telemetry, or at least a look at the feeder.
    const bool asked = jsonField(body, "report") == "1";
    if (asked) {
      postTelemetry(printer, true);
    }
    if (!checkPrintQueue(printer) && !asked && !postTelemetry(printer)) {
      reportIfFeederChanged(printer);
    }
    return;
  }
  String source = jsonField(body, "source");
  String printer = jsonField(body, "printer");
  if (printer.length() == 0) {
    printer = "192.168.68.52";
  }
  setLedPattern(LED_SCANNING);
  Serial.print("job ");
  Serial.println(job);

  // Clear anything the scanner is still holding.
  //
  // It takes one job at a time, and a job that is never released blocks every
  // scan after it -- reproduced by hand: an abandoned job made the printer
  // refuse new ones until it was deleted. The bridge releases its own jobs,
  // but a crash or a power cut between starting and finishing leaves one
  // stranded, and nothing else ever cleans it up.
  {
    HTTPClient st;
    WiFiClient stClient;
    st.setTimeout(8000);
    st.useHTTP10(true);
    if (st.begin(stClient, "http://" + printer + "/eSCL/ScannerStatus") && st.GET() == 200) {
      const String body = st.getString();
      int at = body.indexOf("<pwg:JobUri>");
      while (at >= 0) {
        const int end = body.indexOf('<', at + 12);
        if (end < 0) break;
        const String uri = body.substring(at + 12, end);
        HTTPClient del;
        WiFiClient delClient;
        if (del.begin(delClient, "http://" + printer + uri)) {
          Serial.printf("scan: releasing a stranded job %s\n", uri.c_str());
          del.sendRequest("DELETE");
          del.end();
        }
        at = body.indexOf("<pwg:JobUri>", end);
      }
    }
    st.end();
  }

  const char *input = "Platen";
  if (source == "adf") {
    input = "Feeder";
  }
  String xml = String() +
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<scan:ScanSettings xmlns:scan=\"http://schemas.hp.com/imaging/escl/2011/05/03\" xmlns:pwg=\"http://www.pwg.org/schemas/2010/12/sm\">" +
    "<pwg:Version>2.6</pwg:Version><scan:Intent>Document</scan:Intent>" +
    "<pwg:InputSource>" + input + "</pwg:InputSource>" +
    "<pwg:DocumentFormat>application/pdf</pwg:DocumentFormat>" +
    // Colour, at 200 dpi. Both halves of that are measured, not assumed.
    //
    // 300 dpi was producing pages too large to move and is gone. Grayscale was
    // tried as the next lever and rejected: measured on this printer the same
    // page is 415 KB in RGB24 and 357 KB in Grayscale8, only 1.2x smaller,
    // because the JPEG inside the PDF already compresses colour efficiently.
    // Losing colour for 14% is a bad trade.
    //
    // If pages must get smaller, resolution is the lever that actually works:
    // size falls with its square, so 150 dpi is roughly half of 200.
    "<scan:ColorMode>RGB24</scan:ColorMode>" +
    "<scan:XResolution>200</scan:XResolution><scan:YResolution>200</scan:YResolution>" +
    "</scan:ScanSettings>";

  String printerBase = "http://" + printer;
  String loc;
  int pcode = startScanJob(printerBase, xml.c_str(), loc);
  String resultUrl = String(API_BASE) + "/bridge/result?job=" + job;
  if ((pcode != 201 && pcode != 200) || loc.length() == 0) {
    postError(resultUrl, "scan%20rejected");
    return;
  }

  String docUrl = loc;
  if (docUrl.endsWith("/")) {
    docUrl.remove(docUrl.length() - 1);
  }
  docUrl += "/NextDocument";
  // Scanning and sending now happen together, so the dashboard is told the
  // bytes are moving before the relay starts rather than between two separate
  // transfers. There is no size to report yet: with one pass there is no point
  // at which the whole document has been counted.
  {
    String ignored;
    httpPostBytes(String(API_BASE) + "/bridge/progress?job=" + job + "&phase=uploading",
                  "text/plain", NULL, 0, ignored, true);
  }

  // Streaming keeps no copy, so a failed transfer has nothing to resend from.
  // The printer does still hold the job, though, and has not been told to
  // release it -- so the retry is to ask it for the document again. Costs one
  // extra attempt on a bad Wi-Fi moment and saves walking back to the glass.
  //
  // Only once. If the printer has already released the pages the second GET
  // fails immediately, which is no worse than not trying.
  uint32_t relayed = 0;
  bool ok = relayScan(docUrl, job, relayed);
  if (!ok) {
    Serial.println("scan: transfer failed, asking the printer for it again");
    delay(1000);
    ok = relayScan(docUrl, job, relayed);
  }

  // Did the feeder have more than we sent?
  //
  // eSCL scanners differ. Some return one multi-page PDF for a whole feeder
  // stack; others return a document per sheet and expect the client to keep
  // asking until 404. This firmware asks once, which is right for the glass --
  // a second request there returns 404, confirmed against this printer.
  //
  // If a feeder scan ever answers 200 here, pages were dropped, and this says
  // so rather than quietly emailing the first sheet as though it were the lot.
  if (ok) {
    HTTPClient more;
    WiFiClient moreClient;
    more.setTimeout(15000);
    more.useHTTP10(true);
    if (more.begin(moreClient, docUrl)) {
      if (more.GET() == 200) {
        Serial.println("scan: WARNING more documents remain for this job -- "
                       "pages after the first were NOT sent");
      }
      more.end();
    }
  }

  // Now the pages can be released, whichever way it went: leaving the job open
  // would block the next scan.
  {
    HTTPClient del;
    WiFiClient delClient;
    if (del.begin(delClient, loc)) {
      del.sendRequest("DELETE");
      del.end();
    }
  }

  if (!ok) {
    // relayScan posts nothing on failure -- it abandons the request without
    // closing the chunked body, so the Worker never sees a document. The job
    // still needs an answer or the dashboard waits out the full timeout.
    postError(resultUrl, "scan%20transfer%20failed");
    return;
  }
  Serial.println("posted pdf");
}
