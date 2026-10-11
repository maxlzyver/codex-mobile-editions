import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { Sessions, AccessError, equal, loopback } from './lib/security.mjs';
import { Tasks } from './lib/tasks.mjs';
import { CodexBridge } from './lib/codex-bridge.mjs';
import { TunnelManager } from './lib/tunnel.mjs';
import { Projects } from './lib/files.mjs';
import { DesktopBridge } from './lib/desktop-bridge.mjs';
import { DesktopTasks } from './lib/desktop-tasks.mjs';
import { APP_INFO } from './lib/app-info.mjs';
import { UpdateManager } from './lib/updater.mjs';
import { createInstaller } from './lib/update-installer.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const qrcode = require('./vendor/qrcode.cjs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const ASSETS = new Set(['/', '/index.html', '/app.js', '/styles.css', '/settings.js', '/settings.css', '/support-wechat.jpg', '/icon.svg', '/manifest.webmanifest']);

export function lanAddresses(port) {
  return Object.values(os.networkInterfaces()).flat().filter(v => v && v.family === 'IPv4' && !v.internal && !v.address.startsWith('169.254.') && !v.address.startsWith('198.18.') && !v.address.startsWith('198.19.')).map(v => `http://${v.address}:${port}`).sort((a, b) => Number(a.includes('192.168.137.')) - Number(b.includes('192.168.137.')));
}

