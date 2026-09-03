// ESP8266EX firmware (this board is not an ESP32).
// Joins office Wi-Fi, long-polls the Worker, scans the Xerox over eSCL and
// streams queued PDFs into it on port 9100.
// PDFs are written to LittleFS in 512-byte chunks. A String cannot hold a scan.

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <LittleFS.h>
#include <Ticker.h>
#include "secrets.h"
#include "snmp.h"
#include "webui.h"

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

static const char *SCAN_PATH = "/scan.pdf";
static const int MAX_PDF_BYTES = 1500000;
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
  if (!LittleFS.begin()) {
    LittleFS.format();
    LittleFS.begin();
  }
  {
    // The scan is buffered to LittleFS before it is pushed on, so this number
    // is the real ceiling on a scan and worth stating rather than assuming.
    FSInfo info;
    if (LittleFS.info(info)) {
      Serial.printf("fs: %u bytes total, %u used\n",
                    (unsigned)info.totalBytes, (unsigned)info.usedBytes);
    }
  }
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

bool downloadToFile(String url, const char *path) {
  LittleFS.remove(path);
  HTTPClient http;
  http.setTimeout(180000);
  WiFiClient client;
  if (!http.begin(client, url)) {
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    http.end();
    return false;
  }
  File f = LittleFS.open(path, "w");
  if (!f) {
    http.end();
    return false;
  }
  // -1 when the printer sends no Content-Length, which it usually does not:
  // it streams the PDF while still rendering it.
  const int expected = http.getSize();
  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[512];
  int written = 0;
  bool hitCap = false;
  bool wentQuiet = false;
  uint32_t idleSince = millis();
  while (http.connected()) {
    if (written >= MAX_PDF_BYTES) {
      hitCap = true;
      break;
    }
    size_t avail = stream->available();
    if (avail) {
      size_t chunk = avail;
      if (chunk > sizeof(buf)) {
        chunk = sizeof(buf);
      }
      int n = stream->readBytes(buf, chunk);
      if (n <= 0) {
        break;
      }
      if (f.write(buf, n) != (size_t)n) {
        f.close();
        http.end();
        return false;
      }
      written += n;
      idleSince = millis();
    } else {
      // The printer renders as it sends and can pause mid-document, so this
      // is deliberately patient. Running out is still a failure, not an end.
      if (millis() - idleSince > SCAN_IDLE_TIMEOUT_MS) {
        wentQuiet = true;
        break;
      }
      delay(1);
    }
    yield();
  }
  f.close();
  http.end();

  // Anything short of the whole document is a corrupt PDF, and a corrupt PDF
  // that reports success gets emailed. This used to `return written > 4`,
  // which called every truncation a win: a scan over the cap arrived as a
  // page that renders cleanly at the top and dissolves into colour bands
  // where the JPEG stream was cut.
  if (written <= 4) {
    Serial.println("scan: nothing arrived");
    return false;
  }
  if (hitCap) {
    Serial.printf("scan: hit the %d byte cap, refusing to send a truncated pdf\n", MAX_PDF_BYTES);
    return false;
  }
  if (wentQuiet) {
    Serial.printf("scan: printer went quiet after %d bytes, refusing to send a truncated pdf\n", written);
    return false;
  }
  if (expected > 0 && written < expected) {
    Serial.printf("scan: got %d of %d bytes, refusing to send a truncated pdf\n", written, expected);
    return false;
  }
  Serial.printf("scan: %d bytes\n", written);
  return true;
}

