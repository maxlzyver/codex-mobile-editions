import { readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccessError } from './security.mjs';
import { Models } from './models.mjs';
import { SubmittedMessages } from './submitted-messages.mjs';

const clip = value => String(value || '').slice(-40000);
const active = status => status?.type === 'active' || status === 'inProgress';
const selectionConfig = selection => ({ model: selection.model, ...(selection.effort ? { config: { model_reasoning_effort: selection.effort } } : {}) });
function message(item, turnId = null, index = 0) {
  const identity = { id: item.id || `${turnId || 'unknown'}:${item.type}:${index}`, turnId };
  if (item.type === 'userMessage') return { ...identity, role: 'user', text: (item.content || []).map(c => c.text || (c.type === 'image' ? '[图片]' : '')).join('\n') };
  if (item.type === 'agentMessage') return { ...identity, role: 'assistant', text: item.text || '', phase: item.phase };
  if (item.type === 'commandExecution') return { ...identity, role: 'tool', text: clip((item.command || '') + '\n' + (item.aggregatedOutput || '')), status: item.status };
  if (item.type === 'fileChange') return { ...identity, role: 'tool', text: '文件修改\n' + (item.changes || []).map(c => `${c.path}\n${clip(c.diff)}`).join('\n'), status: item.status };
  return null;
}
export class Tasks {
  constructor(bridge, directory, defaultCwd, options = {}) {
    this.bridge = bridge;
    this.defaultCwd = defaultCwd;
    this.models = options.models || new Models(bridge);
    this.submitted = options.submitted || new SubmittedMessages(directory);
    this.file = path.join(directory, 'tasks.json');
    this.owned = new Map();
    this.cache = new Map();
    this.loaded = new Set();
    this.locks = new Set();
    this.approvals = new Map();
    this.listCache = null;
    this.listTime = 0;
    this.listPending = null;
    this.listComplete = true;
    this.listNextCursor = null;
    try { this.owned = new Map(JSON.parse(readFileSync(this.file, 'utf8'))); } catch {}
    bridge.on('notification', e => this.notification(e));
    bridge.on('request', e => this.approval(e));
    bridge.on('state', s => {
      if (!s.connected) {
        this.loaded.clear();
        this.approvals.clear();
        for (const t of this.cache.values()) if (t.status === 'running') { t.status = 'error'; t.error = '与 Codex 的连接已中断，请重新连接后查看任务。'; }
      }
    });
  }
  save() { writeFileSync(this.file, JSON.stringify([...this.owned]), { mode: 0o600 }); }
  async ready() { if (!this.bridge.state.connected) await this.bridge.start(); }
  async list() {
    await this.ready();
    if (!this.listCache || Date.now() - this.listTime > 4000) {
      if (!this.listPending) this.listPending = this.readAllThreads().finally(() => { this.listPending = null; });
      await this.listPending;
    }
    const data = new Map(this.listCache.map(t => [t.id, {
      id: t.id, title: this.owned.get(t.id)?.title || t.name || t.preview || '未命名任务', updatedAt: (t.updatedAt || t.createdAt || 0) * 1000,
      status: active(t.status) ? 'running' : 'idle', readOnly: !this.owned.has(t.id), cwd: t.cwd,
      model: t.model || this.owned.get(t.id)?.model || null, effort: t.reasoningEffort || this.owned.get(t.id)?.effort || null,
      forkedFromId: t.forkedFromId || this.owned.get(t.id)?.forkedFromId || null,
    }]));
    for (const [id, t] of this.owned) data.set(id, { ...data.get(id), id, ...t, model: this.cache.get(id)?.model || t.model || data.get(id)?.model || null, effort: this.cache.get(id)?.effort || t.effort || data.get(id)?.effort || null, readOnly: false, status: this.cache.get(id)?.status || 'idle', updatedAt: this.cache.get(id)?.updatedAt || t.updatedAt });
    return [...data.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async readAllThreads() {
    const data = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const result = await this.bridge.request('thread/list', { limit: 100, sortKey: 'updated_at', useStateDbOnly: true, ...(cursor ? { cursor } : {}) });
      for (const thread of result.data || []) data.set(thread.id, thread);
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new AccessError(502, 'Codex 任务列表分页异常，请重新连接后重试。');
      if (cursor) cursors.add(cursor);
      if (data.size >= 5000) break;
    } while (cursor);
    this.listComplete = !cursor && data.size <= 5000;
    this.listNextCursor = cursor || null;
    this.listCache = [...data.values()].slice(0, 5000);
    this.listTime = Date.now();
  }
  hydrate(thread) {
    const latest = thread.turns?.at(-1);
    const owned = this.owned.get(thread.id);
    const messages = (thread.turns || []).flatMap(turn => (turn.items || []).map((item, index) => message(item, turn.id, index)).filter(Boolean));
    return { id: thread.id, title: owned?.title || thread.name || thread.preview || '未命名任务', cwd: thread.cwd, messages: messages.slice(-400), status: active(thread.status) || latest?.status === 'inProgress' ? 'running' : latest?.status === 'failed' ? 'error' : 'idle', turnId: latest?.status === 'inProgress' ? latest.id : null, updatedAt: (thread.updatedAt || 0) * 1000, readAt: Date.now(), error: latest?.error?.message || null, model: thread.model || owned?.model || null, effort: thread.reasoningEffort || owned?.effort || null, forkedFromId: thread.forkedFromId || owned?.forkedFromId || null };
  }
  async get(id) {
    await this.ready();
    let cached = this.cache.get(id);
    if (cached && ((this.owned.has(id) && cached.status === 'running') || Date.now() - cached.readAt < 3000)) return this.view(cached);
    const { thread } = await this.bridge.request('thread/read', { threadId: id, includeTurns: true });
    cached = this.hydrate(thread);
    this.cache.set(id, cached);
    return this.view(cached);
  }
  view(t) { return { thread: { ...t, messages: this.submitted.merge(t.id, t.messages), readOnly: !this.owned.has(t.id), ...(this.submitted.warning ? { submissionWarning: this.submitted.warning } : {}) }, approvals: [...this.approvals.values()].filter(a => a.threadId === t.id).map(({ rpcId, ...a }) => a) }; }
  items(t, turn) {
    for (const [index, item] of (turn?.items || []).entries()) {
      const parsed = message(item, turn.id, index);
      if (!parsed) continue;
      const existing = t.messages.findIndex(value => value.id === parsed.id);
      if (existing < 0) t.messages.push(parsed); else t.messages[existing] = parsed;
    }
    t.messages = t.messages.slice(-400);
  }
  validatePrompt(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 30000) throw new AccessError(400, '请输入 1–30000 个字符的任务指令。');
    return prompt.trim();
  }
  async create(prompt, cwd, options = {}) {
    prompt = this.validatePrompt(prompt);
    cwd = cwd || this.defaultCwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new AccessError(400, '工作目录必须是电脑上的绝对路径。');
    try { cwd = realpathSync(cwd); if (!statSync(cwd).isDirectory()) throw new Error(); } catch { throw new AccessError(400, '工作目录不存在。'); }
    await this.ready();
    const selected = await this.models.resolve(options);
    const result = await this.bridge.request('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', experimentalRawEvents: false, allowProviderModelFallback: false, ...selectionConfig(selected) });
    const { thread } = result;
    const entry = { title: prompt.slice(0, 70), cwd, updatedAt: Date.now(), model: result.model || thread.model || selected.model, effort: result.reasoningEffort || thread.reasoningEffort || selected.effort };
    this.owned.set(thread.id, entry);
    this.save();
    this.loaded.add(thread.id);
    this.cache.set(thread.id, { id: thread.id, ...entry, messages: [], status: 'idle', readAt: Date.now() });
    this.listTime = 0;
    try { return await this.send(thread.id, prompt, selected); } catch (error) { error.threadId = thread.id; throw error; }
  }
  async fork(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new AccessError(400, '无效的接续设置。');
    const prompt = options.prompt === undefined || options.prompt === null || options.prompt === '' ? null : this.validatePrompt(options.prompt);
    await this.ready();
    const { thread: source } = await this.bridge.request('thread/read', { threadId: id, includeTurns: false });
    const selected = await this.models.resolve(options, { model: source.model, effort: source.reasoningEffort });
    const result = await this.bridge.request('thread/fork', { threadId: id, approvalPolicy: 'on-request', sandbox: 'workspace-write', excludeTurns: false, deferGoalContinuation: true, ...selectionConfig(selected) });
    const { thread } = result;
    if (!thread?.id || thread.id === id) throw new AccessError(502, 'Codex 没有返回独立的新会话，原会话保持不变。');
    const entry = { title: `${this.owned.get(id)?.title || source.name || source.preview || '桌面任务'} · 手机分支`.slice(0, 90), cwd: thread.cwd || source.cwd, updatedAt: Date.now(), model: result.model || thread.model || selected.model, effort: result.reasoningEffort || thread.reasoningEffort || selected.effort, forkedFromId: id };
    this.owned.set(thread.id, entry);
    this.save();
    this.loaded.add(thread.id);
    this.cache.set(thread.id, { ...this.hydrate({ ...thread, cwd: entry.cwd }), ...entry, status: 'idle', turnId: null, error: null });
    this.listTime = 0;
    if (prompt) {
      try { return await this.send(thread.id, prompt, selected); } catch (error) { error.threadId = thread.id; throw error; }
    }
    return this.get(thread.id);
  }
  async send(id, prompt, options = {}) {
    prompt = this.validatePrompt(prompt);
    if (!this.owned.has(id)) throw new AccessError(403, '桌面历史为只读。请新建手机任务；原有桌面任务继续在桌面端操作。');
    if (this.locks.has(id)) throw new AccessError(409, '此任务正在提交，请稍候。');
    this.locks.add(id);
    let startingTurn = false;
    try {
      await this.ready();
      await this.get(id);
      const t = this.cache.get(id);
      const selected = await this.models.resolve(options, { model: t.model, effort: t.effort });
      if (t.status === 'running' && t.turnId && ((t.model && selected.model !== t.model) || (t.effort && selected.effort !== t.effort))) {
        throw new AccessError(409, '当前任务正在运行，调整模型或推理强度需等待当前轮次结束，或先停止任务。');
      }
      if (!this.loaded.has(id)) {
        await this.bridge.request('thread/resume', { threadId: id, approvalPolicy: 'on-request', sandbox: 'workspace-write', ...selectionConfig(selected) });
        this.loaded.add(id);
      }
      const receipt = this.submitted.begin(id, prompt, t.messages, t.status === 'running' ? t.turnId : null);
      if (t.status === 'running' && t.turnId) {
        const result = await this.bridge.request('turn/steer', { threadId: id, expectedTurnId: t.turnId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
        this.submitted.accept(receipt, result.turnId || t.turnId);
      } else {
        startingTurn = true;
        t.status = 'running';
        t.error = null;
        t.turnId = null;
        const { turn } = await this.bridge.request('turn/start', { threadId: id, input: [{ type: 'text', text: prompt, text_elements: [] }], model: selected.model, ...(selected.effort ? { effort: selected.effort } : {}) });
        this.submitted.accept(receipt, turn.id);
        this.items(t, turn);
        t.model = selected.model;
        t.effort = selected.effort;
        Object.assign(this.owned.get(id), { model: selected.model, effort: selected.effort });
        try { this.save(); } catch { t.submissionWarning = '指令已发送，但模型设置暂未保存；请勿重复发送。'; }
        if (t.status === 'running') {
          if (['completed', 'interrupted', 'failed'].includes(turn.status)) {
            t.status = turn.status === 'failed' ? 'error' : 'idle';
            t.error = turn.error?.message || null;
            t.turnId = null;
          } else t.turnId = turn.id;
        }
      }
      t.updatedAt = Date.now();
      return { ...this.view(t), accepted: true, submissionId: receipt.id };
    } catch (e) {
      const t = this.cache.get(id);
      if (startingTurn && t && !t.turnId) t.status = 'error';
      throw e;
    } finally { this.locks.delete(id); }
  }
  async stop(id) {
    if (!this.owned.has(id)) throw new AccessError(403, '只能停止本控制台发起的任务。');
    const t = this.cache.get(id);
    if (t?.turnId && t.status === 'running') await this.bridge.request('turn/interrupt', { threadId: id, turnId: t.turnId });
    return { ok: true };
  }
  notification({ method, params: p = {} }) {
    const t = this.cache.get(p.threadId || p.thread?.id);
    if (method === 'serverRequest/resolved') {
      for (const [id, a] of this.approvals) if (a.rpcId === p.requestId) this.approvals.delete(id);
    }
    if (!t) return;
    if (method === 'turn/started') { t.status = 'running'; t.turnId = p.turn.id; this.items(t, p.turn); }
    if (method === 'turn/completed') {
      this.items(t, p.turn);
      t.status = p.turn.status === 'failed' ? 'error' : 'idle'; t.error = p.turn.error?.message || null; t.turnId = null; t.readAt = 0;
      for (const [id, a] of this.approvals) if (a.threadId === t.id) this.approvals.delete(id);
    }
    if (method === 'item/started' || method === 'item/completed') {
      const m = message(p.item, p.turnId || t.turnId);
      if (m) { const i = t.messages.findIndex(x => x.id === m.id); if (i < 0) t.messages.push(m); else t.messages[i] = m; }
    }
    if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
      let m = t.messages.find(x => x.id === p.itemId);
      if (!m) { m = { id: p.itemId, turnId: p.turnId || t.turnId, role: method.includes('agentMessage') ? 'assistant' : 'tool', text: '' }; t.messages.push(m); }
      m.text = clip(m.text + (p.delta || ''));
    }
    if (method === 'error') t.error = p.error?.message || '任务执行遇到错误。';
    t.updatedAt = Date.now();
  }
  approval({ id: rpcId, method, params = {} }) {
    const threadId = params.threadId;
    if (!this.owned.has(threadId)) {
      // A shared daemon may notify about another client's task. Never approve it.
      return;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval'].includes(method)) {
      this.bridge.replyError(rpcId, 'This client does not support this request type.', -32601);
      return;
    }
    const id = randomBytes(12).toString('hex');
    this.approvals.set(id, { id, rpcId, method, threadId, title: method.includes('requestUserInput') ? 'Codex 需要你的回答' : 'Codex 请求执行操作', command: params.command, reason: params.reason, questions: params.questions, permissions: params.permissions, supported: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval'].includes(method), createdAt: Date.now() });
  }
  answer(id, body) {
    const a = this.approvals.get(id);
    if (!a) throw new AccessError(404, '此请求已处理或已失效。');
    let result;
    if (a.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const q of a.questions || []) {
        const input = body.answers?.[q.id];
        const values = Array.isArray(input?.answers) ? input.answers : typeof input === 'string' ? [input] : [];
        if (!values.length || values.some(v => typeof v !== 'string' || v.length > 10000)) throw new AccessError(400, '请回答所有问题。');
        answers[q.id] = { answers: values };
      }
      result = { answers };
    } else if (a.method === 'item/permissions/requestApproval') {
      result = { permissions: body.decision === 'accept' ? (a.permissions || {}) : {}, scope: 'turn' };
    } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(a.method)) {
      if (!['accept', 'decline'].includes(body.decision)) throw new AccessError(400, '无效的审批决定。');
      result = { decision: body.decision };
    } else throw new AccessError(400, '此类型尚不支持，请在电脑端处理或停止任务。');
    this.bridge.reply(a.rpcId, result);
    this.approvals.delete(id);
    return { ok: true };
  }
}
