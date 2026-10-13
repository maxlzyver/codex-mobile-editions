import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { DesktopTasks } from '../lib/desktop-tasks.mjs';
import { AccessError } from '../lib/security.mjs';
import { SubmittedMessages } from '../lib/submitted-messages.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const clone = value => structuredClone(value);
const result = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const local = (id, extra = {}) => ({ id, kind: 'codex', hostId: 'local', title: `原生 ${id}`, cwd: 'C:\\project', status: { type: 'idle' }, updatedAt: 1700000000000, ...extra });

class Companion {
  constructor() {
    this.defaultCwd = 'C:\\project';
    this.cache = new Map(); this.owned = new Map(); this.calls = []; this.listComplete = true; this.listNextCursor = null;
    this.rows = [{ id: 'desktop', title: 'Saved desktop', cwd: this.defaultCwd, status: 'idle', readOnly: true, model: 'saved-model', effort: 'high' }];
    this.models = { resolve: async (options, fallback) => {
      this.calls.push({ method: 'models.resolve', options, fallback });
      if (options.model === 'invalid') throw new AccessError(400, 'Unavailable model');
      return { model: options.model === 'picker' ? 'actual-model' : options.model || fallback.model, effort: options.effort || fallback.effort || 'medium' };
    } };
  }
  validatePrompt(value) { if (typeof value !== 'string' || !value.trim() || value.length > 30000) throw new AccessError(400, 'Invalid prompt'); return value.trim(); }
  async list() { this.calls.push({ method: 'list' }); return clone(this.rows); }
  async get(id) { this.calls.push({ method: 'get', id }); return { thread: { id, title: 'Saved history', messages: [{ id: 'saved', role: 'assistant', text: 'Saved result' }], model: 'saved-model', effort: 'high', readOnly: !this.owned.has(id), status: 'idle' }, approvals: [] }; }
  async create(prompt, cwd, options) { this.calls.push({ method: 'create', prompt, cwd, options }); this.owned.set('created', {}); return this.get('created'); }
  async send(id, prompt, options) { this.calls.push({ method: 'send', id, prompt, options }); return this.get(id); }
  async stop(id) { this.calls.push({ method: 'stop', id }); return { ok: true }; }
  async fork(id, options) { this.calls.push({ method: 'fork', id, options }); this.owned.set('forked', {}); return this.get('forked'); }
  answer(id, body) { this.calls.push({ method: 'answer', id, body }); return { ok: true }; }
}

class Native extends EventEmitter {
  constructor() {
    super();
    this.options = { hostId: 'local', allowWrites: true };
    this.state = { connected: true };
    this.tools = [
      { name: 'list_threads', namespace: 'codex_app' }, { name: 'read_thread', namespace: 'codex_app' },
      { name: 'send_message_to_thread', namespace: 'codex_app', inputSchema: { properties: { model: { type: 'string' }, thinking: { enum: ['low', 'medium', 'high', 'ultra'] } } } },
    ];
    this.calls = [];
    this.listed = [local('desktop')];
    this.reads = new Map();
    this.failConnect = false;
    this.failRead = false;
    this.failWrite = null;
  }
  async connect() { if (this.failConnect) { this.state.connected = false; throw new Error('Disconnected'); } this.state.connected = true; }
  async listTools() { return this.tools; }
  async callReadOnly(tool, args, context) {
    this.calls.push({ tool, args: clone(args), context: clone(context) });
    if (this.failRead) throw new Error('Read failed');
    if (tool === 'list_threads') return result({ pinnedThreads: [local('pinned')], threads: this.listed });
    if (tool === 'read_thread') return result(this.reads.get(args.threadId) || { thread: local(args.threadId), page: { order: 'oldest-first', hasMore: false }, turns: [{ id: 'native-turn', status: 'completed', items: [{ id: 'native-message', type: 'agentMessage', text: 'Native result' }] }] });
    throw new Error('Unexpected read tool');
  }
  async call(tool, args, context) {
    this.calls.push({ tool, args: clone(args), context: clone(context) });
    if (this.failWrite) throw this.failWrite;
    return result({ threadId: args.threadId, accepted: true });
  }
}

