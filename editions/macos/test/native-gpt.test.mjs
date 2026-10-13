import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopProjects } from '../lib/desktop-projects.mjs';
import { NativeGPT } from '../lib/native-gpt.mjs';

const result = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const definition = (name, properties = {}) => ({ name, namespace: 'codex_app', inputSchema: { properties } });
const fixtures = {
  projects: [{ projectId: 'local-project', projectKind: 'local', hostId: 'local', label: '本机真实项目', path: '/project', isGitRepository: true }, { projectId: 'gpt-project', projectKind: 'chatgpt', hostId: null, label: '真实 GPT 项目' }, { projectId: 'other-project', projectKind: 'remote', hostId: 'another-machine', label: '其他电脑' }],
  threads: [{ id: 'codex-chat', kind: 'codex', hostId: 'local', projectId: 'local-project', title: 'Codex child' }, { id: 'gpt-chat', kind: 'chatgpt', projectId: 'gpt-project', title: 'GPT child', status: 'idle' }, { id: 'other-chat', kind: 'codex', hostId: 'another-machine', projectId: 'other-project' }],
};
function fixture(t, options = {}) {
  const desktop = new EventEmitter();
  desktop.state = { connected: true }; desktop.options = { allowWrites: true, callerThreadId: 'real-codex-caller', hostId: 'local' };
  desktop.tools = [definition('list_projects'), definition('list_threads'), definition('read_thread'), definition('send_message_to_thread', { model: {}, thinking: {} }), definition('create_thread', { target: { anyOf: [{ properties: { type: { enum: ['project'] } } }] }, model: {}, thinking: { enum: ['high'] } })];
  desktop.connect = async () => { if (!desktop.state.connected) throw Error('Internal connection token=DO_NOT_LEAK'); };
  desktop.listTools = async () => desktop.tools;
  const calls = [];
  const read = { thread: { id: 'gpt-chat', kind: 'chatgpt', title: 'GPT child', status: { type: 'idle' }, updatedAt: 100 }, page: { order: 'newest_first', hasMore: true, nextCursor: 'older' }, turns: [{ id: 'turn-new', items: [{ id: 'new-answer', type: 'agentMessage', text: '最新回复' }] }, { id: 'turn-old', items: [{ id: 'question', type: 'userMessage', content: [{ type: 'text', text: '问题' }, { type: 'file', name: 'report.txt', path: '/project/report.txt', mimeType: 'text/plain' }] }, { id: 'old-answer', type: 'agentMessage', text: '较早回复' }] }] };
  let intercept;
  desktop.call = desktop.callReadOnly = async (tool, args, context) => {
    calls.push({ tool, args, context });
    if (intercept) { const answer = await intercept(tool, args, context); if (answer !== undefined) return answer; }
    if (tool === 'list_projects') return result({ projects: fixtures.projects });
    if (tool === 'list_threads') return result({ threads: fixtures.threads, pinnedThreads: [fixtures.threads[1]], sections: [{ sectionId: 'custom', name: '工作区', itemKeys: ['codex:project:local-project', 'codex:thread:local:codex-chat', 'chatgpt:conversation:gpt-chat', 'codex:thread:another-machine:other-chat'] }] });
    if (tool === 'read_thread') return result(read);
    if (tool === 'send_message_to_thread') return result({ threadId: args.threadId });
    if (tool === 'create_thread') return result({ threadId: 'new-codex-child', hostId: 'local' });
    throw Error('Unexpected tool');
  };
  const tasks = { desktop, nativeListTime: 1, models: { resolve: async () => ({ model: 'native-model', effort: 'high' }) }, tasks: { list: async () => [{ id: 'fallback-caller', hostId: 'local' }] } };
  const projects = new DesktopProjects(tasks, options), gpt = new NativeGPT(projects, options);
  t.after(() => { gpt.close(); projects.close(); });
  return { desktop, projects, gpt, tasks, calls, read, intercept: fn => { intercept = fn; } };
}

