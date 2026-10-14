// Real loopback HTTP and the production server/session code. Only Codex and
// tunnel operations are mocked; no user installation or account is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Backend } from '../lib/backend.mjs';
import { createConsole } from '../../../editions/windows11/server.mjs';
import { APP_INFO } from '../../../editions/windows11/lib/app-info.mjs';

class MockCodex extends EventEmitter {
  constructor() { super(); this.state = { connected: true, mode: 'standalone', error: null }; }
  async start() { return this.state; }
  async close() { this.state.connected = false; }
  async request(method) {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/list') return { data: [], nextCursor: null };
    throw new Error(`Unexpected Codex operation in HTTP authentication fixture: ${method}`);
  }
}

async function fixture(t) {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const workspace = path.resolve(repository, '../v130-validation/backend-http');
  await mkdir(workspace, { recursive: true });
  const root = await mkdtemp(path.join(workspace, 'instance-'));
  const runtime = path.join(root, '.runtime'), project = path.join(root, 'project');
  const profile = { id: 'windows11', version: APP_INFO.version };
  const requests = [];
  let app;
  async function start(port = 0) {
    app = await createConsole({ runtimeDir: runtime, defaultCwd: project, port, host: '127.0.0.1', desktop: false,
      bridge: new MockCodex(), tunnel: { state: { status: 'stopped', url: null }, stop: async () => {} },
      updater: { getState: () => ({ status: 'idle', autoUpdate: false, currentVersion: APP_INFO.version }), close: () => {} } });
    // createConsole is imported from the real edition, while its runtime and
    // installation identity are isolated here. Only this fixture marker changes.
    const marker = JSON.parse(await readFile(path.join(runtime, 'server.json'), 'utf8'));
    await writeFile(path.join(runtime, 'server.json'), JSON.stringify({ ...marker, root }));
    app.server.prependListener('request', (req, res) => {
      const item = { method: req.method, path: req.url, origin: req.headers.origin, cookie: req.headers.cookie, csrf: req.headers['x-csrf-token'] };
      requests.push(item); res.once('finish', () => { item.status = res.statusCode; });
    });
    return app;
  }
  t.after(async () => {
    await app?.close();
    const relative = path.relative(workspace, path.resolve(root));
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  await start();
  const backend = new Backend({ installationRoot: root, defaultCwd: project }, {
    validate: async directory => { assert.equal(directory, root); return { root, profile, nodePath: process.execPath }; },
    spawnProcess: () => { throw new Error('The existing fixture must be reused; no process may be launched.'); },
  });
  return { root, runtime, project, profile, requests, backend, start, get app() { return app; }, get origin() { return `http://127.0.0.1:${app.port}`; } };
}

function assertNoSecrets(value, ...secrets) {
  const encoded = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) assert(!encoded.includes(secret), 'Public result contained a private authentication value');
  assert(!encoded.includes('#owner='));
}

test('Backend logs in over real HTTP, caches its owner session, reuses service and returns no credentials', async t => {
  const f = await fixture(t);
  const first = await f.backend.status({ start: true });
  assert.equal(first.app.version, APP_INFO.version);
  assert.equal(first.busy, false); assert.equal(first.defaultCwd, f.project);
  const auth = { ...f.backend.auth };
  assert.match(auth.cookie, /^codex_mobile_\d+=[\w-]+$/);
  assert.equal(typeof auth.csrf, 'string');
  await f.backend.status();
  assert.equal(f.requests.filter(item => item.path === '/api/owner-login').length, 1);
  const requests = f.requests.filter(item => item.path === '/api/plugin/status');
  assert.equal(requests.length, 2);
  assert(requests.every(item => item.status === 200 && item.cookie === auth.cookie && item.origin === f.origin && item.csrf === undefined));
  assertNoSecrets(first, f.app.sessions.ownerToken, auth.csrf, auth.cookie, auth.cookie.split('=')[1]);
  assertNoSecrets(await f.backend.diagnose(), f.app.sessions.ownerToken, auth.csrf, auth.cookie.split('=')[1]);
});

test('Backend supplies real owner CSRF for writes; missing and invalid tokens do not change permissions', async t => {
  const f = await fixture(t); await f.backend.status();
  const auth = { ...f.backend.auth };
  const denied = await fetch(f.origin + '/api/permissions', { method: 'POST', headers: { cookie: auth.cookie, origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ allowMobileStop: true }) });
  assert.equal(denied.status, 403); await denied.arrayBuffer();
  assert.equal(f.app.permissions.state.allowMobileStop, false);
  const accepted = await f.backend.request('/api/permissions', { allowMobileStop: true });
  assert.equal(accepted.allowMobileStop, true);
  const write = f.requests.filter(item => item.path === '/api/permissions' && item.status === 200).at(-1);
  assert.equal(write.csrf, auth.csrf); assert.equal(write.cookie, auth.cookie); assert.equal(write.origin, f.origin);
  f.backend.auth.csrf = 'invalid-fixture-csrf';
  await assert.rejects(f.backend.request('/api/permissions', { allowMobileStop: false }), /页面验证/);
  assert.equal(f.app.permissions.state.allowMobileStop, true);
  f.backend.auth.csrf = auth.csrf;
  assertNoSecrets(accepted, f.app.sessions.ownerToken, auth.csrf, auth.cookie.split('=')[1]);
});