function fixture() {
  const companion = new Companion(); const native = new Native();
  return { companion, native, tasks: new DesktopTasks(companion, native, { readCacheMs: 0, listCacheMs: 0, retryMs: 0 }) };
}

test('list merges native local and pinned threads, preserves titles, and excludes other hosts and chat kinds', async () => {
  const { tasks, companion, native } = fixture();
  native.listed.push(local('remote', { hostId: 'other-computer' }), local('chatgpt', { kind: 'chatgpt' }));
  companion.rows.push({ id: 'cli-owned', title: 'Companion task', readOnly: false }); companion.owned.set('cli-owned', {});
  native.listed.push(local('cli-owned', { title: 'Native duplicate' }));
  const list = await tasks.list();
  assert(list.some(thread => thread.id === 'pinned'));
  assert(!list.some(thread => thread.id === 'remote' || thread.id === 'chatgpt'));
  const desktop = list.find(thread => thread.id === 'desktop');
  assert.equal(desktop.title, '原生 desktop');
  assert.equal(desktop.control, 'native');
  assert.equal(desktop.readOnly, false);
  assert.equal(desktop.capabilities.stop, false);
  assert.equal(desktop.capabilities.approvals, false);
  assert.equal(desktop.model, 'saved-model');
  assert.equal(list.find(thread => thread.id === 'cli-owned').title, 'Companion task');
  assert.equal(list.find(thread => thread.id === 'cli-owned').control, 'companion');
  assert.deepEqual(native.calls[0].context, { callerThreadId: 'desktop', hostId: 'local' });
});

test('native get formats live messages and object output without exposing reasoning', async () => {
  const { tasks, native } = fixture();
  native.reads.set('desktop', { thread: local('desktop', { status: { type: 'active' } }), page: { order: 'newest-first', hasMore: true }, turns: [
    { id: 'new', status: 'inProgress', items: [{ id: 'command', type: 'commandExecution', command: 'test', output: { text: 'passed', truncated: true }, status: 'completed' }, { id: 'reasoning', type: 'reasoning', content: ['private reasoning'] }] },
    { id: 'old', status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'User prompt' }] }, { id: 'assistant', type: 'agentMessage', text: 'Answer' }] },
  ] });
  const view = await tasks.get('desktop');
  assert.equal(view.thread.native, true);
  assert.equal(view.thread.status, 'running');
  assert.equal(view.thread.turnId, 'new');
  assert.equal(view.thread.historyHasMore, true);
  assert(view.thread.messages.some(message => message.text === 'User prompt'));
  assert.equal(view.thread.messages[0].text, 'Saved result');
  assert.equal(view.thread.messages.at(-1).text, 'test\npassed');
  assert(!JSON.stringify(view).includes('private reasoning'));
  assert.deepEqual(native.calls[0].context, { callerThreadId: 'desktop', hostId: 'local' });
  assert.equal(native.calls[0].args.hostId, 'local');
});

test('native send stays in the selected conversation and omits model settings when unchanged', async () => {
  const { tasks, companion, native } = fixture();
  const view = await tasks.send('desktop', '  Continue this exact conversation  ');
  const write = native.calls.find(call => call.tool === 'send_message_to_thread');
  assert.deepEqual(write.args, { threadId: 'desktop', hostId: 'local', prompt: 'Continue this exact conversation' });
  assert.deepEqual(write.context, { callerThreadId: 'desktop', hostId: 'local' });
  assert.equal(view.thread.id, 'desktop');
  assert.equal(view.thread.control, 'native');
  assert.equal(view.accepted, true);
  assert.equal(view.thread.messages.at(-1).text, 'Continue this exact conversation');
  assert.equal(view.thread.messages.at(-1).delivery, 'sent');
  assert(!companion.calls.some(call => call.method === 'send' || call.method === 'models.resolve' || call.method === 'create'));
});

