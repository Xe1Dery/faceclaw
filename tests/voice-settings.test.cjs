const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

function settings(store) {
  const context = { exports: {}, global: { isIOS: false }, require: id => {
    if (id.includes('settings-store')) return {
      onSettingsStoreChanged() {}, getStringSetting: (k, d) => store.get(k) ?? d,
      setStringSetting: (k, v) => store.set(k, v),
      getBooleanSetting: (k, d) => store.get(k) ?? d, setBooleanSetting: (k, v) => store.set(k, v),
    };
    if (id.includes('brightness-curve')) return require('../.test-build/app/g2/brightness-curve.js');
    if (id.includes('animation-speed')) return require('../.test-build/app/ui/animation-speed.js');
    return { Layer: class {}, ASSISTANT_MODEL_CHOICES: [] };
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/dashboard-settings.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

test('WS defaults and legacy explicit ports survive; transport and language persist', () => {
  const store = new Map([['assistant.bridgePort', '8790']]);
  let api = settings(store);
  assert.equal(api.assistantBridgeTransportSetting.get(), 'ws');
  assert.equal(api.assistantBridgePortSetting.get(), '8790');
  api.assistantBridgeTransportSetting.set('wss');
  api.voiceProviderSetting.set('onboard-whisper-multilingual');
  api.onboardWhisperLanguageSetting.set('ru');
  api = settings(store);
  assert.equal(api.assistantBridgeTransportSetting.get(), 'wss');
  assert.equal(api.assistantBridgePortSetting.get(), '8790');
  assert.equal(api.voiceProviderSetting.get(), 'onboard-whisper-multilingual');
  assert.equal(api.onboardWhisperLanguageSetting.get(), 'ru');
  api.onboardWhisperLanguageSetting.set('auto');
  assert.equal(settings(store).onboardWhisperLanguageSetting.get(), 'auto');
  api.voiceProviderSetting.set('onboard-zipformer-ru');
  assert.equal(settings(store).voiceProviderSetting.get(), 'onboard-zipformer-ru');
  api.assistantBridgePortSetting.set('');
  assert.equal(api.assistantBridgePortSetting.displayValue(), '443 (automatic)');
});
