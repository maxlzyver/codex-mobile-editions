// Runs the real server entry point. Loader hooks only replace external transports;
// this deliberately does NOT call startChecking from test/bootstrap code.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerClient } from './update-repair/repair-update.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.resolve(process.env.CODEX_UPDATE_E2E_OUTPUT || path.join(REPO, '../../v120-upgrade-verification'));
await mkdir(WORK, { recursive: true }); const RUN = await mkdtemp(path.join(WORK, 'startup-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const PIN = 'f'.repeat(40), results = [];
for (const edition of (process.env.CODEX_UPDATE_E2E_EDITIONS || 'windows11,windows10,macos').split(',')) {
  const root = path.join(RUN, edition), runtime = path.join(root, '.runtime');
  await cp(path.join(REPO, 'editions', edition), root, { recursive: true, filter: file => !['.runtime', 'runtime', '.git'].includes(path.basename(file)) });
  const profile = JSON.parse(await readFile(path.join(root, 'edition.json'), 'utf8'));
  const parts = profile.version.split('.'); const nextVersion = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
  const manifest = { name: 'Codex 移动助手', version: nextVersion, edition, platform: profile.platform, repository: profile.repository, runtimePolicy: 'preserve', releaseNotes: '启动自动发现更新\n自动安装保持关闭。', files: [{ path: 'edition.json', bytes: 2, sha256: 'a'.repeat(64) }] };
  await mkdir(path.join(runtime, 'updates'), { recursive: true }); await writeFile(path.join(runtime, 'updates/settings.json'), JSON.stringify({ autoUpdate: false }));
  const log = path.join(RUN, `${edition}-requests.jsonl`), hook = path.join(RUN, `${edition}-isolate.mjs`);
  await writeFile(hook, `
import { registerHooks } from 'node:module';
const root = ${JSON.stringify(pathToFileURL(root).href + '/')};
const common = "import { EventEmitter } from 'node:events';";
registerHooks({ load(url, context, next) {
  if (url.startsWith(root)) {
    if (url.endsWith('/lib/codex-bridge.mjs')) return { format:'module', shortCircuit:true, source: common + "export class CodexBridge extends EventEmitter { state={connected:true}; async start(){return this.state;} async close(){} async request(method){if(method==='account/read')return {account:{}};if(method==='thread/list')return {data:[]};throw Error('Forbidden model call');} }" };
    if (url.endsWith('/lib/desktop-bridge.mjs')) return { format:'module', shortCircuit:true, source: common + "export class DesktopBridge extends EventEmitter { state={connected:false}; options={}; async connect(){} async close(){} async listTools(){return [];} }" };
    if (url.endsWith('/lib/tunnel.mjs')) return { format:'module', shortCircuit:true, source: common + "export class TunnelManager extends EventEmitter { state={status:'stopped',url:null}; async stop(){} }" };
    if (url.endsWith('/lib/updater.mjs')) {
      const result=next(url,context);
      const body=typeof result.source==='string'?result.source:new TextDecoder().decode(result.source);
      return {...result,source:body+${JSON.stringify(`
const realStartChecking=UpdateManager.prototype.startChecking;
UpdateManager.prototype.startChecking=function(){
  this.options.fetchImpl=async url=>{
    await (await import('node:fs/promises')).appendFile(${JSON.stringify(log)}, JSON.stringify(url)+'\\n');
    if(url===REPOSITORY_COMMIT_URL)return new Response(JSON.stringify({sha:${JSON.stringify(PIN)}}));
    if(url===${JSON.stringify(`https://raw.githubusercontent.com/maxlzyver/codex-mobile-editions/${PIN}/editions/${edition}/update.json`)})return new Response(${JSON.stringify(JSON.stringify(manifest))});
    throw Error('Startup must not download or access other networks');
  };
  return realStartChecking.call(this);
};`)} };
    }
  }
  return next(url,context);
}});
`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, path.join(root, 'server.mjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', CODEX_MOBILE_PORT: '0', CODEX_MOBILE_CWD: path.join(RUN, 'project-' + edition) }, cwd: root });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  let client, state;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Real entry point exited: ' + output);
      try { client ||= await ownerClient(root); state = await client.request('/api/updates'); if (state.hasUpdate) break; } catch { /* Starting up. */ }
      await wait(100);
    }
    assert.equal(state?.status, 'available', output); assert.equal(state.autoUpdate, false); assert.equal(state.latestVersion, nextVersion); assert.equal(state.releaseNotes, manifest.releaseNotes); assert(state.checkedAt);
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.length, 2); assert(requests.every(url => !url.includes('codeload')));
    assert.deepEqual(await readdir(path.join(runtime, 'updates')), ['settings.json']);
    results.push({ edition, actualUnmodifiedServerEntry: true, onlyExternalTransportsStubbed: true, manualCheckPost: false, status: state.status, autoUpdate: state.autoUpdate, releaseNotes: state.releaseNotes, metadataRequests: requests.length, archiveRequests: 0 });
    console.log('PASS real server startup notification', edition);
  } finally {
    if (client) await client.request('/api/shutdown', 'POST').catch(() => {});
    for (let attempt = 0; child.exitCode === null && attempt < 30; attempt++) await wait(100);
    if (child.exitCode === null) child.kill();
  }
}
await writeFile(path.join(RUN, 'report.json'), JSON.stringify({ ok: true, results }, null, 2));
console.log('Evidence:', path.join(RUN, 'report.json'));
