const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function layerEnv() {
  const timers = new Map();
  let timerId = 0;
  const now = { ms: 0 };
  const transcriptListeners = new Set();
  const speechEndListeners = new Set();
  const actions = {
    requestRender() {},
    startVoiceCapture: (endpointing) => { actions.starts.push(endpointing); },
    stopVoiceCapture: () => { actions.stops += 1; },
    starts: [],
    stops: 0,
  };
  const load = loader({
    setTimeout(cb, ms) { const id = ++timerId; timers.set(id, { cb, at: now.ms + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, {
    '../../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => ({ lineHeight: 12, ascent: 9 }) },
    '../../graphics/image': { GrayImage: class { constructor(w, h, v) { this.width = w; this.height = h; this.value = v; this.ops = []; }
      fillRect(...a) { this.ops.push({ op: 'fillRect', a }); } drawRect(...a) { this.ops.push({ op: 'drawRect', a }); }
      drawLine() {} drawText() {} drawTextWrapped() {} } },
    './geometry': { minWindowTop: () => 40, screenHeight: () => 480, screenWidth: () => 640, SHELL_OPAQUE_BLACK: 1 },
    '../../native/voice-control': {
      voiceControlBridge: {
        onTranscript(listener) { transcriptListeners.add(listener); return () => transcriptListeners.delete(listener); },
        onSpeechEnd(listener) { speechEndListeners.add(listener); return () => speechEndListeners.delete(listener); },
      },
    },
  });
  const mod = load('app/ui/shell/reminder-layer.ts');

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
  /** Paint and return the recorded ops (a fresh stub canvas per call). */
  function paint(layer) {
    const image = { ops: [], fillRect(...a) { this.ops.push({ op: 'fillRect', a }); },
      drawRect(...a) { this.ops.push({ op: 'drawRect', a }); }, drawLine() {}, drawText() {}, drawTextWrapped() {} };
    layer.paint({}, () => image);
    return image.ops;
  }
  /** Paint a standalone frame: paintBelow must never be asked. */
  function paintStandalone(layer) {
    let belowAsked = false;
    const image = layer.paint({}, () => { belowAsked = true; return null; });
    return { image, belowAsked };
  }
  return { mod, actions, advance, emitTranscript, fireSpeechEnd, timers, paint, paintStandalone };
}

function openReminder(env, overrides = {}) {
  const outcomes = [];
  const dismisses = { count: 0 };
  const layer = new env.mod.ReminderLayer(
    { reminderId: 'r1', text: 'Позвонить клиенту', ttlMs: 60_000, ...overrides },
    env.actions,
    () => false,
    () => { dismisses.count += 1; },
    (outcome) => outcomes.push(outcome),
  );
  return { layer, outcomes, dismisses };
}

const click = { type: 'click', timestampMs: 0 };
const doubleClick = { type: 'double-click', timestampMs: 0 };

test('the popup opens silent: no microphone until a tap', () => {
  const env = layerEnv();
  const { layer } = openReminder(env);
  assert.deepEqual(env.actions.starts, []);
  assert.equal(layer.isCapturing(), false);
});

test('a tap starts capture and a final transcript resolves the classified answer', () => {
  const env = layerEnv();
  const { layer, outcomes, dismisses } = openReminder(env);
  layer.handleInput(click);
  assert.deepEqual(env.actions.starts, [true]); // endpointing capture
  assert.equal(layer.isCapturing(), true);
  env.emitTranscript('сделано', true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'done');
  assert.equal(outcomes[0].text, 'сделано');
  assert.equal(dismisses.count, 1);
});

test('a done answer closes at once: no held confirmation frame', () => {
  // A frame held after "done" reads as a second notification for the same
  // task (2026-11-09 wearer report), so the window vanishing is the confirm.
  const env = layerEnv();
  const { layer, dismisses } = openReminder(env);
  layer.handleInput(click);
  env.emitTranscript('сделано', true);
  assert.equal(dismisses.count, 1); // closed on the spot, not after CONFIRM_MS
});

test('a snooze answer keeps the confirmation frame before closing', () => {
  const env = layerEnv();
  const { layer, outcomes, dismisses } = openReminder(env);
  layer.handleInput(click);
  env.emitTranscript('через 10 минут', true);
  assert.equal(outcomes[0].action, 'snooze');
  assert.equal(dismisses.count, 0); // the frame shows what was understood
  env.advance(1300); // CONFIRM_MS elapses
  assert.equal(dismisses.count, 1);
});

test('a tap that ends the utterance classifies the trailing final', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  env.emitTranscript('через 10 минут', false); // partial
  layer.handleInput(click); // tap to finish
  assert.equal(env.actions.stops, 1);
  env.emitTranscript('через 10 минут', true); // final trails the stop
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'snooze');
  assert.equal(outcomes[0].minutes, 10);
});

test('endpointing ends the capture without a tap', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  env.emitTranscript('не сейчас', true);
  env.fireSpeechEnd();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'snooze');
  assert.equal(outcomes[0].minutes, 0);
});

