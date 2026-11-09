const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// A fake clock drives the timers; a stub GrayImage records what paint drew,
// so geometry (bottom-anchored growth) and the hint/countdown rows are all
// observable without a device.
function layerEnv(opts = {}) {
  const timers = new Map();
  let timerId = 0;
  const now = { ms: 0 };
  const transcriptListeners = new Set();
  const speechEndListeners = new Set();
  const statusListeners = new Set();
  const actions = {
    requestRender() {},
    startVoiceCapture: (endpointing) => { actions.starts.push(endpointing); },
    stopVoiceCapture: () => { actions.stops += 1; },
    starts: [],
    stops: 0,
  };
  const font = (lineHeight) => ({
    lineHeight,
    measureText: (t) => t.length * 8,
    getGlyph: () => ({ dwidthX: 8 }),
  });
  const load = loader({
    setTimeout(cb, ms) { const id = ++timerId; timers.set(id, { cb, at: now.ms + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Date: { now: () => now.ms },
  }, {
    '../../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
    '../../graphics/image': { GrayImage: class {
      constructor(w, h, v) { this.width = w; this.height = h; this.value = v; this.ops = []; }
      fillRect(...a) { this.ops.push({ op: 'fillRect', a }); }
      drawRect(...a) { this.ops.push({ op: 'drawRect', a }); }
      drawLine(...a) { this.ops.push({ op: 'drawLine', a }); }
      drawText(_f, x, y, text, value) { this.ops.push({ op: 'text', x, y, text, value }); }
      drawTextWrapped({ text }) { this.ops.push({ op: 'text', text }); }
    } },
    '../../graphics/ui-fonts': {
      getDefaultSmallFont: () => font(12),
      getDefaultMediumFont: () => font(16),
    },
    './geometry': { SHELL_OPAQUE_BLACK: 1 },
    '../../native/voice-control': {
      voiceControlBridge: {
        onTranscript(listener) { transcriptListeners.add(listener); return () => transcriptListeners.delete(listener); },
        onSpeechEnd(listener) { speechEndListeners.add(listener); return () => speechEndListeners.delete(listener); },
        onStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); },
      },
    },
  });
  const mod = load('app/ui/shell/dictation-bar.ts');

  function advance(ms) {
    now.ms += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now.ms) { timers.delete(id); t.cb(); }
    }
  }
  function emitTranscript(text, isFinal) {
    for (const listener of [...transcriptListeners]) listener({ text, isFinal });
  }
  function fireSpeechEnd() {
    for (const listener of [...speechEndListeners]) listener();
  }
  function openBar(overrides = {}) {
    const done = [];
    const dismisses = { count: 0 };
    const layer = new mod.DictationBarLayer({
      actions,
      interfaceBottom: () => 402,
      dismiss: () => { dismisses.count += 1; },
      onDone: (outcome) => done.push(outcome),
      ...overrides,
    });
    return { layer, done, dismisses };
  }
  /** Paint the layer and return the recorded draw ops. */
  function paint(layer) {
    const ops = [];
    const image = {
      fillRect: (...a) => ops.push({ op: 'fillRect', a }),
      drawRect: (...a) => ops.push({ op: 'drawRect', a }),
      drawLine: (...a) => ops.push({ op: 'drawLine', a }),
      drawText: (_f, x, y, text, value) => ops.push({ op: 'text', x, y, text, value }),
      drawTextWrapped: ({ text }) => ops.push({ op: 'text', text }),
    };
    layer.paint({}, () => image);
    return ops;
  }
  return { mod, actions, advance, emitTranscript, fireSpeechEnd, openBar, paint, timers, now };
}

const click = { type: 'click', timestampMs: 0 };
const doubleClick = { type: 'double-click', timestampMs: 0 };
const scrollDown = { type: 'scroll-down', timestampMs: 0 };

test('the bar opens with the mic running hands-free', () => {
  const env = layerEnv();
  const { layer } = env.openBar();
  layer.startCapture();
  assert.deepEqual(env.actions.starts, [true]); // endpointing capture
  assert.equal(layer.isCapturing(), true);
});

test('a finalized phrase shows the glyph hints and sends on tap', () => {
  const env = layerEnv();
  const { layer, done, dismisses } = env.openBar();
  layer.startCapture();
  env.emitTranscript('позвонить маме', true);
  env.fireSpeechEnd();
  const ops = env.paint(layer);
  const hint = ops.find((o) => o.op === 'text' && /отправить/.test(o.text ?? ''));
  assert.ok(hint, 'hint row appears after finalization');
  assert.match(hint.text, /● отправить\s+▲▼ заново\s+●● закрыть/);
  layer.handleInput(click);
  assert.equal(done.length, 1);
  assert.equal(done[0].action, 'sent');
  assert.equal(done[0].text, 'позвонить маме');
  assert.equal(dismisses.count, 1);
});

test('a tap mid-dictation ends the utterance and sends the trailing final', () => {
  const env = layerEnv();
  const { layer, done } = env.openBar();
  layer.startCapture();
  env.emitTranscript('напомни', false); // partial
  layer.handleInput(click);
  assert.equal(env.actions.stops, 1);
  assert.equal(done.length, 0); // the send waits for the final
  env.emitTranscript('напомни завтра', true);
  assert.equal(done.length, 1);
  assert.equal(done[0].text, 'напомни завтра');
});