int httpPostFile(String url, const char *ctype, const char *path, String &out) {
  File f = LittleFS.open(path, "r");
  if (!f) {
    return -1;
  }
  size_t len = f.size();
  HTTPClient http;
  int code = -1;
  out = "";
  http.setTimeout(180000);
  if (isHttps(url)) {
    BearSSL::WiFiClientSecure client;
    client.setInsecure();
    if (!http.begin(client, url)) {
      f.close();
      return -1;
    }
    addAuth(http);
    http.addHeader("Content-Type", ctype);
    code = http.sendRequest("POST", &f, len);
    if (code > 0) {
      out = http.getString();
    }
    http.end();
    f.close();
    return code;
  }
  WiFiClient client;
  if (!http.begin(client, url)) {
    f.close();
    return -1;
  }
  addAuth(http);
  http.addHeader("Content-Type", ctype);
  code = http.sendRequest("POST", &f, len);
  if (code > 0) {
    out = http.getString();
  }
  http.end();
  f.close();
  return code;
}

void postError(String resultUrl, const char *encoded) {
  String unused;
  httpPostBytes(resultUrl + "&error=" + encoded, "text/plain", NULL, 0, unused, true);
}

static uint32_t lastTelemetry = 0;

static uint32_t lastWebui = 0;
// True while bytes are being relayed to port 9100 or the printer is being
// waited on. Nothing optional runs in that window.
static bool printInFlight = false;

