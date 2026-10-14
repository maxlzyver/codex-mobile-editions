import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, validateInstallation } from './config.mjs';

export class Backend {
  constructor(config, { fetchImpl = fetch, spawnProcess = spawn, validate = validateInstallation } = {}) {
    this.config = config; this.fetch = fetchImpl; this.spawn = spawnProcess; this.validate = validate;
    this.auth = null; this.starting = null;
  }
  async identity() {
    if (!this.config?.installationRoot) throw new Error('请先安装并绑定 Editions 完整版。');
    const { root, profile, nodePath } = await this.validate(this.config.installationRoot);
    const state = await readJson(path.join(root, '.runtime/server.json'));
    if (path.resolve(state.root) !== root || !Number.isSafeInteger(state.pid) || state.pid < 2 || !Number.isInteger(state.port) || state.port < 1024 || state.port > 65535) throw new Error('助手服务身份无效，请重新启动助手。');
    try { process.kill(state.pid, 0); } catch { throw new Error('助手后台尚未运行。'); }
    const origin = `http://127.0.0.1:${state.port}`;
    const response = await this.fetch(origin + '/health', { signal: AbortSignal.timeout(4000), redirect: 'error' });
    const health = await response.json();
    if (!response.ok || health.app !== 'codex-mobile' || health.version !== profile.version) throw new Error('后台版本或服务身份与安装目录不一致。');
    return { root, profile, nodePath, state, origin };
  }
  async ensureStarted() {
    try { return await this.identity(); } catch { /* A stopped instance can be started through its edition launcher. */ }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!this.config?.installationRoot) throw new Error('请先安装并绑定 Editions 完整版。');
      const { root, nodePath, profile } = await this.validate(this.config.installationRoot);
      const isMac = profile.id === 'macos';
      const command = isMac ? nodePath : path.join(root, 'Codex-Mobile.exe');
      const args = isMac ? [path.join(root, 'lib/mac-launcher.mjs'), root, 'start', '--headless'] : ['--headless'];
      const child = this.spawn(command, args, { cwd: root, detached: true, windowsHide: true, shell: false, stdio: 'ignore', env: { ...process.env, ...(this.config.codexBinary ? { CODEX_BINARY: this.config.codexBinary } : {}), ...(this.config.defaultCwd ? { CODEX_MOBILE_CWD: this.config.defaultCwd } : {}) } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      for (let attempt = 0; attempt < 100; attempt++) { await delay(250); try { return await this.identity(); } catch { } }
      throw new Error('助手后台启动超时。请检查完整包、Codex 登录、工作目录和系统版本。');
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
  async session(identity) {
    if (this.auth?.pid === identity.state.pid && this.auth?.startedAt === identity.state.startedAt) return this.auth;
    const owner = new URL((await readFile(path.join(identity.root, '.runtime/owner-url.txt'), 'utf8')).trim());
    if (owner.origin !== identity.origin || owner.pathname !== '/' || owner.search || !/^#owner=[\w-]+$/.test(owner.hash)) throw new Error('本机管理认证信息无效，请重启助手。');
    const response = await this.fetch(identity.origin + '/api/owner-login', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', origin: identity.origin }, body: JSON.stringify({ token: owner.hash.slice(7) }) });
    if (!response.ok) throw new Error('无法验证本机管理身份。');
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie || !/^codex_mobile_\d+=[\w-]+$/.test(cookie)) throw new Error('助手未返回有效管理会话。');
    const bootstrapResponse = await this.fetch(identity.origin + '/api/bootstrap', { headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    const bootstrap = await bootstrapResponse.json();
    if (!bootstrapResponse.ok || bootstrap.role !== 'owner' || typeof bootstrap.csrfToken !== 'string') throw new Error('本机管理会话无法确认。');
    this.auth = { cookie, csrf: bootstrap.csrfToken, pid: identity.state.pid, startedAt: identity.state.startedAt }; return this.auth;
  }
  async request(route, body, { start = false, retry = true } = {}) {
    const identity = start ? await this.ensureStarted() : await this.identity(), auth = await this.session(identity);
    const response = await this.fetch(identity.origin + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { cookie: auth.cookie, origin: identity.origin, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': auth.csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401 && retry) { this.auth = null; return this.request(route, body, { start, retry: false }); }
    const data = await response.json();
    if (!response.ok) throw new Error(String(data.error || `助手请求失败 (${response.status})`).replace(/#owner=[\w-]+/g, '#owner=[hidden]').slice(0, 600));
    return data;
  }
  async status({ start = false } = {}) { return this.request('/api/plugin/status', undefined, { start }); }
  async busy() { try { return (await this.status()).busy !== false; } catch { return true; } }
  async diagnose() {
    const result = { configured: Boolean(this.config?.installationRoot), checks: [] };
    if (!result.configured) { result.checks.push({ name: '安装绑定', ok: false, message: '运行安装绑定工具后重新加载插件。' }); return result; }
    try {
      const installation = await this.validate(this.config.installationRoot);
      result.checks.push({ name: '安装与 Node.js', ok: true, message: `${installation.profile.id} ${installation.profile.version}` });
      const status = await this.status();
      result.checks.push({ name: '后台与本机认证', ok: true, message: '可用' }, { name: 'Codex 连接', ok: status.status?.codex === 'connected', message: status.status?.error || status.status?.codex || '未知' },
        { name: '互联网连接', ok: status.connection?.tunnelStatus === 'running', message: status.connection?.tunnelError || status.connection?.tunnelStatus || '未启用' });
    } catch (error) { result.checks.push({ name: '后台检查', ok: false, message: error.message }); }
    return result;
  }
}
