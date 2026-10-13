import { AccessError } from './security.mjs';
import { SubmittedMessages } from './submitted-messages.mjs';
import { retainMessages, stageView } from './tasks.mjs';
import { nativeText, nativeTimestamp, nativeStatus, unpackNative, validNativeId } from './desktop-projects.mjs';

const HINT = '直接同步电脑上已有的 GPT 聊天，沿用该聊天在电脑上的模型。新建聊天、切换模型、停止生成和发送附件请在电脑完成。';
const limited = { create: false, modelSelection: false, effortSelection: false, stop: false, steer: false, attachments: false, approvals: false, fork: false };

export class NativeGPT {
  constructor(projects, options = {}) {
    this.projects = projects;
    this.desktop = projects?.desktop;
    this.cacheMs = options.cacheMs ?? 1000;
    this.maxEntries = options.maxEntries ?? 16;
    this.maxCacheBytes = options.maxCacheBytes ?? 8 * 1024 * 1024;
    this.cache = new Map();
    this.pending = new Map();
    this.known = new Set();
    this.summaries = new Map();
    this.threadVersions = new Map();
    this.locks = new Set();
    this.used = false;
    this.activeIds = new Set();
    this.activityVersion = 0;
    // Receipts are memory-only and cleared when the desktop connection changes.
    this.submitted = new SubmittedMessages();
    this.epoch = 0;
    this.closed = false;
    this.onState = state => { if (!state.connected) this.clear(); };
    this.desktop?.on?.('state', this.onState);
  }

  clear() { this.epoch++; this.cache.clear(); this.pending.clear(); this.known.clear(); this.summaries.clear(); this.threadVersions.clear(); this.submitted = new SubmittedMessages(); }
  capabilities(available = true) {
    const has = name => Boolean(this.projects?.definition(name));
    return { ...limited, list: available && has('list_threads'), read: available && has('read_thread'), send: available && has('send_message_to_thread') && this.desktop?.options?.allowWrites === true };
  }
  async status() {
    this.used = true;
    try {
      if (this.closed) throw new Error('Closed');
      await this.projects.context();
      const capabilities = this.capabilities();
      return { available: capabilities.list && capabilities.read, capabilities, hint: HINT, models: [], modelHint: '沿用电脑聊天模型' };
    } catch { return { available: false, capabilities: this.capabilities(false), hint: '请打开并登录电脑上的 ChatGPT/Codex 桌面，再刷新已有 GPT 聊天。', models: [], modelHint: '沿用电脑聊天模型' }; }
  }
  summary(item) {
    const capabilities = this.capabilities();
    return { id: item.id, title: nativeText(item.title).slice(0, 1000) || '未命名 GPT 聊天', kind: 'chatgpt', source: 'desktop-gpt', native: true,
      projectId: validNativeId(item.projectId) ? item.projectId : null, cwd: null, status: nativeStatus(item.status), updatedAt: nativeTimestamp(item.updatedAt),
      model: null, effort: null, modelHint: '沿用电脑聊天模型', capabilities, readOnly: !capabilities.send };
  }
  async list(options = {}) {
    const status = await this.status();
    if (!status.available) return { ...status, threads: [], complete: false };
    try {
      const data = await this.projects.readCatalog('threads', options);
      if ((data.unavailableSources || []).some(value => value === 'chatgpt' || value?.source === 'chatgpt' || value?.kind === 'chatgpt')) throw new Error('GPT source unavailable');
      const threads = [...new Map([...(data.pinnedThreads || []), ...(data.threads || [])].filter(item => validNativeId(item.id) && item.kind === 'chatgpt' && !item.hostId).map(item => [item.id, this.summary(item)])).values()];
      for (const thread of threads) {
        this.remember(thread.id, thread);
        if (thread.status === 'running') this.activeIds.add(thread.id);
      }
      return { ...status, threads, complete: false, listHint: '显示电脑提供的置顶与最近聊天；较早聊天可在电脑打开后刷新。' };
    } catch { return { ...status, available: false, capabilities: this.capabilities(false), threads: [], complete: false, hint: '电脑上的 GPT 聊天暂时无法读取，请在电脑确认登录状态后刷新。' }; }
  }

