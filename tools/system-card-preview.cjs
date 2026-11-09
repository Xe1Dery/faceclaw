#!/usr/bin/env node
/**
 * Render proposed System Card layouts to PNGs, under plain node, no device.
 *
 * Same idea as tools/health-preview.cjs, same honesty rules:
 * - the pixel buffer is the REAL GrayImage from app/graphics/image.ts,
 * - the glyphs are the REAL Terminus .bdf files the app bundles (via the one
 *   @nativescript/core shim below),
 * - the battery block is drawn by the REAL app/graphics/battery.ts, so the
 *   "don't touch the battery" area is pixel-faithful,
 * - the clock text is the shipping 24-hour "H:MM" spelling, inlined: the real
 *   formatClockTime lives in ui/clock-format.ts, which imports the settings
 *   store (JNI) — the one piece too native-heavy to shim, and trivial enough
 *   to mirror exactly for the 24h format this preview assumes.
 *
 * Caveats to read before trusting a preview as gospel:
 * - The big clock uses DisplayOTF (tools/assets/DisplayOTF.otf) directly: the
 *   face itself is a dot matrix (square dots with visible gaps), so
 *   tools/assets/extract-metanart-font.py rasterizes it once at 240px to a
 *   1bpp cell and the preview draws that cell 1:1 — exactly what the font
 *   ships, no invented grid.
 *   Small text (date, status, counter) still renders with the REAL Terminus
 *   .bdf files the app bundles, via the one @nativescript/core shim below.
 * - Everything outside the battery block is a PROTOTYPE layout, not the
 *   shipping widget: this tool exists to iterate on the design before the
 *   widget code changes.
 *
 * ## Use
 *
 *     npx tsc -p tests/tsconfig.json
 *     node tools/system-card-preview.cjs [--out DIR]
 *
 * Writes one green-tinted lens PNG per state plus preview.html (screens only).
 */

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "app");
const BUILD = path.join(ROOT, ".test-build", "app");

// --- the one platform shim (fonts/ reads go through knownFolders) ----------
const nsCoreStub = {
  knownFolders: {
    currentApp: () => ({
      getFile: (relative) => ({
        readTextSync: () => fs.readFileSync(path.join(APP, relative), "utf8"),
      }),
    }),
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@nativescript/core") return nsCoreStub;
  return realLoad.apply(this, arguments);
};

if (!fs.existsSync(BUILD)) {
  console.error(`No ${path.relative(ROOT, BUILD)} - run: npx tsc -p tests/tsconfig.json`);
  process.exit(1);
}

const { GrayImage, G2_LENS_WIDTH, G2_LENS_HEIGHT } = require(path.join(BUILD, "graphics/image.js"));
const { getTerminusFont } = require(path.join(BUILD, "graphics/bdffont.js"));
const battery = require(path.join(BUILD, "graphics/battery.js"));
const UPNG = require("upng-js");

// The Metanart matrix font, extracted by tools/assets/extract-metanart-font.py.
const MATRIX_FONT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tools", "assets", "metanart-font.json"), "utf8"),
);

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = path.resolve(outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : path.join(ROOT, "preview", "system-card"));
fs.mkdirSync(OUT, { recursive: true });

const W = G2_LENS_WIDTH;
const H = G2_LENS_HEIGHT;
const PAD = 8; // matches the shipping card's PAD

const large = getTerminusFont(32, false);
const medium = getTerminusFont(24, false);
const small = getTerminusFont(16, false);

// --- shared bits -------------------------------------------------------------

/** RU date like "09.11.26": zero-padded day.month.yy. */
function ruDate(now) {
  const d = String(now.getDate()).padStart(2, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const y = String(now.getFullYear() % 100).padStart(2, "0");
  return `${d}.${m}.${y}`;
}

/** Mirrors ui/clock-format.ts formatClockTime() for the 24-hour setting. */
function formatClockTime(now) {
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** The battery block exactly as the shipping card draws it (dense style). */
function drawBatteryBlock(image, right, top) {
  const items = [
    { device: "phone", percent: 78, charging: false },
    { device: "watch", percent: 45, charging: true },
    { device: "glasses", percent: 91, charging: false },
  ];
  const width = battery.denseBatteriesWidth(items);
  battery.drawDenseBatteries(image, items, right, top);
  return width;
}

/**
 * Hand-drawn bells, same ascii-art idiom as battery.ts icons. The card draws
 * BELL_VARIANT; the sheet PNG shows every variant so one can be picked.
 */
const BELL_VARIANTS = {
  // Filled dome, flat rim, clapper bar.
  solid: [
    "....##....",
    "...####...",
    "..######..",
    "..######..",
    ".########.",
    "##########",
    "##########",
    "##########",
    "##########",
    "##########",
    "..........",
    "...####...",
  ],
  // Stroked outline bell (Lucide-like), open at the bottom.
  outline: [
    "....##....",
    "...#..#...",
    "..#....#..",
    "..#....#..",
    ".#......#.",
    "#........#",
    "#........#",
    "#........#",
    "#........#",
    "##########",
    "..........",
    "...#..#...",
  ],
  // Taller, narrower dome — reads well at arm's length.
  tall: [
    "....##....",
    "...####...",
    "..######..",
    "..######..",
    "..######..",
    "..######..",
    ".########.",
    ".########.",
    "##########",
    "##########",
    "..........",
    "....##....",
  ],
  // Tall dome, stroked outline — the outline style in the tall silhouette.
  "tall-outline": [
    "....##....",
    "...#..#...",
    "..#....#..",
    "..#....#..",
    "..#....#..",
    "..#....#..",
    ".#......#.",
    ".#......#.",
    "#........#",
    "##########",
    "..........",
    "....##....",
  ],
  // Minimal: no handle, straight flare, short.
  minimal: [
    "...####...",
    "..######..",
    ".########.",
    "##########",
    "##########",
    "##########",
    "##########",
    "##########",
    "..........",
    "...####...",
  ],
  // Filled dome with a round clapper dot under the rim.
  clapper: [
    "....##....",
    "..######..",
    ".########.",
    ".########.",
    "##########",
    "##########",
    "##########",
    "##########",
    "##########",
    "##########",
    "..........",
    "....##....",
  ],
};
const BELL_VARIANT = "tall-outline"; // the card draws this one until another is picked

function drawBell(image, x, top, value, rows = BELL_VARIANTS[BELL_VARIANT]) {
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < rows[row].length; col++) {
      if (rows[row][col] === "#") image.fillRect(x + col, top + row, 1, 1, value);
    }
  }
  return rows[0].length;
}