test('explicit native model choices are validated and effort maps to thinking', async () => {
  const { tasks, companion, native } = fixture();
  await tasks.send('desktop', 'Continue', { model: 'picker', effort: 'high' });
  const write = native.calls.find(call => call.tool === 'send_message_to_thread');
  assert.equal(write.args.model, 'actual-model');
  assert.equal(write.args.thinking, 'high');
  assert.equal(write.args.effort, undefined);
  assert(companion.calls.some(call => call.method === 'models.resolve'));
  const count = native.calls.filter(call => call.tool === 'send_message_to_thread').length;
  await assert.rejects(tasks.send('desktop', 'Invalid model', { model: 'invalid' }), { status: 400 });
  assert.equal(native.calls.filter(call => call.tool === 'send_message_to_thread').length, count);
});

test('unknown native model is not replaced by a default and unsupported overrides are rejected', async () => {
  const { tasks, native, companion } = fixture();
  companion.get = async id => ({ thread: { id, messages: [], model: null, effort: null }, approvals: [] });
  assert.equal((await tasks.get('desktop')).thread.model, null);
  await assert.rejects(tasks.send('desktop', 'Effort alone', { effort: 'high' }), { status: 400 });
  native.tools.find(tool => tool.name === 'send_message_to_thread').inputSchema.properties = {};
  assert.equal((await tasks.get('desktop')).thread.capabilities.modelSelection, false);
  await assert.rejects(tasks.send('desktop', 'Override', { model: 'picker' }), { status: 409 });
  assert(!native.calls.some(call => call.tool === 'send_message_to_thread'));
});

test('native write failure never falls back to CLI and warns about uncertain acceptance', async () => {
  const { tasks, companion, native } = fixture();
  native.failWrite = new Error('Timeout after submitting');
  await assert.rejects(tasks.send('desktop', 'Continue'), error => error.status === 502 && /可能已经被接受/.test(error.message));
  assert.equal(native.calls.filter(call => call.tool === 'send_message_to_thread').length, 1);
  assert(!companion.calls.some(call => ['send','create','fork'].includes(call.method)));
  assert.equal(tasks.locks.size, 0);
  assert.equal(tasks.submitted.records.length, 0);
});

test('an accepted native write is not reported as failed when its status refresh fails', async () => {
  const { tasks, companion, native } = fixture();
  const original = native.call.bind(native);
  native.call = async (...args) => { const response = await original(...args); native.failRead = true; return response; };
  const view = await tasks.send('desktop', 'Continue');
  assert.equal(view.accepted, true);
  assert.equal(view.refreshPending, true);
  assert.equal(view.thread.status, 'running');
  assert.equal(view.thread.messages.at(-1).text, 'Continue');
  assert.equal(view.thread.messages.at(-1).delivery, 'sent');
  assert(!companion.calls.some(call => call.method === 'send'));
});

test('unavailable native reads downgrade to saved read-only history and writes are refused', async () => {
  const { tasks, companion, native } = fixture();
  native.failConnect = true; native.state.connected = false;
  const listed = await tasks.list();
  assert.equal(listed[0].readOnly, true);
  assert.equal(listed[0].control, 'readOnly');
  const view = await tasks.get('desktop');
  assert.equal(view.thread.messages[0].text, 'Saved result');
  assert.equal(view.thread.native, false);
  assert.equal(view.thread.capabilities.send, false);
  await assert.rejects(tasks.send('desktop', 'Should not send'), { status: 409 });
  assert(!companion.calls.some(call => call.method === 'send'));
});

