// Browser-only fixtures. No real project, Codex process, or account is accessed.
// Same PLAYWRIGHT_MODULE, CHROME_PATH and MOBILE_UI_OUTPUT settings as test-mobile-ui.mjs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.MOBILE_UI_OUTPUT || path.join(os.tmpdir(), `codex-chat-files-${Date.now()}`));
const editions = (process.env.MOBILE_UI_EDITIONS || 'windows10,windows11,macos').split(',');
assert.ok(editions.every(id => ['windows10', 'windows11', 'macos'].includes(id)));
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const projectId = 'a'.repeat(24), otherProjectId = 'b'.repeat(24);
const reportText = '生成的研究报告，含中文和空格。\n<script>window.__previewExecuted=true</script>';
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let edition, fixture;
const errors = [], requests = [], results = [];

function makeFixture(id) {
  const cwd = id === 'macos' ? '/Users/mock/示例 项目' : 'C:/Mock Workspace/示例 项目';
  const otherCwd = id === 'macos' ? '/Users/mock/其他 项目' : 'D:/Other Project';
  const pdfUri = 'file://' + (id === 'macos' ? '' : '/') + cwd.split('/').map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join('/') + '/%E8%BE%93%E5%87%BA/%E6%96%87%E6%A1%A3.pdf#L2';
  const definitions = [
    ['查看报告', cwd + '/输出/研究 报告.txt:12', '输出/研究 报告.txt', 'text/plain'],
    ['下载表格', '输出/结果%20表格.xlsx', '输出/结果 表格.xlsx', 'application/octet-stream'],
    ['阅读 PDF', pdfUri, '输出/文档.pdf', 'application/pdf'],
    ['HTML 源码', '输出/安全预览.html', '输出/安全预览.html', 'text/html'],
    ['SVG 源码', '输出/矢量.svg', '输出/矢量.svg', 'image/svg+xml'],
    ['带括号的文件', '输出/研究(第一版).txt', '输出/研究(第一版).txt', 'text/plain'],
    ['沙盒文件引用', 'sandbox:' + (id === 'macos' ? '' : '/') + cwd + '/输出/沙盒报告.txt', '输出/沙盒报告.txt', 'text/plain'],
    ['图片引用', '输出/图%20表.png', '输出/图 表.png', 'image/png'],
    ['输出/图 表.png', '输出/图 表.png', '输出/图 表.png', 'image/png'],
    ['符号链接逃逸', '输出/逃逸.txt', null, null, 403],
    ['已经移除的文件', '输出/不存在.pdf', null, null, 404],
  ];
  const references = new Map(definitions.map(([label, reference, relative, mime, status]) => [reference, { label, reference, path: relative, mime, status }]));
  const message = '文件已生成，可以直接预览或下载：\n\n' + definitions.filter((_, index) => index !== 8).map(([label, reference]) => (label === '图片引用' ? '!' : '') + '[' + label + '](<' + reference + '>)').join('\n\n')
    + '\n\n代码样式引用：`输出/图 表.png`\n'
    + '\n[相对越界](../outside.txt)\n[编码越界](%2e%2e%2foutside.txt)\n[重复编码](%252e%252e%252foutside.txt)'
    + '\n[跨项目](<' + otherCwd + '/secret.txt>)\n[脚本链接](javascript:alert(1))\n[数据链接](data:text/html,hello)'
    + '\n[伪造接口](/api/projects/' + otherProjectId + '/download?path=secret.txt)'
    + '\n[外网说明](https://example.com/docs?lang=zh)\n'
    + '\n```text\n[代码示例不可点击](输出/example.txt)\n```\n'
    + '<img src=x onerror="window.__messageExecuted=true">';
  const thread = { id: 'mock-files', title: '生成文件与项目控件演示', cwd, status: 'idle', native: true, readOnly: false, model: 'gpt-5.4-mock', effort: 'high', capabilities: { send: true, stop: false }, messages: [{ id: 'prompt', role: 'user', text: '生成报告、表格和图片，并提供文件链接。' }, { id: 'answer', role: 'assistant', phase: 'final_answer', text: message }] };
  return { cwd, otherCwd, references, definitions, thread };
}

