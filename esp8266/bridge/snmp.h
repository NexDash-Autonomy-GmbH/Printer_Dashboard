#pragma once
#include <Arduino.h>

int snmpGet(const char *host, const char *oid, uint8_t *value, int valueCap, int *valueLen, uint8_t *valueTag);
int snmpInt(const char *host, const char *oid, int unknown = -999999);
String snmpStr(const char *host, const char *oid);