void postTelemetry(const String &printer, bool force = false) {
  if (!force && millis() - lastTelemetry < 60000 && lastTelemetry != 0) {
    return;
  }
  lastTelemetry = millis();
  const char *host = printer.c_str();

  int statusN = snmpInt(host, "1.3.6.1.2.1.25.3.5.1.1.1");
  bool online = statusN != -999999;
  int pages = snmpInt(host, "1.3.6.1.2.1.43.10.2.1.4.1.1");
  int uptime = snmpInt(host, "1.3.6.1.2.1.1.3.0");
  String console = snmpStr(host, "1.3.6.1.2.1.43.16.5.1.2.1.1");
  String model = snmpStr(host, "1.3.6.1.2.1.1.1.0");
  String serial = snmpStr(host, "1.3.6.1.2.1.43.5.1.1.17.1");
  // sysDescr carries the kernel build and more; the model is the first clause.
  int semi = model.indexOf(';');
  if (semi > 0) {
    model = model.substring(0, semi);
  }

  const char *status = "Unknown";
  if (statusN == 3) status = "Idle";
  else if (statusN == 4) status = "Printing";
  else if (statusN == 5) status = "Warmup";
  else if (statusN == 6) status = "Stopped";
  else if (statusN == 7) status = "Offline";

  // Printer MIB indices are arbitrary: this B305 numbers its supplies .1 and
  // .14, so reading .1 and .2 found one cartridge and missed the imaging unit
  // entirely. Probe a range and keep whatever answers — a missing index replies
  // at once with noSuchInstance, so this costs round trips, not timeouts.
  String toners = "";
  for (int i = 1; i <= 16; i++) {
    int cur = snmpInt(host, (String("1.3.6.1.2.1.43.11.1.1.9.1.") + i).c_str());
    if (cur == -999999) {
      continue;
    }
    int max = snmpInt(host, (String("1.3.6.1.2.1.43.11.1.1.8.1.") + i).c_str());
    String name = snmpStr(host, (String("1.3.6.1.2.1.43.11.1.1.6.1.") + i).c_str());
    // Xerox appends part and serial numbers after a comma or semicolon.
    int cut = name.indexOf(',');
    int cut2 = name.indexOf(';');
    if (cut2 >= 0 && (cut < 0 || cut2 < cut)) cut = cut2;
    if (cut > 0) name = name.substring(0, cut);
    name.trim();
    if (name.length() == 0) name = String("Supply ") + i;
    int pct = (max > 0 && cur >= 0) ? (int)(((long)cur * 100) / max) : -1;
    if (pct > 100) pct = 100;
    const char *colour = name.indexOf("Black") >= 0 ? "#1e293b" : "#64748b";
    if (toners.length()) toners += ",";
    toners += "{\"name\":\"" + name + "\",\"pct\":" + (pct < 0 ? String("null") : String(pct))
            + ",\"color\":\"" + colour + "\"}";
  }

  String trays = "";
  for (int i = 1; i <= 6; i++) {
    int cur = snmpInt(host, (String("1.3.6.1.2.1.43.8.2.1.10.1.") + i).c_str());
    if (cur == -999999) {
      continue;
    }
    int cap = snmpInt(host, (String("1.3.6.1.2.1.43.8.2.1.9.1.") + i).c_str());
    String name = snmpStr(host, (String("1.3.6.1.2.1.43.8.2.1.13.1.") + i).c_str());
    name.trim();
    if (name.length() == 0) name = String("Tray ") + i;
    int pct = (cap > 0 && cur >= 0) ? (int)(((long)cur * 100) / cap) : -1;
    if (pct > 100) pct = 100;
    // -3 means "at least one sheet" and -2 unknown, per the printer MIB.
    const char *tstatus = cur == 0 ? "Empty" : (cur < 0 ? "Unknown" : "Loaded");
    if (trays.length()) trays += ",";
    trays += "{\"name\":\"" + name + "\",\"capacity\":" + String(cap < 0 ? 0 : cap)
           + ",\"level\":" + String(cur < 0 ? 0 : cur)
           + ",\"pct\":" + (pct < 0 ? String("null") : String(pct))
           + ",\"status\":\"" + tstatus + "\"}";
  }

  String alerts = "";
  for (int i = 1; i <= 5; i++) {
    String desc = snmpStr(host, (String("1.3.6.1.2.1.43.18.1.1.8.") + i).c_str());
    desc.trim();
    if (desc.length() == 0) {
      continue;
    }
    int sev = snmpInt(host, (String("1.3.6.1.2.1.43.18.1.1.2.") + i).c_str());
    // prtAlertSeverityLevel: 3 critical, 4 warning, 5 warningBinaryChangeEvent.
    const char *sevName = sev == 3 ? "Critical" : "Warning";
    if (alerts.length()) alerts += ",";
    alerts += "{\"severity\":\"" + String(sevName) + "\",\"desc\":\"" + desc + "\"}";
  }

  // SNMP on this B305 stopped answering for hours while its web interface
  // stayed perfectly healthy. Reporting nothing in that state is a worse
  // answer than asking the other door, which knows the same facts and a few
  // SNMP never exposed here.
  // The web fallback is expensive: an HTTP client plus a 32 KB stream. During
  // a print, waitForPrinter forces a telemetry post every three seconds while
  // the relay socket to port 9100 is still open, and doing this on every one
  // of those put two clients and a 32 KB read against 80 KB of RAM. A job
  // died mid-relay that way. It now runs on its own clock no matter how often
  // telemetry is forced, so a forced post during a print reports what SNMP
  // last said and costs nothing.
  if (toners.length() == 0 && !printInFlight &&
      (lastWebui == 0 || millis() - lastWebui > 60000)) {
    lastWebui = millis();
    WebSupply ws[6];
    WebTray wt[6];
    int nS = 0, nT = 0;
    String webSerial;
    if (webuiStatus(printer, ws, 6, nS, wt, 6, nT, webSerial)) {
      for (int i = 0; i < nS; i++) {
        const char *colour = ws[i].name.indexOf("Black") >= 0 ? "#1e293b" : "#64748b";
        if (toners.length()) toners += ",";
        toners += "{\"name\":\"" + ws[i].name + "\",\"pct\":"
                + (ws[i].pct < 0 ? String("null") : String(ws[i].pct))
                + ",\"color\":\"" + colour + "\"}";
      }
      if (trays.length() == 0) {
        for (int i = 0; i < nT; i++) {
          if (trays.length()) trays += ",";
          trays += "{\"name\":\"" + wt[i].name + "\",\"capacity\":" + String(wt[i].capacity)
                 + ",\"level\":0,\"pct\":"
                 + (wt[i].pct < 0 ? String("null") : String(wt[i].pct))
                 + ",\"status\":\"" + (wt[i].pct < 0 ? "Unknown" : (wt[i].pct == 0 ? "Empty" : "Loaded"))
                 + "\"}";
        }
      }
      if (serial.length() == 0 && webSerial.length()) {
        serial = webSerial;
      }
      // Only ask eSCL for what is still missing. Its SerialNumber is the TSN,
      // a different number from the one on the label, so it is the last
      // resort for the serial and never overrides webSerial.
      if (model.length() == 0 || serial.length() == 0) {
        String m, sn;
        if (webuiIdentity(printer, m, sn)) {
          if (model.length() == 0) model = m;
          if (serial.length() == 0) serial = sn;
        }
      }
      if (!online) {
        // Reached over HTTP, so it is on the network whatever SNMP thinks.
        // The scanner's own state is the only movement signal left, and it
        // says nothing about the print engine, so never claim Printing here.
        online = true;
        String st = webuiScannerState(printer);
        status = st == "Idle" ? "Idle" : (st.length() ? "Busy" : "Unknown");
      }
    }
  }

  String json = "{\"online\":";
  json += online ? "true" : "false";
  json += ",\"status\":\"" + String(status) + "\"";
  if (model.length()) json += ",\"model\":\"" + model + "\"";
  if (serial.length()) json += ",\"serial\":\"" + serial + "\"";
  if (console.length()) json += ",\"console\":\"" + console + "\"";
  json += ",\"pages\":" + String(pages == -999999 ? String("null") : String(pages));
  if (uptime != -999999) json += ",\"uptime_ticks\":" + String(uptime);
  json += ",\"toners\":[" + toners + "]";
  json += ",\"trays\":[" + trays + "]";
  json += ",\"alerts\":[" + alerts + "]";
  json += ",\"checked_at\":" + String((uint32_t)(millis() / 1000)) + "}";

  String unused;
  String url = String(API_BASE) + "/bridge/telemetry";
  httpPostBytes(url.c_str(), "application/json", (uint8_t *)json.c_str(), json.length(), unused, true);
  Serial.printf("telemetry %s  supplies=%d trays=%d pages=%d serial=%s heap=%u\n",
                online ? status : "offline",
                toners.length() ? (int)(std::count(toners.begin(), toners.end(), '{')) : 0,
                trays.length() ? (int)(std::count(trays.begin(), trays.end(), '{')) : 0,
                pages, serial.length() ? serial.c_str() : "-",
                (unsigned)ESP.getFreeHeap());
}