function json(response, status, value) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (request.method !== 'GET') { errors.push('Unexpected write: ' + request.method + ' ' + url.pathname); json(response, 405, { error: 'Only fixture reads are permitted.' }); return; }
    if (url.pathname.startsWith('/api/')) {
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
      if (url.pathname === '/api/bootstrap') json(response, 200, { role: 'controller', csrfToken: 'mock-only', status: { codex: 'connected', mode: 'standalone', hostname: '模拟电脑' }, desktop: { connected: true }, app: { version: '1.0.1' } });
      else if (url.pathname === '/api/threads') json(response, 200, { threads: [fixture.thread] });
      else if (url.pathname === '/api/threads/mock-files') json(response, 200, { thread: fixture.thread, approvals: [] });
      else if (url.pathname === '/api/models') json(response, 200, { models: [{ model: 'gpt-5.4-mock', displayName: 'GPT-5.4 · 布局模拟', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '高' }] }] });
      else if (url.pathname === '/api/projects') json(response, 200, { projects: [{ id: projectId, path: fixture.cwd, name: '示例项目：报告与研究资料', exists: true }, { id: otherProjectId, path: fixture.otherCwd, name: '另一个授权项目', exists: true }] });
      else if (url.pathname === '/api/updates') json(response, 200, { status: 'upToDate', currentVersion: '1.0.1', latestVersion: '1.0.1' });
      else if (url.pathname === '/api/projects/' + projectId + '/resolve') {
        const file = fixture.references.get(url.searchParams.get('reference'));
        if (!file) { errors.push('Unexpected reference: ' + url.searchParams.get('reference')); json(response, 400, { error: '无效文件引用。' }); }
        else if (file.status) json(response, file.status, { error: file.status === 403 ? '符号链接指向项目目录之外，已拒绝访问。' : '该目录或文件已不存在。' });
        else json(response, 200, { projectId, path: file.path, name: file.path.split('/').at(-1), mime: file.mime, size: 32 });
      } else if (url.pathname.startsWith('/api/projects/' + projectId + '/')) {
        const file = fixture.definitions.find(value => value[2] === url.searchParams.get('path'));
        assert.ok(file, 'Only resolved fixture files can be read');
        const action = url.pathname.split('/').at(-1);
        if (action === 'preview') json(response, file[3] === 'application/octet-stream' ? 415 : 200, file[3] === 'application/octet-stream' ? { error: '该文件不是 UTF-8 文本，请下载后查看。' } : { text: reportText, name: file[2].split('/').at(-1) });
        else if (action === 'content') { response.writeHead(200, { 'content-type': file[3] }); response.end(file[3] === 'image/png' ? tinyPng : '%PDF-1.7 mock'); }
        else if (action === 'download') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file[2].split('/').at(-1)) }); response.end(reportText); }
        else { errors.push('Unknown action: ' + action); json(response, 404, {}); }
      } else { errors.push('Unexpected API: ' + url.pathname); json(response, 404, {}); }
      return;
    }
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(!filename.includes('..') && !filename.includes('\\'));
    const body = await readFile(path.join(repository, 'editions', edition, 'public', filename));
    response.writeHead(200, { 'content-type': mime[path.extname(filename)] || 'application/octet-stream', 'Content-Security-Policy': csp });
    response.end(body);
  } catch (error) { errors.push(error.stack); json(response, 500, { error: 'Fixture failed.' }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try { browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) }); }
catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }

async function openFile(page, label) {
  await page.getByRole('button', { name: label, exact: true }).tap();
  await page.waitForFunction(() => document.querySelector('#preview-dialog').open);
}
async function closeFile(page) { await page.locator('#preview-close').tap(); await page.waitForFunction(() => !document.querySelector('#preview-dialog').open); }
async function layout(page) {
  const value = await page.evaluate(() => {
    const box = element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
    const group = document.querySelector('.task-settings');
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, group: box(group), controls: [...group.querySelectorAll('.selection-chip, #refresh-models')].map(box), selectors: ['#project-select', '#model-select', '#effort-select'].map(id => ({ id, ...box(document.querySelector(id)) })), messages: { client: document.querySelector('#messages').clientWidth, scroll: document.querySelector('#messages').scrollWidth } };
  });
  assert.ok(value.documentWidth <= value.viewport && value.messages.scroll <= value.messages.client + 1, JSON.stringify(value));
  for (const control of value.controls) assert.ok(control.width > 0 && control.height >= 44 && control.x >= value.group.x - 1 && control.right <= value.group.right + 1, JSON.stringify(value));
  for (const control of value.selectors) assert.ok(control.width >= 40 && control.x >= value.group.x - 1 && control.right <= value.group.right + 1, JSON.stringify(value));
  for (let a = 0; a < value.controls.length; a++) for (let b = a + 1; b < value.controls.length; b++) {
    const one = value.controls[a], two = value.controls[b];
    assert.ok(Math.min(one.right, two.right) - Math.max(one.x, two.x) <= 1 || Math.min(one.bottom, two.bottom) - Math.max(one.y, two.y) <= 1, JSON.stringify(value));
  }
  return value;
}