test('empty recognition re-arms the popup instead of closing it', () => {
  // Truly nothing heard: the wearer meant to answer, so offer another try.
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  layer.handleInput(click); // stop with nothing heard
  env.advance(2500); // finalize window elapses: empty transcript
  assert.equal(outcomes.length, 0); // not an answer, not a close: a re-ask
  layer.handleInput(click); // the note invites a second attempt
  env.emitTranscript('сделано', true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'done');
});

test('an empty-recognition note that lapses leaves the popup on its ttl', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env, { ttlMs: 30_000 });
  layer.handleInput(click);
  layer.handleInput(click);
  env.advance(2500); // empty: the note shows, then lapses and re-arms
  env.advance(2_500); // the note lapses, the popup re-arms on its 30s ttl
  env.advance(31_000); // the re-armed ttl passes with no second attempt
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'expired');
});

test('double-tap while waiting dismisses without touching the mic', () => {
  const env = layerEnv();
  const { layer, outcomes, dismisses } = openReminder(env);
  layer.handleInput(doubleClick);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'dismissed');
  assert.equal(dismisses.count, 1);
  assert.deepEqual(env.actions.starts, []);
});

test('an unanswered popup expires at its ttl', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env, { ttlMs: 30_000 });
  env.advance(31_000);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'expired');
  layer.handleInput(click); // dead popup swallows input
  assert.equal(outcomes.length, 1);
});

test('removal by the shell settles as expired, never as done', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.onRemoved();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'expired');
});

test('cancel resolves once as cancelled and repeats are ignored', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.cancel();
  layer.cancel();
  layer.handleInput(click);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'cancelled');
});

test('a busy mic refuses the tap without starting capture', () => {
  const env = layerEnv();
  const outcomes = [];
  const layer = new env.mod.ReminderLayer(
    { reminderId: 'r1', text: 'x', ttlMs: 60_000 },
    env.actions,
    () => true,
    () => {},
    (outcome) => outcomes.push(outcome),
  );
  layer.handleInput(click);
  assert.deepEqual(env.actions.starts, []);
  assert.equal(outcomes.length, 0); // still open, waiting
});

test('the hard capture cap ends a runaway capture', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  env.advance(31_000); // hard cap fires; no transcript ever arrives
  env.advance(2_500); // finalize window elapses on an empty transcript
  assert.equal(outcomes.length, 0); // nothing heard: a re-ask, not an answer
  env.advance(3_000); // the note lapses, the popup re-arms on its 60s ttl
  env.advance(61_000); // the re-armed ttl passes untouched
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'expired');
});

test('an unrecognized phrase settles at once as other with the raw text', () => {
  // The classifier missing the words is not a mishearing: the phrase goes to
  // the courier on the first attempt, verbatim, for it to interpret.
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  env.emitTranscript('перенеси на вечер', true); // classifier: other
  assert.equal(outcomes.length, 1); // no re-ask phase, no second attempt
  assert.equal(outcomes[0].action, 'other');
  assert.equal(outcomes[0].text, 'перенеси на вечер');
});

