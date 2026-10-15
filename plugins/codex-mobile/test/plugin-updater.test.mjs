import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PluginUpdater, validateManifest, validatePluginPath } from '../lib/plugin-updater.mjs';
import { writeJson, readJson } from '../lib/config.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40);
async function fixture(t, overrides = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-plugin-update-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.codex/plugins/cache/local/mobile/local'), source = path.join(directory, 'marketplace/plugins/codex-mobile'), dataDir = path.join(directory, 'data');
  await mkdir(root, { recursive: true }); await mkdir(source, { recursive: true });
  const files = {
    'plugin.json': JSON.stringify({ name: 'codex-mobile', version: '1.3.1' }),
    '.codex-plugin/plugin.json': JSON.stringify({ name: 'codex-mobile', version: '1.3.1', mcpServers: './mcp.json', skills: './skills/' }),
    'package.json': JSON.stringify({ name: 'codex-mobile-plugin', version: '1.3.1' }),
    'mcp.json': JSON.stringify({ mcpServers: { mobile: { type: 'stdio', command: '__CODEX_MOBILE_BUNDLED_NODE__' } } }),
    'dist/server.mjs': 'export const code = "1.3.1";\n',
    'ui/app.html': '<html>new UI 1.3.1</html>',
    'skills/mobile/SKILL.md': '---\nname: mobile\n---\nNew mobile workflow',
    'skills/setup/SKILL.md': '---\nname: setup\n---\nNew setup workflow',
  };
  const manifest = { schema: 1, name: 'codex-mobile', version: '1.3.1', releaseNotes: 'Plugin code, UI and skills updated', files: Object.entries(files).map(([filename, value]) => ({ path: filename, bytes: Buffer.byteLength(value), sha256: digest(value) })) };
  await writeJson(path.join(source, 'plugin.json'), { name: 'codex-mobile', version: '1.3.0' });
  await writeJson(path.join(root, 'plugin.json'), { name: 'codex-mobile', version: '1.3.0' });
  await writeJson(path.join(dataDir, 'devices.json'), { private: 'persist' });
  let calls = 0;
  const fetchImpl = async url => { calls++; if (url.includes('/commits/main')) return new Response(JSON.stringify({ sha: commit })); if (url.endsWith('/update.json')) return new Response(JSON.stringify(manifest)); const filename = url.split('/plugins/codex-mobile/')[1]; return new Response(files[filename], { status: filename in files ? 200 : 404 }); };
  const config = { pluginSourceRoot: source, nodePath: path.join(directory, 'runtime/node.exe') };
  let refreshed = 0;
  const updater = new PluginUpdater({ rootDir: root, dataDir, config, loadedVersion: '1.3.0', fetchImpl, isBusy: async () => false, refreshHost: async () => { refreshed++; }, ...overrides });
  t.after(() => updater.close()); await updater.ready;
  return { directory, root, source, dataDir, config, files, manifest, updater, fetchImpl, get calls() { return calls; }, get refreshed() { return refreshed; } };
}
test('self update changes code, UI, skills and identity in source, preserves data and running cache', async t => {
  const f = await fixture(t);
  await f.updater.check(); const state = await f.updater.install();
  assert.equal(state.installedVersion, '1.3.1'); assert.equal(state.loadedVersion, '1.3.0'); assert.equal(state.pendingRestart, true); assert.equal(f.refreshed, 1);
  assert.match(await readFile(path.join(f.source, 'dist/server.mjs'), 'utf8'), /1\.3\.1/);
  assert.match(await readFile(path.join(f.source, 'ui/app.html'), 'utf8'), /new UI/);
  assert.match(await readFile(path.join(f.source, 'skills/mobile/SKILL.md'), 'utf8'), /New mobile/);
  assert.equal((await readJson(path.join(f.source, 'plugin.json'))).version, '1.3.1');
  assert.equal((await readJson(path.join(f.source, 'mcp.json'))).mcpServers.mobile.command, 'node.exe');
  assert.equal((await readJson(path.join(f.source, 'mcp.json'))).mcpServers.mobile.env.PATH.split(path.delimiter)[0], path.dirname(f.config.nodePath));
  assert.equal((await readJson(path.join(f.root, 'plugin.json'))).version, '1.3.0');
  assert.deepEqual(await readJson(path.join(f.dataDir, 'devices.json')), { private: 'persist' });
  const loaded = new PluginUpdater({ rootDir: f.root, dataDir: f.dataDir, config: f.config, loadedVersion: '1.3.1' }); await loaded.ready; t.after(() => loaded.close());
  assert.equal(loaded.getState().pendingRestart, false);
});
test('busy automatic update waits without downloading and resumes after idle', async t => {
  let busy = true; const f = await fixture(t, { isBusy: async () => busy, retryMs: 1000, intervalMs: 100000 });
  await f.updater.configure({ autoUpdate: true });
  for (let attempt = 0; attempt < 100 && f.updater.getState().status !== 'waiting'; attempt++) await delay(10);
  f.updater.close();
  assert.equal(f.updater.getState().status, 'waiting'); assert.equal(f.calls, 2);
  busy = false; await f.updater.install();
  assert.equal(f.updater.getState().installedVersion, '1.3.1');
  assert.equal((await readJson(path.join(f.dataDir, 'update-settings.json'))).autoUpdate, true);
});
test('failed file digest never overwrites the installed plugin', async t => {
  const f = await fixture(t); f.files['ui/app.html'] = f.files['ui/app.html'].replace('new UI', 'bad UI');
  await f.updater.check(); await assert.rejects(f.updater.install(), /校验失败/);
  assert.equal((await readJson(path.join(f.source, 'plugin.json'))).version, '1.3.0');
  assert.equal(f.refreshed, 0);
});
test('source pointing into Codex plugin cache is refused', async t => {
  const f = await fixture(t); f.config.pluginSourceRoot = f.root;
  await assert.rejects(f.updater.check(), /不能直接更新/); assert.equal(f.calls, 0);
});
test('an installation failure rolls back already replaced files', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, 'skills/mobile/SKILL.md'), { recursive: true });
  await writeFile(path.join(f.source, 'mcp.json'), 'old mcp');
  await f.updater.check(); await assert.rejects(f.updater.install(), /不是普通文件/);
  assert.equal(await readFile(path.join(f.source, 'mcp.json'), 'utf8'), 'old mcp');
  assert.equal((await readJson(path.join(f.source, 'plugin.json'))).version, '1.3.0');
});
test('path traversal, private data, missing components and case duplicates are refused', async t => {
  const f = await fixture(t);
  for (const filename of ['../plugin.json', 'lib/../../x', '/plugin.json', 'config.json', 'lib/.runtime/x', 'lib/auth.json', 'lib/a.log', 'lib/CON.txt']) assert.throws(() => validatePluginPath(filename));
  assert.throws(() => validateManifest({ ...f.manifest, files: f.manifest.files.slice(1) }), /缺少必要/);
  assert.throws(() => validateManifest({ ...f.manifest, files: [...f.manifest.files, { ...f.manifest.files[0], path: 'PLUGIN.JSON' }] }));
});
test('a second process lock prevents concurrent updates', async t => {
  const f = await fixture(t); await writeJson(path.join(f.dataDir, 'plugin-update.lock'), { pid: process.pid });
  await f.updater.check(); await assert.rejects(f.updater.install(), /另一个插件会话/);
  assert.equal((await readJson(path.join(f.source, 'plugin.json'))).version, '1.3.0');
});
test('compatibility manifest version cannot lag behind the root identity', async t => {
  const f = await fixture(t); f.files['.codex-plugin/plugin.json'] = f.files['.codex-plugin/plugin.json'].replace('1.3.1', '1.3.0');
  const entry = f.manifest.files.find(item => item.path === '.codex-plugin/plugin.json'); entry.sha256 = digest(f.files[entry.path]);
  await f.updater.check(); await assert.rejects(f.updater.install(), /兼容清单/);
  assert.equal((await readJson(path.join(f.source, 'plugin.json'))).version, '1.3.0');
});
test('metadata write failure restores program files and original update manifest', async t => {
  const f = await fixture(t); await writeJson(path.join(f.source, 'update.json'), { version: '1.3.0' });
  await mkdir(path.join(f.dataDir, 'last-update.json'));
  await f.updater.check(); await assert.rejects(f.updater.install(), /不是普通文件/);
  assert.equal((await readJson(path.join(f.source, 'plugin.json'))).version, '1.3.0');
  assert.equal((await readJson(path.join(f.source, 'update.json'))).version, '1.3.0');
});

