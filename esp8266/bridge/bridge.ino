// ESP8266EX firmware (this board is not an ESP32).
// Joins office Wi-Fi, long-polls the Worker, scans the Xerox over eSCL and
// streams queued PDFs into it on port 9100.
// PDFs are written to LittleFS in 512-byte chunks. A String cannot hold a scan.

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <LittleFS.h>
#include "secrets.h"
#include "snmp.h"

static const char *SCAN_PATH = "/scan.pdf";
static const int MAX_PDF_BYTES = 1500000;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("nexdash-bridge boot");
  // TLS is CPU-bound on this chip; the relay rate roughly tracks this number.
  Serial.printf("cpu %u MHz\n", ESP.getCpuFreqMHz());
  if (!LittleFS.begin()) {
    LittleFS.format();
    LittleFS.begin();
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
    Serial.print("ip ");
    Serial.println(WiFi.localIP());
  } else {
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
  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[512];
  int written = 0;
  uint32_t idleSince = millis();
  while (http.connected() && written < MAX_PDF_BYTES) {
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
      if (millis() - idleSince > 8000) {
        break;
      }
      delay(1);
    }
    yield();
  }
  f.close();
  http.end();
  return written > 4;
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

void postTelemetry(const String &printer, bool force = false) {
  if (!force && millis() - lastTelemetry < 60000 && lastTelemetry != 0) {
    return;
  }
  lastTelemetry = millis();
  int statusN = snmpInt(printer.c_str(), "1.3.6.1.2.1.25.3.5.1.1.1");
  int pages = snmpInt(printer.c_str(), "1.3.6.1.2.1.43.10.2.1.4.1.1");
  int tmax = snmpInt(printer.c_str(), "1.3.6.1.2.1.43.11.1.1.8.1.1");
  int tcur = snmpInt(printer.c_str(), "1.3.6.1.2.1.43.11.1.1.9.1.1");
  String tname = snmpStr(printer.c_str(), "1.3.6.1.2.1.43.11.1.1.6.1.1");
  if (tname.length() == 0) {
    tname = "Black Toner";
  }
  int pct = -1;
  if (tmax > 0 && tcur >= 0) {
    pct = (tcur * 100) / tmax;
    if (pct > 100) {
      pct = 100;
    }
  }
  const char *status = "Unknown";
  if (statusN == 3) status = "Idle";
  else if (statusN == 4) status = "Printing";
  else if (statusN == 5) status = "Warmup";
  else if (statusN == 6) status = "Stopped";
  else if (statusN == 7) status = "Offline";
  bool online = statusN != -999999;
  String json = "{";
  json += "\"online\":";
  json += online ? "true" : "false";
  json += ",\"status\":\"";
  json += status;
  json += "\",\"pages\":";
  json += (pages == -999999) ? "null" : String(pages);
  json += ",\"toners\":[{\"name\":\"";
  json += tname;
  json += "\",\"pct\":";
  json += (pct < 0) ? "null" : String(pct);
  json += ",\"color\":\"#1e293b\"}],\"trays\":[],\"alerts\":[],\"checked_at\":";
  json += String((uint32_t)(millis() / 1000));
  json += "}";
  String unused;
  String url = String(API_BASE) + "/bridge/telemetry";
  httpPostBytes(url.c_str(), "application/json", (uint8_t *)json.c_str(), json.length(), unused, true);
  Serial.print("telemetry ");
  Serial.println(online ? status : "offline");
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
  while (millis() - start < 5UL * 60UL * 1000UL) {
    int st = snmpInt(printer.c_str(), HR_DEVICE_STATUS);
    if (st == 4 || st == 5) {
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

bool streamPrintJob(const String &job, const String &printer) {
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
  Serial.print("print job ");
  Serial.println(job);
  return streamPrintJob(job, printer);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("wifi reconnect");
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    delay(3000);
    return;
  }

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
    "<scan:ColorMode>RGB24</scan:ColorMode>" +
    "<scan:XResolution>300</scan:XResolution><scan:YResolution>300</scan:YResolution>" +
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