test('nonlocal native records cannot be targeted for writes', async () => {
  const { tasks, native, companion } = fixture();
  native.reads.set('remote', { thread: local('remote', { hostId: 'other-computer' }), turns: [] });
  await assert.rejects(tasks.send('remote', 'No remote hosts'), { status: 403 });
  assert(!native.calls.some(call => call.tool === 'send_message_to_thread'));
  assert(!companion.calls.some(call => call.method === 'send'));
  native.options.hostId = 'other-computer';
  assert.throws(() => new DesktopTasks(companion, native), /只支持当前电脑/);
});

test('companion tasks retain their original bridge and expose existing controls', async () => {
  const { tasks, companion, native } = fixture();
  companion.owned.set('owned', {});
  assert.equal((await tasks.get('owned')).thread.control, 'companion');
  await tasks.send('owned', 'Continue', { model: 'picker' });
  await tasks.stop('owned');
  tasks.answer('approval', { decision: 'accept' });
  assert.equal((await tasks.create('New', 'C:\\project', { model: 'picker' })).thread.control, 'companion');
  assert.equal((await tasks.fork('desktop', { prompt: 'Branch' })).thread.control, 'companion');
  assert.equal(native.calls.length, 0);
  assert.equal(tasks.models, companion.models);
  assert.equal(tasks.cache, companion.cache);
  assert.equal(tasks.owned, companion.owned);
  assert.equal(tasks.defaultCwd, companion.defaultCwd);
  assert.equal(tasks.listComplete, true);
});

test('native stop is explicit about desktop-only capability and does not send anything', async () => {
  const { tasks, companion, native } = fixture();
  await assert.rejects(tasks.stop('desktop'), error => error.status === 409 && /桌面点击停止/.test(error.message));
  assert.equal(native.calls.length, 0);
  assert(!companion.calls.some(call => call.method === 'stop'));
});

test('concurrent native sends are rejected instead of issuing duplicate messages', async () => {
  const { tasks, native } = fixture();
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  native.call = async () => { entered(); await pending; return result({ accepted: true }); };
  const first = tasks.send('desktop', 'First');
  await started;
  await assert.rejects(tasks.send('desktop', 'Second'), { status: 409 });
  release();
  await first;
  assert.equal(tasks.locks.size, 0);
});

test('native recent turns replace matching saved items while earlier saved results remain visible', async () => {
  const { tasks, companion, native } = fixture();
  companion.get = async id => ({ thread: { id, model: 'model-from-disk', effort: 'high', messages: [{ id: 'older-result', role: 'assistant', text: 'Earlier artifact link' }, { id: 'recent', role: 'assistant', text: 'Incomplete saved text' }] }, approvals: [] });
  native.reads.set('desktop', { thread: local('desktop'), page: { order: 'oldest-first', hasMore: true }, turns: [{ id: 'latest', status: 'completed', items: [{ id: 'recent', type: 'agentMessage', text: 'Complete live text' }] }] });
  const view = await tasks.get('desktop');
  assert.deepEqual(view.thread.messages.map(message => message.text), ['Earlier artifact link', 'Complete live text']);
  assert.equal(view.thread.model, 'model-from-disk');
  assert.equal(view.thread.effort, 'high');
});

