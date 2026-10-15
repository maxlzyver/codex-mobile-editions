import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { setup } from '../scripts/setup.mjs';
import { resolveDataDirectory, installDiagnostic } from '../scripts/one-click.mjs';
import { readJson, writeJson } from '../lib/config.mjs';
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('setup binds bundled Node in Chinese space paths and preserves settings across reinstall', async t => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), '插件 setup '))); t.after(() => rm(temp, { recursive: true, force: true }));
  const install = path.join(temp, '完整 软件'), dataDir = path.join(temp, '插件 数据'), project = path.join(temp, '项目');
  await mkdir(install); await mkdir(project);
  const validate = async directory => ({ root: directory, nodePath: path.join(directory, 'runtime/node.exe'), profile: { id: 'windows11', version: '1.3.0' } });
  const discoverCodex = async () => path.join(temp, 'codex.exe');
  const result = await setup({ installationRoot: install, defaultCwd: project, dataDir, source, validate, discoverCodex });
  const config = await readJson(path.join(dataDir, 'config.json')), mcp = await readJson(path.join(result.pluginSourceRoot, 'mcp.json'));
  assert.equal(mcp.mcpServers.mobile.command, 'node.exe');
  assert.equal(mcp.mcpServers.mobile.env.PATH.split(path.delimiter)[0], path.join(install, 'runtime'));
  assert.equal(mcp.mcpServers.mobile.env.CODEX_MOBILE_PLUGIN_DATA, dataDir); assert.equal(config.defaultCwd, await realpath(project));
  const marketplace = await readJson(path.join(result.marketplaceRoot, '.agents/plugins/marketplace.json'));
  assert.equal(marketplace.plugins[0].source.path, './plugins/codex-mobile'); assert.equal(result.registered, false);
  await writeJson(path.join(dataDir, 'update-settings.json'), { autoUpdate: true });
  await setup({ installationRoot: install, dataDir, source, validate, discoverCodex });
  assert.equal((await readJson(path.join(dataDir, 'update-settings.json'))).autoUpdate, true);
  assert.equal((await readJson(path.join(dataDir, 'config.json'))).defaultCwd, await realpath(project));
  await assert.rejects(setup({ installationRoot: install, defaultCwd: install, dataDir, source, validate, discoverCodex }), /安装目录/);
});

test('reinstall reuses registered marketplace when plugin cache is absent', async t => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'plugin-reinstall-'))); t.after(() => rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'old-data'), marketplaceRoot = path.join(dataDir, 'marketplace'), pluginSourceRoot = path.join(marketplaceRoot, 'plugins/codex-mobile');
  const installationRoot = path.join(temp, 'new-software'), project = path.join(temp, 'project');
  await mkdir(installationRoot); await mkdir(project);
  await writeJson(path.join(dataDir, 'config.json'), { schema: 1, installationRoot: path.join(temp, 'old-software'), marketplaceRoot, pluginSourceRoot });
  await writeJson(path.join(marketplaceRoot, '.agents/plugins/marketplace.json'), { name: 'codex-mobile-local', plugins: [{ name: 'codex-mobile', source: { source: 'local', path: './plugins/codex-mobile' } }] });
  await writeJson(path.join(dataDir, 'update-settings.json'), { autoUpdate: true });
  const calls = [], discoverCodex = async () => path.join(temp, 'codex.exe');
  const executeFile = async (binary, args) => {
    calls.push(args);
    if (args.join(' ') === 'plugin marketplace list --json') return { stdout: JSON.stringify({ marketplaces: [{ name: 'codex-mobile-local', root: marketplaceRoot }] }) };
    assert.deepEqual(args, ['plugin', 'add', 'codex-mobile@codex-mobile-local', '--json']); return { stdout: '{}' };
  };
  const resolved = await resolveDataDirectory({ installationRoot, env: { CODEX_HOME: path.join(temp, 'empty-codex'), LOCALAPPDATA: path.join(temp, 'local-data') }, home: temp, discoverCodex, executeFile });
  assert.equal(resolved, dataDir);
  const result = await setup({ installationRoot, dataDir: resolved, defaultCwd: project, source, register: true, discoverCodex, executeFile,
    validate: async root => ({ root, nodePath: path.join(root, 'runtime/node.exe') }), startBackend: async () => {} });
  assert.equal(result.registered, true); assert.equal(result.dataDir, dataDir);
  assert.equal(calls.filter(args => args[1] === 'marketplace' && args[2] === 'add').length, 0);
  assert.equal(calls.filter(args => args[1] === 'add').length, 1);
  assert.equal((await readJson(path.join(dataDir, 'config.json'))).installationRoot, installationRoot);
  assert.equal((await readJson(path.join(dataDir, 'update-settings.json'))).autoUpdate, true);
  const diagnostic = installDiagnostic(Object.assign(new Error('CLI failed'), { stage: 'plugin-add', code: 1, stderr: 'denied ownerKey=private-value Authorization: Bearer private-token' }));
  assert.match(diagnostic, /plugin-add/); assert.match(diagnostic, /"exitCode": 1/); assert.doesNotMatch(diagnostic, /private-value|private-token/);
});
