import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readEditionProfile, editionAssetName, UPDATE_REPOSITORY } from '../lib/updater.mjs';
import { createInstaller, runUpdateHelper, validatePreparedUpdate, validateUpdatePath } from '../lib/update-installer.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORK = fileURLToPath(new URL('../../../../../work/', import.meta.url));
const edition = readEditionProfile(ROOT);
// Keep the simulated installation independent of the release currently under test.
const PROFILE = { ...edition, version: '1.0.0', assetName: editionAssetName(edition, '1.0.0') };
const sha = value => createHash('sha256').update(value).digest('hex');
function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
function zip(entries) {
  const records = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((entry.attributes || 0) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    records.push(local, name, data); central.push(directory, name); offset += local.length + name.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, index, end]);
}

async function fixture(t, { repository = true, preserve = false, extras = [], badHash = false, targetEdition = PROFILE } = {}) {
  await mkdir(WORK, { recursive: true });
  const scratch = await mkdtemp(path.join(WORK, 'update-installer-test-'));
  t.after(async () => { const target = path.resolve(scratch); assert.equal(path.dirname(target).toLowerCase(), path.resolve(WORK).toLowerCase()); assert.ok(path.basename(target).startsWith('update-installer-test-')); await rm(target, { recursive: true, force: true }); });
  const rootDir = path.join(scratch, 'installed-中文目录'), runtimeDir = path.join(rootDir, '.runtime'), jobDir = path.join(runtimeDir, 'updates', 'job');
  await mkdir(jobDir, { recursive: true });
  const files = {
    'edition.json': JSON.stringify({ ...targetEdition, version: '1.0.1', assetName: editionAssetName(targetEdition, '1.0.1') }),
    'lib/new.mjs': 'export const added = true;', 'server.mjs': 'new-server',
    'package.json': JSON.stringify({ name: 'codex-mobile-console', version: '1.0.1', description: 'Codex 移动助手：' + PROFILE.platform + ' 的手机浏览器工作台' }),
    'lib/中文目录/说明.mjs': 'export const greeting = "你好，手机";',
    'Codex-Mobile.exe': 'MZ-test-launcher-not-executable', 'LICENSE': 'Test license', 'README.md': 'Test readme',
    'lib/security.mjs': 'new-security', 'public/index.html': '<p>new-ui</p>',
    'tools/apply-update.ps1': 'updated-placeholder-never-executed', 'vendor/qrcode.cjs': 'qrcode-test',
    ...(!preserve ? { 'runtime/node.exe': 'MZ-test-runtime-not-executable' } : {}),
  };
  for (const [relative, value] of Object.entries({ 'edition.json': JSON.stringify(PROFILE), 'server.mjs': 'old-server', 'package.json': JSON.stringify({name:'codex-mobile-console',version:'1.0.0'}), 'README.md': 'old-readme', '.runtime/devices.json': 'private-phone-cookie', 'workspace/user.txt': 'user-work', 'custom.txt': 'user-custom', 'public/user-note.txt': 'keep-unknown-user-file', 'runtime/node.exe': 'MZ-old-runtime', 'runtime/LICENSE': 'old-runtime-license', 'vendor/cloudflared-windows-amd64.exe': 'MZ-old-cloudflare', 'vendor/cloudflared-release.json': JSON.stringify({sha256:sha('MZ-old-cloudflare')}) })) {
    const filename = path.join(rootDir, relative); await mkdir(path.dirname(filename), {recursive:true}); await writeFile(filename, value);
  }
  const commit = 'a'.repeat(40), prefix = `codex-mobile-editions-${commit}/${PROFILE.updatePath}/`;
  const archive = zip([...Object.entries(files).map(([name, data]) => ({name: prefix + name, data})), ...extras]);
  const assetName = editionAssetName(PROFILE, '1.0.1');
  const entries = Object.entries(files).map(([name, data]) => ({path: name, bytes:Buffer.byteLength(data),sha256:sha(data)}));
  if (badHash) entries[0].sha256 = '0'.repeat(64);
  const manifest = {name:'Codex 移动助手',version:'1.0.1',edition:PROFILE.id,platform:PROFILE.platform,repository:UPDATE_REPOSITORY,files:entries,...(preserve?{runtimePolicy:'preserve'}:{})};
  const zipPath = path.join(runtimeDir,'updates',assetName), manifestPath = path.join(runtimeDir,'updates','manifest.json');
  await writeFile(zipPath,archive); await writeFile(manifestPath,JSON.stringify(manifest));
  const prepared = {editionId:PROFILE.id,version:'1.0.1',zipPath,sha256:sha(archive),size:archive.length,manifestPath,manifestSha256:sha(JSON.stringify(manifest)),assetName,releaseUrl:'https://github.com/'+UPDATE_REPOSITORY+'/tree/'+commit,source:'repository',sourceCommit:commit,archivePrefix:prefix};
  const plan = {schema:1,rootDir,runtimeDir,jobDir,...prepared,server:null,restartPort:43127,testMode:true};
  const planPath = path.join(jobDir,'plan.json'), script = path.join(jobDir,'apply-update.ps1');
  await copyFile(path.join(ROOT,'tools','apply-update.ps1'),script);
  async function savePlan() { const body = JSON.stringify(plan); await writeFile(planPath,body); return sha(body); }
  let planHash = await savePlan();
  return {rootDir,runtimeDir,jobDir,prepared,plan,planPath,script,files,
    async prepare() { await validatePreparedUpdate(prepared,{rootDir,runtimeDir}); await runUpdateHelper(script,planPath,planHash,'Prepare',{testOnly:true}); plan.inventorySha256=sha(await readFile(path.join(jobDir,'inventory.json'))); planHash=await savePlan(); },
    async apply(failAfterFiles=0) { return runUpdateHelper(script,planPath,planHash,'Apply',{testOnly:true,failAfterFiles}); },
  };
}

