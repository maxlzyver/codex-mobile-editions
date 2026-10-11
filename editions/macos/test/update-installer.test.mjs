import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createInstaller } from '../lib/update-installer.mjs';
import { applyUpdate, assertProcessSnapshot, delay, digest, fileHash, prepareUpdate, readZipEntries, signalApplyReady, snapshotProcess, stopOwnedProcess, validatePreparedUpdate, validateUpdatePath, verifyOwnedProcess, waitForApplyReady } from '../tools/apply-update.mjs';
import { findRunningConsole } from '../lib/mac-launcher.mjs';

const WORK = fileURLToPath(new URL('../../../../../work/', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
function zip(entries) {
  const localParts = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), encoded = deflateRawSync(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6); local.writeUInt16LE(8,8); local.writeUInt32LE(crc32(data),14); local.writeUInt32LE(encoded.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314,4); directory.writeUInt16LE(20,6); directory.writeUInt16LE(0x800,8); directory.writeUInt16LE(8,10); directory.writeUInt32LE(crc32(data),16); directory.writeUInt32LE(encoded.length,20); directory.writeUInt32LE(data.length,24); directory.writeUInt16LE(name.length,28); directory.writeUInt32LE(entry.attributes || 0,38); directory.writeUInt32LE(offset,42);
    localParts.push(local,name,encoded); central.push(directory,name); offset += local.length + name.length + encoded.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(index.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...localParts,index,end]);
}
const profile = version => ({id:'macos',version,label:'macOS 专用版',platform:'macOS universal',repository:'maxlzyver/codex-mobile-editions',updatePath:'editions/macos',assetName:`codex-mobile-macos-${version}-universal.zip`});
async function fixture(t, { preserve = false, extra = [], badHash = false, edition = 'macos' } = {}) {
  await mkdir(WORK,{recursive:true}); const canonicalWork = await realpath(WORK), scratch = await realpath(await mkdtemp(path.join(canonicalWork,'mac-update-test-')));
  t.after(async()=>{ assert.equal(path.dirname(path.resolve(scratch)),canonicalWork); assert.ok(path.basename(scratch).startsWith('mac-update-test-')); await rm(scratch,{recursive:true,force:true}); });
  const rootDir=path.join(scratch,'安装 中文目录'),runtimeDir=path.join(rootDir,'.runtime'),jobDir=path.join(runtimeDir,'updates/job');
  await mkdir(jobDir,{recursive:true});
  const files={
    'lib/中文/new.mjs':'新增内容', 'server.mjs':'new-server', 'edition.json':JSON.stringify({...profile('1.1.0'),id:edition}),
    'package.json':JSON.stringify({name:'codex-mobile-console',version:'1.1.0',description:'Mac 中文工作台'}),
    'Start.command':'#!/bin/bash\necho test\n','Stop.command':'#!/bin/bash\n','Login.command':'#!/bin/bash\n',
    'lib/mac-launcher.mjs':'placeholder','lib/security.mjs':'placeholder','lib/update-installer.mjs':'placeholder','tools/apply-update.mjs':'placeholder',
    'public/index.html':'<p>中文</p>','LICENSE':'test-license','vendor/qrcode.cjs':'qr-test',
    ...(!preserve?{'runtime/darwin-arm64/bin/node':'new-arm64','runtime/darwin-x64/bin/node':'new-x64'}:{}),
  };
  const previous={'server.mjs':'old-server','edition.json':JSON.stringify(profile('1.0.0')),'package.json':JSON.stringify({name:'codex-mobile-console',version:'1.0.0'}),'.runtime/devices.json':'keep-private','workspace/文件.txt':'keep-user','custom.txt':'keep-custom','runtime/darwin-arm64/bin/node':'old-arm64','runtime/darwin-x64/bin/node':'old-x64'};
  for(const [name,data] of Object.entries(previous)){const filename=path.join(rootDir,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,data);}
  const commit='b'.repeat(40),prefix=`codex-mobile-editions-${commit}/editions/macos/`;
  const archive=zip([...Object.entries(files).map(([name,data])=>({name:prefix+name,data})),...extra]);
  const manifest={version:'1.1.0',edition,platform:'macOS universal',repository:'maxlzyver/codex-mobile-editions',...(preserve?{runtimePolicy:'preserve'}:{}),files:Object.entries(files).map(([name,data])=>({path:name,bytes:Buffer.byteLength(data),sha256:digest(data)}))};
  if(badHash)manifest.files[0].sha256='0'.repeat(64);
  const zipPath=path.join(runtimeDir,'updates/download.zip'),manifestPath=path.join(runtimeDir,'updates/manifest.json');
  await writeFile(zipPath,archive);await writeFile(manifestPath,JSON.stringify(manifest));
  const prepared={source:'repository',editionId:'macos',version:'1.1.0',zipPath,manifestPath,manifestSha256:digest(JSON.stringify(manifest)),sha256:digest(archive),size:archive.length,sourceCommit:commit,archivePrefix:prefix,assetName:'codex-mobile-macos-1.1.0-universal.zip',releaseUrl:`https://github.com/maxlzyver/codex-mobile-editions/tree/${commit}`};
  const plan={schema:1,rootDir,runtimeDir,jobDir,...prepared,testMode:true};
  return {rootDir,runtimeDir,jobDir,prepared,plan,files,async prepare(){await prepareUpdate(plan);plan.inventorySha256=await fileHash(path.join(jobDir,'inventory.json'));},async apply(failAfterFiles=0){return applyUpdate(plan,{testOnly:true,failAfterFiles});}};
}

