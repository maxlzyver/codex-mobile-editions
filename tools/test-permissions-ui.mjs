// Permission, onboarding, announcement and directory UI regression; mocked APIs only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.MOBILE_UI_OUTPUT || path.join(os.tmpdir(), 'codex-permissions-' + Date.now()));
const editions = (process.env.MOBILE_UI_EDITIONS || 'windows10,windows11,macos').split(',');
assert.ok(editions.every(id => ['windows10', 'windows11', 'macos'].includes(id)));
const versions = Object.fromEntries(await Promise.all(editions.map(async id => [id, JSON.parse(await readFile(path.join(root, 'editions', id, 'package.json'), 'utf8')).version])));
const futureVersion = (version, offset) => { const [major, minor, patch] = version.split('.').map(Number); return `${major}.${minor}.${patch + offset}`; };
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const primary = 'a'.repeat(24), extra = 'b'.repeat(24);
let edition, fixture;
const errors = [], results = [];
const gate = () => { let release, enter; const promise = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { enter = resolve; }); return { promise, release, started, enter }; };
async function delayFixture(name) { const held = fixture[name]; if (held) { fixture[name] = null; held.enter(); await held.promise; } }
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
function makeFixture(id, role) {
  const cwd = id === 'macos' ? '/Users/mock/工作项目' : 'C:/Mock/工作项目';
  const drive = id === 'macos' ? '/Volumes/Research' : 'D:/';
  return { role, version: versions[id], permissions: { allowMobileApprovals: false, allowMobileStop: false, allowOtherFiles: false }, cwd, drive, folder: drive.replace(/\/$/, '') + '/研究 项目', added: false, approval: true, running: true, failPermission: false, failStop: false, posts: [] };
}
function permissions() { return { ...fixture.permissions, canManage: fixture.role === 'owner' }; }
function thread(native) { return { id: native ? 'native' : 'companion', title: native ? '原生桌面聊天' : '手机助手任务', cwd: fixture.cwd, status: fixture.running ? 'running' : 'idle', native, readOnly: false, capabilities: { send: true, stop: !native, approvals: !native }, messages: [{ id: 'answer', role: 'assistant', phase: 'commentary', text: '正在处理受支持任务。' }] }; }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      let input;
      if (request.method === 'POST') { let raw = ''; for await (const part of request) raw += part; input = JSON.parse(raw); fixture.posts.push({ path: url.pathname, input, csrf: request.headers['x-csrf-token'] }); }
      if (url.pathname === '/api/bootstrap') { const snapshot = { role: fixture.role, csrfToken: 'mock-csrf', status: { codex: 'connected', mode: 'standalone' }, app: { version: fixture.version }, permissions: permissions() }; await delayFixture('holdBootstrap'); return json(response, snapshot); }
      if (url.pathname === '/api/permissions') {
        if (request.method === 'POST') {
          assert.equal(fixture.role, 'owner'); assert.equal(request.headers['x-csrf-token'], 'mock-csrf');
          if (fixture.failPermission) { fixture.failPermission = false; return json(response, { error: '模拟保存失败' }, 500); }
          assert.ok(Object.keys(input).every(key => key in fixture.permissions && typeof input[key] === 'boolean'));
          Object.assign(fixture.permissions, input);
        }
        const snapshot = permissions(); if (request.method !== 'POST') await delayFixture('holdPermissions'); return json(response, snapshot);
      }
      if (url.pathname === '/api/models') return json(response, { models: [] });
      if (url.pathname === '/api/updates') return json(response, { status: 'upToDate', currentVersion: fixture.version, latestVersion: fixture.version, autoUpdate: false });
      if (url.pathname === '/api/threads') return json(response, { threads: [thread(false), thread(true)] });
      if (url.pathname === '/api/threads/companion') return json(response, { thread: thread(false), approvals: fixture.approval ? [{ id: 'request-1', method: 'item/commandExecution/requestApproval', command: 'mock-only', supported: true }] : [] });
      if (url.pathname === '/api/threads/native') return json(response, { thread: thread(true), approvals: [{ id: 'native-request', method: 'item/commandExecution/requestApproval', command: 'native mock-only', supported: false }] });
      if (url.pathname === '/api/threads/companion/stop') { assert.ok(fixture.role === 'owner' || fixture.permissions.allowMobileStop); if (fixture.failStop) { fixture.failStop = false; return json(response, { error: '当前轮次尚未就绪，请稍后重试' }, 409); } return json(response, { ok: true, requested: true }); }
      if (url.pathname === '/api/approvals/request-1') { assert.ok(fixture.role === 'owner' || fixture.permissions.allowMobileApprovals); fixture.approval = false; return json(response, { ok: true }); }
      if (url.pathname === '/api/projects') {
        if (request.method === 'POST') { assert.ok(fixture.role === 'owner' || fixture.permissions.allowOtherFiles); assert.equal(input.path, fixture.folder); fixture.added = true; return json(response, { id: extra, path: fixture.folder, name: '研究 项目', exists: true }); }
        const snapshot = { projects: [{ id: primary, path: fixture.cwd, name: '工作项目', exists: true }, ...(fixture.added && (fixture.role === 'owner' || fixture.permissions.allowOtherFiles) ? [{ id: extra, path: fixture.folder, name: '研究 项目', exists: true }] : [])] }; await delayFixture('holdProjects'); return json(response, snapshot);
      }
      if (/^\/api\/projects\/[ab]{24}\/files$/.test(url.pathname)) {
        const additional = url.pathname.includes(extra); if (additional) assert.ok(fixture.role === 'owner' || fixture.permissions.allowOtherFiles);
        if (additional) await delayFixture('holdFiles');
        return json(response, { project: { id: additional ? extra : primary, path: additional ? fixture.folder : fixture.cwd, name: additional ? '研究 项目' : '工作项目' }, path: '', entries: additional ? [{ name: '已撤销范围.txt', path: '旧文件.txt', type: 'file', size: 15 }] : [], breadcrumbs: [] });
      }
      if (url.pathname === '/api/projects/' + extra + '/preview') { assert.ok(fixture.role === 'owner' || fixture.permissions.allowOtherFiles); await delayFixture('holdPreview'); return json(response, { text: '已撤销范围的延迟预览' }); }
      if (url.pathname === '/api/filesystem') {
        assert.ok(fixture.role === 'owner' || fixture.permissions.allowOtherFiles);
        const requested = url.searchParams.get('path');
        assert.ok(!requested || [fixture.drive, fixture.folder].includes(requested));
        return json(response, { path: requested || null, parent: requested === fixture.folder ? fixture.drive : null, locations: [{ name: '其他盘', path: fixture.drive }], entries: requested === fixture.drive ? [{ name: '研究 项目', path: fixture.folder, type: 'directory' }] : [] });
      }
      errors.push('Unexpected API ' + request.method + ' ' + url.pathname); return json(response, { error: 'Unexpected fixture request' }, 404);
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(!name.includes('..') && !name.includes('\\'));
    const body = await readFile(path.join(root, 'editions', edition, 'public', name));
    response.writeHead(200, { 'content-type': mime[path.extname(name)] || 'application/octet-stream', 'Content-Security-Policy': csp }); response.end(body);
  } catch (error) { errors.push(error.stack); json(response, { error: 'Fixture failed' }, 500); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try { browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) }); }
catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
const refresh = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
async function openThread(page, name) { await page.locator('#sidebar-open').tap(); await page.locator('.thread-item').filter({ hasText: name }).tap(); await page.waitForFunction(title => document.querySelector('#thread-title').textContent === title, name); }
async function waitPermission(page, enabled) { await page.waitForFunction(value => document.querySelector('#permission-stop').checked === value, enabled); }
async function assertLayout(page, selector) {
  const value = await page.evaluate(selector => { const node = document.querySelector(selector); return { viewport: innerWidth, document: document.documentElement.scrollWidth, client: node.clientWidth, scroll: node.scrollWidth }; }, selector);
  assert.ok(value.document <= value.viewport && value.scroll <= value.client + 1, JSON.stringify(value)); return value;
}
try {
  for (const id of editions) for (const role of ['owner', 'controller']) {
    edition = id; fixture = makeFixture(id, role === 'controller' ? 'pending' : role);
    const width = role === 'controller' ? 320 : 390, size = role === 'controller' ? 22 : 16;
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await context.addInitScript(({ id, size }) => localStorage.setItem('codex-mobile.' + id + '.appearance.v1', JSON.stringify({ theme: 'blue', font: 'system', size })), { id, size });
    const page = await context.newPage(); const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content.Security.Policy|Refused to|SyntaxError/i.test(message.text())) browserErrors.push(message.text()); });
    await page.goto(origin);
    if (role === 'controller') {
      await page.waitForFunction(() => document.querySelector('#auth-title').textContent.includes('请在电脑上确认'));
      await page.waitForTimeout(450); assert.equal(await page.locator('#release-notice').evaluate(node => node.open), false, 'Pending pairing must not be interrupted');
      fixture.role = role; await refresh(page);
    }
    await page.waitForSelector('#workspace:not(.hidden)');
    await page.waitForFunction(() => document.querySelector('#release-notice').open);
    assert.match(await page.locator('#release-notice-title').textContent(), /欢迎使用/);
    assert.ok((await page.locator('#release-notice-version').textContent()).includes(versions[id]));
    const releaseText = await page.locator('#release-notice').textContent();
    for (const feature of ['结果先显示', '长对话更轻快', '新的应用图标', '过程可折叠', '发出的指令看得见', '文件直接打开', '项目与模型更清晰', '手机权限默认关闭', '新版本提醒']) assert.ok(releaseText.includes(feature), `Missing release feature: ${feature}`);
    await assertLayout(page, '#release-notice');
    await page.screenshot({ path: path.join(output, id + '-' + role + '-notice.png'), fullPage: true });
    await page.locator('#release-notice-done').tap();
    assert.ok(await page.locator('#permission-guide').isVisible());
    await page.locator('#permission-guide [data-open-permissions]').tap();
    await page.waitForFunction(() => document.querySelector('#settings-tab-permissions').getAttribute('aria-selected') === 'true');
    await page.waitForFunction(() => document.querySelector('#permission-feedback').textContent.includes('保存的设置'));
    for (const suffix of ['approvals', 'stop', 'files']) { assert.equal(await page.locator('#permission-' + suffix).isChecked(), false); assert.equal(await page.locator('#permission-' + suffix).isDisabled(), role !== 'owner'); }
    assert.match(await page.locator('#settings-permissions').textContent(), /不改变 Codex 的执行权限或沙箱/);
    assert.match(await page.locator('#settings-permissions').textContent(), /原生桌面接口尚不支持/);
    await assertLayout(page, '#settings-dialog');
    await page.screenshot({ path: path.join(output, id + '-' + role + '-permissions.png'), fullPage: true });
    if (role === 'owner') {
      const permissionsGate = fixture.holdPermissions = gate();
      await page.locator('#settings-tab-permissions').tap(); await permissionsGate.started;
      assert.equal(await page.locator('#permission-files').isDisabled(), true, 'Loading permissions must prevent conflicting writes');
      const postCount = fixture.posts.length;
      await page.locator('#permission-files').evaluate(input => { input.checked = true; input.dispatchEvent(new Event('change')); });
      assert.equal(fixture.posts.length, postCount); permissionsGate.release();
      await page.waitForFunction(() => !document.querySelector('#permission-files').disabled);
      assert.equal(await page.locator('#permission-files').isChecked(), false);
      for (const [field, suffix] of [['allowMobileApprovals', 'approvals'], ['allowMobileStop', 'stop'], ['allowOtherFiles', 'files']]) {
        await page.locator('#permission-' + suffix).tap();
        await page.waitForFunction(suffix => document.querySelector('#permission-' + suffix).checked && !document.querySelector('#permission-' + suffix).disabled, suffix);
        assert.equal(fixture.posts.at(-1).path, '/api/permissions'); assert.deepEqual(fixture.posts.at(-1).input, { [field]: true });
      }
      fixture.failPermission = true; await page.locator('#permission-stop').tap();
      await page.waitForFunction(() => document.querySelector('#permission-feedback').textContent.includes('模拟保存失败'));
      assert.equal(await page.locator('#permission-stop').isChecked(), true, 'Failed persistence must retain confirmed state');
    } else assert.match(await page.locator('#permission-manager-note').textContent(), /手机只能查看/);
    await page.locator('#settings-close').tap(); await page.locator('#permission-guide-close').tap();
    await page.reload(); await page.waitForSelector('#workspace:not(.hidden)'); await page.waitForTimeout(450);
    assert.equal(await page.locator('#release-notice').evaluate(node => node.open), false, 'Same version notice must not repeat'); assert.equal(await page.locator('#permission-guide').isVisible(), false);
    fixture.version = futureVersion(versions[id], 1); await refresh(page); await page.waitForFunction(() => document.querySelector('#release-notice').open);
    assert.equal(await page.locator('#release-notice-title').textContent(), `V${futureVersion(versions[id], 1)} 更新公告`); await page.locator('#release-notice-done').tap();
    await page.locator('#settings-open').tap(); await page.locator('#settings-tab-about').tap(); await page.locator('#release-notice-review').tap();
    assert.equal(await page.locator('#release-notice').evaluate(node => node.open), true); await page.locator('#release-notice-close').tap(); await page.locator('#settings-close').tap();

    // Standalone Tasks.view has no desktop control/source labels; capability fields are authoritative.
    if (role === 'owner') { Object.assign(fixture.permissions, { allowMobileApprovals: false, allowMobileStop: false, allowOtherFiles: false }); await refresh(page); await waitPermission(page, false); }
    await openThread(page, '手机助手任务');
    if (role === 'controller') {
      assert.equal(await page.locator('#stop-turn').isVisible(), false);
      await page.waitForSelector('.approval-permission-note'); assert.match(await page.locator('.approval-permission-note').textContent(), /手机审批已关闭/);
      await page.locator('#stop-turn').evaluate(button => button.click()); assert.ok(!fixture.posts.some(post => post.path.endsWith('/stop')), 'Disabled capability must not send requests');
      Object.assign(fixture.permissions, { allowMobileApprovals: true, allowMobileStop: true, allowOtherFiles: true }); await refresh(page);
    }
    await page.locator('#stop-turn').waitFor(); await page.getByRole('button', { name: '允许这次操作', exact: true }).waitFor();
    await page.getByRole('button', { name: '允许这次操作', exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('#approvals').children.length === 0);
    assert.ok(fixture.posts.some(post => post.path === '/api/approvals/request-1' && post.input.decision === 'accept'));
    fixture.failStop = true; await page.locator('#stop-turn').tap();
    await page.waitForFunction(() => document.querySelector('#error-banner').textContent.includes('当前轮次尚未就绪'));
    assert.equal(await page.locator('#stop-turn').isVisible(), true, 'Rejected interruption keeps the running task visible');
    assert.equal(await page.locator('#toast').textContent(), '已发送确认', 'A rejected stop must not be announced as success');
    await page.locator('#stop-turn').tap();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === '已发送停止请求');
    assert.equal(await page.locator('#stop-turn').isVisible(), true, 'Accepted request does not claim the task is already stopped');
    fixture.running = false; await refresh(page); await page.waitForFunction(() => document.querySelector('#stop-turn').classList.contains('hidden'));
    assert.ok(fixture.posts.some(post => post.path === '/api/threads/companion/stop'));
    fixture.running = true; await openThread(page, '原生桌面聊天');
    assert.equal(await page.locator('#stop-turn').isVisible(), false); assert.match(await page.locator('#composer-hint').textContent(), /原生接口不支持手机审批和停止/);
    await page.locator('.approval-permission-note').waitFor(); assert.match(await page.locator('.approval-permission-note').textContent(), /当前聊天不支持/);
    assert.equal(await page.getByRole('button', { name: '允许这次操作', exact: true }).count(), 0, 'Permissions never grant unsupported native approvals');
    await page.locator('#sidebar-open').tap(); await page.locator('#projects-open').tap(); await page.locator('#other-files-open').tap();
    await page.locator('#directory-list .directory-entry').filter({ hasText: '其他盘' }).tap();
    await page.locator('#directory-list .directory-entry').filter({ hasText: '研究 项目' }).tap();
    await page.waitForFunction(folder => document.querySelector('#directory-path').value === folder, fixture.folder);
    await assertLayout(page, '#directory-dialog'); await page.screenshot({ path: path.join(output, id + '-' + role + '-directory.png'), fullPage: true });
    await page.locator('#directory-add').tap(); await page.waitForFunction(() => !document.querySelector('#directory-dialog').open);
    assert.ok(fixture.posts.some(post => post.path === '/api/projects' && post.input.path === fixture.folder));
    assert.equal(await page.locator('#files-project').inputValue(), extra);
    if (role === 'controller') {
      const previewGate = fixture.holdPreview = gate();
      await page.locator('.file-open').filter({ hasText: '已撤销范围.txt' }).tap(); await previewGate.started;
      const filesGate = fixture.holdFiles = gate();
      await page.locator('#files-project').evaluate(select => select.dispatchEvent(new Event('change'))); await filesGate.started;
      const projectsGate = fixture.holdProjects = gate();
      await page.locator('#files-refresh').evaluate(button => button.click()); await projectsGate.started;
      fixture.permissions.allowOtherFiles = false; await refresh(page);
      await page.waitForFunction(() => document.querySelector('#other-files-open').classList.contains('hidden'));
      assert.equal(await page.locator('#add-project-form').isVisible(), false);
      await page.waitForFunction(id => ![...document.querySelector('#files-project').options].some(option => option.value === id), extra);
      assert.equal(await page.locator('#preview-dialog').evaluate(dialog => dialog.open), false);
      previewGate.release(); filesGate.release(); projectsGate.release();
      await page.waitForFunction(() => document.querySelector('#files-project-path').textContent.includes('工作项目'));
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#preview-content').textContent(), '', 'Late preview response must stay discarded');
      assert.equal(await page.locator('#file-list').textContent().then(text => text.includes('已撤销范围')), false, 'Late file listing must stay discarded');
      assert.equal(await page.locator('#files-project').evaluate(select => [...select.options].some(option => option.text.includes('研究 项目'))), false, 'Late project list cannot restore removed roots');
      assert.ok(await page.locator('#file-list').isVisible(), 'Ordinary authorized projects remain available');
    } else {
      await page.locator('#project-task').tap(); assert.equal(await page.locator('#project-select').inputValue(), extra);
    }
    if (role === 'controller') {
      await page.locator('#settings-open').tap();
      await page.waitForFunction(() => document.querySelector('#update-status').textContent.includes('最新版本'));
      fixture.version = futureVersion(versions[id], 2); const identityGate = fixture.holdBootstrap = gate();
      await page.locator('#settings-tab-permissions').tap(); await identityGate.started;
      fixture.role = 'pending'; await refresh(page);
      await page.waitForFunction(() => document.querySelector('#app').dataset.role === 'pending');
      identityGate.release(); await page.waitForTimeout(100); await page.locator('#settings-close').tap(); await page.waitForTimeout(450);
      assert.equal(await page.locator('#release-notice').evaluate(dialog => dialog.open), false, 'Old settings identity cannot announce a release after pairing is revoked');
      assert.equal(await page.evaluate(id => localStorage.getItem('codex-mobile.' + id + '.notice.lastVersion'), id), futureVersion(versions[id], 1), 'A late response must not mark an unseen release as read');
    }
    await assertLayout(page, '#app'); assert.deepEqual(browserErrors, []);
    results.push({ edition: id, role, width, fontSize: size, permissions: true, standaloneCli: true, ownerIndependent: role === 'owner', stopAcknowledgement: true, nativeNotPromoted: true, directorySelection: true, revocationDropsLateResponses: role === 'controller', permissionReadWriteSerialized: role === 'owner', staleIdentityDiscarded: role === 'controller', versionNoticeOnce: true, manualNotice: true, pairingUnblocked: true, browserErrors });
    await context.close(); console.log('PASS permissions ' + id + ' ' + role + ' ' + width + 'px');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'permissions-report.json'), JSON.stringify({ ok: true, results }, null, 2));
  console.log('Permission UI regression passed: ' + path.join(output, 'permissions-report.json'));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
