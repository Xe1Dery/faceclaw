#!/usr/bin/env node
/**
 * Render the proposed assistant UX (dictation bar + chat session + popups)
 * exactly as the glasses would show it, under plain node, no device.
 *
 * This is a MOCKUP tool for the assistant redesign, patterned after
 * tools/system-card-preview.cjs: same GrayImage canvas, same Terminus bitmap
 * roles (the offline fallback the device also has), same green-tint PNGs.
 * The background interface behind the overlays is SCHEMATIC (a stand-in app
 * window), not a real app render — the point of the mockups is the overlay
 * geometry, animation end-states, and gesture captions, not the wallpaper.
 *
 * Lens facts this tool respects:
 * - 640x480 content (G2_LENS_WIDTH/HEIGHT), green monochrome panel;
 * - bottom switcher row is 36px (geometry.ts SWITCHER row), so the dictation
 *   bar sits ABOVE it. The bar is the LOWEST ELEMENT OF THE INTERFACE, not
 *   of the screen: it anchors under the window band (+ the row under it),
 *   so with Display > Vertical position = top it rides under the top-pinned
 *   band instead of the screen bottom (see interfaceBottom(), --vpos);
 *   the bar is full width from the start and grows DOWNWARD (its top edge
 *   is fixed) as the phrase wraps;
 * - gesture hints use the app's own glyph convention (gestures.ts):
 *   ● tap, ●● double-tap, ▲▼ scroll;
 * - small text = terminus12 (lh 12), message text = terminus16 (lh 16);
 * - popup frames use the shipping ReminderLayer recipe: fill 1, border 90,
 *   title 200, body 235, hint 150.
 *
 * Usage: node tools/assistant-ui-preview.cjs [--out DIR] [--vpos top|middle|bottom]
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".test-build", "app");
if (!fs.existsSync(BUILD)) {
  console.error(`No ${path.relative(ROOT, BUILD)} - run: npx tsc -p tests/tsconfig.json`);
  process.exit(1);
}

// Platform shim: the real bdffont.js reads .bdf files through knownFolders.
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
const { GrayImage, G2_LENS_WIDTH, G2_LENS_HEIGHT } = require(path.join(BUILD, "graphics/image.js"));
const { getFont } = require(path.join(BUILD, "graphics/bdffont.js"));
const { wrapText } = require(path.join(BUILD, "graphics/textwrap.js"));

const args = {
  out: (() => {
    const i = process.argv.indexOf("--out");
    return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : path.join(ROOT, "preview", "assistant-ui");
  })(),
};
fs.mkdirSync(args.out, { recursive: true });

const small = getFont("terminus12");
const medium = getFont("terminus16");

// --- shared chrome -------------------------------------------------------------

const SWITCHER_ROW = 36; // geometry.ts: bottom switcher row height
const BAR_H = 44;        // one dictation line + 14px vertical padding
const BAR_W = 576;       // full width from the start
const BAR_LINE = 16;     // terminus16 line height, per extra wrapped line

// The app's own gesture glyphs (app/ui/gestures.ts).
const G_TAP = "●";
const G_DOUBLE = "●●";
const G_SCROLL = "▲▼";

// Band geometry mirrors geometry.ts: windowTop("min") = round((screen -
// one switcher row - band) * fraction), band = minWindowHeight = 288, and a
// bottom switcher row hangs right under the band. --vpos mirrors Display >
// Vertical position.
const BAND_H = 288;
const VPOS = (() => {
  const i = process.argv.indexOf("--vpos");
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : "middle";
})();
const VPOS_FRACTION = { top: 0, middle: 0.5, bottom: 1 }[VPOS] ?? 0.5;

/** Top edge of the min-height window band for the chosen vertical position. */
function bandTop() {
  return Math.round((G2_LENS_HEIGHT - SWITCHER_ROW - BAND_H) * VPOS_FRACTION);
}

/** Bottom edge of the interface: band + the bottom switcher row under it. */
function interfaceBottom() {
  return bandTop() + BAND_H + SWITCHER_ROW;
}

/** Top edge of the one-line bar: its bottom rides 12px above the interface's. */
function barTop() {
  return interfaceBottom() - 12 - BAR_H;
}

