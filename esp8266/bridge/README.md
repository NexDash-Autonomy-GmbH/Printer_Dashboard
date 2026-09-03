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

## Ask in HTTP/1.0 whenever you read the stream yourself

This one has bitten twice and cost a working feature both times, so it is the
first thing to check if data arriving through the bridge looks mangled.

This printer answers with `Transfer-Encoding: chunked`, and
`ESP8266HTTPClient` de-chunks **only** inside `getString()` and
`writeToStream()` -- never on the stream you get from `getStreamPtr()`. Read
that stream over HTTP/1.1 and every chunk-size line lands in the middle of
your data.

It corrupted scans for a day: `NextDocument` is chunked, `downloadToFile`
reads the raw stream, and the emailed PDF rendered cleanly at the top and then
dissolved into bands of colour where the injected bytes wrecked the JPEG.
Nothing about it looked like a transport bug -- the file was the right size and
a valid PDF.

So: **every `HTTPClient` in this sketch calls `http.useHTTP10(true)`**, and any
new one that reads `getStreamPtr()` must too. There are three, and the audit is
one command:

```
grep -nE "HTTPClient|useHTTP10|getStreamPtr" bridge.ino
```

The first time this appeared it was fixed in one place only. The second
instance had been sitting in `downloadToFile` the whole time. Fix the class,
not the instance.

## What the bridge reads

SNMP for the device status, one query, with a backoff when the agent goes
quiet -- which this printer does for hours while its HTTP interface stays
perfectly healthy. eSCL's `ScannerStatus` is the fallback, and proves the
printer is at least on the network.

**The printer has two serial numbers.** `DeviceSerialNumberUnq` is the one its
own interface labels "Serial Number" and the one SNMP returns: `3026970899` on
this unit. `DeviceSerialNumberTrk` is the TSN, `701951340W7GM`, and that is
what eSCL puts in its `SerialNumber` field. Both are real; only the first is on
the label.
