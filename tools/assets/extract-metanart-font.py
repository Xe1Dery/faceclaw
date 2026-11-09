#!/usr/bin/env python3
"""Rasterize tools/assets/metanart-big.ttf into a 1bpp matrix font (JSON).

The stock G2 clock look we want is: a chunky digital face rasterized so each
source pixel is a square block on the lens. This script renders Metanart_Big
at a size where each digit fills a 48x48 cell (verified: the face snaps to
that grid at 64px), thresholds to 1bpp, and writes every digit + ':' as
'#'/'.' rows. tools/system-card-preview.cjs then draws each source pixel as a
2x2 block (=> 96px digits), hours stacked over minutes.

Regenerate after editing the TTF:  python3 tools/assets/extract-metanart-font.py
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
TTF = os.path.join(HERE, "metanart-big.ttf")
OUT = os.path.join(HERE, "metanart-font.json")

SIZE = 64  # the size at which the face rasterizes to the 48px cell grid
DIGITS = "0123456789:"

font = ImageFont.truetype(TTF, SIZE)
boxes = {ch: font.getbbox(ch) for ch in DIGITS}
cell_w = max(b[2] - b[0] for b in boxes.values())
cell_h = max(b[3] - b[1] for b in boxes.values())

glyphs = {}
for ch in DIGITS:
    b = boxes[ch]
    img = Image.new("L", (cell_w + 8, cell_h + 8), 0)
    ImageDraw.Draw(img).text((4 - b[0], 4 - b[1]), ch, font=font, fill=255)
    px = img.load()
    glyphs[ch] = [
        "".join("#" if px[x, y] > 127 else "." for x in range(4, 4 + cell_w))
        for y in range(4, 4 + cell_h)
    ]

with open(OUT, "w") as out:
    json.dump({"cellW": cell_w, "cellH": cell_h, "glyphs": glyphs}, out)
print(f"wrote {OUT}: cell {cell_w}x{cell_h}, {len(glyphs)} glyphs")
