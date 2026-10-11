import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const MAX_DOWNLOAD_BYTES = 160 * 1024 * 1024;
const USER_AGENT = 'codex-mobile-local-bridge';

export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || !['x64', 'arm64'].includes(arch)) throw new Error('此专用版需要 Intel 或 Apple 芯片的 macOS 电脑。');
  return { asset: `cloudflared-darwin-${arch === 'x64' ? 'amd64' : 'arm64'}.tgz`, binary: `cloudflared-darwin-${arch}` };
}

export function extractCloudflared(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
  let result;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const text = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/').replace(/^\.\//, '');
    const sizeText = text(124, 136).trim(), type = text(156, 157);
    if (!/^[0-7]+$/.test(sizeText) || !name || name.startsWith('/') || name.split('/').includes('..') || /[\\\0]/.test(name) || !['', '0', '5'].includes(type)) throw new Error('cloudflared 官方压缩包包含不支持的条目。');
    const size = parseInt(sizeText, 8), start = offset + 512;
    if (size > 160 * 1024 * 1024 || start + size > tar.length) throw new Error('cloudflared 压缩包损坏或过大。');
    if (name === 'cloudflared' && type !== '5') {
      if (result) throw new Error('cloudflared 压缩包包含重复文件。');
      result = Buffer.from(tar.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!result?.length) throw new Error('cloudflared 压缩包缺少可执行文件。');
  return result;
}

// Node 24's proxyEnv supports HTTPS_PROXY / HTTP_PROXY / NO_PROXY without
// requiring an additional proxy package. Direct connections work as usual.
function request(url, { signal, timeoutMs = 30_000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      reject(new Error('cloudflared 下载只允许 HTTPS 地址。'));
      return;
    }
    const agent = new https.Agent({ proxyEnv: process.env });
    const req = https.get(target, {
      agent,
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirects <= 0) {
          reject(new Error('下载 cloudflared 时遇到过多重定向。'));
          return;
        }
        resolve(request(new URL(res.headers.location, target), {
          signal, timeoutMs, redirects: redirects - 1,
        }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`下载 cloudflared 失败：${target.hostname} 返回 HTTP ${res.statusCode}。${res.statusCode === 403 || res.statusCode === 429 ? ' GitHub 可能限制了请求，请稍后重试。' : ''}`));
        return;
      }
      resolve(res);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('连接 GitHub 下载 cloudflared 超时，请检查网络或代理。')));
    req.once('error', reject);
    req.once('close', () => agent.destroy());
  });
}

