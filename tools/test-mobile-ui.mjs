// Mock-only browser regression: no Codex process, login, or real task is used.
// npm install --prefix <external-dir> playwright
// PLAYWRIGHT_MODULE=<external-dir>/node_modules/playwright [CHROME_PATH=...] node tools/test-mobile-ui.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.MOBILE_UI_OUTPUT || path.join(os.tmpdir(), `codex-mobile-ui-${Date.now()}`));
const editions = (process.env.MOBILE_UI_EDITIONS || 'windows10,windows11,macos').split(',');
assert.ok(editions.every(id => ['windows10', 'windows11', 'macos'].includes(id)), 'Unknown edition');
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const malicious = '<img src=x onerror="window.__messageMarkupRan=true"><script>window.__messageMarkupRan=true</script>';
const model = { model: 'mock-model', displayName: 'Mock model', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '中等' }] };
let currentEdition, fixtures;
const unexpected = [], results = [];

function makeThread(id, label) {
  const turnId = `turn-${id}`;
  return {
    id, title: `模拟任务 ${label}`, status: 'running', cwd: '/mock/project', native: true,
    model: model.model, effort: 'medium', readOnly: false,
    capabilities: { send: true, stop: false, modelSelection: true, approvals: false },
    messages: [
      { id: 'user-instruction', role: 'user', text: '请展示公开的过程和最终答复。', delivery: 'sent' },
      { id: 'process-shared', role: 'assistant', phase: 'commentary', type: 'agentMessage', turnId, text: `公开过程 ${label} ${malicious}\n${'long-unbroken-text'.repeat(12)}` },
      { role: 'assistant', phase: 'commentary', type: 'agentMessage', turnId, text: `无 ID 的公开过程 ${label}` },
      { role: 'tool', type: 'commandExecution', turnId, text: `执行日志 ${label}`, title: '执行记录' },
      { id: 'final-answer', role: 'assistant', phase: 'final_answer', turnId, text: `最终答复 ${label}：始终可见。${malicious}` },
      { id: 'legacy-answer', role: 'assistant', text: `兼容答复 ${label}：没有 phase 也正常显示。` },
      ...['sending', 'failed', 'uncertain'].map(delivery => ({ id: `user-${delivery}`, role: 'user', delivery, text: `模拟发送状态 ${delivery}` })),
    ],
  };
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  try {
    if (request.method !== 'GET') {
      unexpected.push(`${request.method} ${pathname}`);
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'This browser fixture is read-only.' }));
      return;
    }
    if (pathname.startsWith('/api/')) {
      let data;
      if (pathname === '/api/bootstrap') data = { role: 'controller', csrfToken: 'mock-only', status: { codex: 'connected', mode: 'standalone', hostname: '模拟电脑' }, desktop: { connected: true }, app: { version: '1.0.0' } };
      else if (pathname === '/api/threads') data = { threads: Object.values(fixtures).map(({ messages, ...thread }) => thread) };
      else if (pathname.startsWith('/api/threads/')) data = { thread: fixtures[decodeURIComponent(pathname.split('/').at(-1))], approvals: [] };
      else if (pathname === '/api/models') data = { models: [model] };
      else if (pathname === '/api/projects') data = { projects: [{ id: 'project-mock', name: '模拟项目', path: '/mock/project' }] };
      else if (pathname === '/api/updates') data = { status: 'upToDate', currentVersion: '1.0.0', latestVersion: '1.0.0', autoUpdate: false };
      else { unexpected.push(`GET ${pathname}`); data = {}; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(data));
      return;
    }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    assert.ok(!name.includes('..') && !name.includes('\\'));
    const body = await readFile(path.join(repository, 'editions', currentEdition, 'public', name));
    response.writeHead(200, { 'content-type': mime[path.extname(name)] || 'application/octet-stream', 'Content-Security-Policy': csp });
    response.end(body);
  } catch (error) {
    unexpected.push(error.message);
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Fixture failed');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
} catch (error) {
  await new Promise(resolve => server.close(resolve));
  throw error;
}

async function openThread(page, label) {
  await page.locator('#sidebar-open').tap();
  await page.locator('.thread-item').filter({ has: page.locator('.thread-item-title', { hasText: `模拟任务 ${label}` }) }).tap();
  await page.waitForFunction(value => document.querySelector('#thread-title').textContent === `模拟任务 ${value}` && document.querySelector('#messages').textContent.includes(`最终答复 ${value}`), label);
}
async function assertOpen(locator, expected) {
  await locator.waitFor();
  assert.equal(await locator.evaluate(element => element.open), expected, `Disclosure should be ${expected ? 'open' : 'closed'}`);
}
async function toggle(locator) {
  const wasOpen = await locator.evaluate(element => element.open);
  await locator.locator('summary').tap();
  await locator.page().waitForFunction(({ key, expected }) => [...document.querySelectorAll('#messages details')].find(element => element.dataset.disclosureKey === key)?.open === expected, { key: await locator.getAttribute('data-disclosure-key'), expected: !wasOpen });
}
async function assertFinalAndText(page, label) {
  assert.equal(await page.locator('.message-process').count(), 2);
  assert.equal(await page.locator('.message.assistant:not(:has(details))').count(), 2);
  assert.ok(await page.getByText(`最终答复 ${label}：始终可见。${malicious}`, { exact: true }).isVisible());
  assert.ok(await page.getByText(`兼容答复 ${label}：没有 phase 也正常显示。`, { exact: true }).isVisible());
  assert.equal(await page.locator('#messages img, #messages script').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__messageMarkupRan)), false);
}
async function checkLayout(page) {
  const bounds = await page.evaluate(() => {
    const areas = ['#conversation-scroll', '#messages', '.message-process'];
    return { width: innerWidth, document: document.documentElement.scrollWidth, areas: areas.flatMap(selector => [...document.querySelectorAll(selector)].map(element => ({ selector, width: element.clientWidth, scroll: element.scrollWidth }))), taps: [...document.querySelectorAll('.message-disclosure > summary')].map(element => element.getBoundingClientRect().height) };
  });
  assert.ok(bounds.document <= bounds.width, JSON.stringify(bounds));
  assert.ok(bounds.areas.every(area => area.scroll <= area.width + 1), JSON.stringify(bounds));
  assert.ok(bounds.taps.every(height => height >= 44), JSON.stringify(bounds));
  return bounds;
}

