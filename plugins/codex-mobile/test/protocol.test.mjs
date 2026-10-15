import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, realpath, mkdir, copyFile, rename } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OpenAISettingsCapabilitySchema, OpenAISettingsReadResultSchema, OpenAISettingsUpdateArgumentsSchema, OpenAISettingsUpdateResultSchema } from '@openai/mcp-extensions';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('installed bundle negotiates MCP, exposes native entrypoints/settings and returns actual embedded page', async t => {
  const data = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-plugin-protocol-')));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/server.mjs')], env: { ...process.env, CODEX_MOBILE_PLUGIN_DATA: data }, stderr: 'pipe' });
  let errors = ''; transport.stderr.on('data', data => { errors += data; });
  const client = new Client({ name: 'test', version: '1.0' }); t.after(async () => { await client.close(); await rm(data, { recursive: true, force: true }); });
  try { await client.connect(transport); } catch (error) { throw new Error(`MCP initialization failed: ${error.message}; stderr: ${errors.replace(/#owner=[\w-]+/g, '#owner=[hidden]').slice(0, 2000)}`, { cause: error }); }
  const { tools } = await client.listTools(), panel = tools.find(tool => tool.name === 'mobile_panel');
  assert.deepEqual(panel._meta['openai/ui'].entrypoints.map(v => v.type), ['global', 'thread', 'settings']);
  assert.ok(client.getServerCapabilities().extensions['openai/settings']);
  OpenAISettingsCapabilitySchema.parse(client.getServerCapabilities().extensions['openai/settings']);
  for (const name of ['mobile_pairing', 'mobile_permissions', 'mobile_plugin_update', 'mobile_device_change']) assert.deepEqual(tools.find(tool => tool.name === name)._meta.ui.visibility, ['app']);
  const status = await client.callTool({ name: 'mobile_status', arguments: {} });
  assert.equal(status.structuredContent.configured, false); assert.equal(status.structuredContent.pluginVersion, '1.3.0');
  const html = (await client.readResource({ uri: panel._meta.ui.resourceUri })).contents[0];
  assert.equal(html.mimeType, 'text/html;profile=mcp-app');
  assert.equal((html.text.match(/<h1>/g) || []).length, 1);
  assert.equal((html.text.match(/<html /g) || []).length, 1);
  for (const text of ['手机权限', '使用说明', '一键更新插件', '关于', 'ui/initialize']) assert.ok(html.text.includes(text), text);
  const invalid = await client.callTool({ name: 'mobile_tunnel', arguments: { action: 'exec', command: 'whoami' } }); assert.equal(invalid.isError, true);
  const settings = await client.callTool({ name: 'mobile_settings_read', arguments: {} }); assert.equal(settings.structuredContent.values.pluginAutoUpdate, false);
  OpenAISettingsReadResultSchema.parse(settings.structuredContent);
  for (const [key, field] of Object.entries(settings.structuredContent.schema.properties)) { assert.equal(field.type, 'boolean'); assert.equal(typeof settings.structuredContent.values[key], 'boolean'); assert.ok(field.title); }
  for (const entry of settings.structuredContent.layout.flatMap(group => group.items).filter(item => item.kind === 'tool')) assert.ok(tools.find(tool => tool.name === entry.tool));
  const patch = { set: { pluginAutoUpdate: true } }; OpenAISettingsUpdateArgumentsSchema.parse(patch);
  const updated = await client.callTool({ name: 'mobile_settings_update', arguments: patch });
  OpenAISettingsUpdateResultSchema.parse(updated.structuredContent); assert.equal(updated.structuredContent.values.pluginAutoUpdate, true);
  const reread = await client.callTool({ name: 'mobile_settings_read', arguments: {} }); assert.equal(reread.structuredContent.values.pluginAutoUpdate, true);
  const rejected = await client.callTool({ name: 'mobile_settings_update', arguments: { set: { unexpected: true } } }); assert.equal(rejected.isError, true);
  assert.equal(errors, '');
});

test('a running MCP releases its Windows cache cwd and serves the loaded UI after cache replacement', async t => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-plugin-cache-')));
  const cache = path.join(temp, 'cache'), data = path.join(temp, 'data'), replaced = path.join(temp, 'old-cache');
  for (const file of ['plugin.json', 'dist/server.mjs', 'ui/app.html']) { const target = path.join(cache, file); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(root, file), target); }
  await mkdir(data);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(cache, 'dist/server.mjs')], cwd: cache, env: { ...process.env, CODEX_MOBILE_PLUGIN_DATA: data }, stderr: 'pipe' });
  let errors = ''; transport.stderr.on('data', chunk => { errors += chunk; });
  const client = new Client({ name: 'cache-refresh-test', version: '1.0' }); t.after(async () => { await client.close(); await rm(temp, { recursive: true, force: true }); });
  try { await client.connect(transport); } catch (error) { throw new Error(`MCP initialization failed: ${error.message}; ${errors.slice(0, 2000)}`, { cause: error }); }
  const panel = (await client.listTools()).tools.find(tool => tool.name === 'mobile_panel');
  const before = await client.readResource({ uri: panel._meta.ui.resourceUri });
  await rename(cache, replaced);
  const after = await client.readResource({ uri: panel._meta.ui.resourceUri }); assert.deepEqual(after, before);
  assert.equal((await client.callTool({ name: 'mobile_status', arguments: {} })).structuredContent.pluginVersion, '1.3.0');
  assert.equal(errors, '');
});
