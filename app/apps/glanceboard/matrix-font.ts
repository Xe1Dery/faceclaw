/**
 * The System Card's big clock face: DisplayOTF, a dot-matrix display font,
 * pre-rasterized to 1bpp '#'/'.' grids (see tools/assets/extract-displayotf-
 * font.py). Drawing is a plain fillRect walk — no TTF rasterizer on-device —
 * so the digits are pixel-identical to tools/system-card-preview.cjs.
 *
 * Three rasters ship, at the pixel sizes where the face snaps to a clean dot
 * grid: 48px (cell 27x34, ~3px dots), 96px (cell 53x67, ~6px dots), and
 * 240px (cell 133x168, ~10px dots) — the last drawn 1:1 on the full-lens
 * card, exactly the size the approved design was mocked at. The card picks
 * the biggest that fits.
 */
import { File, knownFolders } from "@nativescript/core";

import { type GrayImage } from "../../graphics/image";

export type MatrixFont = {
  /** Width/height of one digit cell; every glyph fills the cell's box. */
  cellW: number;
  cellH: number;
  /** Digit and ':' rows: cellH strings of cellW '#' (lit) / '.' (dark). */
  glyphs: Record<string, readonly string[]>;
};

// Under app/fonts/ because that is what the NativeScript webpack copy rules
// ship (assets/** and fonts/**); the loader resolves it like the BDF fonts.
const ASSET_DIR = "fonts/displayotf";
export const MATRIX_FONT_48 = "displayotf-48.json";
export const MATRIX_FONT_96 = "displayotf-96.json";
export const MATRIX_FONT_240 = "displayotf-240.json";

const cache = new Map<string, MatrixFont | null>();

/** Load one raster by asset file name (cached; null when the asset is broken). */
export function loadMatrixFont(asset: string): MatrixFont | null {
  if (cache.has(asset)) return cache.get(asset) ?? null;
  let font: MatrixFont | null = null;
  try {
    const path = `${knownFolders.currentApp().path}/${ASSET_DIR}/${asset}`;
    const parsed = JSON.parse(File.fromPath(path).readTextSync());
    if (
      Number.isInteger(parsed?.cellW) && parsed.cellW > 0 &&
      Number.isInteger(parsed?.cellH) && parsed.cellH > 0 &&
      parsed.glyphs && typeof parsed.glyphs === "object"
    ) {
      font = { cellW: parsed.cellW, cellH: parsed.cellH, glyphs: parsed.glyphs };
    }
  } catch (error) {
    console.warn(`Matrix font asset ${asset} failed to load: ${error}`);
  }
  cache.set(asset, font);
  return font;
}

/** Width of `text` in pixels at `scale` (digits are monospaced cells). */
export function measureMatrixText(font: MatrixFont, text: string, scale = 1): number {
  return text.length * font.cellW * scale;
}

/**
 * Draw `text` top-left at (x, y) at an integer `scale`: each lit matrix
 * pixel becomes a scale×scale block of `value`, so the dots and their gaps
 * keep the raster's proportions at any size. Characters with no glyph are
 * skipped (advance still counts).
 */
export function drawMatrixText(
  image: GrayImage,
  font: MatrixFont,
  x: number,
  y: number,
  text: string,
  value: number,
  scale = 1,
): void {
  for (let index = 0; index < text.length; index++) {
    const rows = font.glyphs[text[index]!];
    if (!rows) continue;
    const glyphX = x + index * font.cellW * scale;
    for (let row = 0; row < font.cellH; row++) {
      const line = rows[row]!;
      for (let col = 0; col < font.cellW; col++) {
        if (line[col] === "#") image.fillRect(glyphX + col * scale, y + row * scale, scale, scale, value);
      }
    }
  }
}