try {
  for (const id of editions) for (const [width, size] of [[390, 16], [320, 22]]) {
    edition = id; fixture = makeFixture(id);
    const baseline = requests.length;
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce', acceptDownloads: true });
    await context.addInitScript(({ id, size }) => {
      localStorage.setItem('codex-mobile.' + id + '.appearance.v1', JSON.stringify({ theme: 'blue', font: 'system', size }));
      localStorage.setItem('codex-mobile.' + id + '.notice.lastVersion', '1.0.1');
      localStorage.setItem('codex-mobile.' + id + '.permissions-guide-dismissed.v1', 'true');
    }, { id, size });
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource.*(403|404|415)/.test(message.text())) browserErrors.push(message.text()); });
    await page.goto(origin); await page.waitForSelector('#workspace:not(.hidden)');
    await page.locator('#sidebar-open').tap(); await page.locator('.thread-item').tap();
    await page.waitForSelector('.message-file-link');
    assert.equal(await page.locator('.message-file-link').count(), fixture.definitions.length);
    for (const label of ['相对越界', '编码越界', '重复编码', '跨项目', '脚本链接', '数据链接', '伪造接口', '代码示例不可点击']) assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0, label + ' must remain text');
    const external = page.locator('.message-external-link');
    assert.equal(await external.count(), 1); assert.equal(await external.getAttribute('href'), 'https://example.com/docs?lang=zh'); assert.equal(await external.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.locator('#messages img, #messages script').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.__messageExecuted)), false);
    const bounds = await layout(page);
    await page.getByRole('button', { name: '查看报告', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, id + '-' + width + '-chat-files.png'), fullPage: true });

    await openFile(page, '查看报告');
    await page.waitForSelector('#preview-content .file-text');
    assert.equal(await page.locator('#preview-content .file-text').textContent(), reportText);
    assert.equal(await page.locator('#preview-content script').count(), 0);
    const downloadUrl = new URL(await page.locator('#preview-download').getAttribute('href'), origin);
    assert.equal(downloadUrl.pathname, '/api/projects/' + projectId + '/download');
    assert.equal(downloadUrl.searchParams.get('path'), '输出/研究 报告.txt');
    const downloadPromise = page.waitForEvent('download'); await page.locator('#preview-download').tap(); const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), '研究 报告.txt');
    const downloaded = path.join(output, id + '-' + width + '-download.txt'); await download.saveAs(downloaded); assert.equal(await readFile(downloaded, 'utf8'), reportText);
    await closeFile(page);
    for (const label of ['HTML 源码', 'SVG 源码', '带括号的文件', '沙盒文件引用']) {
      await openFile(page, label); await page.waitForSelector('#preview-content .file-text'); assert.equal(await page.locator('#preview-content .file-text').textContent(), reportText); await closeFile(page);
    }
    await openFile(page, '输出/图 表.png');
    await page.waitForFunction(() => document.querySelector('#preview-content img')?.naturalWidth > 0);
    assert.equal(new URL(await page.locator('#preview-content img').getAttribute('src'), origin).searchParams.get('path'), '输出/图 表.png'); await closeFile(page);
    await openFile(page, '阅读 PDF'); assert.equal(new URL(await page.locator('#preview-content a').getAttribute('href'), origin).searchParams.get('path'), '输出/文档.pdf'); await closeFile(page);
    await openFile(page, '下载表格'); await page.waitForFunction(() => document.querySelector('#preview-content').textContent.includes('下载后查看')); assert.equal(new URL(await page.locator('#preview-download').getAttribute('href'), origin).searchParams.get('path'), '输出/结果 表格.xlsx'); await closeFile(page);
    for (const [label, description] of [['符号链接逃逸', '已拒绝访问'], ['已经移除的文件', '已不存在']]) {
      await page.getByRole('button', { name: label, exact: true }).tap(); await page.waitForFunction(text => document.querySelector('#toast').textContent.includes(text), description); assert.equal(await page.locator('#preview-dialog').evaluate(element => element.open), false);
    }
    assert.equal(await page.evaluate(() => Boolean(window.__previewExecuted)), false);
    assert.deepEqual(browserErrors, []);
    assert.ok(requests.slice(baseline).filter(request => request.path.startsWith('/api/projects/')).every(request => request.path.startsWith('/api/projects/' + projectId + '/')), 'No cross-project request');
    results.push({ edition: id, width, fontSize: size, encodedChineseAndSpaces: true, downloadVerified: true, previewTypes: ['text', 'image', 'pdf', 'html-as-text', 'svg-as-text'], invalidReferencesNotLinked: true, serverDeniedFilesNotOpened: true, layout: bounds, browserErrors });
    await context.close(); console.log('PASS chat files ' + id + ' ' + width + 'px / ' + size + 'px');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'chat-files-report.json'), JSON.stringify({ ok: true, results }, null, 2));
  console.log('Chat file regression passed: ' + path.join(output, 'chat-files-report.json'));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
