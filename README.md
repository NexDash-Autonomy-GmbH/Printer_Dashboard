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

Use the Google Workspace mailbox (for example `alwin@nexdash.com`) with:

| | User SMTP | Org relay |
|---|---|---|
| Host | `smtp.gmail.com` | `smtp-relay.gmail.com` |
| Port | 587 (TLS) | 587, 465, or 25 |
| Auth | full address + 16-character App Password | IP allowlist or SMTP auth |

That mailbox can send to anyone at `nexdash.com`, and typically to any other address, within Google’s daily limits (about 2,000 messages/day on `smtp.gmail.com`, 10,000 recipients/day on relay).

If 2-Step Verification is on, create an App Password: Google Account → Security → App passwords. Put that 16-character value in `SMTP_PASSWORD`. A normal Workspace password is rejected (`Application-specific password required`).

SES on the laptop IAM user can send as `alwin@nexdash.com` only. Other verified identities such as `parth@nexdash.com` return AccessDenied. Workspace SMTP is the send path this app uses.

Gmail attachment limit is 25 MB. A 100-page colour 300 dpi scan can exceed that.

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
