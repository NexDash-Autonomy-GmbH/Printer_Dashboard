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
