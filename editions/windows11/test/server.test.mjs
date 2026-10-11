import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConsole, lanAddresses } from '../server.mjs';

class FakeUpdater {
  constructor() { this.state = { status: 'idle', currentVersion: '1.0.0', autoUpdate: false }; this.calls = []; }
  getState() { return { ...this.state }; }
  async check() { this.calls.push('check'); this.state.status = 'unpublished'; return this.getState(); }
  async configure(input) { this.calls.push(['configure', input]); this.state.autoUpdate = input.autoUpdate; return this.getState(); }
  async install() { this.calls.push('install'); this.state.status = 'prepared'; return this.getState(); }
  close() {}
}

class FakeBridge extends EventEmitter {
  constructor() { super(); this.state = { connected: true, mode: 'standalone', error: null }; this.calls = []; }
  async start() { return this.state; }
  async close() { this.state.connected = false; }
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'model/list') return { data: [{ id: 'test-picker', model: 'test-model', displayName: 'Dynamic test model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Server option' }, { reasoningEffort: 'high', description: 'More reasoning' }] }] };
    const thread = { id: 'desktop-history', name: 'Desktop task', cwd: process.cwd(), updatedAt: 1000, status: { type: 'notLoaded' }, turns: [{ id: 'turn-old', status: 'completed', items: [{ id: 'message-old', type: 'agentMessage', text: 'A saved result' }] }] };
    if (method === 'thread/list') return { data: [thread], nextCursor: null };
    if (method === 'thread/read') return { thread };
    throw new Error(`Test refuses unexpected model-affecting RPC: ${method}`);
  }
  reply() { throw new Error('This test must not answer a model request'); }
  replyError() {}
}

class FakeTunnel extends EventEmitter {
  constructor() { super(); this.state = { status: 'ready', url: 'https://security-test.trycloudflare.com', error: null }; this.starts = 0; }
  async start() { this.starts++; return this.state; }
  async stop() { this.state = { status: 'stopped', url: null, error: null }; }
}

class FakeDesktop extends EventEmitter {
  constructor() {
    super(); this.options = { hostId: 'local', allowWrites: true }; this.state = { connected: true, error: null }; this.calls = []; this.failWrite = false;
    this.tools = [{ name: 'list_threads', namespace: 'codex_app' }, { name: 'read_thread', namespace: 'codex_app' }, { name: 'send_message_to_thread', namespace: 'codex_app', inputSchema: { properties: { model: { type: 'string' }, thinking: { enum: ['medium', 'high'] } } } }];
  }
  async connect() { return this.state; }
  async listTools() { return this.tools; }
  async close() { this.state.connected = false; }
  async callReadOnly(tool, args, context) {
    this.calls.push({ tool, args, context });
    const thread = { id: 'desktop-history', title: 'Native desktop task', kind: 'codex', hostId: 'local', cwd: process.cwd(), status: { type: 'idle' }, updatedAt: 1700000000000 };
    const data = tool === 'list_threads' ? { pinnedThreads: [], threads: [thread] } : { thread, page: { order: 'oldest-first', hasMore: false }, turns: [{ id: 'live-turn', status: 'completed', items: [{ id: 'live-message', type: 'agentMessage', text: 'Native desktop response' }] }] };
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
  }
  async call(tool, args, context) {
    this.calls.push({ tool, args, context });
    if (this.failWrite) throw new Error('Simulated timeout after native dispatch');
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: args.threadId, accepted: true }) }] };
  }
}

