const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture({
  standalone = false, profileId = 'ticktick', actionSucceeds = true, snoozeSucceeds = true,
  assistantSucceeds = true, assistantFailure = null, replySucceeds = true, dismissSucceeds = true,
  notificationOverrides = {},
} = {}) {
  let timerId = 0;
  const timers = new Map();
  class Image {
    constructor(width = 640, height = 480, value = 0) {
      this.width = width; this.height = height; this.value = value; this.ops = [];
    }
    fillRect(...args) { this.ops.push(['fillRect', ...args]); }
    drawRect(...args) { this.ops.push(['drawRect', ...args]); }
    drawLine(...args) { this.ops.push(['drawLine', ...args]); }
    drawImage(...args) { this.ops.push(['drawImage', ...args]); }
    drawText(...args) { this.ops.push(['drawText', ...args]); }
    drawTextWrapped(args) { this.ops.push(['drawTextWrapped', args]); }
  }
  const actions = { renders: 0, requestRender() { this.renders += 1; } };
  const telegram = profileId === 'telegram';
  const notification = {
    key: 'n1', packageName: telegram ? 'org.telegram.messenger' : 'com.ticktick.task',
    appName: telegram ? 'Telegram' : 'TickTick',
    title: telegram ? 'Алексей' : 'Позвонить маме',
    text: telegram ? 'Ты сегодня будешь?' : 'сегодня в 19:00', bigText: '', subText: '',
    infoText: '', summaryText: '', category: 'reminder', lines: [], postTime: 1,
    when: 1, actions: telegram ? [
      { index: 1, title: 'Прочитано', enabled: true, semanticAction: 2 },
      { index: 2, title: 'Ответить', enabled: true, semanticAction: 1, hasRemoteInput: true },
    ] : [{ index: 3, title: 'Выполнить', enabled: true }],
    ...notificationOverrides,
  };
  const calls = { actions: [], replies: [], dismissals: [], snoozes: [], close: 0, closes: [], removed: [], assistant: [], voice: null };
  const host = {
    currentNotification: () => notification,
    sourceIcon: telegram ? new Image(16, 16) : null,
    displayBounds: () => ({ top: 78, height: 288 }),
    invokeAction: (key, index) => { calls.actions.push([key, index]); return actionSucceeds; },
    invokeReply: (key, index, text) => { calls.replies.push([key, index, text]); return replySucceeds; },
    dismissNotification: (key) => { calls.dismissals.push(key); return dismissSucceeds; },
    snoozeNotification: (key, durationMs) => {
      calls.snoozes.push([key, durationMs]);
      return snoozeSucceeds;
    },
    openVoice: (onSubmit, onClosed) => { calls.voice = { onSubmit, onClosed }; return true; },
    assistantFailure: () => assistantFailure,
    sendToAssistant: (message) => { calls.assistant.push(message); return assistantSucceeds; },
    close: (keepScreenOn = false) => { calls.close += 1; calls.closes.push(keepScreenOn); },
    removed: (unresolved) => { calls.removed.push(unresolved); },
  };
  const load = loader({
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, {
    '../../graphics/image': { GrayImage: Image },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => ({
      lineHeight: 12,
      ascent: 10,
      measureText: (text) => text.length * 6,
      getGlyph: () => ({ dwidthX: 6, bbxHeight: 10, bbxY: 0 }),
    }) },
    './geometry': { minWindowTop: () => 78, screenHeight: () => 480, screenWidth: () => 640, SHELL_OPAQUE_BLACK: 1 },
    './popup-slide': { startSlideIn: (_actions, update) => { update(0); return () => {}; } },
  });
  const { CustomNotificationLayer } = load('app/ui/shell/custom-notification-layer.ts');
  const profiles = load('app/ui/custom-notifications.ts');
  const profile = telegram ? profiles.telegramNotificationProfile : profiles.tickTickNotificationProfile;
  const layer = new CustomNotificationLayer(profile, notification, actions, host, standalone);
  return { layer, actions, calls, timers, Image };
}

const event = (type) => ({ type, timestampMs: 1, source: 'ring' });

test('one tap invokes TickTick native Done and closes the overlay', () => {
  const f = fixture();
  f.layer.handleInput(event('click'));
  assert.deepEqual(f.calls.actions, [['n1', 3]]);
  assert.equal(f.calls.close, 1);
  assert.deepEqual(f.calls.snoozes, []);
});

test('double tap snoozes the Android notification for five minutes', () => {
  const f = fixture();
  f.layer.handleInput(event('double-click'));
  assert.deepEqual(f.calls.snoozes, [['n1', 5 * 60_000]]);
  assert.deepEqual(f.calls.dismissals, []);
  assert.equal(f.calls.close, 1);
});

