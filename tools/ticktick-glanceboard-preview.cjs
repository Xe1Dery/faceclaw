#!/usr/bin/env node
/**
 * Honest-size mockups for the proposed read-only TickTick Glanceboard widget.
 * This is intentionally preview-only: shipping widget code is not touched until
 * the wearer confirms the layout. It uses the real 288x144 slot geometry and
 * the same Terminus offline font fallback as the other Glanceboard previews.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".test-build", "app");
const OUT = path.join(ROOT, "preview", "ticktick-glanceboard-proposal");
fs.mkdirSync(OUT, { recursive: true });

const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@nativescript/core") {
    return {
      knownFolders: {
        currentApp: () => ({
          getFile: (relative) => ({
            readTextSync: () => fs.readFileSync(path.join(ROOT, "app", relative), "utf8"),
          }),
        }),
      },
    };
  }
  return realLoad.apply(this, arguments);
};

const UPNG = require("upng-js");
const { GrayImage } = require(path.join(BUILD, "graphics", "image.js"));
const { getFont } = require(path.join(BUILD, "graphics", "bdffont.js"));
const small = getFont("terminus12");
const medium = getFont("terminus16");

const SLOT_WIDTH = 288;
const SLOT_HEIGHT = 144;
const HEADER_BOTTOM = 27;
const ROW_START = 31;
const PAD = 8;

const rows = [
  { type: "group", title: "Просрочено" },
  { type: "task", title: "Подготовить отчёт", time: "вчера" },
  { type: "subtask", title: "Собрать данные", time: "" },
  { type: "subtask", title: "Проверить цифры", time: "" },
  { type: "group", title: "Сегодня" },
  { type: "task", title: "Ответить Марине", time: "09:30" },
  { type: "subtask", title: "Приложить файл", time: "" },
  { type: "task", title: "Забрать заказ", time: "18:20" },
  { type: "task", title: "Купить продукты", time: "20:00" },
  { type: "task", title: "Позвонить родителям", time: "21:00" },
];

function truncate(font, text, width) {
  if (font.measureText(text) <= width) return text;
  const suffix = "...";
  let out = text;
  while (out && font.measureText(out + suffix) > width) out = out.slice(0, -1);
  return out + suffix;
}

function drawCheckbox(image, x, y, value) {
  image.drawRect(x, y, 10, 10, value);
}

function drawRow(image, y, task, time) {
  const foreground = 220;
  const secondary = 150;
  drawCheckbox(image, PAD, y + 2, foreground);
  const timeWidth = small.measureText(time);
  const timeX = image.width - PAD - timeWidth;
  const titleX = 25;
  const titleWidth = Math.max(0, timeX - titleX - 7);
  image.drawText(small, titleX, y, truncate(small, task, titleWidth), foreground);
  image.drawText(small, timeX, y, time, secondary);
}

function drawSubtask(image, y, task, time) {
  const checkboxX = PAD + 12;
  image.drawRect(checkboxX, y + 2, 8, 8, 150);
  const timeWidth = small.measureText(time);
  const timeX = image.width - PAD - timeWidth;
  const titleX = checkboxX + 14;
  const titleWidth = Math.max(0, timeX - titleX - 7);
  image.drawText(small, titleX, y, truncate(small, task, titleWidth), 170);
  if (time) image.drawText(small, timeX, y, time, 130);
}

function drawGroup(image, y, title) {
  image.drawText(small, PAD, y, title, 150);
  const lineX = PAD + small.measureText(title) + 8;
  image.drawLine(lineX, y + 6, image.width - 1, y + 6, 45);
}

function paintWidget(height) {
  const image = new GrayImage(SLOT_WIDTH, height, 0);
  image.drawText(medium, PAD, 6, "Сегодня", 230);
  image.drawLine(0, HEADER_BOTTOM, image.width - 1, HEADER_BOTTOM, 80);

  let y = ROW_START;
  for (const row of rows) {
    const step = row.type === "group" ? 17 : row.type === "subtask" ? 18 : 20;
    if (y + step > height - 2) break;
    if (row.type === "group") drawGroup(image, y, row.title);
    else if (row.type === "subtask") drawSubtask(image, y, row.title, row.time);
    else drawRow(image, y, row.title, row.time);
    y += step;
  }
  return image;
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
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(UPNG.encode([rgba.buffer], baked.width, baked.height, 0)));
  return file;
}

function scale2x(image) {
  const baked = image.withDrawsBaked();
  const out = new GrayImage(baked.width * 2, baked.height * 2, 0);
  for (let y = 0; y < baked.height; y += 1) {
    for (let x = 0; x < baked.width; x += 1) {
      const value = baked.pixels[y * baked.width + x];
      if (value) out.fillRect(x * 2, y * 2, 2, 2, value);
    }
  }
  return out;
}

const previews = [
  ["today-read-only-single", paintWidget(144)],
  ["today-read-only-tall", paintWidget(288)],
];
for (const [name, image] of previews) {
  writePng(name, image);
  writePng(`${name}-2x`, scale2x(image));
}

fs.writeFileSync(path.join(OUT, "preview.html"), `<!doctype html>
<meta charset="utf-8"><title>TickTick Glanceboard proposal</title>
<style>body{background:#111;color:#ddd;font:14px system-ui;margin:24px}img{display:block;background:#000;border:1px solid #333;margin:8px 0 28px}</style>
<h1>TickTick — Glanceboard</h1>
<p>Просроченные задачи сверху. Открытые подзадачи вложены под родительской задачей. Управления нет.</p>
${previews.map(([name, image]) => `<h2>${name}</h2><img src="${name}-2x.png" width="${image.width * 2}" height="${image.height * 2}">`).join("\n")}`);

console.log(`wrote ${previews.length * 2} PNGs + preview.html to ${OUT}`);