test('mac update only permits application paths and rejects Windows/private files',()=>{
  for(const bad of ['../escape','/etc/passwd','.runtime/devices.json','workspace/mine.txt','lib/../mine','lib/link:stream','Codex-Mobile.exe','tools/apply-update.ps1','lib/auth.json'])assert.throws(()=>validateUpdatePath(bad));
  assert.equal(validateUpdatePath('lib/中文/file.mjs'),'lib/中文/file.mjs');
});
test('real mac fixture extraction and application preserves personal data and UTF-8',async t=>{
  const f=await fixture(t);await f.prepare();await f.apply();
  assert.equal(await readFile(path.join(f.rootDir,'server.mjs'),'utf8'),'new-server');
  assert.equal(await readFile(path.join(f.rootDir,'lib/中文/new.mjs'),'utf8'),'新增内容');
  assert.equal(await readFile(path.join(f.rootDir,'workspace/文件.txt'),'utf8'),'keep-user');
  assert.equal(await readFile(path.join(f.runtimeDir,'devices.json'),'utf8'),'keep-private');
  assert.equal(JSON.parse(await readFile(path.join(f.rootDir,'edition.json'),'utf8')).version,'1.1.0');
  assert.equal(JSON.parse(await readFile(path.join(f.jobDir,'status.json'),'utf8')).status,'complete');
});
test('mac update failure rolls back existing and newly introduced files',async t=>{
  const f=await fixture(t);await f.prepare();await assert.rejects(f.apply(3),/Simulated/);
  assert.equal(await readFile(path.join(f.rootDir,'server.mjs'),'utf8'),'old-server');
  assert.equal(JSON.parse(await readFile(path.join(f.rootDir,'edition.json'),'utf8')).version,'1.0.0');
  await assert.rejects(readFile(path.join(f.rootDir,'lib/中文/new.mjs')),{code:'ENOENT'});
  assert.equal(JSON.parse(await readFile(path.join(f.jobDir,'status.json'),'utf8')).status,'rolled-back');
});
test('light mac update preserves both architectures and ignores other repository editions',async t=>{
  const f=await fixture(t,{preserve:true,extra:[{name:`codex-mobile-editions-${'b'.repeat(40)}/editions/windows11/server.mjs`,data:'other-platform'}]});await f.prepare();await f.apply();
  assert.equal(await readFile(path.join(f.rootDir,'runtime/darwin-arm64/bin/node'),'utf8'),'old-arm64');
  assert.equal(await readFile(path.join(f.rootDir,'runtime/darwin-x64/bin/node'),'utf8'),'old-x64');
});
test('cross-edition, hashes, local manifest and staged inventory tampering fail closed',async t=>{
  const other=await fixture(t,{edition:'windows11'});await assert.rejects(other.prepare(),/macOS/);
  const hash=await fixture(t,{badHash:true});await assert.rejects(hash.prepare(),/校验失败/);
  const manifest=await fixture(t);await writeFile(manifest.prepared.manifestPath,'{}');await assert.rejects(manifest.prepare(),/SHA256/);
  const inventory=await fixture(t);await inventory.prepare();await writeFile(path.join(inventory.jobDir,'inventory.json'),'[]');await assert.rejects(inventory.apply(),/清单被修改/);
});
test('same-version or downgrade update is refused even when called directly',async t=>{
  const f=await fixture(t);
  for(const version of ['1.1.0','1.2.0']){await writeFile(path.join(f.rootDir,'edition.json'),JSON.stringify(profile(version)));await assert.rejects(validatePreparedUpdate(f.prepared,f),/更新的 macOS/);}
});
test('ZIP traversal, symlink, duplicate names and damaged directory are rejected',()=>{
  for(const entries of [
    [{name:'root/../escape',data:'x'}], [{name:'root/link',data:'../x',attributes:(0xa1ff<<16)>>>0}],
    [{name:'root/file',data:'a'},{name:'root/FILE',data:'b'}],
  ])assert.throws(()=>readZipEntries(zip(entries)));
  assert.throws(()=>readZipEntries(Buffer.from('not a zip')));
});
test('existing directory symlink cannot redirect extraction writes',async t=>{
  const f=await fixture(t), outside=path.join(path.dirname(f.rootDir),'outside');await mkdir(outside);
  await symlink(outside,path.join(f.rootDir,'lib'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.prepare(),/符号链接/);
  await assert.rejects(readFile(path.join(outside,'中文/new.mjs')),{code:'ENOENT'});
});
test('process identity rejects arbitrary PIDs before any signal',async()=>{
  await assert.rejects(verifyOwnedProcess({pid:process.pid,root:'/elsewhere'},'/safe'),/进程身份/);
});
test('process snapshots compare displayed paths and require an exact nonce argument',()=>{
  const root=path.resolve('中文目录'),nonce='a'.repeat(32);
  const expected={pid:123,uid:501,root,script:path.join(root,'server.mjs'),started:'Sun Oct 11 12:00:00 2026',executable:'/runtime/node',nonce,command:`/runtime/node /escaped/M-d/server.mjs --codex-mobile-instance=${nonce}`};
  assert.equal(assertProcessSnapshot(expected,{...expected},root).pid,123);
  assert.throws(()=>assertProcessSnapshot(expected,{...expected,command:expected.command+' --changed'},root),/身份已改变/);
  for(const command of [null,123,`${expected.command}suffix`,expected.command.replace('--codex-mobile-instance','x--codex-mobile-instance')]) assert.throws(()=>assertProcessSnapshot({...expected,command},{...expected,command},root),/进程身份/);
});
test('ready handshake tolerates an incomplete write and accepts the atomic signal',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.jobDir,'apply-ready.json'),'{"ready":');
  let acknowledged=false;
  const waiting=waitForApplyReady(f.jobDir,{timeoutMs:1000,pollMs:5}).then(()=>{acknowledged=true;});
  await delay(20);assert.equal(acknowledged,false);
  await signalApplyReady(f.jobDir);await waiting;assert.equal(acknowledged,true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.jobDir,'apply-ready.json'),'utf8')),{ready:true});
});
test('ready handshake cancellation takes priority over a ready file',async t=>{
  const f=await fixture(t);await signalApplyReady(f.jobDir);await writeFile(path.join(f.jobDir,'cancel.json'),'{}');
  await assert.rejects(waitForApplyReady(f.jobDir,{timeoutMs:1000,pollMs:5}),/取消更新/);
});
test('a reused PID is ignored when starting but other inspection failures remain visible',async t=>{
  const f=await fixture(t),identity={pid:321,root:f.rootDir};await writeFile(path.join(f.runtimeDir,'mac-process.json'),JSON.stringify(identity));
  let inspections=0;
  assert.equal(await findRunningConsole(f.rootDir,{verifyProcess:async saved=>{inspections++;assert.deepEqual(saved,identity);throw Object.assign(new Error('reused PID'),{code:'PROCESS_IDENTITY_MISMATCH'});}}),null);
  assert.equal(inspections,1);
  await assert.rejects(findRunningConsole(f.rootDir,{verifyProcess:async()=>{throw new Error('inspection denied');}}),/inspection denied/);
});
test('native mac process identity stops only its own spawned fixture and rejects a wrong nonce',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t), script=path.join(f.rootDir,'server.mjs'), nonce='a'.repeat(32);
  await writeFile(script,'setInterval(() => {}, 1000);');
  const child=spawn(process.execPath,[script,`--codex-mobile-instance=${nonce}`],{stdio:'ignore'});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const identity={...await snapshotProcess(child.pid),root:f.rootDir,script,nonce};
  await assert.rejects(verifyOwnedProcess({...identity,nonce:'b'.repeat(32)},f.rootDir),/进程身份/);
  assert.ok(await verifyOwnedProcess(identity,f.rootDir));await stopOwnedProcess(identity,f.rootDir);
  assert.equal(await verifyOwnedProcess(identity,f.rootDir),null);
});

test('mac installer waits for handoff and propagates helper failure without closing',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.rootDir,'tools'),{recursive:true});
  await copyFile(path.join(ROOT,'tools/apply-update.mjs'),path.join(f.rootDir,'tools/apply-update.mjs'));
  await writeFile(path.join(f.runtimeDir,'server.json'),JSON.stringify({pid:process.pid,root:f.rootDir,port:43127}));
  await writeFile(path.join(f.runtimeDir,'mac-process.json'),JSON.stringify({pid:process.pid,root:f.rootDir}));
  let closed=false;
  const install=createInstaller({rootDir:f.rootDir,runtimeDir:f.runtimeDir,onBeforeInstall:()=>{closed=true;},beforeShutdownDelayMs:0,
    spawnProcess(){const child=new EventEmitter();child.unref=()=>{};setImmediate(()=>{child.emit('spawn');child.emit('exit',1);});return child;}});
  await assert.rejects(install(f.prepared),/接管前退出/);assert.equal(closed,false);
});
