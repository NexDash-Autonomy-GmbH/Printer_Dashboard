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

## Back at the office

Printer IP stays `192.168.68.52` in `.env`. Join the NexDash Wi-Fi. On this Mac open http://127.0.0.1:8765/. Other people on that Wi-Fi use `http://<this-mac-lan-ip>:8765/`.

`./deploy/install-launchd.sh` starts the dashboard at login and restarts it if it dies. No extra setup when you walk in.

The ESP32 is not part of this path. It cannot see the Xerox unless it is left on the office Wi-Fi, and it cannot carry a full scan PDF.

## Production workaround

The Xerox is on the office LAN (`192.168.68.52`). ECS, Netlify, and Vercel cannot scan it. The process that talks eSCL has to sit on a machine that can ping that printer.

What works:

1. Leave this Mac (or a Mac Mini / Pi) on the NexDash Wi-Fi, plugged in, not sleeping.
2. Keep the dashboard running: `python3 xerox_scan.py dash` or `./deploy/install-launchd.sh` so it comes back after login.
3. Same building: `http://192.168.68.60:8765/` (IP changes if DHCP moves).
4. Outside the building: a tunnel from that machine, not a cloud frontend.
   - Temporary: `ngrok http 8765`
   - Lasting: Cloudflare Tunnel or Tailscale Funnel to a hostname you own, pointed at `localhost:8765`.

Set `DASH_USER` and `DASH_PASSWORD` in `.env` before you share a public URL. Without those, anyone with the link can scan and send mail as the Workspace sender. There is no other login.

Do not put `.env` on a public host. SMTP lives only on the office box.
