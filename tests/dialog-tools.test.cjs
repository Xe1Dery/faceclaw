const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function toolsEnv() {
  const calls = [];
  let nextOutcome = { action: 'answered', text: 'первую сделал' };
  const shellMock = {
    showProactiveDialog(request) {
      calls.push(request);
      return Promise.resolve(nextOutcome);
    },
  };
  const load = loader({}, {
    '../ui/shell/shell': { shell: shellMock },
  });
  const registry = new (load('app/assistant/tool-registry.ts').ToolRegistry)();
  load('app/assistant/dialog-tools.ts').registerDialogTools(registry);
  return { registry, calls, setOutcome(o) { nextOutcome = o; }, setShell(fn) { shellMock.showProactiveDialog = fn; } };
}

test('dialog_open registers as a proactive system tool', () => {
  const { registry } = toolsEnv();
  const specs = registry.listTools({ proactiveOnly: true }).map((s) => s.name);
  assert.ok(specs.includes('glasses.dialog_open'));
});

test('dialog_open requires non-empty text', async () => {
  const { registry, calls } = toolsEnv();
  assert.equal((await registry.callTool('glasses.dialog_open', {})).ok, false);
  assert.equal((await registry.callTool('glasses.dialog_open', { text: '   ' })).ok, false);
  assert.equal(calls.length, 0);
});

test('dialog_open returns the outcome as JSON and clamps ttl', async () => {
  const { registry, calls, setOutcome } = toolsEnv();
  setOutcome({ action: 'answered', text: 'обе на вечер' });
  const result = await registry.callTool('glasses.dialog_open', { text: 'Что сделать с задачами?', ttl_ms: 999_999 });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.content);
  assert.equal(payload.action, 'answered');
  assert.equal(payload.text, 'обе на вечер');
  assert.equal(typeof payload.respondedAtMs, 'number');
  assert.equal(calls[0].ttlMs, 180_000); // clamped to the tool maximum
});

test('dismissed and no-answer outcomes pass through without text', async () => {
  const { registry, setOutcome } = toolsEnv();
  setOutcome({ action: 'dismissed' });
  const dismissed = JSON.parse((await registry.callTool('glasses.dialog_open', { text: 'x' })).content);
  assert.equal(dismissed.action, 'dismissed');
  assert.equal('text' in dismissed, false);
  setOutcome({ action: 'no-answer' });
  const silent = JSON.parse((await registry.callTool('glasses.dialog_open', { text: 'x' })).content);
  assert.equal(silent.action, 'no-answer');
});

test('a refused dialog returns an error naming the alert fallback', async () => {
  const { registry, setShell } = toolsEnv();
  setShell(() => null); // the shell could not open a turn
  const result = await registry.callTool('glasses.dialog_open', { text: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /show_alert/);
});
