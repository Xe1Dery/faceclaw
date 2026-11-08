const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function toolsEnv() {
  const calls = [];
  const cancels = [];
  let nextOutcome = { action: 'done' };
  let showPromise = null;
  const shellMock = {
    showReminder(request) {
      calls.push(request);
      showPromise = Promise.resolve(nextOutcome);
      return showPromise;
    },
    cancelReminder(id) {
      cancels.push(id);
      return id === 'open-1';
    },
  };
  const load = loader({}, {
    '../ui/shell/shell': { shell: shellMock },
  });
  const registry = new (load('app/assistant/tool-registry.ts').ToolRegistry)();
  load('app/assistant/reminder-tools.ts').registerReminderTools(registry);
  return { registry, calls, cancels, setOutcome(o) { nextOutcome = o; } };
}

test('reminder tools register as proactive system tools', () => {
  const { registry } = toolsEnv();
  const specs = registry.listTools({ proactiveOnly: true }).map((s) => s.name);
  assert.ok(specs.includes('glasses.reminder_show'));
  assert.ok(specs.includes('glasses.reminder_cancel'));
});

test('reminder_show validates its arguments', async () => {
  const { registry, calls } = toolsEnv();
  assert.equal((await registry.callTool('glasses.reminder_show', {})).ok, false);
  assert.equal((await registry.callTool('glasses.reminder_show', { reminder_id: ' ', text: 'x' })).ok, false);
  assert.equal((await registry.callTool('glasses.reminder_show', { reminder_id: 'r1', text: '  ' })).ok, false);
  assert.equal(calls.length, 0);
});

test('reminder_show returns the structured outcome as JSON and clamps ttl', async () => {
  const { registry, calls, setOutcome } = toolsEnv();
  setOutcome({ action: 'snooze', minutes: 10, text: 'через 10 минут' });
  const result = await registry.callTool('glasses.reminder_show', {
    reminder_id: 'r-7', task_id: 't-3', text: 'Позвонить клиенту', ttl_ms: 999_999,
  });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.content);
  assert.equal(payload.reminderId, 'r-7');
  assert.equal(payload.taskId, 't-3');
  assert.equal(payload.action, 'snooze');
  assert.equal(payload.minutes, 10);
  assert.equal(payload.text, 'через 10 минут');
  assert.equal(typeof payload.respondedAtMs, 'number');
  // ttl clamped to the tool's maximum.
  assert.equal(calls[0].ttlMs, 180_000);
  assert.equal(calls[0].reminderId, 'r-7');
});

test('reminder_show defaults ttl and drops blank task ids', async () => {
  const { registry, calls } = toolsEnv();
  await registry.callTool('glasses.reminder_show', { reminder_id: 'r1', text: 'x', task_id: '   ' });
  assert.equal(calls[0].ttlMs, 60_000);
  assert.equal(calls[0].taskId, undefined);
});

test('no-answer outcomes pass through unchanged', async () => {
  const { registry, setOutcome } = toolsEnv();
  setOutcome({ action: 'expired' });
  const result = await registry.callTool('glasses.reminder_show', { reminder_id: 'r1', text: 'x' });
  const payload = JSON.parse(result.content);
  assert.equal(payload.action, 'expired');
  assert.equal('minutes' in payload, false);
  assert.equal('text' in payload, false);
});

test('reminder_cancel reports unknown ids as tool errors', async () => {
  const { registry, cancels } = toolsEnv();
  assert.equal((await registry.callTool('glasses.reminder_cancel', {})).ok, false);
  const miss = await registry.callTool('glasses.reminder_cancel', { reminder_id: 'nope' });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /nope/);
  const hit = await registry.callTool('glasses.reminder_cancel', { reminder_id: 'open-1' });
  assert.equal(hit.ok, true);
  assert.deepEqual(cancels, ['nope', 'open-1']);
});

test('reminder_show carries a timeout long enough for the maximum popup ttl', () => {
  const { registry } = toolsEnv();
  const spec = registry.listTools().find((s) => s.name === 'glasses.reminder_show');
  assert.ok(spec.timeoutMs >= 180_000 + 30_000);
});
