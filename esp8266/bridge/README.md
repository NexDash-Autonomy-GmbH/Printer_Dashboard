# ESP8266 bridge

Joins the office Wi-Fi, long-polls the Worker, scans the Xerox over eSCL and
streams queued PDFs into it on port 9100.

## Build and flash

Compile at **160 MHz**. TLS decryption is CPU-bound on the ESP8266, and the
print relay rate roughly tracks the clock; the default 80 MHz roughly halves it.

```sh
arduino-cli compile --fqbn esp8266:esp8266:nodemcuv2:xtal=160 esp8266/bridge --output-dir /tmp/bridge-build
arduino-cli upload  --fqbn esp8266:esp8266:nodemcuv2:xtal=160 -p /dev/cu.wchusbserial210 --input-dir /tmp/bridge-build esp8266/bridge
```

The board on the desk is an ESP8266EX with 4 MB flash on a CH340 (`wchusbserial`).
`secrets.h` (gitignored) carries `WIFI_SSID`, `WIFI_PASS`, `API_BASE`, `BRIDGE_TOKEN`;
copy `secrets.example.h` to start.

## Reading the LED

The onboard LED (GPIO2, active LOW) is driven by a 100 ms timer rather than from
`loop()`, which spends most of its life parked in a 20-second long-poll. A light
driven from there would sit still for 20 seconds at a time and mean nothing; on
a timer, **a still LED means the board is dead or unpowered, and nothing else.**

| Light | State |
|---|---|
| Solid on | Powered, on Wi-Fi, nothing to do |
| Slow blink, 800 ms | Scanning |
| Medium blink, 400 ms | Printing |
| Fast blink, 100 ms | Joining Wi-Fi (first 20 s after power-on) |
| Dark with one short blip | No Wi-Fi |

Busier is faster; the only mostly-dark pattern is the unhappy one.

## Watch it boot

Serial at 115200. The banner reports the clock, then Wi-Fi progress, then
`poll`, `job`, `print job` and `relay … KB/s` lines as it works. The garbage before
the banner is the ROM bootloader at 74880 baud and is normal.

## Two ways to ask the printer

SNMP is the primary source. It is also the one that fails: this B305's SNMP
agent went silent for hours while its web interface stayed perfectly healthy,
answering every request. So when SNMP returns nothing, `webui.cpp` reads the
same facts over HTTP instead, and the dashboard stays populated.

Three things to know before touching it.

**Ask in HTTP/1.0.** Over 1.1 the printer replies
`Transfer-Encoding: chunked`, and `ESP8266HTTPClient` only de-chunks inside
`getString()` and `writeToStream()`, never on the stream itself. Read the
stream of a 1.1 response and the chunk-size lines arrive mixed into the JSON.

**Read `getStreamPtr()`, never the `WiFiClient` you passed in.**
`HTTPClient::begin()` clones it, so the socket the request went out on is the
clone's. Reading your own object returns an empty stream with no error at all.

**The printer has two serial numbers.** `DeviceSerialNumberUnq` is the one its
own interface labels "Serial Number" and the one SNMP returns: `3026970899` on
this unit. `DeviceSerialNumberTrk` is the TSN, `701951340W7GM`, and that is
what eSCL puts in its `SerialNumber` field. Both are real. Only the first is
on the label, so that is the one the dashboard shows.

The status document is ~32 KB against 80 KB of RAM, so it is parsed as it
arrives and never held whole. `/webglue/webui/nodedata/Status` needs no
authentication, which is the printer's own configuration, not something the
bridge chose.
