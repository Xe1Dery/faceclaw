const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function controllerMethod(name) {
  const fileName = path.join(__dirname, '..', 'app/g2/dashboard-controller.ts');
  const source = fs.readFileSync(fileName, 'utf8');
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const controller = file.statements.find((node) =>
    ts.isClassDeclaration(node) && node.name?.text === 'DashboardController');
  return controller.members.find((node) => node.name?.getText(file) === name).getText(file);
}

test('sleep gestures reach Glanceboard in both sys-event and display-wake forms', () => {
  const context = { exports: {}, OsEventTypeList: {
    RING_LONG_PRESS_EVENT: 9,
    RING_LONG_PRESS_RELEASE_EVENT: 10,
    SHORT_THEN_LONG_PRESS_EVENT: 11,
    HEAD_UP_EVENT: 12,
  } };
  vm.runInNewContext(ts.transpileModule(
    `export class Harness { ${controllerMethod('glanceEventFor')} }`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  ).outputText, context);
  const harness = new context.exports.Harness();
  harness.glance = { eventForGesture: (gesture) => gesture };
  const route = (type, kind, eventType) => harness.glanceEventFor({ type }, { kind, eventType });

  assert.equal(route('long-press', 'sys-event', 9), 'long-press');
  assert.equal(route('unknown', 'sys-event', 12), 'head-tilt');
  assert.equal(route('display-wake', 'display-wake', 12), 'head-tilt');
  assert.equal(route('display-wake', 'display-wake', 9), 'long-press');
  assert.equal(route('display-wake', 'display-wake', 10), 'long-press-release');
  assert.equal(route('display-wake', 'display-wake', 11), 'short-then-long-press');
  assert.equal(route('display-wake', 'display-wake', 3), null, 'ordinary wake remains a normal UI wake');
});

test('Glanceboard can unblank its staged surface while the regular shell stays asleep', async () => {
  const makeHarness = () => {
    const calls = [];
    const communicator = {
      setG2ScreenOn: async () => calls.push('screen-on'),
      resumeEvenHubSession: async () => { calls.push('resume'); return true; },
      setScreenBlanked: async (blanked) => calls.push(`blanked:${blanked}`),
      awaitEvenHubSessionReady: async () => { calls.push('ready'); return true; },
    };
    const context = {
      exports: {},
      EVENHUB_WAKE_READY_TIMEOUT_MS: 5000,
      frameTimings: { spanAsync: (_frameId, _label, operation) => operation() },
      shell: { isScreenOn: () => false },
    };
    vm.runInNewContext(ts.transpileModule(
      `export class Harness { ${controllerMethod('ensureEvenHubSessionActive')} }`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
    ).outputText, context);
    const harness = new context.exports.Harness();
    Object.assign(harness, {
      communicator,
      phase: 'connected',
      previewTarget: null,
      evenHubResumePromise: null,
      evenHubSessionSuspended: true,
      standaloneWakeUnblankPending: false,
    });
    return { harness, calls };
  };

  const ordinary = makeHarness();
  assert.equal(await ordinary.harness.ensureEvenHubSessionActive(1), true);
  assert.ok(!ordinary.calls.includes('blanked:false'), 'regular asleep shell remains blanked');

  const glance = makeHarness();
  assert.equal(await glance.harness.ensureEvenHubSessionActive(2, true), true);
  assert.ok(glance.calls.includes('blanked:false'), 'Glanceboard surface is revealed after resume');

  const standalone = makeHarness();
  standalone.harness.standaloneWakeUnblankPending = true;
  assert.equal(await standalone.harness.ensureEvenHubSessionActive(3, true), true);
  assert.ok(!standalone.calls.includes('blanked:false'), 'standalone wake still owns the first unblank');
});
