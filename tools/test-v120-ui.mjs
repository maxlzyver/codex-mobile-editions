// Isolated mock-only UI regression. Never reads or sends to a real desktop chat.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), edition = process.env.MOBILE_UI_EDITION || 'windows11';
assert.ok(['windows11', 'windows10', 'macos'].includes(edition));
const output = path.resolve(process.env.MOBILE_UI_OUTPUT || path.join(os.tmpdir(), `codex-v120-ui-${Date.now()}`));
await mkdir(output, { recursive: true });
const version = JSON.parse(await readFile(path.join(root, 'editions', edition, 'package.json'), 'utf8')).version;
const nextVersion = n => { const [a,b,c] = version.split('.').map(Number); return [a,b,c+n].join('.'); };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1cAAAAASUVORK5CYII=', 'base64');
const attack = '<img src=x onerror="window.__attack=true"><script>window.__attack=true</script>';
const citation = '\uE200cite\uE202turn1search0\uE201';
const quoted = '# Files mentioned by the user:\n## My request:\n<image name="literal quoted example">';
const rich = `# 易读的结果\n\n**重点** 与 *说明*。\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文 | 正常 |\n\n- 第一项\n- 第二项\n\n\`\`\`xml\n${quoted}\n${attack}\n\`\`\`\n\n$$\\frac{1}{2}+x^2$$\n\n$\\href{javascript:alert(1)}{危险公式}$\n\n${attack}\n\n[脚本](javascript:alert(1)) ![外部图片](https://invalid.example/remote.png)\n\n<iframe srcdoc="<script>window.__attack=true</script>"></iframe>`;
const projectId = 'a'.repeat(24), requests = [], unexpected = [], results = [];
let fixture;
function makeThread(id, title, native, project) { return { id, title, cwd: '/mock/project', status: 'idle', projectId: project, native, readOnly: false, capabilities: { send: true, steer: true, stop: !native, approvals: !native, modelSelection: true }, messages: [{ id: id+'-u', role: 'user', text: '你好' }, { id: id+'-a', role: 'assistant', phase: 'final_answer', text: rich }, { id: 'opaque-marker', role: 'assistant', text: '可读答复'+citation }, {id:'literal-user',role:'user',text:'`'+citation+'`'}, {id:'unknown-size',role:'assistant',text:'压缩包',attachments:[{id:'legacy-zip',name:'资料.zip',size:null,kind:'file',mime:'application/zip'}]}] }; }
function reset(role) { fixture = { role, threads: { 'chat-a': makeThread('chat-a', '真实项目中的聊天', true, 'desktop-project'), cli: makeThread('cli', '助手任务', false, null) }, gpt: { ...makeThread('chat-a', '电脑上的 GPT 聊天', false, 'gpt-project'), kind: 'chatgpt', cwd: null, model: null, capabilities: { send: true, steer: false, stop: false, attachments: false, modelSelection: false }, messages: [{ id: 'gpt-user', role: 'user', text: 'GPT 的提问' }, { id: 'gpt-answer', role: 'assistant', text: 'GPT 独立的答复' }] }, uploads: [], submissions: [], creates: [], holdUpload: false, heldUpload: null, update: null }; requests.length = 0; }
const json = (res, data, status = 200) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
const body = async req => { const parts = []; for await (const chunk of req) parts.push(chunk); return Buffer.concat(parts); };
const envelope = thread => ({ thread, approvals: [], revision: String(thread.messages.length) + thread.status });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), p = url.pathname; requests.push({ method: req.method, path: p });
    if (p === '/api/bootstrap') return json(res, { role: fixture.role, csrfToken: 'fixture-csrf', features: { desktopProjects: true, nativeGpt: true, attachments: true }, app: { version }, status: { mode: 'standalone', codex: 'connected', hostname: '模拟电脑' }, desktop: { connected: true }, permissions: { canManage: fixture.role === 'owner', allowMobileStop: false, allowMobileApprovals: false, allowOtherFiles: false } });
    if (p === '/api/desktop/projects' && req.method === 'GET') return json(res, { available: true, complete: false, capabilities: { createProject: false, createThread: true }, projects: [{ id: 'desktop-project', name: '真实桌面项目', kind: 'codex', cwd: '/mock/project', threadIds: ['chat-a'], threadsComplete: false, capabilities: { createThread: true } }, { id: 'unread-project', name: '尚未加载的项目', kind: 'codex', threadIds: [], capabilities: { createThread: false } }, { id: 'gpt-project', name: 'GPT 项目', kind: 'chatgpt', threadIds: ['chat-a'], capabilities: { createThread: false } }] });
    if (p === '/api/desktop/projects/desktop-project/threads' && req.method === 'POST') { fixture.creates.push(JSON.parse((await body(req)).toString())); return json(res, { clientThreadId: 'queued-client', projectId: 'desktop-project', pending: true }); }
    if (p === '/api/threads' && req.method === 'GET') return json(res, { threads: Object.values(fixture.threads).map(({messages,...thread}) => thread) });
    if (p === '/api/gpt/threads' && req.method === 'GET') return json(res, { available: true, complete: false, hint: '继续已有 GPT 聊天；模型沿用电脑设置，当前接口不支持新建、附件与停止。', capabilities: { list: true, read: true, send: true, create: false, attachments: false, modelSelection: false, stop: false }, threads: [{ ...fixture.gpt, messages: undefined }] });
    if (/^\/api\/(?:gpt\/)?threads\/[^/]+$/.test(p)) { const thread = p.includes('/gpt/') ? fixture.gpt : fixture.threads[p.split('/').at(-1)]; return json(res, p.includes('/gpt/') ? url.searchParams.has('cursor') ? { ...envelope({...thread,messages:[{id:'earlier-gpt',role:'assistant',text:'更早的 GPT 历史'}]}),page:{hasMore:false,nextCursor:null,order:'oldest_first'} } : {...envelope(thread),page:{hasMore:true,nextCursor:'older page 中文',order:'oldest_first'}} : envelope(thread)); }
    if (/^\/api\/(?:gpt\/)?threads\/[^/]+\/messages$/.test(p) && req.method === 'POST') {
      assert.equal(req.headers['x-csrf-token'], 'fixture-csrf'); const data = JSON.parse((await body(req)).toString()); fixture.submissions.push({ path: p, data });
      if (fixture.failNextSend) { fixture.failNextSend = false; return json(res,{error:'模拟网络结果未确认'},500); }
      const thread = p.includes('/gpt/') ? fixture.gpt : fixture.threads[p.split('/').at(-2)];
      if (p.includes('/gpt/')) assert.deepEqual(Object.keys(data), ['prompt']);
      thread.messages.push({ id: 'sent-'+fixture.submissions.length, role: 'user', text: data.prompt, delivery: 'sent', attachments: (data.attachmentIds || []).map(id => fixture.uploads.find(item => item.attachment.id === id).attachment) });
      thread.status = 'idle'; return json(res, envelope(thread));
    }
    if (p === '/api/attachments' && req.method === 'POST') {
      assert.equal(req.headers['x-csrf-token'], 'fixture-csrf'); assert.equal(req.headers['content-type'], 'application/octet-stream');
      const bytes = await body(req), name = decodeURIComponent(req.headers['x-file-name']), id = 'attachment-'+(fixture.uploads.length+1), image = name.endsWith('.png');
      const attachment = { id, name, size: bytes.length, mime: image ? 'image/png' : 'text/plain', kind: image ? 'image' : 'file', previewUrl: `/api/attachments/${id}/preview`, downloadUrl: `/api/attachments/${id}/download` };
      fixture.uploads.push({ attachment, bytes });
      if (fixture.holdUpload) { fixture.holdUpload = false; fixture.heldUpload = () => json(res, { attachment }); return; }
      return json(res, { attachment });
    }
    if (p.startsWith('/api/attachments/')) { const entry = fixture.uploads.find(item => item.attachment.id === p.split('/')[3]); assert.ok(entry); res.writeHead(200, { 'Content-Type': entry.attachment.mime, 'X-Content-Type-Options': 'nosniff' }); res.end(entry.bytes); return; }
    if (p === '/api/projects') return json(res, { projects: [{ id: projectId, path: '/mock/project', name: '文件工作目录', exists: true }] });
    if (p === '/api/models') return json(res, { models: [{ model: 'mock-model', displayName: 'Mock model', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '中' }] }] });
    if (p === '/api/updates') return json(res, fixture.update || { status: 'upToDate', hasUpdate: false, currentVersion: version, latestVersion: version });
    if (p === '/api/permissions') return json(res, { canManage: fixture.role === 'owner', allowMobileStop: false, allowMobileApprovals: false, allowOtherFiles: false });
    if (p.startsWith('/api/')) { unexpected.push(req.method+' '+p); return json(res, {}, 404); }
    const name = p === '/' ? 'index.html' : p.slice(1); assert.ok(!name.includes('..') && !name.includes('\\'));
    const bytes = await readFile(path.join(root, 'editions', edition, 'public', name));
    const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'" }); res.end(bytes);
  } catch (error) { unexpected.push(error.stack); json(res, { error: 'fixture failed' }, 500); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const origin = 'http://127.0.0.1:'+server.address().port;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const waitUntil = async fn => { const end = Date.now()+10000; while (!fn() && Date.now()<end) await new Promise(resolve=>setTimeout(resolve,30)); assert.ok(fn()); };
async function openChat(page, name) { await page.locator('#sidebar-open').tap(); await page.locator('.thread-item').filter({hasText:name}).tap(); await page.waitForFunction(title=>document.querySelector('#thread-title').textContent===title,name); }
try {
  for (const [width, role] of [[390,'owner'],[320,'controller']]) {
    reset(role); const context = await browser.newContext({ viewport:{width,height:900}, isMobile:true,hasTouch:true });
    await context.addInitScript(({edition,version})=>{ localStorage.setItem(`codex-mobile.${edition}.notice.lastVersion`,version); localStorage.setItem(`codex-mobile.${edition}.appearance.v1`,JSON.stringify({theme:'blue',font:'system',size:22})); },{edition,version});
    const page = await context.newPage(), errors = []; page.on('pageerror',error=>errors.push(error.message)); page.on('console',msg=>{if(msg.type()==='error' && /Content Security Policy|Refused to/.test(msg.text())) errors.push(msg.text());});
    page.on('request',request=>{ if (!request.url().startsWith(origin) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) unexpected.push('EXTERNAL '+request.url()); });
    try {
      await page.goto(origin); await page.waitForSelector('.sidebar-project');
      assert.equal(await page.locator('[data-project-id="desktop-project"] .thread-item').count(),1);
      assert.match(await page.locator('[data-project-id="unread-project"]').textContent(),/暂未读取到聊天/);
      await openChat(page,'真实项目中的聊天');
      await page.waitForSelector('.markdown-table-scroll table');
      assert.equal(await page.locator('#messages h2').first().textContent(),'易读的结果');
      assert.equal(await page.locator('.code-block code').textContent(),quoted+'\n'+attack);
      assert.ok(await page.locator('.math-block math mfrac').count(), JSON.stringify(await page.evaluate(value=>({tokens:window.marked.lexer(value).map(t=>({type:t.type,text:t.text?.slice(0,90)})),html:document.querySelector('article[data-message-id="chat-a-a"] .message-content').innerHTML.slice(-1800)}),rich)));
      assert.equal(await page.locator('#messages script,#messages iframe,#messages img').count(),0);
      assert.equal(await page.locator('#messages [href^="javascript:"]').count(),0);
      assert.equal(await page.evaluate(()=>Boolean(window.__attack)),false);
      assert.equal(await page.locator('article[data-message-id="opaque-marker"] .message-content').textContent(),'可读答复');
      assert.equal(await page.locator('article[data-message-id="literal-user"] code').textContent(),citation);
      assert.equal(await page.locator('[data-attachment-id="legacy-zip"] .attachment-glyph').textContent(),'ZIP');
      assert.doesNotMatch(await page.locator('[data-attachment-id="legacy-zip"]').textContent(),/0 B/);
      const bubble = await page.locator('article[data-message-id="chat-a-u"] .message-content').evaluate(el=>({height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,parent:document.querySelector('#messages').getBoundingClientRect().width,font:parseFloat(getComputedStyle(el).fontSize)}));
      assert.ok(bubble.height<=bubble.font*1.7+25,JSON.stringify(bubble)); assert.ok(bubble.width<bubble.parent*.7,JSON.stringify(bubble));
      await page.locator('#attachment-input').setInputFiles(Array.from({length:9},(_,i)=>({name:`本地${i}.txt`,mimeType:'text/plain',buffer:Buffer.from('local')})));
      assert.equal(await page.locator('.attachment-draft').count(),8); assert.equal(fixture.uploads.length,0);
      await openChat(page,'真实项目中的聊天');
      await page.locator('#attachment-input').setInputFiles([{name:'照片 中文.png',mimeType:'image/png',buffer:png},{name:'移除.txt',mimeType:'text/plain',buffer:Buffer.from('remove')},{name:'说明<script>.txt',mimeType:'text/plain',buffer:Buffer.from('中文附件\n'+attack)}]);
      await page.getByRole('button',{name:'移除 移除.txt',exact:true}).tap(); assert.equal(await page.locator('.attachment-draft').count(),2); assert.equal(fixture.uploads.length,0,'Selecting local drafts must not upload');
      fixture.holdUpload = true; await page.locator('#prompt').fill('请查看这些附件'); await page.locator('#send').tap(); await waitUntil(()=>Boolean(fixture.heldUpload));
      assert.ok(await page.locator('.attachment-draft progress').count()); assert.equal(fixture.submissions.length,0,'Submit only after all uploads succeed'); fixture.heldUpload(); fixture.heldUpload=null;
      await waitUntil(()=>fixture.submissions.length===1); await page.waitForSelector('article[data-message-id="sent-1"] .attachment-card');
      assert.deepEqual(fixture.uploads.map(x=>x.attachment.name),['照片 中文.png','说明<script>.txt']); assert.deepEqual(fixture.uploads[0].bytes,png);
      assert.equal(fixture.submissions[0].data.attachmentIds.length,2); assert.equal(await page.locator('.attachment-draft').count(),0);
      await page.getByRole('button',{name:'预览 照片 中文.png',exact:true}).tap(); await page.waitForSelector('#preview-dialog[open] img');
      assert.ok((await page.locator('#preview-download').getAttribute('href')).endsWith('/download')); await page.locator('#preview-close').tap();
      await page.getByRole('button',{name:'预览 说明<script>.txt',exact:true}).tap(); await page.waitForSelector('#preview-content .file-text'); assert.equal(await page.locator('#preview-content .file-text').textContent(),'中文附件\n'+attack); assert.equal(await page.locator('#preview-content script').count(),0); await page.locator('#preview-close').tap();
      await page.waitForFunction(()=>document.querySelector('#toast').classList.contains('hidden'));
      await page.screenshot({path:path.join(output,`${edition}-${width}-attachments.png`),fullPage:true});
      if(width===390) {
        await page.locator('#appearance-size').evaluate(el=>{el.value='17';el.dispatchEvent(new Event('input',{bubbles:true}));});
        await page.screenshot({path:path.join(output,`${edition}-390-normal.png`),fullPage:true,animations:'disabled'});
        await page.locator('#sidebar-open').tap(); await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().x>=0); assert.ok(await page.locator('[data-project-id="desktop-project"] .project-new-chat').isVisible()); await page.screenshot({path:path.join(output,`${edition}-390-projects.png`),fullPage:true,animations:'disabled'}); await page.locator('#sidebar-close').tap();
        await page.locator('#appearance-size').evaluate(el=>{el.value='22';el.dispatchEvent(new Event('input',{bubbles:true}));});
      }
      // Same ID across modes deliberately exercises private snapshot isolation.
      await page.locator('#chat-mode-gpt').tap(); await openChat(page,'电脑上的 GPT 聊天');
      assert.match(await page.locator('#messages').textContent(),/GPT 独立的答复/); assert.doesNotMatch(await page.locator('#messages').textContent(),/请查看这些附件/);
      assert.equal(await page.locator('#attach-files').isDisabled(),true); assert.equal(await page.locator('#new-thread').isDisabled(),true);
      assert.match(await page.locator('#active-model').textContent(),/沿用电脑聊天模型/);
      if(width===390) { await page.locator('#appearance-size').evaluate(el=>{el.value='17';el.dispatchEvent(new Event('input',{bubbles:true}));}); await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=0); await page.screenshot({path:path.join(output,`${edition}-390-gpt.png`),fullPage:true,animations:'disabled'}); await page.locator('#appearance-size').evaluate(el=>{el.value='22';el.dispatchEvent(new Event('input',{bubbles:true}));}); }
      await page.locator('#load-gpt-history').tap(); await page.waitForSelector('article[data-message-id="earlier-gpt"]');
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(250); assert.equal(await page.locator('article[data-message-id="earlier-gpt"]').count(),1);
      await page.locator('#prompt').fill('继续这个 GPT 聊天'); await page.locator('#send').tap(); await waitUntil(()=>fixture.submissions.length===2); assert.equal(fixture.submissions[1].path,'/api/gpt/threads/chat-a/messages');
      await page.waitForFunction(()=>!document.querySelector('#send').disabled); fixture.gpt.status='running'; await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); await page.waitForFunction(()=>document.querySelector('#composer-activity-label').textContent.includes('等待完成')); assert.equal(await page.locator('#send').isDisabled(),true); fixture.gpt.status='idle';
      await page.locator('#chat-mode-codex').tap(); await openChat(page,'真实项目中的聊天'); assert.match(await page.locator('#messages').textContent(),/请查看这些附件/); assert.doesNotMatch(await page.locator('#messages').textContent(),/GPT 独立/);
      fixture.threads['chat-a'].status='running'; await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); await page.waitForSelector('#composer-activity:not(.hidden)'); assert.equal(await page.locator('#send-behavior option[value="stopThenSend"]').isDisabled(),true);
      if(role==='owner') { fixture.threads.cli.status='running'; await openChat(page,'助手任务'); await page.locator('#send-behavior').selectOption('stopThenSend'); await page.locator('#prompt').fill('停止后执行这个新要求'); await page.locator('#send').tap(); await waitUntil(()=>fixture.submissions.length===3); assert.equal(fixture.submissions[2].data.action,'stopThenSend'); }
      await page.locator('#sidebar-open').tap(); await page.locator('[data-project-id="desktop-project"] .project-new-chat').tap(); await page.locator('#prompt').fill('在真实项目创建聊天'); await page.locator('#send').tap(); await waitUntil(()=>fixture.creates.length===1); await page.waitForFunction(()=>document.querySelector('#thread-state').textContent.includes('已提交到桌面')); assert.equal(await page.locator('#send').isDisabled(),true);
      await page.locator('#sidebar-open').tap(); await page.locator('#desktop-project-create').tap(); await page.waitForSelector('#desktop-project-dialog[open]'); assert.match(await page.locator('#desktop-project-dialog').textContent(),/尚未开放创建项目/); await page.locator('#desktop-project-close').tap(); await page.locator('#sidebar-close').tap();
      // Failed Codex requests must never appear in a GPT chat with the same ID.
      fixture.threads['chat-a'].status='idle'; await openChat(page,'真实项目中的聊天'); fixture.failNextSend=true;
      await page.locator('#prompt').fill('仅属于 Codex 的未确认发送'); await page.locator('#send').tap(); await page.waitForSelector('.message-delivery[data-status="uncertain"]');
      await page.locator('#chat-mode-gpt').tap(); await openChat(page,'电脑上的 GPT 聊天'); assert.doesNotMatch(await page.locator('#messages').textContent(),/仅属于 Codex/);
      await page.locator('#chat-mode-codex').tap(); await openChat(page,'真实项目中的聊天');
      // Switching modes while a draft upload is pending cancels dispatch.
      const beforeCancel=fixture.submissions.length; fixture.holdUpload=true;
      await page.locator('#attachment-input').setInputFiles({name:'取消.png',mimeType:'image/png',buffer:png}); await page.locator('#prompt').fill(''); await page.locator('#send').tap(); await waitUntil(()=>Boolean(fixture.heldUpload));
      await page.locator('#chat-mode-gpt').tap(); fixture.heldUpload(); fixture.heldUpload=null; await page.waitForTimeout(250); assert.equal(fixture.submissions.length,beforeCancel); assert.equal(await page.locator('.attachment-draft').count(),0);
      await page.locator('#chat-mode-codex').tap(); await openChat(page,'真实项目中的聊天');
      const layout = await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,font:getComputedStyle(document.documentElement).fontSize})); assert.equal(layout.font,'22px'); assert.ok(layout.width<=layout.viewport,JSON.stringify(layout));
      await page.screenshot({path:path.join(output,`${edition}-${width}.png`),fullPage:true});
      // An old browser's saved acknowledgement must not hide a newer available update.
      fixture.update = {status:'available',hasUpdate:true,currentVersion:version,latestVersion:nextVersion(1),releaseNotes:'新的附件与项目功能 '+attack}; await page.reload(); await page.waitForSelector('#update-notice[open]'); assert.equal(await page.locator('#update-notice-notes script').count(),0);
      await page.locator('#update-notice-skip').check(); await page.locator('#update-notice-later').tap(); await page.reload(); await page.waitForTimeout(1400); assert.equal(await page.locator('#update-notice').evaluate(el=>el.open),false);
      fixture.update.latestVersion=nextVersion(2); await page.reload(); await page.waitForSelector('#update-notice[open]'); await page.locator('#update-notice-later').tap();
      assert.deepEqual(errors,[]); results.push({width,role,passed:true,cases:['native-project-hierarchy','truthful-project-capabilities','safe-markdown-code-table-math','compact-user-bubble','local-drafts-remove-progress','authenticated-binary-upload','attachment-preview-original-download','gpt-existing-chat-send-and-isolation','honest-running-action-capabilities','queued-native-child','startup-update-skip-version','22px-layout','citation-cleanup-preserves-user-code','unknown-size-and-file-type','eight-local-attachment-limit','gpt-history-pagination-preserved','uncertain-send-mode-isolation','cancel-upload-on-mode-switch']});
    } catch(error) { await page.screenshot({path:path.join(output,`${edition}-${width}-failure.png`),fullPage:true}); console.error(JSON.stringify({errors,unexpected,submissions:fixture.submissions.map(x=>x.path),body:(await page.locator('body').textContent()).slice(-2500)})); throw error; }
    finally { fixture.heldUpload?.(); await context.close(); }
  }
  assert.deepEqual(unexpected,[]); await writeFile(path.join(output,'report.json'),JSON.stringify({edition,results},null,2)); console.log(JSON.stringify({ok:true,edition,groups:results.length,checks:results.reduce((sum,result)=>sum+result.cases.length,0),output}));
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
