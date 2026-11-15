const test = require('node:test');
const assert = require('node:assert/strict');
const { GrayImage } = require('../.test-build/app/graphics/image.js');
const {
  BATTERY_ICON_WIDTH,
  DENSE_BATTERY_BLOCK_HEIGHT,
  drawBattery,
  drawDenseBatteries,
  drawDensePercentageBatteries,
} = require('../.test-build/app/graphics/battery.js');

const RIGHT = 120;
const TOP = 4;
const LOWER_ROW = DENSE_BATTERY_BLOCK_HEIGHT - drawBattery(0, false).height;

/** Every top-left position where exactly this gauge was drawn. */
function findGauges(image, percent, charging) {
  const gauge = drawBattery(percent, charging);
  const found = [];
  for (let y = 0; y + gauge.height <= image.height; y++) {
    for (let x = 0; x + gauge.width <= image.width; x++) {
      let match = true;
      for (let gy = 0; match && gy < gauge.height; gy++) {
        for (let gx = 0; match && gx < gauge.width; gx++) {
          match = image.pixels[(y + gy) * image.width + x + gx] === gauge.pixels[gy * gauge.width + gx];
        }
      }
      if (match) found.push({ x, y });
    }
  }
  return found;
}

function hasInk(image, x0, x1, y0, y1) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (image.pixels[y * image.width + x] > 0) return true;
    }
  }
  return false;
}

function gaugeAt(image, percent, charging = false) {
  const found = findGauges(image, percent, charging);
  assert.equal(found.length, 1, `one ${percent}% gauge`);
  return found[0];
}

test('dense batteries stack two per column, right-aligned', () => {
  const image = new GrayImage(RIGHT + 8, 32, 0);
  const left = drawDenseBatteries(image, [
    { device: 'phone', percent: 80, charging: false },
    { device: 'watch', percent: 35, charging: true },
    { device: 'glasses', percent: 60, charging: false },
    { device: 'ring', percent: 100, charging: false },
  ], RIGHT, TOP);
  const phone = gaugeAt(image, 80);
  const watch = gaugeAt(image, 35, true);
  const glasses = gaugeAt(image, 60);
  const ring = gaugeAt(image, 100);
  assert.deepEqual(glasses, { x: RIGHT - BATTERY_ICON_WIDTH, y: TOP });
  assert.deepEqual(ring, { x: RIGHT - BATTERY_ICON_WIDTH, y: TOP + LOWER_ROW });
  assert.equal(phone.y, TOP);
  assert.deepEqual(watch, { x: phone.x, y: TOP + LOWER_ROW });
  // Each gauge has its device icon to its left.
  assert.ok(hasInk(image, left, phone.x, TOP, TOP + 10));
  assert.ok(hasInk(image, left, watch.x, TOP + LOWER_ROW, TOP + LOWER_ROW + 10));
  assert.ok(hasInk(image, phone.x + BATTERY_ICON_WIDTH, glasses.x, TOP, TOP + 10));
  assert.ok(hasInk(image, watch.x + BATTERY_ICON_WIDTH, ring.x, TOP + LOWER_ROW, TOP + LOWER_ROW + 10));
});

test('an odd count leaves the first indicator alone, vertically centered', () => {
  const image = new GrayImage(RIGHT + 8, 32, 0);
  drawDenseBatteries(image, [
    { device: 'phone', percent: 80, charging: false },
    { device: 'glasses', percent: 60, charging: false },
    { device: 'ring', percent: 20, charging: false },
  ], RIGHT, TOP);
  assert.equal(gaugeAt(image, 80).y, TOP + LOWER_ROW / 2);
  assert.deepEqual(gaugeAt(image, 60), { x: RIGHT - BATTERY_ICON_WIDTH, y: TOP });
  assert.deepEqual(gaugeAt(image, 20), { x: RIGHT - BATTERY_ICON_WIDTH, y: TOP + LOWER_ROW });
});

test('no indicators draws nothing', () => {
  const image = new GrayImage(RIGHT + 8, 32, 0);
  assert.equal(drawDenseBatteries(image, [], RIGHT, TOP), RIGHT);
  assert.ok(image.pixels.every((value) => value === 0));
});

test('dense percentages keep the exact dense footprint and centre charging ink', () => {
  const items = [
    { device: 'phone', percent: 80, charging: false },
    { device: 'watch', percent: 35, charging: true },
    { device: 'glasses', percent: 60, charging: false },
    { device: 'ring', percent: 100, charging: false },
  ];
  const gauges = new GrayImage(RIGHT + 8, 32, 0);
  const percentages = new GrayImage(RIGHT + 8, 32, 0);
  const denseLeft = drawDenseBatteries(gauges, items, RIGHT, TOP);
  const percentageLeft = drawDensePercentageBatteries(percentages, items, RIGHT, TOP);
  assert.equal(percentageLeft, denseLeft, 'both modes have the same left and right edges');

  const watchSlot = gaugeAt(gauges, 35, true);
  const darkInk = [];
  for (let y = watchSlot.y; y < watchSlot.y + 10; y++) {
    for (let x = watchSlot.x; x < watchSlot.x + BATTERY_ICON_WIDTH; x++) {
      const value = percentages.getPixel(x, y);
      if (value === 1) darkInk.push({ x, y });
      if (y === watchSlot.y || y === watchSlot.y + 9) assert.equal(value, 0, 'inversion leaves one clear row above and below');
      else assert.ok(value === 1 || value === 200, `charging slot value ${value}`);
    }
  }
  const textTop = Math.min(...darkInk.map((pixel) => pixel.y));
  const textBottom = Math.max(...darkInk.map((pixel) => pixel.y));
  assert.deepEqual([textTop, textBottom], [watchSlot.y + 2, watchSlot.y + 7]);
  assert.equal((textTop + textBottom) / 2, watchSlot.y + 4.5, 'text is centred on the 10px device icon');
  assert.equal(((watchSlot.y + 1) + (watchSlot.y + 8)) / 2, watchSlot.y + 4.5,
    'the inversion rectangle has the same centre');
});

test('dense percentages draw nothing for an empty device list', () => {
  const image = new GrayImage(RIGHT + 8, 32, 0);
  assert.equal(drawDensePercentageBatteries(image, [], RIGHT, TOP), RIGHT);
  assert.ok(image.pixels.every((value) => value === 0));
});
