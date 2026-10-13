import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createConsole } from '../server.mjs';

const result = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
class MockBridge extends EventEmitter {
  constructor(cwd) { super(); this.cwd = cwd; this.state = { connected: true }; }
  async start() { return this.state; }
  async close() { this.state.connected = false; }
  async request(method) {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/list') return { data: [{ id: 'codex-chat', cwd: this.cwd, name: 'Saved Codex', status: { type: 'idle' }, turns: [] }, { id: 'older-codex-chat', projectId: 'real-project', cwd: this.cwd, name: 'Older project chat outside native recent window', status: { type: 'idle' }, turns: [] }, { id: 'unknown-membership', cwd: this.cwd, name: 'Same path does not prove project membership', status: { type: 'idle' }, turns: [] }], nextCursor: null };
    if (method === 'thread/read') return { thread: { id: 'codex-chat', cwd: this.cwd, name: 'Saved Codex', status: { type: 'idle' }, turns: [] } };
    if (method === 'model/list') return { data: [{ id: 'mock-picker', model: 'mock-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] };
    throw Error(`Unexpected mock RPC: ${method}`);
  }
  reply() { throw Error('No approvals in this fixture'); }
  replyError() {}
}
class MockDesktop extends EventEmitter {
  constructor(cwd) {
    super(); this.cwd = cwd; this.state = { connected: true }; this.options = { allowWrites: true, hostId: 'local', callerThreadId: 'real-codex-caller' }; this.calls = []; this.gptStatus = 'idle'; this.intercept = null;
    this.tools = ['list_projects', 'list_threads', 'read_thread', 'send_message_to_thread', 'create_thread'].map(name => ({ name, namespace: 'codex_app', inputSchema: { properties: name === 'create_thread' ? { target: { anyOf: [{ properties: { type: { enum: ['project'] } } }] }, model: {}, thinking: { enum: ['high'] } } : name === 'send_message_to_thread' ? { model: {}, thinking: { enum: ['high'] } } : {} } }));
  }
  async connect() { return this.state; }
  async listTools() { return this.tools; }
  async close() { this.state.connected = false; this.emit('state', this.state); }
  async callReadOnly(tool, args, context) {
    this.calls.push({ tool, args, context, write: false });
    if (this.intercept) await this.intercept(tool, args);
    if (tool === 'list_projects') return result({ projects: [{ projectId: 'real-project', projectKind: 'local', hostId: 'local', label: '真实项目', path: this.cwd }, { projectId: 'gpt-project', projectKind: 'chatgpt', label: 'GPT project' }] });
    if (tool === 'list_threads') return result({ pinnedThreads: [], threads: [{ id: 'codex-chat', kind: 'codex', hostId: 'local', projectId: 'real-project', title: 'Native Codex', cwd: this.cwd, status: 'idle' }, { id: 'gpt-chat', kind: 'chatgpt', projectId: 'gpt-project', title: 'Native GPT', status: this.gptStatus }], sections: [] });
    if (tool === 'read_thread') return result({ thread: { id: args.threadId, kind: args.threadId === 'gpt-chat' ? 'chatgpt' : 'codex', ...(args.threadId === 'gpt-chat' ? {} : { hostId: 'local' }), title: 'Native conversation', cwd: this.cwd, status: { type: args.threadId === 'gpt-chat' ? this.gptStatus : 'idle' } }, page: { order: 'oldest_first', hasMore: false }, turns: [{ id: 'old-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'PRIVATE_GPT_FIXTURE_ONLY', content: [{ type: 'image', url: 'https://example.invalid/image?private=SECRET_METADATA' }] }] }] });
    throw Error('Unexpected read');
  }
  async call(tool, args, context) {
    this.calls.push({ tool, args, context, write: true });
    return result({ threadId: tool === 'create_thread' ? 'created-child' : args.threadId, ...(tool === 'create_thread' ? { hostId: 'local' } : {}) });
  }
}
async function fixture(t) {
  const directory = path.resolve(fileURLToPath(new URL('../../../../../work/', import.meta.url)));
  await mkdir(directory, { recursive: true });
  const fixtureDir = await mkdtemp(path.join(directory, 'native-route-test-'));
  const cwd = path.join(fixtureDir, 'project'); await mkdir(cwd);
  const bridge = new MockBridge(cwd), desktop = new MockDesktop(cwd);
  const tunnel = { state: { status: 'stopped', url: null }, stop: async () => {} };
  const updater = { getState: () => ({ status: 'idle', autoUpdate: false }), close: () => {} };
  const app = await createConsole({ runtimeDir: path.join(fixtureDir, 'runtime'), defaultCwd: cwd, port: 0, bridge, desktop, tunnel, updater });
  t.after(async () => { await app.close(); assert(path.resolve(fixtureDir).startsWith(directory + path.sep)); await rm(fixtureDir, { recursive: true, force: true }); });
  const auth = role => { const { secret, item } = app.sessions.create(role, 'Mock device'); return { cookie: `codex_mobile_${app.port}=${secret}`, csrf: item.csrf, id: item.id }; };
  const owner = auth('owner'), phone = auth('controller'), pending = auth('pending');
  function request(route, access = {}, data, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = data === undefined ? null : JSON.stringify(data);
      const req = http.request({ hostname: '127.0.0.1', port: app.port, path: route, method: payload === null ? 'GET' : 'POST', headers: { ...(access.cookie ? { cookie: access.cookie } : {}), ...(access.csrf ? { 'x-csrf-token': access.csrf } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', value => { raw += value; }); res.on('end', () => { let body; try { body = JSON.parse(raw); } catch { body = raw; } resolve({ status: res.statusCode, body, headers: res.headers }); });
      }); req.on('error', reject); req.end(payload);
    });
  }
  return { app, desktop, request, owner, phone, pending };
}
function gate() { let release, entered; const blocked = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; }); return { release, ready, wait: async () => { entered(); await blocked; } }; }

test('native projects and GPT routes require pairing and every write requires CSRF', async t => {
  const f = await fixture(t);
  for (const route of ['/api/desktop/projects', '/api/gpt/status', '/api/gpt/threads', '/api/gpt/threads/gpt-chat']) {
    assert.equal((await f.request(route)).status, 401);
    assert.equal((await f.request(route, f.pending)).status, 401);
  }
  for (const route of ['/api/desktop/projects/real-project/threads', '/api/gpt/threads/gpt-chat/messages']) {
    assert.equal((await f.request(route, { cookie: f.phone.cookie }, { prompt: 'No write' })).status, 403);
    assert.equal((await f.request(route, f.phone, { prompt: 'No write' }, { origin: 'https://untrusted.invalid' })).status, 403);
  }
  assert.equal(f.desktop.calls.filter(c => c.write).length, 0);
});

test('approved phone receives real project children and truthful GPT capability limits', async t => {
  const f = await fixture(t);
  const projects = await f.request('/api/desktop/projects', f.phone);
  assert.equal(projects.status, 200); assert.equal(projects.body.projects[0].id, 'real-project');
  assert.deepEqual(projects.body.projects[0].threadIds, ['codex-chat', 'older-codex-chat']);
  assert.equal(projects.body.projects[0].threadsComplete, false); assert.equal(projects.body.capabilities.createProject, false);
  const gpt = await f.request('/api/gpt/threads', f.phone);
  assert.equal(gpt.status, 200); assert.deepEqual(gpt.body.threads.map(v => v.id), ['gpt-chat']);
  assert.equal(gpt.body.capabilities.modelSelection, false); assert.equal(gpt.body.capabilities.stop, false); assert.equal(gpt.body.capabilities.steer, false);
  const read = await f.request('/api/gpt/threads/gpt-chat', f.phone);
  assert.equal(read.status, 200); assert.equal(read.body.thread.messages[0].text, 'PRIVATE_GPT_FIXTURE_ONLY');
  assert(!JSON.stringify(read.body).includes('SECRET_METADATA'));
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal((await f.request('/api/gpt/threads/gpt-chat?stage=wrong', f.phone)).status, 400);
});

test('GPT HTTP sends omit model overrides; running, stop, model and attachment actions do not dispatch', async t => {
  const f = await fixture(t);
  const sent = await f.request('/api/gpt/threads/gpt-chat/messages', f.phone, { prompt: 'Mock GPT follow-up' });
  assert.equal(sent.status, 200); assert.equal(sent.body.accepted, true);
  const native = f.desktop.calls.find(c => c.write);
  assert.deepEqual(native.args, { threadId: 'gpt-chat', prompt: 'Mock GPT follow-up' });
  assert.equal(native.context.callerThreadId, 'real-codex-caller');
  for (const input of [{ model: 'unsupported' }, { effort: 'high' }, { attachmentIds: ['a'.repeat(32)] }, { attachmentIds: {} }, { action: 'stop_then_send' }]) assert.equal((await f.request('/api/gpt/threads/gpt-chat/messages', f.phone, { prompt: 'Should not send', ...input })).status, 400);
  f.desktop.gptStatus = 'active';
  assert.equal((await f.request('/api/gpt/threads/gpt-chat/messages', f.phone, { prompt: 'Cannot steer GPT', action: 'steer' })).status, 409);
  assert.equal(f.desktop.calls.filter(c => c.write).length, 1);
});

test('new Codex child stays in its actual project and leaves default model implicit', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/desktop/projects/real-project/threads', f.phone, { prompt: 'Mock only child task', title: 'Child' });
  assert.equal(created.status, 201); assert.equal(created.body.threadId, 'created-child');
  const native = f.desktop.calls.find(c => c.write);
  assert.deepEqual(native.args.target, { type: 'project', projectId: 'real-project', environment: { type: 'local' } });
  assert.equal(native.args.model, undefined); assert.equal(native.args.thinking, undefined);
  assert.equal(native.context.callerThreadId, 'real-codex-caller');
  assert.equal((await f.request('/api/desktop/projects/gpt-project/threads', f.phone, { prompt: 'No GPT new' })).status, 403);
  assert.equal(f.desktop.calls.filter(c => c.write).length, 1);
});

test('revoking a phone during project or GPT reads suppresses all late private responses', async t => {
  for (const [route, blockedTool] of [['/api/desktop/projects', 'list_projects'], ['/api/gpt/threads/gpt-chat', 'read_thread']]) {
    const f = await fixture(t), blocker = gate();
    f.desktop.intercept = async tool => { if (tool === blockedTool) await blocker.wait(); };
    const pending = f.request(route, f.phone); await blocker.ready;
    f.app.sessions.change(f.phone.id, 'revoked'); blocker.release();
    const response = await pending;
    assert.equal(response.status, 401); assert(!JSON.stringify(response.body).includes('PRIVATE_GPT_FIXTURE_ONLY'));
  }
});

test('revoking a phone during a write preflight prevents project creation and GPT/Codex dispatch', async t => {
  for (const [route, blockedTool] of [['/api/desktop/projects/real-project/threads', 'list_projects'], ['/api/gpt/threads/gpt-chat/messages', 'read_thread'], ['/api/threads/codex-chat/messages', 'read_thread']]) {
    const f = await fixture(t), blocker = gate();
    f.desktop.intercept = async tool => { if (tool === blockedTool) await blocker.wait(); };
    const pending = f.request(route, f.phone, { prompt: 'Revoked before dispatch' }); await blocker.ready;
    f.app.sessions.change(f.phone.id, 'revoked'); blocker.release();
    const response = await pending;
    assert.equal(response.status, 401, route); assert.equal(f.desktop.calls.filter(c => c.write).length, 0, route);
  }
});
