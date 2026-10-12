// Mock-only browser regression: no Codex process, login, or real task is used.
// PLAYWRIGHT_MODULE=<external-dir>/node_modules/playwright [CHROME_PATH=...] node tools/test-mobile-ui.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.MOBILE_UI_OUTPUT || path.join(os.tmpdir(), `codex-mobile-ui-${Date.now()}`));
const editions = (process.env.MOBILE_UI_EDITIONS || 'windows10,windows11,macos').split(',');
assert.ok(editions.every(id => ['windows10', 'windows11', 'macos'].includes(id)), 'Unknown edition');
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const malicious = '<img src=x onerror="window.__messageMarkupRan=true"><script>window.__messageMarkupRan=true</script>';
const model = { model: 'mock-model', displayName: 'Mock model', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '中等' }] };
const projectId = 'a'.repeat(24), reference = '输出/过程 报告.txt';
const previewText = '过程文件预览\n<script>window.__previewMarkupRan=true</script>';
const permissions = { allowMobileStop: false, allowMobileApprovals: false };
let currentEdition, fixtures;
const unexpected = [], reads = [], results = [];

function makeThread(id, label, native) {
  const text = (name, extra = '') => `${name} ${label}${extra}`;
  // CLI records need only role/phase/turnId. Native records can retain type too.
  const assistant = (id, turnId, phase, content) => ({ id, role: 'assistant', turnId, phase, text: content, ...(native ? { type: 'agentMessage' } : {}) });
  const tool = (id, turnId, type, content) => ({ id, role: 'tool', turnId, text: content, title: type === 'fileChange' ? '文件修改' : '执行记录', ...(native ? { type } : {}) });
  return {
    id, title: `模拟任务 ${label}`, status: 'idle', cwd: '/mock/project', native,
    source: native ? 'desktop' : 'companion', model: model.model, effort: 'medium', readOnly: false,
    capabilities: { send: true, stop: !native, modelSelection: true, effortSelection: true, approvals: !native },
    messages: [
      { id: 'user-one', turnId: 'turn-one', role: 'user', text: text('第一轮指令'), delivery: 'sent' },
      assistant('process-one', 'turn-one', 'commentary', text('公开过程一', ` ${malicious}\n${'long-unbroken-text'.repeat(12)}`)),
      tool('command-one', 'turn-one', 'commandExecution', text('第一条命令', '\nnode --test')),
      { id: 'user-steer', turnId: 'turn-one', role: 'user', text: text('同轮补充指令') },
      assistant('process-two', 'turn-one', 'commentary', text('公开过程二', `\n[过程报告](<${reference}>)`)),
      tool('file-one', 'turn-one', 'fileChange', text('文件修改内容', `\n[工具报告](<${reference}>)\n+ ${malicious}`)),
      tool('command-two', 'turn-one', 'commandExecution', text('第二条命令', '\n全部测试通过')),
      assistant('final-one', 'turn-one', 'final_answer', text('最终答复一', `：始终可见。${malicious}`)),
      { id: 'user-two', turnId: 'turn-two', role: 'user', text: text('第二轮指令') },
      tool('tool-only-one', 'turn-two', 'commandExecution', text('纯工具轮命令')),
      tool('tool-only-two', 'turn-two', 'webSearch', text('纯工具轮搜索记录')),
      assistant('final-two', 'turn-two', 'final_answer', text('最终答复二', '：工具独占轮也独立成组。')),
      { id: 'legacy-user-one', role: 'user', text: text('旧历史第一轮指令') },
      assistant('legacy-process', null, 'commentary', text('旧历史公开过程')),
      tool('legacy-tool', null, 'commandExecution', text('旧历史执行日志')),
      assistant('legacy-final', null, 'final_answer', text('旧历史最终答复')),
      { id: 'legacy-user-two', role: 'user', text: text('旧历史第二轮指令') },
      assistant(undefined, null, 'commentary', text('无 ID 公开过程')),
      tool(undefined, null, 'fileChange', text('无 ID 文件修改')),
      assistant('legacy-answer', null, undefined, text('兼容答复', '：没有 phase 也正常显示。')),
      ...['sending', 'failed', 'uncertain'].map(delivery => ({ id: `user-${delivery}`, role: 'user', delivery, text: `模拟发送状态 ${delivery}` })),
    ],
  };
}
function makeSplitThread() {
  return { ...makeThread('thread-c', 'C', true), messages: [
    { id: 'split-user', role: 'user', text: '轮次稍后补齐的指令 C' },
    { id: 'split-commentary', role: 'assistant', phase: 'commentary', text: '未分轮公开过程 C' },
    { id: 'split-tool', role: 'tool', text: '未分轮工具记录 C', durationMs: 19000 },
    { id: 'hidden-reasoning', type: 'reasoning', role: 'reasoning', text: 'PRIVATE_REASONING_SHOULD_NEVER_APPEAR', encryptedContent: 'PRIVATE_ENCRYPTED_VALUE' },
    { id: 'hidden-analysis', role: 'assistant', phase: 'analysis', text: 'PRIVATE_ANALYSIS_SHOULD_NEVER_APPEAR' },
    { id: 'split-final', role: 'assistant', phase: 'final_answer', text: '最终答复一 C：轮次补齐不隐藏最终答复。' },
  ] };
}
function json(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost'), pathname = url.pathname;
  try {
    if (request.method !== 'GET') { unexpected.push(`${request.method} ${pathname}`); json(response, 405, { error: 'This fixture is read-only.' }); return; }
    if (pathname.startsWith('/api/')) {
      reads.push({ pathname, query: Object.fromEntries(url.searchParams) });
      let data;
      if (pathname === '/api/bootstrap') data = { role: 'controller', csrfToken: 'mock-only', permissions, status: { codex: 'connected', mode: 'standalone', hostname: '模拟电脑' }, desktop: { connected: true }, app: { version: '1.0.1' } };
      else if (pathname === '/api/threads') data = { threads: Object.values(fixtures).map(({ messages, ...thread }) => thread) };
      else if (pathname.startsWith('/api/threads/')) { const thread = fixtures[decodeURIComponent(pathname.split('/').at(-1))]; assert.ok(thread, 'Only fixture threads can be read'); data = { thread, approvals: [] }; }
      else if (pathname === '/api/models') data = { models: [model] };
      else if (pathname === '/api/projects') data = { projects: [{ id: projectId, name: '模拟项目', path: '/mock/project', exists: true }] };
      else if (pathname === `/api/projects/${projectId}/resolve`) {
        assert.equal(url.searchParams.get('reference'), reference);
        data = { projectId, path: reference, name: '过程 报告.txt', mime: 'text/plain', size: Buffer.byteLength(previewText) };
      } else if (pathname === `/api/projects/${projectId}/preview`) {
        assert.equal(url.searchParams.get('path'), reference); data = { name: '过程 报告.txt', text: previewText };
      } else if (pathname === '/api/updates') data = { status: 'upToDate', currentVersion: '1.0.1', latestVersion: '1.0.1', autoUpdate: false };
      else if (pathname === '/api/permissions') data = permissions;
      else { unexpected.push(`GET ${pathname}`); json(response, 404, {}); return; }
      json(response, 200, data); return;
    }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    assert.ok(!name.includes('..') && !name.includes('\\'));
    const body = await readFile(path.join(repository, 'editions', currentEdition, 'public', name));
    response.writeHead(200, { 'content-type': mime[path.extname(name)] || 'application/octet-stream', 'Content-Security-Policy': csp });
    response.end(body);
  } catch (error) { unexpected.push(error.message); json(response, 500, { error: 'Fixture failed' }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try { browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) }); }
catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }

const processGroups = page => page.locator('#messages > details.process-disclosure');
const turnGroup = (page, id) => page.locator(`#messages > details.process-disclosure[data-turn-id="${id}"]`);
const legacyGroup = (page, label, anonymous = false) => processGroups(page).filter({ has: page.locator('.message-content', { hasText: `${anonymous ? '无 ID 公开过程' : '旧历史公开过程'} ${label}` }) });
async function openThread(page, label) {
  await page.locator('#sidebar-open').tap();
  await page.locator('.thread-item').filter({ has: page.locator('.thread-item-title', { hasText: `模拟任务 ${label}` }) }).tap();
  await page.waitForFunction(value => document.querySelector('#thread-title').textContent === `模拟任务 ${value}` && document.querySelector('#messages').textContent.includes(`最终答复一 ${value}`), label);
}
async function assertOpen(locator, expected) {
  assert.equal(await locator.count(), 1, 'Exactly one disclosure must exist for this group');
  assert.equal(await locator.evaluate(element => element.open), expected, `Disclosure should be ${expected ? 'open' : 'closed'}`);
}
async function toggle(locator) {
  const wasOpen = await locator.evaluate(element => element.open);
  await locator.locator(':scope > summary').tap();
  await locator.page().waitForFunction(({ key, expected }) => [...document.querySelectorAll('#messages details')].find(element => element.dataset.disclosureKey === key)?.open === expected, { key: await locator.getAttribute('data-disclosure-key'), expected: !wasOpen });
}
async function assertHiddenGroup(locator) {
  await assertOpen(locator, false);
  assert.ok(await locator.locator(':scope > summary').isVisible());
  for (const child of await locator.locator('.process-content .message, .process-content .message-avatar, .process-content .message-content, .process-content .message-name, .process-content summary, .process-content .message-file-link').all()) {
    assert.equal(await child.isVisible(), false, `Collapsed process row leaked: ${(await child.textContent()).slice(0, 90)}`);
  }
}
async function assertVisibleOutsideProcess(page, thread) {
  for (const item of thread.messages.filter(item => item.role === 'user' || (item.role === 'assistant' && item.phase !== 'commentary'))) {
    const content = page.locator(`#messages > article.message[data-message-id="${item.id}"] > .message-body > .message-content`);
    assert.equal(await content.count(), 1, `Top-level user/final missing: ${item.id}`);
    assert.equal(await content.textContent(), item.text);
    assert.ok(await content.isVisible(), `Top-level user/final hidden: ${item.id}`);
    assert.equal(await content.evaluate(element => Boolean(element.closest('details'))), false);
  }
  assert.equal(await page.locator('#messages img, #messages script').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__messageMarkupRan || window.__previewMarkupRan)), false);
}
async function assertStructure(page, label) {
  assert.equal(await processGroups(page).count(), 4, 'One process disclosure per explicit or legacy round');
  assert.equal(await page.locator('#messages > article.message.tool').count(), 0, 'Tool rows cannot remain outside the round disclosure');
  assert.equal(await page.locator('.process-disclosure .process-disclosure').count(), 0);
  assert.equal(await turnGroup(page, 'turn-one').locator('.process-content > article.message').count(), 5, 'Both commentary messages and all three command/file records share the round');
  assert.equal(await turnGroup(page, 'turn-two').locator('.process-content > article.message.tool').count(), 2, 'A tools-only round still has one disclosure');
  assert.equal(await turnGroup(page, 'turn-one').locator('article.message.user').count(), 0, 'Same-turn steering stays outside the process group');
  assert.equal(await legacyGroup(page, label).getAttribute('data-turn-id'), '');
  assert.equal(await legacyGroup(page, label, true).getAttribute('data-turn-id'), '');
  const keys = await processGroups(page).evaluateAll(elements => elements.map(element => ({ key: element.dataset.processKey, disclosure: element.dataset.disclosureKey })));
  assert.equal(new Set(keys.map(value => value.key)).size, 4);
  assert.ok(keys.every(value => value.key && value.disclosure && !value.key.includes('公开过程') && !value.key.includes('long-unbroken')));
  for (const group of await processGroups(page).all()) {
    assert.equal(await group.locator(':scope > summary.process-summary').count(), 1);
    assert.match(await group.locator(':scope > summary').textContent(), /思考与过程/);
  }
}
async function checkLayout(page) {
  const bounds = await page.evaluate(() => {
    const areas = ['#conversation-scroll', '#messages', '.process-disclosure', '.process-content', '.message-content'];
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    return { width: innerWidth, document: document.documentElement.scrollWidth,
      areas: areas.flatMap(selector => [...document.querySelectorAll(selector)].filter(visible).map(element => ({ selector, width: element.clientWidth, scroll: element.scrollWidth }))),
      taps: [...document.querySelectorAll('.process-disclosure > summary, .message-disclosure > summary')].filter(visible).map(element => element.getBoundingClientRect().height) };
  });
  assert.ok(bounds.document <= bounds.width, JSON.stringify(bounds));
  assert.ok(bounds.areas.every(area => area.scroll <= area.width + 1), JSON.stringify(bounds));
  assert.ok(bounds.taps.every(height => height >= 44), JSON.stringify(bounds));
  return bounds;
}
async function waitForContent(page, text) {
  await page.waitForFunction(value => document.querySelector('#messages').textContent.includes(value), text, { timeout: 7000 });
}
async function openGroupFile(page, label) {
  const button = turnGroup(page, 'turn-one').getByRole('button', { name: label, exact: true });
  assert.equal(await button.count(), 1); assert.ok(await button.isVisible());
  await button.tap(); await page.waitForSelector('#preview-dialog[open] .file-text');
  assert.equal(await page.locator('#preview-content .file-text').textContent(), previewText);
  assert.equal(await page.locator('#preview-content script').count(), 0);
  const download = new URL(await page.locator('#preview-download').getAttribute('href'), origin);
  assert.equal(download.pathname, `/api/projects/${projectId}/download`);
  assert.equal(download.searchParams.get('path'), reference);
  await page.locator('#preview-close').tap();
  await page.waitForFunction(() => !document.querySelector('#preview-dialog').open);
}
async function checkLateTurnIds(page) {
  await openThread(page, 'C');
  assert.equal(await processGroups(page).count(), 1);
  assert.equal(await processGroups(page).locator('.process-summary-duration').count(), 0, 'A tool duration must not become the whole round duration');
  assert.equal(await page.locator('#messages').evaluate(element => /PRIVATE_(REASONING|ANALYSIS|ENCRYPTED)/.test(element.textContent)), false);
  await toggle(processGroups(page));
  fixtures['thread-c'].messages.find(item => item.id === 'split-commentary').turnId = 'late-turn-a';
  fixtures['thread-c'].messages.find(item => item.id === 'split-tool').turnId = 'late-turn-b';
  await page.waitForFunction(() => document.querySelectorAll('#messages > details.process-disclosure').length === 2, null, { timeout: 7000 });
  const one = turnGroup(page, 'late-turn-a'), two = turnGroup(page, 'late-turn-b');
  assert.notEqual(await one.getAttribute('data-disclosure-key'), await two.getAttribute('data-disclosure-key'), 'Split rounds must never reuse one disclosure key');
  if (!await one.evaluate(element => element.open)) await toggle(one);
  if (await two.evaluate(element => element.open)) await toggle(two);
  fixtures['thread-c'].messages.find(item => item.id === 'split-commentary').text += '\n分轮后轮询追加';
  await waitForContent(page, '分轮后轮询追加');
  await assertOpen(one, true); await assertHiddenGroup(two);
  await page.reload(); await page.waitForSelector('#workspace:not(.hidden)'); await openThread(page, 'C');
  await assertOpen(one, true); await assertHiddenGroup(two);
  assert.ok(await page.getByText('最终答复一 C：轮次补齐不隐藏最终答复。', { exact: true }).isVisible());
}

