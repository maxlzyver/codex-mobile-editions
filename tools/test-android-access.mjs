import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const protocol = 'Codex Mobile Android v1';
const editions = (process.env.CODEX_ANDROID_TEST_EDITIONS || 'windows11,windows10,macos').split(',');
const keyPair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicText = key => key.export({ format: 'der', type: 'spki' }).toString('base64url');
const parseKey = text => createPublicKey({ key: Buffer.from(text, 'base64url'), format: 'der', type: 'spki' });

class Bridge extends EventEmitter {
  state = { connected: true, mode: 'standalone', error: null };
  writes = 0;
  async start() { return this.state; }
  async close() {}
  async request(method) {
    const thread = {
      id: 'android-fixture', name: 'Android fixture thread', status: { type: 'notLoaded' },
      turns: [{ id: 'test-turn', status: 'completed', items: [{ id: 'test-answer', type: 'agentMessage', text: 'ANDROID_TEST_RESULT' }] }],
    };
    if (method === 'thread/list') return { data: [thread], nextCursor: null };
    if (method === 'thread/read') return { thread };
    if (method === 'model/list') return { data: [] };
    this.writes++;
    throw new Error('This fixture only exposes read operations.');
  }
  replyError() {}
}

function cipher(key, session, direction, sequence, input) {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(direction);
  iv.writeBigUInt64BE(BigInt(sequence), 4);
  const aad = Buffer.from([protocol, session, direction, sequence].join('\n'));
  if (direction === 0) {
    const encrypted = createCipheriv('aes-256-gcm', key, iv);
    encrypted.setAAD(aad);
    return Buffer.concat([encrypted.update(JSON.stringify(input)), encrypted.final(), encrypted.getAuthTag()]).toString('base64url');
  }
  const raw = Buffer.from(input, 'base64url');
  const decrypted = createDecipheriv('aes-256-gcm', key, iv);
  decrypted.setAAD(aad);
  decrypted.setAuthTag(raw.subarray(-16));
  return JSON.parse(Buffer.concat([decrypted.update(raw.subarray(0, -16)), decrypted.final()]));
}

async function request(base, route, body, headers = {}) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], json: await response.json() };
}

async function phoneConnect(base, pinned, identity, { device = '', pair = '' } = {}) {
  const ephemeral = keyPair(), name = 'Android 回归设备';
  const nonce = randomBytes(32).toString('base64url'), signing = publicText(identity.publicKey), client = publicText(ephemeral.publicKey);
  const challenge = await request(base, '/api/android/challenge', { device, enroll: Boolean(pair), nonce, key: signing, ephemeral: client });
  assert.equal(challenge.status, 200);
  const transcript = [protocol, challenge.json.id, nonce, pair ? 'enroll' : 'resume', device, signing, client, challenge.json.ephemeral].join('\n');
  assert.equal(verify('sha256', transcript, parseKey(pinned), Buffer.from(challenge.json.signature, 'base64url')), true);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: parseKey(challenge.json.ephemeral) });
  const secret = hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(transcript), 32);
  const proof = { id: challenge.json.id, signature: sign('sha256', transcript, identity.privateKey).toString('base64url') };
  if (pair) proof.enrollment = cipher(secret, challenge.json.id, 0, 0, { pair, name });
  const connected = await request(base, '/api/android/connect', proof);
  assert.equal(connected.status, 200);
  const session = connected.json.session;
  const welcome = cipher(secret, session, 1, 0, connected.json.message);
  let sequence = 0;
  return {
    welcome,
    async call(path, method = 'GET', body) {
      sequence++;
      const payload = { session, sequence, message: cipher(secret, session, 0, sequence, { method, path, body }) };
      const result = await request(base, '/api/android/exchange', payload);
      assert.equal(result.status, 200);
      return { reply: cipher(secret, session, 1, sequence, result.json.message), payload };
    },
  };
}

for (const edition of editions) {
  assert.ok(['windows11', 'windows10', 'macos'].includes(edition));
  const { createConsole } = await import(pathToFileURL(path.resolve('editions', edition, 'server.mjs')));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-android-access-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
  let app;
  async function start(publicUrl) {
    const bridge = new Bridge();
    const tunnel = { state: { status: 'ready', url: publicUrl }, async stop() {} };
    app = await createConsole({ bridge, tunnel, runtimeDir: path.join(directory, 'state'), defaultCwd: project, port: 0, host: '127.0.0.1' });
    const base = 'http://127.0.0.1:' + app.port;
    const login = await request(base, '/api/owner-login', { token: app.sessions.ownerToken });
    assert.equal(login.status, 200);
    const boot = await request(base, '/api/bootstrap', undefined, { Cookie: login.cookie });
    return { base, owner: { Cookie: login.cookie, 'X-CSRF-Token': boot.json.csrfToken }, bridge };
  }
  try {
    const first = await start('https://android-first.trycloudflare.com');
    const qr = await request(first.base, '/api/pairing', { mode: 'internet' }, first.owner);
    const params = new URLSearchParams(new URL(qr.json.url).hash.slice(1));
    const identity = keyPair(), pinned = params.get('desktop');
    const phone = await phoneConnect(first.base, pinned, identity, { pair: params.get('pair') });
    assert.equal(phone.welcome.role, 'pending');
    assert.equal((await phone.call('/api/threads')).reply.status, 401);
    const id = phone.welcome.device;
    assert.equal((await request(first.base, '/api/devices/' + id + '/approve', {}, first.owner)).status, 200);
    assert.equal((await phone.call('/api/bootstrap')).reply.data.role, 'controller');
    const read = await phone.call('/api/threads/android-fixture?stage=full');
    assert.equal(read.reply.status, 200);
    assert.match(JSON.stringify(read.reply.data), /ANDROID_TEST_RESULT/);
    assert.equal((await request(first.base, '/api/android/exchange', read.payload)).status, 401);
    assert.equal((await phone.call('/api/shutdown', 'POST', {})).reply.status, 404);
    assert.equal((await request(first.base, '/api/threads')).status, 401);
    await app.close(); app = null;

    const second = await start('https://android-second.trycloudflare.com');
    const rebound = await phoneConnect(second.base, pinned, identity, { device: id });
    assert.equal(rebound.welcome.role, 'controller');
    assert.equal((await rebound.call('/api/bootstrap')).reply.data.connection.publicUrl, 'https://android-second.trycloudflare.com');
    assert.equal((await phoneConnect(second.base, pinned, keyPair(), { device: id })).welcome.role, 'revoked');
    assert.equal((await request(second.base, '/api/devices/' + id + '/revoke', {}, second.owner)).status, 200);
    assert.equal((await rebound.call('/api/threads')).reply.revoked, true);
    assert.equal(second.bridge.writes, 0);
    console.log(`${edition}: sealed Android pairing, persistent binding, address change, replay rejection and revocation passed`);
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
