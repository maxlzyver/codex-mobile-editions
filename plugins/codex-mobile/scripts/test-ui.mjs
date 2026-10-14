// Isolated MCP Apps host fixture: never connects to a user's desktop or changes real settings.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const host = await build({ stdin: { contents: `import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
  const iframe=document.getElementById('app');
  const bridge=new AppBridge(null,{name:'Fixture',version:'1.0'},{openLinks:{},serverTools:{},logging:{}},{hostContext:{theme:'light',displayMode:'inline',availableDisplayModes:['inline']}});
  bridge.oncalltool=async params=>(await fetch('/tool',{method:'POST',body:JSON.stringify(params)})).json();
  bridge.onopenlink=async params=>{await fetch('/link',{method:'POST',body:JSON.stringify(params)});return {}};
  await bridge.connect(new PostMessageTransport(iframe.contentWindow,iframe.contentWindow)); iframe.src='/ui';`, resolveDir: root }, bundle: true, format: 'esm', platform: 'browser', write: false, minify: true });
const appHtml = await readFile(path.join(root, 'ui/app.html'));
const requests = [], links = [], failures = [];
const state = { configured: true, pluginVersion: '1.3.0', focus: 'connect', error: null,
  pluginUpdate: { loadedVersion: '1.3.0', installedVersion: '1.3.0', latestVersion: '1.3.1', status: 'available', hasUpdate: true, autoUpdate: false, releaseNotes: '<img src=x onerror="window.attack=true"> new release' },
  backend: { app: { version: '1.3.0' }, status: { codex: 'connected' }, connection: { lanUrls: ['http://192.168.1.2:43127'], tunnelStatus: 'stopped' }, busy: false,
    devices: [{ id: 'a'.repeat(24), name: '<img src=x onerror="window.attack=true">', status: 'pending' }], permissions: { allowMobileApprovals: false, allowMobileStop: false, allowOtherFiles: false },
    updates: { currentVersion: '1.3.0', latestVersion: '1.3.1', status: 'available', hasUpdate: true, autoUpdate: false, releaseNotes: '后台更新' } } };
const server = createServer(async (req, res) => {
  if (req.url === '/ui') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'" }); res.end(appHtml); return; }
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(`<iframe id="app" style="width:100%;height:1100px;border:0"></iframe><script type="module">${host.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`); return; }
  if (req.url === '/tool' || req.url === '/link') {
    let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body); res.setHeader('content-type', 'application/json');
    if (req.url === '/link') { links.push(input.url); res.end('{}'); return; }
    requests.push(input); const args = input.arguments;
    if (input.name === 'mobile_permissions') Object.assign(state.backend.permissions, args);
    if (input.name === 'mobile_device_change') state.backend.devices[0].status = 'approved';
    if (input.name === 'mobile_tunnel') state.backend.connection.tunnelStatus = args.action === 'start' ? 'running' : 'stopped';
    if (input.name === 'mobile_plugin_auto_update') state.pluginUpdate.autoUpdate = args.autoUpdate;
    if (input.name === 'mobile_backend_auto_update') state.backend.updates.autoUpdate = args.autoUpdate;
    if (input.name === 'mobile_plugin_update' && args.action === 'install') Object.assign(state.pluginUpdate, { installedVersion: '1.3.1', hasUpdate: false, pendingRestart: true, status: 'pending_restart' });
    if (input.name === 'mobile_pairing') { res.end(JSON.stringify({ content: [], structuredContent: { expiresAt: Date.now() + 120000 }, _meta: { mobile: { pairing: { expiresAt: Date.now() + 120000, url: 'http://192.168.1.2:43127/#pair=fixture', qrDataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>').toString('base64') } } } })); return; }
    res.end(JSON.stringify({ content: [], structuredContent: state })); return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 850 } }); page.on('pageerror', error => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); const frame = page.frameLocator('#app');
  await frame.locator('#service-status').filter({ hasText: '已连接' }).waitFor();
  await frame.locator('#pair-lan').click(); await frame.locator('#pairing-box').waitFor({ state: 'visible' }); assert.match(await frame.locator('#pairing-link').innerText(), /#pair=fixture/);
  await frame.locator('[data-tab="devices"]').click(); await frame.getByText('批准连接', { exact: true }).click(); await frame.getByText('撤销权限', { exact: true }).waitFor();
  assert.equal(await frame.locator('#device-list img').count(), 0);
  await frame.locator('[data-tab="permissions"]').click(); await frame.locator('#allowMobileStop').check(); await page.waitForFunction(() => true); assert.ok(requests.some(v => v.name === 'mobile_permissions' && v.arguments.allowMobileStop));
  await frame.locator('[data-tab="updates"]').click(); await frame.locator('#plugin-auto').check(); await frame.locator('#plugin-install').click(); await frame.locator('#plugin-update-status').filter({ hasText: '待 Codex' }).waitFor();
  assert.equal(await frame.locator('#plugin-loaded').innerText(), '1.3.0'); assert.equal(await frame.locator('#plugin-installed').innerText(), '1.3.1');
  assert.equal(await frame.locator('#plugin-notes img').count(), 0);
  await frame.locator('[data-tab="help"]').click(); await frame.getByText('开始使用', { exact: true }).waitFor();
  await frame.locator('[data-tab="about"]').click(); await frame.locator('#repository').click();
  await page.waitForFunction(() => true); assert.deepEqual(links, ['https://github.com/maxlzyver/codex-mobile-editions']);
  await page.setViewportSize({ width: 390, height: 850 });
  assert.equal(await frame.locator('body').evaluate(body => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(failures, []); assert.equal(browser.contexts()[0].pages().length, 1);
  console.log(JSON.stringify({ ok: true, checks: ['official MCP Apps handshake under strict CSP', 'pairing', 'device approval', 'permission persistence', 'plugin auto update and pending version', 'help', 'about links', 'XSS text', '390px layout'], toolCalls: requests.length }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
