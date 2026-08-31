"""SNMPv1 GETNEXT walker for Printer-MIB. Stdlib only. No SET."""

from __future__ import annotations

import random
import socket
import time
from typing import Any

OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0"
OID_SYS_UPTIME = "1.3.6.1.2.1.1.3.0"
OID_SYS_NAME = "1.3.6.1.2.1.1.5.0"
OID_DEVICE_DESC = "1.3.6.1.2.1.25.3.2.1.3.1"
OID_PRINTER_STATUS = "1.3.6.1.2.1.25.3.5.1.1.1"
OID_SERIAL = "1.3.6.1.2.1.43.5.1.1.17.1"
OID_PAGE_COUNT = "1.3.6.1.2.1.43.10.2.1.4.1.1"
OID_CONSOLE = "1.3.6.1.2.1.43.16.5.1.2.1.1"
OID_TONER_NAME = "1.3.6.1.2.1.43.11.1.1.6.1"
OID_TONER_MAX = "1.3.6.1.2.1.43.11.1.1.8.1"
OID_TONER_CUR = "1.3.6.1.2.1.43.11.1.1.9.1"
OID_COLORANT = "1.3.6.1.2.1.43.12.1.1.4.1"
OID_TRAY_NAME = "1.3.6.1.2.1.43.8.2.1.13.1"
OID_TRAY_CAP = "1.3.6.1.2.1.43.8.2.1.9.1"
OID_TRAY_LEVEL = "1.3.6.1.2.1.43.8.2.1.10.1"
OID_TRAY_STATUS = "1.3.6.1.2.1.43.8.2.1.11.1"
OID_ALERT = "1.3.6.1.2.1.43.18.1.1"

PRINTER_STATUS = {
    1: "Other",
    2: "Unknown",
    3: "Idle",
    4: "Printing",
    5: "Warmup",
    6: "Stopped",
    7: "Offline",
}
ALERT_SEVERITY = {1: "Other", 2: "Critical", 3: "Warning", 4: "Informational"}
ALERT_CODES = {
    1: "Cover Open",
    3: "Paper Jam",
    4: "Paper Out",
    5: "Offline",
    6: "Service Requested",
    7: "Input Tray Missing",
    8: "Output Full",
    9: "Marker Supply Empty",
    11: "Output Near Full",
    12: "Input Tray Empty",
}
TRAY_STATUS = {1: "Other", 2: "Unknown", 3: "Available", 4: "Printing", 5: "Busy", 6: "Offline"}