test('real project identity, membership and section order exclude other computers without inventing projects', async t => {
  const { projects } = fixture(t);
  const view = await projects.list();
  assert.equal(view.available, true); assert.equal(view.complete, false);
  assert.deepEqual(view.projects.map(p => [p.id, p.kind, p.threadIds, p.capabilities.createThread]), [['local-project', 'codex', ['codex-chat'], true], ['gpt-project', 'chatgpt', ['gpt-chat'], false]]);
  assert.equal(view.capabilities.createProject, false);
  assert.deepEqual(view.sections[0].projectIds, ['local-project']);
  assert.equal(view.projects[0].threadsComplete, false);
  assert(view.sections[0].threadIds.includes('gpt-chat'));
  assert(!view.sections[0].threadIds.includes('other-chat'));
});

test('new project child uses actual projectId, local environment and a separate real caller', async t => {
  const { projects, calls, tasks } = fixture(t);
  const created = await projects.createThread('local-project', { prompt: '创建测试聊天，仅 mock 接收', title: '新聊天', model: 'choice', effort: 'high' });
  assert.equal(created.threadId, 'new-codex-child'); assert.equal(created.pending, false);
  const sent = calls.find(c => c.tool === 'create_thread');
  assert.deepEqual(sent.args.target, { type: 'project', projectId: 'local-project', environment: { type: 'local' } });
  assert.equal(sent.args.model, 'native-model'); assert.equal(sent.context.callerThreadId, 'real-codex-caller');
  assert.equal(tasks.nativeListTime, 0);
  await assert.rejects(projects.createThread('gpt-project', { prompt: 'No write' }), { status: 403 });
  await assert.rejects(projects.createThread('other-project', { prompt: 'No write' }), { status: 403 });
  assert.equal(calls.filter(c => c.tool === 'create_thread').length, 1);
});

test('creation without model choice omits overrides and uncertain acceptance is not retried', async t => {
  const { projects, calls, intercept } = fixture(t);
  intercept(tool => { if (tool === 'create_thread') throw Error('timeout with secret=DO_NOT_LEAK'); });
  await assert.rejects(projects.createThread('local-project', { prompt: 'mock only' }), error => error.status === 502 && !error.message.includes('DO_NOT_LEAK'));
  const sent = calls.filter(c => c.tool === 'create_thread');
  assert.equal(sent.length, 1); assert.equal(sent[0].args.model, undefined); assert.equal(sent[0].args.thinking, undefined);
});

test('GPT lists only existing GPT chats, deduplicates pins and exposes truthful limitations', async t => {
  const { gpt } = fixture(t);
  const view = await gpt.list();
  assert.deepEqual(view.threads.map(v => v.id), ['gpt-chat']);
  assert.equal(view.capabilities.send, true);
  for (const capability of ['create', 'modelSelection', 'effortSelection', 'stop', 'steer', 'attachments']) assert.equal(view.capabilities[capability], false);
  assert.deepEqual(view.models, []); assert.equal(view.threads[0].model, null);
  await assert.rejects(gpt.get('codex-chat'), { status: 404 });
});

test('GPT read is chronological, retains rich user metadata and omits host/model target arguments', async t => {
  const { gpt, calls } = fixture(t);
  const view = await gpt.get('gpt-chat');
  assert.deepEqual(view.thread.messages.map(v => v.id), ['question', 'old-answer', 'new-answer']);
  assert.equal(view.thread.messages[0].content[1].name, 'report.txt');
  assert.equal(view.thread.projectId, 'gpt-project');
  assert.equal(view.page.nextCursor, 'older'); assert.equal(view.page.hasMore, true);
  const read = calls.find(c => c.tool === 'read_thread');
  assert.equal(read.args.hostId, undefined); assert.equal(read.args.model, undefined);
  assert.equal(read.context.callerThreadId, 'real-codex-caller'); assert.equal(read.context.hostId, 'local');
  assert.equal((await gpt.get('gpt-chat')).revision, view.revision);
});

test('GPT rejects returned foreign kinds, IDs and unexpected Codex hosts', async t => {
  const { gpt, read } = fixture(t, { cacheMs: 0 });
  for (const patch of [{ kind: 'codex' }, { kind: 'chatgpt', id: 'wrong-id' }, { id: 'gpt-chat', hostId: 'local' }]) {
    Object.assign(read.thread, patch);
    await assert.rejects(gpt.get('gpt-chat'), { status: 403 });
  }
});

