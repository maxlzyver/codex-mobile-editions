import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Backend } from './backend.mjs';
import { PluginUpdater } from './plugin-updater.mjs';
import { dataDirectory, loadConfig, readJson, verifyRuntime } from './config.mjs';

const execute = promisify(execFile);
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = await readJson(path.join(rootDir, 'plugin.json'));
const dataDir = dataDirectory(), config = await loadConfig(dataDir), backend = new Backend(config);
await verifyRuntime(config);
const resourceUri = `ui://codex-mobile/manager-${pkg.version}.html`;
const updater = new PluginUpdater({ rootDir, dataDir, config, loadedVersion: pkg.version, isBusy: () => backend.busy(), refreshHost: async () => {
  let binary = config.codexBinary;
  if (!binary) binary = (await readJson(path.join(config.installationRoot, '.runtime/launcher.json'))).codexBinary;
  if (!path.isAbsolute(binary || '')) throw new Error('Codex 安装路径未配置。');
  await execute(binary, ['plugin', 'add', 'codex-mobile@codex-mobile-local', '--json'], { timeout: 45000, maxBuffer: 64000, windowsHide: true });
} });
await updater.ready;
const server = new McpServer({ name: 'codex-mobile', version: pkg.version }, {
  instructions: 'Open mobile_panel for the embedded Codex management UI. Never open an external management page as a substitute. Owner credentials remain local and must never be returned. Plugin source updates require host reload before the loaded version changes.',
  capabilities: { extensions: { 'openai/settings': { readTool: 'mobile_settings_read', updateTool: 'mobile_settings_update' } }, experimental: { 'openai/settings': { readTool: 'mobile_settings_read', updateTool: 'mobile_settings_update' } } },
});
const annotations = (readOnly = true, openWorld = false) => ({ readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: openWorld });
const appOnly = { ui: { visibility: ['app'] }, 'openai/visibility': 'private' };
const uiMeta = { ui: { resourceUri }, 'openai/outputTemplate': resourceUri, 'openai/widgetAccessible': true,
  'openai/ui': { entrypoints: [{ type: 'global', header: { enabled: true } }, { type: 'thread' }, { type: 'settings' }] } };