test('accepted native instructions survive reload, service restart and read-only fallback', async t => {
  const work = fileURLToPath(new URL('../../../../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(path.join(work, 'native-submissions-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { companion, native } = fixture();
  companion.submitted = new SubmittedMessages(directory);
  const tasks = new DesktopTasks(companion, native, { readCacheMs: 0 });
  const sent = await tasks.send('desktop', 'Phone instruction');
  const message = sent.thread.messages.find(item => item.text === 'Phone instruction');
  assert.equal(message.delivery, 'sent');
  assert.equal((await tasks.get('desktop')).thread.messages.find(item => item.text === 'Phone instruction').id, message.id);
  companion.submitted = new SubmittedMessages(directory);
  const restarted = new DesktopTasks(companion, native, { readCacheMs: 0 });
  assert.equal((await restarted.get('desktop')).thread.messages.find(item => item.text === 'Phone instruction').id, message.id);
  native.failRead = true;
  const fallback = await restarted.get('desktop');
  assert.equal(fallback.thread.readOnly, true);
  assert.equal(fallback.thread.messages.find(item => item.text === 'Phone instruction').id, message.id);
});

test('native transcript reconciliation preserves identical sends and public commentary metadata', async () => {
  const { tasks, native } = fixture();
  await tasks.send('desktop', 'Again');
  const second = await tasks.send('desktop', 'Again');
  const receipts = second.thread.messages.filter(message => message.submitted);
  assert.equal(receipts.length, 2);
  native.reads.set('desktop', { thread: local('desktop'), page: { order: 'oldest-first' }, turns: [
    { id: 'native-turn', status: 'completed', items: [{ id: 'native-message', type: 'agentMessage', text: 'Native result' }] },
    { id: 'next-turn', status: 'inProgress', items: [
      { id: 'first-user', type: 'userMessage', content: [{ type: 'text', text: 'Again' }] },
      { id: 'second-user', type: 'userMessage', content: [{ type: 'text', text: 'Again' }] },
      { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Working now' },
      { id: 'private', type: 'reasoning', content: ['Never disclose'] },
    ] },
  ] });
  const result = await tasks.get('desktop');
  assert.deepEqual(result.thread.messages.filter(message => message.role === 'user').map(message => message.id), receipts.map(message => message.id));
  assert.deepEqual(result.thread.messages.filter(message => message.role === 'user').map(message => message.serverId), ['first-user', 'second-user']);
  const progress = result.thread.messages.find(message => message.id === 'progress');
  assert.equal(progress.phase, 'commentary');
  assert.equal(progress.turnId, 'next-turn');
  assert(!JSON.stringify(result).includes('Never disclose'));
});

test('an explicit native non-acceptance never creates a sent receipt', async () => {
  const { tasks, native } = fixture();
  native.call = async () => result({ accepted: false });
  await assert.rejects(tasks.send('desktop', 'Rejected'), { status: 502 });
  assert.equal(tasks.submitted.records.length, 0);
});

test('live transcript order wins when saved assistant precedes a newly visible user item', async () => {
  const { tasks, companion, native } = fixture();
  companion.get = async id => ({ thread: { id, messages: [
    { id: 'older', role: 'assistant', text: 'Earlier result' },
    { id: 'answer', role: 'assistant', text: 'Stale answer' },
    { id: 'stream-only', role: 'tool', text: 'Saved-only stream' },
  ] }, approvals: [] });
  native.reads.set('desktop', { thread: local('desktop'), turns: [{ id: 'turn', status: 'inProgress', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Prompt' }] },
    { id: 'answer', type: 'agentMessage', text: 'Live answer' },
  ] }] });
  const receipt = tasks.submitted.accept(tasks.submitted.begin('desktop', 'Prompt', [{ id: 'older', role: 'assistant', text: 'Earlier result' }]), 'turn');
  const view = await tasks.get('desktop');
  assert.deepEqual(view.thread.messages.map(message => message.id), ['older', receipt.id, 'answer', 'stream-only']);
  assert.equal(view.thread.messages[1].serverId, 'user');
  assert.equal(view.thread.messages[2].text, 'Live answer');
});

test('native read failures retain cached-only messages even if the CLI reader also fails', async () => {
  const { tasks, companion, native } = fixture();
  await tasks.get('desktop');
  native.failRead = true;
  const savedFallback = await tasks.get('desktop');
  assert(savedFallback.thread.messages.some(message => message.text === 'Native result'));
  companion.get = async () => { throw new Error('CLI disconnected'); };
  const cachedFallback = await tasks.get('desktop');
  assert(cachedFallback.thread.messages.some(message => message.text === 'Native result'));
  assert.equal(cachedFallback.thread.control, 'readOnly');
  assert.equal(cachedFallback.thread.capabilities.send, false);
});

test('recent native results arrive before slow history and full preload shares both reads', { timeout: 3000 }, async () => {
  const { tasks, companion, native } = fixture();
  tasks.readCacheMs = 10000;
  let release, historyReads = 0;
  const history = new Promise(resolve => { release = resolve; });
  companion.get = async id => { historyReads++; await history; return { thread: { id, messages: [{ id: 'old', role: 'assistant', text: 'Earlier answer' }] }, approvals: [] }; };
  try {
    const recent = await tasks.get('desktop', { stage: 'recent' });
    assert.equal(recent.thread.loadingStage, 'recent');
    assert(recent.thread.messages.some(item => item.text === 'Native result'));
    assert(!recent.thread.messages.some(item => item.id === 'old'));
    let fullDone = false;
    const fullPromise = tasks.get('desktop', { stage: 'full' }).then(view => { fullDone = true; return view; });
    const anotherRecent = await tasks.get('desktop', { stage: 'recent' });
    assert.equal(fullDone, false);
    assert.equal(anotherRecent.revision, recent.revision);
    release();
    const full = await fullPromise;
    assert.deepEqual(full.thread.messages.map(item => item.text), ['Earlier answer', 'Native result']);
    assert.equal(historyReads, 1);
    assert.equal(native.calls.filter(call => call.tool === 'read_thread').length, 1);
    const warmed = await tasks.get('desktop', { stage: 'recent' });
    assert.equal(warmed.thread.detailsRevision, full.thread.detailsRevision);
    assert.notEqual(warmed.revision, full.revision, 'Stage validators cannot validate another representation');
  } finally { release(); }
});

test('recent placeholders preserve order and stable identities while hidden output changes invalidate them', async () => {
  const { tasks, native } = fixture();
  await tasks.savedRead('desktop');
  const data = { thread: local('desktop'), turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Keep my question' }] },
    { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Visible progress' },
    { id: 'tool', type: 'commandExecution', command: 'npm test', output: 'First detailed output', status: 'completed' },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'The complete final answer' },
    { id: 'private', type: 'reasoning', text: 'Never expose this' },
  ] }] };
  native.reads.set('desktop', data);
  const recent = await tasks.get('desktop', { stage: 'recent' });
  assert.deepEqual(recent.thread.messages.slice(-4).map(item => item.id), ['question', 'comment', 'tool', 'answer']);
  assert.equal(recent.thread.messages.find(item => item.id === 'tool').text, 'npm test');
  assert.equal(recent.thread.messages.find(item => item.id === 'tool').deferred, true);
  assert.equal(recent.thread.messages.find(item => item.id === 'answer').text, 'The complete final answer');
  assert(!JSON.stringify(recent).includes('First detailed output'));
  assert(!JSON.stringify(recent).includes('Never expose this'));
  const unchanged = await tasks.get('desktop', { stage: 'recent' });
  assert.equal(unchanged.revision, recent.revision, 'Read timestamps alone must not change validators');
  data.turns[0].items[2].output = 'Second detailed output';
  const changed = await tasks.get('desktop', { stage: 'recent' });
  assert.notEqual(changed.revision, recent.revision);
  assert.notEqual(changed.thread.detailsRevision, recent.thread.detailsRevision);
  const full = await tasks.get('desktop');
  assert.equal(changed.thread.detailsRevision, full.thread.detailsRevision);
  assert(full.thread.messages.find(item => item.id === 'tool').text.includes('Second detailed output'));
});