test('GPT send keeps native model implicit, records acceptance and rejects overrides/attachments before writing', async t => {
  const { gpt, calls } = fixture(t);
  const view = await gpt.send('gpt-chat', '继续当前 GPT 对话');
  assert.equal(view.accepted, true);
  assert(view.thread.messages.some(item => item.text === '继续当前 GPT 对话'));
  const writes = calls.filter(c => c.tool === 'send_message_to_thread');
  assert.deepEqual(writes[0].args, { threadId: 'gpt-chat', prompt: '继续当前 GPT 对话' });
  assert.equal(writes[0].context.callerThreadId, 'real-codex-caller');
  await assert.rejects(gpt.send('gpt-chat', 'mock', { model: 'gpt-other' }), { status: 400 });
  await assert.rejects(gpt.send('gpt-chat', 'mock', { attachments: ['file-id'] }), { status: 400 });
  assert.equal(calls.filter(c => c.tool === 'send_message_to_thread').length, 1);
});

test('GPT active replies cannot be steered or stopped through unsupported tools', async t => {
  const { gpt, calls, read } = fixture(t); read.thread.status = { type: 'active' };
  await assert.rejects(gpt.send('gpt-chat', 'No send'), { status: 409 });
  assert(!calls.some(c => c.tool === 'send_message_to_thread'));
});

test('GPT concurrent sends are locked and unknown acceptance is never retried or leaked', async t => {
  const { gpt, calls, intercept } = fixture(t);
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  intercept(async tool => { if (tool === 'send_message_to_thread') { entered(); await gate; throw Error('DO_NOT_LEAK credential'); } });
  const first = gpt.send('gpt-chat', 'mock'); const checked = assert.rejects(first, e => e.status === 502 && !e.message.includes('DO_NOT_LEAK'));
  await ready; await assert.rejects(gpt.send('gpt-chat', 'duplicate'), { status: 409 }); release(); await checked;
  assert.equal(calls.filter(c => c.tool === 'send_message_to_thread').length, 1); assert.equal(gpt.locks.size, 0);
});

test('an accepted GPT send survives a failed status refresh without reporting a failed send', async t => {
  const { gpt, intercept } = fixture(t); let sent = false;
  intercept(tool => { if (tool === 'send_message_to_thread') sent = true; if (tool === 'read_thread' && sent) throw Error('read failure'); });
  const view = await gpt.send('gpt-chat', 'accepted');
  assert.equal(view.accepted, true); assert.equal(view.refreshPending, true); assert.equal(view.thread.status, 'running');
});

test('disconnect clears memory data and late reads cannot repopulate the GPT cache', async t => {
  const { gpt, desktop, intercept, read } = fixture(t);
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  intercept(async tool => { if (tool === 'read_thread') { entered(); await gate; return result(read); } });
  const request = gpt.get('gpt-chat'); const checked = assert.rejects(request, { status: 503 });
  await ready; desktop.state.connected = false; desktop.emit('state', { connected: false }); release(); await checked;
  assert.equal(gpt.cache.size, 0); assert.equal(gpt.known.size, 0); assert.equal((await gpt.status()).available, false);
});

test('native catalog reads are shared and GPT cached transcript bytes stay bounded', async t => {
  const { projects, gpt, calls } = fixture(t, { maxCacheBytes: 2000, maxEntries: 2 });
  await Promise.all([projects.list(), gpt.list(), gpt.list()]);
  assert.equal(calls.filter(c => c.tool === 'list_threads').length, 1);
  for (let i = 0; i < 8; i++) await gpt.get('gpt-chat', { cursor: `cursor-${i}` });
  assert(gpt.cache.size <= 2); assert([...gpt.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0) <= 2000);
});

