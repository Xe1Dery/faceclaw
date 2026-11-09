#!/usr/bin/env python3
"""Rasterize DisplayOTF.otf into 1bpp matrix-font JSONs for the System Card.

DisplayOTF is a dot-matrix display face: at the right sizes it rasterizes to
square dots with visible gaps, no anti-aliasing between them — the stock-G2
chunky-clock look. This script renders it at pixel sizes where the face snaps
to a clean dot grid, thresholds to 1bpp, centers every glyph in a common
cell, and writes digits + ':' as '#'/'.' rows:

  displayotf-48.json   cell ~27x34   dots ~3px, gap 1  (small glance slots)
  displayotf-96.json   cell ~53x67   dots ~6px, gap 1  (tall slots)
  displayotf-240.json  cell ~133x168 dots ~10px, gap 2 (full-lens card, 1:1)

The System Card picks the biggest that fits its canvas; app/apps/glanceboard/
matrix-font.ts draws it. tools/system-card-preview.cjs renders the same
design off-device from the same JSONs.

Regenerate after editing the OTF:  python3 tools/assets/extract-displayotf-font.py
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
TTF = os.path.join(HERE, "DisplayOTF.otf")
OUT_DIR = os.path.join(HERE, "..", "..", "app", "fonts", "displayotf")

SIZES = {48: "displayotf-48.json", 96: "displayotf-96.json", 240: "displayotf-240.json"}
DIGITS = "0123456789:"

for size, out_name in SIZES.items():
    font = ImageFont.truetype(TTF, size)
    boxes = {ch: font.getbbox(ch) for ch in DIGITS}
    cell_w = max(b[2] - b[0] for b in boxes.values())
    cell_h = max(b[3] - b[1] for b in boxes.values())
    glyphs = {}
    for ch in DIGITS:
        b = boxes[ch]
        img = Image.new("L", (cell_w + 8, cell_h + 8), 0)
        dx = (cell_w - (b[2] - b[0])) // 2
        ImageDraw.Draw(img).text((4 + dx - b[0], 4 - b[1]), ch, font=font, fill=255)
        px = img.load()
        glyphs[ch] = [
            "".join("#" if px[x, y] > 127 else "." for x in range(4, 4 + cell_w))
            for y in range(4, 4 + cell_h)
        ]
    out = os.path.join(OUT_DIR, out_name)
    with open(out, "w") as handle:
        json.dump({"cellW": cell_w, "cellH": cell_h, "glyphs": glyphs}, handle)
    print(f"wrote {out}: size {size}, cell {cell_w}x{cell_h}")
