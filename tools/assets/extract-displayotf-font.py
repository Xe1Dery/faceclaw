#!/usr/bin/env python3
"""Extract DisplayOTF.otf's LOGICAL dot matrix for the System Card clock.

DisplayOTF is a dot-matrix display face: a 6-column x 9-row dot grid whose
lit dots are 5/6 of the pitch with a 1/6 gap. At a large enough pixel size
(240px: pitch 19, dots 16x16, gap 3) it rasterizes to a perfectly regular
grid; at small sizes the rasterizer merges and splits dots unevenly, which
is exactly the "rectangles mixed with pixels" look the small rasters used to
ship. So instead of shipping rasters, this script samples the grid ONCE from
a clean 240px rasterization and writes the logical matrix:

  displayotf-grid.json   {cols: 6, rows: 9, glyphs: {ch: 9 rows of 6 '#'}}

app/apps/glanceboard/matrix-font.ts then draws every lit cell as a square
dot of pitch - max(1, round(pitch/6)) px at paint time, so dots are uniform
squares with a visible gap at any size the card fits. tools/system-card-
preview.cjs renders the same design off-device from the same JSON.

Regenerate after editing the OTF:  python3 tools/assets/extract-displayotf-font.py
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
TTF = os.path.join(HERE, "DisplayOTF.otf")
OUT_DIR = os.path.join(HERE, "..", "..", "app", "fonts", "displayotf")

SAMPLE_SIZE = 240  # the size where the face snaps to a clean 19px dot grid
COLS, ROWS = 6, 9
# The stacked clock only ever draws digits; ':' is not in the grid's contract.
DIGITS = "0123456789"

font = ImageFont.truetype(TTF, SAMPLE_SIZE)
boxes = {ch: font.getbbox(ch) for ch in DIGITS}
cell_w = max(b[2] - b[0] for b in boxes.values())
cell_h = max(b[3] - b[1] for b in boxes.values())


def render(ch):
    """One glyph thresholded to 1bpp, in a (cell_w, cell_h) box."""
    b = boxes[ch]
    img = Image.new("L", (cell_w + 8, cell_h + 8), 0)
    # The bbox's ink is centred in the cell box (the widest digit's box is
    # the cell), so narrower glyphs like '1' land on the grid's middle
    # columns rather than hugging its left edge.
    dx = ((cell_w - (b[2] - b[0])) // 2) - b[0]
    ImageDraw.Draw(img).text((4 + dx, 4 - b[1]), ch, font=font, fill=255)
    px = img.load()
    return [[px[4 + x, 4 + y] > 127 for x in range(cell_w)] for y in range(cell_h)]


def groups(flags):
    """Runs of True as (start, end) pairs."""
    flags = list(flags)
    out, start = [], -1
    for i, on in enumerate(flags):
        if on and start < 0:
            start = i
        if not on and start >= 0:
            out.append((start, i - 1))
            start = -1
    if start >= 0:
        out.append((start, len(flags) - 1))
    return out


# The grid's dot centres, detected from the union of every digit's lit
# column and row groups at this size (the face's own grid, not an assumed
# one): '8' lights every column and row, so the union is the full grid.
bitmaps = {ch: render(ch) for ch in DIGITS}
col_groups = groups(
    any(bitmap[y][x] for bitmap in bitmaps.values() for y in range(cell_h)) for x in range(cell_w)
)
row_groups = groups(
    any(bitmap[y][x] for bitmap in bitmaps.values() for x in range(cell_w)) for y in range(cell_h)
)
assert len(col_groups) == COLS, f"expected {COLS} dot columns, got {col_groups}"
assert len(row_groups) == ROWS, f"expected {ROWS} dot rows, got {row_groups}"
col_centres = [(a + b) // 2 for a, b in col_groups]
row_centres = [(a + b) // 2 for a, b in row_groups]

glyphs = {}
for ch in DIGITS:
    bitmap = bitmaps[ch]
    glyphs[ch] = [
        "".join("#" if bitmap[y][x] else "." for x in col_centres) for y in row_centres
    ]

os.makedirs(OUT_DIR, exist_ok=True)
out = os.path.join(OUT_DIR, "displayotf-grid.json")
with open(out, "w") as handle:
    json.dump({"cols": COLS, "rows": ROWS, "glyphs": glyphs}, handle)
print(f"wrote {out}: grid {COLS}x{ROWS} sampled at {SAMPLE_SIZE}px (cell {cell_w}x{cell_h}, "
      f"col centres {col_centres}, row centres {row_centres})")
for ch in DIGITS:
    print(ch, glyphs[ch])