test('installer rejects ZipSlip, ADS, absolute paths and private update paths', () => {
  for(const value of ['../outside','codex-mobile/../outside','codex-mobile/.runtime/devices.json','codex-mobile/workspace/file','codex-mobile/lib/a:stream','codex-mobile/lib/CON.txt','codex-mobile/lib/name.','codex-mobile/C:\\file']) assert.throws(()=>validateUpdatePath(value));
  assert.equal(validateUpdatePath('codex-mobile/lib/new.mjs'),'lib/new.mjs');
});

test('verified fixture update reads UTF-8 JSON and Chinese paths while preserving user data', {skip:process.platform!=='win32'}, async t => {
  const f=await fixture(t); await f.prepare(); await f.apply();
  assert.equal(await readFile(path.join(f.rootDir,'server.mjs'),'utf8'),'new-server');
  assert.equal(await readFile(path.join(f.runtimeDir,'devices.json'),'utf8'),'private-phone-cookie');
  assert.equal(await readFile(path.join(f.rootDir,'workspace/user.txt'),'utf8'),'user-work');
  assert.equal(await readFile(path.join(f.rootDir,'public/user-note.txt'),'utf8'),'keep-unknown-user-file');
  assert.equal(JSON.parse(await readFile(path.join(f.rootDir,'package.json'),'utf8')).description, 'Codex 移动助手：' + PROFILE.platform + ' 的手机浏览器工作台');
  assert.equal(await readFile(path.join(f.rootDir,'lib/中文目录/说明.mjs'),'utf8'), 'export const greeting = "你好，手机";');
  assert.equal(JSON.parse(await readFile(path.join(f.jobDir,'status.json'),'utf8')).status,'complete');
});

test('simulated copy failure rolls back overwritten and newly introduced program files', {skip:process.platform!=='win32'}, async t => {
  const f=await fixture(t); await f.prepare(); await assert.rejects(f.apply(3),/Simulated copy failure/);
  assert.equal(await readFile(path.join(f.rootDir,'server.mjs'),'utf8'),'old-server');
  assert.equal(JSON.parse(await readFile(path.join(f.rootDir,'package.json'),'utf8')).version,'1.0.0');
  await assert.rejects(readFile(path.join(f.rootDir,'lib/new.mjs')),{code:'ENOENT'});
  assert.equal(await readFile(path.join(f.runtimeDir,'devices.json'),'utf8'),'private-phone-cookie');
  assert.equal(JSON.parse(await readFile(path.join(f.jobDir,'status.json'),'utf8')).status,'rolled-back');
});

test('repository folder update validates each file and ignores nonmanifest repository files', {skip:process.platform!=='win32'}, async t => {
  const commit='a'.repeat(40);
  const f=await fixture(t,{repository:true,extras:[{name:`codex-mobile-${commit}/unmanaged.txt`,data:'not installed'}]});
  await f.prepare(); await f.apply();
  assert.equal(JSON.parse(await readFile(path.join(f.rootDir,'update.json'),'utf8')).version,'1.0.1');
  await assert.rejects(readFile(path.join(f.rootDir,'unmanaged.txt')),{code:'ENOENT'});
});

