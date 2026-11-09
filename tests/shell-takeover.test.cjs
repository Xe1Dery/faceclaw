const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const graphics = require('../.test-build/app/graphics/image.js');
const planes = require('../.test-build/app/graphics/plane.js');
const shellScene = require('../.test-build/app/graphics/shell-scene.js');

function load(file, modules) {
  const context = { exports: {}, require: (name) => { assert.ok(name in modules, name); return modules[name]; } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return context.exports;
}

const noopLayerActions = {};
const { LayerStack } = load('app/ui/layers.ts', {
  '../graphics/image': graphics, '../graphics/plane': planes,
  '../native/frame-timings': { spanCurrent: (_name, fn) => fn() },
  '../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
  './gestures': {},
});

// The shell's own stack follows the live screen size (no fixed base size);
// only its paints go through encodeShellScene.
function shellStack() {
  const base = new graphics.GrayImage(640, 480, 0);
  return new LayerStack({ paint: () => base }, noopLayerActions);
}

// A takeover layer: an opaque full-screen canvas of its own, no paintBelow.
function takeover(dimUnderneath) {
  const canvas = new graphics.GrayImage(640, 480, 1);
  return { paint: () => canvas, handleInput: () => {}, ...(dimUnderneath === undefined ? {} : { dimUnderneath }) };
}

test('a takeover canvas reaches the shell scene encoder as strips, not one oversized plane', () => {
  // The regression this guards: a full-screen opaque plane (640×480) is
  // 153,605 bytes once packed, so encodeShellScene threw inside paint, the
  // controller logged "shell render failed", and the screen froze on the
  // last frame. Unit tests that only checked the layer's own canvas passed
  // while the device showed nothing; this one runs the real scene path.
  const stack = shellStack();
  stack.push(takeover());
  const parts = stack.paintUndimmed();
  assert.equal(parts.length, 3, 'the 480-row canvas goes up as three 160-row strips');
  assert.deepEqual(parts.map((p) => [p.x, p.y, p.image.width, p.image.height]),
    [[0, 0, 640, 160], [0, 160, 640, 160], [0, 320, 640, 160]]);
  assert.equal(new Set(parts.map((p) => p.shellKey)).size, 3, 'the scene requires a unique key per plane');
  shellScene.encodeShellScene(parts); // must not throw
});

test('takeover strips keep the scene budget at every width the glasses pair with', () => {
  for (const width of [540, 640]) {
    const canvas = new graphics.GrayImage(width, 480, 1);
    const parts = planes.splitPlaneRows({ image: canvas, x: 0, y: 0, shellKey: 9 });
    assert.ok(parts.length > 1, `${width} wide splits`);
    for (const part of parts) {
      assert.ok(5 + Math.ceil(part.image.width / 2) * part.image.height <= 65536,
        `${width}: strip ${part.image.width}×${part.image.height} encodes`);
    }
  }
});

test('a takeover canvas at most one strip tall stays one plane', () => {
  // Sparse overlays and window stacks paint full-size canvases whose content
  // fits the budget; splitting them would only churn the resource keys.
  const canvas = new graphics.GrayImage(640, 160, 1);
  const parts = planes.splitPlaneRows({ image: canvas, x: 0, y: 0, shellKey: 9 });
  assert.equal(parts.length, 1);
});

test('a takeover dim rides on the first strip alone', () => {
  // The firmware applies one brightness LUT per plane; strips of one canvas
  // must dim what lies below them once, not once per strip.
  const stack = shellStack();
  stack.push(takeover(0.5));
  const parts = stack.paintUndimmed();
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.dimUnderneath), [0.5, 1, 1]);
});

test('takeover strip keys are stable across repaints', () => {
  const stack = shellStack();
  stack.push(takeover());
  const first = stack.paintUndimmed().map((p) => p.shellKey);
  const second = stack.paintUndimmed().map((p) => p.shellKey);
  assert.deepEqual(first, second);
});

test('a window stack takeover plane is not split (window frames have no 64 KiB budget)', () => {
  const base = new graphics.GrayImage(576, 260, 0);
  const stack = new LayerStack({ paint: () => base }, noopLayerActions, { width: 576, height: 260 });
  const canvas = new graphics.GrayImage(576, 260, 1);
  stack.push({ paint: () => canvas, handleInput: () => {} });
  const parts = stack.paint();
  assert.equal(parts.length, 1);
  assert.equal(parts[0].image.height, 260);
});

// Standalone cooling (APK 824, device issue 2) hinges on this one answer:
// is the top stacked layer a standalone overlay? The shell asks it on every
// render to decide whether to hide the window surfaces underneath.
test('standaloneTop answers only for a standalone layer on the stack top', () => {
  const stack = shellStack();
  assert.equal(stack.standaloneTop(), false, 'empty stack');
  stack.push({ paint: () => {}, handleInput: () => {}, standalone: true });
  assert.equal(stack.standaloneTop(), true, 'standalone on top');
  stack.push({ paint: () => {}, handleInput: () => {} });
  assert.equal(stack.standaloneTop(), false, 'plain layer covers it');
  stack.pop();
  assert.equal(stack.standaloneTop(), true, 'covered again once the plain layer pops');
  stack.pop();
  assert.equal(stack.standaloneTop(), false, 'back to empty');
});
