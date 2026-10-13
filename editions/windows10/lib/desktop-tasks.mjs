import { AccessError } from './security.mjs';
import { SubmittedMessages, transcriptMessages } from './submitted-messages.mjs';
import { retainMessages, stageView } from './tasks.mjs';

const choice = value => value !== undefined && value !== null && value !== '';
const text = value => typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : '';
const clip = value => text(value).slice(-40000);
const timestamp = value => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value || '') || 0;
const rawStatus = value => typeof value === 'string' ? value : value?.type || '';
function status(value, latest) {
  const current = rawStatus(value).toLowerCase();
  if (['active', 'running', 'inprogress', 'working', 'queued'].includes(current) || latest?.status === 'inProgress') return 'running';
  return ['error', 'failed'].includes(current) || latest?.status === 'failed' ? 'error' : 'idle';
}

function unpack(result, allowText = false) {
  const blocks = result?.contentItems || result?.content || [];
  const rendered = blocks.map(block => text(block)).filter(Boolean);
  if (result?.success === false || result?.isError) throw new Error(rendered.join('\n').slice(0, 700) || '原生 Codex 返回了失败状态。');
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const value of rendered) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.success === false || parsed.error) throw new AccessError(502, text(parsed.error?.message || parsed.error) || '原生 Codex 返回了失败状态。');
        return parsed;
      }
    } catch (error) { if (error instanceof AccessError) throw error; }
  }
  if (allowText && result?.success === true) return { message: rendered.join('\n').slice(0, 2000) };
  throw new Error('原生 Codex 返回的数据无法识别。');
}

function messages(turns) {
  return retainMessages(turns.flatMap(turn => (turn.items || []).map((item, index) => {
    const identity = { id: item.id || `${turn.id || 'unknown'}:${item.type}:${index}`, turnId: turn.id || null };
    if (item.type === 'userMessage') return { ...identity, role: 'user', text: (item.content || []).map(content => text(content.text) || (content.type === 'image' ? '[图片]' : '')).join('\n') };
    if (item.type === 'agentMessage') return { ...identity, role: 'assistant', text: text(item.text), phase: item.phase };
    if (item.type === 'commandExecution') return { ...identity, role: 'tool', text: clip(text(item.command) + '\n' + text(item.output || item.aggregatedOutput)), status: item.status };
    if (item.type === 'fileChange') return { ...identity, role: 'tool', text: '文件修改\n' + (item.changes || []).map(change => `${change.path}\n${clip(change.diff)}`).join('\n'), status: item.status };
    // Internal reasoning, context compaction, and sub-agent coordination are not chat messages.
    return null;
  }).filter(Boolean)));
}

function mergeHistory(saved, live) {
  const native = new Map(live.map(message => [message.id, message]));
  const after = new Map();
  let anchor = null;
  // Retain saved-only history/stream items next to their preceding common item.
  // Common items always take their position and contents from the live sequence.
  for (const message of new Map(saved.map(item => [item.id, item])).values()) {
    if (native.has(message.id)) { anchor = message.id; continue; }
    if (!after.has(anchor)) after.set(anchor, []);
    after.get(anchor).push(message);
  }
  return [...(after.get(null) || []), ...[...native.values()].flatMap(message => [message, ...(after.get(message.id) || [])])];
}

/**
 * Native desktop reads/writes retain the original conversation. Companion-owned
 * tasks remain on their original CLI connection. No native write is ever retried
 * through another transport: a timeout can mean the desktop already accepted it.
 */
export class DesktopTasks {
  constructor(tasks, desktopBridge, options = {}) {
    this.tasks = tasks;
    this.submitted = tasks.submitted || new SubmittedMessages();
    this.desktop = desktopBridge;
    if (desktopBridge?.options?.hostId && desktopBridge.options.hostId !== 'local') throw new Error('此控制台只支持当前电脑的原生 Codex。');
    this.nativeCache = new Map();
    this.nativeSnapshots = new Map();
    this.nativePending = new Map();
    this.nativeSequence = 0;
    this.nativeViewSequences = new Map();
    this.savedHistory = new Map();
    this.savedPending = new Map();
    this.summaries = new Map();
    this.locks = new Set();
    this.nativeList = null;
    this.nativeListTime = 0;
    this.nativeListPending = null;
    this.retryAfter = 0;
    this.lastNativeError = null;
    this.readCacheMs = options.readCacheMs ?? 1000;
    this.historyCacheMs = options.historyCacheMs ?? 30000;
    this.listCacheMs = options.listCacheMs ?? 3000;
    this.retryMs = options.retryMs ?? 5000;
    desktopBridge?.on?.('state', state => { if (!state.connected) this.nativeListTime = 0; });
  }