test('a long press opens TickTick dictation and executes simple speech locally', async () => {
  const f = fixture();
  f.layer.handleInput(event('long-press'));
  assert.ok(f.calls.voice);
  const result = await f.calls.voice.onSubmit('Отложи на 10 минут');
  assert.equal(result.accepted, true);
  result.afterDismiss();
  assert.deepEqual(f.calls.snoozes, [['n1', 10 * 60_000]]);
  assert.deepEqual(f.calls.dismissals, []);
  assert.deepEqual(f.calls.assistant, []);
  assert.equal(f.calls.close, 1);
});

test('complex speech closes the notification and starts a normal Nano chat', () => {
  const f = fixture();
  f.layer.handleInput(event('long-press'));
  const result = f.calls.voice.onSubmit('перенеси на вечер');
  assert.equal(result.accepted, true);
  result.afterDismiss();
  assert.equal(f.calls.close, 1);
  assert.deepEqual(f.calls.closes, [true]);
  assert.deepEqual(f.calls.assistant, ['По задаче TickTick «Позвонить маме»: перенеси на вечер']);
  assert.deepEqual(f.calls.snoozes, []);
});

test('a failed native snooze clears its error after three seconds', () => {
  const f = fixture({ snoozeSucceeds: false });
  f.layer.handleInput(event('double-click'));
  assert.equal(f.calls.close, 0);
  assert.deepEqual(f.calls.dismissals, []);
  const image = f.layer.paint({}, () => new f.Image());
  assert.ok(image.ops.some((op) => op[0] === 'drawText' && op[4] === 'Не удалось отложить уведомление'));
  const timer = Array.from(f.timers.values())[0];
  assert.equal(timer.delay, 3_000);
  timer.callback();
  const restored = f.layer.paint({}, () => new f.Image());
  assert.ok(restored.ops.some((op) => op[0] === 'drawText' && /готово/.test(op[4] ?? '')));
});

test('a snooze error does not block another notification action', () => {
  const f = fixture({ snoozeSucceeds: false });
  f.layer.handleInput(event('double-click'));
  f.layer.handleInput(event('click'));
  assert.deepEqual(f.calls.actions, [['n1', 3]]);
  assert.equal(f.calls.close, 1);
  assert.equal(f.timers.size, 0);
});

test('a failed spoken snooze is returned to the dictation bar for its three-second error', () => {
  const f = fixture({ snoozeSucceeds: false });
  f.layer.handleInput(event('long-press'));
  const result = f.calls.voice.onSubmit('Отложи на 10 минут');
  assert.equal(result.accepted, false);
  assert.equal(result.error, 'Не удалось отложить уведомление');
  assert.equal(f.calls.close, 0);
});

test('unavailable Nano rejects submission while keeping the notification pending', () => {
  const f = fixture({ assistantFailure: 'Нет связи с OpenClaw' });
  f.layer.handleInput(event('long-press'));
  const result = f.calls.voice.onSubmit('перенеси на вечер');
  assert.equal(result.accepted, false);
  assert.equal(result.error, 'Нет связи с OpenClaw');
  assert.equal(f.calls.close, 0);
  f.calls.voice.onClosed();
  const image = f.layer.paint({}, () => new f.Image());
  const text = image.ops.filter(([op]) => op === 'drawText').map((op) => op[4]);
  assert.ok(text.includes('● готово   ●● +5 мин   — голос'));
});

test('dictation hides only the notification controls and restores them when closed', () => {
  const f = fixture();
  const before = f.layer.paint({}, () => new f.Image());
  const beforeFrame = before.ops.find(([op]) => op === 'fillRect');
  f.layer.handleInput(event('long-press'));
  const during = f.layer.paint({}, () => new f.Image());
  const duringFrame = during.ops.find(([op]) => op === 'fillRect');
  assert.deepEqual(duringFrame, beforeFrame, 'the notification frame keeps its exact size');
  assert.ok(!during.ops.some((op) => op[0] === 'drawText' && /готово/.test(op[4] ?? '')));
  f.calls.voice.onClosed();
  const after = f.layer.paint({}, () => new f.Image());
  assert.ok(after.ops.some((op) => op[0] === 'drawText' && /готово/.test(op[4] ?? '')));
});

test('Telegram tap-then-hold marks read and double-tap closes only the glasses popup', () => {
  const read = fixture({ profileId: 'telegram' });
  assert.equal(read.layer.claimsLongPress, true);
  assert.equal(read.layer.claimsShortThenLongPress, true);
  read.layer.handleInput(event('short-then-long-press'));
  assert.deepEqual(read.calls.actions, [['n1', 1]]);
  assert.equal(read.calls.close, 1);

  const closed = fixture({ profileId: 'telegram' });
  closed.layer.handleInput(event('double-click'));
  assert.deepEqual(closed.calls.dismissals, [], 'the Android notification remains in the phone shade');
  assert.equal(closed.calls.close, 1);
});

