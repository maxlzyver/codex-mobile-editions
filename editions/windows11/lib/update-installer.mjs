import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessError } from './security.mjs';
import { readEditionProfile, editionAssetName, compareVersions, UPDATE_REPOSITORY } from './updater.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const UPDATE_ROOT_FILES = Object.freeze(['server.mjs', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Start.cmd', 'Stop.cmd', 'Launch.ps1', 'Stop.ps1', 'Codex-Mobile.exe', 'build-launcher.ps1', 'update.json', 'edition.json']);
const DIRECTORIES = new Set(['lib', 'public', 'launcher', 'tools', 'test', 'docs', 'runtime', 'vendor']);

export function validateUpdatePath(input) {
  if (typeof input !== 'string' || !input.startsWith('codex-mobile/') || input.length > 512 || /[\\\u0000-\u001f<>:"|?*]/.test(input)) throw new AccessError(400, '更新包包含无效文件路径。');
  const relative = input.slice('codex-mobile/'.length);
  const parts = relative.split('/');
  if (!relative || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
    || /^\.(?:runtime|codex|git|env)$/i.test(part))
    || !(parts.length === 1 ? UPDATE_ROOT_FILES.includes(relative) : DIRECTORIES.has(parts[0]))) throw new AccessError(400, '更新包试图写入程序白名单之外。');
  if (/(?:^|\/)(?:owner-url\.txt|auth\.json|devices\.json|tasks\.json|sessions\.json|credentials\.json)$/i.test(relative)
    || /\.(?:log|sqlite|db|key|pem|pfx)$/i.test(relative)) throw new AccessError(400, '更新包不能包含账户、日志或个人数据。');
  return relative;
}

const inside = (parent, candidate) => { const relative = path.relative(parent, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
async function sha256(filename) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
async function noLinks(filename) {
  let current = path.resolve(filename);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new AccessError(400, '更新目录不能经过符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}

export async function validatePreparedUpdate(prepared, { rootDir, runtimeDir }) {
  if (!prepared || !SEMVER.test(prepared.version || '') || !/^[a-f\d]{64}$/i.test(prepared.sha256 || '')
    || !Number.isSafeInteger(prepared.size) || prepared.size < 1 || prepared.size > 512 * 1024 * 1024) throw new AccessError(400, '更新下载信息无效。');
  const root = path.resolve(rootDir), runtime = path.resolve(runtimeDir);
  const profile = readEditionProfile(root);
  if (!['windows10', 'windows11'].includes(profile.id)) throw new AccessError(400, '此安装器只适用于 Windows 专用版。');
  if (compareVersions(prepared.version, profile.version) <= 0) throw new AccessError(400, '更新必须高于本机专用版版本。');
  const repository = prepared.source === 'repository';
  if (!repository || prepared.editionId !== profile.id || !/^[a-f\d]{40}$/.test(prepared.sourceCommit || '')
    || prepared.releaseUrl !== 'https://github.com/' + UPDATE_REPOSITORY + '/tree/' + prepared.sourceCommit
    || prepared.archivePrefix !== 'codex-mobile-editions-' + prepared.sourceCommit + '/' + profile.updatePath + '/'
    || prepared.assetName !== editionAssetName(profile, prepared.version)) throw new AccessError(400, '更新来源、系统专用版或固定提交信息无效。');
  if (runtime.toLowerCase() !== path.join(root, '.runtime').toLowerCase()) throw new AccessError(400, '更新状态目录必须是本程序的 .runtime。');
  await noLinks(root); await noLinks(runtime);
  const downloads = path.join(runtime, 'updates');
  for (const filename of [prepared.zipPath, prepared.manifestPath]) {
    if (typeof filename !== 'string' || !inside(downloads, path.resolve(filename))) throw new AccessError(400, '更新文件必须位于本程序的更新缓存内。');
    await noLinks(filename);
    if (!(await lstat(filename)).isFile()) throw new AccessError(400, '更新文件必须是普通文件。');
  }
  const archive = await lstat(prepared.zipPath);
  if (archive.size !== prepared.size || await sha256(prepared.zipPath) !== prepared.sha256.toLowerCase()) throw new AccessError(400, '更新 ZIP 大小或 SHA256 校验失败。');
  if ((await lstat(prepared.manifestPath)).size > 8 * 1024 * 1024) throw new AccessError(400, '更新清单超出大小限制。');
  if (prepared.manifestSha256 !== undefined && (!/^[a-f\d]{64}$/i.test(prepared.manifestSha256) || await sha256(prepared.manifestPath) !== prepared.manifestSha256.toLowerCase())) throw new AccessError(400, '更新清单的 SHA256 校验失败。');
  const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
  if (manifest.version !== prepared.version || manifest.repository !== UPDATE_REPOSITORY || manifest.platform !== profile.platform
    || manifest.edition !== profile.id || (manifest.runtimePolicy !== undefined && manifest.runtimePolicy !== 'preserve')) throw new AccessError(400, '更新清单与本机系统专用版不匹配。');
  const files = manifest.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 10000) throw new AccessError(400, '更新清单文件列表无效。');
  const seen = new Set();
  for (const file of files) {
    const relative = validateUpdatePath('codex-mobile/' + file.path).toLowerCase();
    if (seen.has(relative) || !/^[a-f\d]{64}$/i.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new AccessError(400, '更新清单包含重复或无效的文件记录。');
    seen.add(relative);
  }
  if (!seen.has('edition.json') || seen.has('update.json')) throw new AccessError(400, '更新必须包含 edition.json，且清单不能自校验。');

  return manifest;
}

export function runUpdateHelper(script, planPath, planHash, mode, { testOnly = false, failAfterFiles = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PlanPath', planPath, '-PlanSha256', planHash, '-Mode', mode];
    if (testOnly) args.push('-TestOnly');
    if (failAfterFiles) args.push('-FailAfterFiles', String(failAfterFiles));
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data.toString()).slice(-8000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve({ code }) : reject(new Error(`更新${mode === 'Prepare' ? '校验' : '应用'}失败：${output.trim().slice(-1800)}`)));
  });
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** The caller can send HTTP 202 first; this promise covers the complete handoff. */
export function createInstaller({ rootDir, runtimeDir, onBeforeInstall, isBusy = () => false,
  runHelper = runUpdateHelper, spawnProcess = spawn, handshakeTimeoutMs = 30_000, beforeShutdownDelayMs = 300,
}) {
  const root = path.resolve(rootDir), runtime = path.resolve(runtimeDir);
  let pending = false;
  return async function installPrepared(prepared) {
    if (pending) throw new AccessError(409, '已有更新正在准备或安装。');
    if (await isBusy()) throw new AccessError(409, '任务仍在运行，暂不能安装更新。');
    if (typeof onBeforeInstall !== 'function') throw new AccessError(500, '未配置安全关闭服务的更新回调。');
    pending = true;
    let job;
    try {
      await validatePreparedUpdate(prepared, { rootDir: root, runtimeDir: runtime });
      const server = JSON.parse(await readFile(path.join(runtime, 'server.json'), 'utf8'));
      if (server.pid !== process.pid || path.resolve(server.root).toLowerCase() !== root.toLowerCase()) throw new AccessError(409, '无法验证当前服务进程，已取消更新。');
      job = path.join(runtime, 'updates', `install-${prepared.version}-${randomBytes(6).toString('hex')}`);
      await mkdir(job, { recursive: true });
      const helper = path.join(job, 'apply-update.ps1');
      await copyFile(path.join(root, 'tools', 'apply-update.ps1'), helper);
      const plan = {
        schema: 1, rootDir: root, runtimeDir: runtime, jobDir: job,
        ...Object.fromEntries(['version', 'zipPath', 'sha256', 'size', 'manifestPath', 'manifestSha256', 'releaseUrl', 'assetName', 'source', 'sourceCommit', 'archivePrefix', 'editionId'].map(key => [key, prepared[key]])),
        server: { pid: process.pid, executable: process.execPath, startedAt: Date.now() - process.uptime() * 1000 },
        restartPort: server.port, testMode: false,
      };
      const planPath = path.join(job, 'plan.json');
      await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
      let hash = await sha256(planPath);
      await runHelper(helper, planPath, hash, 'Prepare');
      plan.inventorySha256 = await sha256(path.join(job, 'inventory.json'));
      await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
      hash = await sha256(planPath);
      if (await isBusy()) throw new AccessError(409, '校验期间有任务开始执行，请在任务结束后重试。');
      const child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PlanPath', planPath, '-PlanSha256', hash, '-Mode', 'Launch'], {
        // Windows PowerShell can exit successfully before running -File when
        // Node creates it with DETACHED_PROCESS. The helper's Launch broker uses
        // Start-Process instead so Apply survives the service's shutdown.
        windowsHide: true, stdio: 'ignore', cwd: job, env: { ...process.env },
      });
      let helperFailure = null;
      child.once('exit', code => { helperFailure = new Error(`更新安装助手在接管前已退出（${code}），服务未授权进行更新。`); });
      child.once('error', error => { helperFailure = error; });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      const statusPath = path.join(job, 'status.json');
      const deadline = Date.now() + handshakeTimeoutMs;
      let waiting = false;
      while (Date.now() < deadline) {
        if (helperFailure) throw helperFailure;
        let status;
        try {
          status = JSON.parse(await readFile(statusPath, 'utf8'));
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (helperFailure) throw helperFailure;
        if (status?.version === prepared.version && status.status === 'waiting') { waiting = true; break; }
        if (['error', 'rolled-back', 'rollback-failed'].includes(status?.status)) throw new Error(`更新安装助手校验失败：${String(status.message || status.status).slice(0, 1500)}`);
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
      if (!waiting) throw new Error('更新安装助手未在限定时间内准备好，已取消安装，服务保持运行。');
      await delay(beforeShutdownDelayMs);
      if (helperFailure) throw helperFailure;
      if (await isBusy()) throw new AccessError(409, '任务仍在执行，安装已取消。');
      if (helperFailure) throw helperFailure;
      await onBeforeInstall();
      if (helperFailure) throw helperFailure;
      await writeFile(path.join(job, 'apply-ready.json'), JSON.stringify({ ready: true }), { mode: 0o600 });
      return { scheduled: true, version: prepared.version, statusPath };
    } catch (error) {
      pending = false;
      if (job) await writeFile(path.join(job, 'cancel.json'), JSON.stringify({ cancelled: true }), { mode: 0o600 }).catch(() => {});
      throw error;
    }
  };
}