test('two plugin instances synchronize shared auto setting and installed version without changing loaded code', async t => {
  const f = await fixture(t); f.updater.close();
  const peer = new PluginUpdater({ rootDir: f.root, dataDir: f.dataDir, config: f.config, loadedVersion: '1.3.0', fetchImpl: f.fetchImpl, isBusy: async () => false });
  t.after(() => peer.close()); await peer.ready; peer.close();
  await f.updater.configure({ autoUpdate: true });
  assert.equal((await peer.refreshSharedState()).autoUpdate, true);
  await peer.configure({ autoUpdate: false });
  assert.equal((await f.updater.refreshSharedState()).autoUpdate, false);
  await peer.check(); assert.equal(peer.getState().hasUpdate, true);
  await f.updater.check(); await f.updater.install();
  const synced = await peer.refreshSharedState();
  assert.equal(synced.installedVersion, '1.3.1'); assert.equal(synced.loadedVersion, '1.3.0');
  assert.equal(synced.pendingRestart, true); assert.equal(synced.hasUpdate, false); assert.equal(synced.status, 'pending_restart');
  const calls = f.calls; await peer.install(); assert.equal(f.calls, calls);
});

test('shared refresh ignores an uncommitted identity and preserves local install progress', async t => {
  const f = await fixture(t); f.updater.close();
  await writeJson(path.join(f.dataDir, 'plugin-update.lock'), { pid: process.pid });
  await writeJson(path.join(f.source, 'plugin.json'), { name: 'codex-mobile', version: '1.3.1' });
  await writeJson(path.join(f.dataDir, 'update-settings.json'), { autoUpdate: true });
  const locked = await f.updater.refreshSharedState(); assert.equal(locked.installedVersion, '1.3.0'); assert.equal(locked.autoUpdate, true);
  f.updater.operation = Promise.resolve(); f.updater.patch({ status: 'installing' });
  await rm(path.join(f.dataDir, 'plugin-update.lock'));
  const active = await f.updater.refreshSharedState(); assert.equal(active.status, 'installing'); assert.equal(active.installedVersion, '1.3.0');
  f.updater.operation = null;
  const committed = await f.updater.refreshSharedState(); assert.equal(committed.installedVersion, '1.3.1'); assert.equal(committed.status, 'pending_restart');
});