try {
  for (const edition of editions) for (const width of [320, 390]) {
    currentEdition = edition;
    fixtures = { 'thread-a': makeThread('thread-a', 'A', true), 'thread-b': makeThread('thread-b', 'B', false), 'thread-c': makeSplitThread() };
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      unexpected.push('External browser request: ' + route.request().url()); return route.abort();
    });
    await context.addInitScript(id => {
      localStorage.setItem(`codex-mobile.${id}.appearance.v1`, JSON.stringify({ theme: 'blue', font: 'system', size: 22 }));
      localStorage.setItem(`codex-mobile.${id}.notice.lastVersion`, '1.0.1');
      localStorage.setItem(`codex-mobile.${id}.permissions-guide-dismissed.v1`, 'true');
    }, edition);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin); await page.waitForSelector('#workspace:not(.hidden)');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '22px');
    await openThread(page, 'A'); await assertStructure(page, 'A');
    await assertVisibleOutsideProcess(page, fixtures['thread-a']);
    for (const group of await processGroups(page).all()) await assertHiddenGroup(group);
    for (const [status, text] of Object.entries({ sent: '已发送', sending: '发送中…', failed: '发送失败', uncertain: '结果未确认' })) assert.equal(await page.locator(`.message-delivery[data-status="${status}"]`).textContent(), text);
    const collapsedLayout = await checkLayout(page);
    await turnGroup(page, 'turn-one').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${edition}-${width}-collapsed.png`), fullPage: true });

    await toggle(turnGroup(page, 'turn-one')); await toggle(legacyGroup(page, 'A', true));
    const firstTool = turnGroup(page, 'turn-one').locator('details[data-message-id="command-one"]');
    const fileTool = turnGroup(page, 'turn-one').locator('details[data-message-id="file-one"]');
    await toggle(firstTool); await toggle(fileTool);
    assert.ok(await firstTool.locator('.message-content').isVisible());
    await openGroupFile(page, '过程报告'); await openGroupFile(page, '工具报告');
    const keys = await processGroups(page).evaluateAll(elements => elements.map(element => element.dataset.disclosureKey));
    fixtures['thread-a'].messages.find(item => item.id === 'process-one').text += '\n轮询追加公开过程';
    fixtures['thread-a'].messages.find(item => item.text.startsWith('无 ID 公开过程')).text += '\n匿名过程追加内容';
    await waitForContent(page, '轮询追加公开过程');
    await assertOpen(turnGroup(page, 'turn-one'), true); await assertOpen(legacyGroup(page, 'A', true), true);
    await assertOpen(firstTool, true); await assertOpen(fileTool, true); await assertHiddenGroup(turnGroup(page, 'turn-two'));
    assert.deepEqual(await processGroups(page).evaluateAll(elements => elements.map(element => element.dataset.disclosureKey)), keys);
    const expandedLayout = await checkLayout(page);
    await turnGroup(page, 'turn-one').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${edition}-${width}-expanded.png`), fullPage: true });

    // Collapsing hides even already-open tool details and new same-turn records.
    await toggle(turnGroup(page, 'turn-one'));
    fixtures['thread-a'].messages.splice(fixtures['thread-a'].messages.findIndex(item => item.id === 'final-one'), 0, { id: 'late-tool', role: 'tool', turnId: 'turn-one', text: '同轮追加工具记录 A' });
    await waitForContent(page, '同轮追加工具记录 A');
    assert.equal(await turnGroup(page, 'turn-one').locator('.process-content > article.message').count(), 6);
    assert.equal(await processGroups(page).count(), 4);
    await assertHiddenGroup(turnGroup(page, 'turn-one')); await assertVisibleOutsideProcess(page, fixtures['thread-a']);

    // Shared item/turn IDs in another chat must not share disclosure state.
    await openThread(page, 'B'); await assertStructure(page, 'B');
    for (const group of await processGroups(page).all()) await assertHiddenGroup(group);
    await toggle(turnGroup(page, 'turn-two'));
    await toggle(turnGroup(page, 'turn-two').locator('details[data-message-id="tool-only-one"]'));
    await assertVisibleOutsideProcess(page, fixtures['thread-b']);
    await openThread(page, 'A'); await assertHiddenGroup(turnGroup(page, 'turn-one')); await assertHiddenGroup(turnGroup(page, 'turn-two'));
    await assertOpen(legacyGroup(page, 'A', true), true);
    await toggle(turnGroup(page, 'turn-one')); await assertOpen(firstTool, true); await assertOpen(fileTool, true); await toggle(turnGroup(page, 'turn-one'));
    await openThread(page, 'B'); await assertHiddenGroup(turnGroup(page, 'turn-one')); await assertOpen(turnGroup(page, 'turn-two'), true);
    await assertOpen(turnGroup(page, 'turn-two').locator('details[data-message-id="tool-only-one"]'), true);

    const savedDisclosures = await page.evaluate(id => sessionStorage.getItem(`codex-mobile.${id}.process-disclosures.v2`), edition);
    assert.ok(savedDisclosures && !savedDisclosures.includes('公开过程') && !savedDisclosures.includes('long-unbroken-text') && !savedDisclosures.includes(malicious), 'Saved disclosure preferences must not contain transcript text');
    const storedEntries = JSON.parse(savedDisclosures);
    assert.ok(storedEntries.length <= 400 && storedEntries.every(entry => typeof entry[0] === 'string' && typeof entry[1] === 'boolean'));
    await page.reload(); await page.waitForSelector('#workspace:not(.hidden)');
    await openThread(page, 'B'); await assertOpen(turnGroup(page, 'turn-two'), true);
    await assertOpen(turnGroup(page, 'turn-two').locator('details[data-message-id="tool-only-one"]'), true);
    await openThread(page, 'A'); await assertHiddenGroup(turnGroup(page, 'turn-one'));
    await assertOpen(legacyGroup(page, 'A', true), true);
    await toggle(turnGroup(page, 'turn-one')); await assertOpen(firstTool, true); await assertOpen(fileTool, true); await toggle(turnGroup(page, 'turn-one'));
    await openThread(page, 'B');

    // A live CLI round arrives in stages, then gets a final answer outside.
    fixtures['thread-b'].status = 'running'; fixtures['thread-b'].turnId = 'turn-stream';
    fixtures['thread-b'].messages.push({ id: 'stream-user', role: 'user', turnId: 'turn-stream', text: '新增流式轮指令 B' }, { id: 'stream-commentary', role: 'assistant', phase: 'commentary', turnId: 'turn-stream', text: '新增流式公开过程 B' });
    await waitForContent(page, '新增流式公开过程 B');
    assert.equal(await processGroups(page).count(), 5); await assertHiddenGroup(turnGroup(page, 'turn-stream')); await assertOpen(turnGroup(page, 'turn-two'), true);
    await toggle(turnGroup(page, 'turn-stream'));
    fixtures['thread-b'].messages.push({ id: 'stream-command', role: 'tool', turnId: 'turn-stream', text: '新增流式工具输出 B' });
    fixtures['thread-b'].messages.find(item => item.id === 'stream-commentary').text += '\n继续追加流式过程';
    await waitForContent(page, '新增流式工具输出 B'); await assertOpen(turnGroup(page, 'turn-stream'), true);
    assert.equal(await turnGroup(page, 'turn-stream').locator('.process-content > article.message').count(), 2);
    await toggle(turnGroup(page, 'turn-stream'));
    fixtures['thread-b'].messages.push({ id: 'stream-final', role: 'assistant', phase: 'final_answer', turnId: 'turn-stream', text: '新增流式最终答复 B' });
    fixtures['thread-b'].status = 'idle'; fixtures['thread-b'].turnId = null;
    await waitForContent(page, '新增流式最终答复 B'); await assertHiddenGroup(turnGroup(page, 'turn-stream')); await assertVisibleOutsideProcess(page, fixtures['thread-b']);

    // A commentary item promoted to final must leave the closed process group.
    const promoted = fixtures['thread-b'].messages.find(item => item.id === 'process-one');
    promoted.phase = 'final_answer'; promoted.text = '过程消息转为最终答复后必须可见。';
    await waitForContent(page, promoted.text); await assertVisibleOutsideProcess(page, fixtures['thread-b']); await assertHiddenGroup(turnGroup(page, 'turn-one'));
    assert.equal(await turnGroup(page, 'turn-one').locator('.process-content > article.message').count(), 4);
    assert.equal(await processGroups(page).count(), 5); await checkLayout(page);
    await checkLateTurnIds(page);
    assert.deepEqual(errors, [], 'No browser or CSP errors');
    results.push({ edition, width, fontSize: 22, sources: ['native', 'companion'], oneGroupPerTurn: true, allProcessRowsHiddenWhenCollapsed: true, toolsOnlyRound: true,
      noTurnIdHistory: true, anonymousMessageStable: true, lateTurnIdSplitIndependent: true, privateReasoningNeverRendered: true, toolDurationNotTurnDuration: true,
      pollingPreservesOpenAndClosed: true, perThreadState: true, innerToolStatePreserved: true, pageReloadPreservesState: true, noTranscriptInStoredPreferences: true, streamingRound: true,
      finalAnswersAndUsersVisible: true, commentaryPromotedToFinalVisible: true, groupedFilePreview: true, textOnly: true, deliveryLabels: true, collapsedLayout, expandedLayout, errors });
    await context.close(); console.log(`PASS ${edition} ${width}px / 22px · round process groups`);
  }
  assert.deepEqual(unexpected, [], 'Only expected mock reads were requested');
  assert.ok(reads.some(read => read.pathname.endsWith('/resolve')) && reads.some(read => read.pathname.endsWith('/preview')));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, results }, null, 2));
  console.log(`Mobile UI mock checks passed. Report: ${path.join(output, 'report.json')}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
