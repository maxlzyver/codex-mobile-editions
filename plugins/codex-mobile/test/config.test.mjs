import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { findCodex, verifyRuntime, materializeMcp, validateWorkspace } from '../lib/config.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobile-config-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), root); assert.ok(relative.startsWith('mobile-config-') && !relative.includes(path.sep)); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('Codex discovery gives explicit binary priority, rejects invalid override and searches installed locations', async t => {
  const root = await fixture(t), installation = path.join(root, 'software'), app = path.join(root, 'local/OpenAI/Codex/bin/build/resources');
  await mkdir(installation); await mkdir(app, { recursive: true });
  const binary = path.join(app, 'codex.exe'); await writeFile(binary, 'fixture');
  const calls = [], executeFile = async (filename, args) => { calls.push({ filename, args }); return { stdout: 'codex-cli 1.0.0' }; };
  assert.equal(await findCodex(installation, { env: { CODEX_BINARY: binary }, platform: 'win32', executeFile }), await realpath(binary));
  assert.deepEqual(calls[0].args, ['--version']);
  await assert.rejects(findCodex(installation, { env: { CODEX_BINARY: path.join(root, 'missing.exe'), LOCALAPPDATA: path.join(root, 'local') }, platform: 'win32', executeFile }), /CODEX_BINARY/);
  assert.equal(await findCodex(installation, { env: { LOCALAPPDATA: path.join(root, 'local') }, platform: 'win32', home: root, executeFile }), await realpath(binary));
});

test('MCP command is host-compatible while runtime verification rejects a different executable', async t => {
  const root = await fixture(t), other = path.join(root, 'node.exe'); await writeFile(other, 'fixture');
  const config = { nodePath: process.execPath }, mcp = materializeMcp({ mcpServers: { mobile: {} } }, config, root);
  assert.equal(mcp.mcpServers.mobile.command, path.basename(process.execPath));
  assert.equal(mcp.mcpServers.mobile.env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
  await verifyRuntime(config);
  await assert.rejects(verifyRuntime({ nodePath: other }), /绑定的软件运行组件/);
});

test('workspace binding rejects disk root, installation and descendants but accepts sibling project', async t => {
  const root = await fixture(t), installation = path.join(root, 'software'), child = path.join(installation, 'lib'), project = path.join(root, 'project');
  await mkdir(child, { recursive: true }); await mkdir(project);
  for (const directory of [path.parse(root).root, installation, child]) await assert.rejects(validateWorkspace(directory, installation), /安装目录/);
  assert.equal(await validateWorkspace(project, installation), await realpath(project));
});
