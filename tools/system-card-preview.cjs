#!/usr/bin/env node
/**
 * Render the Glanceboard System Card exactly as the glasses show it, under
 * plain node, no device.
 *
 * Why this file exists: an earlier draft drew a hand-made 640x480 "full lens"
 * card, and it lied. On a real board the widget never gets the lens: the
 * Glanceboard paints each widget into its SLOT canvas (288x144 in the 2x2
 * layout), composes the slots into a 576x288 board (board.ts), and the glance
 * host centres that board on the 640x480 lens (glance-host.ts). In a 288x144
 * slot the clock falls to the 48px DisplayOTF raster and the side blocks push
 * the clock left of the slot centre — so the honest preview must run the
 * shipping widget code at the shipping geometry, which is what this does:
 *
 * - the widget is the REAL app/apps/glanceboard/widgets/system-card.ts,
 *   transpiled and loaded with the same vm harness as tests/system-card.test.cjs,
 * - the clock rasters are the REAL shipped JSONs in app/fonts/displayotf/,
 *   picked by the widget's own 240/96/48 fit ladder,
 * - the battery block is the REAL app/graphics/battery.ts,
 * - small text is the REAL Terminus .bdf files (see caveat 1),
 * - the board is composed the way board.ts composes it (slot canvases,
 *   composeInto, hairline dividers at DIVIDER_VALUE=20 when --lines on),
 * - the board is placed on the lens the way glance-host.ts places it:
 *   x = (640 - boardWidth) / 2, y = minWindowTop() (see caveat 3).
 *
 * Caveats to read before trusting a preview as gospel:
 * 1. Small text (date, link label, counter): the device's default UI font is
 *    Roboto-Light TTF, rasterized by Java — impossible off-Android. The
 *    preview uses the Terminus bitmap roles (12/16/24) the app itself falls
 *    back to offline and a wearer can pick in Settings > Fonts. Cyrillic
 *    renders (Terminus is cp1251); glyph shapes differ from Roboto, metrics
 *    are close. The matrix clock is unaffected — it is the shipped raster.
 * 2. The weather icon (SVG) is rasterized by Java on-device; the preview
 *    reserves the icon's slot but draws no icon. Temperature text is real.
 * 3. y = minWindowTop() is mirrored here for the default Display mode
 *    (band-middle) with the switcher at the bottom; a different Display >
 *    Vertical position or switcher placement moves the board — override
 *    with --y.
 *
 * Usage: node tools/system-card-preview.cjs [--out DIR] [--notifications N]
 *   [--weather on|off] [--layout 2x2|2x3] [--slot N] [--time HH:MM]
 *   [--lines on|off] [--y N]
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const vm = require("vm");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".test-build", "app");
if (!fs.existsSync(BUILD)) {
  console.error(`No ${path.relative(ROOT, BUILD)} - run: npx tsc -p tests/tsconfig.json`);
  process.exit(1);
}

// The one platform shim: the real bdffont.js reads its .bdf files through
// knownFolders.currentApp().getFile(); serve them from app/.
const nsCoreStub = {
  knownFolders: {
    currentApp: () => ({
      getFile: (relative) => ({ readTextSync: () => fs.readFileSync(path.join(ROOT, "app", relative), "utf8") }),
    }),
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@nativescript/core") return nsCoreStub;
  return realLoad.apply(this, arguments);
};

const UPNG = require("upng-js");
const { GrayImage, imageFromAsciiArt, G2_LENS_WIDTH, G2_LENS_HEIGHT } = require(path.join(BUILD, "graphics/image.js"));
const { getFont } = require(path.join(BUILD, "graphics/bdffont.js"));
const battery = require(path.join(BUILD, "graphics/battery.js"));
const textwrap = require(path.join(BUILD, "graphics/textwrap.js"));
const { lineStep } = require(path.join(BUILD, "ui/metrics.js"));
const timerModel = require(path.join(BUILD, "apps/timer/timer-model.js"));
const layout = require(path.join(BUILD, "apps/glanceboard/layout.js"));

// --- CLI ---------------------------------------------------------------------

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const args = {
  out: flag("--out", path.join(ROOT, "preview", "system-card")),
  notifications: Number(flag("--notifications", 3)),
  weather: flag("--weather", "on") === "on",
  layout: flag("--layout", "2x2"),
  slot: Number(flag("--slot", 0)),
  time: flag("--time", ""),
  lines: flag("--lines", "on") === "on",
  y: flag("--y", "") === "" ? null : Number(flag("--y", "")),
};
fs.mkdirSync(args.out, { recursive: true });

// A fixed clock makes runs comparable; otherwise "now", like the widget.
const NOW = args.time
  ? (() => {
      const [h, m] = args.time.split(":").map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    })()
  : new Date();

// --- the real widget, loaded through the test harness --------------------------

/** Transpile a real app .ts file and run it with injected dependencies. */
function load(file, dependencies, globals = {}) {
  const context = {
    exports: {},
    console,
    require: (name) => {
      if (!(name in dependencies)) throw new Error(`${file}: unmocked ${name}`);
      return dependencies[name];
    },
    ...globals,
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(ROOT, file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
    context,
  );
  return context.exports;
}

// In-memory settings store shared by every mocked settings consumer, so the
// preview can flip a switch (--weather) the way the app would.
const values = new Map();
class Setting {
  constructor(spec) { Object.assign(this, spec); }
  get() { return values.get(this.storageKey) ?? this.defaultValue; }
  set(value) { values.set(this.storageKey, value); }
}
values.set("display.temperatureUnit", "celsius"); // the wearer's real setting
values.set("weather.showOnSystemCard", args.weather);

const dashboardSettings = {
  ConfigSettingBoolean: Setting,
  ConfigSettingEnum: Setting,
  timeFormatSetting: new Setting({ storageKey: "clock.format", defaultValue: "24h" }),
  temperatureUnitSetting: new Setting({ storageKey: "display.temperatureUnit", defaultValue: "fahrenheit" }),
  batteryDisplayModeSetting: new Setting({ storageKey: "battery.displayMode", defaultValue: "dense" }),
  batteryIndicatorVisible: () => true,
  glassesBatteryVisibilitySetting: new Setting({ storageKey: "b.glasses", defaultValue: "always" }),
  phoneBatteryVisibilitySetting: new Setting({ storageKey: "b.phone", defaultValue: "always" }),
  ringBatteryVisibilitySetting: new Setting({ storageKey: "b.ring", defaultValue: "never" }),
  watchBatteryVisibilitySetting: new Setting({ storageKey: "b.watch", defaultValue: "never" }),
  onAnySettingChanged: () => () => {},
  toggleSettingMenuItem: (setting) => ({ label: setting.label, onSelect: () => setting.set(!setting.get()) }),
};

// The matrix loader is the shipping one; it reads the shipping JSON assets
// through the @nativescript/core shim above (knownFolders.currentApp().getFile).
const matrixFont = load("app/apps/glanceboard/matrix-font.ts", {
  "@nativescript/core": {
    File: { fromPath: (p) => ({ readTextSync: () => fs.readFileSync(p, "utf8") }) },
    knownFolders: { currentApp: () => ({ path: path.join(ROOT, "app") }) },
  },
  "../../graphics/image": {},
});
const clockFormat = load("app/ui/clock-format.ts", { "./dashboard-settings": dashboardSettings });
const temperatureFormat = load("app/apps/weather/temperature-format.ts", {
  "../../ui/dashboard-settings": dashboardSettings,
});
// Real weather block logic; only the Java SVG rasterizer is stubbed (caveat 2).
const weatherIcons = load("app/apps/weather/weather-icons.ts", {
  "../../graphics/icons": { renderSvgIcon: () => null },
  "../../graphics/image": { GrayImage },
  "../../native/weather": {},
  "./temperature-format": temperatureFormat,
});
const weatherSettings = load("app/apps/weather/weather-settings.ts", {
  "../../ui/dashboard-settings": dashboardSettings,
});

// The weather bridge's fixture: a fresh, real-shaped reading.
const weatherState = {
  phase: "ready",
  place: "Home",
  lastUpdatedMs: NOW.getTime(),
  current: {
    temperatureF: 44.6, // 7 C
    description: "Облачно",
    humidityPercent: 81,
    windSpeedMph: 4.5,
    windDirection: "SW",
    timestampMs: NOW.getTime(),
    observed: true,
    condition: "cloudy",
    isDaytime: NOW.getHours() >= 6 && NOW.getHours() < 20,
  },
  forecast: [],
};

const states = [
  { name: "connected", phase: "connected" },
  { name: "connecting", phase: "connecting" },
  { name: "down", phase: "failed" },
];
let currentPhase = "connected";

const systemCard = load("app/apps/glanceboard/widgets/system-card.ts", {
  "../../../graphics/battery": battery,
  "../../../graphics/image": { GrayImage, imageFromAsciiArt },
  "../../../native/location-permissions": { ensureLocationPermission: async () => false, hasLocationPermission: () => true },
  "../../../native/notification-icons": {
    ALL_NOTIFICATIONS: 0x7fffffff,
    onAndroidNotificationsChanged: () => () => {},
    readActiveNotificationIcons: () => ({
      icons: Array.from({ length: args.notifications }, () => ({ packageName: "x", category: 0 })),
      stale: false,
    }),
  },
  "../../../native/phone-battery": { readPhoneBatteryState: () => ({ battery: 78, charging: false }) },
  "../../../native/weather": {
    weatherBridge: {
      onStateChange: () => () => {},
      snapshot: () => weatherState,
      refreshNow: async () => {},
    },
  },
  "../../../ui/clock-format": clockFormat,
  "../../../ui/dashboard-settings": dashboardSettings,
  "../../../ui/menu": {},
  "../../../ui/shell/shell": {
    shell: { getBatteryLevels: () => ({ headset: 91, headsetCharging: false, watch: null, watchCharging: false, ring: null, ringCharging: null }) },
  },
  "../../../util/render-freshness": { noteStaleDataUsed: () => {}, renderPassAllowsStaleData: () => false },
  "../../../graphics/textwrap": textwrap,
  "../../timer/timer-engine": { timerEngine: { timers: () => [], onChange: () => () => {} } },
  "../../timer/timer-model": timerModel,
  "../../../ui/metrics": { lineStep },
  "../../weather/weather-icons": weatherIcons,
  "../../weather/weather-settings": weatherSettings,
  "../../../assistant/bridge-client": {
    assistantBridge: { state: () => ({ phase: currentPhase }), onStateChange: () => () => {} },
  },
  "../matrix-font": matrixFont,
  // The bitmap roles ui-fonts.ts resolves when TTF rasterization is
  // unavailable (caveat 1): small=terminus12, medium=terminus16, large=terminus24.
  "../glance-font": {
    glanceFont: { small: () => getFont("terminus12"), medium: () => getFont("terminus16"), large: () => getFont("terminus24") },
  },
  "../widget": {},
});

/** Paint the real widget onto a fresh canvas, as board.ts does per region. */
function paintSlot(width, height) {
  const canvas = new GrayImage(width, height, 0);
  systemCard.SystemCardWidget.prototype.paint.call({ start() {}, stop() {} }, canvas);
  return canvas;
}

// --- board + lens composition (mirrors board.ts + glance-host.ts) --------------

const DIVIDER_VALUE = 20; // board.ts
const SWITCHER_ROW_HEIGHT = 36; // geometry.ts

function boardLayout() {
  return args.layout === "2x3" ? layout.SIX_SLOT_LAYOUT : layout.QUADRANT_LAYOUT;
}

/** minWindowTop() for the default band-middle layout with a bottom switcher. */
function defaultBoardTop(boardHeight) {
  const band = Math.min(288, G2_LENS_HEIGHT - SWITCHER_ROW_HEIGHT);
  const top = Math.round((G2_LENS_HEIGHT - SWITCHER_ROW_HEIGHT - band) * 0.5);
  return Math.max(0, Math.min(top, G2_LENS_HEIGHT - band - SWITCHER_ROW_HEIGHT, G2_LENS_HEIGHT - boardHeight));
}

/** Compose the slot canvas into a board-sized image, dividers included. */
function composeBoard(gl, slotRect, canvas) {
  const board = new GrayImage(gl.width, gl.height, 0);
  canvas.composeInto(board, slotRect.x, slotRect.y);
  if (args.lines) {
    const regions = [{ choice: "system-card", rect: slotRect, slots: [args.slot] }];
    for (const line of layout.slotDividers(gl, regions))
      board.drawLine(line.x0, line.y0, line.x1, line.y1, DIVIDER_VALUE);
  }
  return board;
}

/** The full lens frame, board placed as glance-host.ts places it. */
function composeLens(board, boardX, boardY) {
  const full = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  board.composeInto(full, boardX, boardY);
  return full;
}

// --- PNG out --------------------------------------------------------------------

/** The G2's microLED panel is green monochrome; approximate the worn look. */
function greenTint(rgba) {
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
  const file = path.join(args.out, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(UPNG.encode([rgba.buffer], baked.width, baked.height, 0)));
  let lit = 0;
  for (const value of baked.pixels) if (value > 0) lit += 1;
  if (lit === 0) console.error(`  !! ${file} is entirely blank`);
  return `${name}.png`;
}

/** Nearest-neighbour upscale for eyeballing slot detail (a viewer-side zoom). */
function scale2x(image) {
  const baked = image.withDrawsBaked();
  const out = new GrayImage(baked.width * 2, baked.height * 2, 0);
  for (let y = 0; y < baked.height; y++)
    for (let x = 0; x < baked.width; x++) {
      const v = baked.pixels[y * baked.width + x];
      if (!v) continue;
      out.fillRect(x * 2, y * 2, 2, 2, v);
    }
  return out;
}

// --- render ----------------------------------------------------------------------

const gl = boardLayout();
const slotRect = gl.slots[args.slot].rect;
const boardX = Math.max(0, ((G2_LENS_WIDTH - gl.width) / 2) | 0);
const boardY = args.y ?? defaultBoardTop(gl.height);

const written = [];
for (const state of states) {
  currentPhase = state.phase;
  const slot = paintSlot(slotRect.width, slotRect.height);
  const board = composeBoard(gl, slotRect, slot);
  const lens = composeLens(board, boardX, boardY);
  written.push({
    ...state,
    slot: writePng(`slot-${state.name}`, slot),
    zoom: writePng(`slot-${state.name}-2x`, scale2x(slot)),
    board: writePng(`board-${state.name}`, board),
    lens: writePng(`lens-${state.name}`, lens),
  });
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>System Card — glanceboard view</title>
<style>
 body{background:#111;color:#ddd;font:14px system-ui,sans-serif;margin:24px}
 h1{font-size:18px} h2{font-size:15px;color:#9c9;margin-top:34px}
 .note{color:#888;max-width:780px}
 img{background:#000;border:1px solid #333;display:block;margin:8px 0}
</style>
<h1>System Card — как он выглядит в Glanceboard (${gl.id}, слот ${args.slot}, ${slotRect.width}×${slotRect.height})</h1>
<p class="note">Настоящий код виджета (widgets/system-card.ts) на настоящем холсте слота; доска собрана как в board.ts и
поставлена на линзу как в glance-host.ts (x=${boardX}, y=${boardY}). Часы — тот растр DisplayOTF, который виджет сам выбрал под слот
(обычно 48px — отсюда «прямоугольники вперемешку с пикселями», на 240px растре их нет). Погода${args.weather ? " включена" : " выключена (--weather off)"}, иконка погоды не рисуется (Java-растеризатор), место под неё зарезервировано.
Мелкий текст — Terminus (офлайн-фолбэк), на устройстве по умолчанию Roboto-Light — глифы чуть другие, метрики близки.</p>
${written
  .map(
    (w) => `<h2>${w.name}</h2>
<img src="${w.lens}" width="640" height="480">
<img src="${w.board}" width="576" height="${gl.height}">
<img src="${w.slot}" width="${slotRect.width}" height="${slotRect.height}">
<img src="${w.zoom}" width="${slotRect.width * 2}" height="${slotRect.height * 2}">`,
  )
  .join("\n")}
`;
fs.writeFileSync(path.join(args.out, "preview.html"), html);
console.log(
  `wrote ${written.length * 4} PNGs + preview.html to ${args.out} (layout ${gl.id}, slot ${args.slot} ${slotRect.width}x${slotRect.height}, board at ${boardX},${boardY}, weather ${args.weather ? "on" : "off"}, notifications ${args.notifications})`,
);