const result = (value, summary = '操作完成。', privateValue) => ({ content: [{ type: 'text', text: summary }], structuredContent: value, ...(privateValue ? { _meta: { mobile: privateValue } } : {}) });
const safe = handler => async (...args) => { try { return await handler(...args); } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error.message).replace(/#owner=[\w-]+/g, '#owner=[hidden]').slice(0, 700) }] }; } };
async function snapshot({ start = false, focus = 'connect' } = {}) {
  let state = null, error = null;
  try { state = await backend.status({ start }); } catch (failure) { error = failure.message; }
  return { configured: Boolean(config), pluginVersion: pkg.version, pluginUpdate: updater.getState(), backend: state, error, focus };
}
server.registerResource('mobile-manager', resourceUri, { mimeType: 'text/html;profile=mcp-app', description: '移动助手内嵌管理页面' }, async () => ({ contents: [{
  uri: resourceUri, mimeType: 'text/html;profile=mcp-app', text: await readFile(path.join(rootDir, 'ui/app.html'), 'utf8'),
  _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/widgetPrefersBorder': false,
    'openai/widgetDescription': 'Codex 移动助手：连接、设备、权限、使用说明、更新与关于。', 'openai/widgetCSP': { connect_domains: [], resource_domains: [] } },
}] }));
for (const [name, title, focus] of [['mobile_panel', '打开移动助手', 'connect'], ['mobile_help', '移动助手使用说明', 'help'], ['mobile_updates', '移动助手更新', 'updates'], ['mobile_about', '关于移动助手', 'about']]) {
  server.registerTool(name, { title, description: `${title}，在 Codex 内显示管理页面，不打开外部网页。${name === 'mobile_panel' ? '自动启动或复用已绑定后台，直接进入手机连接页。' : ''}`, inputSchema: z.object({}).strict(), annotations: annotations(name !== 'mobile_panel'),
    _meta: name === 'mobile_panel' ? uiMeta : { ui: { resourceUri }, 'openai/widgetAccessible': true } }, safe(async () => result(await snapshot({ focus, start: name === 'mobile_panel' && Boolean(config) }), '已打开 Codex 内移动助手页面。')));
}
server.registerTool('mobile_status', { title: '查看移动助手状态', description: '读取后台、手机连接与插件版本状态，不启动服务。', inputSchema: z.object({}).strict(), annotations: annotations() }, safe(async () => result(await snapshot(), '移动助手当前状态。')));
server.registerTool('mobile_diagnose', { title: '诊断移动助手连接', description: '检查绑定、运行组件、后台认证与 Codex 连接，返回不包含凭据的诊断。', inputSchema: z.object({}).strict(), annotations: annotations() }, safe(async () => result(await backend.diagnose(), '移动助手诊断结果。')));
function appTool(name, title, inputSchema, handler, { readOnly = false, openWorld = false } = {}) {
  server.registerTool(name, { title, description: title, inputSchema, annotations: annotations(readOnly, openWorld), _meta: appOnly }, safe(handler));
}
appTool('mobile_start', '启动或复用移动助手后台', z.object({}).strict(), async () => { await backend.ensureStarted(); return result(await snapshot(), '助手已在后台运行。'); });
appTool('mobile_reconnect', '重新连接 Codex', z.object({}).strict(), async () => { await backend.request('/api/reconnect', {}); return result(await snapshot()); });
appTool('mobile_pairing', '生成手机配对二维码', z.object({ mode: z.enum(['lan', 'internet']) }).strict(), async ({ mode }) => {
  const pairing = await backend.request('/api/pairing', { mode });
  return result({ expiresAt: pairing.expiresAt, mode }, '配对二维码已显示在管理页面；请在页面确认待连接设备。', { pairing });
});
appTool('mobile_device_change', '批准或撤销指定手机设备', z.object({ id: z.string().regex(/^[a-f0-9]{24}$/), action: z.enum(['approve', 'revoke']) }).strict(), async ({ id, action }) => { await backend.request(`/api/devices/${id}/${action}`, {}); return result(await snapshot()); });
appTool('mobile_permissions', '保存手机权限', z.object({ allowMobileApprovals: z.boolean().optional(), allowMobileStop: z.boolean().optional(), allowOtherFiles: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0), async patch => { await backend.request('/api/permissions', patch); return result(await snapshot()); });
appTool('mobile_tunnel', '开启或关闭互联网手机连接', z.object({ action: z.enum(['start', 'stop']) }).strict(), async ({ action }) => { await backend.request('/api/tunnel', { action }); return result(await snapshot()); }, { openWorld: true });
appTool('mobile_backend_update', '检查或安装助手后台更新', z.object({ action: z.enum(['check', 'install']) }).strict(), async ({ action }) => { await backend.request(`/api/updates/${action}`, {}); return result(await snapshot({ focus: 'updates' })); }, { openWorld: true });
appTool('mobile_backend_auto_update', '设置助手后台自动更新', z.object({ autoUpdate: z.boolean() }).strict(), async patch => { await backend.request('/api/updates/settings', patch); return result(await snapshot({ focus: 'updates' })); });
appTool('mobile_plugin_update', '检查或安装插件自身更新', z.object({ action: z.enum(['check', 'install']) }).strict(), async ({ action }) => { await updater[action](); return result(await snapshot({ focus: 'updates' })); }, { openWorld: true });
appTool('mobile_plugin_auto_update', '设置插件自身自动更新', z.object({ autoUpdate: z.boolean() }).strict(), async patch => { await updater.configure(patch); return result(await snapshot({ focus: 'updates' })); });

const settingLabels = { allowMobileApprovals: '允许手机处理任务审批', allowMobileStop: '允许手机停止任务', allowOtherFiles: '允许手机访问其他目录', backendAutoUpdate: '自动更新助手后台', pluginAutoUpdate: '自动更新移动助手插件' };
const settingsSchema = { type: 'object', properties: Object.fromEntries(Object.entries(settingLabels).map(([key, title]) => [key, { type: 'boolean', title }])), required: Object.keys(settingLabels), additionalProperties: false };
async function settingValues() {
  let permissions = {}, backendAutoUpdate = false;
  try { const state = await backend.status(); permissions = state.permissions; backendAutoUpdate = state.updates?.autoUpdate === true; }
  catch { if (config) { try { await backend.validate(config.installationRoot); permissions = await readJson(path.join(config.installationRoot, '.runtime/mobile-permissions.json')); } catch { } try { backendAutoUpdate = (await readJson(path.join(config.installationRoot, '.runtime/updates/settings.json'))).autoUpdate === true; } catch { } } }
  return { allowMobileApprovals: permissions.allowMobileApprovals === true, allowMobileStop: permissions.allowMobileStop === true, allowOtherFiles: permissions.allowOtherFiles === true, backendAutoUpdate, pluginAutoUpdate: updater.getState().autoUpdate };
}
server.registerTool('mobile_settings_read', { title: '读取插件设置', inputSchema: z.object({}).strict(), annotations: annotations(), _meta: appOnly }, safe(async () => result({ schema: settingsSchema, values: await settingValues(), layout: [
  { kind: 'group', title: '手机权限', items: ['allowMobileApprovals', 'allowMobileStop', 'allowOtherFiles'].map(property => ({ kind: 'property', property })) },
  { kind: 'group', title: '手机连接', items: [{ kind: 'tool', tool: 'mobile_panel', title: '打开手机配对页面' }, { kind: 'tool', tool: 'mobile_help', title: '使用说明' }] },
  { kind: 'group', title: '更新与关于', items: [{ kind: 'property', property: 'pluginAutoUpdate' }, { kind: 'property', property: 'backendAutoUpdate' }, { kind: 'tool', tool: 'mobile_updates', title: '检查更新与安装' }, { kind: 'tool', tool: 'mobile_about', title: '关于' }] },
] })));
server.registerTool('mobile_settings_update', { title: '保存插件设置', inputSchema: z.object({ set: z.object(Object.fromEntries(Object.keys(settingLabels).map(key => [key, z.boolean().optional()]))).strict().refine(value => Object.keys(value).length > 0) }).strict(), annotations: annotations(false), _meta: appOnly }, safe(async ({ set }) => {
  const permissions = Object.fromEntries(Object.entries(set).filter(([key]) => key.startsWith('allow')));
  if (Object.keys(permissions).length || set.backendAutoUpdate !== undefined) { await backend.ensureStarted(); if (Object.keys(permissions).length) await backend.request('/api/permissions', permissions); if (set.backendAutoUpdate !== undefined) await backend.request('/api/updates/settings', { autoUpdate: set.backendAutoUpdate }); }
  if (set.pluginAutoUpdate !== undefined) await updater.configure({ autoUpdate: set.pluginAutoUpdate });
  return result({ values: await settingValues() });
}));
server.server.onclose = () => updater.close();
await server.connect(new StdioServerTransport());
if (config) updater.startChecking();
process.on('SIGTERM', () => { updater.close(); server.close().finally(() => process.exit(0)); });
