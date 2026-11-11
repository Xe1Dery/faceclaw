const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadDefinition() {
  const settings = {
    glanceboardEnabledSetting: { get: () => true },
    glanceDepth: () => 0,
    glanceLayout: () => ({ width: 576, height: 288 }),
    glanceShowOnHeadTiltSetting: { get: () => true },
    glanceShowOnLongPressSetting: { get: () => true },
    glanceShowOnTap: () => true,
    glanceTapTimeoutMs: () => 3000,
  };
  const liveFactory = () => {};
  const settingsFactory = () => {};
  const dependencies = {
    './board': { GlanceBoard: class {} },
    './glanceboard-app': {
      createGlanceboardAppWindow: settingsFactory,
      createPinnedGlanceboardWindow: liveFactory,
      GLANCEBOARD_SURFACE_ID: 'window:glanceboard',
      GLANCEBOARD_WINDOW_ID: 'glanceboard',
      PINNED_GLANCEBOARD_SURFACE_ID: 'window:glanceboard-view',
      PINNED_GLANCEBOARD_WINDOW_ID: 'glanceboard-view',
    },
    './glanceboard-settings': settings,
  };
  const context = {
    exports: {},
    require: (name) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
  };
  const fileName = path.join(__dirname, '..', 'app/apps/glanceboard/index.ts');
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(fileName, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return { definition: context.exports.default, liveFactory, settingsFactory };
}

test('boot pins the live board while Launcher opens the separate settings app', async () => {
  const { definition, liveFactory, settingsFactory } = loadDefinition();
  const backgroundCalls = [];
  const launchCalls = [];
  const ctx = {
    openInProcessAppInBackground: (...args) => backgroundCalls.push(args),
    launchInProcessApp: (...args) => {
      launchCalls.push(args);
      return Promise.resolve();
    },
  };

  definition.boot(ctx);
  assert.deepEqual(backgroundCalls[0], [
    'glanceboard-view',
    'window:glanceboard-view',
    liveFactory,
  ]);

  await definition.launch(ctx);
  assert.deepEqual(launchCalls[0], [
    'glanceboard',
    'window:glanceboard',
    settingsFactory,
  ]);
  assert.notEqual(backgroundCalls[0][2], launchCalls[0][2]);
});