async function fixture(t, { desktop, updater } = {}) {
  const work = fileURLToPath(new URL('../../../../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  const fixtureDir = await mkdtemp(path.join(work, 'codex-server-test-'));
  const runtimeDir = path.join(fixtureDir, 'runtime');
  const projectRoot = path.join(fixtureDir, 'project');
  await mkdir(projectRoot);
  const bridge = new FakeBridge();
  const tunnel = new FakeTunnel();
  const app = await createConsole({ runtimeDir, port: 0, bridge, tunnel, defaultCwd: projectRoot, ...(desktop ? { desktop } : {}), ...(updater ? { updater } : {}) });
  t.after(async () => { await app.close(); await rm(fixtureDir, { recursive: true, force: true }); });
  function request(route, { method = 'GET', data, cookie, csrf, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = data === undefined ? null : JSON.stringify(data);
      const req = http.request({ hostname: '127.0.0.1', port: app.port, path: route, method, headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      } }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', value => { raw += value; });
        res.on('end', () => {
          let body; try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode, body, headers: res.headers, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  async function owner() {
    const login = await request('/api/owner-login', { method: 'POST', data: { token: app.sessions.ownerToken } });
    assert.equal(login.status, 200);
    const boot = await request('/api/bootstrap', { cookie: login.cookie });
    assert.equal(boot.body.role, 'owner');
    return { cookie: login.cookie, csrf: boot.body.csrfToken };
  }
  async function pair(ownerAuth) {
    const pairing = await request('/api/pairing', { method: 'POST', ...ownerAuth, data: { mode: 'internet' } });
    assert.equal(pairing.status, 200);
    const token = new URLSearchParams(new URL(pairing.body.url).hash.slice(1)).get('pair');
    const claimed = await request('/api/pair', { method: 'POST', data: { token, name: 'Test phone' } });
    assert.equal(claimed.status, 200);
    const boot = await request('/api/bootstrap', { cookie: claimed.cookie });
    return { token, id: claimed.body.deviceId, cookie: claimed.cookie, csrf: boot.body.csrfToken };
  }
  async function defaultProject(auth) {
    const result = await request('/api/projects', auth);
    assert.equal(result.status, 200);
    const project = result.body.projects.find(p => path.resolve(p.path).toLowerCase() === path.resolve(projectRoot).toLowerCase());
    assert(project, 'The configured workspace must appear in the project list');
    return project;
  }
  return { app, bridge, tunnel, request, owner, pair, defaultProject, fixtureDir, runtimeDir, projectRoot };
}

test('update idle guard refreshes stale native state and fails closed on active tasks or read errors', async t => {
  const f = await fixture(t);
  const busy = f.app.updater.options.isBusy;
  const stale = { id: 'native-old', status: 'running' };
  f.app.tasks.cache.set(stale.id, stale);
  let reads = 0;
  f.app.tasks.list = async () => [{ ...stale, status: 'idle' }];
  f.app.tasks.get = async () => { reads++; return { thread: { ...stale, status: 'idle' } }; };
  assert.equal(await busy(), false, 'A completed desktop task must not permanently block updates');
  assert.equal(reads, 1);
  f.app.tasks.get = async () => ({ thread: stale });
  assert.equal(await busy(), true);
  f.app.tasks.list = async () => { throw new Error('Status unavailable'); };
  assert.equal(await busy(), true);
  f.app.tasks.list = async () => [];
  f.app.tasks.cache.clear();
  f.app.tasks.approvals.set('pending', {});
  assert.equal(await busy(), true);
  f.app.tasks.approvals.clear();
  assert.equal(await busy(), false);
});

test('update state requires pairing and update mutations require a local owner with CSRF', async t => {
  const updater = new FakeUpdater();
  const f = await fixture(t, { updater });
  const owner = await f.owner();
  const phone = await f.pair(owner);
  for (const auth of [{}, phone]) {
    assert.equal((await f.request('/api/updates', auth)).status, 401);
    assert.equal((await f.request('/api/updates/install', { ...auth, method: 'POST', data: {} })).status, 401);
  }
  await f.request(`/api/devices/${phone.id}/approve`, { ...owner, method: 'POST', data: {} });
  assert.equal((await f.request('/api/updates', phone)).body.currentVersion, '1.0.0');
  for (const action of ['check', 'settings', 'install']) {
    assert.equal((await f.request(`/api/updates/${action}`, { ...phone, method: 'POST', data: { autoUpdate: true } })).status, 403);
    assert.equal((await f.request(`/api/updates/${action}`, { cookie: owner.cookie, method: 'POST', data: {} })).status, 403);
  }
  assert.deepEqual(updater.calls, []);
  assert.equal((await f.request('/api/updates/check', { ...owner, method: 'POST', data: {} })).body.status, 'unpublished');
  assert.equal((await f.request('/api/updates/settings', { ...owner, method: 'POST', data: { autoUpdate: true, repository: 'attacker/other' } })).body.autoUpdate, true);
  assert.equal((await f.request('/api/updates/install', { ...owner, method: 'POST', data: {} })).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updater.calls, ['check', ['configure', { autoUpdate: true }], 'install']);
});

test('installing updates block new task mutations without invoking Codex', async t => {
  const updater = new FakeUpdater(); updater.state.status = 'installing';
  const f = await fixture(t, { updater }); const auth = await f.owner();
  for (const route of ['/api/threads', '/api/threads/desktop-history/messages', '/api/threads/desktop-history/fork']) {
    assert.equal((await f.request(route, { ...auth, method: 'POST', data: { prompt: 'should not execute' } })).status, 409);
  }
  assert.equal(f.bridge.calls.length, 0);
  assert.equal((await f.request('/api/bootstrap', auth)).body.app.author, 'maxlzyver');
  assert.equal((await f.request('/api/bootstrap', auth)).body.app.feedbackEmail, 'lzyuan666666@gmail.com');
});

test('appearance assets are served as static code and revoked phones lose update access', async t => {
  const f = await fixture(t, { updater: new FakeUpdater() });
  for (const route of ['/settings.js', '/settings.css']) assert.equal((await f.request(route)).status, 200);
  const support = await f.request('/support-wechat.jpg');
  assert.equal(support.status, 200);
  assert.equal(support.headers['content-type'], 'image/jpeg');
  const owner = await f.owner(), phone = await f.pair(owner);
  await f.request(`/api/devices/${phone.id}/approve`, { ...owner, method: 'POST', data: {} });
  assert.equal((await f.request('/api/updates', phone)).status, 200);
  await f.request(`/api/devices/${phone.id}/revoke`, { ...owner, method: 'POST', data: {} });
  assert.equal((await f.request('/api/updates', phone)).status, 401);
});

test('anonymous and pending devices cannot read history or submit instructions', async t => {
  const f = await fixture(t);
  for (const auth of [{}, await f.pair(await f.owner())]) {
    assert.equal((await f.request('/api/threads', auth)).status, 401);
    assert.equal((await f.request('/api/threads/desktop-history', auth)).status, 401);
    assert.equal((await f.request('/api/threads', { ...auth, method: 'POST', data: { prompt: 'run' } })).status, 401);
  }
  assert.equal(f.bridge.calls.length, 0);
});

test('mutation requires CSRF even with a valid owner cookie', async t => {
  const f = await fixture(t);
  const auth = await f.owner();
  for (const csrf of [undefined, 'invalid']) {
    const result = await f.request('/api/tunnel', { cookie: auth.cookie, csrf, method: 'POST', data: { action: 'start' } });
    assert.equal(result.status, 403);
  }
  assert.equal(f.tunnel.starts, 0);
  assert.equal((await f.request('/api/tunnel', { ...auth, method: 'POST', data: { action: 'start' } })).status, 202);
  assert.equal(f.tunnel.starts, 1);
});

test('pairing nonces are single-use and expire', async t => {
  const f = await fixture(t);
  const auth = await f.owner();
  const phone = await f.pair(auth);
  assert.equal((await f.request('/api/pair', { method: 'POST', data: { token: phone.token } })).status, 401);
  const expired = f.app.sessions.newPairing('internet', f.tunnel.state.url);
  expired.expiresAt = Date.now() - 1;
  assert.equal((await f.request('/api/pair', { method: 'POST', data: { token: expired.token } })).status, 401);
  assert.equal((await f.request('/api/pair', { method: 'POST', data: { token: '猜'.repeat(43) } })).status, 401);
});

test('owner approval enables phone access; controller cannot administer; revoke removes access', async t => {
  const f = await fixture(t);
  const owner = await f.owner();
  const phone = await f.pair(owner);
  assert.equal((await f.request('/api/bootstrap', phone)).body.role, 'pending');
  assert.equal((await f.request(`/api/devices/${phone.id}/approve`, { ...owner, method: 'POST', data: {} })).status, 200);
  assert.equal((await f.request('/api/bootstrap', phone)).body.role, 'controller');
  const history = await f.request('/api/threads', phone);
  assert.equal(history.status, 200);
  assert.equal(history.body.threads[0].readOnly, true);
  assert.equal((await f.request('/api/devices', phone)).status, 403);
  assert.equal((await f.request('/api/tunnel', { ...phone, method: 'POST', data: { action: 'start' } })).status, 403);
  assert.equal((await f.request('/api/pairing', { ...phone, method: 'POST', data: { mode: 'internet' } })).status, 403);
  assert.equal((await f.request('/api/shutdown', { ...phone, method: 'POST', data: {} })).status, 403);
  assert.equal((await f.request(`/api/devices/${phone.id}/revoke`, { ...owner, method: 'POST', data: {} })).status, 200);
  assert.equal((await f.request('/api/threads', phone)).status, 401);
});

test('desktop history remains read-only even for an authenticated owner', async t => {
  const f = await fixture(t);
  const auth = await f.owner();
  const history = await f.request('/api/threads/desktop-history', auth);
  assert.equal(history.status, 200);
  assert.equal(history.body.thread.readOnly, true);
  assert.equal(history.body.thread.messages[0].text, 'A saved result');
  for (const action of ['messages', 'stop']) {
    const result = await f.request(`/api/threads/desktop-history/${action}`, { ...auth, method: 'POST', data: { prompt: 'change history' } });
    assert.equal(result.status, 403);
  }
  assert(f.bridge.calls.every(call => ['thread/list','thread/read'].includes(call.method)));
});

test('untrusted Host, Origin and cross-site requests are blocked', async t => {
  const f = await fixture(t);
  const auth = await f.owner();
  for (const headers of [
    { Host: 'attacker.example' },
    { Origin: 'https://attacker.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await f.request('/api/threads', { ...auth, headers })).status, 403);
  assert.equal(f.bridge.calls.length, 0);
});

test('owner identity cannot be used through a tunnel, proxy headers or LAN Host', async t => {
  const f = await fixture(t);
  const owner = await f.owner();
  const hosts = [
    { Host: new URL(f.tunnel.state.url).host, Origin: f.tunnel.state.url },
    { 'X-Forwarded-For': '198.51.100.1' },
    { 'CF-Connecting-IP': '198.51.100.1' },
  ];
  const lan = lanAddresses(f.app.port)[0];
  if (lan) hosts.push({ Host: new URL(lan).host, Origin: lan });
  else t.diagnostic('No LAN interface; proxy and tunnel owner isolation still tested.');
  for (const headers of hosts) {
    assert.equal((await f.request('/api/threads', { ...owner, headers })).status, 401);
    assert.equal((await f.request('/api/bootstrap', { ...owner, headers })).body.role, 'anonymous');
    assert.equal((await f.request('/api/owner-login', { method: 'POST', headers, data: { token: f.app.sessions.ownerToken } })).status, 403);
  }
});

test('controller tunnel cookie is Secure and can access only after approval', async t => {
  const f = await fixture(t);
  const owner = await f.owner();
  const pairing = f.app.sessions.newPairing('internet', f.tunnel.state.url);
  const headers = { Host: new URL(f.tunnel.state.url).host, Origin: f.tunnel.state.url, 'CF-Connecting-IP': '198.51.100.10' };
  const paired = await f.request('/api/pair', { method: 'POST', headers, data: { token: pairing.token } });
  assert.equal(paired.status, 200);
  assert.match(paired.headers['set-cookie'][0], /; Secure(?:;|$)/);
  assert.match(paired.headers['set-cookie'][0], /; HttpOnly;/);
  assert.match(paired.headers['set-cookie'][0], /; SameSite=Strict;/);
  assert.equal((await f.request('/api/threads', { cookie: paired.cookie, headers })).status, 401);
  assert.equal((await f.request(`/api/devices/${paired.body.deviceId}/approve`, { ...owner, method: 'POST', data: {} })).status, 200);
  assert.equal((await f.request('/api/threads', { cookie: paired.cookie, headers })).status, 200);
});

test('model HTTP endpoint requires pairing and returns the live Codex catalog', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/models')).status, 401);
  const owner = await f.owner();
  const pending = await f.pair(owner);
  assert.equal((await f.request('/api/models', pending)).status, 401);
  const result = await f.request('/api/models', owner);
  assert.equal(result.status, 200);
  assert.equal(result.body.models[0].id, 'test-picker');
  assert.equal(result.body.models[0].model, 'test-model');
  assert.equal(result.body.models[0].displayName, 'Dynamic test model');
  assert.deepEqual(result.body.models[0].supportedReasoningEfforts.map(e => e.reasoningEffort), ['medium', 'high']);
  assert.equal(f.bridge.calls.filter(c => c.method === 'model/list').length, 1);
});

test('owner can add a project; approved phones can list projects but cannot add roots', async t => {
  const f = await fixture(t);
  const owner = await f.owner();
  const phone = await f.pair(owner);
  assert.equal((await f.request('/api/projects', phone)).status, 401);
  await f.request(`/api/devices/${phone.id}/approve`, { ...owner, method: 'POST', data: {} });
  const extraRoot = path.join(f.fixtureDir, 'extra-project');
  await mkdir(extraRoot);
  assert.equal((await f.request('/api/projects', { ...phone, method: 'POST', data: { path: extraRoot } })).status, 403);
  assert.equal((await f.request('/api/projects', { cookie: owner.cookie, method: 'POST', data: { path: extraRoot } })).status, 403);
  const added = await f.request('/api/projects', { ...owner, method: 'POST', data: { path: extraRoot } });
  assert.equal(added.status, 201);
  const projects = await f.request('/api/projects', phone);
  assert.equal(projects.status, 200);
  assert(projects.body.projects.some(p => path.resolve(p.path).toLowerCase() === path.resolve(extraRoot).toLowerCase()));
});

test('project files expose text preview and authenticated downloads with byte ranges', async t => {
  const f = await fixture(t);
  const auth = await f.owner();
  await writeFile(path.join(f.projectRoot, 'report.txt'), 'abcdefghij');
  const project = await f.defaultProject(auth);
  const base = `/api/projects/${project.id}`;
  const files = await f.request(`${base}/files`, auth);
  assert.equal(files.status, 200);
  assert.match(JSON.stringify(files.body), /report\.txt/);
  const preview = await f.request(`${base}/preview?path=report.txt`, auth);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.text, 'abcdefghij');
  const download = await f.request(`${base}/download?path=report.txt`, auth);
  assert.equal(download.status, 200);
  assert.equal(download.body, 'abcdefghij');
  assert.equal(download.headers['content-length'], '10');
  assert.match(download.headers['content-disposition'], /^attachment;/);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.match(download.headers['content-security-policy'], /sandbox/);
  const middle = await f.request(`${base}/download?path=report.txt`, { ...auth, headers: { Range: 'bytes=2-5' } });
  assert.equal(middle.status, 206);
  assert.equal(middle.body, 'cdef');
  assert.equal(middle.headers['content-range'], 'bytes 2-5/10');
  const tail = await f.request(`${base}/download?path=report.txt`, { ...auth, headers: { Range: 'bytes=-3' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.body, 'hij');
  for (const range of ['bytes=99-100', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=bogus']) {
    const invalid = await f.request(`${base}/download?path=report.txt`, { ...auth, headers: { Range: range } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], 'bytes */10');
  }
});

test('HTML and SVG cannot run inline and downloads cannot escape the project', async t => {
  const f = await fixture(t);
  const auth = await f.owner();
  await writeFile(path.join(f.projectRoot, 'index.html'), '<script>alert(1)</script>');
  await writeFile(path.join(f.projectRoot, 'diagram.svg'), '<svg onload="alert(1)"></svg>');
  await writeFile(path.join(f.fixtureDir, 'outside.txt'), 'outside secret');
  const project = await f.defaultProject(auth);
  const base = `/api/projects/${project.id}`;
  for (const file of ['index.html', 'diagram.svg']) {
    assert.equal((await f.request(`${base}/content?path=${file}`, auth)).status, 415);
    const download = await f.request(`${base}/download?path=${file}`, auth);
    assert.equal(download.status, 200);
    assert.match(download.headers['content-disposition'], /^attachment;/);
    assert.equal(download.headers['content-type'], 'application/octet-stream');
    assert.match(download.headers['content-security-policy'], /sandbox/);
  }
  for (const escaped of ['../outside.txt', '..\\outside.txt', path.join(f.fixtureDir, 'outside.txt')]) {
    const result = await f.request(`${base}/download?path=${encodeURIComponent(escaped)}`, auth);
    assert([400, 403].includes(result.status), `Escaped path must fail: ${result.status}`);
    assert.doesNotMatch(JSON.stringify(result.body), /outside secret/);
  }
});

test('unpaired and revoked devices cannot list, preview or download project files', async t => {
  const f = await fixture(t);
  const owner = await f.owner();
  await writeFile(path.join(f.projectRoot, 'result.txt'), 'private result');
  const project = await f.defaultProject(owner);
  const phone = await f.pair(owner);
  const routes = ['files', 'preview', 'download', 'content'].map(action => `/api/projects/${project.id}/${action}?path=result.txt`);
  for (const auth of [{}, phone]) for (const route of routes) assert.equal((await f.request(route, auth)).status, 401);
  await f.request(`/api/devices/${phone.id}/approve`, { ...owner, method: 'POST', data: {} });
  assert.equal((await f.request(routes[2], phone)).status, 200);
  await f.request(`/api/devices/${phone.id}/revoke`, { ...owner, method: 'POST', data: {} });
  for (const route of routes) assert.equal((await f.request(route, phone)).status, 401);
});

test('new task endpoint selects an approved project and forwards model and effort', async t => {
  const f = await fixture(t);
  const auth = await f.owner();
  const project = await f.defaultProject(auth);
  const calls = [];
  f.app.tasks.create = async (prompt, cwd, options) => { calls.push({ prompt, cwd, options }); return { thread: { id: 'fake-created', readOnly: false } }; };
  const result = await f.request('/api/threads', { ...auth, method: 'POST', data: { prompt: '执行指定项目', projectId: project.id, model: 'test-picker', effort: 'high' } });
  assert.equal(result.status, 201);
  assert.equal(path.resolve(calls[0].cwd).toLowerCase(), path.resolve(f.projectRoot).toLowerCase());
  assert.deepEqual(calls[0].options, { model: 'test-picker', effort: 'high' });
  assert.equal(calls[0].prompt, '执行指定项目');
  const bad = await f.request('/api/threads', { ...auth, method: 'POST', data: { prompt: '拒绝未知项目', projectId: 'missing-project' } });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 1);
});

test('message and fork routes pass model choices while enforcing session and CSRF checks', async t => {
  const f = await fixture(t);
  const auth = await f.owner();
  const calls = [];
  f.app.tasks.send = async (id, prompt, options) => { calls.push({ kind: 'send', id, prompt, options }); return { thread: { id } }; };
  f.app.tasks.fork = async (id, options) => { calls.push({ kind: 'fork', id, options }); return { thread: { id: 'fork-new', forkedFromId: id } }; };
  const payload = { prompt: '继续', model: 'test-picker', effort: 'high' };
  for (const route of ['/api/threads/desktop-history/messages', '/api/threads/desktop-history/fork']) {
    assert.equal((await f.request(route, { method: 'POST', data: payload })).status, 401);
    assert.equal((await f.request(route, { cookie: auth.cookie, method: 'POST', data: payload })).status, 403);
    assert.equal((await f.request(route, { ...auth, method: 'POST', data: payload })).status, 200);
  }
  assert.deepEqual(calls, [
    { kind: 'send', id: 'desktop-history', prompt: '继续', options: { model: 'test-picker', effort: 'high' } },
    { kind: 'fork', id: 'desktop-history', options: payload },
  ]);
  assert(f.bridge.calls.every(call => ['thread/list', 'thread/read'].includes(call.method)));
});

test('native HTTP routes make no desktop calls before pairing and CSRF authorization', async t => {
  const desktop = new FakeDesktop(); const f = await fixture(t, { desktop });
  const owner = await f.owner(); const pending = await f.pair(owner);
  for (const auth of [{}, pending]) {
    assert.equal((await f.request('/api/threads', auth)).status, 401);
    assert.equal((await f.request('/api/threads/desktop-history', auth)).status, 401);
    assert.equal((await f.request('/api/threads/desktop-history/messages', { ...auth, method: 'POST', data: { prompt: 'No permission' } })).status, 401);
  }
  assert.equal((await f.request('/api/threads/desktop-history/messages', { cookie: owner.cookie, method: 'POST', data: { prompt: 'Missing CSRF' } })).status, 403);
  assert.equal(desktop.calls.length, 0);
  assert.equal(f.bridge.calls.length, 0);
});

test('native HTTP reads expose exact conversation and capability metadata with saved history merged', async t => {
  const desktop = new FakeDesktop(); const f = await fixture(t, { desktop }); const owner = await f.owner();
  const list = await f.request('/api/threads', owner);
  assert.equal(list.status, 200);
  assert.equal(list.body.threads[0].source, 'desktop');
  assert.equal(list.body.threads[0].control, 'native');
  assert.equal(list.body.threads[0].readOnly, false);
  const read = await f.request('/api/threads/desktop-history', owner);
  assert.equal(read.status, 200);
  assert.equal(read.body.thread.id, 'desktop-history');
  assert.equal(read.body.thread.title, 'Native desktop task');
  assert.equal(read.body.thread.capabilities.send, true);
  assert.equal(read.body.thread.capabilities.modelSelection, true);
  assert.equal(read.body.thread.capabilities.stop, false);
  assert.equal(read.body.thread.capabilities.approvals, false);
  assert.deepEqual(read.body.thread.messages.map(m => m.text), ['A saved result', 'Native desktop response']);
  assert(desktop.calls.every(call => call.context.hostId === 'local' && call.context.callerThreadId === 'desktop-history'));
});

test('approved phone sends to the original desktop ID with model and thinking mapped correctly', async t => {
  const desktop = new FakeDesktop(); const f = await fixture(t, { desktop }); const owner = await f.owner(); const phone = await f.pair(owner);
  await f.request(`/api/devices/${phone.id}/approve`, { ...owner, method: 'POST', data: {} });
  const sent = await f.request('/api/threads/desktop-history/messages', { ...phone, method: 'POST', data: { prompt: '继续原桌面会话', model: 'test-picker', effort: 'high' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.thread.id, 'desktop-history');
  const write = desktop.calls.find(call => call.tool === 'send_message_to_thread');
  assert.deepEqual(write.args, { threadId: 'desktop-history', hostId: 'local', prompt: '继续原桌面会话', model: 'test-model', thinking: 'high' });
  assert.deepEqual(write.context, { callerThreadId: 'desktop-history', hostId: 'local' });
  assert(f.bridge.calls.every(call => ['thread/list', 'thread/read', 'model/list'].includes(call.method)));
  const count = desktop.calls.length;
  await f.request(`/api/devices/${phone.id}/revoke`, { ...owner, method: 'POST', data: {} });
  assert.equal((await f.request('/api/threads/desktop-history/messages', { ...phone, method: 'POST', data: { prompt: 'Revoked' } })).status, 401);
  assert.equal(desktop.calls.length, count);
});

test('native HTTP default send preserves desktop settings and unavailable stop never dispatches a write', async t => {
  const desktop = new FakeDesktop(); const f = await fixture(t, { desktop }); const owner = await f.owner();
  const sent = await f.request('/api/threads/desktop-history/messages', { ...owner, method: 'POST', data: { prompt: '沿用当前设置' } });
  assert.equal(sent.status, 200);
  const write = desktop.calls.find(call => call.tool === 'send_message_to_thread');
  assert.equal(write.args.model, undefined);
  assert.equal(write.args.thinking, undefined);
  assert(!f.bridge.calls.some(call => call.method === 'model/list'));
  const count = desktop.calls.length;
  const stopped = await f.request('/api/threads/desktop-history/stop', { ...owner, method: 'POST', data: {} });
  assert.equal(stopped.status, 409);
  assert.match(stopped.body.error, /桌面/);
  assert.equal(desktop.calls.length, count);
});

test('native HTTP write errors remain explicit and do not fall back to duplicate CLI execution', async t => {
  const desktop = new FakeDesktop(); desktop.failWrite = true;
  const f = await fixture(t, { desktop }); const owner = await f.owner();
  const response = await f.request('/api/threads/desktop-history/messages', { ...owner, method: 'POST', data: { prompt: 'Single dispatch only' } });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /可能已经被接受/);
  assert.equal(desktop.calls.filter(call => call.tool === 'send_message_to_thread').length, 1);
  assert(f.bridge.calls.every(call => ['thread/list', 'thread/read'].includes(call.method)));
});