test('an execution-heavy native turn cannot evict its question or complete final answer', async () => {
  const { tasks, native } = fixture();
  const finalText = 'Complete answer '.repeat(4000);
  native.reads.set('desktop', { thread: local('desktop'), turns: [{ id: 'long', status: 'completed', items: [
    { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'The original request' }] },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: finalText },
    ...Array.from({ length: 600 }, (_, index) => ({ id: `tool-${index}`, type: 'commandExecution', command: 'step', output: `log ${index}` })),
  ] }] });
  // An accepted phone message is overlaid after native truncation; the overlay
  // must apply the same priority policy instead of slicing the old question off.
  tasks.submitted.accept(tasks.submitted.begin('desktop', 'A later phone instruction', [{ id: 'answer', role: 'assistant', text: finalText }]), 'next');
  for (const stage of ['recent', 'full']) {
    const view = await tasks.get('desktop', { stage });
    assert(view.thread.messages.length <= 400);
    assert.equal(view.thread.messages.find(item => item.id === 'question').text, 'The original request');
    assert.equal(view.thread.messages.find(item => item.id === 'answer').text, finalText);
    assert(view.thread.messages.findIndex(item => item.id === 'question') < view.thread.messages.findIndex(item => item.id === 'answer'));
  }
});

test('read-only fallback never replaces a complete native answer with older cached history', async () => {
  const { tasks, companion, native } = fixture();
  companion.get = async id => ({ thread: { id, updatedAt: 1600000000000, messages: [{ id: 'native-message', role: 'assistant', text: 'Old partial saved answer' }] }, approvals: [] });
  assert.equal((await tasks.get('desktop')).thread.messages[0].text, 'Native result');
  native.failRead = true;
  const fallback = await tasks.get('desktop', { stage: 'recent' });
  assert.equal(fallback.thread.messages[0].text, 'Native result');
  assert.equal(fallback.thread.readOnly, true);
  assert.equal(fallback.thread.capabilities.send, false);
  assert(fallback.thread.nativeError);
  // A genuinely later disk transcript is still usable while native is offline.
  tasks.savedHistory.clear();
  companion.get = async id => ({ thread: { id, updatedAt: 1800000000000, status: 'idle', messages: [{ id: 'native-message', role: 'assistant', text: 'Later saved completion' }] }, approvals: [] });
  assert.equal((await tasks.get('desktop')).thread.messages[0].text, 'Later saved completion');
});

