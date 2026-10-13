import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profiles = { windows11: 'Windows 11 x64', windows10: 'Windows 10 x64', macos: 'macOS universal' };
const expectedFiles = edition => ['lib/updater.mjs', 'lib/update-installer.mjs', edition === 'macos' ? 'tools/apply-update.mjs' : 'tools/apply-update.ps1'];
const json = async filename => JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));

async function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('修复路径不能经过符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}

export async function assertStopped(root) {
  for (const name of ['server.json', 'launcher-process.json', 'mac-process.json']) {
    let state;
    try { state = await json(path.join(root, '.runtime', name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error(`无法读取 ${name}，请先确认移动助手已退出。`); }
    if (!Number.isSafeInteger(state.pid) || state.pid < 1) throw new Error('旧程序的进程记录无效，无法安全修复。');
    try { process.kill(state.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') continue; throw new Error('无法确认移动助手已退出，请先退出移动助手后重试。'); }
    // Fail closed even if an old PID was reused. This tool never stops processes.
    throw new Error('请先退出 Codex 移动助手（Windows 托盘右键退出 / Mac 双击 Stop.command），再运行修复。无需退出官方 Codex。');
  }
}

/** Local repair only: no network, credentials, process termination or version change. */
export async function repairInstallation(rootDir, { bundleDir = HERE } = {}) {
  await noLinks(rootDir); const root = await realpath(rootDir);
  await noLinks(path.join(root, '.runtime'));
  const edition = await json(path.join(root, 'edition.json'));
  const suffix = edition.id === 'macos' ? 'universal' : 'x64';
  if (!Object.hasOwn(profiles, edition.id) || edition.platform !== profiles[edition.id]
    || edition.repository !== 'maxlzyver/codex-mobile-editions' || edition.updatePath !== `editions/${edition.id}`
    || !['1.0.0', '1.0.1', '1.1.0'].includes(edition.version)
    || edition.assetName !== `codex-mobile-${edition.id}-${edition.version}-${suffix}.zip`) throw new Error('请选择官方 V1.0 / V1.0.1 / V1.1.0 专用版的完整程序目录。');
  if ((await json(path.join(root, 'package.json'))).version !== edition.version) throw new Error('旧版本身份不一致，已取消修复。');
  const manifest = await json(path.join(bundleDir, 'repair.json'));
  const profile = manifest.editions?.[edition.id];
  const required = expectedFiles(edition.id);
  if (manifest.schema !== 1 || manifest.repository !== edition.repository || !profile
    || !Array.isArray(profile.files) || profile.files.length !== required.length) throw new Error('修复包不适用于此系统专用版。');
  const verified = [];
  for (const relative of required) {
    const entry = profile.files.find(file => file.path === relative);
    if (!entry || !/^[a-f\d]{64}$/.test(entry.sha256 || '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) throw new Error('修复清单无效。');
    const source = path.join(bundleDir, 'payload', edition.id, relative), target = path.join(root, relative);
    await noLinks(source); await noLinks(target);
    if (!(await lstat(source)).isFile() || !(await lstat(target)).isFile()) throw new Error('程序文件不完整，请重新下载完整便携包。');
    const bytes = await readFile(source);
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error('修复文件校验失败，未修改旧程序。');
    verified.push({ relative, bytes, target, previous: await readFile(target) });
  }
  await assertStopped(root);
  const backup = path.join(root, '.runtime', 'updates', `repair-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await noLinks(backup); await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const file of verified) { const saved = path.join(backup, file.relative); await mkdir(path.dirname(saved), { recursive: true }); await writeFile(saved, file.previous, { mode: 0o600 }); }
  const changed = [];
  try {
    // Check again immediately before replacing anything; no running service is patched.
    await assertStopped(root);
    for (const file of verified) {
      const temporary = `${file.target}.repair-${randomBytes(4).toString('hex')}`;
      try { await writeFile(temporary, file.bytes, { flag: 'wx', mode: 0o644 }); await rename(temporary, file.target); changed.push(file); }
      finally { await rm(temporary, { force: true }); }
    }
    await writeFile(path.join(backup, 'repair-result.json'), JSON.stringify({ schema: 1, from: edition.version, edition: edition.id, files: verified.map(file => ({ path: file.relative, sha256: sha(file.bytes) })) }, null, 2));
  } catch (error) {
    for (const file of changed.reverse()) await copyFile(path.join(backup, file.relative), file.target);
    throw error;
  }
  return { root, edition, backup, repaired: true };
}

export async function ownerClient(root, { fetchImpl = fetch } = {}) {
  const state = await json(path.join(root, '.runtime/server.json'));
  if (path.resolve(state.root) !== path.resolve(root) || !Number.isInteger(state.port) || state.port < 1024 || state.port > 65535) throw new Error('重启后的服务身份不一致。');
  const owner = new URL((await readFile(path.join(root, '.runtime/owner-url.txt'), 'utf8')).trim());
  const origin = `http://127.0.0.1:${state.port}`;
  if (owner.origin !== origin || owner.pathname !== '/' || !owner.hash.startsWith('#owner=')) throw new Error('本机管理入口无效。');
  const request = async (route, method = 'GET', data, headers = {}) => {
    const response = await fetchImpl(origin + route, { method, headers: { Origin: origin, ...headers, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, body: method === 'POST' ? JSON.stringify(data || {}) : undefined, signal: AbortSignal.timeout(route.startsWith('/api/updates/') ? 60000 : 4000), redirect: 'error' });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || `本机请求失败 (${response.status})`); return { response, body };
  };
  const health = (await request('/health')).body; if (health.app !== 'codex-mobile') throw new Error('本机端口并非移动助手。');
  const login = await request('/api/owner-login', 'POST', { token: owner.hash.slice(7) });
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0]; if (!cookie) throw new Error('未能登录本机管理端。');
  const bootstrap = (await request('/api/bootstrap', 'GET', undefined, { Cookie: cookie })).body;
  if (bootstrap.role !== 'owner' || !bootstrap.csrfToken) throw new Error('本机管理验证失败。');
  return { state, request: async (route, method = 'GET', data) => (await request(route, method, data, { Cookie: cookie, 'X-CSRF-Token': bootstrap.csrfToken })).body };
}

export async function restartAndCheck({ root, edition }, { install = true } = {}) {
  const mac = edition.id === 'macos';
  if ((mac && process.platform !== 'darwin') || (!mac && process.platform !== 'win32')) throw new Error('请在对应操作系统上运行修复入口。');
  await assertStopped(root);
  const executable = mac ? path.join(root, 'runtime', `darwin-${process.arch}`, 'bin/node') : path.join(root, 'Codex-Mobile.exe');
  const args = mac ? [path.join(root, 'lib/mac-launcher.mjs'), root, 'start', '--after-update'] : ['--after-update'];
  const child = spawn(executable, args, { cwd: root, windowsHide: true, detached: mac, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  let client;
  for (let attempt = 0; attempt < 120; attempt++) {
    await sleep(500);
    try { client = await ownerClient(root); break; } catch { /* It takes a moment to start. */ }
  }
  if (!client) throw new Error('安装器已修复；自动重启未完成，请手动运行原启动入口，再到设置中检查更新。');
  const checked = await client.request('/api/updates/check', 'POST');
  if (checked.hasUpdate && install) await client.request('/api/updates/install', 'POST');
  return { ...checked, requestedInstall: Boolean(checked.hasUpdate && install) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--root');
  try {
    if (index < 0 || !process.argv[index + 1]) throw new Error('请使用修复包中的 Repair-Update 启动入口选择旧程序目录。');
    const repaired = await repairInstallation(process.argv[index + 1]);
    console.log('更新安装器已修复，原版本号、账号、手机配对、项目和运行环境保持不变。');
    const state = await restartAndCheck(repaired);
    console.log(state.requestedInstall ? '已交由移动助手校验并安装新版；若电脑仍有任务，程序会暂缓安装。请稍后打开原启动入口查看结果。' : '已重启并检查更新：' + state.reason);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