// ---- print queue -----------------------------------------------------------
// Pulls the next queued PDF from the Worker and streams it straight into the
// Xerox on port 9100. Never holds the file: 80 KB of RAM against PDFs up to
// 25 MB, so it is a relay, chunk in and chunk out.
static const uint16_t RAW_PRINT_PORT = 9100;

static const char *HR_DEVICE_STATUS = "1.3.6.1.2.1.25.3.5.1.1.1";  // 3 idle, 4 printing, 5 warmup

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
    // No scan waiting. A print job, if any, takes this pass; telemetry otherwise.
    if (!checkPrintQueue(printer)) {
      postTelemetry(printer);
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
    // Colour is kept; the resolution is not. RGB24 at 300 dpi runs an A4 page
    // past the 1.5 MB cap, which is what was truncating scans. 200 dpi is
    // about 44% of the data, comfortably inside the cap, quicker to scan and
    // quicker to push over TLS from an 80 MHz board -- and still well above
    // what a document being emailed needs.
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
  if (!downloadToFile(docUrl, SCAN_PATH)) {
    HTTPClient del;
    WiFiClient delClient;
    if (del.begin(delClient, loc)) {
      del.sendRequest("DELETE");
      del.end();
    }
    postError(resultUrl, "no%20document");
    return;
  }

  String unused;
  httpPostFile(resultUrl, "application/pdf", SCAN_PATH, unused);
  HTTPClient del;
  WiFiClient delClient;
  if (del.begin(delClient, loc)) {
    del.sendRequest("DELETE");
    del.end();
  }
  LittleFS.remove(SCAN_PATH);
  Serial.println("posted pdf");
}