  remember(id, summary) {
    this.known.delete(id); this.known.add(id);
    if (summary) this.summaries.set(id, summary);
    if (this.known.size > 200) { const oldest = this.known.values().next().value; this.known.delete(oldest); this.summaries.delete(oldest); this.threadVersions.delete(oldest); }
  }
  async requireKnown(id) {
    if (!validNativeId(id)) throw new AccessError(400, '无效的 GPT 聊天编号。');
    if (this.known.has(id)) return;
    const listing = await this.list();
    if (!listing.available) throw new AccessError(503, listing.hint);
    if (!this.known.has(id)) throw new AccessError(404, '此聊天不在电脑返回的 GPT 列表中，请在电脑打开它后刷新。');
  }

  async read(id, { cursor, fresh = false } = {}) {
    if (this.closed) throw new AccessError(503, '桌面连接已关闭。');
    if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length > 2000 || /[\u0000-\u001f]/.test(cursor))) throw new AccessError(400, '无效的历史分页位置。');
    await this.requireKnown(id);
    const context = await this.projects.context();
    const key = JSON.stringify([id, cursor || '']);
    const cached = this.cache.get(key);
    if (!fresh && cached && Date.now() - cached.at < this.cacheMs) return cached.view;
    if (this.pending.has(key)) return this.pending.get(key);
    const epoch = this.epoch, version = this.threadVersions.get(id) || 0;
    const pending = (async () => {
      // Deliberately omit hostId/model/thinking from GPT target arguments.
      // The outer caller remains a genuine local Codex thread.
      const data = unpackNative(await this.desktop.callReadOnly('read_thread', { threadId: id, turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}) }, context));
      if (data.thread?.id !== id || data.thread?.kind !== 'chatgpt' || data.thread?.hostId) throw new AccessError(403, '此入口只允许读取电脑上的 GPT 聊天。');
      if (epoch !== this.epoch || this.closed) throw new AccessError(503, '桌面连接已改变，请刷新重试。');
      if (version !== (this.threadVersions.get(id) || 0)) throw new AccessError(409, '此聊天已有新的发送操作，请重新读取最新内容。');
      const turns = [...(data.turns || [])];
      if (/newest|desc/i.test(data.page?.order || '')) turns.reverse();
      const messages = retainMessages(turns.flatMap(turn => (turn.items || []).flatMap((item, index) => {
        const identity = { id: item.id || `${turn.id || id}:${item.type}:${index}`, turnId: turn.id || null };
        if (item.type === 'userMessage') return [{ ...identity, role: 'user', text: (item.content || []).map(block => nativeText(block) || (block.type === 'image' ? '[图片]' : block.type === 'file' ? '[文件]' : '')).filter(Boolean).join('\n'), content: item.content || [] }];
        if (item.type === 'agentMessage') return [{ ...identity, role: 'assistant', text: nativeText(item.text), ...(item.phase ? { phase: item.phase } : {}), ...(Array.isArray(item.content) ? { content: item.content } : {}), ...(item.truncated ? { truncated: true } : {}) }];
        return [];
      })));
      const page = { order: 'oldest_first', nextCursor: typeof data.page?.nextCursor === 'string' ? data.page.nextCursor : null, hasMore: Boolean(data.page?.hasMore) };
      const view = { thread: { ...this.summary({ ...this.summaries.get(id), ...data.thread }), messages, historyHasMore: page.hasMore, nativeHint: HINT, turnId: null }, approvals: [], page };
      if (!cursor) {
        if (view.thread.status === 'running') this.activeIds.add(id);
        else if (!this.locks.has(id)) this.activeIds.delete(id);
      }
      this.cache.delete(key);
      const bytes = Buffer.byteLength(JSON.stringify(view));
      if (bytes <= this.maxCacheBytes) this.cache.set(key, { view, bytes, at: Date.now() });
      let total = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      while (this.cache.size > this.maxEntries || total > this.maxCacheBytes) { const oldest = this.cache.keys().next().value; total -= this.cache.get(oldest).bytes; this.cache.delete(oldest); }
      return view;
    })().finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
    this.pending.set(key, pending);
    return pending;
  }

  decorate(view, stage = 'full', includeReceipts = true) {
    const messages = includeReceipts ? this.submitted.merge(view.thread.id, view.thread.messages, retainMessages) : view.thread.messages;
    return stageView({ ...view, thread: { ...view.thread, messages } }, stage);
  }
  async get(id, options = {}) {
    if (options.stage && !['recent', 'full'].includes(options.stage)) throw new AccessError(400, '无效的聊天加载阶段。');
    try { return this.decorate(await this.read(id, options), options.stage || 'full', !options.cursor); }
    catch (error) { if (error instanceof AccessError) throw error; throw new AccessError(503, '读取 GPT 聊天失败，请检查电脑连接后刷新。'); }
  }

  async isBusy() {
    if (this.locks.size) return true;
    // Optional GPT support must not block updates before it has been used.
    if (!this.used) return false;
    const version = this.activityVersion;
    const listing = await this.list({ fresh: true });
    if (!listing.available) return Boolean(this.activeIds.size || this.locks.size || version !== this.activityVersion);
    for (const id of [...this.activeIds]) {
      try {
        // Remembered active chats may have fallen outside the latest 50 items.
        // Keep only their identifiers across a disconnect so an unknown outcome
        // cannot be mistaken for completion; transcript caches are still cleared.
        this.remember(id);
        if ((await this.read(id, { fresh: true })).thread.status === 'running') return true;
      } catch { return true; }
    }
    return Boolean(this.activeIds.size || this.locks.size || version !== this.activityVersion);
  }

  async send(id, prompt, options = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 30000) throw new AccessError(400, '请输入 1–30000 个字符的消息。');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new AccessError(400, '无效的发送设置。');
    if (options.model || options.effort || options.thinking) throw new AccessError(400, 'GPT 沿用电脑当前聊天的模型；请在电脑切换模型后再发送。');
    if (['attachments', 'attachmentIds', 'files', 'images'].some(key => options[key] !== undefined && (!Array.isArray(options[key]) || options[key].length))) throw new AccessError(400, '当前 GPT 接口只能发送文字，附件请在电脑端发送。');
    if (this.locks.has(id)) throw new AccessError(409, '正在发送此聊天的消息，请稍候。');
    this.locks.add(id);
    let attempted = false;
    try {
      const view = await this.read(id, { fresh: true });
      if (!view.thread.capabilities.send) throw new AccessError(403, '当前连接不允许发送 GPT 消息。');
      if (view.thread.status === 'running') throw new AccessError(409, 'GPT 正在回复，请等待完成；需要停止时请在电脑端操作。');
      const context = await this.projects.context(), epoch = this.epoch;
      const receipt = this.submitted.begin(id, prompt, view.thread.messages);
      if (typeof options.beforeWrite === 'function') options.beforeWrite();
      attempted = true;
      this.activityVersion++;
      this.activeIds.add(id);
      const result = unpackNative(await this.desktop.call('send_message_to_thread', { threadId: id, prompt }, context));
      if (result.threadId !== id || result.accepted === false) throw new Error('Unexpected acknowledgement');
      if (epoch !== this.epoch || this.closed) throw new Error('Connection changed');
      this.submitted.accept(receipt, null);
      // Drop cached reads only after acknowledged acceptance; never retry sends.
      this.threadVersions.set(id, (this.threadVersions.get(id) || 0) + 1);
      for (const key of this.cache.keys()) if (JSON.parse(key)[0] === id) this.cache.delete(key);
      for (const key of this.pending.keys()) if (JSON.parse(key)[0] === id) this.pending.delete(key);
      this.projects.cache.delete('threads');
      try { return { ...await this.get(id, { fresh: true }), accepted: true, submissionId: receipt.id }; }
      catch { return { ...this.decorate({ ...view, thread: { ...view.thread, status: 'running' } }), accepted: true, submissionId: receipt.id, refreshPending: true }; }
    } catch (error) {
      if (attempted) throw new AccessError(502, '发送结果尚未确认，电脑可能已收到消息。请先刷新此聊天核对，避免重复发送。');
      if (error instanceof AccessError) throw error;
      throw new AccessError(503, '暂时无法连接电脑，消息尚未发送。');
    } finally { this.locks.delete(id); }
  }

  close() { this.closed = true; this.clear(); this.desktop?.off?.('state', this.onState); }
}
