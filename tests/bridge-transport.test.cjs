const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const endpoint = loader()('app/assistant/bridge-endpoint.ts');
test('bridge endpoints preserve WS and explicit ports; WSS defaults to 443', () => {
  assert.equal(endpoint.bridgeUrl('100.64.0.1'), 'ws://100.64.0.1:8790');
  assert.equal(endpoint.bridgeUrl('agent.example.com', 'wss'), 'wss://agent.example.com:443');
  assert.equal(endpoint.bridgeUrl('agent.example.com', 'wss', '9443'), 'wss://agent.example.com:9443');
  assert.equal(endpoint.bridgeUrl('[::1]', 'ws', 8790), 'ws://[::1]:8790');
  for (const host of ['wss://host', 'user:token@host', 'host/?token=secret', 'host#secret', 'host:443']) {
    assert.throws(() => endpoint.bridgeUrl(host, 'wss'));
  }
  for (const port of ['443oops', '0', '-1', '65536', '4.2']) assert.throws(() => endpoint.bridgeUrl('host', 'wss', port));
});

function clientEnv() {
  const sockets = [], timers = new Map(); let timerId = 0;
  const load = loader({
    setTimeout(cb) { const id = ++timerId; timers.set(id, cb); return id; },
    clearTimeout(id) { timers.delete(id); },
    com: { faceclaw: { app: {
      FaceclawWebSocketListener: function (callbacks) { return callbacks; },
      FaceclawWebSocket: class {
        constructor(url, listener) { this.url = url; this.listener = listener; this.sent = []; sockets.push(this); }
        sendText(text) { this.sent.push(JSON.parse(text)); }
        close() {}
      },
    } } },
  }, {
    './mcp-server': { AssistantMcpServer: class {} },
    './tool-registry': { toolRegistry: { onToolsChanged: () => () => {} } },
  });
  return { client: new (load('app/assistant/bridge-client.ts').AssistantBridgeClient)(), sockets,
    reconnect() { for (const [id, cb] of [...timers]) { timers.delete(id); cb(); } } };
}

test('TLS failures reconnect only over WSS; authentication never enters URL or status', () => {
  const { client, sockets, reconnect } = clientEnv();
  client.configure({ host: 'agent.example.com', transport: 'wss', token: 'secret-token', deviceName: 'test', allowProactive: () => true });
  const first = sockets[0];
  first.listener.onOpen();
  assert.equal(first.sent[0].token, 'secret-token');
  assert.ok(!first.url.includes('secret-token'));
  first.listener.onFailure('SSLHandshakeException secret-token');
  assert.match(client.state().status, /TLS certificate/);
  assert.ok(!client.state().status.includes('secret-token'));
  reconnect();
  assert.equal(sockets[1].url, 'wss://agent.example.com:443');
  first.listener.onClosed(1006, 'old connection');
  sockets[1].listener.onOpen();
  sockets[1].listener.onTextMessage(JSON.stringify({ chan: 'ctl', type: 'hello-ack' }));
  assert.equal(client.state().phase, 'connected');
  client.stop();
});

test('reconfiguration ignores callbacks from the previous socket', () => {
  const { client, sockets } = clientEnv();
  const options = { host: 'host', token: 'token', deviceName: 'test', allowProactive: () => true };
  client.configure(options);
  client.configure({ ...options, transport: 'wss' });
  sockets[0].listener.onFailure('old failure');
  sockets[0].listener.onOpen();
  assert.equal(sockets[1].sent.length, 0);
  sockets[1].listener.onOpen();
  assert.equal(sockets[1].sent.length, 1);
  client.stop();
});
