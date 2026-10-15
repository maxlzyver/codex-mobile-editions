// Isolated MCP Apps host fixture: never connects to a user's desktop or changes real settings.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
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
let failNextTool = null, blockedRequestReceived = false;
async function until(predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(50); } throw new Error('Timed out waiting for UI response'); }
const state = { configured: true, pluginVersion: '1.3.0', focus: 'connect', error: null,
  pluginUpdate: { loadedVersion: '1.3.0', installedVersion: '1.3.0', latestVersion: '1.3.1', status: 'available', hasUpdate: true, autoUpdate: false, releaseNotes: '<img src=x onerror="window.attack=true"> new release' },
  backend: { app: { version: '1.3.0' }, status: { codex: 'connected', authenticated: true, version: '1.3.0', mode: 'standalone', error: null }, connection: { lanUrls: ['http://192.168.1.2:43127'], tunnelStatus: 'stopped', publicUrl: null, tunnelError: null }, desktop: { connected: false, error: null }, defaultCwd: '/fixture/project', busy: false,
    devices: [], permissions: { allowMobileApprovals: false, allowMobileStop: false, allowOtherFiles: false },
    updates: { currentVersion: '1.3.0', latestVersion: '1.3.1', status: 'available', hasUpdate: true, autoUpdate: false, releaseNotes: '后台更新' } } };