def _ber_len(n: int) -> bytes:
    if n < 128:
        return bytes([n])
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def _ber_int(n: int) -> bytes:
    if n == 0:
        raw = b"\x00"
    else:
        length = max(1, (n.bit_length() + 8) // 8)
        raw = n.to_bytes(length, "big", signed=True)
        if n > 0 and raw[0] & 0x80:
            raw = b"\x00" + raw
    return b"\x02" + _ber_len(len(raw)) + raw


def _ber_octets(data: bytes) -> bytes:
    return b"\x04" + _ber_len(len(data)) + data


def _ber_null() -> bytes:
    return b"\x05\x00"


def _ber_seq(tag: int, body: bytes) -> bytes:
    return bytes([tag]) + _ber_len(len(body)) + body


def _ber_oid(oid: str) -> bytes:
    parts = [int(p) for p in oid.strip(".").split(".")]
    if len(parts) < 2:
        raise ValueError(oid)
    out = [40 * parts[0] + parts[1]]
    for n in parts[2:]:
        if n < 0:
            raise ValueError(oid)
        stack = [n & 0x7F]
        n >>= 7
        while n:
            stack.append(0x80 | (n & 0x7F))
            n >>= 7
        out.extend(reversed(stack))
    raw = bytes(out)
    return b"\x06" + _ber_len(len(raw)) + raw


def encode_getnext(community: str, request_id: int, oid: str) -> bytes:
    varbind = _ber_seq(0x30, _ber_oid(oid) + _ber_null())
    varbind_list = _ber_seq(0x30, varbind)
    pdu = _ber_seq(0xA1, _ber_int(request_id) + _ber_int(0) + _ber_int(0) + varbind_list)
    body = _ber_int(0) + _ber_octets(community.encode()) + pdu
    return _ber_seq(0x30, body)


def _read_len(buf: bytes, i: int) -> tuple[int, int]:
    first = buf[i]
    if first < 128:
        return first, i + 1
    n = first & 0x7F
    val = int.from_bytes(buf[i + 1 : i + 1 + n], "big")
    return val, i + 1 + n


def _read_tlv(buf: bytes, i: int) -> tuple[int, bytes, int]:
    tag = buf[i]
    length, j = _read_len(buf, i + 1)
    return tag, buf[j : j + length], j + length


def decode_oid(raw: bytes) -> str:
    if not raw:
        return ""
    first = raw[0]
    parts = [first // 40, first % 40]
    acc = 0
    for b in raw[1:]:
        acc = (acc << 7) | (b & 0x7F)
        if b < 128:
            parts.append(acc)
            acc = 0
    return ".".join(str(p) for p in parts)


def _decode_value(tag: int, raw: bytes) -> Any:
    if tag == 0x02:
        return int.from_bytes(raw, "big", signed=True)
    if tag == 0x04:
        return raw
    if tag == 0x06:
        return decode_oid(raw)
    if tag == 0x43:  # TimeTicks
        return int.from_bytes(raw, "big")
    if tag == 0x41:  # Counter32
        return int.from_bytes(raw, "big")
    if tag == 0x42:  # Gauge32
        return int.from_bytes(raw, "big")
    if tag in (0x05, 0x80):
        return None
    return raw


def decode_getnext(packet: bytes) -> tuple[str, Any] | None:
    try:
        tag, body, _ = _read_tlv(packet, 0)
        if tag != 0x30:
            return None
        i = 0
        _, _, i = _read_tlv(body, i)  # version
        _, _, i = _read_tlv(body, i)  # community
        pdu_tag, pdu, _ = _read_tlv(body, i)
        if pdu_tag != 0xA2:
            return None
        j = 0
        _, _, j = _read_tlv(pdu, j)  # request id
        err_tag, err_raw, j = _read_tlv(pdu, j)
        if _decode_value(err_tag, err_raw):
            return None
        _, _, j = _read_tlv(pdu, j)  # error index
        _, vbl, _ = _read_tlv(pdu, j)
        _, vb, _ = _read_tlv(vbl, 0)
        k = 0
        oid_tag, oid_raw, k = _read_tlv(vb, k)
        val_tag, val_raw, _ = _read_tlv(vb, k)
        if oid_tag != 0x06:
            return None
        return decode_oid(oid_raw), _decode_value(val_tag, val_raw)
    except (IndexError, ValueError):
        return None


def as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace").replace("\x00", "").strip()
    return str(value).strip()


def getnext(host: str, community: str, oid: str, timeout: float = 2.0) -> tuple[str, Any] | None:
    req_id = random.randint(1, 2_000_000_000)
    packet = encode_getnext(community, req_id, oid)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(packet, (host, 161))
        data, _ = sock.recvfrom(4096)
    except OSError:
        return None
    finally:
        sock.close()
    return decode_getnext(data)


def walk(host: str, community: str, prefix: str, limit: int = 40) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    cursor = prefix
    for _ in range(limit):
        nxt = getnext(host, community, cursor)
        if not nxt:
            break
        oid, value = nxt
        if not (oid == prefix or oid.startswith(prefix + ".")):
            break
        if oid == cursor:
            break
        out.append((oid, value))
        cursor = oid
    return out


def _pct(cur: int, mx: int) -> int | None:
    if cur == -3:
        return None
    if cur < 0 or mx <= 0:
        return None
    return max(0, min(100, round((cur / mx) * 100)))


def _supply_color(name: str) -> str:
    n = name.lower()
    if "black" in n or n.endswith(" bk") or "mono" in n:
        return "#1e293b"
    if "cyan" in n:
        return "#0ea5e9"
    if "magenta" in n:
        return "#d946ef"
    if "yellow" in n:
        return "#eab308"
    if "fuser" in n or "drum" in n or "waste" in n or "kit" in n:
        return "#f97316"
    return "#64748b"


def poll(host: str, community: str = "public") -> dict[str, Any]:
    started = time.time()
    descr = getnext(host, community, "1.3.6.1.2.1.1.1")
    if not descr:
        return {"online": False, "status": "Offline", "toners": [], "trays": [], "alerts": [], "checked_at": int(started)}
    status_row = getnext(host, community, "1.3.6.1.2.1.25.3.5.1.1")
    pages_row = getnext(host, community, "1.3.6.1.2.1.43.10.2.1.4.1")
    serial_row = getnext(host, community, "1.3.6.1.2.1.43.5.1.1.17")
    up_row = getnext(host, community, "1.3.6.1.2.1.1.3")
    console_row = getnext(host, community, "1.3.6.1.2.1.43.16.5.1.2.1")
    names = walk(host, community, OID_TONER_NAME)
    maxes = walk(host, community, OID_TONER_MAX)
    curs = walk(host, community, OID_TONER_CUR)
    toners = []
    for i, (_, name_v) in enumerate(names):
        name = as_text(name_v) or f"Supply {i + 1}"
        mx = int(maxes[i][1]) if i < len(maxes) and isinstance(maxes[i][1], int) else 0
        cur = int(curs[i][1]) if i < len(curs) and isinstance(curs[i][1], int) else 0
        pct = _pct(cur, mx)
        toners.append({"name": name, "pct": pct, "color": _supply_color(name)})
    tray_n = walk(host, community, OID_TRAY_NAME)
    tray_c = walk(host, community, OID_TRAY_CAP)
    tray_l = walk(host, community, OID_TRAY_LEVEL)
    tray_s = walk(host, community, OID_TRAY_STATUS)
    trays = []
    for i, (_, name_v) in enumerate(tray_n):
        name = as_text(name_v) or f"Tray {i + 1}"
        cap = int(tray_c[i][1]) if i < len(tray_c) and isinstance(tray_c[i][1], int) else 0
        lvl = int(tray_l[i][1]) if i < len(tray_l) and isinstance(tray_l[i][1], int) else 0
        stat = int(tray_s[i][1]) if i < len(tray_s) and isinstance(tray_s[i][1], int) else 0
        pct = _pct(lvl, cap) if cap > 0 and lvl >= 0 else None
        trays.append(
            {
                "name": name,
                "capacity": cap,
                "level": lvl,
                "pct": pct,
                "status": TRAY_STATUS.get(stat, "Unknown"),
            }
        )
    alerts_raw = walk(host, community, OID_ALERT)
    grouped: dict[str, dict[int, Any]] = {}
    for oid, value in alerts_raw:
        parts = oid.split(".")
        col = int(parts[-2])
        idx = parts[-1]
        grouped.setdefault(idx, {})[col] = value
    alerts = []
    for g in grouped.values():
        severity = ALERT_SEVERITY.get(int(g.get(2) or 0), "Info")
        code = ALERT_CODES.get(int(g.get(4) or 0))
        desc = as_text(g.get(8)) or code
        if desc and desc not in ("Sleep", "Unknown Alert"):
            alerts.append({"severity": severity, "desc": desc})
    uptime_ticks = up_row[1] if up_row and isinstance(up_row[1], int) else 0
    status_n = status_row[1] if status_row and isinstance(status_row[1], int) else 2
    pages = pages_row[1] if pages_row and isinstance(pages_row[1], int) else None
    return {
        "online": True,
        "status": PRINTER_STATUS.get(status_n, "Unknown"),
        "model": as_text(descr[1])[:60],
        "serial": as_text(serial_row[1]) if serial_row else "",
        "pages": pages,
        "uptime_ticks": uptime_ticks,
        "console": as_text(console_row[1]) if console_row else "",
        "toners": toners,
        "trays": trays,
        "alerts": alerts,
        "checked_at": int(time.time()),
    }
