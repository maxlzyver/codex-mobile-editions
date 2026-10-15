import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, copyFile, lstat, rm, open } from 'node:fs/promises';
import { readJson, writeJson, noLinks, materializeMcp } from './config.mjs';

const REPOSITORY = 'maxlzyver/codex-mobile-editions';
const PREFIX = 'plugins/codex-mobile';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[a-f0-9]{64}$/;
const ROOT_FILES = new Set(['plugin.json', 'mcp.json', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Install-Plugin.ps1', 'Install-Plugin.command']);
const REQUIRED = ['plugin.json', '.codex-plugin/plugin.json', 'package.json', 'mcp.json', 'dist/server.mjs', 'ui/app.html', 'skills/mobile/SKILL.md', 'skills/setup/SKILL.md'];
export function compareVersions(a, b) {
  if (!VERSION.test(a || '') || !VERSION.test(b || '')) throw new Error('无效插件版本。');
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
export function validatePluginPath(filename) {
  if (typeof filename !== 'string' || filename.length > 220 || /[\\\u0000-\u001f<>:"|?*]/.test(filename)) throw new Error('插件更新包含无效路径。');
  const parts = filename.split('/');
  if (parts.some(v => !v || v === '.' || v === '..' || /[. ]$/.test(v) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v))
    || !(parts.length === 1 ? ROOT_FILES.has(filename) : ['lib', 'dist', 'ui', 'scripts', 'skills', 'assets', 'licenses'].includes(parts[0]) || filename === '.codex-plugin/plugin.json')
    || parts.some(v => ['.runtime', '.git', '.env', 'node_modules', 'config.json', 'owner-url.txt', 'devices.json', 'auth.json', 'credentials.json'].includes(v))
    || /\.(?:log|sqlite|db|key|pem|pfx)$/i.test(filename)) throw new Error('插件更新路径超出程序白名单。');
  return filename;
}
export function validateManifest(manifest) {
  if (manifest?.schema !== 1 || manifest.name !== 'codex-mobile' || !VERSION.test(manifest.version || '') || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 300) throw new Error('插件更新清单无效。');
  const seen = new Set(); let total = 0;
  for (const file of manifest.files) {
    validatePluginPath(file.path); const key = file.path.toLowerCase();
    if (seen.has(key) || !HASH.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 8 * 1024 * 1024) throw new Error('插件更新清单的文件信息无效。');
    seen.add(key); total += file.bytes;
  }
  if (total > 24 * 1024 * 1024 || REQUIRED.some(name => !seen.has(name.toLowerCase()))) throw new Error('插件更新缺少必要文件或超过大小限制。');
  return manifest;
}
async function bounded(response, limit) {
  if (!response.ok) throw new Error(`插件更新下载失败 (${response.status})。`);
  if (Number(response.headers?.get('content-length')) > limit) throw new Error('插件更新响应过大。');
  if (!response.body?.getReader) { const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > limit) throw new Error('插件更新响应过大。'); return buffer; }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) { await reader.cancel(); throw new Error('插件更新响应过大。'); } chunks.push(Buffer.from(next.value)); }
  return Buffer.concat(chunks);
}
const hash = data => createHash('sha256').update(data).digest('hex');

export class PluginUpdater {
  constructor({ rootDir, dataDir, config, loadedVersion, isBusy = async () => true, fetchImpl = fetch, refreshHost, intervalMs = 6 * 60 * 60 * 1000, retryMs = 60000 }) {
    Object.assign(this, { rootDir, dataDir, config, loadedVersion, isBusy, fetch: fetchImpl, refreshHost, intervalMs, retryMs });
    this.state = { loadedVersion, installedVersion: loadedVersion, latestVersion: null, autoUpdate: false, status: 'idle', hasUpdate: false, pendingRestart: false, checkedAt: null, releaseNotes: '', error: null, hostRefresh: null };
    this.operation = null; this.timer = null; this.closed = false; this.candidate = null; this.settingsGeneration = 0; this.manualPending = false;
    this.ready = this.refreshSharedState();
  }
  async refreshSharedState() {
    // Every Codex surface can have its own stdio process. Settings and the source
    // identity belong to their shared stable directory, not to one process.
    const generation = this.settingsGeneration;
    let autoUpdate = false;
    try { autoUpdate = (await readJson(path.join(this.dataDir, 'update-settings.json'))).autoUpdate === true; } catch { }
    if (generation === this.settingsGeneration) this.state.autoUpdate = autoUpdate;
    if (!this.config?.pluginSourceRoot || (this.operation && ['downloading', 'installing'].includes(this.state.status))) return this.getState();
    const locked = async () => { try { await lstat(path.join(this.dataDir, 'plugin-update.lock')); return true; } catch (error) { return error.code !== 'ENOENT'; } };
    try {
      // The root identity is written before the transaction metadata. Do not
      // announce it while another process can still roll back the transaction.
      if (await locked()) return this.getState();
      const pkg = await readJson(path.join(this.config.pluginSourceRoot, 'plugin.json'));
      if (pkg.name !== 'codex-mobile' || !VERSION.test(pkg.version) || await locked()) return this.getState();
      const changed = pkg.version !== this.state.installedVersion;
      this.state.installedVersion = pkg.version;
      this.state.pendingRestart = compareVersions(pkg.version, this.loadedVersion) > 0;
      this.state.hasUpdate = VERSION.test(this.state.latestVersion || '') && compareVersions(this.state.latestVersion, pkg.version) > 0;
      if (!this.operation && (changed || ['available', 'waiting', 'current', 'pending_restart'].includes(this.state.status))) {
        const waiting = this.state.status === 'waiting' && (this.manualPending || this.state.autoUpdate);
        this.state.status = this.state.hasUpdate ? waiting ? 'waiting' : 'available' : this.state.pendingRestart ? 'pending_restart' : this.state.latestVersion ? 'current' : 'idle';
        if (!this.state.hasUpdate) this.manualPending = false;
        if (changed) { this.state.error = null; this.state.hostRefresh = null; }
      } else if (!this.operation && this.state.pendingRestart && this.state.status === 'idle') this.state.status = 'pending_restart';
    } catch { /* A missing/unreadable source keeps the last confirmed version. */ }
    return this.getState();
  }
  getState() { return structuredClone(this.state); }
  patch(value) { Object.assign(this.state, value); return this.getState(); }
  async source() {
    const source = this.config?.pluginSourceRoot;
    if (typeof source !== 'string' || !path.isAbsolute(source) || /[\\/]\.codex[\\/]plugins[\\/]cache(?:[\\/]|$)/i.test(source)) throw new Error('请先绑定稳定的插件源目录；不能直接更新 Codex 插件缓存。');
    await noLinks(source); await noLinks(this.dataDir);
    const identity = await readJson(path.join(source, 'plugin.json'));
    if (identity.name !== 'codex-mobile' || !VERSION.test(identity.version)) throw new Error('插件源目录身份无效。');
    return source;
  }
  async request(url, limit) { return bounded(await this.fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'codex-mobile-plugin' } }), limit); }
  async check() {
    await this.ready;
    await this.refreshSharedState();
    if (this.operation) return this.getState();
    this.operation = (async () => {
      this.patch({ status: 'checking', error: null });
      try {
        await this.source();
        const commit = JSON.parse((await this.request(`https://api.github.com/repos/${REPOSITORY}/commits/main`, 256000)).toString()).sha;
        if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('插件发布提交无效。');
        const manifest = validateManifest(JSON.parse((await this.request(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${PREFIX}/update.json`, 512000)).toString()));
        this.candidate = { commit, manifest };
        await this.refreshSharedState();
        const hasUpdate = compareVersions(manifest.version, this.state.installedVersion) > 0;
        return this.patch({ latestVersion: manifest.version, checkedAt: Date.now(), releaseNotes: String(manifest.releaseNotes || '').slice(0, 12000), hasUpdate,
          status: hasUpdate ? 'available' : this.state.pendingRestart ? 'pending_restart' : 'current' });
      } catch (error) { this.patch({ status: 'error', error: error.message }); throw error; }
    })().finally(() => { this.operation = null; });
    return this.operation;
  }
  async lock() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 }); const filename = path.join(this.dataDir, 'plugin-update.lock'); await noLinks(filename);
    for (let i = 0; i < 2; i++) {
      try { const handle = await open(filename, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close(); return () => rm(filename, { force: true }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stale = false;
        try { const previous = await readJson(filename); if (!Number.isInteger(previous.pid) || previous.pid < 2) throw new Error('无效更新锁'); process.kill(previous.pid, 0); } catch (failure) { stale = failure.code === 'ESRCH'; }
        if (!stale) throw new Error('另一个插件会话正在更新，请稍后再试。'); await rm(filename);
      }
    }
    throw new Error('无法取得插件更新锁。');
  }
  async install({ automatic = false } = {}) {
    await this.ready;
    await this.refreshSharedState();
    if (this.operation) return this.getState();
    if (!this.candidate) await this.check();
    if (!this.state.hasUpdate) { this.manualPending = false; return this.getState(); }
    if (!automatic) this.manualPending = true;
    this.operation = (async () => {
      let unlock, job; const committed = [];
      try {
        const source = await this.source(); unlock = await this.lock();
        const actual = await readJson(path.join(source, 'plugin.json'));
        if (compareVersions(this.candidate.manifest.version, actual.version) <= 0) { this.manualPending = false; return this.patch({ installedVersion: actual.version, hasUpdate: false, pendingRestart: actual.version !== this.loadedVersion, status: actual.version !== this.loadedVersion ? 'pending_restart' : 'current' }); }
        if (await this.isBusy()) { this.schedule(this.retryMs); return this.patch({ status: 'waiting', error: null }); }
        const { commit, manifest } = this.candidate;
        job = path.join(this.dataDir, 'updates', `plugin-${Date.now()}-${randomBytes(4).toString('hex')}`);
        await mkdir(path.join(job, 'stage'), { recursive: true, mode: 0o700 });
        this.patch({ status: 'downloading', error: null });
        for (const file of manifest.files) {
          const content = await this.request(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${PREFIX}/${file.path}`, file.bytes + 1);
          if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error(`插件文件校验失败：${file.path}`);
          const target = path.join(job, 'stage', file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
        }
        const nextIdentity = await readJson(path.join(job, 'stage/plugin.json'));
        if (nextIdentity.name !== 'codex-mobile' || nextIdentity.version !== manifest.version) throw new Error('插件包身份与清单不一致。');
        const compatibility = await readJson(path.join(job, 'stage/.codex-plugin/plugin.json')), packageIdentity = await readJson(path.join(job, 'stage/package.json'));
        if (compatibility.name !== 'codex-mobile' || compatibility.version !== manifest.version || compatibility.mcpServers !== './mcp.json' || compatibility.skills !== './skills/'
          || packageIdentity.name !== 'codex-mobile-plugin' || packageIdentity.version !== manifest.version) throw new Error('插件兼容清单或 package.json 的身份/版本与更新清单不一致。');
        const mcp = materializeMcp(await readJson(path.join(job, 'stage/mcp.json')), this.config, this.dataDir);
        await writeJson(path.join(job, 'stage/mcp.json'), mcp);
        if (await this.isBusy()) { this.schedule(this.retryMs); return this.patch({ status: 'waiting' }); }
        this.patch({ status: 'installing' });
        // Commit the identity last, after the complete code, UI and skill set.
        const files = [...manifest.files].sort((a, b) => Number(a.path === 'plugin.json') - Number(b.path === 'plugin.json'));
        for (const file of files) {
          const target = path.join(source, file.path), backup = path.join(job, 'backup', file.path); await noLinks(target);
          let existed = false;
          try { if (!(await lstat(target)).isFile()) throw new Error('插件目标不是普通文件。'); existed = true; await mkdir(path.dirname(backup), { recursive: true }); await copyFile(target, backup); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await mkdir(path.dirname(target), { recursive: true });
          const temp = `${target}.update-${process.pid}`; await copyFile(path.join(job, 'stage', file.path), temp);
          try { await rename(temp, target); } catch (error) { await rm(temp, { force: true }); throw error; }
          committed.push({ target, backup, existed });
        }
        for (const [target, value, marker] of [[path.join(source, 'update.json'), manifest, 'update.json'], [path.join(this.dataDir, 'last-update.json'), { version: manifest.version, sourceCommit: commit, installedAt: Date.now() }, 'last-update.json']]) {
          await noLinks(target); const backup = path.join(job, 'metadata-backup', marker); let existed = false;
          try { if (!(await lstat(target)).isFile()) throw new Error('插件更新状态目标不是普通文件。'); existed = true; await mkdir(path.dirname(backup), { recursive: true }); await copyFile(target, backup); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          committed.push({ target, backup, existed }); await writeJson(target, value);
        }
        let hostRefresh = '需要在 Codex 中重新加载插件或重启后生效。';
        if (this.refreshHost) {
          try { await this.refreshHost(); hostRefresh = '已刷新宿主插件安装；当前会话仍需重新加载或重启 Codex。'; }
          catch { hostRefresh = '插件源已更新，宿主刷新未完成。请在插件目录重新加载后重启 Codex。'; }
        }
        this.manualPending = false;
        return this.patch({ installedVersion: manifest.version, hasUpdate: false, pendingRestart: manifest.version !== this.loadedVersion, status: 'pending_restart', hostRefresh });
      } catch (error) {
        this.manualPending = false;
        let rollbackFailed = false;
        for (const file of committed.reverse()) { try { if (file.existed) await copyFile(file.backup, file.target); else await rm(file.target, { force: true }); } catch { rollbackFailed = true; } }
        this.patch({ status: 'error', error: rollbackFailed ? '插件更新失败且回滚未完成，请重新运行安装工具。' : error.message }); throw error;
      } finally { if (unlock) await unlock(); }
    })().finally(() => { this.operation = null; });
    return this.operation;
  }
  async configure({ autoUpdate }) {
    if (typeof autoUpdate !== 'boolean') throw new Error('autoUpdate 必须是布尔值。'); await this.ready;
    this.settingsGeneration++;
    await writeJson(path.join(this.dataDir, 'update-settings.json'), { autoUpdate }); this.settingsGeneration++;
    this.patch({ autoUpdate }); this.schedule(0); return this.getState();
  }
  schedule(ms) { if (this.timer) clearTimeout(this.timer); if (!this.closed) { this.timer = setTimeout(() => this.cycle(), ms); this.timer.unref(); } }
  async cycle() {
    await this.ready; if (this.closed) return;
    let next = this.intervalMs;
    try { await this.refreshSharedState(); if (this.operation) { next = this.retryMs; return; } await this.check(); await this.refreshSharedState(); if ((this.manualPending || this.state.autoUpdate) && this.state.hasUpdate) { await this.install({ automatic: !this.manualPending }); if (this.state.status === 'waiting') next = this.retryMs; } }
    catch { next = this.intervalMs; }
    finally { this.schedule(next); }
  }
  startChecking() { this.schedule(1000); }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); }
}