test('a tap-send with nothing heard returns to listening instead of sending', () => {
  const env = layerEnv();
  const { layer, done, dismisses } = env.openBar();
  layer.startCapture();
  layer.handleInput(click); // stop with silence
  env.advance(2_500); // finalize window elapses
  assert.equal(done.length, 0);
  assert.equal(dismisses.count, 0);
  assert.equal(env.actions.starts.length, 2); // the mic re-opened
  assert.equal(layer.isCapturing(), true);
});

test('scroll wipes the phrase and re-opens the mic', () => {
  const env = layerEnv();
  const { layer, done } = env.openBar();
  layer.startCapture();
  env.emitTranscript('не то', true);
  env.fireSpeechEnd();
  layer.handleInput(scrollDown);
  assert.equal(done.length, 0);
  assert.equal(env.actions.stops, 1);
  env.advance(0);
  assert.equal(env.actions.starts.length, 2);
  const ops = env.paint(layer);
  assert.ok(!ops.some((o) => o.op === 'text' && /отправить/.test(o.text ?? '')));
});

test('double-tap closes without sending and stops the mic', () => {
  const env = layerEnv();
  const { layer, done, dismisses } = env.openBar();
  layer.startCapture();
  env.emitTranscript('что-то', false);
  layer.handleInput(doubleClick);
  assert.equal(done.length, 1);
  assert.equal(done[0].action, 'closed');
  assert.equal(dismisses.count, 1);
  assert.equal(env.actions.stops, 1);
});

test('auto-send fires after the grace window', () => {
  const env = layerEnv();
  const { layer, done } = env.openBar({ autoSend: true });
  layer.startCapture();
  env.emitTranscript('сделано', true);
  env.fireSpeechEnd();
  assert.equal(done.length, 0); // grace is running
  env.advance(1_600);
  assert.equal(done.length, 1);
  assert.equal(done[0].action, 'sent');
});

test('a tap inside the auto-send grace sends at once', () => {
  const env = layerEnv();
  const { layer, done } = env.openBar({ autoSend: true });
  layer.startCapture();
  env.emitTranscript('сделано', true);
  env.fireSpeechEnd();
  env.advance(400);
  layer.handleInput(click);
  assert.equal(done.length, 1);
  assert.equal(done[0].action, 'sent');
});

test('the bar is bottom-anchored and grows upward as the phrase wraps', () => {
  const env = layerEnv();
  const { layer } = env.openBar();
  layer.startCapture();
  const oneLine = env.paint(layer).find((o) => o.op === 'fillRect');
  // One line: 44px tall, bottom edge exactly on the interface bottom (402).
  assert.equal(oneLine.a[1] + oneLine.a[3], 402);
  assert.equal(oneLine.a[3], 44);
  // A phrase that wraps to two lines: taller, bottom edge unchanged.
  env.emitTranscript('а'.repeat(40), true);
  env.fireSpeechEnd();
  const grown = env.paint(layer).find((o) => o.op === 'fillRect');
  assert.ok(grown.a[3] > oneLine.a[3]);
  assert.equal(grown.a[1] + grown.a[3], 402);
});

test('removal by the shell reports closed, never sent', () => {
  const env = layerEnv();
  const { layer, done } = env.openBar();
  layer.startCapture();
  env.emitTranscript('фраза', true);
  layer.onRemoved();
  assert.equal(done.length, 1);
  assert.equal(done[0].action, 'closed');
  assert.equal(env.actions.stops, 1);
});

test('the no-link refusal dismisses itself after three seconds', () => {
  const env = layerEnv();
  const dismisses = { count: 0 };
  const layer = new env.mod.DictationRefusalLayer(
    env.actions,
    () => 402,
    () => { dismisses.count += 1; },
  );
  env.advance(2_900);
  assert.equal(dismisses.count, 0);
  env.advance(200);
  assert.equal(dismisses.count, 1);
});

test('the no-link refusal paints the reason line at the interface bottom', () => {
  const env = layerEnv();
  const layer = new env.mod.DictationRefusalLayer(env.actions, () => 402, () => {});
  const ops = env.paint(layer);
  const frame = ops.find((o) => o.op === 'fillRect');
  assert.equal(frame.a[1] + frame.a[3], 402);
  const text = ops.find((o) => o.op === 'text');
  assert.equal(text.text, 'Нет связи с OpenClaw');
});

test('the locked-glasses bar paints standalone on the screen bottom', () => {
  const env = layerEnv();
  const { layer } = env.openBar({ standalone: true });
  layer.startCapture();
  let belowAsked = false;
  const image = layer.paint({}, () => { belowAsked = true; return null; });
  assert.equal(belowAsked, false, 'the interface stays down behind the bar');
  assert.equal(image.value, 1, 'the canvas starts opaque black');
  const frame = image.ops.find((o) => o.op === 'fillRect');
  assert.equal(frame.a[1] + frame.a[3], 480, 'anchored to the screen bottom, no band to ride');
});

test('the locked-glasses no-link refusal paints standalone too', () => {
  const env = layerEnv();
  const layer = new env.mod.DictationRefusalLayer(env.actions, () => 402, () => {}, undefined, true);
  let belowAsked = false;
  const image = layer.paint({}, () => { belowAsked = true; return null; });
  assert.equal(belowAsked, false);
  const frame = image.ops.find((o) => o.op === 'fillRect');
  assert.equal(frame.a[1] + frame.a[3], 480);
});