/** Schematic background: top bar + a stand-in app window. */
function background() {
  const img = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  // top status bar: time left, batteries right
  medium.drawText(img, 16, 10, "14:32", 235);
  img.drawRect(560, 10, 30, 14, 200); // glasses battery outline
  img.fillRect(562, 12, 20, 10, 200);
  img.drawRect(600, 12, 24, 10, 200); // phone battery outline
  img.fillRect(602, 14, 14, 6, 200);
  // stand-in window: border + title + rows
  const bt = bandTop();
  img.drawRect(32, bt + 4, 576, BAND_H - 8, 90);
  medium.drawText(img, 46, bt + 14, "Напоминания", 200);
  const rows = [
    "Купить билеты на Ригу",
    "Позвонить маме",
    "Отдать долг - 1500",
    "Записаться к стоматологу",
  ];
  rows.forEach((row, i) => medium.drawText(img, 46, bt + 46 + i * 30, "· " + row, 235));
  // bottom switcher row, hanging under the band: a few app squares
  const sy = bt + BAND_H;
  img.drawLine(0, sy, G2_LENS_WIDTH, sy, 60);
  for (let i = 0; i < 5; i++) img.drawRect(200 + i * 56, sy + 8, 20, 20, 120);
  return img;
}

/** Mic glyph: capsule + stand, ~10x14 at (x, y). */
function drawMic(img, x, y, value) {
  img.fillRect(x + 3, y, 4, 10, value);
  img.fillRect(x + 2, y + 1, 6, 8, value);
  img.drawLine(x + 1, y + 6, x + 9, y + 6, value);
  img.drawLine(x + 1, y + 7, x + 9, y + 7, value);
  img.drawLine(x + 5, y + 9, x + 5, y + 13, value);
  img.drawLine(x + 3, y + 13, x + 7, y + 13, value);
}

/**
 * The dictation bar. opts: {text, controls, countdown}
 * - full width always; one line tall, growing DOWN as the phrase wraps
 *   (top edge fixed); the tail of the phrase is what stays visible;
 * - controls: the post-dictation glyph hint row (● send · ▲▼ redo · ●● close);
 * - countdown: remaining ms of the auto-send grace, a shrinking underline
 *   drawn at the bar's bottom edge (so it rides the growth).
 */
function dictationBar(img, opts) {
  const x = ((G2_LENS_WIDTH - BAR_W) / 2) | 0;
  const y = barTop();
  // the phrase wraps at the full inner width; the bar grows down to fit it
  const lines = opts.text ? wrapText(medium, opts.text, BAR_W - 36 - 14) : [];
  const shown = lines.slice(0, 4); // hard cap: 4 lines, then it scrolls
  const height = BAR_H + Math.max(0, shown.length - 1) * BAR_LINE + (opts.controls ? small.lineHeight + 4 : 0);
  img.fillRect(x, y, BAR_W, height, 1);
  img.drawRect(x, y, BAR_W, height, 120);
  drawMic(img, x + 14, y + 10, opts.text ? 150 : 235);
  if (shown.length) {
    shown.forEach((line, i) => medium.drawText(img, x + 36, y + 14 + i * BAR_LINE, line, 235));
  } else {
    small.drawText(img, x + 36, y + 16, "Слушаю...", 150);
  }
  if (opts.controls) {
    const cy = y + height - small.lineHeight - 4;
    small.drawText(img, x + 36, cy, `${G_TAP} отправить   ${G_SCROLL} заново   ${G_DOUBLE} закрыть`, 150);
  }
  if (opts.countdown !== undefined) {
    // auto-send grace: a shrinking underline at the bottom edge, full = 1.5s
    const w = Math.max(0, Math.min(1, opts.countdown / 1500)) * (BAR_W - 8);
    img.fillRect(x + 4, y + height - 3, w | 0, 2, 200);
  }
  return { x, y, width: BAR_W, height };
}

