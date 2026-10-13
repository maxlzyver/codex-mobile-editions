// Real local service -> real installer/helper -> replace files -> real launcher.
// Only Codex transport and GitHub HTTP are replaced with isolated fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { buildRepairBundle } from './build-update-repair.mjs';
import { ownerClient } from './update-repair/repair-update.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.resolve(process.env.CODEX_UPDATE_E2E_OUTPUT || path.join(REPO, '../../v120-upgrade-verification'));
const LEGACY = process.env.CODEX_UPDATE_E2E_LEGACY === '1';
const OLD = LEGACY ? [{ version: '1.0.0', ref: 'v1.0.0', variant: 'original' }, { version: '1.0.1', ref: 'v1.0.1', variant: 'original' }, { version: '1.0.1', ref: '770664ea23255187b389ce9d6817fe1ed98a4e11', variant: 'rebuilt' }, { version: '1.1.0', ref: '874c8e0', variant: 'original' }] : [{ version: '1.2.0', ref: null, variant: 'current-auto-update' }];
// A future version exists ONLY under this isolated work directory, never in source
// metadata or GitHub. The default exercises automatic updates without a repair.
const TARGET = LEGACY ? '1.2.0' : '1.2.1', PIN = 'e'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async filename => JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
const write = async (filename, bytes) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); };
function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
function zip(entries) {
  const localParts = [], central = []; let offset = 0;
  for (const [entry, data] of entries) {
    const name = Buffer.from(entry), encoded = deflateRawSync(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(encoded.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(encoded.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    localParts.push(local, name, encoded); central.push(directory, name); offset += local.length + name.length + encoded.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, index, end]);
}
async function waitFor(work, message, timeout = 90000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const result = await work(); if (result) return result; } catch (error) { last = error; } await sleep(150); }
  throw new Error(message + (last ? ': ' + last.message : ''));
}
async function launch(root, env) {
  const mac = process.platform === 'darwin';
  const executable = mac ? path.join(root, 'runtime', `darwin-${process.arch}`, 'bin/node') : path.join(root, 'Codex-Mobile.exe');
  const args = mac ? [path.join(root, 'lib/mac-launcher.mjs'), root, 'start', '--after-update'] : ['--after-update'];
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.once('exit', code => { if (code) console.error('Isolated launcher exit', code, output); });
  return child;
}
async function stop(root) {
  try { const client = await ownerClient(root); await client.request('/api/shutdown', 'POST'); } catch { /* May already be closed. */ }
  if (process.platform === 'win32') {
    try { const launcher = await json(path.join(root, '.runtime/launcher-process.json')); assert.equal(path.resolve(launcher.root), path.resolve(root)); await write(path.join(root, '.runtime/update-exit.json'), JSON.stringify(launcher)); } catch { /* No launcher was started. */ }
  }
  for (const name of ['server.json', process.platform === 'darwin' ? 'mac-process.json' : 'launcher-process.json']) {
    let state; try { state = await json(path.join(root, '.runtime', name)); } catch { continue; }
    await waitFor(() => { try { process.kill(state.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, `Isolated ${name} did not stop`, 20000);
  }
}
async function compileLauncher(root, version, permitHost) {
  const source = path.join(root, 'launcher/Launcher.cs');
  let text = await readFile(source, 'utf8'); text = text.replace(/internal const string Version = "[^"]+";/, `internal const string Version = "${version}";`);
  // Test fixture ONLY: Win10 package cannot natively launch on Win11 / Server CI.
  // Keep every startup, tray exit, service, ownership and health check unchanged.
  if (permitHost) text = text.replace(/if \(editionId == "windows10"\) return build >= 19045 && build < 22000;/, 'if (editionId == "windows10") return build >= 19045;');
  await writeFile(source, text);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'build-launcher.ps1')], { windowsHide: true, timeout: 30000 });
}
await mkdir(WORK, { recursive: true });
const RUN = await realpath(await mkdtemp(path.join(WORK, 'cross-version-')));
const editions = (process.env.CODEX_UPDATE_E2E_EDITIONS || (process.platform === 'win32' ? 'windows11,windows10' : process.platform === 'darwin' ? 'macos' : '')).split(',').filter(Boolean);
if (!editions.length) throw new Error('Run on Windows or native macOS. No simulated native-platform pass is reported.');
const versions = process.env.CODEX_UPDATE_E2E_VERSIONS?.split(',');
const results = [];