test('a scheduled peer re-reads another instance opt-out before deciding to auto-install', async t => {
  const f = await fixture(t); f.updater.close(); await f.updater.configure({ autoUpdate: true });
  const peer = new PluginUpdater({ rootDir: f.root, dataDir: f.dataDir, config: f.config, loadedVersion: '1.3.0', fetchImpl: f.fetchImpl, isBusy: async () => false });
  t.after(() => peer.close()); await peer.ready; assert.equal(peer.getState().autoUpdate, true);
  await f.updater.configure({ autoUpdate: false }); await peer.cycle(); peer.close();
  assert.equal(peer.getState().autoUpdate, false); assert.equal(peer.getState().hasUpdate, true);
  assert.equal((await readJson(path.join(f.source, 'plugin.json'))).version, '1.3.0');
  assert.equal(f.calls, 2);
});

test('one-click update waits for idle and retries without enabling automatic updates', async t => {
  let busy = true; const f = await fixture(t, { isBusy: async () => busy, retryMs: 20, intervalMs: 100000 });
  const waiting = await f.updater.install(); assert.equal(waiting.status, 'waiting'); assert.equal(waiting.autoUpdate, false);
  assert.equal((await f.updater.refreshSharedState()).status, 'waiting');
  assert.equal(f.calls, 2); assert.equal(f.updater.manualPending, true);
  busy = false;
  for (let attempt = 0; attempt < 100 && f.updater.getState().installedVersion !== '1.3.1'; attempt++) await delay(20);
  assert.equal(f.updater.getState().installedVersion, '1.3.1'); assert.equal(f.updater.getState().autoUpdate, false);
  assert.equal(f.updater.manualPending, false); assert.equal(f.refreshed, 1);
  assert.deepEqual(await readJson(path.join(f.dataDir, 'devices.json')), { private: 'persist' });
});
