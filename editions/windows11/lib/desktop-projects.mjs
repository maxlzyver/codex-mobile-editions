import { AccessError } from './security.mjs';

export const nativeText = value => typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : '';
export const nativeTimestamp = value => typeof value === 'number' && Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : Date.parse(value || '') || 0;
export const nativeStatus = value => /^(active|running|inprogress|working|queued)$/i.test(typeof value === 'string' ? value : value?.type || '') ? 'running' : /^(error|failed|systemerror)$/i.test(typeof value === 'string' ? value : value?.type || '') ? 'error' : 'idle';
export const validNativeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

// Never pass arbitrary desktop errors to HTTP: they may contain account data or
// internal addresses. Only the explicit public errors in these adapters escape.
export function unpackNative(result) {
  if (!result || result.success === false || result.isError) throw new Error('Native tool failed.');
  let data = result.structuredContent;
  if (!data) for (const block of result.contentItems || result.content || []) {
    try { data = JSON.parse(nativeText(block)); if (data && typeof data === 'object') break; } catch {}
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.success === false) throw new Error('Invalid native result.');
  return data;
}

const hint = '项目来自电脑原生侧栏。可在已有本机 Codex 项目中新建聊天；新建、修改项目及 GPT 新建与模型切换请在电脑完成。';

/** Shared, short-lived catalog for native projects and GPT. No account tokens,
 * private application storage or fabricated local project memberships are used. */
export class DesktopProjects {
  constructor(desktopTasks, options = {}) {
    this.tasks = desktopTasks;
    this.desktop = desktopTasks?.desktop;
    this.cacheMs = options.cacheMs ?? 3000;
    this.projectCacheMs = options.projectCacheMs ?? 10000;
    this.cache = new Map();
    this.pending = new Map();
    this.locks = new Set();
    this.resolvedCallerId = null;
    this.callerPending = null;
    this.epoch = 0;
    this.closed = false;
    this.onState = state => { if (!state.connected) this.invalidate(); };
    this.desktop?.on?.('state', this.onState);
  }

  definition(name) { return this.desktop?.tools?.find(tool => tool.name === name && (!tool.namespace || tool.namespace === 'codex_app')); }
  invalidate() { this.epoch++; this.cache.clear(); this.pending.clear(); this.resolvedCallerId = null; this.callerPending = null; }
  async context() {
    if (this.closed) throw new AccessError(503, '桌面连接已关闭。');
    if (!this.desktop || this.desktop.options?.hostId && this.desktop.options.hostId !== 'local') throw new AccessError(503, '请先连接这台电脑的 Codex 桌面。');
    await this.desktop.connect();
    if (!this.desktop.tools?.length) await this.desktop.listTools();
    let callerThreadId = this.desktop.options?.callerThreadId || this.resolvedCallerId;
    if (!callerThreadId) {
      // Only a real Codex conversation from this computer can be the caller.
      // A GPT destination ID must never be used as a Codex caller identity.
      if (!this.callerPending) {
        const epoch = this.epoch, companion = this.tasks.tasks || this.tasks;
        const pending = Promise.resolve().then(() => companion.list()).then(candidates => {
          if (epoch !== this.epoch || this.closed) throw new AccessError(503, '桌面连接已改变，请刷新重试。');
          const id = candidates.find(item => (!item.hostId || item.hostId === 'local') && (!item.kind || item.kind === 'codex'))?.id;
          if (validNativeId(id)) this.resolvedCallerId = id;
          return id;
        }).finally(() => { if (this.callerPending === pending) this.callerPending = null; });
        this.callerPending = pending;
      }
      callerThreadId = await this.callerPending;
    }
    if (!validNativeId(callerThreadId)) throw new AccessError(503, '请先在电脑 Codex 中打开一个本机聊天，再刷新连接。');
    return { callerThreadId, hostId: 'local' };
  }

