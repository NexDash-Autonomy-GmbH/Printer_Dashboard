# Printer Dashboard

LAN dashboard for the Xerox B305 at NexDash. Add recipients, scan from the glass or ADF, and email one PDF.

Scans of many pages (ADF, up to 200) are merged into a single PDF, then sent from the Google Workspace mailbox in `.env`.

## Setup

```bash
git clone https://github.com/NexDash-Autonomy-GmbH/Printer_Dashboard.git
cd Printer_Dashboard
cp .env.example .env   # or .env_example
```

Edit `.env`. Set SMTP user, password, and from-address. Do not commit `.env`.

```bash
npm install
npm run build
python3 xerox_scan.py dash
```

Open http://127.0.0.1:8765/ on this Mac, or `http://<this-machine-ip>:8765/` on the same Wi-Fi.

## Mail

SMTP is Google Workspace (`smtp.gmail.com`, port 587). The sender is whoever you put in `.env`. A normal Google password does not work. You need an App Password.

### Make an App Password

The person who will send must do this on **their** Google account (the mailbox that should appear as From).

1. Turn on 2-Step Verification for that account if it is not on: [Google Account security](https://myaccount.google.com/security).
2. Open [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) while signed in as that person.
3. If Google asks you to sign in again, use that mailbox (for example `parth@nexdash.com`), not someone else’s.
4. App name: `Printer Dashboard` (any label is fine).
5. Create. Google shows a 16-character password in four groups, like `xxxx xxxx xxxx xxxx`.
6. Copy it. Google will not show it again. Spaces are optional; the app stores it with spaces removed.

If the App passwords page is missing, the admin has blocked it, or 2-Step Verification is off.

### Point the dashboard at that person as sender

On the office machine that runs the dashboard:

1. Open `.env` in the project root (copy from `.env.example` if you do not have one).
2. Set:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=the-person@nexdash.com
SMTP_PASSWORD=the16characterapppassword
SMTP_FROM_EMAIL=the-person@nexdash.com
SMTP_FROM_NAME=Their Name
```

3. Do not commit `.env`.
4. Restart the dashboard (`python3 xerox_scan.py dash`) so it reloads `.env`.
5. Hard-refresh the UI. The dialog Sender line should show that address.
6. That address is removed from Recipients automatically. Add other people as recipients if you still want them on the list.

The sender can mail anyone at `nexdash.com` (Gmail limit about 2,000 messages/day). Attachment cap is 25 MB.

This app does not use Amazon SES. The laptop SES user can only send as some identities and is the wrong path.

## CLI

```bash
python3 xerox_scan.py status
python3 xerox_scan.py emails
python3 xerox_scan.py add-email someone@nexdash.com
python3 xerox_scan.py remove-email someone@nexdash.com
python3 xerox_scan.py scan
python3 xerox_scan.py dash --port 8765
```

Recipient list is stored in `~/.config/xerox-scan/config.json`. SMTP settings come from `.env`.

## Layout

Vite + React + TypeScript + Tailwind + shadcn. Instrument Sans (400/500/600/700) plus Instrument Sans Fallback, bundled locally.

## Transport: long-poll on the chip, SSE in the browser

We compared WebSocket, SSE, and HTTPS long-poll for this stack (ESP8266EX, BearSSL, PDF upload, Cloudflare/ngrok in front).

| Link | Protocol | Why |
|---|---|---|
| ESP8266 → API | **HTTPS long-poll + POST** | Job notify is rare (one scan at a time). The PDF is **device → server**; SSE cannot carry that. WebSocket + TLS on this chip is a RAM risk (firmware already uses ~91% IRAM). Long-poll is ordinary HTTP, survives proxies, and we tested it. |
| Browser → API | **REST + SSE for status** | The UI only needs server→browser updates (scanning / sent / failed). SSE is HTTP, auto-reconnects, and is the right default when traffic is one-way. WebSocket would add a duplex channel we do not use. |

Speed: a scan takes seconds to minutes on the Xerox. Job pickup is a long-poll that wakes as soon as someone hits Scan, not a 20s sleep. The UI stops poking ScannerStatus while a scan is running. Printer HTTP connections are reused.

Security: HTTPS for the public API. The bridge token is only accepted as `Authorization: Bearer …`, never as `?token=` on the URL (that leaks in logs and Referer). CORS is an allowlist (`printer-dashboard.pages.dev`, localhost, plus `CORS_ORIGINS`). Uploaded PDFs are capped at 20 MB. Pages.dev cannot talk to `192.168.68.52` directly (browser Private Network Access).

Tests: `go test ./internal/realtime ./internal/bridge ./cmd/api`.

## Production (laptop can be off)

The webpage and the API stay up on Cloudflare. The Xerox does not. Something on the NexDash Wi-Fi has to press the scanner, which is the ESP8266 left at the office on a USB charger.

```
Browser (anywhere) → https://printer-dashboard.pages.dev
                  → https://printer-api.nexdash.workers.dev
ESP8266 on NexDash Wi-Fi → Xerox 192.168.68.52
ESP8266 → Worker API (HTTPS long-poll + PDF POST)
Worker → Gmail SMTP as the Workspace sender
```

ngrok (`https://cb21-89-245-192-80.ngrok-free.app`) is a tunnel to this Mac's port 8765. It dies when the lid closes. Do not use it as prod.

Flash `esp8266/bridge` with `secrets.h` (gitignored): office SSID, `API_BASE` `https://printer-api.nexdash.workers.dev`, and the same `BRIDGE_TOKEN` stored in Wrangler secrets. Leave the board at the office. Scan from the Pages URL after `bridge_online` is true.

```bash
VITE_API_BASE=https://printer-api.nexdash.workers.dev npm run build
npx wrangler pages deploy dist --project-name printer-dashboard
npx wrangler deploy -c api/wrangler.jsonc
```

GitHub Action `.github/workflows/pages.yml` rebuilds the UI on push. Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE`.

Local office fallback if the chip is not plugged in: `python3 xerox_scan.py dash` on a machine that can ping `192.168.68.52`, or `go run ./cmd/office-agent` with `API_BASE` and `BRIDGE_TOKEN`.

## Back at the office (this Mac on NexDash Wi-Fi)

Printer IP stays `192.168.68.52`. Open https://printer-dashboard.pages.dev/ or http://127.0.0.1:8765/.

`./deploy/install-launchd.sh` starts the local Python dash at login. That path is optional once the ESP8266 is left at the office.
