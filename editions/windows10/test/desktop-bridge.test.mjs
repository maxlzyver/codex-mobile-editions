import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopBridge } from '../lib/desktop-bridge.mjs';

const tools = ['read_thread', 'list_threads', 'wait_threads', 'create_thread', 'send_message_to_thread']
  .map(name => ({ name, namespace: 'codex_app', inputSchema: { type: 'object' } }));
const content = text => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(text) }] });
const frame = value => {
  const body = Buffer.from(JSON.stringify(value));
  const packet = Buffer.alloc(body.length + 4);
  packet.writeUInt32LE(body.length); body.copy(packet, 4);
  return packet;
};

async function fixture(t, handler, options = {}) {
  // A unique mock-only named pipe ensures no test contacts the installed app.
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-browser-use-${randomUUID()}`
    : path.join(os.tmpdir(), `codex-mobile-test-${randomUUID()}.sock`);
  const sockets = new Set();
  const requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32LE(0) + 4) {
        const length = pending.readUInt32LE(0);
        const message = JSON.parse(pending.subarray(4, length + 4));
        pending = pending.subarray(length + 4);
        requests.push(message);
        if (message.method === 'tools/list') socket.write(frame({ jsonrpc: '2.0', id: message.id, result: { tools } }));
        else handler(message, socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  const bridge = new DesktopBridge({ pipePath: pipe, callerThreadId: 'real-caller-chat', requestTimeoutMs: 500, ...options });
  bridge.candidatePipes = async () => [pipe];
  t.after(async () => {
    await bridge.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await bridge.connect();
  return { bridge, requests };
}

test('reads split length prefixes and fragmented UTF-8 JSON responses', async t => {
  const { bridge } = await fixture(t, (message, socket) => {
    const packet = frame({ jsonrpc: '2.0', id: message.id, result: content({ value: '中文同步结果' }) });
    socket.write(packet.subarray(0, 2));
    setImmediate(() => { socket.write(packet.subarray(2, 17)); setImmediate(() => socket.write(packet.subarray(17))); });
  });
  const result = await bridge.callReadOnly('read_thread', { threadId: 'target-chat' });
  assert.equal(JSON.parse(result.contentItems[0].text).value, '中文同步结果');
  assert.equal(bridge.pending.size, 0);
});

test('correlates coalesced replies arriving in reverse request order', async t => {
  const received = [];
  const { bridge } = await fixture(t, (message, socket) => {
    received.push(message);
    if (received.length === 2) socket.write(Buffer.concat(received.reverse().map(item => frame({ jsonrpc: '2.0', id: item.id, result: content({ tool: item.params.tool }) }))));
  });
  const results = await Promise.all([bridge.callReadOnly('list_threads', {}), bridge.callReadOnly('read_thread', { threadId: 'target-chat' })]);
  assert.deepEqual(results.map(result => JSON.parse(result.contentItems[0].text).tool), ['list_threads', 'read_thread']);
  assert.equal(bridge.pending.size, 0);
});

test('rejects oversized frames and releases waiting readers', async t => {
  const { bridge } = await fixture(t, (message, socket) => {
    const header = Buffer.alloc(4); header.writeUInt32LE(8 * 1024 * 1024 + 1); socket.write(header);
  });
  await assert.rejects(bridge.callReadOnly('list_threads'), /超出范围/);
  assert.equal(bridge.state.connected, false);
  assert.equal(bridge.pending.size, 0);
});

test('rejects malformed JSON without retaining a connected state', async t => {
  const { bridge } = await fixture(t, (message, socket) => {
    const bad = Buffer.from('{invalid json');
    const header = Buffer.alloc(4); header.writeUInt32LE(bad.length); socket.write(Buffer.concat([header, bad]));
  });
  await assert.rejects(bridge.callReadOnly('list_threads'), /无效数据/);
  assert.equal(bridge.state.connected, false);
});

test('times out ignored requests and removes the pending entry', async t => {
  const { bridge } = await fixture(t, () => {}, { requestTimeoutMs: 35 });
  await assert.rejects(bridge.callReadOnly('list_threads'), /超时/);
  assert.equal(bridge.pending.size, 0);
});

test('unsupported tools and writes without explicit local opt-in never reach the pipe', async t => {
  const { bridge, requests } = await fixture(t, () => { throw new Error('No tool call was expected.'); });
  await assert.rejects(bridge.call('turn/interrupt'), /允许列表/);
  await assert.rejects(bridge.call('send_message_to_thread', { threadId: 'target-chat', prompt: 'mock' }), /仅允许读取/);
  await assert.rejects(bridge.callReadOnly('create_thread', {}), /仅允许读取/);
  assert.equal(requests.filter(request => request.method === 'tools/call').length, 0);
});

test('explicit write opt-in keeps the caller, target and model selection separate', async t => {
  const { bridge, requests } = await fixture(t, (message, socket) => {
    socket.write(frame({ jsonrpc: '2.0', id: message.id, result: content({ threadId: message.params.arguments.threadId }) }));
  }, { allowWrites: true });
  await bridge.call('send_message_to_thread', { threadId: 'target-chat', hostId: 'local', prompt: 'Only a mock server receives this.', model: 'test-model', thinking: 'high' });
  const message = requests.find(request => request.method === 'tools/call');
  assert.equal(message.params.threadId, 'real-caller-chat');
  assert.equal(message.params.arguments.threadId, 'target-chat');
  assert.equal(message.params.arguments.model, 'test-model');
  assert.equal(message.params.arguments.thinking, 'high');
  assert.equal(message.params.hostId, 'local');
  assert.equal(message.params.callerSource, 'codex');
  assert.match(message.params.turnId, /^mcp-turn-/);
  assert.equal(message.params.namespace, 'codex_app');
});

test('read metadata uses the explicit genuine caller and does not infer identity from its target', async t => {
  const { bridge, requests } = await fixture(t, (message, socket) => {
    socket.write(frame({ jsonrpc: '2.0', id: message.id, result: content({}) }));
  });
  bridge.options.callerThreadId = null;
  await assert.rejects(bridge.callReadOnly('read_thread', { threadId: 'target-chat' }), /真实的调用方聊天编号/);
  await bridge.callReadOnly('read_thread', { threadId: 'target-chat' }, { callerThreadId: 'chosen-caller-chat', turnId: 'provided-turn-id' });
  const message = requests.find(request => request.method === 'tools/call');
  assert.equal(message.params.threadId, 'chosen-caller-chat');
  assert.equal(message.params.arguments.threadId, 'target-chat');
  assert.equal(message.params.turnId, 'provided-turn-id');
});

test('host-rejected capabilities remain a failed tool result, not a fabricated success', async t => {
  const { bridge } = await fixture(t, (message, socket) => {
    socket.write(frame({ jsonrpc: '2.0', id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'The requested thread is not accessible.' }] } }));
  });
  const result = await bridge.callReadOnly('read_thread', { threadId: 'target-chat' });
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /not accessible/);
});