  get models() { return this.tasks.models; }
  get cache() { return this.tasks.cache; }
  get owned() { return this.tasks.owned; }
  get defaultCwd() { return this.tasks.defaultCwd; }
  get listComplete() { return this.tasks.listComplete; }
  get listNextCursor() { return this.tasks.listNextCursor; }
  get bridge() { return this.tasks.bridge; }

  definition(name) { return this.desktop?.tools?.find(tool => tool.name === name && (!tool.namespace || tool.namespace === 'codex_app')); }

  meta(kind, available = false) {
    if (kind === 'companion') return { source: 'companion', native: false, control: 'companion', capabilities: { send: true, stop: true, fork: true, modelSelection: true, effortSelection: true, approvals: true } };
    const send = available && this.desktop?.options?.allowWrites === true && Boolean(this.definition('send_message_to_thread'));
    const props = this.definition('send_message_to_thread')?.inputSchema?.properties || {};
    return {
      source: 'desktop', native: available, control: send ? 'native' : 'readOnly',
      capabilities: { send, stop: false, fork: true, modelSelection: send && Boolean(props.model), effortSelection: send && Boolean(props.thinking), approvals: false },
      nativeHint: available ? '直接连接原生 Codex 的同一聊天。停止任务和操作审批请在桌面端处理。' : '原生连接当前不可用，已显示保存的只读历史。',
    };
  }

  decorate(view, kind, available = false) {
    const meta = this.meta(kind, available);
    return { ...view, thread: { ...view.thread, ...(Array.isArray(view.thread.messages) ? { messages: this.submitted.merge(view.thread.id, view.thread.messages, retainMessages) } : {}), ...meta, readOnly: !meta.capabilities.send, ...(this.submitted.warning ? { submissionWarning: this.submitted.warning } : {}) } };
  }

  async tools() {
    if (!this.desktop) throw new Error('未配置原生 Codex 连接。');
    if (!this.desktop.state?.connected && Date.now() < this.retryAfter) throw new Error(this.lastNativeError || '原生 Codex 尚未连接。');
    await this.desktop.connect();
    if (!this.desktop.tools?.length) await this.desktop.listTools();
  }

  failed(error) {
    this.lastNativeError = String(error?.message || error || '原生连接失败').slice(0, 700);
    if (!this.desktop?.state?.connected) this.retryAfter = Date.now() + this.retryMs;
  }

  async nativeThreads(callerId) {
    if (this.nativeList && Date.now() - this.nativeListTime < this.listCacheMs && this.desktop?.state?.connected) return this.nativeList;
    if (this.nativeListPending) return this.nativeListPending;
    this.nativeListPending = (async () => {
      await this.tools();
      if (!callerId) throw new Error('需要当前电脑上一个真实聊天编号来读取桌面会话。');
      const payload = unpack(await this.desktop.callReadOnly('list_threads', { limit: 50 }, { callerThreadId: callerId, hostId: 'local' }));
      this.nativeList = [...(payload.pinnedThreads || []), ...(payload.threads || [])].filter(thread => thread.hostId === 'local' && thread.kind === 'codex');
      this.nativeListTime = Date.now();
      return this.nativeList;
    })().finally(() => { this.nativeListPending = null; });
    return this.nativeListPending;
  }

