#pragma once
#include <Arduino.h>

// What the printer's own web interface reports.
//
// SNMP is the primary source and stays that way, but this B305's SNMP agent
// went silent for hours while its HTTP interface stayed perfectly healthy,
// and a dashboard that says "No reading" against a printer sitting there
// working is not much use. These read the same facts over HTTP.
//
// The web interface also knows things SNMP never exposed here: each
// cartridge's own serial number, pages remaining, and the real paper size in
// every tray.

struct WebSupply {
  String name;
  int pct;        // -1 when the printer will not say
  String status;  // "OK", "Low", ...
};

struct WebTray {
  String name;
  int capacity;
  int pct;        // -1 unknown
};

// Reads supplies and trays from /webglue/webui/nodedata/Status. Streamed and
// parsed as it arrives: the response is ~32 KB against 80 KB of RAM, so it is
// never held whole.
// serialOut receives DeviceSerialNumberUnq, which is the number this printer's
// own interface labels "Serial Number" and the one SNMP returns. Note that
// eSCL reports a different number in its SerialNumber field: that is the TSN,
// DeviceSerialNumberTrk. Two real identifiers, and only one is on the label.
bool webuiStatus(const String &host, WebSupply *supplies, int supplyCap, int &supplyCount,
                 WebTray *trays, int trayCap, int &trayCount, String &serialOut);

// Model and serial from the eSCL capabilities document, which is the same
// endpoint the scanner already uses.
bool webuiIdentity(const String &host, String &model, String &serial);

// pwg:State from eSCL: "Idle", "Processing", or empty if unreachable.
String webuiScannerState(const String &host);