test('canonical history supplements old project children without guessing from paths or overriding explicit native removal', async t => {
  const { projects, tasks, intercept } = fixture(t);
  tasks.tasks.list = async () => [
    { id: 'old-child', projectId: 'local-project', cwd: '/some-other-source-folder' },
    { id: 'same-path-unknown', cwd: '/project' },
    { id: 'same-path-unassigned', projectId: null, cwd: '/project' },
    { id: 'codex-chat', projectId: 'local-project', cwd: '/project' },
  ];
  let explicitRemoval = false;
  intercept(tool => { if (tool === 'list_threads') return result({ threads: [{ id: 'codex-chat', kind: 'codex', hostId: 'local', ...(explicitRemoval ? { projectId: null } : {}) }] }); });
  let view = await projects.list();
  assert.deepEqual(view.projects[0].threadIds, ['old-child', 'codex-chat']);
  assert.equal(view.projects[0].threadsComplete, false); assert.equal(view.projects[0].threadCount, null);
  explicitRemoval = true; projects.invalidate(); view = await projects.list();
  assert.deepEqual(view.projects[0].threadIds, ['old-child']);
});

test('a genuine fallback caller is discovered once per connection instead of rescanning CLI history on every GPT poll', async t => {
  const { projects, gpt, tasks, desktop, calls } = fixture(t, { cacheMs: 0 });
  desktop.options.callerThreadId = null; let scans = 0;
  tasks.tasks.list = async () => { scans++; return [{ id: 'fallback-caller', kind: 'codex', hostId: 'local' }]; };
  await Promise.all([projects.context(), projects.context(), gpt.status()]);
  await gpt.get('gpt-chat'); await gpt.get('gpt-chat');
  assert.equal(scans, 1);
  assert(calls.filter(c => c.tool === 'read_thread').every(c => c.context.callerThreadId === 'fallback-caller'));
});

test('unused or unavailable optional GPT never blocks updates; running GPT is refreshed until complete', async t => {
  const { gpt, read, intercept, calls } = fixture(t);
  assert.equal(await gpt.isBusy(), false); assert.equal(calls.length, 0);
  await gpt.status();
  intercept(tool => {
    if (tool === 'list_threads') return result({ threads: [{ ...fixtures.threads[1], status: read.thread.status }] });
  });
  read.thread.status = { type: 'active' };
  assert.equal(await gpt.isBusy(), true);
  read.thread.status = { type: 'idle' };
  assert.equal(await gpt.isBusy(), false);
  intercept(() => { throw new Error('Offline'); });
  assert.equal(await gpt.isBusy(), false);
});

test('known running GPT remains busy across list omissions, failed reads and disconnect until confirmed complete', async t => {
  const { gpt, read, intercept, desktop } = fixture(t);
  read.thread.status = { type: 'active' }; await gpt.get('gpt-chat');
  intercept(tool => { if (tool === 'list_threads') return result({ threads: [] }); });
  assert.equal(await gpt.isBusy(), true);
  intercept(tool => { if (tool === 'list_threads') return result({ threads: [] }); if (tool === 'read_thread') throw Error('Offline'); });
  assert.equal(await gpt.isBusy(), true);
  desktop.state.connected = false; desktop.emit('state', { connected: false });
  assert.equal(gpt.cache.size, 0); assert.equal(await gpt.isBusy(), true);
  desktop.state.connected = true; read.thread.status = { type: 'idle' };
  intercept(tool => { if (tool === 'list_threads') return result({ threads: [] }); });
  assert.equal(await gpt.isBusy(), false);
});

test('in-flight and accepted GPT sends block updates even if the immediate refresh fails', async t => {
  const { gpt, intercept, read } = fixture(t);
  let release, entered, sent = false;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  intercept(async tool => {
    if (tool === 'send_message_to_thread') { sent = true; entered(); await gate; }
    if (tool === 'read_thread' && sent) throw Error('Offline');
  });
  const request = gpt.send('gpt-chat', 'mock only'); await ready;
  assert.equal(await gpt.isBusy(), true); release(); assert.equal((await request).accepted, true);
  assert.equal(await gpt.isBusy(), true);
  intercept(() => undefined); read.thread.status = { type: 'idle' };
  assert.equal(await gpt.isBusy(), false);
});

test('a send starting during an idle check prevents an obsolete idle result', async t => {
  const { gpt, intercept } = fixture(t);
  await gpt.get('gpt-chat');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  intercept(async tool => { if (tool === 'list_threads') { entered(); await gate; return result({ threads: [] }); } });
  const checking = gpt.isBusy(); await ready;
  assert.equal((await gpt.send('gpt-chat', 'concurrent mock')).accepted, true);
  release(); assert.equal(await checking, true);
  assert.equal(await gpt.isBusy(), false);
});