  async list() {
    let local = [], localError;
    try { local = await this.tasks.list(); } catch (error) { localError = error; }
    const all = new Map(local.map(thread => [thread.id, this.decorate({ thread }, this.owned.has(thread.id) ? 'companion' : 'desktop').thread]));
    for (const thread of local) this.summaries.set(thread.id, thread);
    const callerId = local[0]?.id || this.nativeCache.keys().next().value;
    try {
      for (const native of await this.nativeThreads(callerId)) {
        if (this.owned.has(native.id)) continue;
        const prior = all.get(native.id) || {};
        const thread = { ...prior, id: native.id, title: native.title || prior.title || '未命名任务', cwd: native.cwd || prior.cwd, status: status(native.status), nativeStatus: rawStatus(native.status), updatedAt: timestamp(native.updatedAt) || prior.updatedAt || 0, model: native.model || prior.model || null, effort: native.reasoningEffort || prior.effort || null, hostId: 'local', projectId: native.projectId || null };
        all.set(native.id, this.decorate({ thread }, 'desktop', true).thread);
        this.summaries.set(native.id, thread);
      }
    } catch (error) { this.failed(error); if (localError && !all.size) throw localError; }
    return [...all.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async savedRead(id) {
    const cached = this.savedHistory.get(id);
    const snapshot = this.nativeSnapshots.get(id);
    const running = snapshot && status(snapshot.data.thread.status, snapshot.turns.at(-1)) === 'running';
    const cacheMs = running ? Math.min(3000, this.historyCacheMs) : this.historyCacheMs;
    if (cached && Date.now() - cached.at < cacheMs) return cached.view;
    if (this.savedPending.has(id)) return this.savedPending.get(id);
    const pending = Promise.resolve().then(() => this.tasks.get(id)).then(view => {
      this.savedHistory.delete(id);
      this.savedHistory.set(id, { view, at: Date.now() });
      if (this.savedHistory.size > 100) this.savedHistory.delete(this.savedHistory.keys().next().value);
      return view;
    }).finally(() => this.savedPending.delete(id));
    this.savedPending.set(id, pending);
    return pending;
  }

  async nativeSnapshot(id, fresh = false) {
    const cached = this.nativeSnapshots.get(id);
    if (!fresh && cached && Date.now() - cached.readAt < this.readCacheMs && this.desktop?.state?.connected) return cached;
    if (!fresh && this.nativePending.has(id)) return this.nativePending.get(id);
    const sequence = ++this.nativeSequence;
    const pending = (async () => {
      await this.tools();
      const data = unpack(await this.desktop.callReadOnly('read_thread', { threadId: id, hostId: 'local', turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 }, { callerThreadId: id, hostId: 'local' }));
      if (data.thread?.id !== id || data.thread?.hostId !== 'local' || data.thread?.kind !== 'codex') throw new AccessError(403, '只允许读取当前电脑上的 Codex 聊天。');
      const turns = [...(data.turns || [])];
      if (/desc|newest/i.test(data.page?.order || '')) turns.reverse();
      const snapshot = { data, turns, messages: messages(turns), readAt: Date.now(), sequence };
      // A fresh read (for example after sending) may finish before an older
      // background request. Only the newer request can advance the shared cache.
      if (!this.nativeSnapshots.has(id) || this.nativeSnapshots.get(id).sequence < sequence) {
        this.nativeSnapshots.delete(id);
        this.nativeSnapshots.set(id, snapshot);
        if (this.nativeSnapshots.size > 100) this.nativeSnapshots.delete(this.nativeSnapshots.keys().next().value);
      }
      return snapshot;
    })().finally(() => { if (this.nativePending.get(id) === pending) this.nativePending.delete(id); });
    this.nativePending.set(id, pending);
    return pending;
  }

  async nativeRead(id, fresh = false, stage = 'full') {
    // Full reads fetch both sources concurrently. The first screen only waits for
    // the native ten-turn snapshot; slower saved history warms independently.
    const savedPromise = stage === 'full' ? this.savedRead(id).catch(() => null) : null;
    let snapshot = await this.nativeSnapshot(id, fresh);
    const saved = (savedPromise ? await savedPromise : this.savedHistory.get(id)?.view)?.thread;
    const newer = this.nativeSnapshots.get(id);
    if (newer && newer.sequence > snapshot.sequence) snapshot = newer;
    const { data, turns } = snapshot;
    const latest = turns.at(-1);
    const prior = saved || this.summaries.get(id) || this.tasks.cache.get(id) || {};
    const combined = mergeHistory(transcriptMessages(saved?.messages || []), snapshot.messages);
    const thread = {
      id, title: data.thread.title || prior.title || '未命名任务', cwd: data.thread.cwd || prior.cwd,
      status: status(data.thread.status, latest), nativeStatus: rawStatus(data.thread.status),
      turnId: latest?.status === 'inProgress' ? latest.id : null,
      model: data.thread.model || prior.model || null, effort: data.thread.reasoningEffort || prior.effort || null,
      messages: retainMessages(combined), updatedAt: timestamp(data.thread.updatedAt) || prior.updatedAt || 0, readAt: snapshot.readAt,
      error: latest?.error?.message || null, hostId: 'local', historyHasMore: Boolean(data.page?.hasMore),
    };
    const view = { thread, approvals: [], nativeAttention: { needsDesktop: true, message: '原生任务的停止与审批需在桌面端处理。' } };
    if (snapshot.sequence >= (this.nativeViewSequences.get(id) || 0)) {
      this.nativeCache.set(id, view);
      this.nativeViewSequences.set(id, snapshot.sequence);
    }
    if (stage === 'recent') this.savedRead(id).catch(() => {});
    return stageView(this.decorate(view, 'desktop', true), stage);
  }

  async get(id, options = {}) {
    const stage = options.stage || 'full';
    if (this.owned.has(id)) return stageView(this.decorate(await this.tasks.get(id), 'companion'), stage);
    try { return await this.nativeRead(id, false, stage); }
    catch (error) {
      this.failed(error);
      const cached = this.nativeCache.get(id);
      let saved;
      try { saved = stage === 'recent' && cached ? this.savedHistory.get(id)?.view : await this.savedRead(id); } catch (savedError) { if (!cached) throw savedError; }
      // Saved history can lag behind the native answer even when it was read
      // moments ago. It wins overlapping items only when its source timestamp
      // establishes that it contains a newer transcript; saved-only items remain.
      const savedNewer = !cached || Number(saved?.thread.updatedAt || 0) > Number(cached.thread.updatedAt || 0);
      const fallback = savedNewer ? saved : cached;
      const older = savedNewer ? cached : saved;
      const view = this.decorate({ ...fallback, thread: { ...fallback.thread, messages: retainMessages(mergeHistory(transcriptMessages(older?.thread.messages || []), transcriptMessages(fallback?.thread.messages || []))) } }, 'desktop');
      view.thread.nativeError = this.lastNativeError;
      return stageView(view, stage);
    }
  }

  async create(prompt, cwd, options = {}) { return this.decorate(await this.tasks.create(prompt, cwd, options), 'companion'); }
  async fork(id, options = {}) { return this.decorate(await this.tasks.fork(id, options), 'companion'); }
  answer(id, body) { return this.tasks.answer(id, body); }

  async send(id, prompt, options = {}) {
    if (this.owned.has(id)) return this.decorate(await this.tasks.send(id, prompt, options), 'companion');
    prompt = this.tasks.validatePrompt(prompt);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new AccessError(400, '无效的模型设置。');
    if (this.locks.has(id)) throw new AccessError(409, '此聊天正在提交指令，请稍候。');
    this.locks.add(id);
    let attempted = false;
    try {
      const view = await this.nativeRead(id, true);
      if (!view.thread.capabilities.send) throw new AccessError(409, '当前原生连接不支持发送指令，请在桌面端操作。');
      const args = { threadId: id, hostId: 'local', prompt };
      const receipt = this.submitted.begin(id, prompt, view.thread.messages);
      if (choice(options.model) || choice(options.effort)) {
        if (choice(options.model) && !view.thread.capabilities.modelSelection) throw new AccessError(409, '此原生接口不支持切换模型，请沿用桌面设置。');
        if (choice(options.effort) && !view.thread.capabilities.effortSelection) throw new AccessError(409, '此原生接口不支持切换推理强度，请沿用桌面设置。');
        if (!choice(options.model) && !view.thread.model) throw new AccessError(400, '无法确认当前桌面模型，请同时选择模型，或沿用桌面当前设置。');
        const selected = await this.models.resolve(options, { model: view.thread.model, effort: view.thread.effort });
        if (choice(options.model)) args.model = selected.model;
        if (view.thread.capabilities.effortSelection && selected.effort) args.thinking = selected.effort;
        const advertised = this.definition('send_message_to_thread')?.inputSchema?.properties?.thinking?.enum;
        if (args.thinking && Array.isArray(advertised) && !advertised.includes(args.thinking)) throw new AccessError(400, '原生桌面接口不支持所选推理强度。');
      }
      attempted = true;
      const acknowledgement = unpack(await this.desktop.call('send_message_to_thread', args, { callerThreadId: id, hostId: 'local' }), true);
      if (acknowledgement.accepted === false) throw new Error('桌面没有接受该指令。');
      this.submitted.accept(receipt, acknowledgement.turnId || acknowledgement.turn?.id || null);
      this.nativeCache.delete(id);
      this.nativeListTime = 0;
      try { return { ...await this.nativeRead(id, true), accepted: true, submissionId: receipt.id }; }
      catch (readError) {
        this.failed(readError);
        return this.decorate({ ...view, accepted: true, submissionId: receipt.id, refreshPending: true, thread: { ...view.thread, status: 'running', readAt: 0, nativeHint: '指令已发送到原生桌面；读取最新状态暂时失败，请刷新查看。' } }, 'desktop', true);
      }
    } catch (error) {
      this.failed(error);
      if (attempted) throw new AccessError(502, '原生桌面发送结果未能确认，指令可能已经被接受。请先刷新同一聊天核对；控制台不会通过其他连接重复发送。');
      if (error instanceof AccessError) throw error;
      throw new AccessError(409, '原生桌面暂时无法连接，尚未发送指令。请打开 Codex 桌面后重试，或明确选择创建手机分支。');
    } finally { this.locks.delete(id); }
  }

  async stop(id) {
    if (this.owned.has(id)) return this.tasks.stop(id);
    throw new AccessError(409, '当前原生桌面接口不支持停止任务，请回到 Codex 桌面点击停止。');
  }
}

export default DesktopTasks;
