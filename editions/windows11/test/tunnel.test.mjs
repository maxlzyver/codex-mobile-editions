import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { TunnelManager } from '../lib/tunnel.mjs';

const nextTick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, overrides = {}) {
  const children = [];
  const manager = new TunnelManager({
    port: 43127,
    rootDir: process.cwd(),
    binaryProvider: async () => 'verified-cloudflared.exe',
    spawnProcess(binary, args, options) {
      assert.equal(binary, 'verified-cloudflared.exe');
      assert.deepEqual(args, [
        'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:43127', '--protocol', 'http2',
      ]);
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      const child = new EventEmitter();
      Object.assign(child, {
        stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kills: 0,
        kill() {
          this.kills += 1;
          this.exitCode = 0;
          queueMicrotask(() => this.emit('exit', 0, null));
          return true;
        },
      });
      children.push(child);
      return child;
    },
    ...overrides,
  });
  t.after(() => manager.stop());
  return { manager, children };
}

test('tunnel is ready only after both a public URL and registered edge connection', async t => {
  const { manager, children } = fixture(t);
  const states = [];
  manager.on('change', state => states.push(state.status));
  assert.equal((await manager.start()).status, 'starting');
  await nextTick();
  children[0].stderr.write('INF https://test-connection.trycloudflare.com\n');
  assert.equal(manager.state.status, 'starting');
  assert.equal(manager.state.url, null);
  const ready = manager.waitUntilReady({ timeoutMs: 500 });
  children[0].stderr.write('INF Registered tunnel connection connIndex=0\n');
  assert.equal((await ready).url, 'https://test-connection.trycloudflare.com');
  assert.ok(states.includes('starting'));
  assert.equal(states.at(-1), 'ready');
});

test('tunnel parser accepts lines split across process output chunks', async t => {
  const { manager, children } = fixture(t);
  await manager.start();
  await nextTick();
  const ready = manager.waitUntilReady({ timeoutMs: 500 });
  children[0].stdout.write('INF https://split-test.trycloud');
  children[0].stdout.write('flare.com\n');
  children[0].stderr.write('INF Registered tunnel connec');
  assert.equal(manager.state.status, 'starting');
  children[0].stderr.write('tion connIndex=0\n');
  assert.equal((await ready).url, 'https://split-test.trycloudflare.com');
});

test('stop kills only the owned child and clears the public URL', async t => {
  const { manager, children } = fixture(t);
  await manager.start();
  await nextTick();
  children[0].stderr.write('https://stop-test.trycloudflare.com\nRegistered tunnel connection\n');
  assert.equal(manager.state.status, 'ready');
  await manager.stop();
  assert.equal(children.length, 1);
  assert.equal(children[0].kills, 1);
  assert.equal(manager.state.status, 'stopped');
  assert.equal(manager.state.url, null);
  await manager.stop();
  assert.equal(children[0].kills, 1);
});

test('a startup timeout reports the connection failure and terminates its child', async t => {
  const { manager, children } = fixture(t, { startupTimeoutMs: 20 });
  await manager.start();
  await assert.rejects(manager.waitUntilReady({ timeoutMs: 500 }), /连接 Cloudflare 超时/);
  assert.equal(manager.state.status, 'error');
  assert.equal(manager.state.url, null);
  assert.equal(children[0].kills, 1);
});

test('stopping during binary preparation prevents a later process launch', async t => {
  let finishPreparation;
  let preparationSignal;
  const { manager, children } = fixture(t, {
    binaryProvider: (rootDir, { signal }) => {
      preparationSignal = signal;
      return new Promise(resolve => { finishPreparation = resolve; });
    },
  });
  await manager.start();
  const pending = manager.waitUntilReady({ timeoutMs: 500 });
  const rejected = assert.rejects(pending, /已停止/);
  await manager.stop();
  await rejected;
  assert.equal(preparationSignal.aborted, true);
  finishPreparation('verified-cloudflared.exe');
  await nextTick();
  assert.equal(children.length, 0);
  assert.equal(manager.state.status, 'stopped');
});

test('an unexpected process exit becomes an actionable error', async t => {
  const { manager, children } = fixture(t);
  await manager.start();
  await nextTick();
  const pending = manager.waitUntilReady({ timeoutMs: 500 });
  const rejected = assert.rejects(pending, /退出码 1/);
  children[0].stderr.write('ERR failed to connect to edge: connection refused\n');
  children[0].exitCode = 1;
  children[0].emit('exit', 1, null);
  await rejected;
  assert.equal(manager.state.status, 'error');
  assert.match(manager.state.error, /connection refused/);
  assert.equal(manager.state.url, null);
});