test('lightweight repository update preserves the existing runtime and cloudflared', {skip:process.platform!=='win32'}, async t => {
  const f=await fixture(t,{repository:true,preserve:true}); await f.prepare(); await f.apply();
  assert.equal(await readFile(path.join(f.rootDir,'runtime/node.exe'),'utf8'),'MZ-old-runtime');
  assert.equal(await readFile(path.join(f.rootDir,'vendor/cloudflared-windows-amd64.exe'),'utf8'),'MZ-old-cloudflare');
});

test('old-repository or cross-edition download plans cannot be installed', async t => {
  const f = await fixture(t);
  for (const patch of [{editionId:PROFILE.id==='windows11'?'windows10':'windows11'}, {source:'release'}, {archivePrefix:'codex-mobile-'+ 'a'.repeat(40) +'/codex-mobile/'}, {releaseUrl:'https://github.com/maxlzyver/codex-mobile/tree/'+'a'.repeat(40)}, {assetName:'codex-mobile-1.0.1-win11-x64.zip'}]) {
    await assert.rejects(validatePreparedUpdate({...f.prepared,...patch},f), /来源|专用版/);
  }
});

test('a correctly hashed ZIP from the other Windows edition is rejected before program changes', {skip:process.platform!=='win32'}, async t => {
  const id = PROFILE.id === 'windows11' ? 'windows10' : 'windows11';
  const targetEdition = {...PROFILE,id,platform:id==='windows11'?'Windows 11 x64':'Windows 10 x64',updatePath:'editions/'+id};
  targetEdition.assetName=editionAssetName(targetEdition,targetEdition.version);
  const f=await fixture(t,{targetEdition});
  await assert.rejects(f.prepare(),/Extracted edition.json/);
  assert.equal(await readFile(path.join(f.rootDir,'server.mjs'),'utf8'),'old-server');
});

test('a mismatched file hash and symlink archive are rejected before modifying programs', {skip:process.platform!=='win32'}, async t => {
  const hash=await fixture(t,{badHash:true}); await assert.rejects(hash.prepare(),/checksum\s+mismatch/);
  assert.equal(await readFile(path.join(hash.rootDir,'server.mjs'),'utf8'),'old-server');
  const link=await fixture(t,{extras:[{name:'codex-mobile/lib/link',data:'../../outside',attributes:(0xa1ff<<16)>>>0}]});
  await assert.rejects(link.prepare(),/symbolic links/);
});

test('tampering with prepared inventory cancels apply and busy state never invokes shutdown', {skip:process.platform!=='win32'}, async t => {
  const f=await fixture(t); await f.prepare();
  await writeFile(path.join(f.jobDir,'inventory.json'),'[]');
  await assert.rejects(f.apply(),/inventory\s+changed/);
  let called=false;
  const install=createInstaller({rootDir:f.rootDir,runtimeDir:f.runtimeDir,isBusy:()=>true,onBeforeInstall:()=>{called=true;}});
  await assert.rejects(install(f.prepared),error=>error.status===409);
  assert.equal(called,false);
});

test('local manifest tampering and malicious extra ZIP paths are rejected', {skip:process.platform!=='win32'}, async t => {
  const manifest=await fixture(t);
  await writeFile(manifest.prepared.manifestPath,'{}');
  await assert.rejects(validatePreparedUpdate(manifest.prepared,manifest),/清单的 SHA256/);
  const traversal=await fixture(t,{repository:true,extras:[{name:'codex-mobile-'+'a'.repeat(40)+'/../escape.txt',data:'no'}]});
  await assert.rejects(traversal.prepare(),/path traversal/);
  assert.equal(await readFile(path.join(traversal.rootDir,'server.mjs'),'utf8'),'old-server');
});

