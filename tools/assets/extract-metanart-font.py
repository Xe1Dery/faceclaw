#!/usr/bin/env python3
"""Rasterize the display TTF into a 1bpp matrix font (JSON).

The stock G2 clock look we want is: a chunky digital face rasterized so each
source pixel is a square block on the lens. This script renders the display
face (DisplayOTF.otf) at a size where a digit fills a ~53x67 cell, thresholds
to 1bpp (the face is anti-aliased, so a hard cut at 127 is used), centers
every glyph in a common cell, and writes digits + ':' as '#'/'.' rows.
tools/system-card-preview.cjs then draws each source pixel as a 2x2 block —
the stock-G2 chunky-digit look, hours stacked over minutes.

Regenerate after swapping the TTF:  python3 tools/assets/extract-metanart-font.py
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
TTF = os.path.join(HERE, "DisplayOTF.otf")
OUT = os.path.join(HERE, "metanart-font.json")


DIGITS = "0123456789:"
SIZE = 240  # the face IS a dot matrix at this size: dots rasterize ~10x10
            # with visible gaps; the preview draws it 1:1 (pitch = dot + 1)
font = ImageFont.truetype(TTF, SIZE)
boxes = {ch: font.getbbox(ch) for ch in DIGITS}
cell_w = max(b[2] - b[0] for b in boxes.values())
cell_h = max(b[3] - b[1] for b in boxes.values())

glyphs = {}
for ch in DIGITS:
    b = boxes[ch]
    img = Image.new("L", (cell_w + 8, cell_h + 8), 0)
    # center each glyph horizontally in the common cell so digits align
    dx = (cell_w - (b[2] - b[0])) // 2
    ImageDraw.Draw(img).text((4 + dx - b[0], 4 - b[1]), ch, font=font, fill=255)
    px = img.load()
    glyphs[ch] = [
        "".join("#" if px[x, y] > 127 else "." for x in range(4, 4 + cell_w))
        for y in range(4, 4 + cell_h)
    ]

with open(OUT, "w") as out:
    json.dump({"cellW": cell_w, "cellH": cell_h, "glyphs": glyphs}, out)
print(f"wrote {OUT}: cell {cell_w}x{cell_h}, {len(glyphs)} glyphs")
