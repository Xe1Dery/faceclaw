const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture() {
  const timers = new Map();
  let timerId = 0;
  const available = new Set(['tick-1']);
  const reopened = [];
  const opensNow = { value: true };
  const load = loader({
    setTimeout(callback, ms) {
      const id = ++timerId;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const { PersistentNotificationReopener } = load('app/ui/shell/persistent-notification-reopener.ts');
  const manager = new PersistentNotificationReopener({
    isAvailable: (key) => available.has(key),
    reopen: (key) => { reopened.push(key); return opensNow.value; },
  });
  function fireTimer() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
  }
  return { manager, timers, available, reopened, opensNow, fireTimer };
}

test('an unresolved notification reopens after one minute', () => {
  const f = fixture();
  f.manager.shown('tick-1', 60_000);
  f.manager.unresolved('tick-1');
  assert.equal([...f.timers.values()][0].ms, 60_000);
  f.fireTimer();
  assert.deepEqual(f.reopened, ['tick-1']);
});

test('an explicit wake reopens immediately and cancels the minute timer', () => {
  const f = fixture();
  f.manager.shown('tick-1', 60_000);
  f.manager.unresolved('tick-1');
  assert.equal(f.manager.reopenOnWake(), true);
  assert.deepEqual(f.reopened, ['tick-1']);
  assert.equal(f.timers.size, 0);
  assert.equal(f.manager.reopenOnWake(), false, 'already visible notifications do not reopen twice');
});

test('a completed or vanished Android notification never reappears', () => {
  const f = fixture();
  f.manager.shown('tick-1', 60_000);
  f.manager.unresolved('tick-1');
  f.manager.settled('tick-1');
  assert.equal(f.timers.size, 0);
  assert.equal(f.manager.reopenOnWake(), false);

  f.manager.shown('tick-1', 60_000);
  f.available.delete('tick-1');
  f.manager.unresolved('tick-1');
  assert.equal(f.timers.size, 0);
});

test('a popup queued behind another notification keeps its minute retry', () => {
  const f = fixture();
  f.manager.shown('tick-1', 60_000);
  f.manager.unresolved('tick-1');
  f.opensNow.value = false;
  f.fireTimer();
  assert.deepEqual(f.reopened, ['tick-1']);
  assert.equal(f.timers.size, 1, 'a dropped modal queue cannot lose the pending reminder');
  f.opensNow.value = true;
  f.fireTimer();
  assert.deepEqual(f.reopened, ['tick-1', 'tick-1']);
});