const server = createServer(async (req, res) => {
  if (req.url === '/ui') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'" }); res.end(appHtml); return; }
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(`<iframe id="app" sandbox="allow-scripts allow-same-origin" style="width:100%;height:1100px;border:0"></iframe><button id="host-close" aria-label="宿主关闭" style="position:fixed;top:16px;right:16px;width:32px;height:32px;z-index:1000;border:0;background:#fff;border-radius:50%">×</button><script type="module">${host.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`); return; }
  if (req.url === '/blocked-by-csp') { blockedRequestReceived = true; res.end('unexpected'); return; }
  if (req.url === '/tool' || req.url === '/link') {
    let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body); res.setHeader('content-type', 'application/json');
    if (req.url === '/link') { links.push(input.url); res.end('{}'); return; }
    requests.push(input); const args = input.arguments;
    if (input.name === failNextTool) { failNextTool = null; res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: '测试：后台暂不可用，请重试。' }] })); return; }
    if (input.name === 'mobile_permissions') Object.assign(state.backend.permissions, args);
    if (input.name === 'mobile_device_change') state.backend.devices[0].status = 'approved';
    if (input.name === 'mobile_tunnel') state.backend.connection.tunnelStatus = args.action === 'start' ? 'running' : 'stopped';
    if (input.name === 'mobile_plugin_auto_update') state.pluginUpdate.autoUpdate = args.autoUpdate;
    if (input.name === 'mobile_backend_auto_update') state.backend.updates.autoUpdate = args.autoUpdate;
    if (input.name === 'mobile_pairing') state.backend.devices = [{ id: 'a'.repeat(24), name: '<img src=x onerror="window.attack=true">', status: 'pending' }];
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
  assert.match(await frame.locator('#app-icon').getAttribute('src'), /^data:image\/png;base64,/);
  assert.equal(await frame.locator('#app-icon').evaluate(image => image.complete && image.naturalWidth > 0), true);
  assert.equal(await frame.locator('#pair-lan').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(53, 101, 232)');
  await frame.locator('#pair-lan').click(); await frame.locator('#pairing-box').waitFor({ state: 'visible' }); assert.match(await frame.locator('#pairing-link').innerText(), /#pair=fixture/);
  await frame.locator('#pending-device-list').getByText('批准连接', { exact: true }).waitFor();
  if (process.env.CODEX_MOBILE_UI_SCREENSHOT) { await page.setViewportSize({ width: 390, height: 1000 }); await page.screenshot({ path: process.env.CODEX_MOBILE_UI_SCREENSHOT, fullPage: true }); await page.setViewportSize({ width: 1050, height: 850 }); }
  await frame.locator('#pending-device-list').getByText('批准连接', { exact: true }).click();
  assert.equal(await frame.locator('[data-pane="connect"]').isVisible(), true);
  await until(() => state.backend.devices[0].status === 'approved');
  await frame.locator('#pending-device-list .device-approved').waitFor();
  await frame.locator('[data-tab="devices"]').click(); await frame.locator('#device-list').getByText('撤销权限', { exact: true }).waitFor();
  assert.equal(await frame.locator('#device-list img').count(), 0);
  await frame.locator('[data-tab="permissions"]').click(); await frame.locator('#allowMobileStop').check(); await until(() => requests.some(v => v.name === 'mobile_permissions' && v.arguments.allowMobileStop));
  await until(async () => !(await frame.locator('#allowMobileStop').isDisabled())); assert.equal(await frame.locator('#allowMobileStop').isChecked(), true);
  await frame.locator('[data-tab="updates"]').click(); await frame.locator('#plugin-auto').check(); await until(() => state.pluginUpdate.autoUpdate);
  await until(async () => !(await frame.locator('#plugin-auto').isDisabled())); assert.equal(await frame.locator('#plugin-auto').isChecked(), true);
  await frame.locator('#plugin-install').click(); await frame.locator('#plugin-update-status').filter({ hasText: '待 Codex' }).waitFor();
  assert.equal(await frame.locator('#plugin-loaded').innerText(), '1.3.0'); assert.equal(await frame.locator('#plugin-installed').innerText(), '1.3.1');
  assert.equal(await frame.locator('#plugin-notes img').count(), 0);
  await frame.locator('#backend-auto').check(); await until(() => state.backend.updates.autoUpdate);
  await until(async () => !(await frame.locator('#backend-auto').isDisabled()));
  failNextTool = 'mobile_backend_auto_update'; await frame.locator('#backend-auto').uncheck();
  await frame.locator('#notice.error').filter({ hasText: '后台暂不可用' }).waitFor();
  await until(async () => !(await frame.locator('#backend-auto').isDisabled())); assert.equal(await frame.locator('#backend-auto').isChecked(), true);
  assert.equal(state.backend.updates.autoUpdate, true);
  await frame.locator('#backend-auto').uncheck(); await until(() => !state.backend.updates.autoUpdate);
  await until(async () => !(await frame.locator('#backend-auto').isDisabled())); assert.equal(await frame.locator('#backend-auto').isChecked(), false);
  await frame.locator('[data-tab="help"]').click(); await frame.getByText('开始使用', { exact: true }).waitFor();
  await frame.locator('[data-tab="about"]').click(); await frame.locator('#repository').click();
  await until(() => links.length === 1); assert.deepEqual(links, ['https://github.com/maxlzyver/codex-mobile-editions']);
  const blocked = await frame.locator('body').evaluate(async () => { try { await fetch('/blocked-by-csp'); return false; } catch { return true; } });
  assert.equal(blocked, true); assert.equal(blockedRequestReceived, false);
  for (const width of [420, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    for (const tab of ['connect', 'permissions']) {
      await frame.locator(`[data-tab="${tab}"]`).click();
      assert.equal(await frame.locator('body').evaluate(body => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const close = await page.locator('#host-close').boundingBox();
      for (const selector of ['#version', '.brand h1', '.brand p']) {
        const box = await frame.locator(selector).boundingBox();
        assert.ok(box && close && (box.x + box.width <= close.x || box.x >= close.x + close.width || box.y + box.height <= close.y || box.y >= close.y + close.height), `${width}px ${selector} overlaps host close button`);
      }
      if (width === 420 && tab === 'permissions' && process.env.CODEX_MOBILE_UI_SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.CODEX_MOBILE_UI_SETTINGS_SCREENSHOT, fullPage: true });
    }
  }
  assert.deepEqual(failures, []); assert.equal(browser.contexts()[0].pages().length, 1);
  console.log(JSON.stringify({ ok: true, checks: ['official MCP Apps handshake under strict CSP', 'original embedded icon and blue theme', 'pairing private result', 'polling discovers device and approval stays on connection page', 'permission persistence', 'plugin auto update and pending version', 'backend auto update', 'failed mutation rollback and retry', 'help', 'about links', 'XSS text', 'iframe network blocked by CSP', '320px 390px 420px connection and permissions layout', 'host close button never overlaps header text or version'], toolCalls: requests.length }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
