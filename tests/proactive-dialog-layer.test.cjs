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
  const mod = load('app/ui/shell/proactive-dialog-layer.ts');

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

function openDialog(env, overrides = {}) {
  const outcomes = [];
  const dismisses = { count: 0 };
  const layer = new env.mod.ProactiveDialogLayer(
    { text: 'Есть задачи без времени — что с ними?', ttlMs: 45_000, ...overrides },
    env.actions,
    () => false,
    () => { dismisses.count += 1; },
    (outcome) => outcomes.push(outcome),
  );
  return { layer, outcomes, dismisses };
}

const click = { type: 'click', timestampMs: 0 };
const doubleClick = { type: 'double-click', timestampMs: 0 };

test('the dialog opens silent: no microphone until a tap', () => {
  const env = layerEnv();
  openDialog(env);
  assert.deepEqual(env.actions.starts, []);
});

test('a tap opens the mic and a final transcript settles as answered', () => {
  const env = layerEnv();
  const { layer, outcomes, dismisses } = openDialog(env);
  layer.handleInput(click);
  assert.deepEqual(env.actions.starts, [true]); // endpointing capture on the tap
  env.emitTranscript('первую сделал, вторую на вечер', true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'answered');
  assert.equal(outcomes[0].text, 'первую сделал, вторую на вечер');
  assert.equal(dismisses.count, 1);
});

test('endpointing ends the capture and the trailing final still settles', () => {
  const env = layerEnv();
  const { layer, outcomes } = openDialog(env);
  layer.handleInput(click);
  env.emitTranscript('сделаю вечером', false); // partial only
  env.fireSpeechEnd(); // the speaker stopped
  assert.equal(env.actions.stops, 1);
  env.emitTranscript('сделаю вечером', true); // the final trails the stop
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'answered');
  assert.equal(outcomes[0].text, 'сделаю вечером');
});

test('a tap ends the capture; the trailing final settles the answer', () => {
  const env = layerEnv();
  const { layer, outcomes } = openDialog(env);
  layer.handleInput(click); // open the mic
  env.emitTranscript('отмени первую', false);
  layer.handleInput(click); // a second tap cuts the silence wait short
  env.emitTranscript('отмени первую', true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'answered');
  assert.equal(outcomes[0].text, 'отмени первую');
});

test('silence until the ttl is a no-answer, not an answer', () => {
  const env = layerEnv();
  const { layer, outcomes, dismisses } = openDialog(env, { ttlMs: 30_000 });
  env.advance(31_000); // never tapped
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'no-answer');
  assert.equal(dismisses.count, 1);
  layer.handleInput(click); // a dead dialog swallows input
  assert.equal(outcomes.length, 1);
});

test('a tapped capture into silence settles no-answer on the hard cap', () => {
  const env = layerEnv();
  const { layer, outcomes } = openDialog(env);
  layer.handleInput(click); // open the mic, then say nothing
  env.advance(31_000); // the capture hard cap ends it
  env.advance(2500); // the finalize window elapses
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'no-answer');
});

test('a double-tap dismisses without an answer', () => {
  const env = layerEnv();
  const { layer, outcomes, dismisses } = openDialog(env);
  layer.handleInput(doubleClick); // from the waiting phase: skip
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'dismissed');
  assert.equal(dismisses.count, 1);
});

test('removal by the shell settles as no-answer', () => {
  const env = layerEnv();
  const { layer, outcomes } = openDialog(env);
  layer.onRemoved();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'no-answer');
});

test('the hard capture cap ends a runaway capture', () => {
  const env = layerEnv();
  const { layer, outcomes } = openDialog(env);
  layer.handleInput(click); // the tap opens the mic and arms the hard cap
  env.advance(31_000); // the hard cap fires; no transcript ever arrives
  env.advance(2_500); // the finalize window elapses
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'no-answer');
});

test('a busy mic refuses the tap and the dialog still times out', () => {
  const env = layerEnv();
  const outcomes = [];
  const layer = new env.mod.ProactiveDialogLayer(
    { text: 'x', ttlMs: 30_000 },
    env.actions,
    () => true, // the mic stays busy
    () => {},
    (outcome) => outcomes.push(outcome),
  );
  layer.handleInput(click); // the tap is refused with a hint, not an answer
  assert.deepEqual(env.actions.starts, []); // no mic started over a busy mic
  env.advance(31_000); // the waiting ttl still closes the turn
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].action, 'no-answer');
});
