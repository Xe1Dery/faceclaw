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
    './geometry': { minWindowTop: () => 40 },
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
  return { mod, actions, advance, emitTranscript, fireSpeechEnd, timers };
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

test('empty capture after the finalize window is no answer', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  layer.handleInput(click); // stop with nothing heard
  env.advance(2500); // finalize window elapses
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
  env.advance(2_500); // finalize window elapses
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'expired');
});

test('an unrecognized answer re-asks once instead of settling', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  env.emitTranscript('ыыы тфыы', true); // classifier: other
  assert.equal(outcomes.length, 0); // not settled: the layer re-asked
  layer.handleInput(click); // tap during the re-ask restarts capture
  env.emitTranscript('сделано', true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'done');
});

test('a second unrecognized answer settles as other carrying both transcripts', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env);
  layer.handleInput(click);
  env.emitTranscript('ыыы', true);
  env.advance(3_000); // re-ask window lapses, popup re-arms
  layer.handleInput(click);
  env.emitTranscript('ффыу', true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'other');
  assert.match(outcomes[0].text, /ыыы/);
  assert.match(outcomes[0].text, /ффыу/);
});

test('re-ask then silence is no answer: the re-armed popup expires on ttl', () => {
  const env = layerEnv();
  const { layer, outcomes } = openReminder(env, { ttlMs: 30_000 });
  layer.handleInput(click);
  env.emitTranscript('непонятно что', true);
  env.advance(3_000); // re-ask lapses, TTL re-armed
  env.advance(31_000); // full ttl passes with no second attempt
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'expired');
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
