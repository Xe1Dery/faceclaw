const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function env() {
  const renders = { count: 0 };
  const font = (lineHeight) => ({
    lineHeight,
    measureText: (t) => t.length * 8,
    getGlyph: () => ({ dwidthX: 8 }),
  });
  class GrayImage {
    constructor(width, height, value) { this.width = width; this.height = height; this.value = value; this.ops = []; }
    fillRect(...a) { this.ops.push({ op: 'fillRect', a }); }
    drawRect(...a) { this.ops.push({ op: 'drawRect', a }); }
    drawLine(...a) { this.ops.push({ op: 'drawLine', a }); }
    drawText(_f, x, y, text, value) { this.ops.push({ op: 'text', x, y, text, value }); }
    drawTextWrapped({ text }) { this.ops.push({ op: 'text', text }); }
  }
  const load = loader({
    setTimeout(cb, ms) { return 0; },
    clearTimeout() {},
  }, {
    '../../graphics/image': { GrayImage },
    '../../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font(12), getDefaultMediumFont: () => font(16) },
    './geometry': {
      SHELL_OPAQUE_BLACK: 1,
      // The G2 with the switcher at the bottom and the global band-middle
      // display mode: a 576x288 band centred, framed, at y=96.
      appViewportRect: () => ({ x: 32, y: 96, width: 576, height: 260 }),
      interfaceBottom: () => 480,
      switcherRect: () => ({ x: 32, y: 384, width: 576, height: 36 }),
      switcherRowHeight: () => 36,
      statusBarOverlays: () => false,
      statusBarEdge: () => 'top',
      switcherPosition: () => 'bottom',
      TOP_BAR_HEIGHT: 28,
      windowFramed: () => true,
      windowTop: () => 96,
    },
    '../../assistant/bridge-client': { assistantBridge: { state: () => ({ phase: 'connected', status: '' }) } },
  });
  const mod = load('app/ui/shell/chat-session.ts');
  const actions = { requestRender: () => { renders.count += 1; } };
  function open(history = [], callbacks = {}) {
    const calls = { followUp: 0, cancel: 0, close: 0, removed: 0 };
    const layer = new mod.ChatSessionLayer(actions, {
      onFollowUp: () => { calls.followUp += 1; },
      onCancel: () => { calls.cancel += 1; },
      onClose: () => { calls.close += 1; },
      onRemoved: () => { calls.removed += 1; },
      ...callbacks,
    }, history);
    return { layer, calls };
  }
  function paint(layer) {
    const image = layer.paint({ stack: {} }, () => new GrayImage(640, 480, 0));
    return image.ops;
  }
  return { mod, actions, open, paint, renders, GrayImage };
}

const click = { type: 'click', timestampMs: 0 };
const doubleClick = { type: 'double-click', timestampMs: 0 };
const scrollUp = { type: 'scroll-up', timestampMs: 0 };
const scrollDown = { type: 'scroll-down', timestampMs: 0 };

test('a working turn shows the trail where the answer will print', () => {
  const e = env();
  const { layer } = e.open();
  layer.appendUser('напомни маме');
  layer.startTurn();
  layer.onToolActivity('ticktick.create_task');
  const ops = e.paint(layer);
  const trail = ops.find((o) => o.op === 'text' && /Exec: ticktick/.test(o.text ?? ''));
  assert.ok(trail, 'the action trail is drawn');
  assert.equal(trail.value, 130);
  // The user line is dim and prefixed.
  const user = ops.find((o) => o.text === '> напомни маме');
  assert.equal(user.value, 170);
});

test('the first answer token replaces the trail in its place', () => {
  const e = env();
  const { layer } = e.open();
  layer.appendUser('напомни маме');
  layer.startTurn();
  layer.onToolActivity('ticktick.create_task');
  layer.onTextDelta('Г', 'Готово');
  const ops = e.paint(layer);
  assert.ok(!ops.some((o) => /Exec:/.test(o.text ?? '')), 'the trail is gone');
  const answer = ops.find((o) => o.text === 'Готово');
  assert.equal(answer.value, 235);
});

test('a finished turn lands in the thread and offers the follow-up hint', () => {
  const e = env();
  const { layer } = e.open();
  layer.appendUser('напомни маме');
  layer.startTurn();
  layer.onTextDelta('ок', 'ок');
  layer.onTurnDone();
  assert.deepStrictEqual(layer.messages().map((m) => ({ role: m.role, text: m.text })), [
    { role: 'user', text: 'напомни маме' },
    { role: 'agent', text: 'ок' },
  ]);
  const hint = e.paint(layer).find((o) => /продолжить/.test(o.text ?? ''));
  assert.match(hint.text, /● продолжить\s+●● выйти/);
});

test('a click continues the thread; a double-click cancels and closes', () => {
  const e = env();
  const { layer, calls } = e.open();
  layer.appendUser('x');
  layer.startTurn();
  layer.handleInput(click); // working: a click does nothing
  assert.equal(calls.followUp, 0);
  layer.handleInput(doubleClick);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.close, 1);
});

test('scroll works during generation and the arrow marks more below', () => {
  const e = env();
  const { layer } = e.open();
  layer.appendUser('длинный запрос ' + 'слово '.repeat(120));
  layer.appendUser('ещё ' + 'много '.repeat(300));
  layer.startTurn();
  e.paint(layer); // first paint measures the content height
  layer.handleInput(scrollUp); // scroll up while the agent is still working
  const ops = e.paint(layer);
  assert.ok(ops.some((o) => o.text === '▼'), 'more content below is marked');
});

test('restoreIdle keeps the thread and follows whether a turn is live', () => {
  const e = env();
  const history = [{ role: 'user', text: 'а' }, { role: 'agent', text: 'б' }];
  const { layer } = e.open(history);
  layer.restoreIdle(false);
  const hint = e.paint(layer).find((o) => /выйти/.test(o.text ?? ''));
  assert.ok(hint, 'an idle restore shows the continue/exit hint');
  layer.restoreIdle(true);
  assert.ok(!e.paint(layer).some((o) => /выйти/.test(o.text ?? '')));
});

test('the window paints an opaque panel over its band and keeps the interface', () => {
  const e = env();
  const { layer } = e.open();
  let belowCalled = false;
  const image = layer.paint({ stack: {} }, () => { belowCalled = true; return new e.GrayImage(640, 480, 0); });
  assert.equal(belowCalled, true, 'the chrome below stays painted as its own planes');
  assert.equal(image.value, 0, 'the canvas starts transparent: the interface shows around the band');
  const panel = image.ops.find((o) => o.op === 'fillRect');
  assert.deepEqual(panel.a.slice(0, 4), [32, 96, 576, 260], 'the opaque panel covers exactly the window band');
  assert.ok(image.ops.some((o) => o.text === 'OpenClaw'));
  // Device issue 1: content stays inside the band, never at the screen edges.
  for (const o of image.ops.filter((x) => x.op === 'text')) {
    assert.ok(o.y >= 96 && o.y <= 96 + 260, `text at y=${o.y} stays in the band`);
    assert.ok(o.x >= 32 && o.x <= 32 + 576, `text at x=${o.x} stays in the band`);
  }
});

test('an error keeps the window and offers the close gesture', () => {
  const e = env();
  const { layer } = e.open();
  layer.appendUser('x');
  layer.startTurn();
  layer.onError('Мост недоступен');
  const hint = e.paint(layer).find((o) => /Мост недоступен/.test(o.text ?? ''));
  assert.ok(hint);
});
