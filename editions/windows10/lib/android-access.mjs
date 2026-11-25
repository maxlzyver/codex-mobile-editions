import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AccessError, token } from './security.mjs';

const CURVE = 'prime256v1';
const CONTEXT = 'Codex Mobile Android v1';
const CHALLENGE_TTL = 60_000;
const LEASE_TTL = 300_000;
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_REPLY = 8 * 1024 * 1024;
const DEVICE_ID = /^[a-f0-9]{24}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9_-]{122}$/;
const READ = /^\/api\/(?:bootstrap|models|permissions|desktop\/projects|(?:gpt\/)?threads(?:\/[\w-]+)?|projects(?:\/[\w-]+\/(?:files|preview|download|content|resolve))?|attachments\/[a-f0-9]{32}\/(?:download|content))$/;
const WRITE = /^\/api\/(?:threads(?:\/[\w-]+\/(?:messages|stop|fork))?|gpt\/threads\/[\w-]+\/messages|desktop\/projects\/[\w-]+\/threads|approvals\/[a-f0-9]+|attachments(?:\/[a-f0-9]{32}\/delete)?)$/;

function publicKey(encoded) {
  if (typeof encoded !== 'string' || !KEY.test(encoded)) throw new AccessError(400, '设备公钥无效。');
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== CURVE) throw new Error();
    return key;
  } catch { throw new AccessError(400, '设备公钥无效。'); }
}

function publicText(key) {
  return key.export({ type: 'spki', format: 'der' }).toString('base64url');
}

function remember(map, id, value) {
  const now = Date.now();
  for (const [key, existing] of map) if (existing.expires < now) map.delete(key);
  if (map.size >= 256) map.delete(map.keys().next().value);
  map.set(id, value);
}

function iv(direction, sequence) {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(direction);
  value.writeBigUInt64BE(BigInt(sequence), 4);
  return value;
}

function aad(session, direction, sequence) {
  return Buffer.from([CONTEXT, session, direction, sequence].join('\n'));
}

function seal(key, session, sequence, value) {
  const cipher = createCipheriv('aes-256-gcm', key, iv(1, sequence));
  cipher.setAAD(aad(session, 1, sequence));
  return Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}

function open(key, session, sequence, message) {
  try {
    const bytes = Buffer.from(message, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key, iv(0, sequence));
    cipher.setAAD(aad(session, 0, sequence));
    cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString('utf8'));
  } catch { throw new AccessError(401, '手机会话校验失败，请重连。'); }
}

export class AndroidAccess {
  constructor({ runtime, sessions, origin }) {
    this.identityFile = path.join(runtime, 'android-identity.pem');
    this.sessions = sessions;
    this.origin = origin;
    this.challenges = new Map();
    this.leases = new Map();
    this.localGrants = new Map();
  }

  identity() {
    if (this.signingKey) return this.signingKey;
    try { this.signingKey = createPrivateKey(readFileSync(this.identityFile)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
      try {
        writeFileSync(this.identityFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
        this.signingKey = privateKey;
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        this.signingKey = createPrivateKey(readFileSync(this.identityFile));
      }
    }
    return this.signingKey;
  }

  publicIdentity() {
    return publicText(createPublicKey(this.identity()));
  }

  challenge(input) {
    const { device = '', enroll = false, nonce, key, ephemeral } = input;
    if (typeof nonce !== 'string' || !TOKEN.test(nonce) || typeof device !== 'string' ||
        typeof enroll !== 'boolean' || (enroll ? device !== '' : !DEVICE_ID.test(device))) {
      throw new AccessError(400, '手机配对参数无效。');
    }
    const signingKey = publicKey(key);
    const peerEphemeral = publicKey(ephemeral);
    const server = generateKeyPairSync('ec', { namedCurve: CURVE });
    const serverKey = publicText(server.publicKey);
    const id = token();
    const transcript = [CONTEXT, id, nonce, enroll ? 'enroll' : 'resume', device, key, ephemeral, serverKey].join('\n');
    const salt = Buffer.alloc(0);
    const shared = diffieHellman({ privateKey: server.privateKey, publicKey: peerEphemeral });
    const secret = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(transcript), 32));
    remember(this.challenges, id, { signingKey, key, device, transcript, secret, expires: Date.now() + CHALLENGE_TTL });
    return { id, ephemeral: serverKey, signature: sign('sha256', transcript, this.identity()).toString('base64url') };
  }