/** Bell + count, right-aligned into the bottom-right corner. */
function drawNotificationCounter(image, count, bottom) {
  const text = count > 99 ? "99+" : String(count);
  const textW = small.measureText(text);
  const bellW = 10;
  const gap = 6;
  const totalW = bellW + gap + textW;
  const x = W - PAD - totalW;
  // Vertically centered on the counter text's line, not bottom-aligned: the
  // bell is shorter than the line, and hanging it at the baseline reads low.
  const bellH = BELL_VARIANTS[BELL_VARIANT].length;
  const bellTop = bottom - small.lineHeight + Math.round((small.lineHeight - bellH) / 2);
  drawBell(image, x, bellTop, count > 0 ? 230 : 90);
  image.drawText(small, x + bellW + gap, bottom - small.lineHeight, text, count > 0 ? 230 : 90);
}

/**
 * OpenClaw link state, left-aligned into the bottom-left corner. The square
 * is always sharp-cornered: filled = connected, hollow = disconnected,
 * hollow + center dot = reconnecting.
 */
function drawConnection(image, state, bottom) {
  const label = { ok: "OpenClaw: ок", reconnecting: "OpenClaw: …", down: "OpenClaw: ОБРЫВ" }[state];
  const value = { ok: 170, reconnecting: 170, down: 255 }[state];
  const dotR = 4;
  const cy = bottom - small.lineHeight / 2 - 1;
  if (state === "ok") {
    image.fillRect(PAD, cy - dotR, dotR * 2, dotR * 2, value);
  } else {
    image.drawRect(PAD, cy - dotR, dotR * 2, dotR * 2, value);
    if (state === "reconnecting") image.fillRect(PAD + dotR - 1, cy - 1, 2, 2, value);
  }
  image.drawText(small, PAD + dotR * 2 + 6, bottom - small.lineHeight, label, value);
}

/** Date top-left, battery top-right — the shared top row of every variant. */
function drawTopRow(image, now) {
  image.drawText(medium, PAD, PAD, ruDate(now), 170);
  drawBatteryBlock(image, W - PAD, PAD + 7);
}

// --- the clock: big dot-matrix digits, hours stacked over minutes ------------

// The extracted cell is the font rasterized 1:1 (dots and gaps are the font's
// own), so drawing is a plain 1:1 blit. PITCH/DOT stay as knobs in case a
// coarser grid than the font's own is ever wanted.
const MATRIX_PITCH = 1;
const MATRIX_DOT = 1;

/**
 * Draw `text` with the dot-matrix font, centered horizontally at `centerY`.
 */
function drawMatrixDigits(image, text, centerY, value) {
  const cellW = MATRIX_FONT.cellW;
  const cellH = MATRIX_FONT.cellH;
  const x0 = Math.round((W - text.length * cellW * MATRIX_PITCH) / 2);
  const y0 = Math.round(centerY - (cellH * MATRIX_PITCH) / 2);
  for (let i = 0; i < text.length; i++) {
    const rows = MATRIX_FONT.glyphs[text[i]];
    if (!rows) continue;
    const gx = x0 + i * cellW * MATRIX_PITCH;
    for (let y = 0; y < cellH; y++) {
      const row = rows[y];
      for (let x = 0; x < cellW; x++) {
        if (row[x] === "#")
          image.fillRect(gx + x * MATRIX_PITCH, y0 + y * MATRIX_PITCH, MATRIX_DOT, MATRIX_DOT, value);
      }
    }
  }
}

// --- the card -----------------------------------------------------------------

/**
 * One card: date top-left, untouched battery top-right, HH over MM big in the
 * middle, OpenClaw link bottom-left, notification bell bottom-right.
 */
