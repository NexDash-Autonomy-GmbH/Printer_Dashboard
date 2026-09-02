#!/usr/bin/env python3
"""Rewrite index.html's favicon link from public/printer.svg.

The icon is inlined rather than linked because Cloudflare Access intercepts the
separate favicon request and answers 302 text/html, which browsers cache as a
failure and replace with the default globe. Run this after editing the SVG.
"""
import base64
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
svg = (root / "public" / "printer.svg").read_text(encoding="utf-8")
compact = re.sub(r">\s+<", "><", svg).strip()
uri = "data:image/svg+xml;base64," + base64.b64encode(compact.encode()).decode()

html_path = root / "index.html"
html = html_path.read_text(encoding="utf-8")
updated, n = re.subn(
    r'(<link rel="icon" type="image/svg\+xml" href=")[^"]*(" />)',
    lambda m: m.group(1) + uri + m.group(2),
    html,
)
if n != 1:
    raise SystemExit(f"expected one icon link, found {n}")
html_path.write_text(updated, encoding="utf-8")
print(f"favicon inlined ({len(uri)} chars)")
