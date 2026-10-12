import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AccessError } from './security.mjs';

export const MOBILE_PERMISSION_DEFAULTS = Object.freeze({
  allowMobileApprovals: false,
  allowMobileStop: false,
  allowOtherFiles: false,
});
const labels = {
  allowMobileApprovals: '电脑尚未允许手机处理任务审批，请在电脑设置中开启。',
  allowMobileStop: '电脑尚未允许手机停止任务，请在电脑设置中开启。',
  allowOtherFiles: '电脑尚未允许手机访问其他目录，请在电脑设置中开启。',
};

export class MobilePermissions {
  constructor(directory) {
    this.file = path.join(directory, 'mobile-permissions.json');
    this.state = { ...MOBILE_PERMISSION_DEFAULTS };
    mkdirSync(directory, { recursive: true });
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8'));
      this.validate(stored);
      this.state = { ...this.state, ...stored };
    } catch { /* Missing or damaged settings never grant mobile privileges. */ }
  }

  validate(value) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !Object.hasOwn(MOBILE_PERMISSION_DEFAULTS, key) || typeof value[key] !== 'boolean')) {
      throw new AccessError(400, '权限设置只接受已知的布尔开关。');
    }
  }

  view(role) { return { ...this.state, canManage: role === 'owner' }; }

  require(role, key) {
    if (!Object.hasOwn(MOBILE_PERMISSION_DEFAULTS, key)) throw new AccessError(400, '未知权限。');
    if (role === 'owner') return;
    if (role !== 'controller') throw new AccessError(401, '请先连接并授权当前设备。');
    if (!this.state[key]) throw new AccessError(403, labels[key]);
  }

  configure(patch) {
    this.validate(patch);
    const next = { ...this.state, ...patch }, temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
    this.state = next;
    return this.view('owner');
  }
}