  async readCatalog(name, { fresh = false } = {}) {
    const context = await this.context();
    const tool = name === 'projects' ? 'list_projects' : 'list_threads';
    if (!this.definition(tool)) throw new AccessError(501, '当前桌面版本不提供此列表，请在电脑端查看。');
    const cached = this.cache.get(name), ttl = name === 'projects' ? this.projectCacheMs : this.cacheMs;
    if (!fresh && cached && Date.now() - cached.at < ttl) return cached.data;
    // A forced read joins an existing request: never issue overlapping catalog
    // reads whose completion order can roll the shared state backwards.
    if (this.pending.has(name)) return this.pending.get(name);
    const epoch = this.epoch;
    const promise = Promise.resolve().then(() => this.desktop.callReadOnly(tool, name === 'threads' ? { limit: 50 } : {}, context)).then(unpackNative).then(data => {
      if (epoch !== this.epoch || this.closed) throw new AccessError(503, '桌面连接已改变，请刷新重试。');
      this.cache.set(name, { data, at: Date.now() });
      return data;
    }).finally(() => { if (this.pending.get(name) === promise) this.pending.delete(name); });
    this.pending.set(name, promise);
    return promise;
  }

  capabilities() {
    const target = this.definition('create_thread')?.inputSchema?.properties?.target;
    const projectTarget = target?.anyOf?.some(value => value.properties?.type?.enum?.includes('project'));
    return { createProject: false, renameProject: false, deleteProject: false, createThread: this.desktop?.options?.allowWrites === true && Boolean(projectTarget) };
  }

  async list(options = {}) {
    try {
      // Tasks.list already shares concurrent reads and caches its paginated
      // catalog. Preserve only canonical project IDs; paths never imply
      // membership, especially for projects sharing source folders.
      const [catalog, threads, saved] = await Promise.all([this.readCatalog('projects', options), this.readCatalog('threads', options),
        Promise.resolve().then(() => (this.tasks.tasks || this.tasks).list()).catch(() => [])]);
      const capabilities = this.capabilities();
      const merged = new Map(saved.filter(item => validNativeId(item.id) && (!item.hostId || item.hostId === 'local') && (!item.kind || item.kind === 'codex')).map(item => [`codex:${item.id}`, { ...item, kind: 'codex', hostId: 'local' }]));
      for (const item of [...(threads.pinnedThreads || []), ...(threads.threads || [])].filter(item => validNativeId(item.id) && (item.kind === 'chatgpt' && !item.hostId || item.kind === 'codex' && item.hostId === 'local'))) {
        const key = `${item.kind}:${item.id}`;
        merged.set(key, { ...merged.get(key), ...item });
      }
      const entries = [...merged.values()].filter(item => item.archived !== true && item.isArchived !== true);
      const projects = (catalog.projects || []).filter(item => validNativeId(item.projectId) && (item.projectKind === 'local' && item.hostId === 'local' || item.projectKind === 'chatgpt' && !item.hostId)).map(item => ({
        id: item.projectId, name: nativeText(item.label).slice(0, 500) || '未命名项目', kind: item.projectKind === 'chatgpt' ? 'chatgpt' : 'codex', hostId: item.hostId || null,
        cwd: item.projectKind === 'local' ? nativeText(item.path) || null : null, isGitRepository: item.isGitRepository === true,
        threadIds: entries.filter(thread => thread.kind === (item.projectKind === 'chatgpt' ? 'chatgpt' : 'codex') && thread.projectId === item.projectId).map(thread => thread.id),
        threadsComplete: false, threadCount: null,
        capabilities: { createThread: capabilities.createThread && item.projectKind === 'local' },
      }));
      // Keep the desktop's mixed project/thread ordering and identities. Bare IDs
      // can collide across Codex and GPT; itemKeys are the canonical references.
      const references = new Map();
      for (const project of projects) references.set(`${project.kind}:project:${project.id}`, { type: 'project', kind: project.kind, id: project.id });
      for (const thread of entries) references.set(thread.kind === 'chatgpt' ? `chatgpt:conversation:${thread.id}` : `codex:thread:local:${thread.id}`, { type: 'thread', kind: thread.kind, id: thread.id });
      const sections = [], sectionIds = new Set();
      for (const section of Array.isArray(threads.sections) ? threads.sections : []) {
        if (typeof section.sectionId !== 'string' || !section.sectionId || section.sectionId.length > 2000 || sectionIds.has(section.sectionId)) continue;
        sectionIds.add(section.sectionId);
        const seen = new Set(), items = [];
        for (const key of Array.isArray(section.itemKeys) ? section.itemKeys : []) {
          if (!references.has(key) || seen.has(key)) continue;
          seen.add(key); items.push(references.get(key));
        }
        sections.push({ id: section.sectionId, type: section.sectionId === 'pinned' ? 'pinned' : section.sectionId === 'threads' ? 'projects' : section.sectionId === 'chats' ? 'threads' : 'custom', name: nativeText(section.name).slice(0, 500) || '未命名分区', items,
          projectIds: items.filter(item => item.type === 'project').map(item => item.id),
          threadIds: items.filter(item => item.type === 'thread').map(item => item.id) });
      }
      const threadMemberships = entries.filter(item => Object.hasOwn(item, 'projectId')).map(item => ({ id: item.id, kind: item.kind, projectId: validNativeId(item.projectId) ? item.projectId : null }));
      return { available: true, projects, sections, threadMemberships, complete: false, capabilities, hint, listHint: '显示桌面提供的近期聊天，并补入本机历史中带明确项目编号的聊天。未读取到的较早聊天请在电脑打开后刷新。' };
    } catch {
      return { available: false, projects: [], sections: [], complete: false, capabilities: { createProject: false, renameProject: false, deleteProject: false, createThread: false }, hint: '暂时无法读取原生项目，请保持电脑 Codex 桌面开启后刷新。' };
    }
  }