/** Chat session window: full-screen takeover, header + message list. */
function chatWindow(img, opts) {
  const x = 16;
  const width = G2_LENS_WIDTH - 32;
  const top = 8;
  const height = G2_LENS_HEIGHT - SWITCHER_ROW - 16;
  img.fillRect(x, top, width, height, 1);
  img.drawRect(x, top, width, height, 120);
  // header: name left, link square right (bridge state lives here now)
  medium.drawText(img, x + 14, top + 8, "OpenClaw", 200);
  const sq = 12;
  img.fillRect(x + width - sq - 14, top + 10, sq, sq, opts.link === "down" ? 255 : opts.link === "connecting" ? 120 : 235);
  if (opts.link === "connecting") img.fillRect(x + width - sq - 9, top + 15, 2, 2, 1);
  img.drawLine(x, top + 32, x + width, top + 32, 70);
  // messages, newest last
  let y = top + 40;
  for (const msg of opts.messages) {
    const user = msg.role === "user";
    const text = user ? "> " + msg.text : msg.text;
    const lines = wrapText(medium, text, width - 28);
    const value = user ? 170 : 235;
    for (const line of lines) {
      if (y + medium.lineHeight > top + height - (opts.actions || opts.hint || opts.newBelow ? 24 : 20)) break;
      medium.drawText(img, x + 14, y, line, value);
      y += medium.lineHeight;
    }
    y += 6;
  }
  // the agent's action trail (Thinking, Exec...) rides under the newest message
  if (opts.actions) {
    small.drawText(img, x + 26, Math.min(y, top + height - small.lineHeight - 2), opts.actions, 130);
  }
  if (opts.newBelow) {
    // answer outgrew the window: an arrow promises more below
    const ax = x + width - 20;
    const ay = top + height - 16;
    img.drawLine(ax, ay, ax + 8, ay, 180);
    img.drawLine(ax + 1, ay + 2, ax + 7, ay + 2, 180);
    img.drawLine(ax + 2, ay + 4, ax + 6, ay + 4, 180);
    img.drawLine(ax + 3, ay + 6, ax + 5, ay + 6, 180);
    img.drawLine(ax + 4, ay + 8, ax + 4, ay + 8, 180);
  }
  if (opts.hint) {
    small.drawText(img, x + 14, top + height - 18, opts.hint, 150);
  }
  return { x, top, width, height };
}

/** Popup frame (reminder / notification): the shipping ReminderLayer recipe. */
function popup(img, opts) {
  const x = 32;
  const width = G2_LENS_WIDTH - 64;
  const height = 128;
  const y = opts.overInterface ? 140 : ((G2_LENS_HEIGHT - SWITCHER_ROW - height) / 2) | 0;
  img.fillRect(x, y, width, height, 1);
  img.drawRect(x, y, width, height, 90);
  medium.drawText(img, x + 14, y + 10, opts.title, 200);
  const bodyLines = wrapText(medium, opts.text, width - 28);
  bodyLines.slice(0, 3).forEach((line, i) => medium.drawText(img, x + 14, y + 10 + medium.lineHeight + 4 + i * medium.lineHeight, line, 235));
  const hint = opts.hint || "Тап - ответить · Двойной - пропустить";
  small.drawText(img, x + 14, y + height - small.lineHeight - 10, hint, 150);
  return { x, y, width, height };
}

// --- PNG out (same recipe as system-card-preview) --------------------------------

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

// --- the mockups -----------------------------------------------------------------

const shots = [];
function shot(name, title, note, build) {
  const img = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  build(img);
  shots.push({ name, title, note, png: writePng(name, img) });
}

// 1. Dictation over the live interface, one line, listening.
shot(
  "01-bar-one-line",
  "Диктовка поверх интерфейса - одна строка",
  "Полоса сразу во всю ширину, прижата к низу. Пока фраза влезает в строку, высота не растёт. Подсказок нет - место под них внизу полосы зарезервировано.",
  (img) => {
    background().composeInto(img, 0, 0);
    dictationBar(img, { text: "Поставь напоминание" });
  },
);

// 2. Long phrase: the bar grew downward.
shot(
  "02-bar-grown",
  "Фраза не влезает - полоса выросла вниз",
  "Ширина та же, окно растёт вниз на каждую перенесённую строку (верх закреплён), при необходимости закрывая ряд переключателя.",
  (img) => {
    background().composeInto(img, 0, 0);
    dictationBar(img, {
      text: "Напомни мне завтра в семь вечера позвонить маме и купить билеты на Ригу, и ещё закрыть отчёт",
    });
  },
);

// 3. Dictation finished: controls appear.
shot(
  "03-bar-controls",
  "Диктовка окончена - появились подсказки",
  "Подсказки символами, как в остальном интерфейсе: ● тап - отправить, ▲▼ скролл - заново, ●● двойной тап - закрыть.",
  (img) => {
    background().composeInto(img, 0, 0);
    dictationBar(img, {
      text: "Напомни мне завтра в семь вечера позвонить маме",
      controls: true,
    });
  },
);