function drawCard(now, opts) {
  const image = new GrayImage(W, H, 0);
  drawTopRow(image, now);
  const time = formatClockTime(now);
  const [hh, mm] = time.split(":");
  const digitH = MATRIX_FONT.cellH * MATRIX_PITCH;
  const lineGap = Math.round(digitH * 0.12);
  const hourCenter = Math.round(H / 2 - digitH / 2 - lineGap / 2);
  const minuteCenter = Math.round(H / 2 + digitH / 2 + lineGap / 2);
  drawMatrixDigits(image, hh.padStart(2, "0"), hourCenter, 235);
  drawMatrixDigits(image, mm.padStart(2, "0"), minuteCenter, 235);
  drawConnection(image, opts.connection, H - PAD);
  drawNotificationCounter(image, opts.notifications, H - PAD);
  return image;
}

// --- PNG + HTML out -----------------------------------------------------------

/**
 * The G2's microLED panel is green monochrome; this approximates the worn
 * look by pushing luminance toward phosphor green.
 */
function greenTint(rgba) {
  // Even-style worn look: keep luminance, push toward phosphor green.
  for (let i = 0; i < rgba.length; i += 4) {
    const v = rgba[i];
    rgba[i] = Math.round(v * 0.35);
    rgba[i + 1] = Math.round(v * 0.95);
    rgba[i + 2] = Math.round(v * 0.45);
  }
}

function writePng(name, image) {
  const baked = image.withDrawsBaked();
  const rgba = new Uint8Array(baked.width * baked.height * 4);
  for (let i = 0; i < baked.pixels.length; i += 1) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = baked.pixels[i];
    rgba[i * 4 + 3] = 255;
  }
  greenTint(rgba);
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(UPNG.encode([rgba.buffer], baked.width, baked.height, 0)));
  let lit = 0;
  for (const value of baked.pixels) if (value > 0) lit += 1;
  if (lit === 0) console.error(`  !! ${file} is entirely blank`);
  return `${name}.png`;
}

const now = new Date();
const variants = [
  { name: "connected", opts: { connection: "ok", notifications: 3 } },
  { name: "disconnected", opts: { connection: "down", notifications: 0 } },
  { name: "reconnecting", opts: { connection: "reconnecting", notifications: 12 } },
];

const written = [];
for (const spec of variants) {
  const image = drawCard(now, spec.opts);
  const png = writePng(spec.name, image);
  written.push({ ...spec, png });
}

/**
 * Bell comparison sheet: every BELL_VARIANTS glyph at 4x (chunky pixels are
 * how they read on the lens) with its name and a live 3-count counter, so a
 * variant can be picked from the sheet and set in BELL_VARIANT.
 */
function drawBellSheet() {
  const names = Object.keys(BELL_VARIANTS);
  const scale = 4;
  const cellH = 12 * scale + 40;
  const image = new GrayImage(W, cellH * names.length, 0);
  names.forEach((name, i) => {
    const top = i * cellH;
    const rows = BELL_VARIANTS[name];
    for (let y = 0; y < rows.length; y++)
      for (let x = 0; x < rows[y].length; x++)
        if (rows[y][x] === "#") image.fillRect(PAD + x * scale, top + y * scale, scale, scale, 230);
    image.drawText(small, PAD + 10 * scale + 16, top + 6, `${name}  (сейчас в карте: ${BELL_VARIANT})`, 170);
    image.drawText(small, PAD + 10 * scale + 16, top + 6 + small.lineHeight + 4, "3", 230);
    image.drawLine(PAD, top + cellH - 8, W - PAD, top + cellH - 8, 60);
  });
  return image;
}
const bellsPng = writePng("bells", drawBellSheet());

const html = `<!doctype html>
<meta charset="utf-8">
<title>System Card — redesign preview</title>
<style>
 body{background:#111;color:#ddd;font:14px system-ui,sans-serif;margin:24px}
 h1{font-size:18px} h2{font-size:15px;color:#9c9;margin-top:34px}
 .note{color:#888;max-width:760px}
 .lens{width:640px;height:480px;background:#000;border:1px solid #333;margin:10px 0}
</style>
<h1>System Card — редизайн (640×480, отрисовано настоящим прикладным кодом)</h1>
<p class="note">Время — DisplayOTF 1:1 (шрифт сам состоит из квадратов с зазорами), растеризация 240px → 1bpp, часы над минутами.
Батарея справа сверху — настоящая отрисовка из graphics/battery.ts, без изменений.
Индикатор линка: залитый квадрат = подключен, пустой (только рамка) = обрыв, рамка с точкой = переподключение.</p>
${written
  .map(
    (w) => `<h2>${w.name}</h2>
<div class="lens"><img src="${w.png}" width="640" height="480"></div>`,
  )
  .join("\n")}
<h2>Варианты колокольчика (4×, с подписями)</h2>
<img src="${bellsPng}" width="640">
`;
fs.writeFileSync(path.join(OUT, "preview.html"), html);
console.log(`wrote ${written.length + 1} PNGs + preview.html to ${OUT}`);
