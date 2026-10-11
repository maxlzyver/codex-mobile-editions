import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const REPOSITORY = 'maxlzyver/codex-mobile-editions';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HASH = /^[a-f0-9]{64}$/i;
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const digest = data => createHash('sha256').update(data).digest('hex');
export async function fileHash(filename) { const hash = createHash('sha256'); for await (const bytes of createReadStream(filename)) hash.update(bytes); return hash.digest('hex'); }
export const inside = (parent, target) => { const relative = path.relative(parent, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
export async function noLinks(filename) {
  for (let current = path.resolve(filename);;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('更新路径不能经过符号链接。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
const ROOT_FILES = new Set(['server.mjs', 'package.json', 'edition.json', 'update.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Start.command', 'Stop.command', 'Login.command']);
const DIRECTORIES = new Set(['lib', 'tools', 'public', 'test', 'docs', 'vendor', 'runtime']);
export function validateUpdatePath(relative) {
  if (typeof relative !== 'string' || relative.length > 512 || /[\\\0-\x1f<>:"|?*]/.test(relative)) throw new Error('更新文件路径无效。');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[. ]$/.test(part)) || !(parts.length === 1 ? ROOT_FILES.has(relative) : DIRECTORIES.has(parts[0]))) throw new Error('更新路径超出程序文件白名单。');
  if (/(?:^|\/)(?:auth|devices|tasks|sessions|credentials)\.json$/i.test(relative) || /(?:owner-url|\.exe$|\.ps1$|\.cmd$|\.log$|\.sqlite$|\.key$|\.pem$)/i.test(relative)) throw new Error('更新不能包含其他平台或个人数据。');
  return relative;
}

/** Decode only normal ZIP files; names are checked even for unselected repository files. */
export function readZipEntries(buffer) {
  let end = -1;
  for (let cursor = buffer.length - 22; cursor >= Math.max(0, buffer.length - 65557); cursor--) {
    if (buffer.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + buffer.readUInt16LE(cursor + 20) === buffer.length) { end = cursor; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error('不支持损坏、分卷或 ZIP64 压缩包。');
  const count = buffer.readUInt16LE(end + 10), index = buffer.readUInt32LE(end + 16), size = buffer.readUInt32LE(end + 12);
  if (count > 12000 || count !== buffer.readUInt16LE(end + 8) || index + size !== end) throw new Error('ZIP 中央目录无效。');
  const entries = [], seen = new Set(); let cursor = index;
  for (let number = 0; number < count; number++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏。');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20), bytes = buffer.readUInt32LE(cursor + 24), length = buffer.readUInt16LE(cursor + 28);
    const extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32), local = buffer.readUInt32LE(cursor + 42);
    const attributes = buffer.readUInt32LE(cursor + 38), mode = attributes >>> 16;
    if (cursor + 46 + length + extra + comment > end) throw new Error('ZIP 文件名损坏。');
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + length);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    const components = name.replace(/\/$/, '').split('/');
    if (!name || name.length > 1024 || name.startsWith('/') || /[\\\0-\x1f:]/.test(name) || components.some(part => !part || part === '.' || part === '..') || seen.has(name.toLowerCase())) throw new Error('ZIP 包含路径越界或重复条目。');
    seen.add(name.toLowerCase());
    if (flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || attributes & 0x400 || (mode & 0xf000 && ![0x4000, 0x8000].includes(mode & 0xf000))) throw new Error('ZIP 不允许加密、符号链接或特殊文件。');
    if (bytes > 256 * 1024 * 1024 || compressed > 512 * 1024 * 1024 || local + 30 > index || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 条目大小或位置无效。');
    const localLength = buffer.readUInt16LE(local + 26), localExtra = buffer.readUInt16LE(local + 28), start = local + 30 + localLength + localExtra;
    if (start + compressed > index || buffer.readUInt16LE(local + 8) !== method || !buffer.subarray(local + 30, local + 30 + localLength).equals(nameBytes)) throw new Error('ZIP 本地条目与中央目录不一致。');
    entries.push({ name, bytes, directory: name.endsWith('/'), data() {
      const compressedData = buffer.subarray(start, start + compressed);
      const decoded = method === 0 ? compressedData : inflateRawSync(compressedData, { maxOutputLength: Math.max(bytes, 1) });
      if (decoded.length !== bytes) throw new Error('ZIP 解压后大小不匹配。');
      return decoded;
    } });
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end) throw new Error('ZIP 目录长度不匹配。');
  return entries;
}

export async function validatePreparedUpdate(prepared, { rootDir, runtimeDir }) {
  const root = path.resolve(rootDir), runtime = path.resolve(runtimeDir);
  if (runtime !== path.join(root, '.runtime')) throw new Error('更新状态目录必须是安装目录的 .runtime。');
  await noLinks(root); await noLinks(runtime);
  if (!prepared || prepared.source !== 'repository' || prepared.editionId !== 'macos' || !VERSION.test(prepared.version || '') || !HASH.test(prepared.sha256 || '') || !HASH.test(prepared.manifestSha256 || '') || !Number.isSafeInteger(prepared.size) || prepared.size <= 0 || prepared.size > 512 * 1024 * 1024) throw new Error('macOS 更新下载信息无效。');
  const commit = prepared.sourceCommit;
  if (!/^[a-f0-9]{40}$/.test(commit || '') || prepared.releaseUrl !== `https://github.com/${REPOSITORY}/tree/${commit}` || prepared.archivePrefix !== `codex-mobile-editions-${commit}/editions/macos/` || prepared.assetName !== `codex-mobile-macos-${prepared.version}-universal.zip`) throw new Error('更新来源或 macOS 版本不匹配。');
  for (const filename of [prepared.zipPath, prepared.manifestPath]) {
    if (typeof filename !== 'string' || !inside(path.join(runtime, 'updates'), path.resolve(filename))) throw new Error('更新文件必须来自本安装的缓存目录。');
    await noLinks(filename); if (!(await lstat(filename)).isFile()) throw new Error('更新缓存必须是普通文件。');
  }
  if ((await lstat(prepared.zipPath)).size !== prepared.size || await fileHash(prepared.zipPath) !== prepared.sha256.toLowerCase() || (await lstat(prepared.manifestPath)).size > 8 * 1024 * 1024 || await fileHash(prepared.manifestPath) !== prepared.manifestSha256.toLowerCase()) throw new Error('更新 ZIP 或清单 SHA256 校验失败。');
  const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
  const installed = JSON.parse(await readFile(path.join(root, 'edition.json'), 'utf8'));
  if (installed.id !== 'macos' || installed.repository !== REPOSITORY || installed.updatePath !== 'editions/macos' || installed.platform !== 'macOS universal' || !VERSION.test(installed.version || '') || installed.assetName !== `codex-mobile-macos-${installed.version}-universal.zip`) throw new Error('本地安装不是有效的 macOS 专用版。');
  const oldVersion = installed.version.split('+')[0].split('.').map(BigInt), newVersion = prepared.version.split('+')[0].split('.').map(BigInt);
  const difference = newVersion.map((part, index) => part > oldVersion[index] ? 1 : part < oldVersion[index] ? -1 : 0).find(value => value !== 0) || 0;
  if (difference <= 0) throw new Error('只能安装比当前版本更新的 macOS 专用版。');
  if (manifest.edition !== 'macos' || manifest.platform !== 'macOS universal' || manifest.repository !== REPOSITORY || manifest.version !== prepared.version || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 10000 || ![undefined, 'replace', 'preserve'].includes(manifest.runtimePolicy)) throw new Error('更新清单不属于 macOS 专用版。');
  const seen = new Set(); let total = 0;
  for (const file of manifest.files) {
    const relative = validateUpdatePath(file.path), key = relative.toLowerCase();
    if (relative === 'update.json' || seen.has(key) || !HASH.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 256 * 1024 * 1024) throw new Error('更新文件清单重复或无效。');
    if (manifest.runtimePolicy === 'preserve' && /^(?:runtime\/|vendor\/cloudflared)/.test(relative)) throw new Error('轻量更新不能覆盖已有运行环境。');
    seen.add(key); total += file.bytes;
  }
  if (total > 1024 * 1024 * 1024) throw new Error('更新文件总大小超限。');
  for (const required of ['edition.json', 'package.json', 'server.mjs', 'Start.command', 'Stop.command', 'lib/mac-launcher.mjs', 'lib/security.mjs', 'lib/update-installer.mjs', 'tools/apply-update.mjs', 'public/index.html', 'LICENSE', 'vendor/qrcode.cjs']) if (!seen.has(required.toLowerCase())) throw new Error(`更新清单缺少 ${required}。`);
  return manifest;
}

const executable = relative => relative.endsWith('.command') || /^runtime\/darwin-(?:arm64|x64)\/bin\/node$/.test(relative) || /^vendor\/cloudflared-darwin-(?:arm64|x64)$/.test(relative);
async function status(plan, state, message) { await writeFile(path.join(plan.jobDir, 'status.json'), JSON.stringify({ version: plan.version, status: state, message, updatedAt: new Date().toISOString() }), { mode: 0o600 }); }
async function regularTarget(filename) { await noLinks(filename); try { const information = await lstat(filename); if (!information.isFile() || information.nlink > 1) throw new Error('程序目标必须是没有硬链接的普通文件。'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }

export async function prepareUpdate(plan) {
  const manifest = await validatePreparedUpdate(plan, plan), stage = path.join(plan.jobDir, 'stage');
  await noLinks(plan.jobDir); await mkdir(stage, { recursive: true, mode: 0o700 });
  await status(plan, 'preparing', '正在逐项验证 macOS 更新文件。');
  const wanted = new Map(manifest.files.map(file => [plan.archivePrefix + file.path, file]));
  const inventory = [];
  for (const entry of readZipEntries(await readFile(plan.zipPath))) {
    if (entry.directory) continue;
    const file = wanted.get(entry.name); if (!file) continue;
    const bytes = entry.data();
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256.toLowerCase()) throw new Error(`更新文件校验失败：${file.path}`);
    const target = path.join(stage, file.path); await regularTarget(path.join(plan.rootDir, file.path)); await noLinks(target);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx', mode: executable(file.path) ? 0o755 : 0o644 });
    inventory.push({ path: file.path, bytes: file.bytes, sha256: file.sha256.toLowerCase(), mode: executable(file.path) ? 0o755 : 0o644 });
    wanted.delete(entry.name);
  }
  if (wanted.size) throw new Error('更新 ZIP 缺少清单要求的程序文件。');
  const profile = JSON.parse(await readFile(path.join(stage, 'edition.json'), 'utf8')), pkg = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
  if (profile.id !== 'macos' || profile.platform !== 'macOS universal' || profile.repository !== REPOSITORY || profile.updatePath !== 'editions/macos' || profile.version !== plan.version || profile.assetName !== `codex-mobile-macos-${plan.version}-universal.zip` || pkg.version !== plan.version || pkg.name !== 'codex-mobile-console') throw new Error('更新包内的程序版本或 edition 不匹配。');
  for (const architecture of ['arm64', 'x64']) {
    const runtimePath = `runtime/darwin-${architecture}/bin/node`;
    if (manifest.runtimePolicy === 'preserve') {
      await regularTarget(path.join(plan.rootDir, runtimePath));
      if (!(await lstat(path.join(plan.rootDir, runtimePath))).isFile()) throw new Error('已有 macOS 运行环境缺失，请重新下载完整安装包。');
    } else if (!inventory.some(file => file.path === runtimePath)) throw new Error('完整更新缺少双架构 Node 运行环境。');
  }
  const content = await readFile(plan.manifestPath); await writeFile(path.join(stage, 'update.json'), content, { flag: 'wx', mode: 0o644 });
  inventory.push({ path: 'update.json', bytes: content.length, sha256: digest(content), mode: 0o644 });
  await writeFile(path.join(plan.jobDir, 'inventory.json'), JSON.stringify(inventory), { mode: 0o600 });
  await status(plan, 'prepared', 'macOS 更新文件已通过校验。');
  return inventory;
}

export async function snapshotProcess(pid) {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || pid < 2) throw new Error('只能检查本机 macOS 进程。');
  const value = async field => (await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', `${field}=`], { timeout: 3000, maxBuffer: 64 * 1024 })).stdout.trim();
  const [uid, started, command, executablePath] = await Promise.all(['uid', 'lstart', 'args', 'comm'].map(value));
  if (Number(uid) !== process.getuid()) throw Object.assign(new Error('进程不属于当前用户。'), { code: 'PROCESS_IDENTITY_MISMATCH' });
  if (!started || !command) throw new Error('无法读取进程身份。');
  return { pid, uid: Number(uid), started, command, executable: executablePath };
}
function validateProcessIdentity(expected, rootDir) {
  if (!expected || !Number.isSafeInteger(expected.pid) || expected.pid < 2 || !Number.isInteger(expected.uid) || expected.uid < 0
    || expected.root !== path.resolve(rootDir) || !/^[a-f0-9]{32}$/.test(expected.nonce || '') || expected.script !== path.join(path.resolve(rootDir), 'server.mjs')
    || typeof expected.command !== 'string' || expected.command.length > 65536 || typeof expected.started !== 'string' || !expected.started
    || typeof expected.executable !== 'string' || !expected.executable
    || !new RegExp(`(?:^| )--codex-mobile-instance=${expected.nonce}(?: |$)`).test(expected.command)) throw new Error('缺少本安装的进程身份。');
}
export function assertProcessSnapshot(expected, live, rootDir) {
  validateProcessIdentity(expected, rootDir);
  // Darwin ps renders paths through strvis; its display is not a raw pathname.
  // Compare two snapshots from the same tool instead of searching for UTF-8 paths.
  if (live.pid !== expected.pid || live.uid !== expected.uid || live.started !== expected.started || live.executable !== expected.executable || live.command !== expected.command) throw Object.assign(new Error('进程身份已改变，拒绝结束该进程。'), { code: 'PROCESS_IDENTITY_MISMATCH' });
  return live;
}
export async function verifyOwnedProcess(expected, rootDir) {
  validateProcessIdentity(expected, rootDir);
  let live; try { live = await snapshotProcess(expected.pid); } catch (error) { try { process.kill(expected.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') return null; } throw error; }
  return assertProcessSnapshot(expected, live, rootDir);
}
export async function stopOwnedProcess(expected, rootDir) {
  if (!await verifyOwnedProcess(expected, rootDir)) return;
  process.kill(expected.pid, 'SIGTERM');
  for (let n = 0; n < 80; n++) { await delay(100); if (!await verifyOwnedProcess(expected, rootDir)) return; }
  if (await verifyOwnedProcess(expected, rootDir)) process.kill(expected.pid, 'SIGKILL');
  for (let n = 0; n < 30; n++) { await delay(100); if (!await verifyOwnedProcess(expected, rootDir)) return; }
  throw new Error('本控制台进程尚未退出。');
}

export async function signalApplyReady(jobDir) {
  const temporary = path.join(jobDir, `.apply-ready-${randomBytes(8).toString('hex')}.tmp`);
  const destination = path.join(jobDir, 'apply-ready.json');
  await noLinks(destination);
  try {
    await writeFile(temporary, JSON.stringify({ ready: true }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

export async function waitForApplyReady(jobDir, { timeoutMs = 120000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await lstat(path.join(jobDir, 'cancel.json')); throw new Error('应用已取消更新。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { if (JSON.parse(await readFile(path.join(jobDir, 'apply-ready.json'), 'utf8')).ready === true) return; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(pollMs);
  }
  throw new Error('安全关闭握手超时。');
}

async function restart(plan) {
  const node = path.join(plan.rootDir, 'runtime', `darwin-${process.arch}`, 'bin/node');
  const child = spawn(node, [path.join(plan.rootDir, 'lib/mac-launcher.mjs'), plan.rootDir, 'start', '--after-update'], { detached: true, stdio: 'ignore', cwd: plan.rootDir, env: { ...process.env, CODEX_MOBILE_PORT: String(plan.restartPort) } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(500);
    try {
      const health = await (await fetch(`http://127.0.0.1:${plan.restartPort}/health`, { signal: AbortSignal.timeout(1000) })).json();
      const state = JSON.parse(await readFile(path.join(plan.runtimeDir, 'server.json'), 'utf8'));
      if (health.version === JSON.parse(await readFile(path.join(plan.rootDir, 'package.json'), 'utf8')).version && state.root === plan.rootDir && state.pid !== plan.server.pid) return;
    } catch { /* Wait for this installation's service only. */ }
  }
  // If startup partially succeeded, stop only its recorded, verified process before rollback.
  try { const owned = JSON.parse(await readFile(path.join(plan.runtimeDir, 'mac-process.json'), 'utf8')); if (owned.pid !== plan.server.pid) await stopOwnedProcess(owned, plan.rootDir); } catch { /* Leave unverified processes untouched. */ }
  throw new Error('更新后服务未通过启动检查。');
}

export async function applyUpdate(plan, { testOnly = false, failAfterFiles = 0, restartApplication = restart } = {}) {
  if (Boolean(plan.testMode) !== testOnly || (!testOnly && process.platform !== 'darwin')) throw new Error('更新执行环境不匹配。');
  await validatePreparedUpdate(plan, plan);
  const inventoryPath = path.join(plan.jobDir, 'inventory.json'); await noLinks(inventoryPath);
  if (!HASH.test(plan.inventorySha256 || '') || await fileHash(inventoryPath) !== plan.inventorySha256) throw new Error('已验证文件清单被修改。');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')), stage = path.join(plan.jobDir, 'stage'), backup = path.join(plan.jobDir, 'backup');
  for (const file of inventory) {
    validateUpdatePath(file.path); const staged = path.join(stage, file.path); await noLinks(staged); await regularTarget(path.join(plan.rootDir, file.path));
    if ((await lstat(staged)).size !== file.bytes || await fileHash(staged) !== file.sha256) throw new Error('暂存更新文件发生变化。');
  }
  const changed = []; let stopped = false;
  try {
    if (!testOnly) {
      await verifyOwnedProcess(plan.server, plan.rootDir);
      await status(plan, 'waiting', '等待本控制台完成安全关闭。');
      await waitForApplyReady(plan.jobDir);
      await stopOwnedProcess(plan.server, plan.rootDir); stopped = true;
    }
    await status(plan, 'applying', '正在备份和替换程序文件，个人数据保持不变。');
    for (const file of inventory) {
      const target = path.join(plan.rootDir, file.path), saved = path.join(backup, file.path);
      await regularTarget(target); await noLinks(saved); await mkdir(path.dirname(saved), { recursive: true });
      let previous = null; try { previous = await lstat(target); await copyFile(target, saved); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      changed.push({ file, previousMode: previous?.mode, existed: Boolean(previous) });
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(stage, file.path), target); await chmod(target, file.mode);
      if (await fileHash(target) !== file.sha256) throw new Error('替换后的程序文件校验失败。');
      if (testOnly && changed.length === failAfterFiles) throw new Error('Simulated copy failure');
    }
    if (!testOnly) await restartApplication(plan);
    await status(plan, 'complete', '更新完成。请重新打开电脑管理页；互联网连接地址可能改变。');
  } catch (error) {
    let rollbackError;
    for (const entry of changed.reverse()) {
      try {
        const target = path.join(plan.rootDir, entry.file.path); await regularTarget(target);
        if (entry.existed) { await copyFile(path.join(backup, entry.file.path), target); await chmod(target, entry.previousMode & 0o777); }
        else await rm(target, { force: true });
      } catch (failure) { rollbackError = failure; }
    }
    if (!testOnly && stopped && !rollbackError) try { await restartApplication(plan); } catch (failure) { rollbackError = failure; }
    await status(plan, rollbackError ? 'rollback-failed' : changed.length ? 'rolled-back' : 'error', rollbackError ? `请从更新备份恢复：${rollbackError.message}` : error.message);
    throw error;
  }
}

export async function runPlan(planPath, expectedHash) {
  if (!HASH.test(expectedHash || '') || await fileHash(planPath) !== expectedHash) throw new Error('更新计划 SHA256 不匹配。');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (plan.schema !== 1 || path.dirname(path.resolve(planPath)) !== path.resolve(plan.jobDir) || !inside(path.join(plan.rootDir, '.runtime/updates'), plan.jobDir)) throw new Error('更新计划目录无效。');
  await noLinks(planPath);
  try { await applyUpdate(plan); } catch (error) {
    let previous;
    try { previous = JSON.parse(await readFile(path.join(plan.jobDir, 'status.json'), 'utf8')); } catch { /* Failure may predate status creation. */ }
    if (!['rolled-back', 'rollback-failed'].includes(previous?.status)) await status(plan, 'error', error.message).catch(() => {});
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPlan(process.argv[2], process.argv[3]).catch(error => { process.stderr.write(`更新失败：${error.message}\n`); process.exitCode = 1; });
}
