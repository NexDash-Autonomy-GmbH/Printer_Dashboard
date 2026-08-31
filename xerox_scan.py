#!/usr/bin/env python3
"""Scan the Xerox B305 and email the PDF via Google Workspace SMTP."""

from __future__ import annotations

import argparse
import base64
import hmac
import http.client
import io
import json
import os
import re
import smtplib
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from urllib.parse import urlsplit
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path.home() / ".config/xerox-scan/config.json"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ESCL_NS = {
    "scan": "http://schemas.hp.com/imaging/escl/2011/05/03",
    "pwg": "http://www.pwg.org/schemas/2010/12/sm",
}
A4_WIDTH = 2480
A4_HEIGHT = 3508
MAX_PAGES = 200
PAGE_TIMEOUT = 180
NEXDASH_MAILS = [
    "alwin@nexdash.com",
    "parth@nexdash.com",
    "esteban@nexdash.com",
    "elisa@nexdash.com",
    "franck@nexdash.com",
    "michael@nexdash.com",
    "karsten@nexdash.com",
    "gabriel@nexdash.com",
    "berit@nexdash.com",
]
_ses_nexdash: list[str] | None = None


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(ROOT / ".env")
load_dotenv(Path.home() / ".config/xerox-scan/.env")


def env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def load_config() -> dict[str, Any]:
    data: dict[str, Any] = {}
    if CONFIG_PATH.exists():
        loaded = json.loads(CONFIG_PATH.read_text())
        if isinstance(loaded, dict):
            data = loaded
    data.setdefault("emails", [])
    data["printer_host"] = env("PRINTER_HOST") or data.get("printer_host") or "192.168.68.52"
    data["scan_dir"] = env("SCAN_DIR") or data.get("scan_dir") or str(
        Path.home() / "Documents/Xerox-scans"
    )
    from_email = (env("SMTP_FROM_EMAIL") or env("SMTP_USER")).strip().lower()
    data["smtp"] = {
        "host": env("SMTP_HOST", "smtp.gmail.com"),
        "port": int(env("SMTP_PORT", "587") or "587"),
        "username": env("SMTP_USER"),
        "password": env("SMTP_PASSWORD"),
        "from_email": from_email,
        "from_name": env("SMTP_FROM_NAME") or from_email,
    }
    data["emails"] = [e for e in data["emails"] if e.strip().lower() != from_email]
    data["workspace_emails"] = workspace_emails(from_email)
    return data


def ses_nexdash_emails() -> list[str]:
    global _ses_nexdash
    if _ses_nexdash is not None:
        return _ses_nexdash
    try:
        raw = subprocess.check_output(
            [
                "aws",
                "ses",
                "list-identities",
                "--region",
                "eu-central-1",
                "--identity-type",
                "EmailAddress",
                "--output",
                "json",
            ],
            timeout=8,
            stderr=subprocess.DEVNULL,
        )
        identities = json.loads(raw).get("Identities") or []
        _ses_nexdash = [
            str(item).strip().lower()
            for item in identities
            if str(item).strip().lower().endswith("@nexdash.com")
        ]
    except Exception:
        _ses_nexdash = []
    return _ses_nexdash


def workspace_emails(from_email: str) -> list[str]:
    found: list[str] = []
    for raw in env("WORKSPACE_EMAILS").split(","):
        addr = raw.strip().lower()
        if addr.endswith("@nexdash.com"):
            found.append(addr)
    found.extend(ses_nexdash_emails())
    found.extend(NEXDASH_MAILS)
    unique: list[str] = []
    sender = from_email.strip().lower()
    for addr in found:
        if addr and addr != sender and addr not in unique:
            unique.append(addr)
    unique.sort()
    return unique


def save_config(cfg: dict[str, Any]) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    stored = {"emails": list(cfg.get("emails") or []), "printer_host": cfg.get("printer_host")}
    CONFIG_PATH.write_text(json.dumps(stored, indent=2) + "\n")
    CONFIG_PATH.chmod(0o600)


