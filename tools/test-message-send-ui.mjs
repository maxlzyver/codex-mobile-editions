// Real browser regression with an in-memory API; never opens a real Codex connection.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const editions = process.argv.slice(2).length ? process.argv.slice(2) : ['windows11', 'windows10', 'macos'];
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const clone = value => structuredClone(value);
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
try {
  for (const edition of editions) {
    assert(['windows11', 'windows10', 'macos'].includes(edition));
    const directory = path.join(root, 'editions', edition);
    let posts = 0, nextPost, pendingPost, holdRead = false, staleRead, readGate;
    const threads = new Map(['a', 'b'].map(id => [id, { id, title: `聊天 ${id}`, status: 'idle', readOnly: false, native: true, capabilities: { stop: false }, messages: id === 'a' ? [{ id: 'old-user', role: 'user', text: '重复检查' }, { id: 'answer', role: 'assistant', phase: 'final_answer', text: '上一次结果' }] : [] }]));
    const view = id => ({ thread: clone(threads.get(id)), approvals: [] });
    const server = createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/api/bootstrap') return json(res, { role: 'controller', csrfToken: 'mock', status: { codex: 'connected', mode: 'standalone' }, desktop: { connected: true } });
        if (pathname === '/api/models') return json(res, { models: [] });
        if (pathname === '/api/projects') return json(res, { projects: [] });
        if (pathname === '/api/updates') return json(res, { status: 'upToDate', currentVersion: '1.0.1' });
        if (pathname === '/api/threads' && req.method === 'GET') return json(res, { threads: [...threads.values()] });
        if (pathname.startsWith('/api/threads/') && req.method === 'GET') {
          const id = decodeURIComponent(pathname.split('/')[3]);
          const snapshot = view(id);
          if (holdRead && id === 'a') { holdRead = false; staleRead = true; await readGate.promise; }
          return json(res, snapshot);
        }
        if (req.method === 'POST' && (pathname === '/api/threads' || pathname.endsWith('/messages'))) {
          let raw = ''; for await (const bytes of req) raw += bytes;
          const input = JSON.parse(raw); const sequence = ++posts;
          const scenario = nextPost || { gate: gate(), failure: 0 }; nextPost = null;
          const id = pathname === '/api/threads' ? `created-${sequence}` : decodeURIComponent(pathname.split('/')[3]);
          pendingPost = { input, id, scenario, sequence };
          await scenario.gate.promise;
          if (scenario.failure) return json(res, { error: scenario.failure === 409 ? '此任务暂不能接收指令' : '发送结果未能确认，请刷新核对' }, scenario.failure);
          if (!threads.has(id)) threads.set(id, { id, title: `聊天 ${id}`, status: 'idle', messages: [] });
          if (scenario.warning) threads.get(id).submissionWarning = scenario.warning;
          threads.get(id).messages.push({ id: `receipt-${sequence}`, role: 'user', text: input.prompt, delivery: 'sent', submitted: true, createdAt: Date.now() });
          return json(res, view(id));
        }
        if (pathname.startsWith('/api/')) return json(res, { error: 'Unexpected mocked API route' }, 404);
        const name = pathname === '/' ? 'index.html' : pathname.slice(1);
        assert(!name.includes('..'));
        const bytes = await readFile(path.join(directory, 'public', name));
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[path.extname(name)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" }); res.end(bytes);
      } catch (error) { json(res, { error: error.message }, 500); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(id => {
      localStorage.setItem('codex-mobile.' + id + '.notice.lastVersion', '1.0.1');
      localStorage.setItem('codex-mobile.' + id + '.permissions-guide-dismissed.v1', 'true');
    }, edition);
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const eventually = async (condition, label) => {
      const started = Date.now();
      while (!await condition()) { if (Date.now() - started > 10000) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); }
    };
    const open = async id => {
      await page.locator('#sidebar-open').tap();
      await page.locator('.thread-item').filter({ hasText: `聊天 ${id}` }).tap();
      await eventually(async () => await page.locator('#thread-title').textContent() === `聊天 ${id}`, `open ${id}`);
    };
    const userCount = async text => page.locator('.message.user').filter({ has: page.locator('.message-content', { hasText: text }) }).count();
    const begin = async (prompt, failure = 0, warning = '') => {
      const scenario = { gate: gate(), failure, warning }; nextPost = scenario; pendingPost = null;
      await page.locator('#prompt').fill(prompt); await page.locator('#send').tap();
      await eventually(() => pendingPost !== null, 'POST request');
      await page.locator('.message-delivery[data-status="sending"]').waitFor();
      return { ...pendingPost, release: () => scenario.gate.resolve() };
    };
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.locator('#workspace:not(.hidden)').waitFor(); await open('a');
      const first = await begin('重复检查');
      assert.equal(await userCount('重复检查'), 2, 'old identical prompt must remain alongside immediate pending send');
      assert.equal(await page.locator('#send').isDisabled(), true);
      assert.equal(posts, 1);
      await page.locator('#prompt').fill('下一条草稿不能被清空');
      readGate = gate(); staleRead = false; holdRead = true;
      await eventually(() => staleRead, 'hold a poll started before POST completes');
      first.release();
      await page.locator('.message-delivery[data-status="sent"]').waitFor();
      readGate.resolve();
      await eventually(async () => await page.locator('#send').isEnabled(), 'send complete');
      assert.equal(await userCount('重复检查'), 2, 'accepted message must replace pending exactly once');
      assert.equal(await page.locator('#prompt').inputValue(), '下一条草稿不能被清空');
      await page.reload(); await page.locator('#workspace:not(.hidden)').waitFor(); await open('a');
      assert.equal(await userCount('重复检查'), 2, 'accepted send must survive page reload');
      const warning = '指令已发送，但本地回执暂未保存到磁盘；请勿重复发送。';
      const second = await begin('重复检查', 0, warning); second.release();
      await eventually(async () => await page.locator('#send').isEnabled(), 'repeat send');
      assert.equal(await userCount('重复检查'), 3, 'two equal submitted instructions are two distinct messages');
      assert.equal(await page.locator('#error-banner').isVisible(), true);
      assert.match(await page.locator('#error-banner').textContent(), /指令已发送.*请勿重复发送/);
      delete threads.get('a').submissionWarning;

      const switched = await begin('只发给聊天 a'); await open('b');
      await page.locator('#prompt').fill('聊天 b 的草稿'); switched.release();
      await eventually(async () => await page.locator('#send').isEnabled(), 'switched send complete');
      assert.equal(await page.locator('#thread-title').textContent(), '聊天 b');
      assert.equal(await page.locator('#prompt').inputValue(), '聊天 b 的草稿');
      assert.equal(await userCount('只发给聊天 a'), 0);
      await open('a'); assert.equal(await userCount('只发给聊天 a'), 1);

      const failed = await begin('明确失败的指令', 409); failed.release();
      await page.locator('.message-delivery[data-status="failed"]').waitFor();
      assert.equal(await page.locator('#prompt').inputValue(), '明确失败的指令');
      assert.equal(threads.get('a').messages.some(message => message.text === '明确失败的指令'), false);
      const uncertain = await begin('网络结果未确认', 502); uncertain.release();
      await page.locator('.message-delivery[data-status="uncertain"]').waitFor();
      const countBeforeRefresh = posts;
      threads.get('a').messages.push({ id: 'late-receipt', role: 'user', text: '网络结果未确认', submitted: true, delivery: 'sent' });
      await eventually(async () => await page.locator('.message-delivery[data-status="uncertain"]').count() === 0, 'later confirmed read resolves ambiguous response');
      assert.equal(await userCount('网络结果未确认'), 1);
      assert.equal(posts, countBeforeRefresh, 'refresh never automatically resends');

      await page.locator('#mobile-new').tap();
      const newThread = await begin('手机首次新建任务');
      assert.equal(await userCount('手机首次新建任务'), 1);
      newThread.release();
      await eventually(async () => await page.locator('#thread-title').textContent() === `聊天 ${newThread.id}`, 'new thread response');
      assert.equal(await userCount('手机首次新建任务'), 1);
      await page.setViewportSize({ width: 320, height: 740 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      console.log(`PASS ${edition}: immediate send, accepted POST, stale polling, reload, repeated text, thread isolation, failure, uncertain acknowledgement, no resend, new task and 320px layout`);
    } finally {
      nextPost?.gate.resolve(); pendingPost?.scenario.gate.resolve(); readGate?.resolve();
      await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
} finally { await browser.close(); }
