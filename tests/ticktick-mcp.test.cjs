const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function response(body, { status = 200, session = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    header: (name) => name.toLowerCase() === 'mcp-session-id' ? session : null,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function rpcResult(result, sse = false) {
  const json = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
  return sse ? `event: message\ndata: ${json}\n\n` : json;
}

function loadModule(token = 'secret-token') {
  return loader({}, {
    '../ui/dashboard-settings': { tickTickApiTokenSetting: { get: () => token } },
    '../util/http': { fetchTextWithUserAgent: async () => { throw new Error('unexpected default request'); } },
  })('app/integrations/ticktick-mcp.ts');
}

test('the MCP client initializes once, carries the session id, and preserves Today order', async () => {
  const mod = loadModule();
  const calls = [];
  const replies = [
    response(rpcResult({ protocolVersion: '2025-06-18' }), { session: 'session-1' }),
    response('', { status: 202 }),
    response(rpcResult({ content: [{ type: 'text', text: [
      JSON.stringify({ id: 'b', projectId: 'p', title: 'Вторая', dueDate: '2026-11-13T10:00:00+0000', status: 0,
        items: [
          { id: 'open', title: 'Открытая подзадача', status: 0, sortOrder: 2 },
          { id: 'done', title: 'Готовая подзадача', status: 1, sortOrder: 1 },
        ] }),
      JSON.stringify({ id: 'a', projectId: 'p', title: 'Первая', dueDate: '2026-11-13T09:00:00+0000', status: 0 }),
    ].join('\n') }] }, true)),
  ];
  const request = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length > 1) assert.equal(init.headers['mcp-session-id'], 'session-1');
    return replies.shift();
  };
  const client = new mod.TickTickMcpClient('secret-token', request);
  const tasks = await client.listTasks('today');
  assert.deepEqual(Array.from(tasks, (task) => task.id), ['b', 'a']);
  assert.deepEqual(Array.from(tasks[0].subtasks, (item) => item.title), ['Открытая подзадача']);
  assert.deepEqual(calls.map((call) => call.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.deepEqual(calls[2].params, {
    name: 'list_undone_tasks_by_time_query', arguments: { query_command: 'today' },
  });
});

test('Today with overdue includes old open tasks and keeps Today order', async () => {
  const mod = loadModule();
  const calls = [];
  const replies = [
    response(rpcResult({}), { session: 's' }),
    response('', { status: 202 }),
    response(rpcResult({ content: [{ type: 'text', text: [
      JSON.stringify({ id: 'today-b', projectId: 'p', title: 'Сегодня вторая', dueDate: '2026-11-14T14:00:00+0000', status: 0 }),
      JSON.stringify({ id: 'today-a', projectId: 'p', title: 'Сегодня первая', dueDate: '2026-11-14T10:00:00+0000', status: 0 }),
    ].join('\n') }] })),
    response(rpcResult({ content: [{ type: 'text', text: [
      JSON.stringify({ id: 'old', projectId: 'p', title: 'Давняя', dueDate: '2026-10-01T10:00:00+0000', status: 0 }),
      JSON.stringify({ id: 'yesterday', projectId: 'p', title: 'Вчерашняя', dueDate: '2026-11-13T10:00:00+0000', status: 0 }),
      JSON.stringify({ id: 'today-a', projectId: 'p', title: 'Сегодня первая', dueDate: '2026-11-14T10:00:00+0000', status: 0 }),
    ].join('\n') }] })),
  ];
  const request = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return replies.shift();
  };
  const client = new mod.TickTickMcpClient('secret-token', request);
  const result = await client.listTodayWithOverdue(Date.parse('2026-11-14T12:00:00Z'));
  assert.deepEqual(Array.from(result.overdue, (task) => task.id), ['old', 'yesterday']);
  assert.deepEqual(Array.from(result.today, (task) => task.id), ['today-b', 'today-a']);
  const tools = calls.filter((call) => call.method === 'tools/call');
  assert.deepEqual(tools.map((call) => call.params.name), ['list_undone_tasks_by_time_query', 'filter_tasks']);
  assert.deepEqual(tools[1].params.arguments, { filter: { status: [0] } });
});

test('reschedule sends update_task and preserves the original duration', async () => {
  const mod = loadModule();
  const calls = [];
  const request = async (_url, init) => {
    const call = JSON.parse(init.body);
    calls.push(call);
    if (call.method === 'initialize') return response(rpcResult({}), { session: 's' });
    if (call.method === 'notifications/initialized') return response('', { status: 202 });
    return response(rpcResult({ content: [{ type: 'text', text: '{"ok":true}' }] }));
  };
  const client = new mod.TickTickMcpClient('secret-token', request);
  await client.reschedule({
    id: 'task-1', projectId: 'project-1', title: 'Созвон',
    startDate: '2026-11-13T09:00:00+0000', dueDate: '2026-11-13T10:00:00+0000',
    isAllDay: false, timeZone: 'Asia/Yekaterinburg', status: 0, sortOrder: 1, raw: {},
  }, Date.parse('2026-11-13T12:00:00Z'));
  const update = calls.find((call) => call.method === 'tools/call');
  assert.equal(update.params.name, 'update_task');
  assert.deepEqual(update.params.arguments.task, {
    id: 'task-1', projectId: 'project-1', title: 'Созвон',
    dueDate: '2026-11-13T12:00:00+0000', isAllDay: false,
    timeZone: 'Asia/Yekaterinburg', startDate: '2026-11-13T11:00:00+0000',
  });
});

test('complete uses the project-scoped complete_task tool', async () => {
  const mod = loadModule();
  const calls = [];
  const request = async (_url, init) => {
    const call = JSON.parse(init.body);
    calls.push(call);
    if (call.method === 'initialize') return response(rpcResult({}), { session: 's' });
    if (call.method === 'notifications/initialized') return response('', { status: 202 });
    return response(rpcResult({ content: [] }));
  };
  const client = new mod.TickTickMcpClient('secret-token', request);
  await client.complete({
    id: 'task-1', projectId: 'project-1', title: 'Готово', dueDate: null, startDate: null,
    isAllDay: false, timeZone: null, status: 0, sortOrder: null, raw: {},
  });
  const complete = calls.find((call) => call.method === 'tools/call');
  assert.equal(complete.params.name, 'complete_task');
  assert.deepEqual(complete.params.arguments, { project_id: 'project-1', task_id: 'task-1' });
});

test('duplicate notification titles select the due time closest to the Android occurrence', () => {
  const mod = loadModule();
  const task = (id, dueDate) => ({
    id, projectId: 'p', title: 'Купить молоко', dueDate, startDate: null,
    isAllDay: false, timeZone: null, status: 0, sortOrder: null, raw: {},
  });
  const selected = mod.selectNotificationTask([
    task('morning', '2026-11-13T06:00:00+0000'),
    task('evening', '2026-11-13T16:00:00+0000'),
  ], '  купить   МОЛОКО ', Date.parse('2026-11-13T15:55:00Z'));
  assert.equal(selected.id, 'evening');
});

test('a missing account token fails before any network request', async () => {
  const mod = loadModule('');
  const result = await mod.rescheduleTickTickNotification({ when: 0, postTime: 0 }, 'Задача', 5, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Задайте токен TickTick в Settings > API Keys');
});