// Exercise the production handoff promise without launching processes or closing a service.
async function handshakeFixture(t, { behavior = 'waiting', isBusy = () => false, onBeforeInstall = async () => {}, beforeShutdownDelayMs = 0 } = {}) {
  const f = await fixture(t);
  await mkdir(path.join(f.rootDir, 'tools'), { recursive: true });
  await copyFile(path.join(ROOT, 'tools/apply-update.ps1'), path.join(f.rootDir, 'tools/apply-update.ps1'));
  await writeFile(path.join(f.runtimeDir, 'server.json'), JSON.stringify({ pid: process.pid, root: f.rootDir, port: 43127 }));
  let installJob, shutdownCalls = 0;
  const install = createInstaller({
    rootDir: f.rootDir, runtimeDir: f.runtimeDir, handshakeTimeoutMs: 250, beforeShutdownDelayMs, isBusy,
    onBeforeInstall: async () => { shutdownCalls++; await onBeforeInstall(); },
    runHelper: async (_script, planPath, _hash, mode) => {
      assert.equal(mode, 'Prepare');
      installJob = path.dirname(planPath);
      await writeFile(path.join(installJob, 'inventory.json'), '[]');
      await writeFile(path.join(installJob, 'status.json'), JSON.stringify({ version: f.prepared.version, status: 'prepared' }));
    },
    spawnProcess: (_command, args, options) => {
      assert.equal(args.at(-1), 'Apply');
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.unref = () => {};
      setImmediate(() => {
        if (behavior === 'spawn-error') { child.emit('error', new Error('mock spawn failed')); return; }
        child.emit('spawn');
        if (behavior === 'exit') { child.emit('exit', 1); return; }
        if (behavior === 'timeout') return;
        const status = behavior === 'error-status' ? 'error' : 'waiting';
        writeFile(path.join(installJob, 'status.json'), JSON.stringify({ version: f.prepared.version, status, message: 'mock helper validation' }))
          .then(() => { if (behavior === 'exit-after-waiting') setTimeout(() => child.emit('exit', 1), 120); })
          .catch(error => child.emit('error', error));
      });
      return child;
    },
  });
  return { ...f, install, get installJob() { return installJob; }, get shutdownCalls() { return shutdownCalls; } };
}

async function assertCancelledHandoff(f) {
  assert.deepEqual(JSON.parse(await readFile(path.join(f.installJob, 'cancel.json'), 'utf8')), { cancelled: true });
  await assert.rejects(readFile(path.join(f.installJob, 'apply-ready.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.rootDir, 'server.mjs'), 'utf8'), 'old-server');
}

test('helper spawn, exit, validation and timeout failures reject without closing the service', async t => {
  for (const [behavior, expression] of [
    ['spawn-error', /mock spawn failed/], ['exit', /接管前已退出/],
    ['error-status', /mock helper validation/], ['timeout', /未在限定时间内准备好/],
  ]) {
    await t.test(behavior, async subtest => {
      const f = await handshakeFixture(subtest, { behavior });
      await assert.rejects(f.install(f.prepared), expression);
      assert.equal(f.shutdownCalls, 0);
      await assertCancelledHandoff(f);
    });
  }
});

test('helper exit during the shutdown delay cancels before the close callback', async t => {
  const f = await handshakeFixture(t, { behavior: 'exit-after-waiting', beforeShutdownDelayMs: 160 });
  await assert.rejects(f.install(f.prepared), /接管前已退出/);
  assert.equal(f.shutdownCalls, 0);
  await assertCancelledHandoff(f);
});

test('a task becoming busy after helper waiting rejects instead of reporting scheduled', async t => {
  let busyChecks = 0;
  const f = await handshakeFixture(t, { isBusy: () => ++busyChecks === 3 });
  await assert.rejects(f.install(f.prepared), error => error.status === 409);
  assert.equal(busyChecks, 3);
  assert.equal(f.shutdownCalls, 0);
  await assertCancelledHandoff(f);
});

test('shutdown callback failure propagates, records cancellation and permits a retry', async t => {
  let fail = true;
  const f = await handshakeFixture(t, { onBeforeInstall: async () => { if (fail) throw new Error('mock close failed'); } });
  await assert.rejects(f.install(f.prepared), /mock close failed/);
  assert.equal(f.shutdownCalls, 1);
  await assertCancelledHandoff(f);
  fail = false;
  const result = await f.install(f.prepared);
  assert.equal(result.scheduled, true);
  assert.equal(f.shutdownCalls, 2);
});

test('scheduled is returned only after helper waiting, shutdown completion and ready signal', async t => {
  let reachedClose, releaseClose, settled = false;
  const closing = new Promise(resolve => { reachedClose = resolve; });
  const permitClose = new Promise(resolve => { releaseClose = resolve; });
  const f = await handshakeFixture(t, { onBeforeInstall: async () => { reachedClose(); await permitClose; } });
  const installing = f.install(f.prepared).then(result => { settled = true; return result; });
  try {
    await closing;
    assert.equal(JSON.parse(await readFile(path.join(f.installJob, 'status.json'), 'utf8')).status, 'waiting');
    assert.equal(settled, false);
    await assert.rejects(readFile(path.join(f.installJob, 'apply-ready.json')), { code: 'ENOENT' });
  } finally { releaseClose(); }
  const result = await installing;
  assert.deepEqual(result, { scheduled: true, version: f.prepared.version, statusPath: path.join(f.installJob, 'status.json') });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.installJob, 'apply-ready.json'), 'utf8')), { ready: true });
  await assert.rejects(readFile(path.join(f.installJob, 'cancel.json')), { code: 'ENOENT' });
});
