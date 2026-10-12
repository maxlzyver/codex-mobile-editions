import { EventEmitter } from 'node:events';
import https from 'node:https';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

export const UPDATE_REPOSITORY = 'maxlzyver/codex-mobile-editions';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const REPOSITORY_COMMIT_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/commits/main`;
const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_RELEASE_NOTES = 12000;
const checksum = value => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value);

export class UpdateError extends Error {
  constructor(status, message, code = 'UPDATE_ERROR') { super(message); this.status = status; this.code = code; }
}

export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/.exec(value);
  if (!match) return null;
  const prerelease = match[5]?.split('.') || [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { version: match[1], numbers: [match[2], match[3], match[4]].map(BigInt), prerelease };
}

export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new UpdateError(400, '版本号不是有效的 SemVer。');
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1;
  if (!left.prerelease.length || !right.prerelease.length) return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i], y = right.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

const EDITIONS = Object.freeze({ windows11: { platform: 'Windows 11 x64', architecture: 'x64' }, windows10: { platform: 'Windows 10 x64', architecture: 'x64' }, macos: { platform: 'macOS universal', architecture: 'universal' } });

export function editionAssetName(profile, version) {
  if (!Object.hasOwn(EDITIONS, profile?.id || '') || !parseVersion(version)) throw new UpdateError(400, '系统专用版或版本号无效。');
  return 'codex-mobile-' + profile.id + '-' + version + '-' + EDITIONS[profile.id].architecture + '.zip';
}

export function readEditionProfile(rootDir) {
  const filename = path.join(path.resolve(rootDir), 'edition.json');
  let profile;
  try {
    if (statSync(filename).size > 16384) throw new Error('oversized');
    profile = JSON.parse(readFileSync(filename, 'utf8'));
  } catch { throw new UpdateError(400, '缺少有效的本机 edition.json，不能确定此程序所属系统。'); }
  const known = Object.hasOwn(EDITIONS, profile?.id || '') ? EDITIONS[profile.id] : null, version = parseVersion(profile?.version);
  if (!known || !version || version.prerelease.length || version.version !== profile.version || profile.platform !== known.platform
    || profile.repository !== UPDATE_REPOSITORY || profile.updatePath !== 'editions/' + profile.id
    || profile.assetName !== editionAssetName(profile, profile.version)) throw new UpdateError(400, '本机 edition.json 的系统、仓库、路径或资产身份不一致。');
  return Object.freeze({ ...profile });
}

function safeError(error, localPaths = []) {
  let message = String(error?.message || error || '更新失败');
  for (const local of [...localPaths].sort((a, b) => b.length - a.length)) {
    message = message.split(local).join('[本地程序目录]').split(local.replaceAll('\\', '/')).join('[本地程序目录]');
  }
  return message.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@').replace(/([?&](?:token|sig|signature|credential)=[^&\s]*)/gi, '[redacted]').slice(0, 700);
}

// Uses the same Node 24 proxy support as the other network components. No GitHub
// credential, release body, or remote command is ever consumed by this module.
function defaultFetch(url, { headers, signal } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ proxyEnv: process.env });
    const req = https.get(url, { headers, signal, agent }, response => {
      response.once('close', () => agent.destroy());
      resolve({ status: response.statusCode, headers: { get: name => response.headers[name.toLowerCase()] ?? null }, body: response });
    });
    req.once('error', error => { agent.destroy(); reject(error); });
  });
}

async function hashFile(filename, maxBytes = MAX_ARCHIVE) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(filename)) { size += chunk.length; if (size > maxBytes) throw new UpdateError(502, '本地更新文件超过大小限制。'); hash.update(chunk); }
  return { sha256: hash.digest('hex'), size };
}

function validateRepositoryManifest(manifest, profile) {
  const version = parseVersion(manifest?.version);
  if (!version || version.version !== manifest.version || version.prerelease.length || manifest.repository !== UPDATE_REPOSITORY || manifest.platform !== profile.platform || manifest.edition !== profile.id) throw new UpdateError(502, '仓库 update.json 的稳定版本、仓库或平台不正确。');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000) throw new UpdateError(502, '仓库更新清单缺少有效文件列表。');
  if (manifest.runtimePolicy !== undefined && manifest.runtimePolicy !== 'preserve') throw new UpdateError(502, '仓库清单的运行库更新策略无效。');
  if (manifest.releaseNotes !== undefined && (typeof manifest.releaseNotes !== 'string' || manifest.releaseNotes.length > MAX_RELEASE_NOTES
    || Buffer.byteLength(manifest.releaseNotes, 'utf8') > 48000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(manifest.releaseNotes))) throw new UpdateError(502, '仓库更新说明必须是长度受限的纯文本。');
  const paths = new Set(); let size = 0;
  for (const file of manifest.files) {
    const filename = file?.path;
    if (typeof filename !== 'string' || filename.length > 240 || /[\\:<>"|?*\x00-\x1f\x7f]/.test(filename) || filename.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) || filename.toLowerCase() === 'update.json' || paths.has(filename.toLowerCase())) throw new UpdateError(502, '仓库更新清单包含不安全或重复的文件路径。');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !checksum(file.sha256)) throw new UpdateError(502, '仓库文件大小或 SHA256 无效。');
    paths.add(filename.toLowerCase()); size += file.bytes;
    if (size > 1024 * 1024 * 1024) throw new UpdateError(502, '仓库解压文件总大小超过限制。');
  }
  if (!paths.has('edition.json')) throw new UpdateError(502, '仓库更新缺少 edition.json 身份文件。');
  return version;
}

export class UpdateManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rootDir = path.resolve(options.rootDir || process.cwd());
    this.profile = readEditionProfile(this.rootDir);
    const current = parseVersion(this.profile.version);
    if (options.currentVersion !== undefined && options.currentVersion !== this.profile.version) throw new UpdateError(400, '程序版本与本机 edition.json 不一致。');
    this.runtimeDir = path.resolve(options.runtimeDir || path.join(this.rootDir, '.runtime'));
    this.directory = path.join(this.runtimeDir, 'updates');
    this.configPath = path.join(this.directory, 'settings.json');
    this.options = {
      isBusy: options.isBusy || (() => true), installPrepared: options.installPrepared,
      fetchImpl: options.fetchImpl || defaultFetch, onState: options.onState || (() => {}),
      checkIntervalMs: options.checkIntervalMs ?? 6 * 60 * 60 * 1000,
      idleRetryMs: options.idleRetryMs ?? 60000,
      requestTimeoutMs: options.requestTimeoutMs ?? 30000,
      downloadTimeoutMs: options.downloadTimeoutMs ?? 15 * 60 * 1000,
      maxArchiveBytes: Math.min(options.maxArchiveBytes ?? MAX_ARCHIVE, MAX_ARCHIVE),
      now: options.now || Date.now,
      setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    };
    mkdirSync(this.directory, { recursive: true });
    let autoUpdate = false;
    try { autoUpdate = JSON.parse(readFileSync(this.configPath, 'utf8')).autoUpdate === true; } catch {}
    this.state = { editionId: this.profile.id, platform: this.profile.platform, status: 'idle', currentVersion: current.version, latestVersion: null, autoUpdate, checkedAt: null, releaseUrl: null, releaseNotes: '', source: null, sourceCommit: null, publishedAt: null, progress: null, error: null, reason: '', hasUpdate: false, preparedVersion: null, installScheduled: false };
    this.release = null; this.prepared = null; this.operation = null; this.timer = null; this.checkTimer = null; this.checkingEnabled = false; this.closed = false; this.generation = 0; this.controllers = new Set();
    if (autoUpdate) this.schedule(0);
  }

  getState() { return structuredClone(this.state); }
  update(patch) { this.state = { ...this.state, ...patch }; const snapshot = this.getState(); this.emit('state', snapshot); this.options.onState(snapshot); return snapshot; }
  async configure({ autoUpdate } = {}) {
    if (typeof autoUpdate !== 'boolean') throw new UpdateError(400, 'autoUpdate 必须是布尔值。');
    if (this.closed) throw new UpdateError(409, '更新器已关闭。');
    const temp = `${this.configPath}.${randomBytes(5).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify({ autoUpdate }, null, 2), { mode: 0o600 });
    renameSync(temp, this.configPath);
    ++this.generation;
    if (this.timer) this.options.clearTimeout(this.timer);
    this.timer = null;
    if (this.checkTimer) this.options.clearTimeout(this.checkTimer);
    this.checkTimer = null;
    this.update({ autoUpdate });
    if (autoUpdate) this.schedule(0);
    else if (this.checkingEnabled) this.scheduleCheck(0);
    return this.getState();
  }

  // Explicitly enabled by the real server entry point, never by importing or
  // constructing a console in a test or another application. This only checks.
  startChecking() {
    if (this.closed) throw new UpdateError(409, '更新器已关闭。');
    if (this.checkingEnabled) return this.getState();
    this.checkingEnabled = true;
    this.scheduleCheck(0);
    return this.getState();
  }

  scheduleCheck(delay) {
    if (this.closed || !this.checkingEnabled || this.state.autoUpdate || this.state.installScheduled) return;
    if (this.checkTimer) this.options.clearTimeout(this.checkTimer);
    this.checkTimer = this.options.setTimeout(() => { this.checkTimer = null; return this.checkOnlyCycle().catch(() => {}); }, delay);
    this.checkTimer?.unref?.();
  }

  async checkOnlyCycle() {
    if (this.closed || !this.checkingEnabled || this.state.autoUpdate || this.state.installScheduled) return;
    const generation = this.generation;
    let delay = this.options.checkIntervalMs;
    try {
      if (this.operation) { delay = this.options.idleRetryMs; return; }
      await this.check();
    } catch { /* A failed background check records its error and waits until the next interval. */ }
    finally {
      if (generation === this.generation) this.scheduleCheck(delay);
    }
  }

  schedule(delay) {
    if (this.closed || !this.state.autoUpdate) return;
    if (this.timer) this.options.clearTimeout(this.timer);
    this.timer = this.options.setTimeout(() => { this.timer = null; this.automaticCycle().catch(() => {}); }, delay);
    this.timer?.unref?.();
  }

  async automaticCycle() {
    if (this.closed || !this.state.autoUpdate) return;
    const generation = this.generation;
    let delay = this.options.checkIntervalMs;
    try {
      if (this.operation) { delay = this.options.idleRetryMs; return; }
      if (!this.prepared && (this.state.status !== 'waitingForIdle' || !this.release)) await this.check();
      if (this.closed || !this.state.autoUpdate || generation !== this.generation) return;
      if (this.release && this.state.hasUpdate) await this.exclusive('install', () => this.installInternal({ automatic: true, generation }));
      if (this.state.status === 'waitingForIdle') delay = this.options.idleRetryMs;
    } catch { /* The operation records a user-visible failure; never silently installs after it. */ }
    finally { if (!this.state.installScheduled && !this.closed && this.state.autoUpdate && generation === this.generation) this.schedule(delay); }
  }

  exclusive(name, work) {
    if (this.closed) return Promise.reject(new UpdateError(409, '更新器已关闭。'));
    if (this.state.installScheduled && name !== 'install') return Promise.reject(new UpdateError(409, '安装器已接收更新，请等待程序重启。'));
    if (this.operation) return this.operation.name === name ? this.operation.promise : Promise.reject(new UpdateError(409, '另一个更新操作正在进行，请稍候。'));
    const promise = Promise.resolve().then(work).catch(error => {
      this.update({ status: 'error', error: safeError(error, [this.rootDir, this.runtimeDir]), reason: '更新未完成，当前程序保持原样。', progress: null });
      throw error;
    }).finally(() => { if (this.operation?.promise === promise) this.operation = null; });
    this.operation = { name, promise };
    return promise;
  }

  check() { return this.exclusive('check', () => this.checkInternal()); }
  prepare() { return this.exclusive('prepare', () => this.prepareInternal()); }
  install() { return this.exclusive('install', () => this.installInternal()); }

  validateUrl(value, { asset = false } = {}) {
    let url; try { url = new URL(value); } catch { throw new UpdateError(502, '更新下载地址无效。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) throw new UpdateError(502, '更新仅接受受信任的 HTTPS 地址。');
    const repositoryPath = '/' + UPDATE_REPOSITORY + '/';
    const manifestPattern = new RegExp('^' + repositoryPath + '[a-f0-9]{40}/' + this.profile.updatePath + '/update\\.json$');
    const archivePattern = new RegExp('^' + repositoryPath + 'zip/[a-f0-9]{40}$');
    const allowed = asset ? (url.hostname === 'raw.githubusercontent.com' && manifestPattern.test(url.pathname))
      || (url.hostname === 'codeload.github.com' && archivePattern.test(url.pathname)) : url.href === REPOSITORY_COMMIT_URL;
    if (!allowed) throw new UpdateError(502, '更新地址不属于本系统专用版的固定 GitHub 来源。');
    return url;
  }

  async consume(url, { asset = false, maxBytes = MAX_METADATA, allow404 = false, timeoutMs = this.options.requestTimeoutMs, onChunk } = {}) {
    let target = this.validateUrl(url, { asset });
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = this.options.setTimeout(() => controller.abort(new Error('连接 GitHub 超时，请检查网络后重试。')), timeoutMs);
    timer?.unref?.();
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await this.options.fetchImpl(target.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { 'User-Agent': 'Codex-Mobile-Updater', Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          response.body?.resume?.(); await response.body?.cancel?.().catch(() => {});
          if (!location || redirects === 5) throw new UpdateError(502, 'GitHub 下载重定向异常。');
          const redirected = this.validateUrl(new URL(location, target).href, { asset, redirect: true });
          if (redirected.href !== url) throw new UpdateError(502, '固定提交的更新地址不能重定向到其他提交或资源。');
          target = redirected;
          continue;
        }
        if (response.status === 404 && allow404) { response.body?.resume?.(); await response.body?.cancel?.().catch(() => {}); return null; }
        if (response.status !== 200) {
          response.body?.resume?.(); await response.body?.cancel?.().catch(() => {});
          throw new UpdateError(502, `GitHub 返回 HTTP ${response.status}。${response.status === 403 || response.status === 429 ? '可能达到请求限制，请稍后重试。' : '更新未下载。'}`);
        }
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) throw new UpdateError(502, '更新响应超过允许的大小。');
        if (!response.body) throw new UpdateError(502, 'GitHub 返回了空响应。');
        const chunks = []; let size = 0;
        for await (const value of response.body) {
          controller.signal.throwIfAborted();
          const chunk = Buffer.from(value); size += chunk.length;
          if (size > maxBytes) throw new UpdateError(502, '更新响应超过允许的大小。');
          if (onChunk) await onChunk(chunk, size); else chunks.push(chunk);
        }
        controller.signal.throwIfAborted();
        return onChunk ? { size } : Buffer.concat(chunks, size);
      }
    } finally { this.options.clearTimeout(timer); this.controllers.delete(controller); controller.abort(); }
  }

  unavailable() {
    this.release = null; this.prepared = null;
    return this.update({ status: 'unpublished', checkedAt: new Date(this.options.now()).toISOString(), latestVersion: null, releaseUrl: null, releaseNotes: '', source: null, sourceCommit: null, publishedAt: null, hasUpdate: false, preparedVersion: null, reason: 'GitHub 尚未提供此系统专用版的有效 update.json；这不代表当前版本已经最新。' });
  }

  async checkInternal() {
    this.update({ status: 'checking', error: null, progress: null, reason: '正在检查本系统专用版的 GitHub 更新。' });
    const bytes = await this.consume(REPOSITORY_COMMIT_URL, { maxBytes: 2 * 1024 * 1024, allow404: true });
    if (!bytes) return this.unavailable();
    let commit; try { commit = JSON.parse(bytes.toString('utf8')); } catch { throw new UpdateError(502, 'GitHub 提交信息不是有效 JSON。'); }
    if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new UpdateError(502, 'GitHub 提交 SHA 无效。');
    const manifestUrl = 'https://raw.githubusercontent.com/' + UPDATE_REPOSITORY + '/' + commit.sha + '/' + this.profile.updatePath + '/update.json';
    const metadata = await this.consume(manifestUrl, { asset: true, allow404: true });
    if (!metadata) return this.unavailable();
    let manifest; try { manifest = JSON.parse(metadata.toString('utf8')); } catch { throw new UpdateError(502, '仓库 update.json 不是有效 JSON。'); }
    const version = validateRepositoryManifest(manifest, this.profile);
    const releaseUrl = 'https://github.com/' + UPDATE_REPOSITORY + '/tree/' + commit.sha;
    const details = { checkedAt: new Date(this.options.now()).toISOString(), latestVersion: version.version, releaseUrl, releaseNotes: (manifest.releaseNotes || '').replace(/\r\n?/g, '\n').trim(), source: 'repository', sourceCommit: commit.sha, publishedAt: commit.commit?.committer?.date || null };
    if (compareVersions(version.version, this.state.currentVersion) <= 0) {
      this.release = null; this.prepared = null;
      return this.update({ ...details, status: 'upToDate', hasUpdate: false, preparedVersion: null, reason: '此系统专用版没有更高的稳定版本；不会用其他系统或旧版本覆盖。' });
    }
    if (this.prepared?.version !== version.version || this.prepared?.sourceCommit !== commit.sha) this.prepared = null;
    this.release = { source: 'repository', editionId: this.profile.id, version: version.version, manifest, releaseUrl, sourceCommit: commit.sha, archivePrefix: 'codex-mobile-editions-' + commit.sha + '/' + this.profile.updatePath + '/', assetName: editionAssetName(this.profile, version.version), zip: { browser_download_url: 'https://codeload.github.com/' + UPDATE_REPOSITORY + '/zip/' + commit.sha } };
    return this.update({ ...details, status: this.prepared ? 'prepared' : 'available', hasUpdate: true, preparedVersion: this.prepared?.version || null, reason: '发现本系统专用版 ' + version.version + '；将校验清单中的每个文件。' });
  }

  async prepareInternal() {
    if (!this.release) await this.checkInternal();
    const release = this.release;
    if (!release || compareVersions(release.version, this.state.currentVersion) <= 0) return this.getState();
    if (this.prepared) {
      try { await this.verifyPrepared(); return this.update({ status: 'prepared', error: null, preparedVersion: release.version }); }
      catch { this.prepared = null; }
    }
    return this.prepareRepository(release);
  }

  async prepareRepository(release) {
    this.update({ status: 'downloading', error: null, progress: { received: 0, total: null }, reason: '正在下载固定 GitHub 提交的程序文件夹。' });
    const directory = path.join(this.directory, `${release.version}-${release.sourceCommit.slice(0, 12)}`); await mkdir(directory, { recursive: true });
    const zipPath = path.join(directory, release.assetName), manifestPath = path.join(directory, 'update.json');
    const temporary = `${zipPath}.${randomBytes(6).toString('hex')}.download`;
    const handle = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let size = 0, first = Buffer.alloc(0);
    try {
      await this.consume(release.zip.browser_download_url, { asset: true, maxBytes: this.options.maxArchiveBytes, timeoutMs: this.options.downloadTimeoutMs, onChunk: async (chunk, received) => {
        if (first.length < 4) first = Buffer.concat([first, chunk.subarray(0, 4 - first.length)]);
        hash.update(chunk); size = received; await handle.writeFile(chunk);
        this.update({ progress: { received, total: null } });
      } });
      if (!['504b0304', '504b0506'].includes(first.toString('hex'))) throw new UpdateError(502, '仓库下载不是 ZIP 安装包。');
      await handle.close(); await rm(zipPath, { force: true }); await rename(temporary, zipPath);
      await writeFile(manifestPath, JSON.stringify(release.manifest, null, 2), { mode: 0o600 });
      this.prepared = { source: 'repository', editionId: this.profile.id, version: release.version, zipPath, sha256: hash.digest('hex'), size, manifestPath, manifestSha256: (await hashFile(manifestPath, MAX_METADATA)).sha256, releaseUrl: release.releaseUrl, assetName: release.assetName, archivePrefix: release.archivePrefix, sourceCommit: release.sourceCommit };
      await writeFile(path.join(directory, 'prepared.json'), JSON.stringify(this.prepared, null, 2), { mode: 0o600 });
      return this.update({ status: 'prepared', preparedVersion: release.version, progress: { received: size, total: size }, reason: '固定提交的安装包已下载；安装器将逐文件校验 update.json，全部通过后才替换程序。' });
    } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }

  async verifyPrepared() {
    if (!this.prepared || compareVersions(this.prepared.version, this.state.currentVersion) <= 0) throw new UpdateError(409, '没有可安装的更新版本。');
    const file = await stat(this.prepared.zipPath);
    if (!file.isFile() || file.size !== this.prepared.size || file.size > this.options.maxArchiveBytes) throw new UpdateError(502, '已下载更新包发生变化，安装已取消。');
    const digest = await hashFile(this.prepared.zipPath);
    if (digest.sha256 !== this.prepared.sha256 || digest.size !== this.prepared.size) throw new UpdateError(502, '已下载更新包 SHA256 已变化，安装已取消。');
    const manifestDigest = await hashFile(this.prepared.manifestPath, MAX_METADATA);
    if (manifestDigest.sha256 !== this.prepared.manifestSha256) throw new UpdateError(502, '本地更新清单发生变化，安装已取消。');
    const manifest = JSON.parse(await readFile(this.prepared.manifestPath, 'utf8'));
    if (this.prepared.source !== 'repository' || this.prepared.editionId !== this.profile.id || validateRepositoryManifest(manifest, this.profile).version !== this.prepared.version) throw new UpdateError(502, '本地更新清单的系统或版本不匹配。');
  }

  async busy() {
    try { const result = await this.options.isBusy(); return typeof result === 'boolean' ? result : result?.busy !== false; }
    catch { return true; }
  }

  async installInternal({ automatic = false, generation = this.generation } = {}) {
    if (this.state.installScheduled) return this.getState();
    const allowed = () => !this.closed && (!automatic || this.state.autoUpdate && generation === this.generation);
    if (!allowed()) return this.getState();
    if (await this.busy()) return this.update({ status: 'waitingForIdle', error: null, reason: automatic ? '电脑仍有任务或审批，空闲后会自动重试。' : '电脑仍有任务或审批，请空闲后再次安装。' });
    await this.prepareInternal();
    if (!allowed() || !this.prepared) return this.getState();
    if (await this.busy()) return this.update({ status: 'waitingForIdle', reason: '有任务或审批尚未结束，已下载的更新会保留。' });
    if (typeof this.options.installPrepared !== 'function') throw new UpdateError(503, '本地安装器尚未配置。');
    this.update({ status: 'installing', error: null, reason: '正在交给本地安装器，完成后程序将重启。' });
    await this.verifyPrepared();
    if (!allowed()) return this.update({ status: 'prepared', reason: '自动更新已关闭，下载包已保留且未安装。' });
    if (await this.busy()) return this.update({ status: 'waitingForIdle', reason: '任务状态发生变化，暂缓安装。' });
    const outcome = await this.options.installPrepared(structuredClone(this.prepared));
    if (!outcome?.scheduled) throw new UpdateError(502, '安装器没有确认更新安排，当前程序保持原样。');
    return this.update({ status: 'installing', installScheduled: true, reason: '本地安装器已接收更新，程序即将重启；安装结果由本地安装状态确认。' });
  }

  async close() {
    this.closed = true; ++this.generation;
    if (this.timer) this.options.clearTimeout(this.timer); this.timer = null;
    if (this.checkTimer) this.options.clearTimeout(this.checkTimer); this.checkTimer = null;
    this.checkingEnabled = false;
    for (const controller of this.controllers) controller.abort(new Error('更新器已关闭。'));
  }
}

export default UpdateManager;