const bootstrap = path.join(RUN, 'isolate.mjs');
await writeFile(bootstrap, `
import { EventEmitter } from 'node:events';
import { readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(process.env.CODEX_UPDATE_E2E_ROOT, 'server.mjs')) {
  const script = process.argv[1]; process.argv[1] = '';
  const { createConsole } = await import(pathToFileURL(script)); process.argv[1] = script;
  class Bridge extends EventEmitter {
    state = { connected: true, mode: 'standalone' };
    async start() { return this.state; } async close() { this.state.connected = false; }
    async request(method) { if (method === 'account/read') return { account: {} }; if (method === 'thread/list') return { data: existsSync(process.env.CODEX_UPDATE_E2E_BUSY) ? [{ id: 'busy-fixture', cwd: process.env.CODEX_MOBILE_CWD, status: { type: 'active' } }] : [], nextCursor: null }; throw new Error('Isolated upgrade test forbids Codex calls: ' + method); }
  }
  class Tunnel extends EventEmitter { state = { status: 'stopped', url: null }; async stop() {} }
  const app = await createConsole({ bridge: new Bridge(), desktop: false, tunnel: new Tunnel(), onShutdown: () => process.exit(0) });
  app.server.on('request', request => { appendFile(process.env.CODEX_UPDATE_E2E_REQUESTS, request.method + ' ' + request.url + '\\n').catch(() => {}); });
  app.updater.options.fetchImpl = async url => {
    await appendFile(process.env.CODEX_UPDATE_E2E_NETWORK, String(url) + '\\n');
    if (url.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: '${PIN}' }));
    if (url === 'https://raw.githubusercontent.com/maxlzyver/codex-mobile-editions/${PIN}/editions/' + process.env.CODEX_UPDATE_E2E_EDITION + '/update.json') return new Response(await readFile(process.env.CODEX_UPDATE_E2E_MANIFEST));
    if (url === 'https://codeload.github.com/maxlzyver/codex-mobile-editions/zip/${PIN}') return new Response(await readFile(process.env.CODEX_UPDATE_E2E_ARCHIVE));
    throw new Error('Unmocked external network is forbidden: ' + url);
  };
  app.updater.startChecking?.();
  process.once('SIGTERM', () => app.close().finally(() => process.exit(0)));
}
`);