// 4. Auto-send grace: countdown underline.
shot(
  "04-bar-countdown",
  "Автоотправка - полоса обратного отсчёта",
  "Линия отсчёта (1.5 с) тает по нижнему краю полосы. ● отправляет сразу, ▲▼ - переговорить.",
  (img) => {
    background().composeInto(img, 0, 0);
    dictationBar(img, {
      text: "Напомни мне завтра в семь вечера позвонить маме",
      controls: true,
      countdown: 900,
    });
  },
);

// 5. Chat session, agent working: the trail holds the answer's place.
shot(
  "05-chat-working",
  "Окно диалога - агент работает",
  "Пока ответа нет, на его месте - текущее действие (Thinking, Exec...). Пойдёт текст - он печатается в этом же месте, действие уходит.",
  (img) => {
    chatWindow(img, {
      link: "connected",
      messages: [
        { role: "user", text: "Напомни мне завтра в семь вечера позвонить маме" },
      ],
      actions: "Thinking...",
    });
  },
);

// 5b. Answer arrived: the trail is gone, hints are back.
shot(
  "05b-chat-answer",
  "Окно диалога - ответ агента",
  "Ответ занял место действия. Внизу подсказка: ● продолжить, ●● выйти.",
  (img) => {
    chatWindow(img, {
      link: "connected",
      messages: [
        { role: "user", text: "Напомни мне завтра в семь вечера позвонить маме" },
        { role: "agent", text: "Готово. Завтра в 19:00 напомню позвонить маме. Ставлю в список «Личное»." },
      ],
      hint: `${G_TAP} продолжить   ${G_DOUBLE} выйти`,
    });
  },
);

// 6. Chat with a long answer streaming + scroll arrow + reopened bar.
shot(
  "06-chat-stream",
  "Диалог - ответ печатается, диктовка снова вызвана",
  "Длинный ответ не влез - стрелка обещает продолжение ниже, скроллить можно прямо во время генерации. Тап по окну снова поднял полосу диктовки.",
  (img) => {
    chatWindow(img, {
      link: "connected",
      messages: [
        { role: "user", text: "Что у меня завтра по планам?" },
        { role: "agent", text: "Завтра: в 10:00 созвон с командой, в 13:00 обед с Сергеем, к 18:00 закрыть отчёт по расходам. Между 14:00 и 17:00 окон нет - хорошее время для звонка маме." },
      ],
      newBelow: true,
    });
    dictationBar(img, { text: "Перенеси созвон" });
  },
);

// 7. Chat history after several turns.
shot(
  "07-chat-history",
  "Диалог - история накопилась",
  "Видны и команды, и ответы. Старые сообщения уходят за верхний край; при новом вызове история начинается чисто.",
  (img) => {
    chatWindow(img, {
      link: "connected",
      messages: [
        { role: "user", text: "Что у меня завтра по планам?" },
        { role: "agent", text: "Созвон в 10:00, обед в 13:00, отчёт к 18:00." },
        { role: "user", text: "Перенеси созвон на 11" },
        { role: "agent", text: "Перенёс. Осталось: созвон 11:00, обед 13:00." },
      ],
      hint: `${G_TAP} продолжить   ${G_DOUBLE} выйти`,
    });
  },
);

// 8. Notification on locked glasses: popup only, no interface.
shot(
  "08-popup-locked",
  "Уведомление на заблокированных очках",
  "Никакого интерфейса за окном - только рамка уведомления, по центру, с переходом яркости.",
  (img) => {
    popup(img, {
      title: "Напоминание",
      text: "Позвонить маме - сегодня в 19:00",
      hint: `${G_TAP} ответить   ${G_DOUBLE} пропустить`,
    });
  },
);

// 9. Notification over the live interface.
shot(
  "09-popup-over",
  "Уведомление поверх интерфейса",
  "Интерфейс остаётся видимым, окно выехало снизу-вверх и лежит поверх (позиция - как у ReminderLayer).",
  (img) => {
    background().composeInto(img, 0, 0);
    popup(img, {
      overInterface: true,
      title: "Напоминание",
      text: "Позвонить маме - сегодня в 19:00",
      hint: `${G_TAP} ответить   ${G_DOUBLE} пропустить`,
    });
  },
);