test('a full read waiting on history adopts the newer native snapshot before caching or returning', { timeout: 3000 }, async () => {
  const { tasks, companion, native } = fixture();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  companion.get = async id => { await blocked; return { thread: { id, messages: [] }, approvals: [] }; };
  const earlier = tasks.get('desktop');
  try {
    await new Promise(resolve => setImmediate(resolve));
    native.reads.set('desktop', { thread: local('desktop'), turns: [{ id: 'turn', items: [{ id: 'native-message', type: 'agentMessage', text: 'New complete answer' }] }] });
    assert.equal((await tasks.get('desktop', { stage: 'recent' })).thread.messages[0].text, 'New complete answer');
    release();
    assert.equal((await earlier).thread.messages[0].text, 'New complete answer');
    assert.equal(tasks.nativeCache.get('desktop').thread.messages[0].text, 'New complete answer');
    native.failRead = true;
    assert.equal((await tasks.get('desktop', { stage: 'recent' })).thread.messages[0].text, 'New complete answer');
  } finally { release(); }
});

test('a delayed native read cannot overwrite a newer forced refresh in the shared caches', { timeout: 3000 }, async () => {
  const { tasks, native } = fixture();
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const original = native.callReadOnly.bind(native);
  let first = true;
  native.callReadOnly = async (...args) => {
    const response = await original(...args);
    if (first) { first = false; entered(); await blocked; }
    return response;
  };
  const earlier = tasks.nativeRead('desktop', false, 'recent');
  try {
    await started;
    native.reads.set('desktop', { thread: local('desktop'), turns: [{ id: 'turn', items: [{ id: 'native-message', type: 'agentMessage', text: 'Newest forced refresh' }] }] });
    await tasks.nativeRead('desktop', true, 'recent');
    release(); await earlier;
    assert.equal(tasks.nativeSnapshots.get('desktop').messages[0].text, 'Newest forced refresh');
    assert.equal(tasks.nativeCache.get('desktop').thread.messages.find(item => item.id === 'native-message').text, 'Newest forced refresh');
  } finally { release(); }
});