  connect({ id, signature, enrollment }) {
    const { challenges, sessions, leases } = this;
    const attempt = challenges.get(id);
    challenges.delete(id);
    if (!attempt || attempt.expires < Date.now() || typeof signature !== 'string' ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(signature) ||
        !verify('sha256', attempt.transcript, attempt.signingKey, Buffer.from(signature, 'base64url'))) {
      throw new AccessError(401, '手机设备验证失败，请重试。');
    }
    const session = token();
    let device;
    if (attempt.device) {
      device = sessions.mobileDevice(attempt.device);
      if (device?.mobileKey !== attempt.key) {
        return { session, message: seal(attempt.secret, session, 0, { role: 'revoked' }) };
      }
    } else {
      const input = open(attempt.secret, id, 0, enrollment);
      if (typeof input?.pair !== 'string' || !TOKEN.test(input.pair) || typeof input.name !== 'string' || input.name.length > 80) {
        throw new AccessError(400, '手机配对参数无效。');
      }
      try { device = sessions.claim(input.pair, input.name || 'Android 手机', attempt.key).item; }
      catch (error) {
        if (!(error instanceof AccessError)) throw error;
        return { session, message: seal(attempt.secret, session, 0, { role: 'expired', error: error.message }) };
      }
    }
    remember(leases, session, { device: device.id, secret: attempt.secret, seq: 0, expires: Date.now() + LEASE_TTL });
    return { session, message: seal(attempt.secret, session, 0, { device: device.id, role: device.role }) };
  }

  sessionForLocalRequest(grant) {
    return this.sessions.mobileDevice(this.localGrants.get(grant));
  }

  async exchange({ session, sequence, message }) {
    const lease = this.leases.get(session);
    if (!lease || lease.expires < Date.now() || !Number.isSafeInteger(sequence) || sequence <= lease.seq ||
        typeof message !== 'string') {
      throw new AccessError(401, '手机会话已失效，请重连。');
    }
    const request = open(lease.secret, session, sequence, message);
    lease.seq = sequence;
    const reply = value => ({ message: seal(lease.secret, session, sequence, value) });
    const device = this.sessions.mobileDevice(lease.device);
    if (!device) return reply({ status: 403, revoked: true, data: { error: '设备绑定已解除。' } });
    try {
      const response = await this.forward(request, device);
      if (!this.sessions.mobileDevice(lease.device)) return reply({ status: 403, revoked: true, data: { error: '设备绑定已解除。' } });
      return reply(response);
    } catch (error) {
      if (error instanceof AccessError) return reply({ status: error.status, data: { error: error.message } });
      throw error;
    }
  }

  async forward(request, device) {
    const { method, path: target } = request || {};
    const origin = this.origin();
    if (typeof target !== 'string' || target.length > 8192 || !target.startsWith('/api/')) throw new AccessError(404, '此手机操作不可用。');
    const url = new URL(target, origin);
    if (url.origin !== origin || url.hash || !(method === 'GET' && READ.test(url.pathname) || method === 'POST' && WRITE.test(url.pathname))) {
      throw new AccessError(404, '此手机操作不可用。');
    }
    if (device.role !== 'controller' && !(method === 'GET' && url.pathname === '/api/bootstrap')) {
      throw new AccessError(401, '请先在电脑上批准这个设备。');
    }
    const grant = token();
    const headers = { 'X-Codex-Android-Grant': grant, 'X-CSRF-Token': device.csrf };
    let body;
    if (method === 'POST' && url.pathname === '/api/attachments') {
      const file = request.upload;
      if (typeof file?.name !== 'string' || !file.name || file.name.length > 240 || typeof file.bytes !== 'string') {
        throw new AccessError(400, '附件信息无效。');
      }
      body = Buffer.from(file.bytes, 'base64url');
      if (!body.length || body.length > MAX_UPLOAD) throw new AccessError(413, 'Android 单个附件最大 8 MiB。');
      headers['Content-Type'] = 'application/octet-stream';
      headers['X-File-Name'] = encodeURIComponent(file.name);
    } else if (method === 'POST') {
      body = JSON.stringify(request.body || {});
      headers['Content-Type'] = 'application/json';
    }
    if (method === 'GET' && /\/(download|content)$/.test(url.pathname)) {
      const range = /^bytes=(\d{1,15})-(\d{1,15})$/.exec(request.range || '');
      if (!range || Number(range[2]) < Number(range[1]) || Number(range[2]) - Number(range[1]) >= 1048576) {
        throw new AccessError(400, '手机文件读取需要指定文件区段。');
      }
      headers.Range = range[0];
    }
    this.localGrants.set(grant, device.id);
    try {
      const response = await fetch(url, { method, body, headers, redirect: 'error', signal: AbortSignal.timeout(45_000) });
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > MAX_REPLY) throw new AccessError(413, '此结果过大，请分段读取。');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const mime = response.headers.get('content-type') || '';
      if (mime.startsWith('application/json')) return { status: response.status, data: JSON.parse(data) };
      return { status: response.status, content: data.toString('base64url'), mime, range: response.headers.get('content-range') };
    } finally {
      this.localGrants.delete(grant);
    }
  }
}
