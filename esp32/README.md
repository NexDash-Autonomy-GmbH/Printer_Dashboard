# ESP32 bridge (Go)

The chip must sit on the **office** Wi-Fi so it can reach `192.168.68.52`. From home USB it cannot see the Xerox.

## Protocol

The ESP32 long-polls the Go API, then talks eSCL to the printer:

1. `GET {API}/bridge/poll?token=...`
2. If `job` is set, `POST http://{printer}/eSCL/ScanJobs` and `GET .../NextDocument`
3. `POST {API}/bridge/result?token=...&job=...` with the PDF body

## Flash (TinyGo)

```bash
cp wifi.example.go wifi.go
# set apiBase, wifiSSID, wifiPass
tinygo flash -target=esp32 -port /dev/cu.wchusbserial210 .
```

This Mac has no TinyGo/esptool yet. Flash when those are installed, then leave the ESP32 powered at the office.

## Without TinyGo

On any computer that is on the office LAN:

```bash
API_BASE=https://your-api go run ./cmd/office-agent
```

That is the same Go protocol as the ESP32 firmware.
