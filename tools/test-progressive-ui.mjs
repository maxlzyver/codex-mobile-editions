// Mock HTTP only. No desktop Codex, login, or real task is read or started.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.MOBILE_UI_OUTPUT || path.join(os.tmpdir(), `codex-progressive-${Date.now()}`));
const edition = process.env.MOBILE_UI_EDITION || 'windows11';
assert.ok(['windows10', 'windows11', 'macos'].includes(edition));
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const permissions = { canManage: false, allowMobileApprovals: false, allowMobileStop: false, allowOtherFiles: false };
const projectId = 'a'.repeat(24), reference = '输出/结果 报告.txt';
const attacks = '<img src=x onerror="window.__injected=true"><script>window.__injected=true</script>';
let fixtures, reads, held, hold, role, failNextPost;
const unexpected = [], results = [];
function thread(id, progressive = true) {
  return { id, title: `模拟聊天 ${id}`, cwd: '/mock/project', status: 'idle', native: true,
    readOnly: false, revisionNumber: 1, progressive,
    capabilities: { send: true, stop: false, approvals: false },
    messages: [
      { id: `${id}-u`, role: 'user', turnId: `${id}-turn`, text: `我的提问 ${id}` },
      { id: `${id}-c`, role: 'assistant', phase: 'commentary', turnId: `${id}-turn`, text: `公开过程 ${id}\n${attacks}\n[报告](<${reference}>)` },
      { id: `${id}-t`, role: 'tool', title: '命令执行', turnId: `${id}-turn`, text: `工具输出 ${id} v1\n${'模拟长执行输出\n'.repeat(5000)}` },
      { id: `${id}-f`, role: 'assistant', phase: 'final_answer', turnId: `${id}-turn`, text: `最终结果 ${id} v1` },
    ] };
}
function reset() {
  fixtures = Object.fromEntries('ABCDEFGHIJK'.split('').map(id => [id, thread(id)]));
  fixtures.OLD = thread('OLD', false);
  reads = []; held = []; hold = new Set(); role = 'controller'; failNextPost = false;
}
function json(response, data, status = 200) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(data));
}
function release(key) {
  hold.delete(key);
  for (const item of held.filter(item => item.key === key)) json(item.response, item.data);
  held = held.filter(item => item.key !== key);
}
function payload(id, stage, since) {
  const source = structuredClone(fixtures[id]), rev = String(source.revisionNumber);
  delete source.revisionNumber;
  if (!source.progressive) { delete source.progressive; return { thread: source, approvals: [] }; }
  delete source.progressive;
  const revision = `${id}:${stage}:${rev}`;
  if (since === revision) return { unchanged: true, revision, detailsRevision: `${id}:details:${rev}` };
  if (stage === 'recent') source.messages = source.messages.map(message => message.phase === 'commentary' || message.role === 'tool'
    ? { ...message, text: message.role === 'tool' ? '命令执行' : '思考与过程', deferred: true } : message);
  else source.messages = [...(source.history || []), ...source.messages];
  delete source.history;
  source.loadingStage = stage; source.detailsRevision = `${id}:details:${rev}`;
  return { thread: source, approvals: [], revision };
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost'), pathname = url.pathname;
    if (request.method === 'POST' && pathname === '/api/threads/A/messages' && failNextPost) {
      failNextPost = false; request.resume(); json(response, { error: '模拟发送失败，测试自动恢复同步。' }, 500); return;
    }
    if (request.method !== 'GET') { unexpected.push(`${request.method} ${pathname}`); json(response, {}, 405); return; }
    if (pathname.startsWith('/api/')) {
      reads.push({ path: pathname, stage: url.searchParams.get('stage'), since: url.searchParams.get('since'), time: Date.now() });
      let data;
      if (pathname === '/api/bootstrap') data = { role, csrfToken: 'mock-only', permissions, app: { version: '1.0.1' }, status: { codex: 'connected', mode: 'standalone', hostname: '模拟电脑' }, desktop: { connected: true } };
      else if (pathname === '/api/threads') data = { threads: Object.values(fixtures).map(({ messages, progressive, revisionNumber, ...item }) => item) };
      else if (pathname.startsWith('/api/threads/')) {
        const id = decodeURIComponent(pathname.split('/').at(-1)), stage = url.searchParams.get('stage') || 'full';
        assert.ok(fixtures[id]); data = payload(id, stage, url.searchParams.get('since'));
        const key = `${id}:${stage}`;
        if (hold.has(key)) { held.push({ key, response, data }); return; }
      } else if (pathname === '/api/projects') data = { projects: [{ id: projectId, name: '模拟项目', path: '/mock/project', exists: true }] };
      else if (pathname === '/api/models') data = { models: [{ model: 'mock', displayName: 'Mock model', supportedReasoningEfforts: [] }] };
      else if (pathname === '/api/permissions') data = permissions;
      else if (pathname === '/api/updates') data = { status: 'upToDate', currentVersion: '1.0.1', latestVersion: '1.0.1' };
      else if (pathname === `/api/projects/${projectId}/resolve`) { assert.equal(url.searchParams.get('reference'), reference); data = { projectId, path: reference, name: '结果 报告.txt', mime: 'text/plain', size: 100 }; }
      else if (pathname === `/api/projects/${projectId}/preview`) data = { name: '结果 报告.txt', text: '预览成功 ' + attacks };
      else { unexpected.push(pathname); json(response, {}, 404); return; }
      json(response, data); return;
    }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    assert.ok(!name.includes('..') && !name.includes('\\'));
    const body = await readFile(path.join(root, 'editions', edition, 'public', name));
    response.writeHead(200, { 'content-type': mime[path.extname(name)] || 'application/octet-stream', 'Content-Security-Policy': csp }); response.end(body);
  } catch (error) { unexpected.push(error.stack); json(response, { error: 'Mock error' }, 500); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(predicate(), message);
};
const tick = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const group = page => page.locator('#messages > .process-disclosure').first();
const finalNode = (page, id) => page.locator(`#messages > article[data-message-id="${id}-f"]`);
async function open(page, id, wait = true) {
  await page.locator('#sidebar-open').tap();
  await page.locator('.thread-item').filter({ has: page.locator('.thread-item-title', { hasText: new RegExp(`^模拟聊天 ${id}$`) }) }).tap();
  if (wait) await finalNode(page, id).waitFor();
}
async function setup(width) {
  reset();
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await context.addInitScript(({ edition }) => {
    localStorage.setItem(`codex-mobile.${edition}.notice.lastVersion`, '1.0.1');
    localStorage.setItem('codex-mobile.notice.lastVersion', '1.0.1');
  }, { edition });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
  await page.goto(origin);
  await page.waitForSelector('.thread-item');
  // The old welcome announcement is a product feature, not part of this performance fixture.
  await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); document.documentElement.style.fontSize = '22px'; });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '22px');
  return { context, page, errors };
}

