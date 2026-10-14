import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay, noLinks, snapshotProcess, stopOwnedProcess, verifyOwnedProcess } from '../tools/apply-update.mjs';

const exec = promisify(execFile);
export function macNodePath(rootDir, arch = process.arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('需要 Intel 或 Apple 芯片的 Mac。');
  return path.join(rootDir, 'runtime', `darwin-${arch}`, 'bin/node');
}
export function assertMac(platform = process.platform, kernel = os.release()) {
  if (platform !== 'darwin' || Number(kernel.split('.')[0]) < 23) throw new Error('此专用版需要 macOS 14 或更新版本。');
}
export function codexCandidates({ configured, home = os.homedir(), env = process.env } = {}) {
  return [...new Set([configured, env.CODEX_BINARY,
    '/Applications/Codex.app/Contents/Resources/codex', path.join(home, 'Applications/Codex.app/Contents/Resources/codex'),
    path.join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'codex')),
  ].filter(Boolean))];
}
export async function findCodex(configured) {
  for (const candidate of codexCandidates({ configured })) {
    try {
      await access(candidate, constants.X_OK);
      const filename = await realpath(candidate);
      if (!(await lstat(filename)).isFile()) continue;
      await exec(filename, ['--version'], { timeout: 8000, maxBuffer: 4096 });
      return filename;
    } catch { /* Try the next locally installed Codex binary. */ }
  }
  throw new Error('未发现 Codex。请先安装并打开官方 Codex 桌面应用，或安装 Codex CLI，再双击 Start.command。');
}
async function json(filename) { return JSON.parse(await readFile(filename, 'utf8')); }
async function configuration(root, { choose = false, silent = false } = {}) {
  const filename = path.join(root, '.runtime/launcher.json');
  let config = {}; try { config = await json(filename); } catch (error) { if (error.code !== 'ENOENT') throw new Error('启动配置损坏，请检查 .runtime/launcher.json。'); }
  if (process.env.CODEX_MOBILE_CWD) config.defaultCwd = process.env.CODEX_MOBILE_CWD;
  if (!config.defaultCwd || choose) {
    if (silent) throw new Error('缺少工作目录配置，请先在插件中选择工作目录，或双击 Start.command。');
    const script = 'on run argv\nset chosen to choose folder with prompt "选择 Codex 工作目录（手机可访问此目录中的项目文件）"\nreturn POSIX path of chosen\nend run';
    const selection = await exec('/usr/bin/osascript', ['-e', script], { timeout: 300000, maxBuffer: 8192 });
    config.defaultCwd = selection.stdout.trim();
  }
  if (!path.isAbsolute(config.defaultCwd) || !(await lstat(config.defaultCwd)).isDirectory()) throw new Error('所选工作目录不存在，请运行 Start.command --configure。');
  config.codexBinary = await findCodex(config.codexBinary);
  config.defaultCwd = await realpath(config.defaultCwd);
  await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  return config;
}
export async function findRunningConsole(root, { verifyProcess = verifyOwnedProcess } = {}) {
  let identity;
  try { identity = await json(path.join(root, '.runtime/mac-process.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { if (!await verifyProcess(identity, root)) return null; }
  catch (error) { if (error.code === 'PROCESS_IDENTITY_MISMATCH') return null; throw error; }
  const state = await json(path.join(root, '.runtime/server.json'));
  if (state.pid !== identity.pid || state.root !== root || !Number.isInteger(state.port)) throw new Error('正在运行的服务身份不匹配。');
  const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok || (await response.json()).app !== 'codex-mobile') throw new Error('本控制台正在启动或关闭，请稍后重试。');
  return { identity, state };
}
async function showOwner(root) {
  const url = (await readFile(path.join(root, '.runtime/owner-url.txt'), 'utf8')).trim();
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.hash.startsWith('#owner=')) throw new Error('电脑管理链接无效。');
  await exec('/usr/bin/open', [url], { timeout: 10000 });
}
async function lockStart(runtime) {
  const filename = path.join(runtime, 'start.lock'); await noLinks(filename);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await open(filename, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close(); return async () => rm(filename, { force: true }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try { const previous = await json(filename); if (!Number.isSafeInteger(previous.pid) || previous.pid < 2) throw new Error('无效启动锁'); process.kill(previous.pid, 0); }
      catch (failure) { stale = failure.code === 'ESRCH'; }
      if (!stale) throw new Error('控制台已在启动，请等待已打开的设置窗口。');
      await rm(filename);
    }
  }
  throw new Error('无法取得控制台启动锁。');
}

export async function main(rootDir, command = 'start', options = []) {
  assertMac();
  const root = await realpath(rootDir), runtime = path.join(root, '.runtime');
  await noLinks(runtime); await mkdir(runtime, { recursive: true, mode: 0o700 });
  const silent = options.includes('--after-update') || options.includes('--headless');
  if (command === 'login') {
    let configured; try { configured = (await json(path.join(runtime, 'launcher.json'))).codexBinary; } catch { /* First login may precede configuration. */ }
    const binary = await findCodex(configured);
    const child = spawn(binary, ['login'], { stdio: 'inherit', shell: false });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    if (code !== 0) throw new Error('Codex 登录未完成。也可先在官方 Codex 桌面应用中登录。');
    console.log('登录完成。现在可以双击 Start.command。'); return;
  }
  if (command === 'stop') {
    let identity; try { identity = await json(path.join(runtime, 'mac-process.json')); } catch (error) { if (error.code === 'ENOENT') { console.log('本控制台未启动。'); return; } throw error; }
    await stopOwnedProcess(identity, root);
    await rm(path.join(runtime, 'mac-process.json'), { force: true });
    console.log('本控制台已停止。'); return;
  }
  if (command !== 'start') throw new Error('未知启动命令。');
  const releaseLock = await lockStart(runtime);
  try {
    if (await findRunningConsole(root)) { if (!silent) await showOwner(root); return; }
    const config = await configuration(root, { choose: options.includes('--configure'), silent });
    try { await exec(config.codexBinary, ['login', 'status'], { timeout: 15000, maxBuffer: 8192 }); }
    catch { throw new Error('Codex 尚未登录。请先在官方 Codex 桌面应用登录，或双击 Login.command 完成登录，再重试。'); }
    const node = macNodePath(root), script = path.join(root, 'server.mjs'), nonce = randomBytes(16).toString('hex');
    await access(node, constants.X_OK);
    const output = await open(path.join(runtime, 'server.log'), 'a', 0o600), errors = await open(path.join(runtime, 'server-error.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(node, [script, `--codex-mobile-instance=${nonce}`], { detached: true, shell: false, cwd: root,
        stdio: ['ignore', output.fd, errors.fd], env: { ...process.env, CODEX_BINARY: config.codexBinary, CODEX_MOBILE_CWD: config.defaultCwd, CODEX_MOBILE_PORT: process.env.CODEX_MOBILE_PORT || String(config.port || 43127) },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } finally { await output.close(); await errors.close(); }
    child.unref();
    const identity = { ...await snapshotProcess(child.pid), root, script, nonce };
    await writeFile(path.join(runtime, 'mac-process.json'), JSON.stringify(identity), { mode: 0o600 });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) { await delay(250); try { ready = Boolean(await findRunningConsole(root)); if (ready) break; } catch { /* Initialization may still be in progress. */ } }
    if (!ready) { await stopOwnedProcess(identity, root); throw new Error('控制台启动超时。请查看 .runtime/server-error.log。'); }
    if (!silent) { await showOwner(root); console.log('Codex 移动助手已在后台运行。此终端窗口可以关闭；双击 Stop.command 可停止。'); }
  } finally { await releaseLock(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.argv[3], process.argv.slice(4)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