def printer_base(cfg: dict[str, Any]) -> str:
    host = str(cfg["printer_host"]).rstrip("/")
    if host.startswith("http://") or host.startswith("https://"):
        return host
    return f"http://{host}"


_opener = urllib.request.build_opener()
_tls = threading.local()


def http(
    url: str,
    *,
    data: bytes | None = None,
    method: str | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> tuple[int, dict[str, str], bytes]:
    method = method or ("POST" if data is not None else "GET")
    parts = urlsplit(url)
    if parts.scheme != "http" or not parts.hostname:
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        try:
            with _opener.open(req, timeout=timeout) as resp:
                hdrs = {k.lower(): v for k, v in resp.headers.items()}
                return resp.status, hdrs, resp.read()
        except urllib.error.HTTPError as err:
            hdrs = {k.lower(): v for k, v in err.headers.items()} if err.headers else {}
            return err.code, hdrs, err.read() or b""
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, {}, b""

    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    port = parts.port or 80
    hdrs_in = {"Connection": "keep-alive", "Host": parts.hostname}
    if headers:
        hdrs_in.update(headers)
    attempts = 2 if method in ("GET", "DELETE") else 1
    for attempt in range(attempts):
        conn: http.client.HTTPConnection | None = getattr(_tls, "conn", None)
        reused = (
            conn is not None
            and conn.host == parts.hostname
            and (conn.port or 80) == port
            and conn.sock is not None
        )
        try:
            if not reused:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
                conn = http.client.HTTPConnection(parts.hostname, port, timeout=timeout)
                _tls.conn = conn
            else:
                conn.timeout = timeout
                if conn.sock is not None:
                    conn.sock.settimeout(timeout)
            conn.request(method, path, body=data, headers=hdrs_in)
            resp = conn.getresponse()
            body = resp.read()
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, hdrs, body
        except (TimeoutError, OSError, http.client.HTTPException):
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
            _tls.conn = None
            if reused and attempt + 1 < attempts:
                continue
            return 0, {}, b""
    return 0, {}, b""


class BadEmail(ValueError):
    pass


def parse_email(value: str) -> str:
    addr = value.strip().lower()
    if not EMAIL_RE.match(addr):
        raise BadEmail(f"not an email address: {value}")
    return addr


def normalize_email(value: str) -> str:
    try:
        return parse_email(value)
    except BadEmail as err:
        sys.exit(str(err))


def cmd_status(cfg: dict[str, Any]) -> int:
    base = printer_base(cfg)
    code, _, body = http(f"{base}/eSCL/ScannerStatus", timeout=8)
    if code != 200:
        print(f"scanner unreachable at {base} (HTTP {code})", file=sys.stderr)
        return 1
    root = ET.fromstring(body)
    state = root.findtext("pwg:State", default="?", namespaces=ESCL_NS)
    adf = root.findtext("scan:AdfState", default="?", namespaces=ESCL_NS)
    smtp = cfg.get("smtp") or {}
    print(f"printer:  {cfg['printer_host']}")
    print(f"model:    Xerox B305 MFP")
    print(f"scanner:  {state}")
    print(f"adf:      {adf}")
    print(f"web ui:   {base}/")
    print(f"scans:    {cfg['scan_dir']}")
    print(f"from:     {smtp.get('from_email') or '(unset)'} ({smtp.get('host')})")
    emails = cfg.get("emails") or []
    print("email to: " + (", ".join(emails) if emails else "(none, scans will not be emailed)"))
    return 0


def cmd_emails(cfg: dict[str, Any]) -> int:
    emails = cfg.get("emails") or []
    if not emails:
        print("no recipients. scans will not be emailed")
        return 0
    for addr in emails:
        print(addr)
    return 0


def cmd_add_email(cfg: dict[str, Any], raw: str) -> int:
    addr = normalize_email(raw)
    sender = ((cfg.get("smtp") or {}).get("from_email") or "").lower()
    if addr == sender:
        print(f"{addr} is the sender")
        return 1
    emails = list(cfg.get("emails") or [])
    if addr in emails:
        print(f"already listed: {addr}")
        return 0
    emails.append(addr)
    cfg["emails"] = emails
    save_config(cfg)
    print(f"added {addr}")
    return 0


def cmd_remove_email(cfg: dict[str, Any], raw: str) -> int:
    addr = normalize_email(raw)
    emails = list(cfg.get("emails") or [])
    if addr not in emails:
        print(f"not listed: {addr}", file=sys.stderr)
        return 1
    cfg["emails"] = [e for e in emails if e != addr]
    save_config(cfg)
    print(f"removed {addr}")
    return 0


_status_lock = threading.Lock()
_status_at = 0.0
_status_host = ""
_status_pair = ("unreachable", "unknown")


def scanner_status(cfg: dict[str, Any], *, fresh: bool = False) -> tuple[str, str]:
    global _status_at, _status_host, _status_pair
    host = str(cfg.get("printer_host") or "")
    now = time.monotonic()
    if not fresh:
        with _status_lock:
            if host == _status_host and now - _status_at < 1.5:
                return _status_pair
    base = printer_base(cfg)
    code, _, body = http(f"{base}/eSCL/ScannerStatus", timeout=8 if fresh else 2)
    state, adf = "unreachable", "unknown"
    if code == 200:
        root = ET.fromstring(body)
        state = root.findtext("pwg:State", default="?", namespaces=ESCL_NS) or "?"
        adf = root.findtext("scan:AdfState", default="?", namespaces=ESCL_NS) or "?"
    with _status_lock:
        _status_at = time.monotonic()
        _status_host = host
        _status_pair = (state, adf)
    return state, adf


def pick_source(cfg: dict[str, Any], requested: str) -> str:
    state, adf = scanner_status(cfg, fresh=True)
    if state == "unreachable":
        raise RuntimeError("cannot read scanner status")
    if requested == "adf":
        if adf == "ScannerAdfEmpty" or "empty" in adf.lower():
            raise RuntimeError("ADF is empty")
        return "Feeder"
    if requested == "platen":
        return "Platen"
    if adf and adf != "ScannerAdfEmpty" and "empty" not in adf.lower():
        return "Feeder"
    return "Platen"


def scan_settings_xml(source: str) -> bytes:
    height = 4200 if source == "Feeder" else A4_HEIGHT
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03"
                   xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.6</pwg:Version>
  <scan:Intent>Document</scan:Intent>
  <pwg:ScanRegions>
    <pwg:MustHonor>true</pwg:MustHonor>
    <pwg:ScanRegion>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:Width>{A4_WIDTH}</pwg:Width>
      <pwg:Height>{height}</pwg:Height>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>{source}</pwg:InputSource>
  <pwg:DocumentFormat>application/pdf</pwg:DocumentFormat>
  <scan:ColorMode>RGB24</scan:ColorMode>
  <scan:XResolution>300</scan:XResolution>
  <scan:YResolution>300</scan:YResolution>
</scan:ScanSettings>
"""
    return xml.encode("utf-8")


def assemble_pdf(pages: list[tuple[str, bytes]], dest: Path) -> Path:
    if len(pages) == 1 and "pdf" in pages[0][0]:
        dest.write_bytes(pages[0][1])
        return dest

    from PIL import Image
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    for ctype, data in pages:
        if "pdf" in ctype:
            reader = PdfReader(io.BytesIO(data))
            for page in reader.pages:
                writer.add_page(page)
            continue
        image = Image.open(io.BytesIO(data))
        if image.mode != "RGB":
            image = image.convert("RGB")
        buf = io.BytesIO()
        image.save(buf, format="PDF", resolution=300)
        buf.seek(0)
        reader = PdfReader(buf)
        writer.add_page(reader.pages[0])
    with dest.open("wb") as handle:
        writer.write(handle)
    return dest


def send_scan(cfg: dict[str, Any], path: Path, recipients: list[str], dry_run: bool) -> None:
    smtp = cfg.get("smtp") or {}
    host = smtp.get("host") or "smtp.gmail.com"
    port = int(smtp.get("port") or 587)
    username = smtp.get("username")
    password = smtp.get("password")
    from_email = smtp.get("from_email") or username
    if not (username and password and from_email):
        raise RuntimeError("SMTP_USER, SMTP_PASSWORD and SMTP_FROM_EMAIL must be set in .env")

    subject = f"Xerox scan {path.name}"
    body = f"Scan from the Xerox B305 at {cfg['printer_host']}.\nFile: {path.name}\n"
    if dry_run:
        print(f"[dry-run] would email {path.name} to {', '.join(recipients)} from {from_email}")
        return

    msg = MIMEMultipart()
    from_name = smtp.get("from_name") or from_email
    msg["From"] = f"{from_name} <{from_email}>"
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=from_email.split("@", 1)[-1])
    msg.attach(MIMEText(body, "plain", "utf-8"))
    part = MIMEApplication(path.read_bytes(), _subtype="pdf")
    part.add_header("Content-Disposition", "attachment", filename=path.name)
    msg.attach(part)

    server = smtplib.SMTP(host, port, timeout=30)
    try:
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(username, password)
        server.sendmail(from_email, recipients, msg.as_string())
    except smtplib.SMTPAuthenticationError as err:
        raise RuntimeError(
            "SMTP login failed. For Google Workspace use smtp.gmail.com:587 "
            "with a 16-character App Password, not the account password."
        ) from err
    finally:
        try:
            server.quit()
        except smtplib.SMTPServerDisconnected:
            pass
    print(f"emailed {path.name} to {', '.join(recipients)} via {host}")


def run_scan(
    cfg: dict[str, Any],
    *,
    source: str = "auto",
    extra: list[str] | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    log: list[str] = []
    extra = extra or []
    recipients: list[str] = []
    for addr in list(cfg.get("emails") or []) + extra:
        if addr not in recipients:
            recipients.append(addr)

    try:
        base = printer_base(cfg)
        chosen = pick_source(cfg, source)
    except RuntimeError as err:
        return {
            "ok": False,
            "stage": "scan_failed",
            "scanned": False,
            "emailed": False,
            "error": str(err),
        }

    log.append(f"scanning {chosen.lower()} on {cfg['printer_host']}")
    code, hdrs, body = http(
        f"{base}/eSCL/ScanJobs",
        data=scan_settings_xml(chosen),
        method="POST",
        headers={"Content-Type": "text/xml"},
        timeout=30,
    )
    if code not in (201, 200):
        snippet = body.decode("utf-8", errors="replace")[:500]
        return {
            "ok": False,
            "stage": "scan_failed",
            "scanned": False,
            "emailed": False,
            "error": f"scan job rejected (HTTP {code})\n{snippet}",
        }

    location = hdrs.get("location")
    if not location:
        return {
            "ok": False,
            "stage": "scan_failed",
            "scanned": False,
            "emailed": False,
            "error": "scanner did not return a job URL",
        }
    if location.startswith("/"):
        location = base + location
    elif not location.startswith("http"):
        location = f"{base}/eSCL/ScanJobs/{location}"

    doc_url = location.rstrip("/") + "/NextDocument"
    pages: list[tuple[str, bytes]] = []
    while len(pages) < MAX_PAGES:
        code, hdrs, data = http(doc_url, timeout=PAGE_TIMEOUT)
        if code == 404 or not data:
            break
        if code != 200:
            snippet = data.decode("utf-8", errors="replace")[:500]
            http(location, method="DELETE", timeout=10)
            return {
                "ok": False,
                "stage": "scan_failed",
                "scanned": False,
                "emailed": False,
                "error": f"no scan data (HTTP {code})\n{snippet}",
            }
        pages.append((hdrs.get("content-type", "application/pdf"), data))
        log.append(f"page {len(pages)} ({len(data)} bytes)")

    if not pages:
        http(location, method="DELETE", timeout=10)
        return {
            "ok": False,
            "stage": "scan_failed",
            "scanned": False,
            "emailed": False,
            "error": "scanner returned no pages",
        }

    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    out_dir = Path(cfg["scan_dir"]).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"scan_{stamp}.pdf"
    assemble_pdf(pages, dest)
    log.append(f"saved {dest} ({dest.stat().st_size} bytes, {len(pages)} page(s))")
    http(location, method="DELETE", timeout=10)

    emailed = False
    if not recipients:
        log.append("no recipients, not sending mail")
    else:
        try:
            send_scan(cfg, dest, recipients, dry_run)
            emailed = not dry_run
            log.append(f"{'dry-run mail' if dry_run else 'emailed'} to {', '.join(recipients)}")
        except Exception as err:
            return {
                "ok": False,
                "stage": "mail_failed",
                "scanned": True,
                "emailed": False,
                "error": str(err),
                "files": [str(dest)],
                "recipients": recipients,
                "log": log,
            }

    stage = "sent" if emailed else "saved"
    return {
        "ok": True,
        "stage": stage,
        "scanned": True,
        "emailed": emailed,
        "files": [str(dest)],
        "recipients": recipients,
        "pages": len(pages),
        "log": log,
    }


def cmd_scan(cfg: dict[str, Any], args: argparse.Namespace) -> int:
    extra = [normalize_email(a) for a in (args.to or [])]
    result = run_scan(cfg, source=args.source, extra=extra, dry_run=args.dry_run_mail)
    if not result.get("ok"):
        sys.exit(result.get("error") or "scan failed")
    for line in result.get("log") or []:
        print(line)
    return 0


def printer_state(cfg: dict[str, Any]) -> dict[str, Any]:
    base = printer_base(cfg)
    state, adf = scanner_status(cfg)
    smtp = cfg.get("smtp") or {}
    sender = (smtp.get("from_email") or "").lower()
    return {
        "printer_host": cfg.get("printer_host"),
        "model": "Xerox B305 MFP",
        "scanner": state,
        "adf": adf,
        "scan_dir": cfg.get("scan_dir"),
        "from_email": smtp.get("from_email"),
        "from_name": smtp.get("from_name"),
        "ses_region": smtp.get("host"),
        "emails": [e for e in (cfg.get("emails") or []) if e.lower() != sender],
        "workspace_emails": list(cfg.get("workspace_emails") or []),
        "web_ui": f"{base}/",
    }


def _lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("1.1.1.1", 80))
        return sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()


def cmd_dash(cfg: dict[str, Any], port: int, open_browser: bool = True) -> int:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import mimetypes
    import urllib.parse
    import webbrowser

    dist = ROOT / "dist"
    cors_origins = ("http://127.0.0.1:5173", "http://localhost:5173")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: object) -> None:
            return

        def _cors(self) -> None:
            origin = self.headers.get("Origin") or ""
            if origin in cors_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _json(self, code: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self._cors()
            self.end_headers()
            self.wfile.write(raw)

        def _authorized(self) -> bool:
            user = env("DASH_USER")
            password = env("DASH_PASSWORD")
            if not user or not password:
                return True
            header = self.headers.get("Authorization") or ""
            if not header.startswith("Basic "):
                return False
            try:
                decoded = base64.b64decode(header.split(" ", 1)[1]).decode()
                got_user, got_pass = decoded.split(":", 1)
            except Exception:
                return False
            return hmac.compare_digest(got_user, user) and hmac.compare_digest(got_pass, password)

        def _challenge(self) -> None:
            body = b"auth required\n"
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="Printer Dashboard"')
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors()
            self.end_headers()

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or "0")
            if length <= 0:
                return {}
            if length > 8192:
                return {}
            raw = self.rfile.read(length)
            if not raw:
                return {}
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                return {}
            return data if isinstance(data, dict) else {}

        def do_GET(self) -> None:  # noqa: N802
            if not self._authorized():
                self._challenge()
                return
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/state":
                self._json(200, printer_state(load_config()))
                return
            if not dist.exists():
                self._json(503, {"ok": False, "error": "dashboard not built. run npm run build"})
                return
            rel = parsed.path.lstrip("/") or "index.html"
            candidate = (dist / rel).resolve()
            if not str(candidate).startswith(str(dist.resolve())):
                self.send_error(404)
                return
            if candidate.is_dir() or not candidate.exists():
                candidate = dist / "index.html"
            data = candidate.read_bytes()
            ctype = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:  # noqa: N802
            if not self._authorized():
                self._challenge()
                return
            parsed = urllib.parse.urlparse(self.path)
            payload = self._body()
            if parsed.path == "/api/emails":
                try:
                    addr = parse_email(str(payload.get("email") or ""))
                except BadEmail as err:
                    self._json(400, {"ok": False, "error": str(err)})
                    return
                current = load_config()
                sender = (current.get("smtp") or {}).get("from_email") or ""
                if addr == sender:
                    self._json(400, {"ok": False, "error": f"{addr} is the sender, not a recipient"})
                    return
                emails = list(current.get("emails") or [])
                if addr not in emails:
                    emails.append(addr)
                    current["emails"] = emails
                    save_config(current)
                    self._json(200, {"ok": True, "emails": emails, "added": True})
                    return
                self._json(200, {"ok": True, "emails": emails, "added": False})
                return
            if parsed.path == "/api/scan":
                source = str(payload.get("source") or "auto")
                if source not in ("auto", "platen", "adf"):
                    source = "auto"
                result = run_scan(load_config(), source=source)
                self._json(200, result)
                return
            self.send_error(404)

        def do_DELETE(self) -> None:  # noqa: N802
            if not self._authorized():
                self._challenge()
                return
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/api/emails":
                self.send_error(404)
                return
            query = urllib.parse.parse_qs(parsed.query)
            raw = (query.get("email") or [""])[0]
            try:
                addr = parse_email(raw)
            except BadEmail as err:
                self._json(400, {"ok": False, "error": str(err)})
                return
            current = load_config()
            emails = [e for e in (current.get("emails") or []) if e != addr]
            current["emails"] = emails
            save_config(current)
            self._json(200, {"ok": True, "emails": emails})

    listen_port = int(env("DASH_PORT") or port)
    server = ThreadingHTTPServer(("0.0.0.0", listen_port), Handler)
    lan_ip = _lan_ip()
    print(f"dashboard  http://127.0.0.1:{listen_port}/")
    if lan_ip:
        print(f"on the LAN http://{lan_ip}:{listen_port}/")
    if open_browser:
        webbrowser.open(f"http://127.0.0.1:{listen_port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        return 0
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="xerox-scan",
        description="Scan the Xerox B305 and email the PDF to saved recipients.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="printer and scanner state")
    sub.add_parser("emails", help="list saved addresses")
    add_p = sub.add_parser("add-email", help="add a recipient")
    add_p.add_argument("address")
    rm_p = sub.add_parser("remove-email", help="remove a recipient")
    rm_p.add_argument("address")
    scan_p = sub.add_parser("scan", help="scan, save one PDF, and email")
    scan_p.add_argument("--source", choices=("auto", "platen", "adf"), default="auto")
    scan_p.add_argument("--to", action="append", default=[])
    scan_p.add_argument("--dry-run-mail", action="store_true")
    dash_p = sub.add_parser("dash", help="open the dashboard")
    dash_p.add_argument("--port", type=int, default=8765)
    dash_p.add_argument("--no-browser", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    cfg = load_config()
    if args.cmd == "status":
        return cmd_status(cfg)
    if args.cmd == "emails":
        return cmd_emails(cfg)
    if args.cmd == "add-email":
        return cmd_add_email(cfg, args.address)
    if args.cmd == "remove-email":
        return cmd_remove_email(cfg, args.address)
    if args.cmd == "scan":
        return cmd_scan(cfg, args)
    if args.cmd == "dash":
        return cmd_dash(cfg, args.port, open_browser=not args.no_browser)
    raise AssertionError(args.cmd)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        sys.exit(130)