test('garbled output still ships on the first attempt, never held for repeats', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  env.emitTranscript('ыыы тфыы', true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'other');
  assert.equal(outcomes[0].text, 'ыыы тфыы');
});

test('free-text popups return any answer verbatim as other, no re-ask', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env, { freeText: true, text: 'Просрочено 2: 1. А 2. Б' });
  layer.handleInput(click);
  env.emitTranscript('первую сделал вторую на вечер', true);
  assert.equal(outcomes.length, 1); // settled at once: nothing to classify or re-ask
  assert.equal(outcomes[0].action, 'other');
  assert.equal(outcomes[0].text, 'первую сделал вторую на вечер');
});

/** A popup wired to answer through the shared dictation bar (spec 4). */
function openDelegated(env, delegate, overrides = {}) {
  const outcomes = [];
  const dismisses = { count: 0 };
  const layer = new env.mod.ReminderLayer(
    { reminderId: 'r1', text: 'Позвонить клиенту', ttlMs: 60_000, ...overrides },
    env.actions,
    () => false,
    () => { dismisses.count += 1; },
    (outcome) => outcomes.push(outcome),
    delegate,
  );
  return { layer, outcomes, dismisses };
}

test('a tap hands the answer to the dictation bar; the popup never touches its own mic', () => {
  const env = layerEnv();
  let onDone = null;
  const { layer, outcomes } = openDelegated(env, (cb) => { onDone = cb; return true; });
  layer.handleInput(click);
  assert.ok(onDone, 'the bar was asked to open');
  assert.deepEqual(env.actions.starts, []); // the popup's own capture path stayed shut
  onDone('сделано');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'done');
});

test('a bar closed without sending re-arms the popup for another tap', () => {
  const env = layerEnv();
  let opens = 0;
  let onDone = null;
  const { layer, outcomes } = openDelegated(env, (cb) => { opens += 1; onDone = cb; return true; });
  layer.handleInput(click);
  onDone(null); // closed without sending
  assert.equal(outcomes.length, 0);
  layer.handleInput(click);
  assert.equal(opens, 2); // the tap re-opened the bar
  onDone('через 10 минут');
  assert.equal(outcomes[0].action, 'snooze');
  assert.equal(outcomes[0].minutes, 10);
});

test('a refused bar keeps the popup open with a busy note', () => {
  const env = layerEnv();
  const { layer, outcomes } = openDelegated(env, () => false);
  layer.handleInput(click);
  assert.equal(outcomes.length, 0); // still open, waiting
  assert.deepEqual(env.actions.starts, []);
});

test('an unlocked popup slides up from the screen bottom to its rest place', () => {
  const env = layerEnv();
  const { layer } = openReminder(env);
  const start = env.paint(layer).find((o) => o.op === 'fillRect');
  // Slide-in start: the frame hangs at the screen's bottom edge (480-128).
  assert.equal(start.a[1], 480 - 128);
  for (let i = 0; i < 8; i++) env.advance(30); // the slide settles within 180ms
  const rest = env.paint(layer).find((o) => o.op === 'fillRect');
  assert.equal(rest.a[1], 40 + 80); // minWindowTop + 80, the classic rest place
});

test('a locked-glasses popup paints standalone at its Display-mode position', () => {
  const env = layerEnv();
  const outcomes = [];
  const layer = new env.mod.ReminderLayer(
    { reminderId: 'r1', text: 'Позвонить маме', ttlMs: 60_000 },
    env.actions,
    () => false,
    () => {},
    (outcome) => outcomes.push(outcome),
    undefined,
    { standalone: true },
  );
  const { image, belowAsked } = env.paintStandalone(layer);
  assert.equal(belowAsked, false, 'paintBelow is never asked: the interface stays down');
  assert.equal(image.value, 1, 'the canvas starts opaque black');
  const frame = image.ops.find((o) => o.op === 'fillRect');
  assert.equal(frame.a[1], 40 + 80, 'same rest position as the unlocked frame');
});