  async createThread(projectId, options = {}) {
    if (!validNativeId(projectId)) throw new AccessError(400, '无效的原生项目编号。');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new AccessError(400, '无效的新聊天设置。');
    if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 30000) throw new AccessError(400, '请输入 1–30000 个字符的指令。');
    if (options.title !== undefined && (typeof options.title !== 'string' || !options.title.trim() || options.title.length > 200)) throw new AccessError(400, '聊天标题应为 1–200 个字符。');
    if (this.locks.has(projectId)) throw new AccessError(409, '正在此项目中创建聊天，请稍候。');
    this.locks.add(projectId);
    let attempted = false;
    try {
      const context = await this.context();
      const catalog = await this.readCatalog('projects', { fresh: true });
      const project = (catalog.projects || []).find(item => item.projectId === projectId && item.projectKind === 'local' && item.hostId === 'local');
      if (!project || project.projectKind !== 'local' || project.hostId !== 'local') throw new AccessError(403, '只允许在这台电脑已有的 Codex 项目中创建聊天。');
      if (!this.capabilities().createThread) throw new AccessError(501, '当前桌面接口不支持此操作，请在电脑项目中创建聊天。');
      const args = { prompt: options.prompt, target: { type: 'project', projectId, environment: { type: 'local' } }, ...(options.title ? { title: options.title } : {}) };
      if (options.model || options.effort) {
        if (options.effort && !options.model) throw new AccessError(400, '设置思考强度时请同时选择模型，或沿用电脑默认设置。');
        const props = this.definition('create_thread')?.inputSchema?.properties || {};
        if (options.model && !props.model || options.effort && !props.thinking) throw new AccessError(501, '当前桌面接口不支持所选模型设置。');
        const selected = await this.tasks.models.resolve(options);
        if (options.model) args.model = selected.model;
        if (selected.effort && props.thinking) args.thinking = selected.effort;
        if (args.thinking && Array.isArray(props.thinking.enum) && !props.thinking.enum.includes(args.thinking)) throw new AccessError(400, '当前桌面不支持所选思考强度。');
      }
      if (typeof options.beforeWrite === 'function') options.beforeWrite();
      attempted = true;
      const result = unpackNative(await this.desktop.call('create_thread', args, context));
      if (result.hostId && result.hostId !== 'local' || !validNativeId(result.threadId) && !validNativeId(result.clientThreadId)) throw new Error('Unexpected creation acknowledgement.');
      this.invalidate();
      this.tasks.nativeListTime = 0;
      return { ...(result.threadId ? { threadId: result.threadId } : {}), ...(result.clientThreadId ? { clientThreadId: result.clientThreadId } : {}), hostId: 'local', projectId, pending: !result.threadId };
    } catch (error) {
      if (attempted) throw new AccessError(502, '创建结果尚未确认，电脑可能已经创建聊天。请先刷新项目核对，避免重复创建。');
      if (error instanceof AccessError) throw error;
      throw new AccessError(503, '暂时无法连接电脑，尚未创建聊天。');
    } finally { this.locks.delete(projectId); }
  }

  close() { this.closed = true; this.invalidate(); this.desktop?.off?.('state', this.onState); }
}
