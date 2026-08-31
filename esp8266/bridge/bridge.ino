// ESP8266EX firmware (this board is not an ESP32).
// Joins office Wi-Fi, long-polls the Go API, scans the Xerox over eSCL.

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecureBearSSL.h>
#include "secrets.h"

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("nexdash-bridge boot");
  WiFi.mode(WIFI_STA);
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

int httpGet(String url, String &out) {
  if (isHttps(url)) {
    BearSSL::WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.setTimeout(25000);
    http.begin(client, url);
    http.addHeader("Authorization", String("Bearer ") + BRIDGE_TOKEN);
    int code = http.GET();
    out = http.getString();
    http.end();
    return code;
  }
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(25000);
  http.begin(client, url);
  int code = http.GET();
  out = http.getString();
  http.end();
  return code;
}

int httpPost(String url, const char *ctype, uint8_t *data, size_t len, String &out) {
  if (isHttps(url)) {
    BearSSL::WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.setTimeout(180000);
    http.begin(client, url);
    http.addHeader("Authorization", String("Bearer ") + BRIDGE_TOKEN);
    http.addHeader("Content-Type", ctype);
    int code = http.POST(data, len);
    out = http.getString();
    http.end();
    return code;
  }
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(180000);
  http.begin(client, url);
  http.addHeader("Content-Type", ctype);
  int code = http.POST(data, len);
  out = http.getString();
  http.end();
  return code;
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
  int code = httpGet(pollUrl, body);
  if (code != 200) {
    Serial.printf("poll %d\n", code);
    delay(2000);
    return;
  }
  String job = jsonField(body, "job");
  if (job.length() == 0) {
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
  String unused;
  int pcode = httpPost(printerBase + "/eSCL/ScanJobs", "text/xml",
                       (uint8_t *)xml.c_str(), xml.length(), unused);
  String resultUrl = String(API_BASE) + "/bridge/result?job=" + job;
  if (pcode != 201 && pcode != 200) {
    String err = "scan rejected";
    httpPost(resultUrl + "&error=" + err, "text/plain", NULL, 0, unused);
    return;
  }

  String pdf;
  int dcode = httpGet(printerBase + "/eSCL/ScanJobs/NextDocument", pdf);
  // Location-based NextDocument is printer-specific; try common path first.
  if (dcode != 200 || pdf.length() < 4) {
    httpPost(resultUrl + "&error=no%20document", "text/plain", NULL, 0, unused);
    return;
  }
  httpPost(resultUrl, "application/pdf", (uint8_t *)pdf.c_str(), pdf.length(), unused);
  Serial.println("posted pdf");
}
