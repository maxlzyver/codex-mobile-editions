import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
export class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Sessions {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'devices.json');
    this.ownerToken = token();
    this.items = new Map();
    this.pairings = new Map();
    this.attempts = new Map();
    try {
      for (const s of JSON.parse(readFileSync(this.file, 'utf8'))) {
        if (s.role === 'controller' && s.expiresAt > Date.now()) this.items.set(s.hash, s);
      }
    } catch {}
  }
  save() {
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify([...this.items.values()].filter(s => s.role === 'controller'), null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  create(role, name) {
    const secret = token();
    const item = { id: randomBytes(12).toString('hex'), hash: digest(secret), role, name: String(name || '手机浏览器').slice(0, 80), csrf: token(), createdAt: Date.now(), lastSeen: Date.now(), expiresAt: Date.now() + (role === 'pending' ? 300000 : 30 * 86400000) };
    this.items.set(item.hash, item);
    return { secret, item };
  }
  get(cookie = '', name) {
    const match = cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
    if (!match) return null;
    const s = this.items.get(digest(match.slice(name.length + 1)));
    if (!s || s.expiresAt < Date.now() || s.role === 'revoked') return null;
    s.lastSeen = Date.now();
    return s;
  }
  newPairing(mode, baseUrl) {
    const value = token();
    const pairing = { token: value, mode, baseUrl, expiresAt: Date.now() + 120000 };
    this.pairings.set(mode, pairing);
    return pairing;
  }
  claim(value, name, mobileKey = null) {
    for (const [mode, p] of this.pairings) {
      if (p.expiresAt > Date.now() && equal(p.token, value)) {
        this.pairings.delete(mode);
        const created = this.create('pending', name);
        if (mobileKey) created.item.mobileKey = mobileKey;
        return created;
      }
    }
    throw new AccessError(401, '二维码已过期或已使用，请在电脑端刷新后重新扫码。');
  }
  mobileDevice(id) {
    const device = [...this.items.values()].find(item => item.id === id && item.mobileKey &&
      ['pending', 'controller'].includes(item.role) && item.expiresAt > Date.now());
    if (device) device.lastSeen = Date.now();
    return device || null;
  }
  rate(key) {
    const now = Date.now();
    for (const [k, v] of this.attempts) if (now - v.since > 60000) this.attempts.delete(k);
    const a = this.attempts.get(key) || { since: now, count: 0 };
    if (++a.count > 15) throw new AccessError(429, '尝试次数过多，请稍后重试。');
    this.attempts.set(key, a);
  }
  devices() {
    return [...this.items.values()].filter(s => s.role !== 'owner' && s.role !== 'revoked' && s.expiresAt > Date.now()).map(({ id, name, role, createdAt, lastSeen, mobileKey }) => ({ id, name, status: role === 'controller' ? 'approved' : role, createdAt, lastSeen, ...(mobileKey ? { type: 'android' } : {}) }));
  }
  change(id, role) {
    const s = [...this.items.values()].find(v => v.id === id && v.role !== 'owner');
    if (!s || s.expiresAt < Date.now()) throw new AccessError(404, '设备不存在或请求已过期。');
    if (role === 'controller' && s.role !== 'pending') throw new AccessError(409, '设备不在等待确认状态。');
    const previous = { role: s.role, expiresAt: s.expiresAt };
    s.role = role;
    s.expiresAt = s.mobileKey && role === 'controller' ? Number.MAX_SAFE_INTEGER : Date.now() + 30 * 86400000;
    try { this.save(); }
    catch (error) { Object.assign(s, previous); throw error; }
  }
}