try {
  for (const edition of editions) for (const width of [320, 390]) {
    currentEdition = edition;
    fixtures = { 'thread-a': makeThread('thread-a', 'A'), 'thread-b': makeThread('thread-b', 'B') };
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await context.addInitScript(id => localStorage.setItem(`codex-mobile.${id}.appearance.v1`, JSON.stringify({ theme: 'blue', font: 'system', size: 22 })), edition);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin);
    await page.waitForSelector('#workspace:not(.hidden)');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '22px');
    await openThread(page, 'A');
    const process = page.locator('#messages details[data-message-id="process-shared"]');
    const anonymous = page.locator('#messages .message-process').nth(1);
    const tool = page.locator('#messages .message.tool details');
    await assertOpen(process, false);
    await assertOpen(anonymous, false);
    assert.equal(await process.locator('summary').textContent(), '思考与过程');
    await assertFinalAndText(page, 'A');
    for (const [status, text] of Object.entries({ sent: '已发送', sending: '发送中…', failed: '发送失败', uncertain: '结果未确认' })) assert.equal(await page.locator(`.message-delivery[data-status="${status}"]`).textContent(), text);

    await toggle(process);
    await toggle(anonymous);
    await toggle(tool);
    const keys = await page.locator('#messages details').evaluateAll(elements => elements.map(element => element.dataset.disclosureKey));
    fixtures['thread-a'].messages[1].text += '\n实时刷新第一段';
    fixtures['thread-a'].messages[2].text += '\n匿名消息追加内容';
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('实时刷新第一段'), null, { timeout: 7000 });
    await assertOpen(process, true);
    await assertOpen(anonymous, true);
    await assertOpen(tool, true);
    assert.deepEqual(await page.locator('#messages details').evaluateAll(elements => elements.map(element => element.dataset.disclosureKey)), keys);
    await assertFinalAndText(page, 'A');
    const layout = await checkLayout(page);
    await process.locator('summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${edition}-${width}-expanded.png`), fullPage: true });

    await toggle(process);
    fixtures['thread-a'].messages[1].text += '\n实时刷新第二段';
    fixtures['thread-a'].status = 'idle';
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('实时刷新第二段'), null, { timeout: 7000 });
    await assertOpen(process, false);
    await assertOpen(anonymous, true);
    await openThread(page, 'B');
    await assertOpen(process, false);
    await assertOpen(anonymous, false);
    await assertOpen(tool, false);
    await toggle(process);
    await openThread(page, 'A');
    await assertOpen(process, false);
    await assertOpen(anonymous, true);
    await assertOpen(tool, true);
    await assertFinalAndText(page, 'A');
    await openThread(page, 'B');
    await assertOpen(process, true);
    await assertOpen(anonymous, false);
    await assertFinalAndText(page, 'B');
    await checkLayout(page);
    await toggle(process);
    fixtures['thread-b'].messages[1].phase = 'final_answer';
    fixtures['thread-b'].messages[1].text = '过程消息转为最终答复后必须可见。';
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('过程消息转为最终答复后必须可见。'), null, { timeout: 7000 });
    assert.equal(await page.locator('#messages .message-process').count(), 1);
    const promotedFinal = page.getByText('过程消息转为最终答复后必须可见。', { exact: true });
    assert.ok(await promotedFinal.isVisible());
    assert.equal(await promotedFinal.evaluate(element => element.closest('details')), null);
    assert.deepEqual(errors, [], 'No browser or CSP errors');
    results.push({ edition, width, fontSize: 22, pollingPreservesOpenAndClosed: true, perThreadState: true, anonymousMessageStable: true, finalAnswersVisible: true, commentaryPromotedToFinalVisible: true, textOnly: true, deliveryLabels: true, layout, errors });
    await context.close();
    console.log(`PASS ${edition} ${width}px / 22px`);
  }
  assert.deepEqual(unexpected, [], 'Only expected mock reads were requested');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, results }, null, 2));
  console.log(`Mobile UI mock checks passed. Report: ${path.join(output, 'report.json')}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
