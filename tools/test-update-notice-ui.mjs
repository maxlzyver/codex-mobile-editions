// Mock-only browser regression. No real Codex, GitHub update or installer is contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.MOBILE_UI_OUTPUT || path.join(os.tmpdir(), 'codex-update-notice-' + Date.now()));
const editions = (process.env.MOBILE_UI_EDITIONS || 'windows10,windows11,macos').split(',');
assert.ok(editions.every(id => ['windows10', 'windows11', 'macos'].includes(id)));
const versions = Object.fromEntries(await Promise.all(editions.map(async id => [id, JSON.parse(await readFile(path.join(root, 'editions', id, 'package.json'), 'utf8')).version])));
const futureVersion = (version, offset) => { const [major, minor, patch] = version.split('.').map(Number); return `${major}.${minor}.${patch + offset}`; };
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const notes = '同一轮过程与执行记录统一折叠。\n文件预览与发送状态继续保留。\n<img src=x onerror="window.__notesExecuted=true"><script>window.__notesExecuted=true</script>';
const heldGates = new Set();
const gate = () => { let release, enter; const promise = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { enter = resolve; }); const held = { promise, release, started, enter }; heldGates.add(held); return held; };
async function waitForGate(held) {
  let timer;
  try { await Promise.race([held.started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected mocked update request did not start')), 15000); })]); }
  finally { clearTimeout(timer); }
}
let edition, fixture;
const errors = [], results = [];
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
function updateState() { return { status: 'available', hasUpdate: true, currentVersion: versions[edition], latestVersion: fixture.latest, releaseNotes: notes, autoUpdate: false, releaseUrl: 'https://github.com/maxlzyver/codex-mobile-editions/releases/tag/v' + fixture.latest }; }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      fixture.calls.push({ path: url.pathname, method: request.method, role: fixture.role });
      if (url.pathname === '/api/bootstrap') return json(response, { role: fixture.role, csrfToken: 'mock-csrf', app: { version: versions[edition] }, status: { codex: 'connected', mode: 'standalone' }, permissions: { canManage: fixture.role === 'owner', allowMobileApprovals: false, allowMobileStop: false, allowOtherFiles: false } });
      if (url.pathname === '/api/threads') return json(response, { threads: [] });
      if (url.pathname === '/api/models') return json(response, { models: [] });
      if (url.pathname === '/api/projects') return json(response, { projects: [] });
      if (url.pathname === '/api/updates') {
        assert.ok(['owner', 'controller'].includes(fixture.role), 'Pending/unpaired devices must not request update state');
        const snapshot = updateState(); const held = fixture.holdUpdates;
        if (held) { fixture.holdUpdates = null; held.enter(); await held.promise; }
        return json(response, snapshot);
      }
      if (url.pathname === '/api/updates/check') {
        assert.equal(fixture.role, 'owner'); assert.equal(request.headers['x-csrf-token'], 'mock-csrf');
        const held = fixture.holdCheck;
        if (held) { fixture.holdCheck = null; held.enter(); await held.promise; return json(response, { error: '模拟迟到检查失败' }, 500); }
        return json(response, updateState());
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
const noticeOpen = page => page.locator('#update-notice').evaluate(dialog => dialog.open);
async function layout(page) {
  const bounds = await page.evaluate(() => { const node = document.querySelector('#update-notice'); return { viewport: innerWidth, document: document.documentElement.scrollWidth, client: node.clientWidth, scroll: node.scrollWidth }; });
  assert.ok(bounds.document <= bounds.viewport && bounds.scroll <= bounds.client + 1, JSON.stringify(bounds));
}
async function createContext(id, width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await context.addInitScript(({ id, size, version }) => {
    localStorage.setItem('codex-mobile.' + id + '.appearance.v1', JSON.stringify({ theme: 'blue', font: 'system', size }));
    localStorage.setItem('codex-mobile.' + id + '.notice.lastVersion', version);
    localStorage.setItem('codex-mobile.' + id + '.permissions-guide-dismissed.v1', 'true');
  }, { id, size: width === 320 ? 22 : 16, version: versions[id] });
  return context;
}
try {
  for (const id of editions) for (const role of ['owner', 'controller']) {
    const nextVersion = futureVersion(versions[id], 1), secondVersion = futureVersion(versions[id], 2), thirdVersion = futureVersion(versions[id], 3);
    edition = id; fixture = { role: role === 'controller' ? 'pending' : role, latest: nextVersion, calls: [] };
    const width = role === 'controller' ? 320 : 390;
    const context = await createContext(id, width), page = await context.newPage(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content.Security.Policy|Refused to|SyntaxError/i.test(message.text())) pageErrors.push(message.text()); });
    fixture.phase = 'initial notice'; await page.goto(origin);
    if (role === 'controller') {
      await page.waitForFunction(() => document.querySelector('#app').dataset.role === 'pending'); await page.waitForTimeout(500);
      assert.equal(await noticeOpen(page), false); assert.equal(fixture.calls.filter(call => call.path === '/api/updates').length, 0);
      fixture.role = role; await refresh(page);
    }
    await page.waitForFunction(() => document.querySelector('#update-notice').open);
    assert.ok((await page.locator('#update-notice-version').textContent()).includes(nextVersion));
    assert.equal(await page.locator('#update-notice-notes').textContent(), notes);
    assert.equal(await page.locator('#update-notice-notes img,#update-notice-notes script').count(), 0);
    assert.equal(await page.evaluate(() => window.__notesExecuted), undefined);
    await layout(page); await page.screenshot({ path: path.join(output, id + '-' + role + '-update-notice.png'), fullPage: true });
    await page.locator('#update-notice-later').tap(); assert.equal(await noticeOpen(page), false);
    const skipKey = 'codex-mobile.' + id + '.updates.dismissedVersion';
    assert.equal(await page.evaluate(key => localStorage.getItem(key), skipKey), null);
    await refresh(page); await page.waitForTimeout(500); assert.equal(await noticeOpen(page), false, 'Later suppresses repeated reminders during this page session');
    fixture.phase = 'reload after later'; await page.reload(); await page.waitForFunction(() => document.querySelector('#update-notice').open);
    await page.locator('#update-notice-skip').check(); await page.locator('#update-notice-later').tap();
    await page.waitForFunction(({ key, version }) => localStorage.getItem(key) === version, { key: skipKey, version: nextVersion });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), skipKey), nextVersion);
    fixture.phase = 'reload with explicit skip'; const beforeReload = fixture.calls.filter(call => call.path === '/api/updates').length;
    const updateRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/updates');
    await page.reload(); await page.waitForFunction(() => document.querySelector('#workspace:not(.hidden)')); await updateRead;
    await page.waitForTimeout(100); assert.ok(fixture.calls.filter(call => call.path === '/api/updates').length > beforeReload);
    assert.equal(await noticeOpen(page), false, 'Explicitly skipped version stays suppressed across reloads');

    fixture.phase = 'new version behind settings'; await page.locator('#settings-open').tap(); fixture.latest = secondVersion; await refresh(page); await page.waitForTimeout(500);
    assert.equal(await noticeOpen(page), false, 'Update reminder must not cover an existing settings dialog');
    await page.locator('#settings-close').tap(); await refresh(page);
    await page.waitForFunction(() => document.querySelector('#update-notice').open);
    assert.ok((await page.locator('#update-notice-version').textContent()).includes(secondVersion), 'A newer version bypasses the old skip choice');
    fixture.phase = 'view update'; await page.locator('#update-notice-view').tap();
    await page.waitForFunction(() => document.querySelector('#settings-dialog').open && document.querySelector('#settings-tab-about').getAttribute('aria-selected') === 'true');
    assert.equal(await noticeOpen(page), false);
    await page.waitForFunction(version => document.querySelector('#update-status').textContent.includes(version), secondVersion);
    assert.equal(await page.locator('#update-install').isDisabled(), role !== 'owner');
    assert.equal(await page.locator('#update-check').isDisabled(), role !== 'owner');
    assert.equal(await page.locator('#update-notes-body').textContent(), notes);
    if (role === 'owner') {
      fixture.phase = 'late failed update check'; const heldCheck = fixture.holdCheck = gate();
      await page.locator('#update-check').tap(); await waitForGate(heldCheck);
      fixture.role = 'pending'; await refresh(page);
      await page.waitForFunction(() => document.querySelector('#app').dataset.role === 'pending');
      const clearedStatus = await page.locator('#update-status').textContent();
      assert.equal(await page.locator('#update-notes-body').textContent(), '');
      heldCheck.release(); await page.waitForTimeout(400);
      assert.equal(await page.locator('#update-status').textContent(), clearedStatus, 'Old failed POST cannot restore a previous authorized update state');
      assert.equal(await page.locator('#update-notes-body').textContent(), '');
      assert.equal(await page.locator('#update-notes-box').isVisible(), false);
      assert.equal(await noticeOpen(page), false);
    }
    await page.locator('#settings-close').tap(); await context.close();

    // A late update response from an old identity cannot open a popup after pairing is revoked.
    fixture.phase = 'late old identity'; fixture.role = role; fixture.latest = thirdVersion; const held = fixture.holdUpdates = gate();
    const staleContext = await createContext(id, width), stalePage = await staleContext.newPage();
    stalePage.on('pageerror', error => pageErrors.push(error.message));
    await stalePage.goto(origin); await waitForGate(held);
    fixture.role = 'pending'; await refresh(stalePage);
    await stalePage.waitForFunction(() => document.querySelector('#app').dataset.role === 'pending');
    held.release(); await stalePage.waitForTimeout(600);
    assert.equal(await noticeOpen(stalePage), false, 'Late update response must be discarded after identity changes');
    assert.equal(await stalePage.evaluate(key => localStorage.getItem(key), skipKey), null);
    assert.deepEqual(pageErrors, []); await staleContext.close();
    results.push({ edition: id, role, width, notesPlainText: true, skipByVersion: true, laterUntilReload: true, modalDeferral: true, installRoleGuard: true, staleIdentityDiscarded: true, lateFailedPostDiscarded: role === 'owner', pageErrors });
    console.log('PASS update notice ' + id + ' ' + role + ' ' + width + 'px');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'update-notice-report.json'), JSON.stringify({ ok: true, results }, null, 2));
  console.log('Update notice regression passed: ' + path.join(output, 'update-notice-report.json'));
} catch (error) { console.error('Failed update fixture:', edition, fixture?.phase, fixture?.role); throw error; }
finally { for (const held of heldGates) held.release(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