async function textResponse(url, { signal, maxBytes = 2 * 1024 * 1024 } = {}) {
  const response = await request(url, { signal });
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) {
      response.destroy();
      throw new Error('GitHub 返回的元数据超出允许大小。');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function readChecksum(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const standard = line.trim().match(/^([a-f\d]{64})\s+\*?(.+)$/i);
    if (standard && standard[2].replace(/^\.\//, '') === filename) return standard[1].toLowerCase();
    const bsd = line.trim().match(/^SHA256\s*\(([^)]+)\)\s*=\s*([a-f\d]{64})$/i);
    if (bsd && bsd[1] === filename) return bsd[2].toLowerCase();
  }
  return null;
}

/** Download an official release and verify SHA-256 before returning its path. */
export async function ensureCloudflared(rootDir, { signal, onProgress = () => {} } = {}) {
  const target = cloudflaredAsset();
  const ASSET_NAME = target.asset;
  const vendorDir = path.join(path.resolve(rootDir), 'vendor');
  const binaryPath = path.join(vendorDir, target.binary);
  const metadataPath = `${binaryPath}.json`;
  await mkdir(vendorDir, { recursive: true });
  signal?.throwIfAborted();
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (metadata.asset === ASSET_NAME && /^[a-f\d]{64}$/i.test(metadata.sha256)
      && metadata.source?.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')
      && (await stat(binaryPath)).isFile()) {
      onProgress('正在验证 cloudflared');
      if (await fileHash(binaryPath) === metadata.sha256.toLowerCase()) {
        signal?.throwIfAborted();
        await chmod(binaryPath, 0o755);
        return binaryPath;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // A missing or damaged cache is repaired using the official release.
  }

  onProgress('正在查询 cloudflared 官方版本');
  const release = JSON.parse(await textResponse(RELEASE_API, { signal }));
  const asset = release.assets?.find((entry) => entry.name === ASSET_NAME);
  if (!asset?.browser_download_url?.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) {
    throw new Error('Cloudflare 官方版本中未找到当前 Mac 架构的下载文件。');
  }
  let expectedHash = /^sha256:([a-f\d]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase();
  if (!expectedHash) {
    const checksumAsset = release.assets?.find((entry) => /^(checksums?(\.txt)?|sha256sums?(\.txt)?|.*\.sha256)$/i.test(entry.name));
    if (checksumAsset?.browser_download_url?.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) {
      expectedHash = readChecksum(await textResponse(checksumAsset.browser_download_url, { signal }), ASSET_NAME);
    }
  }
  if (!expectedHash) {
    throw new Error('官方版本未提供可验证的 SHA256，已停止下载执行。请稍后重试或使用已验证的版本。');
  }
  if (!Number.isInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD_BYTES) {
    throw new Error('cloudflared 官方文件大小不符合预期，已停止下载。');
  }

  const tempPath = `${binaryPath}.${randomBytes(6).toString('hex')}.download`;
  let downloaded = 0;
  let lastPercent = -10;
  const hash = createHash('sha256');
  try {
    onProgress('正在下载 cloudflared');
    const response = await request(asset.browser_download_url, { signal, timeoutMs: 60_000 });
    const verifier = new Transform({
      transform(chunk, encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > MAX_DOWNLOAD_BYTES || downloaded > asset.size) {
          callback(new Error('cloudflared 下载大小超出官方文件大小。'));
          return;
        }
        hash.update(chunk);
        const percent = Math.floor(downloaded * 100 / asset.size);
        if (percent >= lastPercent + 10) {
          lastPercent = percent;
          onProgress(`正在下载 cloudflared · ${percent}%`);
        }
        callback(null, chunk);
      },
    });
    await pipeline(response, verifier, createWriteStream(tempPath, { flags: 'wx', mode: 0o700 }), { signal });
    if (downloaded !== asset.size || hash.digest('hex') !== expectedHash) {
      throw new Error('cloudflared 的 SHA256 或文件大小校验失败，文件不会被执行。');
    }
    signal?.throwIfAborted();
    const executable = extractCloudflared(await readFile(tempPath));
    await writeFile(tempPath, executable, { mode: 0o700 });
    await chmod(tempPath, 0o755);
    await rm(binaryPath, { force: true });
    await rename(tempPath, binaryPath);
    await writeFile(metadataPath, `${JSON.stringify({
      asset: ASSET_NAME,
      version: release.tag_name,
      source: asset.browser_download_url,
      sha256: createHash('sha256').update(executable).digest('hex'),
      archiveSha256: expectedHash,
      verifiedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    return binaryPath;
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/** Owns one opt-in Cloudflare quick tunnel; never installs a service. */
export class TunnelManager extends EventEmitter {
  constructor({ port, rootDir, startupTimeoutMs = 120_000, binaryProvider = ensureCloudflared, spawnProcess = spawn }) {
    super();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的本地服务端口。');
    this.port = port;
    this.rootDir = path.resolve(rootDir);
    this.startupTimeoutMs = startupTimeoutMs;
    this.binaryProvider = binaryProvider;
    this.spawnProcess = spawnProcess;
    this.state = { status: 'stopped', url: null, error: null, detail: '' };
    this.child = null;
    this.generation = 0;
    this.controller = null;
    this.startupTimer = null;
    this.recentLogs = [];
  }

  updateState(next) {
    this.state = { ...this.state, ...next };
    this.emit('change', { ...this.state });
  }

  /** Returns immediately. Subscribe to "change" or call waitUntilReady(). */
  async start() {
    if (this.state.status === 'starting' || this.state.status === 'ready') return { ...this.state };
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.recentLogs = [];
    this.updateState({ status: 'starting', url: null, error: null, detail: '准备互联网连接' });
    this.launch(generation, this.controller.signal).catch((error) => {
      if (generation !== this.generation) return;
      this.fail(error.message || String(error));
    });
    return { ...this.state };
  }

  async launch(generation, signal) {
    const binary = await this.binaryProvider(this.rootDir, {
      signal,
      onProgress: (detail) => {
        if (generation === this.generation) this.updateState({ detail });
      },
    });
    signal.throwIfAborted();
    if (generation !== this.generation) return;
    this.updateState({ detail: '正在连接 Cloudflare' });
    const child = this.spawnProcess(binary, [
      'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`, '--protocol', 'http2',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, cwd: this.rootDir });
    this.child = child;
    let discoveredUrl = null;
    let connected = false;
    const pending = { stdout: '', stderr: '' };
    const consumeLine = (line) => {
      if (generation !== this.generation) return;
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@').replace(/((?:token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi, '$1[redacted]').trim();
      if (!clean) return;
      this.recentLogs.push(clean);
      this.recentLogs = this.recentLogs.slice(-12);
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i.exec(clean);
      if (match) discoveredUrl = match[0].toLowerCase();
      if (/Registered tunnel connection/i.test(clean)) connected = true;
      if (discoveredUrl && connected && this.state.status === 'starting') {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
        this.updateState({ status: 'ready', url: discoveredUrl, error: null, detail: '互联网连接已就绪' });
      }
    };
    for (const name of ['stdout', 'stderr']) {
      child[name]?.on('data', (chunk) => {
        pending[name] += chunk.toString('utf8');
        const lines = pending[name].split(/\r?\n/);
        pending[name] = lines.pop().slice(-16_384);
        for (const line of lines) consumeLine(line);
      });
      child[name]?.on('end', () => consumeLine(pending[name]));
    }
    child.once('error', (error) => {
      if (generation === this.generation) this.fail(`启动 cloudflared 失败：${error.message}`);
    });
    child.once('exit', (code, exitSignal) => {
      if (this.child === child) this.child = null;
      if (generation !== this.generation || this.state.status === 'stopped' || this.state.status === 'error') return;
      this.fail(`互联网连接进程已退出（${exitSignal || `退出码 ${code}`}）。${this.logHint()}`);
    });
    this.startupTimer = setTimeout(() => {
      if (generation !== this.generation || this.state.status !== 'starting') return;
      this.fail(`连接 Cloudflare 超时，请检查网络是否允许访问 Cloudflare（出站 TCP 7844），再重试。${this.logHint()}`);
    }, this.startupTimeoutMs);
    this.startupTimer.unref?.();
  }

  logHint() {
    const meaningful = this.recentLogs.filter((line) => /error|failed|ERR |timeout|refused/i.test(line));
    return meaningful.length ? ` 最近信息：${meaningful.slice(-2).join(' | ').slice(0, 900)}` : '';
  }

  fail(message) {
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.updateState({ status: 'error', url: null, error: message, detail: '互联网连接失败' });
    if (this.child && this.child.exitCode === null) this.child.kill();
  }

  waitUntilReady({ timeoutMs = 240_000 } = {}) {
    if (this.state.status === 'ready') return Promise.resolve({ ...this.state });
    if (this.state.status === 'error') return Promise.reject(new Error(this.state.error));
    if (this.state.status === 'stopped') return Promise.reject(new Error('互联网连接尚未启动。'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('change', listener); };
      const listener = (state) => {
        if (state.status === 'ready') { cleanup(); resolve(state); }
        else if (state.status === 'error' || state.status === 'stopped') {
          cleanup(); reject(new Error(state.error || '互联网连接已停止。'));
        }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('等待互联网连接就绪超时。')); }, timeoutMs);
      this.on('change', listener);
    });
  }

  async stop() {
    ++this.generation;
    this.controller?.abort();
    this.controller = null;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const child = this.child;
    this.child = null;
    this.updateState({ status: 'stopped', url: null, error: null, detail: '' });
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
        const done = () => { clearTimeout(timer); resolve(); };
        child.once('exit', done);
        child.once('error', done);
        child.kill();
      });
    }
    return { ...this.state };
  }
}

export default TunnelManager;
