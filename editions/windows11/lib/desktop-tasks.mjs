import { AccessError } from './security.mjs';

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
  return turns.flatMap(turn => (turn.items || []).map(item => {
    if (item.type === 'userMessage') return { id: item.id, role: 'user', text: (item.content || []).map(content => text(content.text) || (content.type === 'image' ? '[图片]' : '')).join('\n') };
    if (item.type === 'agentMessage') return { id: item.id, role: 'assistant', text: text(item.text), phase: item.phase };
    if (item.type === 'commandExecution') return { id: item.id, role: 'tool', text: clip(text(item.command) + '\n' + text(item.output || item.aggregatedOutput)), status: item.status };
    if (item.type === 'fileChange') return { id: item.id, role: 'tool', text: '文件修改\n' + (item.changes || []).map(change => `${change.path}\n${clip(change.diff)}`).join('\n'), status: item.status };
    // Internal reasoning, context compaction, and sub-agent coordination are not chat messages.
    return null;
  }).filter(Boolean)).slice(-400);
}

/**
 * Native desktop reads/writes retain the original conversation. Companion-owned
 * tasks remain on their original CLI connection. No native write is ever retried
 * through another transport: a timeout can mean the desktop already accepted it.
 */
export class DesktopTasks {
  constructor(tasks, desktopBridge, options = {}) {
    this.tasks = tasks;
    this.desktop = desktopBridge;
    if (desktopBridge?.options?.hostId && desktopBridge.options.hostId !== 'local') throw new Error('此控制台只支持当前电脑的原生 Codex。');
    this.nativeCache = new Map();
    this.summaries = new Map();
    this.locks = new Set();
    this.nativeList = null;
    this.nativeListTime = 0;
    this.nativeListPending = null;
    this.retryAfter = 0;
    this.lastNativeError = null;
    this.readCacheMs = options.readCacheMs ?? 1000;
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
    return { ...view, thread: { ...view.thread, ...meta, readOnly: !meta.capabilities.send } };
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

  async nativeRead(id, fresh = false) {
    const cached = this.nativeCache.get(id);
    if (!fresh && cached && Date.now() - cached.thread.readAt < this.readCacheMs && this.desktop?.state?.connected) return this.decorate(cached, 'desktop', true);
    await this.tools();
    const data = unpack(await this.desktop.callReadOnly('read_thread', { threadId: id, hostId: 'local', turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 }, { callerThreadId: id, hostId: 'local' }));
    if (data.thread?.id !== id || data.thread?.hostId !== 'local' || data.thread?.kind !== 'codex') throw new AccessError(403, '只允许读取当前电脑上的 Codex 聊天。');
    const turns = [...(data.turns || [])];
    if (/desc|newest/i.test(data.page?.order || '')) turns.reverse();
    const latest = turns.at(-1);
    let saved;
    try { saved = (await this.tasks.get(id)).thread; } catch { /* Native reads can still work when the companion process is unavailable. */ }
    const prior = saved || this.summaries.get(id) || this.tasks.cache.get(id) || {};
    const combined = new Map();
    for (const [index, message] of (saved?.messages || []).entries()) combined.set(message.id || `saved-${index}`, message);
    for (const [index, message] of messages(turns).entries()) combined.set(message.id || `native-${index}`, message);
    const thread = {
      id, title: data.thread.title || prior.title || '未命名任务', cwd: data.thread.cwd || prior.cwd,
      status: status(data.thread.status, latest), nativeStatus: rawStatus(data.thread.status),
      turnId: latest?.status === 'inProgress' ? latest.id : null,
      model: data.thread.model || prior.model || null, effort: data.thread.reasoningEffort || prior.effort || null,
      messages: [...combined.values()].slice(-400), updatedAt: timestamp(data.thread.updatedAt) || Date.now(), readAt: Date.now(),
      error: latest?.error?.message || null, hostId: 'local', historyHasMore: Boolean(data.page?.hasMore),
    };
    const view = { thread, approvals: [], nativeAttention: { needsDesktop: true, message: '原生任务的停止与审批需在桌面端处理。' } };
    this.nativeCache.set(id, view);
    return this.decorate(view, 'desktop', true);
  }

  async get(id) {
    if (this.owned.has(id)) return this.decorate(await this.tasks.get(id), 'companion');
    try { return await this.nativeRead(id); }
    catch (error) {
      this.failed(error);
      const view = this.decorate(await this.tasks.get(id), 'desktop');
      view.thread.nativeError = this.lastNativeError;
      return view;
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
      unpack(await this.desktop.call('send_message_to_thread', args, { callerThreadId: id, hostId: 'local' }), true);
      this.nativeCache.delete(id);
      this.nativeListTime = 0;
      try { return await this.nativeRead(id, true); }
      catch (readError) {
        this.failed(readError);
        return { ...view, accepted: true, refreshPending: true, thread: { ...view.thread, status: 'running', readAt: 0, nativeHint: '指令已发送到原生桌面；读取最新状态暂时失败，请刷新查看。' } };
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
