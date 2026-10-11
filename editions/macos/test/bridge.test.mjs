import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexBridge } from '../lib/codex-bridge.mjs';

// The fake process handles only JSONL RPC. No installed Codex/model is invoked.
const workspace = fileURLToPath(new URL('../../../work/', import.meta.url));
await mkdir(workspace, { recursive: true });
const fixtureDir = await mkdtemp(path.join(workspace, 'codex-bridge-test-'));
const fixture = path.join(fixtureDir, 'mock.mjs');
await writeFile(fixture, `
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv.includes('proxy') && process.env.FAKE_PROXY !== '1') process.exit(3);
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 'approval-1' && !message.method) {
    send({method:'approval/result',params:message.result});
    return;
  }
  switch(message.method) {
    case 'initialize': send({id:message.id,result:{userAgent:'test',codexHome:'test'}}); break;
    case 'echo': send({id:message.id,result:message.params}); break;
    case 'notify':
      send({method:'thread/started',params:{thread:{id:'test-thread'}}});
      send({id:message.id,result:{ok:true}}); break;
    case 'ask':
      send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:'test-thread',command:'echo test'}});
      send({id:message.id,result:{ok:true}}); break;
    case 'resolve':
      send({method:'serverRequest/resolved',params:{threadId:'test-thread',requestId:'approval-1'}});
      send({id:message.id,result:{ok:true}}); break;
    case 'unicode': {
      const payload=Buffer.from(JSON.stringify({id:message.id,result:{text:'中文手机'}})+'\\n');
      for(let i=0;i<payload.length;i++) process.stdout.write(payload.subarray(i,i+1));
      break;
    }
    case 'failure': send({id:message.id,error:{code:-32602,message:'bad argument'}}); break;
    case 'hang': break;
    case 'exit': process.exit(7); break;
    case 'malformed': process.stdout.write('{malformed\\n'); break;
    case 'oversize': process.stdout.write('x'.repeat(32*1024*1024+1)); break;
    case 'stderr':
      process.stderr.write('Bearer VERY_SECRET_TOKEN sk-PRIVATE_KEY token=HIDDEN');
      send({id:message.id,result:{ok:true}}); break;
  }
});
await new Promise(resolve=>rl.on('close',resolve));
process.exit(0);
`);
after(() => rm(fixtureDir, { recursive: true, force: true }));

function makeBridge(options = {}) {
  return new CodexBridge({
    codexPath: process.execPath,
    preferProxy: false,
    startTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    ...options,
    env: {
      NODE_OPTIONS: `--import "${pathToFileURL(fixture).href}"`,
      ...options.env,
    },
  });
}

test('initializes once under concurrent calls; preserves split UTF-8', async (t) => {
  const bridge = makeBridge(); t.after(() => bridge.close());
  const [a,b] = await Promise.all([bridge.start(),bridge.start()]);
  assert.equal(a.connected,true);
  assert.equal(b.mode,'standalone');
  assert.deepEqual(await bridge.request('echo',{number:42}),{number:42});
  assert.deepEqual(await bridge.request('unicode'),{text:'中文手机'});
});

test('proxy failure falls back without invoking daemon management', async (t) => {
  const bridge = makeBridge({preferProxy:true}); t.after(() => bridge.close());
  await bridge.start();
  assert.equal(bridge.state.mode,'standalone');
  assert.match(bridge.state.notice,/Shared desktop daemon unavailable/);
});

test('successful existing proxy remains in shared mode', async (t) => {
  const bridge = makeBridge({preferProxy:true,env:{FAKE_PROXY:'1'}}); t.after(() => bridge.close());
  await bridge.start();
  assert.equal(bridge.state.mode,'shared');
});

test('forwards notifications and requires matching approval IDs', async (t) => {
  const bridge = makeBridge(); t.after(() => bridge.close());
  await bridge.start();
  const event=once(bridge,'notification');
  await bridge.request('notify');
  assert.equal((await event)[0].method,'thread/started');
  const incoming=once(bridge,'request');
  await bridge.request('ask');
  const [approval]=await incoming;
  assert.equal(approval.method,'item/commandExecution/requestApproval');
  assert.throws(()=>bridge.reply('other-id',{decision:'accept'}),/no longer pending/);
  const replied=once(bridge,'notification');
  bridge.reply(approval.id,{decision:'decline'});
  assert.deepEqual((await replied)[0].params,{decision:'decline'});
  assert.throws(()=>bridge.reply(approval.id,{}),/no longer pending/);
  await bridge.request('ask');
  await bridge.request('resolve');
  assert.throws(()=>bridge.reply(approval.id,{}),/no longer pending/);
});

test('RPC errors and timeouts do not corrupt later requests', async (t) => {
  const bridge = makeBridge(); t.after(() => bridge.close());
  await assert.rejects(bridge.request('failure'),{code:-32602});
  await assert.rejects(bridge.request('hang',{},20),{code:'RPC_TIMEOUT'});
  assert.deepEqual(await bridge.request('echo',{alive:true}),{alive:true});
  assert.equal(bridge._pending.size,0);
});

test('process exit rejects outstanding requests promptly', async (t) => {
  const bridge = makeBridge(); t.after(() => bridge.close());
  await bridge.start();
  const pending = bridge.request('hang');
  const exiting = bridge.request('exit');
  const results = await Promise.allSettled([pending,exiting]);
  assert(results.every(result=>result.status==='rejected'));
  assert.equal(bridge.state.connected,false);
  assert.equal(bridge._pending.size,0);
});

test('invalid and oversized responses disconnect instead of buffering forever', async (t) => {
  for (const method of ['malformed','oversize']) {
    const bridge = makeBridge(); t.after(() => bridge.close());
    await assert.rejects(bridge.request(method),method==='malformed' ? /invalid JSON/ : /32 MiB/);
    assert.equal(bridge.state.connected,false);
    await bridge.close();
  }
});

test('stderr secrets are never retained and closed bridges cannot restart', async () => {
  const bridge = makeBridge();
  await bridge.request('stderr');
  await bridge.close();
  assert.equal(bridge.state.connected,false);
  assert.doesNotMatch(JSON.stringify(bridge.diagnostics),/SECRET|PRIVATE|HIDDEN/);
  await assert.rejects(bridge.start(),/closed/);
});
