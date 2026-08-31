#include <WiFiUdp.h>

#ifndef SNMP_COMMUNITY
#define SNMP_COMMUNITY "public"
#endif

static bool berLen(const uint8_t *buf, int n, int i, int *lenOut, int *next) {
  if (i >= n) {
    return false;
  }
  uint8_t first = buf[i];
  if (first < 128) {
    *lenOut = first;
    *next = i + 1;
    return true;
  }
  int c = first & 0x7F;
  if (c == 0 || i + 1 + c > n) {
    return false;
  }
  int v = 0;
  for (int k = 0; k < c; k++) {
    v = (v << 8) | buf[i + 1 + k];
  }
  *lenOut = v;
  *next = i + 1 + c;
  return true;
}

static int oidEncode(const char *oid, uint8_t *out, int cap) {
  int parts[24];
  int n = 0;
  const char *p = oid;
  while (*p && n < 24) {
    if (*p == '.') {
      p++;
      continue;
    }
    int v = 0;
    while (*p >= '0' && *p <= '9') {
      v = v * 10 + (*p - '0');
      p++;
    }
    parts[n++] = v;
  }
  if (n < 2 || cap < 2) {
    return 0;
  }
  int i = 0;
  out[i++] = 40 * parts[0] + parts[1];
  for (int k = 2; k < n; k++) {
    int v = parts[k];
    uint8_t stack[5];
    int s = 0;
    stack[s++] = v & 0x7F;
    v >>= 7;
    while (v) {
      stack[s++] = 0x80 | (v & 0x7F);
      v >>= 7;
    }
    while (s && i < cap) {
      out[i++] = stack[--s];
    }
  }
  return i;
}

int snmpGet(const char *host, const char *oid, uint8_t *value, int valueCap, int *valueLen, uint8_t *valueTag) {
  uint8_t pkt[128];
  int i = 0;
  uint8_t oidBuf[48];
  int oidLen = oidEncode(oid, oidBuf, sizeof(oidBuf));
  if (oidLen == 0) {
    return -1;
  }
  const char *comm = SNMP_COMMUNITY;
  int commLen = strlen(comm);
  uint8_t reqId[4] = {0x12, 0x34, 0x56, 0x78};
  int vbLen = 2 + oidLen + 2;
  int vblLen = 2 + vbLen;
  int pduLen = 6 + 3 + 3 + 2 + vblLen;
  int bodyLen = 3 + 2 + commLen + 2 + pduLen;
  pkt[i++] = 0x30;
  pkt[i++] = (uint8_t)bodyLen;
  pkt[i++] = 0x02;
  pkt[i++] = 0x01;
  pkt[i++] = 0x00;
  pkt[i++] = 0x04;
  pkt[i++] = (uint8_t)commLen;
  memcpy(pkt + i, comm, commLen);
  i += commLen;
  pkt[i++] = 0xA0;
  pkt[i++] = (uint8_t)pduLen;
  pkt[i++] = 0x02;
  pkt[i++] = 0x04;
  memcpy(pkt + i, reqId, 4);
  i += 4;
  pkt[i++] = 0x02;
  pkt[i++] = 0x01;
  pkt[i++] = 0x00;
  pkt[i++] = 0x02;
  pkt[i++] = 0x01;
  pkt[i++] = 0x00;
  pkt[i++] = 0x30;
  pkt[i++] = (uint8_t)vblLen;
  pkt[i++] = 0x30;
  pkt[i++] = (uint8_t)vbLen;
  pkt[i++] = 0x06;
  pkt[i++] = (uint8_t)oidLen;
  memcpy(pkt + i, oidBuf, oidLen);
  i += oidLen;
  pkt[i++] = 0x05;
  pkt[i++] = 0x00;

  WiFiUDP udp;
  IPAddress ip;
  if (!ip.fromString(host)) {
    return -1;
  }
  if (!udp.beginPacket(ip, 161)) {
    return -1;
  }
  udp.write(pkt, i);
  if (!udp.endPacket()) {
    return -1;
  }
  uint32_t start = millis();
  while (millis() - start < 1500) {
    int n = udp.parsePacket();
    if (n > 0) {
      uint8_t buf[256];
      if (n > (int)sizeof(buf)) {
        n = sizeof(buf);
      }
      n = udp.read(buf, n);
      for (int p = 0; p < n - 2; p++) {
        if (buf[p] == 0x06) {
          int olen = buf[p + 1];
          int q = p + 2 + olen;
          if (q + 1 < n) {
            *valueTag = buf[q];
            int vlen = buf[q + 1];
            if (q + 2 + vlen <= n && vlen <= valueCap) {
              memcpy(value, buf + q + 2, vlen);
              *valueLen = vlen;
              udp.stop();
              return 0;
            }
          }
        }
      }
      udp.stop();
      return -2;
    }
    delay(10);
    yield();
  }
  udp.stop();
  return -3;
}

int snmpInt(const char *host, const char *oid, int unknown) {
  uint8_t raw[8];
  int n = 0;
  uint8_t tag = 0;
  if (snmpGet(host, oid, raw, sizeof(raw), &n, &tag) != 0 || n <= 0) {
    return unknown;
  }
  int v = 0;
  for (int i = 0; i < n; i++) {
    v = (v << 8) | raw[i];
  }
  if (tag == 0x02 && (raw[0] & 0x80)) {
    int bits = n * 8;
    if (bits < 32) {
      v -= (1 << bits);
    }
  }
  return v;
}

String snmpStr(const char *host, const char *oid) {
  uint8_t raw[48];
  int n = 0;
  uint8_t tag = 0;
  if (snmpGet(host, oid, raw, sizeof(raw), &n, &tag) != 0 || n <= 0) {
    return "";
  }
  String s;
  for (int i = 0; i < n; i++) {
    if (raw[i] >= 32 && raw[i] < 127) {
      s += (char)raw[i];
    }
  }
  return s;
}
