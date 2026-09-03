#include "webui.h"
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>

// Reading the web interface without buffering it.
//
// The status document is about 32 KB and the board has 80 KB of RAM, so it is
// consumed a byte at a time and thrown away as it goes. Everything below is a
// forward scan: find a marker, read the value that follows, keep going. No
// seeking backwards, and nothing kept but the handful of values wanted.

static const uint32_t WEBUI_TIMEOUT_MS = 12000;

// HTTPClient::begin() clones the WiFiClient it is handed, so the socket the
// request actually went out on is the clone's, not the caller's. Reading the
// caller's object returns nothing at all -- no error, just an empty stream --
// which is exactly how this failed the first time. Always read what
// getStreamPtr() hands back, and ask the HTTPClient whether it is still
// connected.
struct Src {
  Stream *s;
  HTTPClient *http;
};

// One byte, or -1 once the server has finished and the buffer is drained.
static int nextByte(Src &c, uint32_t deadline) {
  while ((int32_t)(millis() - deadline) < 0) {
    if (c.s->available()) {
      return c.s->read();
    }
    if (!c.http->connected()) {
      return -1;
    }
    delay(1);
    yield();
  }
  return -1;
}

// Consume up to and including `marker`. False if the stream ends first.
static bool seekMarker(Src &c, const char *marker, uint32_t deadline) {
  int len = strlen(marker);
  int hit = 0;
  int ch;
  while ((ch = nextByte(c, deadline)) >= 0) {
    // On a mismatch fall back to 0 rather than a proper prefix table: the
    // markers here have no repeated prefix, so the simple reset is correct.
    hit = (ch == marker[hit]) ? hit + 1 : (ch == marker[0] ? 1 : 0);
    if (hit == len) {
      return true;
    }
  }
  return false;
}

// The rest of a JSON string, the opening quote already consumed.
static String readQuoted(Src &c, uint32_t deadline, int cap) {
  String out;
  int ch;
  while ((ch = nextByte(c, deadline)) >= 0) {
    if (ch == '\\') {
      nextByte(c, deadline);
      continue;
    }
    if (ch == '"') {
      break;
    }
    if ((int)out.length() < cap) {
      out += (char)ch;
    }
  }
  return out;
}

// The number after a matched key. The delimiter that ends it still counts
// toward brace depth and string state, so it is handed back to the caller.
static int readNumber(Src &c, uint32_t deadline, int &depth, bool &inString) {
  String digits;
  int d;
  while ((d = nextByte(c, deadline)) >= 0) {
    if ((d >= '0' && d <= '9') || d == '-') {
      digits += (char)d;
    } else {
      if (d == '{' || d == '[') depth++;
      else if (d == '}' || d == ']') depth--;
      else if (d == '"') inString = !inString;
      break;
    }
  }
  return digits.length() ? digits.toInt() : -1;
}

/**
 * Walk one JSON object, ending when its closing brace is reached, and pull out
 * an integer field and a string field by name. Braces inside strings are not
 * depth, which is why the string state is tracked at all.
 *
 * Returns with the object's closing brace consumed.
 */
static void scanObject(Src &c, uint32_t deadline,
                       const char *intKey, int &intOut,
                       const char *intKey2, int &intOut2,
                       const char *strKey, String &strOut) {
  int depth = 1;
  bool inString = false;
  int intHit = 0, intHit2 = 0, strHit = 0;
  int intLen = intKey ? strlen(intKey) : 0;
  int intLen2 = intKey2 ? strlen(intKey2) : 0;
  int strLen = strKey ? strlen(strKey) : 0;
  int ch;
  while (depth > 0 && (ch = nextByte(c, deadline)) >= 0) {
    if (inString) {
      if (ch == '\\') {
        nextByte(c, deadline);
        continue;
      }
      if (ch == '"') {
        inString = false;
      }
    } else if (ch == '"') {
      inString = true;
    } else if (ch == '{' || ch == '[') {
      depth++;
    } else if (ch == '}' || ch == ']') {
      depth--;
      continue;
    }

    if (intLen && intOut == -1) {
      intHit = (ch == intKey[intHit]) ? intHit + 1 : (ch == intKey[0] ? 1 : 0);
      if (intHit == intLen) {
        intHit = 0;
        intOut = readNumber(c, deadline, depth, inString);
        continue;
      }
    }
    if (intLen2 && intOut2 == -1) {
      intHit2 = (ch == intKey2[intHit2]) ? intHit2 + 1 : (ch == intKey2[0] ? 1 : 0);
      if (intHit2 == intLen2) {
        intHit2 = 0;
        intOut2 = readNumber(c, deadline, depth, inString);
        continue;
      }
    }
    if (strLen && strOut.length() == 0) {
      strHit = (ch == strKey[strHit]) ? strHit + 1 : (ch == strKey[0] ? 1 : 0);
      if (strHit == strLen) {
        strHit = 0;
        strOut = readQuoted(c, deadline, 24);
        // The key ends on the value's opening quote, which the loop above has
        // already counted as entering a string. readQuoted then eats the
        // closing one, so without this reset the scan believes it is inside a
        // string forever, stops counting braces, and runs off the end of the
        // object. That is why only the first supply was ever found.
        inString = false;
      }
    }
  }
}

