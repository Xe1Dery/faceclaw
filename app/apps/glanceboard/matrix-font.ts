/**
 * The System Card's big clock face: DisplayOTF as a LOGICAL dot matrix.
 *
 * The face is a 6-column x 9-row dot grid (lit dots 5/6 of the pitch, gap
 * 1/6) — tools/assets/extract-displayotf-font.py samples that grid out of a
 * clean 240px rasterization and ships it as one JSON of '#'/'.' rows. The
 * DRAWER then decides the pitch at paint time: every lit grid cell becomes a
 * square dot of `pitch - max(1, round(pitch/6))` pixels, centred in its
 * `pitch` cell, so dots are always square and always separated by a visible
 * whole-pixel gap — at any size, instead of the small rasterizations' uneven
 * 2-4px smudges that read as rectangles mixed with pixels. The card picks
 * the biggest pitch that fits its canvas, so the clock is as large as the
 * slot allows.
 */
import { File, knownFolders } from "@nativescript/core";

import { type GrayImage } from "../../graphics/image";

export type MatrixGrid = {
  /** Dot columns/rows of one digit cell. */
  cols: number;
  rows: number;
  /** Digit and ':' rows: `rows` strings of `cols` '#' (lit) / '.' (dark). */
  glyphs: Record<string, readonly string[]>;
};

// Under app/fonts/ because that is what the NativeScript webpack copy rules
// ship (assets/** and fonts/**); the loader resolves it like the BDF fonts.
const ASSET_DIR = "fonts/displayotf";
export const MATRIX_GRID = "displayotf-grid.json";

let cached: MatrixGrid | null | undefined;

/** Load the dot-matrix grid (cached; null when the asset is broken). */
export function loadMatrixGrid(asset = MATRIX_GRID): MatrixGrid | null {
  if (cached !== undefined) return cached;
  try {
    const path = `${knownFolders.currentApp().path}/${ASSET_DIR}/${asset}`;
    const parsed = JSON.parse(File.fromPath(path).readTextSync());
    if (
      Number.isInteger(parsed?.cols) && parsed.cols > 0 &&
      Number.isInteger(parsed?.rows) && parsed.rows > 0 &&
      parsed.glyphs && typeof parsed.glyphs === "object"
    ) {
      cached = { cols: parsed.cols, rows: parsed.rows, glyphs: parsed.glyphs };
    } else {
      cached = null;
    }
  } catch (error) {
    console.warn(`Matrix grid asset ${asset} failed to load: ${error}`);
    cached = null;
  }
  return cached;
}

/** Width of `text` in pixels at `pitch` (digits are monospaced cell columns). */
export function measureMatrixGrid(grid: MatrixGrid, text: string, pitch: number): number {
  return text.length * grid.cols * pitch;
}

/** The gap between the hours and minutes lines for a block of dot `pitch`. */
export function matrixLineGap(grid: MatrixGrid, pitch: number, fraction: number): number {
  return Math.max(2, Math.round(grid.rows * pitch * fraction));
}

/** Height of the two stacked digit lines at `pitch` (digits + line gap). */
export function matrixBlockHeight(grid: MatrixGrid, pitch: number, fraction: number): number {
  return grid.rows * pitch * 2 + matrixLineGap(grid, pitch, fraction);
}

/**
 * The biggest dot pitch whose two-line block fits `roomRows` x `roomCols`.
 * 0 when even pitch 1 doesn't fit (caller falls back to plain text).
 */
export function fitMatrixPitch(grid: MatrixGrid, roomRows: number, roomCols: number, fraction: number): number {
  for (let pitch = Math.floor(roomRows / (grid.rows * 2)); pitch >= 1; pitch--) {
    if (matrixBlockHeight(grid, pitch, fraction) <= roomRows && grid.cols * pitch * 2 <= roomCols) return pitch;
  }
  return 0;
}

/**
 * Draw `text` top-left at (x, y) with dot `pitch`: each lit grid cell is a
 * square dot of pitch - max(1, round(pitch/6)) px, centred in its pitch px
 * cell, so every dot is uniform and every gap is visible. Characters with no
 * glyph are skipped (the advance still counts).
 */
export function drawMatrixGrid(
  image: GrayImage,
  grid: MatrixGrid,
  x: number,
  y: number,
  text: string,
  value: number,
  pitch: number,
): void {
  const dot = Math.max(1, pitch - Math.max(1, Math.round(pitch / 6)));
  const inset = (pitch - dot) >> 1;
  for (let index = 0; index < text.length; index++) {
    const rows = grid.glyphs[text[index]!];
    if (!rows) continue;
    const glyphX = x + index * grid.cols * pitch;
    for (let row = 0; row < grid.rows; row++) {
      const line = rows[row]!;
      for (let col = 0; col < grid.cols; col++) {
        if (line[col] === "#") image.fillRect(glyphX + col * pitch + inset, y + row * pitch + inset, dot, dot, value);
      }
    }
  }
}