for (const edition of editions) {
  assert.equal(edition === 'macos', process.platform === 'darwin', 'Native platform required');
  const mac = edition === 'macos', permitHost = edition === 'windows10';
  const target = path.join(RUN, 'target-' + edition); await cp(path.join(REPO, 'editions', edition), target, { recursive: true, filter: src => !['.runtime', 'runtime', '.git'].includes(path.basename(src)) });
  const profile = await json(path.join(target, 'edition.json')); profile.version = TARGET; profile.assetName = `codex-mobile-${edition}-${TARGET}-${mac ? 'universal' : 'x64'}.zip`; await writeFile(path.join(target, 'edition.json'), JSON.stringify(profile));
  const pkg = await json(path.join(target, 'package.json')); pkg.version = TARGET; await writeFile(path.join(target, 'package.json'), JSON.stringify(pkg));
  if (!mac) await compileLauncher(target, TARGET, permitHost);
  const files = [];
  async function walk(directory, relative = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = relative + item.name; if (name === 'update.json' || name.startsWith('vendor/cloudflared')) continue;
      if (item.isDirectory()) await walk(path.join(directory, item.name), name + '/');
      else files.push({ path: name, bytes: await readFile(path.join(directory, item.name)) });
    }
  }
  await walk(target);
  const manifest = { name: 'Codex 移动助手', edition, platform: profile.platform, repository: profile.repository, version: TARGET, runtimePolicy: 'preserve', releaseNotes: `${TARGET} 仅用于隔离升级测试`, files: files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: hash(file.bytes) })) };
  const manifestPath = path.join(RUN, `${edition}-update.json`); await writeFile(manifestPath, JSON.stringify(manifest));
  const archivePath = path.join(RUN, `${edition}-source.zip`); await writeFile(archivePath, zip([...files.map(file => [`codex-mobile-editions-${PIN}/editions/${edition}/${file.path}`, file.bytes]), [`codex-mobile-editions-${PIN}/editions/${edition}/update.json`, Buffer.from(JSON.stringify(manifest))]]));
  const bundle = LEGACY ? await buildRepairBundle(path.join(RUN, 'repair-' + edition), [edition]) : null;
  for (const old of OLD.filter(old => !versions || versions.includes(old.version))) {
    const scratch = path.join(RUN, `${edition}-${old.version}-${old.variant}`), extracted = path.join(scratch, 'old-source'); await mkdir(extracted, { recursive: true });
    if (old.ref) {
      const tar = execFileSync('git', ['archive', '--format=tar', old.ref, `editions/${edition}`], { cwd: REPO, maxBuffer: 50 * 1024 * 1024 });
      execFileSync('tar', ['-xf', '-', '-C', extracted], { input: tar });
    }
    const root = path.join(scratch, 'installed 中文'), runtime = path.join(root, '.runtime'), project = path.join(scratch, 'user project 中文');
    await cp(old.ref ? path.join(extracted, 'editions', edition) : path.join(REPO, 'editions', edition), root, { recursive: true, filter: src => !['.runtime', 'runtime', '.git'].includes(path.basename(src)) }); await mkdir(runtime, { recursive: true }); await mkdir(project, { recursive: true });
    assert.equal((await json(path.join(root, 'edition.json'))).version, old.version);
    const node = path.join(root, mac ? `runtime/darwin-${process.arch}/bin/node` : 'runtime/node.exe'); await mkdir(path.dirname(node), { recursive: true }); await cp(process.execPath, node); await chmod(node, 0o755);
    let codex = node;
    if (mac) { codex = path.join(scratch, 'codex-fixture'); await write(codex, '#!/bin/sh\nexit 0\n'); await chmod(codex, 0o755); }
    await write(path.join(runtime, 'launcher.json'), JSON.stringify({ defaultCwd: project, codexBinary: codex }));
    if (!mac) await compileLauncher(root, old.version, permitHost);
    const sentinels = { '.runtime/devices.json': JSON.stringify([{ id: 'paired-phone', hash: hash('fixture-phone-cookie'), role: 'controller', csrf: 'paired-csrf', name: 'Existing phone', createdAt: 1, lastSeen: 1, expiresAt: Date.now() + 86400000 }], null, 2), '.runtime/mobile-permissions.json': JSON.stringify({ allowOtherFiles: false, allowMobileStop: false }), '.runtime/updates/settings.json': JSON.stringify({ autoUpdate: !LEGACY }), '.runtime/custom-settings.json': 'keep settings', 'workspace/keep.txt': 'keep workspace', 'runtime/LICENSE': 'keep runtime license', ...(mac ? { [`runtime/darwin-${process.arch === 'arm64' ? 'x64' : 'arm64'}/bin/node`]: 'inert non-host runtime sentinel; native CI covers the other architecture separately', 'vendor/cloudflared-darwin-arm64': 'inert arm64 tunnel', 'vendor/cloudflared-darwin-x64': 'inert x64 tunnel' } : { 'vendor/cloudflared-windows-amd64.exe': 'inert tunnel fixture', 'vendor/cloudflared-release.json': JSON.stringify({ sha256: hash('inert tunnel fixture') }) }) };
    for (const [name, value] of Object.entries(sentinels)) await write(path.join(root, name), value);
    await write(path.join(project, '用户项目.txt'), 'project content preserved');
    const nodeHash = hash(await readFile(node)), config = await json(path.join(runtime, 'launcher.json'));
    const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(bootstrap).href}`, CODEX_UPDATE_E2E_ROOT: root, CODEX_UPDATE_E2E_EDITION: edition, CODEX_UPDATE_E2E_ARCHIVE: archivePath, CODEX_UPDATE_E2E_MANIFEST: manifestPath, CODEX_UPDATE_E2E_NETWORK: path.join(scratch, 'network.txt'), CODEX_UPDATE_E2E_REQUESTS: path.join(scratch, 'requests.txt'), CODEX_UPDATE_E2E_BUSY: path.join(scratch, 'task-is-running'), CODEX_BINARY: codex, CODEX_MOBILE_CWD: project, CODEX_MOBILE_PORT: '0' };
    if (!LEGACY) await writeFile(env.CODEX_UPDATE_E2E_BUSY, 'An isolated task is running');
    // Launcher requires a stable non-privileged port; reserve one with a short-lived socket.
    const net = await import('node:net'); const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); env.CODEX_MOBILE_PORT = String(reservation.address().port); await new Promise(resolve => reservation.close(resolve));
    let originalFailure = null;
    try {
      await launch(root, env); let client = await waitFor(() => ownerClient(root), 'Old real server did not start');
      const originalPid = client.state.pid;
      const checked = LEGACY ? await client.request('/api/updates/check', 'POST') : await waitFor(async () => { const state = await client.request('/api/updates'); return state.status === 'waitingForIdle' ? state : null; }, 'Automatic startup did not defer the busy task');
      assert.equal(checked.latestVersion, TARGET); assert.equal(checked.autoUpdate, !LEGACY);
      if (checked.releaseNotes !== undefined) assert.equal(checked.releaseNotes, manifest.releaseNotes);
      assert.equal((await readFile(env.CODEX_UPDATE_E2E_NETWORK, 'utf8')).includes('codeload'), false, 'Checking and notifications must not download/install');
      if (LEGACY) await client.request('/api/updates/install', 'POST');
      else {
        assert.equal((await json(path.join(root, 'edition.json'))).version, old.version);
        assert.equal((await readdir(path.join(runtime, 'updates'))).some(name => name.startsWith('install-')), false);
        await sleep(1000);
        assert.equal((await readFile(env.CODEX_UPDATE_E2E_NETWORK, 'utf8')).includes('codeload'), false, 'A busy automatic update must not download');
        await rm(env.CODEX_UPDATE_E2E_BUSY);
        console.log('PASS busy protection; awaiting the real automatic idle retry', edition);
      }
      if (LEGACY && !mac) {
        const failure = await waitFor(async () => { const state = await client.request('/api/updates'); return state.status === 'error' ? state : null; }, 'Original installer did not expose its failure');
        assert.match(failure.error, /接管前已退出（0）/); originalFailure = failure.error;
        assert.equal((await json(path.join(root, 'edition.json'))).version, old.version); process.kill(originalPid, 0);
        await stop(root);
        // Run the distributed repair CLI, including its own real launcher and
        // automatic owner-authenticated install request; it then exits itself.
        const repair = spawn(node, [path.join(bundle, 'repair-update.mjs'), '--root', root], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let repairOutput = ''; for (const stream of [repair.stdout, repair.stderr]) stream.on('data', data => { repairOutput += data; });
        const repairExit = await new Promise((resolve, reject) => { repair.once('error', reject); repair.once('exit', resolve); });
        assert.equal(repairExit, 0, repairOutput);
        const backups = (await readdir(path.join(runtime, 'updates'))).filter(name => name.startsWith('repair-'));
        assert.equal(backups.length, 1); assert.equal((await json(path.join(runtime, 'updates', backups[0], 'repair-result.json'))).from, old.version);
      }
      const installed = await waitFor(async () => {
        const jobs = (await readdir(path.join(runtime, 'updates'))).filter(name => name.startsWith(`install-${TARGET}-`));
        for (const job of jobs) { let state; try { state = await json(path.join(runtime, 'updates', job, 'status.json')); } catch { continue; }
          if (state.status === 'complete') return { job, state }; if (['rolled-back', 'rollback-failed'].includes(state.status)) throw new Error(JSON.stringify(state)); }
        return null;
      }, 'Real installer did not finish and restart', 150000);
      const current = await ownerClient(root); assert.notEqual(current.state.pid, originalPid); assert.equal((await current.request('/health')).version, TARGET);
      const startup = await waitFor(async () => { const state = await current.request('/api/updates'); return state.checkedAt ? state : null; }, 'New server did not perform its startup update check');
      assert.equal(startup.autoUpdate, !LEGACY); assert.equal(startup.status, 'upToDate'); assert.equal(startup.releaseNotes, manifest.releaseNotes);
      assert.equal((await json(path.join(root, 'edition.json'))).version, TARGET);
      for (const file of files) assert.equal(hash(await readFile(path.join(root, file.path))), hash(file.bytes), 'Installed hash: ' + file.path);
      for (const [name, value] of Object.entries(sentinels)) assert.equal(await readFile(path.join(root, name), 'utf8'), value, 'Preserved sentinel: ' + name);
      assert.equal(hash(await readFile(node)), nodeHash); assert.deepEqual(await json(path.join(runtime, 'launcher.json')), config); assert.equal(await readFile(path.join(project, '用户项目.txt'), 'utf8'), 'project content preserved');
      const phone = await (await fetch(`http://127.0.0.1:${current.state.port}/api/bootstrap`, { headers: { Cookie: `codex_mobile_${current.state.port}=fixture-phone-cookie` } })).json();
      assert.equal(phone.role, 'controller', 'Existing phone pairing must still authenticate after restart'); assert.equal(phone.session.name, 'Existing phone');
      if (!LEGACY) {
        assert.equal((await readFile(env.CODEX_UPDATE_E2E_NETWORK, 'utf8')).split('\n').filter(url => url.includes('codeload')).length, 1, 'Exactly one automatic archive download');
        const requests = await readFile(env.CODEX_UPDATE_E2E_REQUESTS, 'utf8');
        assert.equal(requests.includes('POST /api/updates/check'), false); assert.equal(requests.includes('POST /api/updates/install'), false);
      }
      const plan = await json(path.join(runtime, 'updates', installed.job, 'plan.json')); assert.equal(plan.testMode, false);
      results.push({ edition, from: old.version, variant: old.variant, oldRef: old.ref, to: TARGET, syntheticFutureOnly: !LEGACY, automatic: !LEGACY, busyPreventedDownload: !LEGACY, manualCheckPosts: LEGACY ? 1 : 0, manualInstallPosts: LEGACY ? 1 : 0, originalFailure, repaired: LEGACY && !mac, realRepairEntry: LEGACY && !mac, actualServer: true, actualLauncher: true, launcherPlatformGuardAdaptedForHost: permitHost, nativePlatform: process.platform, nativeArchitecture: process.arch, realHandoffApplyRestart: true, manifestSha256: hash(await readFile(manifestPath)), verifiedFiles: files.length, sentinelsPreserved: true, testMode: false });
      console.log('PASS true upgrade', edition, old.version, old.variant, '->', TARGET, LEGACY ? '(legacy path)' : '(fully automatic, busy then idle, no repair, no check/install POST)');
    } finally { await stop(root); }
    await writeFile(path.join(RUN, 'report.json'), JSON.stringify({ ok: true, results }, null, 2));
  }
}
console.log('Evidence:', path.join(RUN, 'report.json'));
