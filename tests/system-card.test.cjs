const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/**
 * The stock-G2 System Card: a big stacked dot-matrix clock centred from the
 * pre-rasterized DisplayOTF JSONs, the RU date top left, the OpenClaw link
 * square bottom left, and the notification bell counter bottom right. This
 * harness paints the real widget onto a recording canvas and asserts on the
 * recorded draws; the matrix fonts load through a mocked @nativescript/core
 * from the real shipped JSON assets.
 */
function load(file, dependencies, globals = {}) {
  const context = { exports: {}, console, require: (name) => {
    assert.ok(name in dependencies, `${file}: unmocked ${name}`);
    return dependencies[name];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

class RecordingImage {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.texts = [];
    this.rects = [];
    this.outlines = [];
  }
  fillRect(x, y, width, height, value) { this.rects.push({ x, y, width, height, value }); }
  drawRect(x, y, width, height, value) { this.outlines.push({ x, y, width, height, value }); }
  drawText(font, x, y, text, value) { this.texts.push({ x, y, text, value, size: font.lineHeight }); }
  drawImage() {}
  bitBlt() {}
  withDrawsBaked() { return this; }
}

function harness(options = {}) {
  const values = new Map();
  const settingListeners = new Set();
  const state = {
    bridgePhase: options.bridgePhase ?? 'connected',
    notificationCount: options.notificationCount ?? 0,
    time: options.time ?? '14:05',
  };
  class Setting {
    constructor(spec) { Object.assign(this, spec); }
    get() { return values.get(this.storageKey) ?? this.defaultValue; }
    set(value) { values.set(this.storageKey, value); }
  }
  const font = (lineHeight, advance) => ({ lineHeight, measureText: (text) => text.length * advance });
  const settings = {
    ConfigSettingBoolean: Setting, ConfigSettingEnum: Setting,
    batteryDisplayModeSetting: new Setting({ storageKey: 'battery.displayMode', defaultValue: 'dense' }),
    batteryIndicatorVisible: () => true,
    glassesBatteryVisibilitySetting: new Setting({ storageKey: 'b.glasses', defaultValue: 'always' }),
    phoneBatteryVisibilitySetting: new Setting({ storageKey: 'b.phone', defaultValue: 'always' }),
    ringBatteryVisibilitySetting: new Setting({ storageKey: 'b.ring', defaultValue: 'never' }),
    watchBatteryVisibilitySetting: new Setting({ storageKey: 'b.watch', defaultValue: 'never' }),
    onAnySettingChanged: (listener) => { settingListeners.add(listener); return () => settingListeners.delete(listener); },
    toggleSettingMenuItem: (setting) => ({ label: setting.label, onSelect: () => setting.set(!setting.get()) }),
  };
  const matrixFont = load('app/apps/glanceboard/matrix-font.ts', {
    '@nativescript/core': {
      File: { fromPath: (p) => ({ readTextSync: () => fs.readFileSync(p, 'utf8') }) },
      knownFolders: { currentApp: () => ({ path: path.join(__dirname, '..', 'app') }) },
    },
    '../../graphics/image': {},
  });
  const battery = {
    BATTERY_ICON_WIDTH: 12, DENSE_BATTERY_BLOCK_HEIGHT: 22,
    denseBatteriesWidth: (items) => items.length * 26,
    drawDenseBatteries: () => {}, drawBattery: () => {},
  };
  const widget = load('app/apps/glanceboard/widgets/system-card.ts', {
    '../../../graphics/battery': battery,
    '../../../graphics/image': {
      GrayImage: RecordingImage,
      imageFromAsciiArt: (lines) => ({ width: Math.max(...lines.map((l) => l.length)), height: lines.length }),
    },
    '../../../native/location-permissions': { ensureLocationPermission: async () => false, hasLocationPermission: () => false },
    '../../../native/notification-icons': {
      ALL_NOTIFICATIONS: 0x7fffffff,
      onAndroidNotificationsChanged: () => () => {},
      readActiveNotificationIcons: () => ({
        icons: Array.from({ length: state.notificationCount }, () => ({})), stale: false,
      }),
    },
    '../../../native/phone-battery': { readPhoneBatteryState: () => ({ battery: 80, charging: false }) },
    '../../../native/weather': { weatherBridge: { onStateChange: () => () => {}, snapshot: () => ({}), refreshNow: async () => {} } },
    '../../../ui/clock-format': { formatClockTime: () => state.time },
    '../../../ui/dashboard-settings': settings,
    '../../../ui/menu': {},
    '../../../ui/shell/shell': { shell: { getBatteryLevels: () => ({ headset: 90, headsetCharging: false, watch: null, watchCharging: false, ring: null, ringCharging: null }) } },
    '../../../util/render-freshness': { noteStaleDataUsed: () => {}, renderPassAllowsStaleData: () => false },
    '../../../graphics/textwrap': { truncateText: (_font, text) => text },
    '../../timer/timer-engine': { timerEngine: { timers: () => [], onChange: () => () => {} } },
    '../../timer/timer-model': {
      formatCountdown: () => '0:00', sortTimers: (timers) => timers, timerDisplayName: () => '',
      timerPhase: () => 'running', timerRemainingMs: () => 0,
    },
    '../../../ui/metrics': { lineStep: (f) => f.lineHeight + 2 },
    '../../weather/weather-icons': { drawWeatherReading: () => {}, measureWeatherReading: () => 0, weatherReading: () => null },
    '../../weather/weather-settings': { weatherShowOnSystemCardSetting: new Setting({ storageKey: 'weather.showOnSystemCard', defaultValue: false }) },
    '../../../assistant/bridge-client': { assistantBridge: { state: () => ({ phase: state.bridgePhase }), onStateChange: () => () => {} } },
    '../matrix-font': matrixFont,
    '../glance-font': { glanceFont: { large: () => font(32, 16), medium: () => font(24, 12), small: () => font(16, 8) } },
    '../widget': {},
  });
  return { widget, state, values, settings, settingListeners };
}

const paint = (h, width, height) => {
  const image = new RecordingImage(width, height);
  h.widget.SystemCardWidget.prototype.paint.call({ start() {}, stop() {} }, image);
  return image;
};

test('the clock paints as stacked matrix digits, hours over minutes, centred', () => {
  const h = harness({ time: '14:05' });
  const image = paint(h, 640, 480);
  // The 240px raster at 1:1: digit cells 133x168, two lines of two digits.
  const lit = image.rects.filter((r) => r.value === 235);
  assert.ok(lit.length > 200, `expected a matrix clock, got ${lit.length} lit pixels`);
  const xs = lit.map((r) => r.x);
  const ys = [...new Set(lit.map((r) => r.y))].sort((a, b) => a - b);
  // Hours occupy the upper digit row, minutes the lower: two rows of 168px
  // separated by the inter-line gap (~20px).
  const hours = lit.filter((r) => r.y < ys[0] + 168);
  const minutes = lit.filter((r) => !hours.includes(r));
  assert.ok(hours.length > 50 && minutes.length > 50, 'two stacked digit rows');
  assert.ok(Math.min(...xs) > 100 && Math.max(...lit.map((r) => r.x + r.width)) < 540, 'clock stays clear of the side columns');
  // The block is centred horizontally (glyphs sit centred in their cells, so
  // the lit span, not the cell grid, is what the card centres).
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...lit.map((r) => r.x + r.width))) / 2 - 320) < 12, 'clock centred horizontally');
  // Vertically centred in the card.
  const top = Math.min(...lit.map((r) => r.y));
  const bottom = Math.max(...lit.map((r) => r.y + r.height));
  assert.ok(Math.abs((top + bottom) / 2 - 240) < 40, `block centred (span ${top}..${bottom})`);
  // No plain-text clock fallback was drawn (the link label's colon is not it).
  assert.ok(!image.texts.some((t) => /^\d{1,2}:\d{2}/.test(t.text)), 'matrix clock replaces the text clock');
});