test('Telegram title draws the source notification icon before the sender', () => {
  const f = fixture({ profileId: 'telegram' });
  const image = f.layer.paint({}, () => new f.Image());
  const icon = image.ops.find(([op]) => op === 'drawImage');
  assert.ok(icon, 'the Android notification source icon is drawn');
  assert.equal(icon[1].width, 16);
  const sender = image.ops.find((op) => op[0] === 'drawText' && op[4] === 'Алексей');
  assert.ok(sender);
  assert.ok(sender[2] > icon[2] + icon[1].width, 'sender starts after the icon');
});

test('Telegram long-press submits recognized text through RemoteInput', () => {
  const f = fixture({ profileId: 'telegram' });
  f.layer.handleInput(event('long-press'));
  const result = f.calls.voice.onSubmit('Да, буду');
  assert.equal(result.accepted, true);
  assert.deepEqual(f.calls.replies, [['n1', 2, 'Да, буду']]);
  result.afterDismiss();
  assert.equal(f.calls.close, 1);
});

test('scroll moves only long Telegram text and never starts TickTick voice', () => {
  const ticktick = fixture();
  ticktick.layer.handleInput(event('scroll-down'));
  assert.equal(ticktick.calls.voice, null);

  const telegram = fixture({
    profileId: 'telegram',
    notificationOverrides: { text: 'длинное сообщение '.repeat(120) },
  });
  const before = telegram.layer.paint({}, () => new telegram.Image());
  const frame = before.ops.find(([op]) => op === 'fillRect');
  assert.ok(frame[4] <= 288, 'the frame is capped by the selected Display mode');
  assert.ok(before.ops.some((op) => op[0] === 'drawLine' && op[1] === 32 && op[3] === 608),
    'Telegram title divider reaches both frame edges');
  const beforeBody = before.ops.filter((op) => op[0] === 'drawText').map((op) => op[4]);
  telegram.layer.handleInput(event('scroll-down'));
  assert.equal(telegram.calls.voice, null);
  const after = telegram.layer.paint({}, () => new telegram.Image());
  const afterBody = after.ops.filter((op) => op[0] === 'drawText').map((op) => op[4]);
  assert.notDeepEqual(afterBody, beforeBody);
});

test('short Telegram notifications shrink within the selected Display mode', () => {
  const f = fixture({ profileId: 'telegram' });
  const image = f.layer.paint({}, () => new f.Image());
  const frame = image.ops.find(([op]) => op === 'fillRect');
  assert.ok(frame[4] < 128);
  assert.ok(frame[2] >= 78 && frame[2] + frame[4] <= 78 + 288);
});

test('failed Telegram reply stays in dictation until the bar reports its error', () => {
  const f = fixture({ profileId: 'telegram', replySucceeds: false });
  f.layer.handleInput(event('long-press'));
  const result = f.calls.voice.onSubmit('Ответ');
  assert.equal(result.accepted, false);
  assert.equal(result.error, 'Не удалось отправить ответ');
  assert.equal(f.calls.close, 0);
});

test('a failed native action stays visible and reports the failure without calling Nano', () => {
  const f = fixture({ actionSucceeds: false });
  f.layer.handleInput(event('click'));
  assert.equal(f.calls.close, 0);
  assert.deepEqual(f.calls.assistant, []);
  assert.ok(f.actions.renders > 0);
});

test('standalone TickTick presentation paints only the confirmed compact frame', () => {
  const f = fixture({ standalone: true });
  let askedBelow = false;
  const image = f.layer.paint({}, () => { askedBelow = true; return new f.Image(); });
  assert.equal(askedBelow, false);
  assert.equal(image.value, 1);
  const text = image.ops.filter(([op]) => op === 'drawText').map((op) => op[4]);
  assert.deepEqual(text, ['TickTick', '● готово   ●● +5 мин   — голос']);
  const body = image.ops.find(([op]) => op === 'drawTextWrapped')[1];
  assert.equal(body.text, 'Позвонить маме - сегодня в 19:00');
});

test('removal callback is idempotent', () => {
  const f = fixture();
  f.layer.onRemoved();
  f.layer.onRemoved();
  assert.deepEqual(f.calls.removed, [true]);
});

test('a successful terminal action marks removal as settled', () => {
  const f = fixture();
  f.layer.handleInput(event('click'));
  f.layer.onRemoved();
  assert.deepEqual(f.calls.removed, [false]);
});
