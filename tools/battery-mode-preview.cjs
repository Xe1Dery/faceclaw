#!/usr/bin/env node
/**
 * UI proposal only: compare the shipping Dense battery block with a proposed
 * same-footprint Dense percentage variant before touching shipping widgets.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".test-build", "app");
const OUT = path.join(ROOT, "preview", "battery-dense-percentage-proposal");
fs.mkdirSync(OUT, { recursive: true });

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
const { GrayImage } = require(path.join(BUILD, "graphics", "image.js"));
const { getFont } = require(path.join(BUILD, "graphics", "bdffont.js"));
const battery = require(path.join(BUILD, "graphics", "battery.js"));

const small = getFont("terminus12");
const medium = getFont("terminus16");
const ITEMS = [
  { device: "phone", percent: 80, charging: false },
  { device: "watch", percent: 35, charging: true },
  { device: "glasses", percent: 60, charging: false },
  { device: "ring", percent: 100, charging: false },
];

function blocks() {
  const dense = new GrayImage(128, 26, 0);
  const proposed = new GrayImage(128, 26, 0);
  const right = 120;
  const left = battery.drawDenseBatteries(dense, ITEMS, right, 2);
  const proposedLeft = battery.drawDensePercentageBatteries(proposed, ITEMS, right, 2);
  if (proposedLeft !== left) throw new Error(`Footprint mismatch: ${left} != ${proposedLeft}`);
  const width = right - left;
  const crop = (source) => {
    const result = new GrayImage(width, battery.DENSE_BATTERY_BLOCK_HEIGHT, 0);
    result.bitBlt(source, 0, 0, { sx: left, sy: 2, width, height: result.height });
    return result;
  };
  return { dense: crop(dense), proposed: crop(proposed), width };
}

function zoomInto(source, target, x, y, scale) {
  for (let sy = 0; sy < source.height; sy += 1) {
    for (let sx = 0; sx < source.width; sx += 1) {
      target.fillRect(x + sx * scale, y + sy * scale, scale, scale, source.getPixel(sx, sy));
    }
  }
}

function greenTint(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const value = rgba[i];
    rgba[i] = Math.round(value * 0.35);
    rgba[i + 1] = Math.round(value * 0.95);
    rgba[i + 2] = Math.round(value * 0.45);
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
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(UPNG.encode([rgba.buffer], baked.width, baked.height, 0)));
  return file;
}

const { dense, proposed, width } = blocks();
const preview = new GrayImage(640, 300, 0);
small.drawText(preview, 20, 18, "ТЕКУЩИЙ DENSE (1:1)", 150);
medium.drawText(preview, 20, 42, "14:32", 235);
preview.drawLine(0, 70, 639, 70, 50);
preview.bitBlt(dense, 608 - width, 38);

small.drawText(preview, 20, 92, "НОВЫЙ DENSE PERCENTAGE (1:1)", 150);
medium.drawText(preview, 20, 116, "14:32", 235);
preview.drawLine(0, 144, 639, 144, 50);
preview.bitBlt(proposed, 608 - width, 112);

small.drawText(preview, 20, 166, `ОДИНАКОВЫЙ РАЗМЕР: ${width}x${dense.height} PX`, 150);
small.drawText(preview, 20, 188, "УВЕЛИЧЕНО 4x: DENSE", 150);
small.drawText(preview, 330, 188, "УВЕЛИЧЕНО 4x: ПРОЦЕНТЫ", 150);
zoomInto(dense, preview, 20, 210, 4);
zoomInto(proposed, preview, 330, 210, 4);

const out = writePng("dense-vs-dense-percentage.png", preview);
console.log(`${out}\nblock=${width}x${dense.height}`);
