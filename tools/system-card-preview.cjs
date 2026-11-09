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
 * - The device's default UI font is a TTF rasterized in Java; off Android the
 *   shipping code falls back to Terminus, which is what renders here. Layouts
 *   must therefore survive the bitmap-font metrics, not just the TTF default.
 * - The firmware (EvenHub) font the stock G2 clock uses cannot be extracted
 *   off-device, so the "stock clock style" time is approximated with the
 *   largest bundled Terminus face. The preview shows placement and hierarchy,
 *   not the stock glyph shapes.
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

/** Hand-drawn bell, same ascii-art idiom as battery.ts icons. */
const BELL_ROWS = [
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
];
function drawBell(image, x, top, value) {
  for (let row = 0; row < BELL_ROWS.length; row++) {
    for (let col = 0; col < BELL_ROWS[row].length; col++) {
      if (BELL_ROWS[row][col] === "#") image.fillRect(x + col, top + row, 1, 1, value);
    }
  }
  return BELL_ROWS[0].length;
}

/** Bell + count, right-aligned into the bottom-right corner. */
function drawNotificationCounter(image, count, bottom) {
  const text = count > 99 ? "99+" : String(count);
  const textW = small.measureText(text);
  const bellW = 10;
  const gap = 6;
  const totalW = bellW + gap + textW;
  const x = W - PAD - totalW;
  const bellTop = bottom - BELL_ROWS.length;
  drawBell(image, x, bellTop, count > 0 ? 230 : 90);
  image.drawText(small, x + bellW + gap, bottom - small.lineHeight, text, count > 0 ? 230 : 90);
}

/** OpenClaw link state, left-aligned into the bottom-left corner. */
function drawConnection(image, state, bottom) {
  const label = { ok: "OpenClaw: ок", reconnecting: "OpenClaw: …", down: "OpenClaw: ОБРЫВ" }[state];
  const value = { ok: 170, reconnecting: 170, down: 255 }[state];
  const dotR = 4;
  const cy = bottom - small.lineHeight / 2 - 1;
  // status dot (filled square — the panel is a pixel grid anyway)
  image.fillRect(PAD, cy - dotR, dotR * 2, dotR * 2, value);
  if (state === "down") {
    // carve an X into the dot so colour alone is not the only signal
    for (let i = 0; i < dotR * 2; i++) {
      image.fillRect(PAD + i, cy - dotR + i, 1, 1, 0);
      image.fillRect(PAD + i, cy + dotR - i - 1, 1, 1, 0);
    }
  }
  image.drawText(small, PAD + dotR * 2 + 6, bottom - small.lineHeight, label, value);
}

/** Date top-left, battery top-right — the shared top row of every variant. */
function drawTopRow(image, now) {
  image.drawText(medium, PAD, PAD, ruDate(now), 170);
  drawBatteryBlock(image, W - PAD, PAD + 7);
}

// --- the clock: stock-style big pixel digits, hours stacked over minutes ----

/**
 * Draw `text` with the Terminus 32 glyphs nearest-neighbour scaled by
 * `scale` (chunky pixels, like the stock G2 clock), centered horizontally at
 * `centerY`. Terminus is 1bpp, so scaling stays crisp at any integer factor.
 */
function drawBigDigits(image, text, scale, centerY, value) {
  const glyph = new GrayImage(large.measureText(text), large.lineHeight, 0);
  glyph.drawText(large, 0, 0, text, value);
  const baked = glyph.withDrawsBaked();
  const x0 = Math.round((W - baked.width * scale) / 2);
  const y0 = Math.round(centerY - (baked.height * scale) / 2);
  for (let y = 0; y < baked.height; y++)
    for (let x = 0; x < baked.width; x++) {
      const v = baked.pixels[y * baked.width + x];
      if (v) image.fillRect(x0 + x * scale, y0 + y * scale, scale, scale, v);
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
  const scale = opts.scale ?? 3;
  const lineGap = Math.round(large.lineHeight * scale * 0.18);
  const blockH = large.lineHeight * scale * 2 + lineGap;
  const hourCenter = Math.round(H / 2 - blockH / 4);
  const minuteCenter = Math.round(H / 2 + blockH / 4);
  drawBigDigits(image, hh.padStart(2, "0"), scale, hourCenter, 235);
  drawBigDigits(image, mm.padStart(2, "0"), scale, minuteCenter, 235);
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
  { name: "connected", opts: { connection: "ok", notifications: 3, scale: 3 } },
  { name: "disconnected", opts: { connection: "down", notifications: 0, scale: 3 } },
  { name: "reconnecting", opts: { connection: "reconnecting", notifications: 12, scale: 3 } },
];

const written = [];
for (const spec of variants) {
  const image = drawCard(now, spec.opts);
  const png = writePng(spec.name, image);
  written.push({ ...spec, png });
}

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
<p class="note">Время — Terminus 32, увеличенный втрое побитово (1bpp-глифы, масштаб без размытия): крупные пиксельные цифры, часы над минутами, как в стоковых часах G2.
Батарея справа сверху — настоящая отрисовка из graphics/battery.ts, без изменений.</p>
${written
  .map(
    (w) => `<h2>${w.name}</h2>
<div class="lens"><img src="${w.png}" width="640" height="480"></div>`,
  )
  .join("\n")}
`;
fs.writeFileSync(path.join(OUT, "preview.html"), html);
console.log(`wrote ${written.length} PNGs + preview.html to ${OUT}`);