try {
  for (const width of [390, 320]) {
    const { context, page, errors } = await setup(width);
    try {
      fixtures.A.history = [
        { id: 'history-u', role: 'user', turnId: 'history', text: '保存历史中的旧提问' },
        { id: 'history-f', role: 'assistant', phase: 'final_answer', turnId: 'history', text: '保存历史中的旧答复' },
      ];
      hold.add('A:full');
      await open(page, 'A');
      assert.match(await finalNode(page, 'A').textContent(), /最终结果 A v1/);
      assert.equal(await page.locator('[data-message-id="history-u"]').count(), 0, 'Initial recent view does not wait for saved history');
      await page.evaluate(() => { window.__initialUserNode = document.querySelector('[data-message-id="A-u"]'); });
      assert.equal(await group(page).locator('.process-content *').count(), 0, 'Closed process must not construct hidden rows');
      await waitFor(() => held.some(item => item.key === 'A:full'), 'Details must preload after first paint');
      fixtures.A.messages.at(-1).text = '最终结果 A v2'; fixtures.A.revisionNumber = 2;
      await tick(page);
      await page.waitForFunction(() => document.querySelector('[data-message-id="A-f"]')?.textContent.includes('v2'));
      release('A:full');
      await page.locator('[data-message-id="history-u"]').waitFor();
      assert.match(await finalNode(page, 'A').textContent(), /v2/, 'Older full response cannot roll back the newer result');
      assert.deepEqual(await page.locator('#messages > article').evaluateAll(nodes => nodes.map(node => node.dataset.messageId)), ['history-u', 'history-f', 'A-u', 'A-f'], 'Older history is inserted in chronological order');
      assert.equal(await page.evaluate(() => window.__initialUserNode === document.querySelector('[data-message-id="A-u"]')), true, 'Adding old history preserves recent message nodes');
      assert.equal(await group(page).locator('.process-content *').count(), 0, 'Preloaded details remain outside DOM until expanded');
      await group(page).locator(':scope > summary').tap();
      await page.waitForFunction(() => document.querySelector('.process-content')?.textContent.includes('公开过程 A'));
      assert.equal(await group(page).locator('.message.tool .message-content').count(), 0, 'Tool output is independently lazy');
      await group(page).locator('.message-disclosure > summary').tap();
      await page.waitForFunction(() => document.querySelector('.message.tool .message-content')?.textContent.includes('工具输出 A'));
      await group(page).getByRole('button', { name: '报告', exact: true }).tap();
      await page.waitForSelector('#preview-dialog[open]');
      assert.match(await page.locator('#preview-content').textContent(), /预览成功/);
      const download = new URL(await page.locator('#preview-download').getAttribute('href'), origin);
      assert.equal(download.searchParams.get('path'), reference);
      assert.equal(await page.locator('#preview-content script, #messages script, #messages img').count(), 0);
      await page.locator('#preview-close').tap();
      await group(page).locator(':scope > summary').tap();
      await page.waitForFunction(() => document.querySelector('.process-content')?.childElementCount === 0);
      await page.evaluate(() => { window.__userNode = document.querySelector('[data-message-id="A-u"]'); window.__finalNode = document.querySelector('[data-message-id="A-f"]'); window.__groupNode = document.querySelector('.process-disclosure'); });
      const sinceCount = reads.filter(item => item.path === '/api/threads/A' && item.since).length;
      await tick(page);
      await waitFor(() => reads.filter(item => item.path === '/api/threads/A' && item.since).length > sinceCount, 'Polling sends same-stage revisions');
      await page.waitForTimeout(70);
      assert.equal(await page.evaluate(() => window.__userNode === document.querySelector('[data-message-id="A-u"]') && window.__finalNode === document.querySelector('[data-message-id="A-f"]') && window.__groupNode === document.querySelector('.process-disclosure')), true, 'Unchanged response preserves node identity');
      fixtures.A.messages.at(-1).text = '最终结果 A v3'; fixtures.A.revisionNumber = 3;
      await tick(page); await page.waitForFunction(() => document.querySelector('[data-message-id="A-f"]')?.textContent.includes('v3'));
      assert.equal(await page.evaluate(() => window.__userNode === document.querySelector('[data-message-id="A-u"]') && window.__groupNode === document.querySelector('.process-disclosure') && window.__finalNode !== document.querySelector('[data-message-id="A-f"]')), true, 'Only the changed message is replaced');
      await open(page, 'B'); hold.add('A:recent');
      await open(page, 'A');
      assert.match(await finalNode(page, 'A').textContent(), /v3/, 'Visited snapshot is visible while fresh request is held');
      await waitFor(() => held.some(item => item.key === 'A:recent'), 'Fresh request remains pending');
      release('A:recent');
      await page.waitForTimeout(100);
      const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, injected: Boolean(window.__injected), persistent: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].some(key => /最终结果|工具输出/.test(localStorage.getItem(key) || sessionStorage.getItem(key) || '')) }));
      assert.ok(layout.width <= layout.viewport, JSON.stringify(layout)); assert.equal(layout.injected, false); assert.equal(layout.persistent, false, 'Transcript snapshots are not persisted');
      await page.screenshot({ path: path.join(output, `${edition}-${width}-recent.png`), fullPage: true });
      assert.deepEqual(errors, []);
      results.push({ width, cases: ['recent-before-details', 'late-full-preserves-new-answer', 'history-order-and-node-preservation', 'lazy-round-and-tool', 'file-preview-and-download', 'revision-and-node-reuse', 'changed-node-only', 'instant-memory-snapshot', 'safe-text-and-layout'], passed: true });
    } finally { for (const key of [...hold]) release(key); await context.close(); }
  }
  {
    const { context, page, errors } = await setup(390);
    try {
      await open(page, 'OLD');
      assert.equal(reads.some(item => item.path === '/api/threads/OLD' && item.stage === 'full'), false, 'Old full-only responses do not cause a second details fetch');
      for (const id of 'ABCDEFGHI') await open(page, id);
      hold.add('A:recent'); await open(page, 'A', false);
      assert.equal(await finalNode(page, 'A').count(), 0, 'Ninth visited chat evicts the oldest of eight cached snapshots');
      release('A:recent'); await finalNode(page, 'A').waitFor();
      await page.waitForTimeout(500);
      const before = reads.filter(item => item.path.startsWith('/api/threads')).length;
      await page.waitForTimeout(3700);
      assert.equal(reads.filter(item => item.path.startsWith('/api/threads')).length, before, 'Idle conversation/list do not use old 1.5s/5s polling');
      fixtures.A.status = 'running'; fixtures.A.revisionNumber++;
      await tick(page); await page.waitForTimeout(100);
      const running = reads.filter(item => item.path === '/api/threads/A' && item.stage === 'recent').length;
      await waitFor(() => reads.filter(item => item.path === '/api/threads/A' && item.stage === 'recent').length > running, 'Running chat continues frequent recent polling');
      hold.add('A:full'); fixtures.A.revisionNumber++; await tick(page);
      await group(page).locator(':scope > summary').tap();
      await waitFor(() => held.some(item => item.key === 'A:full'), 'Hold details before revocation');
      role = 'pending'; await tick(page); await page.waitForFunction(() => document.querySelector('#app').dataset.role === 'pending');
      release('A:full');
      assert.equal(await page.locator('#messages').textContent(), '', 'Revocation clears visible private records');
      role = 'controller'; await tick(page); await page.waitForSelector('.thread-item');
      hold.add('A:recent'); await open(page, 'A', false);
      assert.equal(await finalNode(page, 'A').count(), 0, 'Reauthorization does not reuse private snapshots');
      release('A:recent'); await finalNode(page, 'A').waitFor();
      failNextPost = true;
      await page.locator('#prompt').fill('模拟发送失败后继续同步'); await page.locator('#send').tap();
      await page.waitForSelector('.message-delivery[data-status="uncertain"]');
      fixtures.A.messages.at(-1).text = '发送失败后仍自动同步的新答复'; fixtures.A.revisionNumber++;
      await page.waitForFunction(() => document.querySelector('[data-message-id="A-f"]')?.textContent.includes('发送失败后仍自动同步'), null, { timeout: 6000 });
      assert.equal(failNextPost, false, 'The failed submission was attempted exactly once');
      assert.deepEqual(errors, []);
      results.push({ cases: ['legacy-envelope', 'bounded-cache', 'idle-and-running-cadence', 'revoke-drops-late-details-and-cache', 'failed-send-resumes-polling'], passed: true });
    } finally { for (const key of [...hold]) release(key); await context.close(); }
  }
  {
    const { context, page, errors } = await setup(390);
    try {
      const question = fixtures.A.messages[0], answer = fixtures.A.messages.at(-1);
      const tool = number => ({ id: `long-tool-${number}`, role: 'tool', title: `执行 ${number}`, turnId: 'A-turn', text: `记录 ${number}` });
      fixtures.A.messages = [question, answer, ...Array.from({ length: 398 }, (_, index) => tool(index))];
      hold.add('A:full'); await open(page, 'A');
      await waitFor(() => held.some(item => item.key === 'A:full'), 'Long round starts details preload');
      release('A:full');
      await group(page).locator(':scope > summary').tap();
      await page.waitForFunction(() => document.querySelectorAll('.process-content > .message.tool').length === 398);
      await group(page).locator(':scope > summary').tap();
      for (const advance of [1, 2]) {
        fixtures.A.messages = [question, answer, ...Array.from({ length: 398 }, (_, index) => tool(index + advance))];
        fixtures.A.revisionNumber++;
        hold.add('A:full');
        const before = reads.filter(item => item.path === '/api/threads/A' && item.stage === 'recent').length;
        await tick(page);
        await waitFor(() => reads.filter(item => item.path === '/api/threads/A' && item.stage === 'recent').length > before, 'Recent window advances');
        await group(page).locator(':scope > summary').tap();
        await page.waitForFunction(number => Boolean(document.querySelector(`article[data-message-id="long-tool-${number}"]`)), advance + 397);
        assert.deepEqual(await page.locator('#messages > article').evaluateAll(nodes => nodes.map(node => node.dataset.messageId)), ['A-u', 'A-f'], 'Recent merge retains the question and final answer');
        assert.equal(await group(page).locator('.process-content > .message.tool').count(), 398, 'Recent merge remains bounded to 400 total messages');
        assert.equal(await group(page).locator('.process-content > .message.tool').first().getAttribute('data-message-id'), `long-tool-${advance}`, 'Old process rows are evicted first');
        await waitFor(() => held.some(item => item.key === 'A:full'), 'Each advanced recent snapshot schedules full details');
        release('A:full');
        await page.waitForTimeout(100);
        assert.deepEqual(await page.locator('#messages > article').evaluateAll(nodes => nodes.map(node => node.dataset.messageId)), ['A-u', 'A-f'], 'Full merge also preserves primary messages');
        assert.equal(await group(page).locator('.process-content > .message.tool').count(), 398);
        await group(page).locator(':scope > summary').tap();
      }
      assert.deepEqual(errors, []);
      results.push({ cases: ['long-round-primary-retention', 'long-round-recent-full-window-bound'], passed: true });
    } finally { for (const key of [...hold]) release(key); await context.close(); }
  }
  assert.deepEqual(unexpected, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ edition, results, unexpected }, null, 2));
  console.log(JSON.stringify({ ok: true, edition, groups: results.length, assertions: results.reduce((sum, result) => sum + result.cases.length, 0), output }));
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