test('an expired owner session is renewed after real HTTP 401 before one authorized mutation', async t => {
  const f = await fixture(t); await f.backend.status();
  const old = { ...f.backend.auth };
  const session = f.app.sessions.get(old.cookie, `codex_mobile_${f.app.port}`);
  assert.equal(session.role, 'owner'); session.expiresAt = Date.now() - 1;
  const changed = await f.backend.request('/api/permissions', { allowMobileApprovals: true });
  assert.equal(changed.allowMobileApprovals, true);
  assert.notEqual(f.backend.auth.cookie, old.cookie); assert.notEqual(f.backend.auth.csrf, old.csrf);
  assert.equal(f.requests.filter(item => item.path === '/api/owner-login').length, 2);
  assert.deepEqual(f.requests.filter(item => item.path === '/api/permissions').map(item => item.status), [401, 200]);
  const stale = await fetch(f.origin + '/api/plugin/status', { headers: { cookie: old.cookie } });
  assert.equal(stale.status, 401); await stale.arrayBuffer();
  assertNoSecrets(changed, f.app.sessions.ownerToken, old.csrf, f.backend.auth.csrf);
});

test('a real server restart refreshes cached owner authentication, even when PID and port are reused', async t => {
  const f = await fixture(t); await f.backend.status();
  const old = { ...f.backend.auth }, oldOwner = f.app.sessions.ownerToken, port = f.app.port;
  await f.app.close();
  while (Date.now() <= old.startedAt) await delay(1);
  await f.start(port);
  const result = await f.backend.status();
  assert.equal(f.backend.auth.pid, old.pid); // In-process HTTP fixture deliberately reuses PID.
  assert.notEqual(f.backend.auth.startedAt, old.startedAt);
  assert.notEqual(f.backend.auth.cookie, old.cookie); assert.notEqual(f.app.sessions.ownerToken, oldOwner);
  assert.equal(f.requests.filter(item => item.path === '/api/owner-login').length, 2);
  assert(f.requests.filter(item => item.path === '/api/plugin/status').every(item => item.status === 200));
  assertNoSecrets(result, oldOwner, f.app.sessions.ownerToken, old.csrf, f.backend.auth.csrf);
});

test('installation identity and health version mismatches stop before HTTP owner login; failed auth stays private', async t => {
  const f = await fixture(t), markerFile = path.join(f.runtime, 'server.json');
  const marker = JSON.parse(await readFile(markerFile, 'utf8'));
  await writeFile(markerFile, JSON.stringify({ ...marker, root: path.join(f.root, 'different-installation') }));
  await assert.rejects(f.backend.status(), /服务身份无效/);
  assert.equal(f.requests.length, 0);
  await writeFile(markerFile, JSON.stringify(marker)); f.profile.version = '0.0.0';
  await assert.rejects(f.backend.status(), /版本或服务身份/);
  assert.equal(f.requests.filter(item => item.path === '/api/owner-login').length, 0);
  f.profile.version = APP_INFO.version;
  const invalidSecret = 'deliberately_invalid_owner_secret_fixture';
  await writeFile(path.join(f.runtime, 'owner-url.txt'), f.origin + '/#owner=' + invalidSecret);
  await assert.rejects(f.backend.status(), error => { assertNoSecrets({ message: error.message }, invalidSecret, f.app.sessions.ownerToken); return /管理身份/.test(error.message); });
  assert.equal(await f.backend.busy(), true, 'Update guard must fail closed when authentication fails');
});

test('real plugin status rejects anonymous, pending, approved-phone and forwarded owner requests', async t => {
  const f = await fixture(t); await f.backend.status();
  async function deniedStatus(headers, expected) {
    const response = await fetch(f.origin + '/api/plugin/status', { headers });
    assert.equal(response.status, expected);
    const result = await response.json();
    for (const field of ['devices', 'connection', 'permissions', 'defaultCwd', 'updates']) assert.equal(result[field], undefined);
    assertNoSecrets(result, f.app.sessions.ownerToken, f.backend.auth.csrf, f.backend.auth.cookie.split('=')[1]);
  }
  await deniedStatus({}, 401);
  // Only this mock tunnel URL is used to create the pairing token. Every HTTP
  // request still targets the isolated loopback server; no tunnel is started.
  f.app.tunnel.state = { status: 'connected', url: 'https://pairing-fixture.example.invalid' };
  const pairing = await f.backend.request('/api/pairing', { mode: 'internet' });
  const token = new URLSearchParams(new URL(pairing.url).hash.slice(1)).get('pair');
  assert(token);
  const claimed = await fetch(f.origin + '/api/pair', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token, name: 'Isolated HTTP test phone' }) });
  assert.equal(claimed.status, 200);
  const cookie = claimed.headers.get('set-cookie').split(';')[0], phone = await claimed.json();
  await deniedStatus({ cookie }, 401);
  await f.backend.request(`/api/devices/${phone.deviceId}/approve`, {});
  await deniedStatus({ cookie }, 403);
  await deniedStatus({ cookie: f.backend.auth.cookie, 'x-forwarded-for': '127.0.0.1' }, 401);
  const status = await f.backend.status();
  assert.equal(status.devices.length, 1);
  assertNoSecrets(status, token, cookie.split('=')[1], f.app.sessions.ownerToken, f.backend.auth.csrf);
});
