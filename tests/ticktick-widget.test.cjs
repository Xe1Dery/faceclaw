const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function subtask(id, title, hour = null) {
  const due = hour === null ? null : new Date(2026, 10, 14, hour, 0, 0, 0).toISOString();
  return {
    id, title, dueDate: due, startDate: null, isAllDay: false,
    timeZone: 'Asia/Yekaterinburg', status: 0, sortOrder: null,
  };
}

function task(id, title, hour, day = 14, subtasks = []) {
  const due = new Date(2026, 10, day, hour, 0, 0, 0);
  return {
    id, projectId: 'project', title, dueDate: due.toISOString(), startDate: null,
    isAllDay: false, timeZone: 'Asia/Yekaterinburg', status: 0, sortOrder: null,
    subtasks, raw: {},
  };
}

function fixture() {
  const timeoutCallbacks = new Map();
  let timerId = 0;
  let fail = false;
  const calls = { list: 0 };
  const overdue = [task('old', 'Просроченная задача', 12, 13, [
    subtask('old-a', 'Первая подзадача'),
    subtask('old-b', 'Вторая подзадача'),
  ])];
  const today = [
    task('a', 'Первая задача', 8, 14, [subtask('a-1', 'Вложенная задача')]),
    task('b', 'Вторая задача', 12),
    task('c', 'Третья задача', 18),
  ];
  const font = (lineHeight) => ({
    lineHeight,
    measureText: (text) => text.length * 6,
    drawText() {},
  });
  class Image {
    constructor(width, height) { this.width = width; this.height = height; this.ops = []; }
    drawText(_font, x, y, text, value) { this.ops.push(['text', x, y, text, value]); }
    drawLine(...args) { this.ops.push(['line', ...args]); }
    drawRect(...args) { this.ops.push(['rect', ...args]); }
    fillRect(...args) { this.ops.push(['fill', ...args]); }
  }
  const mod = loader({
    setTimeout(callback, delay) {
      const id = ++timerId;
      timeoutCallbacks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timeoutCallbacks.delete(id); },
  }, {
    '../../../graphics/textwrap': {
      truncateText: (font, text, width) => {
        const max = Math.max(0, Math.floor(width / 6));
        return font.measureText(text) <= width ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
      },
    },
    '../../../integrations/ticktick-mcp': {
      async listTickTickTodayTasks() {
        calls.list += 1;
        return fail
          ? { ok: false, error: 'Нет связи' }
          : { ok: true, overdue: overdue.slice(), today: today.slice() };
      },
    },
    '../glance-font': { glanceFont: { small: () => font(12), medium: () => font(16) } },
  })('app/apps/glanceboard/widgets/ticktick-widget.ts');
  const newWidget = () => new mod.TickTickWidget();
  const paint = (widget, height = 144) => {
    const image = new Image(288, height);
    widget.paint(image);
    return image.ops;
  };
  let renders = 0;
  const widget = newWidget();
  widget.start(() => { renders += 1; });
  return {
    mod, widget, calls, paint, newWidget, timeoutCallbacks,
    renders: () => renders,
    setFail(value) { fail = value; },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('paints overdue tasks first with indented subtasks and no controls', async () => {
  const f = fixture();
  await flush();
  const single = f.paint(f.widget);
  const text = single.filter((op) => op[0] === 'text').map((op) => op[3]);
  assert.deepEqual(text.slice(0, 7), [
    'Сегодня', 'Просрочено', 'Просроченная задача', 'вчера',
    'Первая подзадача', 'Вторая подзадача', 'Сегодня',
  ]);
  assert.ok(text.includes('Первая задача'));
  const rectangles = single.filter((op) => op[0] === 'rect');
  assert.ok(rectangles.some((op) => op[3] === 10 && op[4] === 10));
  assert.ok(rectangles.some((op) => op[3] === 8 && op[4] === 8));
  assert.equal(single.some((op) => op[0] === 'fill'), false);
  assert.equal(typeof f.widget.handleInput, 'undefined');

  const tallText = f.paint(f.widget, 288).filter((op) => op[0] === 'text').map((op) => op[3]);
  assert.ok(tallText.includes('Вложенная задача'));
  assert.ok(tallText.indexOf('Первая задача') < tallText.indexOf('Вторая задача'));
  assert.equal(tallText.includes('Следующие 7 дней'), false);
  f.widget.stop();
});

test('reopening the board uses the fresh process cache without another request', async () => {
  const f = fixture();
  await flush();
  assert.equal(f.calls.list, 1);
  f.widget.stop();

  const reopened = f.newWidget();
  reopened.start(() => {});
  await flush();
  assert.equal(f.calls.list, 1);
  const text = f.paint(reopened).filter((op) => op[0] === 'text').map((op) => op[3]);
  assert.ok(text.includes('Просроченная задача'));
  assert.equal(text.includes('Загрузка...'), false);
  reopened.stop();
});

test('refreshes cached tasks after one minute and keeps old rows on a transient error', async () => {
  const f = fixture();
  await flush();
  const timer = Array.from(f.timeoutCallbacks.values())[0];
  assert.equal(timer.delay, 60_000);
  f.setFail(true);
  timer.callback();
  await flush();
  assert.equal(f.calls.list, 2);
  const text = f.paint(f.widget).filter((op) => op[0] === 'text').map((op) => op[3]);
  assert.ok(text.includes('Просроченная задача'));
  assert.equal(text.includes('Нет связи'), false);
  f.widget.stop();
});

test('stopping invalidates late list rendering while still warming the shared cache', async () => {
  let resolveList;
  const mod = loader({
    setTimeout: () => 1, clearTimeout() {},
  }, {
    '../../../graphics/textwrap': { truncateText: (_font, text) => text },
    '../../../integrations/ticktick-mcp': {
      listTickTickTodayTasks: () => new Promise((resolve) => { resolveList = resolve; }),
    },
    '../glance-font': { glanceFont: { small: () => ({ lineHeight: 12, measureText: (t) => t.length * 6 }),
      medium: () => ({ lineHeight: 16, measureText: (t) => t.length * 6 }) } },
  })('app/apps/glanceboard/widgets/ticktick-widget.ts');
  let renders = 0;
  const widget = new mod.TickTickWidget();
  widget.start(() => { renders += 1; });
  widget.stop();
  resolveList({ ok: true, overdue: [], today: [task('late', 'Опоздавшая задача', 8)] });
  await flush();
  assert.equal(renders, 0);

  const reopened = new mod.TickTickWidget();
  reopened.start(() => {});
  const image = { width: 288, height: 144, ops: [],
    drawText(_font, _x, _y, text) { this.ops.push(text); }, drawLine() {}, drawRect() {} };
  reopened.paint(image);
  assert.ok(image.ops.includes('Опоздавшая задача'));
  reopened.stop();
});