export async function createConsole(options = {}) {
  const runtime = options.runtimeDir || path.join(ROOT, '.runtime');
  mkdirSync(runtime, { recursive: true });
  const workDirectory = options.defaultCwd || process.env.CODEX_MOBILE_CWD || path.join(ROOT, 'workspace');
  mkdirSync(workDirectory, { recursive: true });
  const bridge = options.bridge || new CodexBridge({ cwd: workDirectory });
  const sessions = new Sessions(runtime);
  const companionTasks = new Tasks(bridge, runtime, workDirectory);
  const desktop = options.desktop === false ? null : options.desktop || (options.bridge ? null : new DesktopBridge({ allowWrites: true }));
  const tasks = desktop ? new DesktopTasks(companionTasks, desktop) : companionTasks;
  const defaultCwd = tasks.defaultCwd;
  const projects = new Projects({ tasks, defaultCwd, runtimeDir: runtime, protectedPaths: [path.join(ROOT, '.runtime')] });
  let port = options.port ?? Number(process.env.CODEX_MOBILE_PORT || 43127);
  let tunnel;
  let closing = false;
  let closePromise;
  let signedIn = null;
  let taskRequests = 0;
  let updateLock = false;
  let updateJob = null;
  async function updateBusy() {
    if (taskRequests || companionTasks.approvals.size) return true;
    const active = t => ['running', 'waiting', 'waiting_for_approval'].includes(t.status);
    // Refresh before considering historical snapshots: desktop work can finish
    // without notifying this companion's CLI connection.
    try {
      const listed = await tasks.list();
      if (listed.some(active)) return true;
      for (const cached of tasks.cache.values()) {
        if (!active(cached)) continue;
        if (tasks.owned.has(cached.id) || active((await tasks.get(cached.id)).thread)) return true;
      }
      return Boolean(taskRequests || companionTasks.approvals.size);
    } catch { return true; }
  }
  const installPrepared = options.installPrepared || createInstaller({
    rootDir: ROOT, runtimeDir: runtime, isBusy: updateBusy,
    onBeforeInstall: async () => {
      updateLock = true;
      if (await updateBusy()) { updateLock = false; throw new AccessError(409, '仍有任务在执行，请完成后再更新。'); }
      await close();
    },
  });
  const updater = options.updater || new UpdateManager({ rootDir: ROOT, runtimeDir: runtime, currentVersion: APP_INFO.version, isBusy: updateBusy, installPrepared });
  async function refreshAccount() {
    try { const result = await bridge.request('account/read', {}); signedIn = result.account != null; } catch { signedIn = null; }
  }
  bridge.on('state', s => { if (s.connected) refreshAccount(); else signedIn = null; });
  let connections;
  const cookieName = () => `codex_mobile_${port}`;
  function currentConnections() { return { lanUrls: lanAddresses(port), publicUrl: tunnel?.state?.url || null, tunnelStatus: tunnel?.state?.status || 'stopped', tunnelError: tunnel?.state?.error || null }; }
  function originFor(req) {
    const host = req.headers.host || '';
    const locals = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...lanAddresses(port).map(v => new URL(v).host)]);
    if (locals.has(host)) return `http://${host}`;
    if (tunnel?.state?.url && host === new URL(tunnel.state.url).host && loopback(req.socket.remoteAddress)) return `https://${host}`;
    throw new AccessError(403, '不受信任的访问地址。请使用控制台显示的连接地址。');
  }
  function localOwnerRequest(req) { return loopback(req.socket.remoteAddress) && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip']; }
  function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  function setCookie(res, secret, origin) { res.setHeader('Set-Cookie', `${cookieName()}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${origin.startsWith('https:') ? '; Secure' : ''}`); }
  async function body(req) {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new AccessError(415, '请求必须使用 JSON。');
    let length = 0;
    const chunks = [];
    for await (const c of req) { length += c.length; if (length > 128000) throw new AccessError(413, '请求内容过大。'); chunks.push(c); }
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || Array.isArray(v) || typeof v !== 'object') throw new Error(); return v; } catch { throw new AccessError(400, '无效的 JSON 请求。'); }
  }
  function authorized(session, owner = false) {
    if (!session || !['owner', 'controller'].includes(session.role)) throw new AccessError(401, '请先扫描电脑上的二维码并在电脑端确认连接。');
    if (owner && session.role !== 'owner') throw new AccessError(403, '此操作只能在电脑管理端执行。');
  }
  function pairingView(p) {
    if (!p || p.expiresAt <= Date.now()) return { url: null, qrDataUrl: null, expiresAt: 0 };
    const url = p.baseUrl + '/#pair=' + p.token;
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const svg = qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
    return { url, qrDataUrl: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), expiresAt: p.expiresAt };
  }
  const server = http.createServer(async (req, res) => {
    let authenticatedRequest = false;
    let affectsTasks = false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const origin = originFor(req);
      const url = new URL(req.url, origin);
      const method = req.method;
      if (closing) throw new AccessError(503, '控制台正在关闭，请稍后重新启动。');
      if (req.headers.origin && req.headers.origin !== origin) throw new AccessError(403, '已拒绝跨站请求。');
      if (req.headers['sec-fetch-site'] === 'cross-site' && url.pathname.startsWith('/api/')) throw new AccessError(403, '已拒绝跨站请求。');
      if (['GET', 'HEAD'].includes(method) && ASSETS.has(url.pathname)) {
        const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        const data = readFileSync(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(method === 'HEAD' ? undefined : data); return;
      }
      if (method === 'GET' && url.pathname === '/health') { send(res, 200, { ok: true, app: 'codex-mobile', version: APP_INFO.version }); return; }
      let session = sessions.get(req.headers.cookie, cookieName());
      // Owner cookies never authorize requests arriving via a tunnel or LAN.
      if (session?.role === 'owner' && !localOwnerRequest(req)) session = null;
      authenticatedRequest = ['owner', 'controller'].includes(session?.role);
      if (method === 'GET' && url.pathname === '/api/bootstrap') {
        const role = session?.role || 'anonymous';
        const result = { role, csrfToken: session?.csrf || null, session: session ? { id: session.id, name: session.name } : null };
        if (['owner', 'controller'].includes(role)) Object.assign(result, { app: APP_INFO, status: { codex: signedIn === false ? 'error' : bridge.state.connected ? 'connected' : bridge.state.error ? 'error' : 'connecting', mode: bridge.state.mode, version: APP_INFO.version, hostname: os.hostname(), authenticated: signedIn, error: signedIn === false ? '尚未登录 Codex。请双击 Login.command 或在官方 Codex 桌面应用登录，完成后点击“重新连接”。' : bridge.state.error }, defaultCwd });
        if (role === 'owner') result.connection = currentConnections();
        if (['owner', 'controller'].includes(role)) result.desktop = { connected: Boolean(desktop?.state?.connected), error: desktop?.state?.error || null };
        send(res, 200, result); return;
      }
      if (method === 'POST' && url.pathname === '/api/owner-login') {
        sessions.rate('owner:' + req.socket.remoteAddress);
        if (!localOwnerRequest(req)) throw new AccessError(403, '管理端只能从本机启动器打开。');
        const input = await body(req);
        if (!equal(input.token, sessions.ownerToken)) throw new AccessError(401, '管理链接无效，请重新运行启动器。');
        const created = sessions.create('owner', '本机管理端'); setCookie(res, created.secret, origin); send(res, 200, { ok: true }); return;
      }
      if (method === 'POST' && url.pathname === '/api/pair') {
        sessions.rate('pair:' + (req.headers['cf-connecting-ip'] || req.socket.remoteAddress));
        const input = await body(req);
        const created = sessions.claim(input.token, input.name);
        setCookie(res, created.secret, origin); send(res, 200, { role: 'pending', deviceId: created.item.id }); return;
      }
      authorized(session);
      if (!['GET', 'POST'].includes(method)) throw new AccessError(405, '不支持的请求方式。');
      if (method === 'POST' && !equal(req.headers['x-csrf-token'], session.csrf)) throw new AccessError(403, '页面验证已过期，请刷新后重试。');
      if (url.pathname === '/api/updates' && method === 'GET') { send(res, 200, updater.getState()); return; }
      if (url.pathname.startsWith('/api/updates/') && method === 'POST') {
        authorized(session, true);
        const input = await body(req);
        if (url.pathname === '/api/updates/check') { send(res, 200, await updater.check()); return; }
        if (url.pathname === '/api/updates/settings') { send(res, 200, await updater.configure({ autoUpdate: input.autoUpdate })); return; }
        if (url.pathname === '/api/updates/install') {
          if (updateJob || updateLock || updater.getState().status === 'installing') throw new AccessError(409, '更新正在处理，请稍候。');
          send(res, 202, updater.getState());
          updateJob = Promise.resolve().then(() => updater.install()).catch(() => {}).finally(() => { updateJob = null; });
          return;
        }
        throw new AccessError(404, '此更新操作不存在。');
      }
      if (method === 'POST' && /^\/api\/(threads|approvals)(?:\/|$)/.test(url.pathname)) {
        if (updateLock || updater.getState().status === 'installing') throw new AccessError(409, '正在安装更新，暂时不能提交新的任务操作。');
        affectsTasks = true; taskRequests++;
      }
      if (url.pathname === '/api/pairing') {
        authorized(session, true);
        if (method === 'GET') { send(res, 200, pairingView(sessions.pairings.get(url.searchParams.get('mode') || 'lan'))); return; }
        const input = await body(req);
        if (!['lan', 'internet'].includes(input.mode)) throw new AccessError(400, '请选择连接模式。');
        const c = currentConnections();
        const base = input.mode === 'internet' ? c.publicUrl : input.baseUrl || c.lanUrls[0];
        if (!base) throw new AccessError(409, input.mode === 'internet' ? '外网连接尚未建立，请先启用外网连接。' : '没有找到局域网地址，请检查电脑网络连接。');
        if (input.mode === 'lan' && !c.lanUrls.includes(base)) throw new AccessError(400, '无效的局域网地址。');
        send(res, 200, pairingView(sessions.newPairing(input.mode, base))); return;
      }
      if (url.pathname === '/api/devices' && method === 'GET') { authorized(session, true); send(res, 200, { devices: sessions.devices() }); return; }
      let match = /^\/api\/devices\/([a-f0-9]+)\/(approve|revoke)$/.exec(url.pathname);
      if (match && method === 'POST') { authorized(session, true); await body(req); sessions.change(match[1], match[2] === 'approve' ? 'controller' : 'revoked'); send(res, 200, { ok: true }); return; }
      if (url.pathname === '/api/tunnel' && method === 'POST') {
        authorized(session, true); const input = await body(req);
        if (input.action === 'start') { await tunnel.start(); } else if (input.action === 'stop') { await tunnel.stop(); sessions.pairings.delete('internet'); } else throw new AccessError(400, '无效操作。');
        send(res, 202, currentConnections()); return;
      }
      if (url.pathname === '/api/reconnect' && method === 'POST') { authorized(session, true); await body(req); await bridge.start(); await desktop?.connect().catch(() => {}); await refreshAccount(); send(res, 200, { ok: true }); return; }
      if (url.pathname === '/api/logout' && method === 'POST') { await body(req); if (session.role !== 'owner') sessions.change(session.id, 'revoked'); else sessions.items.delete(session.hash); res.setHeader('Set-Cookie', `${cookieName()}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); send(res, 200, { ok: true }); return; }
      if (url.pathname === '/api/shutdown' && method === 'POST') { authorized(session, true); await body(req); send(res, 200, { ok: true }); setTimeout(() => close().then(() => options.onShutdown?.()), 100).unref(); return; }
      if (url.pathname === '/api/models' && method === 'GET') { send(res, 200, { models: await tasks.models.list({ refresh: true }) }); return; }
      if (url.pathname === '/api/projects') {
        if (method === 'GET') { send(res, 200, { projects: await projects.list() }); return; }
        authorized(session, true); const input = await body(req); send(res, 201, await projects.addRoot(input.path)); return;
      }
      match = /^\/api\/projects\/([a-zA-Z0-9_-]+)\/(files|preview|download|content)$/.exec(url.pathname);
      if (match && method === 'GET') {
        const relative = url.searchParams.get('path') || '';
        if (match[2] === 'files') { send(res, 200, await projects.browse(match[1], relative)); return; }
        if (match[2] === 'preview') { send(res, 200, await projects.preview(match[1], relative)); return; }
        const file = await projects.resolveFile(match[1], relative);
        const inline = match[2] === 'content' && /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf)$/.test(file.mime);
        if (match[2] === 'content' && !inline) throw new AccessError(415, '此格式请下载后打开。');
        // Project HTML/SVG/scripts are never served as executable same-origin documents.
        res.setHeader('Content-Security-Policy', inline && file.mime === 'application/pdf' ? "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" : "sandbox; default-src 'none'; frame-ancestors 'self'");
        res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
        res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16))}`);
        res.setHeader('Accept-Ranges', 'bytes');
        let start = 0, end = file.size - 1;
        if (req.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!range || (!range[1] && !range[2]) || file.size === 0) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return; }
          if (!range[1]) start = Math.max(0, file.size - Number(range[2]));
          else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.size) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return; }
          res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
        }
        res.writeHead(req.headers.range ? 206 : 200, { 'Content-Length': Math.max(0, end - start + 1) });
        if (file.size === 0) res.end();
        else await pipeline(createReadStream(file.absolutePath, { start, end }), res);
        return;
      }
      if (url.pathname === '/api/threads') {
        if (method === 'GET') send(res, 200, { threads: await tasks.list() });
        else {
          const input = await body(req);
          let cwd = defaultCwd;
          if (input.projectId || input.cwd) {
            const available = await projects.list();
            const project = available.find(p => input.projectId ? p.id === input.projectId : path.resolve(p.path).toLowerCase() === path.resolve(input.cwd).toLowerCase());
            if (!project || !project.exists) throw new AccessError(400, '请选择一个可访问的电脑项目。');
            cwd = project.path;
          }
          send(res, 201, await tasks.create(input.prompt, cwd, { model: input.model, effort: input.effort }));
        }
        return;
      }
      match = /^\/api\/threads\/([a-zA-Z0-9_-]+)(?:\/(messages|stop|fork))?$/.exec(url.pathname);
      if (match) {
        if (method === 'GET' && !match[2]) { send(res, 200, await tasks.get(match[1])); return; }
        if (method === 'POST' && match[2]) { const input = await body(req); send(res, 200, match[2] === 'stop' ? await tasks.stop(match[1]) : match[2] === 'fork' ? await tasks.fork(match[1], input) : await tasks.send(match[1], input.prompt, { model: input.model, effort: input.effort })); return; }
      }
      match = /^\/api\/approvals\/([a-f0-9]+)$/.exec(url.pathname);
      if (match && method === 'POST') { send(res, 200, tasks.answer(match[1], await body(req))); return; }
      throw new AccessError(404, '此地址不存在。');
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: (error instanceof AccessError || authenticatedRequest) ? String(error.message || '请求失败').slice(0, 1500) : '请求失败，请在电脑管理端检查服务状态。', ...(authenticatedRequest && error.threadId ? { threadId: error.threadId } : {}) });
      else res.end();
    } finally { if (affectsTasks) taskRequests--; }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxConnections = 64;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, options.host || '0.0.0.0', resolve); });
  port = server.address().port;
  tunnel = options.tunnel || new TunnelManager({ port, rootDir: ROOT });
  connections = currentConnections();
  const ownerUrl = `http://127.0.0.1:${port}/#owner=${sessions.ownerToken}`;
  writeFileSync(path.join(runtime, 'owner-url.txt'), ownerUrl, { mode: 0o600 });
  writeFileSync(path.join(runtime, 'server.json'), JSON.stringify({ pid: process.pid, port, root: ROOT, startedAt: Date.now() }), { mode: 0o600 });
  bridge.start().catch(() => {});
  desktop?.connect().catch(() => {});
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const httpClosed = new Promise(resolve => server.close(resolve));
      const attempts = Promise.allSettled([...tasks.cache.keys()].filter(id => tasks.owned.has(id)).map(id => tasks.stop(id)));
      let timer;
      await Promise.race([attempts, new Promise(resolve => { timer = setTimeout(resolve, 2000); timer.unref?.(); })]);
      clearTimeout(timer);
      await Promise.allSettled([tunnel.stop(), bridge.close(), desktop?.close(), updater.close()]);
      server.closeAllConnections();
      await httpClosed;
    })();
    return closePromise;
  }
  return { server, bridge, desktop, tasks, projects, sessions, tunnel, updater, port, ownerUrl, connections, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createConsole({ onShutdown: () => process.exit(0) });
  console.log(`Codex 移动助手 ${APP_INFO.version} is listening on http://127.0.0.1:${app.port}`);
  console.log('Use Start.command to open the local owner console. Pairing secrets are not logged.');
  const stop = () => { app.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
