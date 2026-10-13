import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { Tasks, stageView } from '../lib/tasks.mjs';

const copy = value => structuredClone(value);
const catalog = [
  { id: 'picker-alpha', model: 'model-alpha', displayName: 'Alpha', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }] },
  { id: 'picker-beta', model: 'model-beta', displayName: 'Beta', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }] },
];
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

test('recent views retain the latest ten turns with complete primary messages and a stable validator', () => {
  const messages = Array.from({ length: 18 }, (_, i) => [
    { id: `user-${i}`, turnId: `turn-${i}`, role: 'user', text: `Question ${i}` },
    { id: `tool-${i}`, turnId: `turn-${i}`, role: 'tool', text: `Command ${i}\nLong output ${i}` },
    { id: `answer-${i}`, turnId: `turn-${i}`, role: 'assistant', phase: 'final_answer', text: `Complete answer ${i}` },
  ]).flat();
  const full = { thread: { id: 'scoped', messages, readAt: 100 }, approvals: [] };
  const recent = stageView(full, 'recent');
  assert.equal(recent.thread.messages.length, 30);
  assert.equal(recent.thread.messages[0].id, 'user-8');
  assert.equal(recent.thread.messages.at(-1).text, 'Complete answer 17');
  assert.equal(recent.thread.messages[1].text, 'Command 8');
  assert.equal(recent.thread.messages[1].deferred, true);
  assert.equal(stageView({ ...full, thread: { ...full.thread, readAt: 999 } }, 'recent').revision, recent.revision);
  assert.notEqual(stageView({ ...full, thread: { ...full.thread, id: 'other' } }, 'recent').revision, recent.revision);
});

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.state = { connected: true, mode: 'standalone', error: null };
    this.calls = [];
    this.replies = [];
    this.errors = [];
    this.threads = new Map();
    this.handlers = new Map();
    this.turnNumber = 0;
  }
  async start() { this.state.connected = true; this.emit('state', copy(this.state)); }
  async request(method, params = {}) {
    this.calls.push({ method, params: copy(params) });
    if (this.handlers.has(method)) return this.handlers.get(method)(params);
    if (method === 'model/list') return { data: copy(catalog) };
    if (method === 'thread/start') {
      const thread = { id: `mobile-${this.threads.size + 1}`, cwd: params.cwd, updatedAt: Math.floor(Date.now() / 1000), status: { type: 'idle' }, turns: [], model: params.model, reasoningEffort: params.config?.model_reasoning_effort };
      this.threads.set(thread.id, thread);
      return { thread: copy(thread) };
    }
    if (method === 'thread/list') return { data: copy([...this.threads.values()]) };
    const thread = this.threads.get(params.threadId);
    if (!thread) throw new Error('No fake thread');
    if (method === 'thread/fork') {
      const fork = { ...copy(thread), id: `mobile-${this.threads.size + 1}`, status: { type: 'idle' }, model: params.model || thread.model, reasoningEffort: params.config?.model_reasoning_effort || thread.reasoningEffort, forkedFromId: thread.id };
      this.threads.set(fork.id, fork);
      return { thread: copy(fork), model: fork.model, reasoningEffort: fork.reasoningEffort };
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: copy(thread) };
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.turnNumber}`, status: 'inProgress', items: [] };
      thread.model = params.model || thread.model;
      thread.reasoningEffort = params.effort || thread.reasoningEffort;
      thread.turns.push(turn); thread.status = { type: 'active' };
      return { turn: copy(turn) };
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    if (method === 'turn/interrupt') { this.finish(params.threadId, 'interrupted'); return {}; }
    throw new Error(`Unsupported fake RPC: ${method}`);
  }
  reply(id, result) { this.replies.push({ id, result: copy(result) }); }
  replyError(id, message, code = -32601) {
    assert.equal(typeof message, 'string', 'RPC error.message must be a string');
    this.errors.push({ id, message, code });
  }
  event(method, params) { this.emit('notification', { method, params }); }
  finish(threadId, status = 'completed', error = null) {
    const thread = this.threads.get(threadId);
    const turn = thread.turns.at(-1);
    turn.status = status; turn.error = error;
    thread.status = { type: 'idle' };
    this.event('turn/completed', { threadId, turn: copy(turn) });
  }
  item(threadId, item) {
    const turn = this.threads.get(threadId).turns.at(-1);
    const index = turn.items.findIndex(v => v.id === item.id);
    if (index === -1) turn.items.push(copy(item)); else turn.items[index] = copy(item);
    this.event('item/completed', { threadId, turnId: turn.id, item: copy(item) });
  }
}

async function fixture(t) {
  const work = fileURLToPath(new URL('../../../../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(path.join(work, 'codex-tasks-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = new FakeBridge();
  const tasks = new Tasks(bridge, directory, directory);
  return { tasks, bridge, directory };
}

function approval(bridge, tasks, threadId, method, extra = {}) {
  const rpcId = `request-${Math.random()}`;
  bridge.emit('request', { id: rpcId, method, params: { threadId, ...extra } });
  return { rpcId, pending: [...tasks.approvals.values()].find(value => value.rpcId === rpcId) };
}

test('generated image saved paths remain primary output without copying binary results or input image views', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  const savedPath = path.join(directory, 'generated.png');
  const items = [
    { id: 'input-image', type: 'imageView', path: path.join(directory, 'input.png') },
    { id: 'output-image', type: 'imageGeneration', status: 'completed', savedPath, result: 'SECRET_BINARY_RESULT', revisedPrompt: 'PRIVATE_METADATA' },
    { id: 'unsaved-image', type: 'imageGeneration', status: 'completed', result: 'SECRET_BINARY_RESULT' },
  ];
  bridge.threads.set('image-chat', { id: 'image-chat', cwd: directory, status: { type: 'idle' }, turns: [{ id: 'image-turn', status: 'completed', items }] });
  const view = await tasks.get('image-chat', { stage: 'recent' });
  assert.deepEqual(view.thread.messages.map(message => message.id), ['output-image']);
  assert.equal(view.thread.messages[0].role, 'assistant'); assert.equal(view.thread.messages[0].deferred, undefined);
  assert.deepEqual(view.thread.messages[0].generatedImage, { savedPath });
  assert(!JSON.stringify(view).includes('SECRET_BINARY_RESULT')); assert(!JSON.stringify(view).includes('PRIVATE_METADATA'));
  bridge.event('item/completed', { threadId: 'image-chat', turnId: 'image-turn', item: { ...items[1], id: 'streamed-image' } });
  assert.equal(tasks.cache.get('image-chat').messages.at(-1).generatedImage.savedPath, savedPath);
});

test('create persists ownership, uses workspace permission defaults, and starts the exact prompt', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  const result = await tasks.create('  创建一个报告  ');
  assert.equal(result.thread.readOnly, false);
  assert.equal(result.thread.status, 'running');
  assert.equal(result.thread.messages[0].text, '创建一个报告');
  assert.equal(result.thread.messages[0].delivery, 'sent');
  const start = bridge.calls.find(call => call.method === 'thread/start');
  assert.equal(start.params.cwd.toLowerCase(), directory.toLowerCase());
  assert.equal(start.params.approvalPolicy, 'on-request');
  assert.equal(start.params.sandbox, 'workspace-write');
  assert.deepEqual(bridge.calls.find(call => call.method === 'turn/start').params.input, [{ type: 'text', text: '创建一个报告', text_elements: [] }]);
  const restored = new Tasks(new FakeBridge(), directory, directory);
  assert(restored.owned.has(result.thread.id));
  assert.equal((await tasks.list())[0].readOnly, false);
});

test('streams assistant and command output, steers a running turn, and interrupts it', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('开始工作');
  bridge.event('item/started', { threadId: thread.id, item: { id: 'assistant-1', type: 'agentMessage', text: '' } });
  bridge.event('item/agentMessage/delta', { threadId: thread.id, itemId: 'assistant-1', delta: '正在' });
  bridge.event('item/agentMessage/delta', { threadId: thread.id, itemId: 'assistant-1', delta: '检查' });
  bridge.event('item/commandExecution/outputDelta', { threadId: thread.id, itemId: 'cmd-1', delta: 'test passed' });
  const streamed = await tasks.get(thread.id);
  assert.equal(streamed.thread.messages.find(v => v.id === 'assistant-1').text, '正在检查');
  assert.equal(streamed.thread.messages.find(v => v.id === 'cmd-1').text, 'test passed');
  await tasks.send(thread.id, '增加图表');
  const steer = bridge.calls.find(call => call.method === 'turn/steer');
  assert.equal(steer.params.expectedTurnId, thread.turnId);
  assert.equal(steer.params.input[0].text, '增加图表');
  assert.equal(bridge.calls.filter(call => call.method === 'turn/start').length, 1);
  await tasks.stop(thread.id);
  assert.equal(bridge.calls.at(-1).method, 'turn/interrupt');
  assert.equal(tasks.cache.get(thread.id).status, 'idle');
  assert.equal(tasks.cache.get(thread.id).turnId, null);
});

test('completion reconciles durable output, removes approval, and a later message starts a fresh turn', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('先检查');
  approval(bridge, tasks, thread.id, 'item/fileChange/requestApproval');
  bridge.item(thread.id, { id: 'final-1', type: 'agentMessage', text: '已完成' });
  bridge.finish(thread.id);
  assert.equal(tasks.approvals.size, 0);
  const finished = await tasks.get(thread.id);
  assert.equal(finished.thread.status, 'idle');
  assert.equal(finished.thread.turnId, null);
  assert.deepEqual(finished.thread.messages.map(message => message.text), ['先检查', '已完成']);
  await tasks.send(thread.id, '继续下一步');
  assert.equal(bridge.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(bridge.calls.filter(call => call.method === 'turn/steer').length, 0);
});

test('desktop running history refreshes after cache expiry and cannot be written', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  bridge.threads.set('desktop', { id: 'desktop', cwd: directory, updatedAt: 1, status: { type: 'notLoaded' }, turns: [{ id: 'desktop-turn', status: 'inProgress', items: [] }] });
  assert.equal((await tasks.get('desktop')).thread.status, 'running');
  const stored = bridge.threads.get('desktop');
  stored.turns[0].status = 'completed';
  stored.turns[0].items.push({ id: 'new-message', type: 'agentMessage', text: '桌面已完成' });
  tasks.cache.get('desktop').readAt = Date.now() - 4000;
  const refreshed = await tasks.get('desktop');
  assert.equal(refreshed.thread.status, 'idle');
  assert.equal(refreshed.thread.messages[0].text, '桌面已完成');
  assert.equal(refreshed.thread.readOnly, true);
  await assert.rejects(tasks.send('desktop', '执行操作'), { status: 403 });
  await assert.rejects(tasks.stop('desktop'), { status: 403 });
  assert(bridge.calls.every(call => call.method === 'thread/read'));
});

test('command and file approvals accept only one-off explicit decisions', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    for (const decision of ['accept', 'decline']) {
      const { rpcId, pending } = approval(bridge, tasks, thread.id, method);
      assert.throws(() => tasks.answer(pending.id, { decision: 'acceptForSession' }), { status: 400 });
      assert.equal(tasks.view(tasks.cache.get(thread.id)).approvals[0].rpcId, undefined);
      tasks.answer(pending.id, { decision });
      assert.deepEqual(bridge.replies.at(-1), { id: rpcId, result: { decision } });
      assert.throws(() => tasks.answer(pending.id, { decision }), { status: 404 });
    }
  }
});

test('permission approvals grant only requested permissions for one turn', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  const permissions = { network: { enabled: true } };
  const accepted = approval(bridge, tasks, thread.id, 'item/permissions/requestApproval', { permissions });
  tasks.answer(accepted.pending.id, { decision: 'accept', permissions: { fileSystem: { write: ['C:\\'] } }, scope: 'session' });
  assert.deepEqual(bridge.replies.at(-1).result, { permissions, scope: 'turn' });
  const declined = approval(bridge, tasks, thread.id, 'item/permissions/requestApproval', { permissions });
  tasks.answer(declined.pending.id, { decision: 'decline' });
  assert.deepEqual(bridge.replies.at(-1).result, { permissions: {}, scope: 'turn' });
});

test('question responses require every question and preserve protocol answer shape', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  const request = approval(bridge, tasks, thread.id, 'item/tool/requestUserInput', { questions: [{ id: 'format' }, { id: 'audience' }] });
  assert.throws(() => tasks.answer(request.pending.id, { answers: { format: 'PDF' } }), { status: 400 });
  tasks.answer(request.pending.id, { answers: { format: 'PDF', audience: { answers: ['同事'] }, unsolicited: 'ignored' } });
  assert.deepEqual(bridge.replies.at(-1).result, { answers: { format: { answers: ['PDF'] }, audience: { answers: ['同事'] } } });
});

test('unknown owned requests are rejected; another client requests are untouched; resolved approvals disappear', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  const unknown = approval(bridge, tasks, thread.id, 'item/unknown');
  assert.equal(unknown.pending, undefined);
  assert.equal(bridge.errors.at(-1).id, unknown.rpcId);
  assert.equal(bridge.errors.at(-1).code, -32601);
  const errors = bridge.errors.length;
  approval(bridge, tasks, 'desktop-other', 'item/commandExecution/requestApproval');
  assert.equal(bridge.errors.length, errors);
  assert.equal(tasks.approvals.size, 0);
  const pending = approval(bridge, tasks, thread.id, 'item/commandExecution/requestApproval');
  bridge.event('serverRequest/resolved', { threadId: thread.id, requestId: pending.rpcId });
  assert.equal(tasks.approvals.size, 0);
});

test('a concurrent duplicate send is rejected and the lock is released afterward', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  const entered = deferred();
  const release = deferred();
  bridge.handlers.set('turn/steer', async () => { entered.resolve(); return release.promise; });
  const first = tasks.send(thread.id, '第一条');
  await entered.promise;
  await assert.rejects(tasks.send(thread.id, '重复提交'), { status: 409 });
  release.resolve({ turnId: thread.turnId });
  await first;
  bridge.handlers.delete('turn/steer');
  await tasks.send(thread.id, '锁已释放');
  assert.equal(bridge.calls.filter(call => call.method === 'turn/steer').length, 2);
});

test('disconnect clears live approvals and a later send resumes the owned task', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  approval(bridge, tasks, thread.id, 'item/fileChange/requestApproval');
  bridge.state.connected = false;
  bridge.emit('state', { connected: false, mode: 'standalone' });
  assert.equal(tasks.approvals.size, 0);
  assert.equal(tasks.loaded.size, 0);
  assert.equal(tasks.cache.get(thread.id).status, 'error');
  bridge.threads.get(thread.id).turns.at(-1).status = 'completed';
  bridge.threads.get(thread.id).status = { type: 'idle' };
  tasks.cache.get(thread.id).readAt = 0;
  await tasks.send(thread.id, '连接恢复后继续');
  assert(bridge.calls.some(call => call.method === 'thread/resume' && call.params.threadId === thread.id));
});

test('invalid prompts and nonexistent working directories never create a task', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  for (const prompt of ['', ' ', null, 'x'.repeat(30001)]) await assert.rejects(tasks.create(prompt), { status: 400 });
  await assert.rejects(tasks.create('工作', 'relative/path'), { status: 400 });
  await assert.rejects(tasks.create('工作', path.join(directory, 'not-there')), { status: 400 });
  assert.equal(bridge.calls.length, 0);
});

test('failed execution surfaces its error and clears the active turn', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  bridge.finish(thread.id, 'failed', { message: '模型连接中断' });
  const result = await tasks.get(thread.id);
  assert.equal(result.thread.status, 'error');
  assert.equal(result.thread.error, '模型连接中断');
  assert.equal(result.thread.turnId, null);
});

test('a rejected start releases the send lock and permits a later successful retry', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  bridge.finish(thread.id);
  await tasks.get(thread.id);
  bridge.handlers.set('turn/start', async () => { throw new Error('Temporary RPC failure'); });
  await assert.rejects(tasks.send(thread.id, '第一次重试'), /Temporary RPC failure/);
  assert.equal(tasks.cache.get(thread.id).status, 'error');
  assert.equal(tasks.locks.has(thread.id), false);
  bridge.handlers.delete('turn/start');
  const retried = await tasks.send(thread.id, '第二次重试');
  assert.equal(retried.thread.status, 'running');
});

test('a completion event received before start response cannot revive the completed turn', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  bridge.finish(thread.id);
  await tasks.get(thread.id);
  bridge.handlers.set('turn/start', async () => {
    const turn = { id: 'fast-turn', status: 'completed', items: [] };
    bridge.threads.get(thread.id).turns.push(turn);
    bridge.event('turn/completed', { threadId: thread.id, turn });
    return { turn: { ...turn, status: 'inProgress' } };
  });
  const result = await tasks.send(thread.id, '极快完成');
  assert.equal(result.thread.status, 'idle');
  assert.equal(result.thread.turnId, null);
});

test('terminal turn snapshots end running state even without a completion notification', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  bridge.finish(thread.id);
  await tasks.get(thread.id);
  for (const status of ['completed', 'interrupted', 'failed']) {
    bridge.handlers.set('turn/start', async () => {
      const turn = { id: `instant-${status}`, status, items: [], error: status === 'failed' ? { message: 'Startup failed' } : null };
      bridge.threads.get(thread.id).turns.push(turn);
      return { turn };
    });
    const result = await tasks.send(thread.id, status);
    assert.equal(result.thread.status, status === 'failed' ? 'error' : 'idle');
    assert.equal(result.thread.turnId, null);
    if (status === 'failed') assert.equal(result.thread.error, 'Startup failed');
  }
});

test('selected catalog model and effort reach both thread creation and turn execution', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('选择模型', undefined, { model: 'picker-beta', effort: 'high' });
  const start = bridge.calls.find(call => call.method === 'thread/start');
  assert.equal(start.params.model, 'model-beta');
  assert.deepEqual(start.params.config, { model_reasoning_effort: 'high' });
  assert.equal(start.params.reasoningEffort, undefined);
  const turn = bridge.calls.find(call => call.method === 'turn/start');
  assert.equal(turn.params.model, 'model-beta');
  assert.equal(turn.params.effort, 'high');
  assert.equal(turn.params.reasoningEffort, undefined);
  assert.equal(thread.model, 'model-beta');
  assert.equal(thread.effort, 'high');
  assert.equal((await tasks.list())[0].model, 'model-beta');
  assert.equal(tasks.owned.get(thread.id).effort, 'high');
});

test('model changes wait for the current turn and are persisted for later turns', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('工作');
  const previous = bridge.calls.length;
  await assert.rejects(tasks.send(thread.id, '切换模型', { model: 'picker-beta' }), { status: 409 });
  assert.equal(bridge.calls.length, previous);
  assert.equal(tasks.cache.get(thread.id).status, 'running');
  bridge.finish(thread.id);
  await tasks.send(thread.id, '换模型继续', { model: 'picker-beta' });
  assert.equal(bridge.calls.at(-1).params.model, 'model-beta');
  assert.equal(bridge.calls.at(-1).params.effort, 'low');
  assert.equal(tasks.owned.get(thread.id).model, 'model-beta');
  bridge.finish(thread.id);
  await tasks.send(thread.id, '沿用设置');
  assert.equal(bridge.calls.at(-1).params.model, 'model-beta');
  assert.equal(bridge.calls.at(-1).params.effort, 'low');
});

test('unavailable model and unsupported effort are rejected before creating or starting work', async t => {
  const { tasks, bridge } = await fixture(t);
  await assert.rejects(tasks.create('工作', undefined, { model: 'unavailable' }), { status: 400 });
  await assert.rejects(tasks.create('工作', undefined, { model: 'model-beta', effort: 'medium' }), { status: 400 });
  assert(bridge.calls.every(call => call.method === 'model/list'));
  const { thread } = await tasks.create('工作');
  bridge.finish(thread.id);
  await assert.rejects(tasks.send(thread.id, '不支持的强度', { effort: 'unavailable' }), { status: 400 });
  assert.equal(tasks.cache.get(thread.id).status, 'idle');
  assert.equal(bridge.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('fork copies full desktop context into a new controllable thread without altering its source', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  const source = { id: 'desktop-source', name: '原始桌面任务', cwd: directory, model: 'model-alpha', reasoningEffort: 'high', status: { type: 'notLoaded' }, turns: [{ id: 'old-turn', status: 'completed', items: [{ id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: '原始问题' }] }, { id: 'old-answer', type: 'agentMessage', text: '之前的完整上下文' }] }] };
  bridge.threads.set(source.id, copy(source));
  const forked = await tasks.fork(source.id);
  assert.notEqual(forked.thread.id, source.id);
  assert.equal(forked.thread.readOnly, false);
  assert.equal(forked.thread.forkedFromId, source.id);
  assert.equal(forked.thread.messages[1].text, '之前的完整上下文');
  assert.equal(forked.thread.model, 'model-alpha');
  assert.equal(forked.thread.effort, 'high');
  assert.deepEqual(bridge.threads.get(source.id), source);
  assert.equal(tasks.owned.has(source.id), false);
  assert.equal(bridge.calls.some(call => call.method === 'turn/start'), false);
  const forkCall = bridge.calls.find(call => call.method === 'thread/fork');
  assert.equal(forkCall.params.deferGoalContinuation, true);
  assert.equal(forkCall.params.excludeTurns, false);
  assert.equal(forkCall.params.beforeTurnId, undefined);
  assert.equal(forkCall.params.sandbox, 'workspace-write');
  await tasks.send(forked.thread.id, '接着完成');
  assert.equal(bridge.calls.at(-1).params.threadId, forked.thread.id);
  await assert.rejects(tasks.send(source.id, '误改原任务'), { status: 403 });
});

test('fork can start a follow-up using a newly selected model and rejects reused source IDs', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  const source = { id: 'desktop', cwd: directory, model: 'model-alpha', reasoningEffort: 'medium', status: { type: 'notLoaded' }, turns: [] };
  bridge.threads.set(source.id, source);
  const forked = await tasks.fork(source.id, { prompt: '继续', model: 'picker-beta', effort: 'high' });
  const start = bridge.calls.find(call => call.method === 'turn/start');
  assert.equal(start.params.threadId, forked.thread.id);
  assert.equal(start.params.model, 'model-beta');
  assert.equal(start.params.effort, 'high');
  bridge.handlers.set('thread/fork', async () => ({ thread: copy(source) }));
  await assert.rejects(tasks.fork(source.id), { status: 502 });
  assert.equal(tasks.owned.has(source.id), false);
});

test('thread listing walks every page and retains older project directories', async t => {
  const { tasks, bridge } = await fixture(t);
  bridge.handlers.set('thread/list', async params => params.cursor
    ? { data: [{ id: 'older-project', cwd: 'D:\\OlderProject', model: 'model-beta', reasoningEffort: 'low', status: { type: 'notLoaded' } }], nextCursor: null }
    : { data: [{ id: 'new-project', cwd: 'D:\\NewProject', status: { type: 'notLoaded' } }], nextCursor: 'second-page' });
  const [a, b] = await Promise.all([tasks.list(), tasks.list()]);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert(a.some(thread => thread.cwd === 'D:\\OlderProject'));
  assert.equal(a.find(thread => thread.id === 'older-project').effort, 'low');
  assert.equal(bridge.calls.filter(call => call.method === 'thread/list').length, 2);
});

test('large thread catalogs stop at 5000 and advertise incomplete results', async t => {
  const { tasks, bridge } = await fixture(t);
  bridge.handlers.set('thread/list', async params => {
    const page = Number(params.cursor || 0);
    return { data: Array.from({ length: 100 }, (_, index) => ({ id: `thread-${page * 100 + index}`, cwd: `D:\\Project${page}`, status: { type: 'notLoaded' } })), nextCursor: String(page + 1) };
  });
  assert.equal((await tasks.list()).length, 5000);
  assert.equal(tasks.listComplete, false);
  assert.equal(tasks.listNextCursor, '50');
  assert.equal(bridge.calls.length, 50);
});

test('CLI sends stay visible through missing item notifications and a service restart', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  const created = await tasks.create('First phone instruction');
  const id = created.thread.id;
  const firstId = created.thread.messages[0].id;
  const sent = await tasks.send(id, 'Second phone instruction');
  assert.equal(sent.accepted, true);
  assert.deepEqual(sent.thread.messages.map(message => message.text), ['First phone instruction', 'Second phone instruction']);
  const restarted = new Tasks(bridge, directory, directory);
  const restored = await restarted.get(id);
  assert.deepEqual(restored.thread.messages.map(message => message.text), ['First phone instruction', 'Second phone instruction']);
  assert.equal(restored.thread.messages[0].id, firstId);
});

test('turn response items reconcile the echo and retain public assistant phase and turn ID', async t => {
  const { tasks, bridge } = await fixture(t);
  bridge.handlers.set('turn/start', async () => ({ turn: { id: 'response-turn', status: 'inProgress', items: [
    { id: 'response-user', type: 'userMessage', content: [{ type: 'text', text: 'From response' }] },
    { id: 'response-assistant', type: 'agentMessage', phase: 'commentary', text: 'Public progress' },
    { id: 'private', type: 'reasoning', text: 'Never publish', encryptedContent: 'secret' },
  ] } }));
  const result = await tasks.create('From response');
  assert.equal(result.thread.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(result.thread.messages[0].serverId, 'response-user');
  const progress = result.thread.messages.find(message => message.role === 'assistant');
  assert.equal(progress.phase, 'commentary');
  assert.equal(progress.turnId, 'response-turn');
  assert(!JSON.stringify(result).includes('Never publish'));
  assert(!JSON.stringify(result).includes('secret'));
});

test('repeated CLI prompts remain separate until each matching item is reported', async t => {
  const { tasks, bridge } = await fixture(t);
  const created = await tasks.create('Again');
  const id = created.thread.id;
  const second = await tasks.send(id, 'Again');
  const ids = second.thread.messages.map(message => message.id);
  assert.equal(new Set(ids).size, 2);
  bridge.item(id, { id: 'real-first', type: 'userMessage', content: [{ type: 'text', text: 'Again' }] });
  assert.deepEqual((await tasks.get(id)).thread.messages.map(message => message.id), ids);
  bridge.item(id, { id: 'real-second', type: 'userMessage', content: [{ type: 'text', text: 'Again' }] });
  const complete = (await tasks.get(id)).thread.messages;
  assert.deepEqual(complete.map(message => message.id), ids);
  assert.deepEqual(complete.map(message => message.serverId), ['real-first', 'real-second']);
});

test('a failed or still-pending CLI submission is not labelled as accepted', async t => {
  const { tasks, bridge } = await fixture(t);
  const created = await tasks.create('Accepted');
  const id = created.thread.id;
  const gate = deferred();
  const entered = deferred();
  bridge.handlers.set('turn/steer', async () => { entered.resolve(); return gate.promise; });
  const pending = tasks.send(id, 'Not confirmed');
  await entered.promise;
  assert.deepEqual((await tasks.get(id)).thread.messages.map(message => message.text), ['Accepted']);
  gate.reject(new Error('Timed out'));
  await assert.rejects(pending, /Timed out/);
  assert.deepEqual((await tasks.get(id)).thread.messages.map(message => message.text), ['Accepted']);
  assert.equal(tasks.submitted.records.length, 1);
});

test('standalone views advertise real owned capabilities and keep desktop history read-only', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  const owned = await tasks.create('Owned task');
  assert.deepEqual(owned.thread.capabilities, { send: true, stop: true, steer: true, attachments: true, approvals: true, modelSelection: true, effortSelection: true, fork: true });
  bridge.threads.set('history', { id: 'history', cwd: directory, status: { type: 'idle' }, turns: [] });
  const history = await tasks.get('history');
  assert.equal(history.thread.readOnly, true);
  assert.deepEqual(history.thread.capabilities, { send: false, stop: false, steer: false, attachments: false, approvals: false, modelSelection: false, effortSelection: false, fork: true });
});

test('stop loads an uncached owned thread and interrupts only its active turn without resuming it', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  const first = await tasks.create('First task');
  const second = await tasks.create('Other task');
  const restarted = new Tasks(bridge, directory, directory);
  bridge.calls.length = 0;
  assert.equal(restarted.cache.size, 0);
  assert.deepEqual(await restarted.stop(first.thread.id), { ok: true, requested: true });
  assert.deepEqual(bridge.calls, [
    { method: 'thread/read', params: { threadId: first.thread.id, includeTurns: true } },
    { method: 'turn/interrupt', params: { threadId: first.thread.id, turnId: first.thread.turnId } },
  ]);
  assert.equal(bridge.threads.get(second.thread.id).turns.at(-1).status, 'inProgress');
});

test('a pending turn start with no turn ID cannot report that a stop was requested', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('Initial task');
  bridge.finish(thread.id);
  const entered = deferred();
  const gate = deferred();
  bridge.handlers.set('turn/start', async () => { entered.resolve(); return gate.promise; });
  const starting = tasks.send(thread.id, 'Next turn');
  await entered.promise;
  assert.equal(tasks.cache.get(thread.id).turnId, null);
  await assert.rejects(tasks.stop(thread.id), error => error.status === 409 && /尚未取得可停止的轮次/.test(error.message));
  assert.equal(bridge.calls.filter(call => call.method === 'turn/interrupt').length, 0);
  assert.equal(tasks.cache.get(thread.id).status, 'running');
  gate.resolve({ turn: { id: 'pending-turn', status: 'inProgress', items: [] } });
  await starting;
  bridge.handlers.set('turn/interrupt', async () => ({}));
  assert.deepEqual(await tasks.stop(thread.id), { ok: true, requested: true });
  assert.deepEqual(bridge.calls.at(-1).params, { threadId: thread.id, turnId: 'pending-turn' });
  assert.equal(tasks.cache.get(thread.id).status, 'running', 'RPC acceptance must not fabricate a completion notification');
});

test('stop propagates read and interrupt failures and releases its lock for retry', async t => {
  const { tasks, bridge, directory } = await fixture(t);
  const { thread } = await tasks.create('Task');
  const restarted = new Tasks(bridge, directory, directory);
  bridge.handlers.set('thread/read', async () => { throw new Error('Read unavailable'); });
  await assert.rejects(restarted.stop(thread.id), /Read unavailable/);
  assert.equal(bridge.calls.filter(call => call.method === 'turn/interrupt').length, 0);
  bridge.handlers.delete('thread/read');
  bridge.handlers.set('turn/interrupt', async () => { throw new Error('Interrupt rejected'); });
  await assert.rejects(restarted.stop(thread.id), /Interrupt rejected/);
  assert.equal(restarted.cache.get(thread.id).status, 'running');
  bridge.handlers.delete('turn/interrupt');
  assert.deepEqual(await restarted.stop(thread.id), { ok: true, requested: true });
  assert.equal(bridge.calls.filter(call => call.method === 'turn/interrupt').length, 2);
});

test('concurrent stops send one scoped request and reject new sends until it settles', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('Task');
  const entered = deferred();
  const gate = deferred();
  bridge.handlers.set('turn/interrupt', async () => { entered.resolve(); return gate.promise; });
  const stopping = tasks.stop(thread.id);
  await entered.promise;
  const callCount = bridge.calls.length;
  await assert.rejects(tasks.stop(thread.id), { status: 409 });
  await assert.rejects(tasks.send(thread.id, 'Not during stop'), { status: 409 });
  assert.equal(bridge.calls.length, callCount);
  gate.resolve({});
  assert.deepEqual(await stopping, { ok: true, requested: true });
  assert.equal(bridge.calls.filter(call => call.method === 'turn/interrupt').length, 1);
  await tasks.send(thread.id, 'After request settled');
  assert.equal(bridge.calls.at(-1).method, 'turn/steer');
});

test('an idle owned thread cannot report a successful stop without an interrupt request', async t => {
  const { tasks, bridge } = await fixture(t);
  const { thread } = await tasks.create('Task');
  bridge.finish(thread.id);
  await assert.rejects(tasks.stop(thread.id), error => error.status === 409 && /没有可停止/.test(error.message));
  assert.equal(bridge.calls.filter(call => call.method === 'turn/interrupt').length, 0);
  assert.equal((await tasks.get(thread.id)).thread.status, 'idle');
});