test('a card too small for the matrix falls back to the plain large clock', () => {
  const h = harness({ time: '14:05' });
  const image = paint(h, 288, 96);
  assert.ok(image.texts.some((t) => t.text === '14:05' && t.size === 32), 'text clock drawn instead');
});

test('the date paints top-left in RU dd.mm.yy form', () => {
  const h = harness();
  const image = paint(h, 640, 480);
  const expected = h.widget.formatClockDateRu(new Date());
  assert.match(expected, /^\d{2}\.\d{2}\.\d{2}$/);
  const date = image.texts.find((t) => t.text === expected);
  assert.ok(date, 'date text drawn');
  assert.equal(date.x, 8);
  assert.equal(date.y, 8);
});

test('the link square is filled when connected, hollow with a dot while redialing, hollow and bright when down', () => {
  const connected = paint(harness({ bridgePhase: 'connected' }), 640, 480);
  assert.ok(connected.rects.some((r) => r.width === 8 && r.height === 8 && r.value === 170), 'filled square');
  assert.ok(connected.texts.some((t) => t.text === 'OpenClaw: ок'));

  const dialing = paint(harness({ bridgePhase: 'connecting' }), 640, 480);
  assert.ok(dialing.outlines.some((r) => r.width === 8 && r.height === 8), 'hollow square');
  assert.ok(dialing.rects.some((r) => r.width === 2 && r.height === 2), 'centre dot');
  assert.ok(dialing.texts.some((t) => t.text === 'OpenClaw: …'));

  const down = paint(harness({ bridgePhase: 'failed' }), 640, 480);
  assert.ok(down.outlines.some((r) => r.width === 8 && r.height === 8 && r.value === 255), 'hollow bright square');
  assert.ok(!down.rects.some((r) => r.width === 8 && r.height === 8), 'not filled');
  assert.ok(down.texts.some((t) => t.text === 'OpenClaw: ОБРЫВ'));
});

test('notifications show as a bell counter; the count drives its brightness', () => {
  const empty = paint(harness({ notificationCount: 0 }), 640, 480);
  assert.ok(empty.texts.some((t) => t.text === '0' && t.value === 90), 'zero counter is dim');
  const busy = paint(harness({ notificationCount: 3 }), 640, 480);
  assert.ok(busy.texts.some((t) => t.text === '3' && t.value === 230), 'active counter is lit');
  assert.ok(busy.rects.some((r) => r.value === 230 && r.width === 1 && r.height === 1), 'bell pixels painted');
});

test('toggles hide their blocks and the link toggle is in the settings menu', () => {
  const h = harness();
  h.values.set('glanceboard.systemCard.showTime', false);
  h.values.set('glanceboard.systemCard.showNotifications', false);
  h.values.set('glanceboard.systemCard.showLink', false);
  const image = paint(h, 640, 480);
  assert.equal(image.rects.filter((r) => r.value === 235).length, 0, 'no clock');
  assert.ok(!image.texts.some((t) => t.text.startsWith('OpenClaw')), 'no link');
  assert.ok(!image.texts.some((t) => /^\d+$/.test(t.text)), 'no counter');
  const labels = h.widget.systemCardSettingsMenuItems().map((item) => item.label);
  assert.ok(labels.includes('OpenClaw link'), labels.join(','));
});