// 10. dialog_open on locked glasses: question joins the session.
shot(
  "10-dialog-question",
  "Вопрос агента на заблокированных очках",
  "dialog_open: вопрос + приглашение ответить. Тап открывает микрофон; после ответа агент продолжит в полноценном окне диалога, а не одной репликой.",
  (img) => {
    popup(img, {
      title: "OpenClaw",
      text: "Напоминание «Позвонить маме» просрочено на 2 часа. Перенести на 21:00?",
      hint: `${G_TAP} ответить голосом   ${G_DOUBLE} пропустить`,
    });
  },
);

// 11. Agent invoked on locked glasses: dictation bar alone, no interface.
shot(
  "11-bar-locked",
  "Вызов агента на заблокированных очках",
  "Интерфейс не поднимается: с переходом яркости появляется только полоса записи (тот же низ, где был бы интерфейс). После отправки - окно диалога (05).",
  (img) => {
    dictationBar(img, { text: "" });
  },
);

// 12. No link: the bar refuses to open.
shot(
  "12-bar-no-link",
  "Нет связи - ввод не начинается",
  "Полоса не открывается без связи: вместо неё короткая рамка с причиной (тот же низ интерфейса).",
  (img) => {
    background().composeInto(img, 0, 0);
    const x = ((G2_LENS_WIDTH - BAR_W) / 2) | 0;
    const y = barTop();
    img.fillRect(x, y, BAR_W, BAR_H, 1);
    img.drawRect(x, y, BAR_W, BAR_H, 90);
    drawMic(img, x + 14, y + 10, 60);
    medium.drawText(img, x + 36, y + 14, "Нет связи с OpenClaw", 255);
  },
);

// 13. Vertical position = top: the bar rides under the band, not the screen.
shot(
  "13-bar-top-layout",
  "Позиция интерфейса сверху - полоса под интерфейсом",
  "Полоса - самый нижний элемент интерфейса, а не экрана: при Display > Vertical position = top она всплывает под верхней полосой окон, а не внизу экрана.",
  (img) => {
    // the same schematic background, rendered at vpos=top
    const bt = 0;
    img.drawRect(32, bt + 4, 576, BAND_H - 8, 90);
    medium.drawText(img, 46, bt + 14, "Напоминания", 200);
    const rows = ["Купить билеты на Ригу", "Позвонить маме", "Отдать долг - 1500", "Записаться к стоматологу"];
    rows.forEach((row, i) => medium.drawText(img, 46, bt + 46 + i * 30, "· " + row, 235));
    img.drawLine(0, bt + BAND_H, G2_LENS_WIDTH, bt + BAND_H, 60);
    for (let i = 0; i < 5; i++) img.drawRect(200 + i * 56, bt + BAND_H + 8, 20, 20, 120);
    // the bar, anchored under the top-pinned interface
    const x = ((G2_LENS_WIDTH - BAR_W) / 2) | 0;
    const y = bt + BAND_H + SWITCHER_ROW - 12 - BAR_H;
    img.fillRect(x, y, BAR_W, BAR_H, 1);
    img.drawRect(x, y, BAR_W, BAR_H, 120);
    drawMic(img, x + 14, y + 10, 235);
    small.drawText(img, x + 36, y + 16, "Слушаю...", 150);
  },
);

// --- HTML sheet -------------------------------------------------------------------

const html = `<!doctype html>
<meta charset="utf-8">
<title>Ассистент - редизайн: макеты</title>
<style>
 body{background:#111;color:#ddd;font:14px system-ui,sans-serif;margin:24px}
 h1{font-size:18px} h2{font-size:15px;color:#9c9;margin-top:34px}
 .note{color:#888;max-width:780px}
 img{background:#000;border:1px solid #333;display:block;margin:8px 0}
</style>
<h1>Ассистент - редизайн: макеты (640×480, Terminus, зелёный тон панели; позиция интерфейса: ${VPOS})</h1>
<p class="note">Фон под оверлеями - схематичный стенд-ин, не реальный экран приложения. Геометрия полос и рамок - честная:
полоса диктовки - самый нижний элемент интерфейса (под полосой окон и рядом переключателя, отступ 12 px), высота 44 px и растёт вниз; рамки уведомлений -
рецепт ReminderLayer (фон 1, рамка 90, заголовок 200, текст 235, подсказка 150).</p>
${shots
  .map((s) => `<h2>${s.title}</h2>\n<p class="note">${s.note}</p>\n<img src="${s.png}" width="640" height="480">`)
  .join("\n")}
`;
fs.writeFileSync(path.join(args.out, "preview.html"), html);
console.log(`wrote ${shots.length} PNGs + preview.html to ${args.out}`);