static bool openGet(HTTPClient &http, WiFiClient &client, const String &host,
                    const char *path) {
  http.setTimeout(WEBUI_TIMEOUT_MS);
  http.setReuse(false);
  // Ask in HTTP/1.0. Over 1.1 this printer answers Transfer-Encoding: chunked,
  // and ESP8266HTTPClient only de-chunks inside getString() and
  // writeToStream(), never on the stream itself -- so a reader like this one
  // gets the chunk-size lines mixed into the JSON and parses nothing. 1.0 has
  // no chunked encoding, and the server closes the connection to mark the end.
  http.useHTTP10(true);
  if (!http.begin(client, "http://" + host + path)) {
    Serial.printf("webui begin failed %s\n", path);
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    Serial.printf("webui GET %s -> %d\n", path, code);
    http.end();
    return false;
  }
  return true;
}

bool webuiStatus(const String &host, WebSupply *supplies, int supplyCap, int &supplyCount,
                 WebTray *trays, int trayCap, int &trayCount, String &serialOut) {
  supplyCount = 0;
  trayCount = 0;
  HTTPClient http;
  WiFiClient client;
  if (!openGet(http, client, host, "/webglue/webui/nodedata/Status")) {
    return false;
  }
  Src src{http.getStreamPtr(), &http};
  uint32_t deadline = millis() + WEBUI_TIMEOUT_MS;

  // The document lists its sections alphabetically, so inputs arrive before
  // supplies and one forward pass covers both.
  if (seekMarker(src, "\"inputs\":{", deadline)) {
    while (trayCount < trayCap) {
      int ch = nextByte(src, deadline);
      while (ch == ',' || ch == ' ' || ch == '\n' || ch == '\r') {
        ch = nextByte(src, deadline);
      }
      if (ch != '"') {
        break;  // '}' closes the section, anything else is a malformed stream
      }
      String name = readQuoted(src, deadline, 28);
      if (!seekMarker(src, "{", deadline)) {
        break;
      }
      int cap = -1, level = -1;
      String unused;
      // capacity is the sheet count; currentLevel is a percentage of full.
      scanObject(src, deadline, "\"capacity\":", cap,
                 "\"currentLevel\":", level, NULL, unused);
      trays[trayCount].name = name;
      trays[trayCount].capacity = cap < 0 ? 0 : cap;
      trays[trayCount].pct = (level < 0 || level > 100) ? -1 : level;
      // capacity is sheets, currentLevel a percentage of full. The dashboard
      // shows the percentage, so no sheet count is invented from it.
      trayCount++;
    }
  }

  // The device block sits between inputs and supplies, so the same forward
  // pass can pick the serial up on the way past.
  if (seekMarker(src, "\"DeviceSerialNumberUnq\"", deadline)
      && seekMarker(src, ",\"text\":\"", deadline)) {
    serialOut = readQuoted(src, deadline, 32);
  }

  if (seekMarker(src, "\"supplies\":{", deadline)) {
    while (supplyCount < supplyCap) {
      int ch = nextByte(src, deadline);
      while (ch == ',' || ch == ' ' || ch == '\n' || ch == '\r') {
        ch = nextByte(src, deadline);
      }
      if (ch != '"') {
        break;
      }
      String name = readQuoted(src, deadline, 28);
      if (!seekMarker(src, "{", deadline)) {
        break;
      }
      int pct = -1;
      String status;
      int ignored = -2;
      scanObject(src, deadline, "\"curlevel\":", pct, NULL, ignored,
                 "\"currentStatus\":\"", status);
      supplies[supplyCount].name = name;
      supplies[supplyCount].pct = (pct < 0 || pct > 100) ? -1 : pct;
      supplies[supplyCount].status = status;
      supplyCount++;
    }
  }

  http.end();
  Serial.printf("webui status supplies=%d trays=%d\n", supplyCount, trayCount);
  return supplyCount > 0 || trayCount > 0;
}

bool webuiIdentity(const String &host, String &model, String &serial) {
  HTTPClient http;
  WiFiClient client;
  if (!openGet(http, client, host, "/eSCL/ScannerCapabilities")) {
    return false;
  }
  Src src{http.getStreamPtr(), &http};
  uint32_t deadline = millis() + WEBUI_TIMEOUT_MS;
  if (seekMarker(src, "<pwg:MakeAndModel>", deadline)) {
    int ch;
    while ((ch = nextByte(src, deadline)) >= 0 && ch != '<') {
      if (model.length() < 40) model += (char)ch;
    }
  }
  if (seekMarker(src, "<pwg:SerialNumber>", deadline)) {
    int ch;
    while ((ch = nextByte(src, deadline)) >= 0 && ch != '<') {
      if (serial.length() < 32) serial += (char)ch;
    }
  }
  http.end();
  model.trim();
  serial.trim();
  return model.length() > 0 || serial.length() > 0;
}

String webuiScannerState(const String &host) {
  HTTPClient http;
  WiFiClient client;
  if (!openGet(http, client, host, "/eSCL/ScannerStatus")) {
    return "";
  }
  Src src{http.getStreamPtr(), &http};
  uint32_t deadline = millis() + WEBUI_TIMEOUT_MS;
  String state;
  if (seekMarker(src, "<pwg:State>", deadline)) {
    int ch;
    while ((ch = nextByte(src, deadline)) >= 0 && ch != '<') {
      if (state.length() < 16) state += (char)ch;
    }
  }
  http.end();
  state.trim();
  return state;
}
