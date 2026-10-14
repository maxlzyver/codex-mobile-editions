// Mock desktop metadata only. This never opens or sends to a real user chat.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), edition = process.env.MOBILE_UI_EDITION || 'windows11';
assert.ok(['windows10', 'windows11', 'macos'].includes(edition));
const output = path.resolve(process.env.MOBILE_UI_OUTPUT || path.join(os.tmpdir(), `codex-v130-sections-${Date.now()}`));
await mkdir(output, { recursive: true });
const version = JSON.parse(await readFile(path.join(root, 'editions', edition, 'package.json'), 'utf8')).version;
const ref = (type, id, kind = 'codex') => ({ type, kind, id });
const chat = (id, title, projectId) => ({ id, title, projectId, status: 'idle', updatedAt: 1700000000000, messages: [{ id: id + '-answer', role: 'assistant', text: '模拟回复' }], capabilities: { send: true, modelSelection: true }, readOnly: false });
const project = (id, name, threadIds, kind = 'codex') => ({ id, name, kind, threadIds, capabilities: { createThread: kind === 'codex' } });
let fixture, holdNext = false;
const held = [], requests = [], errors = [], results = [];
function reset() {
  fixture = {
    role: 'controller',
    threads: [chat('child-a', '项目甲的聊天', 'shared'), chat('child-b', '项目乙的聊天', 'second'), chat('loose', '独立聊天', null), chat('removed', '已移出项目', 'second'), chat('unlisted', '未知项目的聊天', 'unknown'), { ...chat('archived', '归档聊天', 'shared'), archived: true }],
    gpt: [chat('child-a', 'GPT 项目的聊天', 'shared')],
    catalog: {
      available: true, complete: false,
      projects: [project('shared', '项目甲', ['child-a']), project('second', '项目乙', ['child-b', 'removed']), project('unassigned', '未分区项目', []), project('shared', 'GPT 项目', ['child-a'], 'chatgpt')],
      threadMemberships: [{ id: 'removed', kind: 'codex', projectId: null }],
      sections: [
        { id: 'pinned', type: 'pinned', name: 'Pinned', items: [] },
        { id: 'work', type: 'custom', name: '课程作业', items: [ref('project', 'second'), ref('thread', 'loose'), ref('project', 'shared'), ref('project', 'shared'), ref('thread', 'loose'), ref('project', 'shared', 'chatgpt')] },
        { id: 'empty', type: 'custom', name: '空分区 <img src=x onerror=alert(1)>', items: [] },
        { id: 'chats', type: 'threads', name: 'Tasks', items: [ref('thread', 'removed')] },
      ],
    },
  };
  requests.length = 0; holdNext = false; held.length = 0;
}
const json = (res, data, status = 200) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), p = url.pathname;
    requests.push(url.pathname + url.search);
    if (p === '/api/bootstrap') return json(res, { role: fixture.role, csrfToken: 'fixture-csrf', features: { desktopProjects: true, nativeGpt: true }, app: { version }, status: { mode: 'standalone', codex: 'connected' }, desktop: { connected: true }, permissions: { canManage: false } });
    if (p === '/api/desktop/projects') {
      const value = structuredClone(fixture.catalog);
      if (holdNext) { holdNext = false; held.push(() => json(res, value)); return; }
      return json(res, value);
    }
    if (p === '/api/threads') return json(res, { threads: fixture.threads });
    if (p === '/api/gpt/threads') return json(res, { available: true, threads: fixture.gpt, capabilities: { read: true, send: true } });
    if (/^\/api\/(?:gpt\/)?threads\/[^/]+$/.test(p)) {
      const thread = (p.includes('/gpt/') ? fixture.gpt : fixture.threads).find(item => item.id === p.split('/').at(-1));
      return json(res, { thread, approvals: [], revision: 'fixture', page: { hasMore: false } });
    }
    if (p === '/api/projects') return json(res, { projects: [] });
    if (p === '/api/models') return json(res, { models: [] });
    if (p === '/api/updates') return json(res, { status: 'upToDate', hasUpdate: false, currentVersion: version });
    if (p === '/api/permissions') return json(res, { canManage: false });
    if (p.startsWith('/api/')) { errors.push('Unexpected ' + req.method + ' ' + p); return json(res, {}, 404); }
    const name = p === '/' ? 'index.html' : p.slice(1);
    assert.ok(!name.includes('..') && !name.includes('\\'));
    const bytes = await readFile(path.join(root, 'editions', edition, 'public', name));
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream' }); res.end(bytes);
  } catch (error) { errors.push(error.stack); json(res, {}, 500); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const section = (page, id) => page.locator(`.sidebar-section[data-section-id="${id}"]`);
const projectNode = (page, id) => page.locator(`.sidebar-project[data-project-id="${id}"]`);
const waitForHeld = async () => { const end = Date.now() + 5000; while (!held.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(held.length, 1); };
try {
  for (const width of [390, 320]) {
    reset();
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ edition, version, width }) => {
      localStorage.setItem(`codex-mobile.${edition}.notice.lastVersion`, version);
      localStorage.setItem(`codex-mobile.${edition}.appearance.v1`, JSON.stringify({ theme: width === 320 ? 'dark' : 'blue', font: 'system', size: 22 }));
    }, { edition, version, width });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (!req.url().startsWith(origin) && !req.url().startsWith('data:')) errors.push('External request ' + req.url()); });
    await page.goto(origin); await page.waitForSelector('.sidebar-section');
    await page.locator('#sidebar-open').tap();
    await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().x >= 0);
    assert.deepEqual(await page.locator('.sidebar-section').evaluateAll(nodes => nodes.map(node => node.dataset.sectionId)), ['work', 'empty', 'chats']);
    assert.deepEqual(await section(page, 'work').locator(':scope > .sidebar-section-items > details, :scope > .sidebar-section-items > button').evaluateAll(nodes => nodes.map(node => node.dataset.projectId || node.dataset.threadId)), ['second', 'loose', 'shared']);
    assert.equal(await page.locator('.thread-item').count(), 5);
    assert.equal(await page.locator('.thread-item[data-thread-id="removed"]').count(), 1);
    assert.equal(await projectNode(page, 'second').locator('[data-thread-id="removed"]').count(), 0);
    assert.equal(await page.locator('[data-thread-id="archived"]').count(), 0);
    assert.equal(await projectNode(page, 'unassigned').count(), 1);
    assert.equal(await section(page, 'empty').locator('img').count(), 0);
    assert.match(await section(page, 'empty').textContent(), /暂无可显示/);
    const dimensions = await page.locator('.sidebar').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
    await page.screenshot({ path: path.join(output, `${edition}-${width}-sections.png`), fullPage: true, animations: 'disabled' });

    await projectNode(page, 'shared').locator('summary').tap();
    await section(page, 'work').locator(':scope > summary').tap();
    await page.waitForFunction(() => !document.querySelector('[data-section-id="work"]').open);
    await page.locator('#refresh-threads').tap();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('任务列表已刷新'));
    assert(requests.includes('/api/desktop/projects?refresh=true'));
    assert.equal(await section(page, 'work').getAttribute('open'), null);
    await page.reload(); await page.waitForSelector('.sidebar-section');
    assert.equal(await section(page, 'work').getAttribute('open'), null);
    assert.equal(await projectNode(page, 'shared').getAttribute('open'), null);

    await page.locator('#chat-mode-gpt').tap();
    await page.waitForFunction(() => document.querySelector('[data-project-id="shared"] .thread-item')?.textContent.includes('GPT'));
    assert.notEqual(await section(page, 'work').getAttribute('open'), null);
    assert.notEqual(await projectNode(page, 'shared').getAttribute('open'), null);
    assert.equal(await page.locator('.sidebar-project').count(), 1);
    assert.equal(await page.locator('.thread-item').count(), 1);
    await page.locator('#chat-mode-codex').tap();
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-project').length === 3);
    assert.equal(await section(page, 'work').getAttribute('open'), null);
    await page.locator('#sidebar-open').tap();
    await section(page, 'work').locator(':scope > summary').tap();
    await projectNode(page, 'shared').locator('summary').tap();
    await page.locator('[data-thread-id="child-a"]').tap();
    await page.waitForFunction(() => document.querySelector('#thread-title').textContent === '项目甲的聊天');
    await page.locator('#sidebar-open').tap();
    assert.equal(await page.locator('.thread-item.active').getAttribute('data-thread-id'), 'child-a');

    // Two overlapping refreshes: the late older catalog must not undo the move.
    holdNext = true; await page.locator('#refresh-threads').tap(); await waitForHeld();
    fixture.catalog.sections[1] = { id: 'work', type: 'custom', name: '调整之后', items: [ref('project', 'shared'), ref('project', 'second')] };
    await page.locator('#refresh-threads').tap();
    await page.waitForFunction(() => document.querySelector('[data-section-id="work"] > summary').textContent === '调整之后');
    held.shift()();
    await page.waitForTimeout(100);
    assert.equal(await section(page, 'work').locator(':scope > summary').textContent(), '调整之后');
    assert.deepEqual(await section(page, 'work').locator('.sidebar-project').evaluateAll(nodes => nodes.map(node => node.dataset.projectId)), ['shared', 'second']);
    assert.equal(await page.locator('[data-thread-id="loose"]').count(), 1);

    // A disconnected catalog degrades to the original chat list; it can recover.
    const catalog = fixture.catalog;
    fixture.catalog = { available: false, projects: [], sections: [], hint: '模拟桌面断开' };
    await page.locator('#refresh-threads').tap(); await page.waitForFunction(() => !document.querySelector('.sidebar-section'));
    assert.equal(await page.locator('.thread-item').count(), 5);
    fixture.catalog = catalog;
    await page.locator('#refresh-threads').tap(); await page.waitForSelector('.sidebar-section');

    // An explicitly pinned project child is shown once, in its direct section.
    fixture.catalog.sections[0].items = [ref('thread', 'child-a')];
    await page.locator('#refresh-threads').tap(); await page.waitForSelector('[data-section-id="pinned"]');
    assert.equal(await section(page, 'pinned').locator('[data-thread-id="child-a"]').count(), 1);
    assert.equal(await projectNode(page, 'shared').locator('[data-thread-id="child-a"]').count(), 0);
    assert.equal(await page.locator('[data-thread-id="child-a"]').count(), 1);

    // Revocation clears private sidebar metadata and rejects a late response.
    holdNext = true; await page.locator('#refresh-threads').tap(); await waitForHeld();
    fixture.role = 'anonymous';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.querySelector('#app').dataset.role === 'anonymous');
    held.shift()(); await page.waitForTimeout(100);
    assert.equal(await page.locator('#thread-list').textContent(), '');
    results.push({ width, checks: 'section order, mixed members, identity, folding, refresh, stale reads, disconnect, revocation', passed: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ edition, results }, null, 2));
  console.log(JSON.stringify({ edition, results, output }));
} finally {
  for (const release of held) release();
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
