'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const icons = {
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/>',
    logout: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4m5-12 4 4-4 4m-5-4h10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
    computer: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 2h18"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    shield: '<path d="m12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0M12 20h.01"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18m0-18c5 5 5 13 0 18"/>',
    qr: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M15 15h3v3h3m-6 3v-3m6-6v3M12 3v3m0 6h3M3 12h3m6 6v3m6-9h3"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
    chat: '<path d="M21 11a9 9 0 0 1-9 9H4l-2 2 1-7a9 9 0 1 1 18-4Z"/><path d="M8 10h8m-8 4h5"/>',
    terminal: '<path d="m5 6 6 6-6 6m9 0h5"/>',
  };
  function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    // Only the fixed, authored icon paths above are inserted as markup.
    span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
    return span;
  }
  document.querySelectorAll('[data-icon]').forEach((node) => node.replaceChildren(...icon(node.dataset.icon).childNodes));

  const state = {
    mode: 'codex', nativeProjects: [], nativeProjectId: '', projectCatalog: null, projectCatalogAt: 0, projectCatalogGeneration: 0, sidebarExpanded: new Map(), gptStatus: null, gptPage: null, gptHistory: [], gptHistoryBusy: null, pendingCreation: false,
    attachmentDrafts: [], uploadRequests: new Set(), attachmentSequence: 0,
    snapshots: new Map(), snapshotChars: 0, renderedRows: new Map(), recentRevision: '', fullRevision: '', desiredDetailsRevision: '', loadedDetailsRevision: '', recentMessages: [], progressive: false,
    detailBusy: null, detailTimer: null, detailAttempts: 0, lastDetailAt: 0, threadPollTimer: null, listPollTimer: null, listBusy: null, sessionRevision: 0,
    outgoing: new Map(), outgoingSequence: 0, conversationGeneration: 0, readRevision: 0, lastSubmissionWarning: '',
    role: 'loading', csrf: '', bootstrap: null, activeId: null, threads: [], thread: null,
    pairing: null, pairMode: 'lan', pairingBusy: false, pairToken: '', sending: false,
    readBusy: false, statusBusy: false, devicesBusy: false, lastMessages: '', lastApprovals: '', messageDisclosure: new Map(), processGroupKeys: new Map(), processGroupOwners: new Map(),
    lastThreads: '', lastDevices: '', lastStatus: '', connected: true, toastTimer: null, authTimer: null,
    wantInternetPair: false, shownReady: false, activeReadOnly: false, lanUrl: '', lastThreadError: '',
    models: [], projects: [], projectId: '', filesProjectId: '', filePath: '', filesGeneration: 0, projectsGeneration: 0, accessRevision: 0, selectionThread: null, view: 'chat', modelsBusy: false,
  };
  const sidebarStorageKey = `codex-mobile.${document.documentElement.dataset.edition || 'web'}.sidebar-disclosures.v1`;
  try {
    const saved = JSON.parse(localStorage.getItem(sidebarStorageKey) || '[]');
    if (Array.isArray(saved)) for (const entry of saved.slice(-600)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length <= 2100 && typeof entry[1] === 'boolean') state.sidebarExpanded.set(entry[0], entry[1]);
    }
  } catch { /* Browser storage is optional; in-memory folding still works. */ }
  function sidebarDisclosure(group, type, id, mode = state.mode) {
    const key = `${mode}:${type}:${id}`;
    group.open = state.sidebarExpanded.get(key) !== false;
    group.addEventListener('toggle', () => {
      if (!group.isConnected || state.sidebarExpanded.get(key) === group.open) return;
      state.sidebarExpanded.delete(key); state.sidebarExpanded.set(key, group.open);
      while (state.sidebarExpanded.size > 600) state.sidebarExpanded.delete(state.sidebarExpanded.keys().next().value);
      try { localStorage.setItem(sidebarStorageKey, JSON.stringify([...state.sidebarExpanded])); } catch {}
    });
  }
  const disclosureStorageKey = `codex-mobile.${document.documentElement.dataset.edition || 'web'}.process-disclosures.v2`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(disclosureStorageKey) || '[]');
    if (Array.isArray(saved)) for (const entry of saved.slice(-400)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length <= 3000 && typeof entry[1] === 'boolean') state.messageDisclosure.set(entry[0], entry[1]);
    }
  } catch { /* Private browsing can disable session storage; in-memory state still works. */ }
  function saveDisclosures() {
    while (state.messageDisclosure.size > 400) state.messageDisclosure.delete(state.messageDisclosure.keys().next().value);
    try { sessionStorage.setItem(disclosureStorageKey, JSON.stringify([...state.messageDisclosure])); } catch {}
  }
  const hidden = (id, value) => $(id).classList.toggle('hidden', value);
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  };
  function toast(message) {
    $('toast').textContent = message;
    hidden('toast', false);
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => hidden('toast', true), 3800);
  }
  function showError(error) {
    $('error-banner').textContent = error?.message || String(error);
    hidden('error-banner', false);
  }
  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : options.signal) : AbortSignal.timeout(30000),
    });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : (data.error?.message || data.message);
      const error = new Error(detail || `请求未完成（${response.status}）`);
      error.status = response.status;
      error.threadId = data.threadId;
      throw error;
    }
    return data;
  }
  function dateLabel(value) {
    if (!value) return '';
    const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }
  function isRunning(thread) {
    const status = typeof thread?.status === 'object' ? thread.status.type : thread?.status;
    return ['running', 'inProgress', 'active', 'busy', 'streaming'].includes(status) || Boolean(thread?.running);
  }
  function statusLabel(thread) {
    if (isRunning(thread)) return '正在工作';
    const status = typeof thread?.status === 'object' ? thread.status.type : thread?.status;
    return ({ completed: '已完成', idle: '就绪', error: '需要处理', failed: '需要处理', interrupted: '已停止', stopped: '已停止', waiting: '等待确认', waiting_for_approval: '等待确认' })[status] || '';
  }
  function mobilePermission(field) {
    return state.role === 'owner' || state.role === 'controller' && state.bootstrap?.permissions?.[field] === true;
  }
  function taskPermission(capability, field) {
    return mobilePermission(field) && state.thread?.capabilities?.[capability] === true;
  }
  function fileAccessKey(role, permissions) {
    return role + ':' + (role === 'controller' && permissions?.allowOtherFiles === true);
  }
  function invalidateFileAccess() {
    state.accessRevision++; state.projectsGeneration++; state.filesGeneration++; previewGeneration++; directoryGeneration++;
    state.projects = []; state.filesProjectId = ''; state.filePath = ''; directoryLocation = null;
    for (const id of ['preview-dialog', 'directory-dialog']) if ($(id).open) $(id).close();
    for (const id of ['preview-content', 'file-list', 'file-breadcrumbs', 'project-select', 'files-project']) $(id).replaceChildren();
    $('preview-download').removeAttribute('href'); $('preview-title').textContent = '';
    $('files-project-path').textContent = ''; $('file-count').textContent = ''; $('files-error').textContent = '';
  }
  async function reloadFileAccess() {
    await loadProjects();
    if (state.view === 'files') await browseFiles('');
  }
  function refreshPermissionControls() {
    hidden('stop-turn', !isRunning(state.thread) || state.activeReadOnly || !taskPermission('stop', 'allowMobileStop'));
    const otherFiles = mobilePermission('allowOtherFiles');
    hidden('add-project-form', !otherFiles); hidden('other-files-open', !otherFiles);
    $('other-files-note').textContent = otherFiles
      ? '可选择电脑上的其他已有目录并添加为项目。此权限不改变 Codex 的执行权限或沙箱。'
      : '其他电脑目录访问已关闭。已授权任务项目仍可查看；如需其他目录，请在电脑端「设置 → 手机权限」开启。';
    if (!otherFiles && $('directory-dialog').open) $('directory-dialog').close();
  }
  function updateStatus() {
    const info = state.bootstrap || {};
    const status = info.status || {};
    const connected = state.connected && status.codex !== 'error';
    hidden('reconnect', state.role !== 'owner' || status.codex !== 'error');
    $('connection-status').classList.toggle('offline', !connected);
    $('connection-status').lastElementChild.textContent = state.connected ? (status.codex === 'connected' ? '电脑已连接' : status.codex === 'error' ? 'Codex 未就绪' : state.role === 'pending' ? '等待确认' : '正在连接') : '连接中断 · 重试中';
    $('computer-name').textContent = status.hostname || '我的电脑';
    $('codex-state').textContent = info.desktop?.connected ? '已接入桌面 Codex' : status.codex === 'connected' ? (status.mode === 'shared' ? '已接入共享 Codex' : 'Codex 本地任务已就绪') : status.error || '正在连接 Codex';
    const standalone = status.mode === 'standalone';
    $('composer-hint').textContent = state.thread?.native
      ? '桌面原会话 · 当前原生接口不支持手机审批和停止，请到 Codex 桌面处理。'
      : isRunning(state.thread) && !mobilePermission('allowMobileStop')
        ? '手机停止任务已关闭。需要时请在电脑端「设置 → 手机权限」开启；不会停止其他聊天。'
        : standalone ? '任务由电脑 Codex 执行 · 手机审批与停止须同时具备权限和聊天支持。' : '任务在电脑上执行 · 操作能力以当前聊天和手机权限为准。';
    refreshPermissionControls();
    refreshComposerControls();
    if (status.error && state.role === 'owner' && state.lastStatus !== status.error) {
      showError(new Error(status.error));
      state.lastStatus = status.error;
    }
  }
  function showAuth(title, description, loading = false, note = '') {
    hidden('auth-view', false);
    hidden('workspace', true);
    $('auth-title').textContent = title;
    $('auth-description').textContent = description;
    $('auth-note').textContent = note;
    hidden('auth-progress', !loading);
    hidden('pair-form', true);
  }
  async function bootstrap() {
    if (state.statusBusy) return;
    state.statusBusy = true;
    try {
      const previousRole = state.role;
      const previousSession = state.role + ':' + state.csrf;
      const previousAccess = fileAccessKey(state.role, state.bootstrap?.permissions);
      const data = await api('/api/bootstrap');
      state.bootstrap = data;
      state.role = data.role || 'anonymous';
      state.csrf = data.csrfToken || '';
      if (previousSession !== state.role + ':' + state.csrf && previousRole !== 'loading') clearConversationCache();
      const accessChanged = previousAccess !== fileAccessKey(state.role, data.permissions);
      if (accessChanged) invalidateFileAccess();
      document.dispatchEvent(new CustomEvent('codex:bootstrap', { detail: data }));
      state.connected = true;
      $('app').dataset.role = state.role;
      updateStatus();
      if (['owner', 'controller'].includes(state.role)) {
        hidden('auth-view', true);
        hidden('workspace', false);
        if (!state.shownReady || previousRole !== state.role) {
          state.shownReady = true;
          await loadThreads();
          await Promise.allSettled([loadProjects(), loadModels(), loadDesktopProjects()]);
          if (previousRole === 'pending') toast('电脑已确认，现在可以开始工作了');
        } else if (accessChanged) await reloadFileAccess();
      } else if (state.role === 'pending') {
        showAuth('请在电脑上确认连接', '你的设备正在等待确认。请在电脑的「连接手机」窗口中批准本次连接。', true, '确认后会自动进入你的工作空间。');
      } else if (state.pairToken) {
        showAuth('连接你的 Codex', '配对后，就能在手机上查看进度、发送指令。');
        hidden('pair-form', false);
      } else {
        if ($('preview-dialog').open) $('preview-dialog').close();
        $('preview-content').replaceChildren();
        showAuth(previousRole === 'controller' ? '此设备已断开连接' : '把 Codex 带到手机上', '请在电脑上打开「连接手机」，用手机相机扫描二维码，然后在浏览器中打开链接。', false, '配对链接有时效；已过期时请在电脑重新生成。');
      }
      if ($('pair-dialog').open && state.role === 'owner') {
        updateInternetNote();
        if (state.wantInternetPair && data.connection?.publicUrl) {
          state.wantInternetPair = false;
          await createPairing();
        }
      }
    } catch (error) {
      state.connected = false;
      updateStatus();
      if (state.role === 'loading') showAuth('暂时无法连接电脑', '请确认电脑上的 Codex 移动助手服务正在运行，并检查手机与电脑的网络连接。', true, error.message);
    } finally { state.statusBusy = false; }
  }

  function codexVisible() { return !document.hidden; }
  function threadApi(id = '', suffix = '') { return (state.mode === 'gpt' ? '/api/gpt/threads' : '/api/threads') + (id ? '/' + encodeURIComponent(id) : '') + suffix; }
  function snapshotKey(id) { return state.mode + ':' + id; }
  function refreshComposerControls() {
    const authorized = ['owner', 'controller'].includes(state.role), gpt = state.mode === 'gpt';
    hidden('chat-mode-bar', !authorized || !state.bootstrap?.features?.nativeGpt);
    $('attach-files').disabled = !authorized || state.sending || state.activeReadOnly || !state.bootstrap?.features?.attachments || gpt;
    $('attach-files').title = gpt ? '当前桌面 GPT 接口不支持附件发送' : !state.bootstrap?.features?.attachments ? '需要电脑端支持附件上传' : '添加照片或文件';
    const running = isRunning(state.thread);
    hidden('composer-activity', !running);
    $('composer-activity-label').textContent = running ? gpt ? 'GPT 正在回复 · 请等待完成' : '正在工作 · 可以补充说明' : '等待下一条指令';
    const stopAllowed = taskPermission('stop', 'allowMobileStop');
    $('send-behavior').options[1].disabled = !stopAllowed;
    if (!stopAllowed) $('send-behavior').value = 'steer';
    $('send-behavior').disabled = state.sending || gpt;
    $('send-behavior').title = gpt ? '当前 GPT 接口不支持中途引导或停止，请到电脑处理' : stopAllowed ? '引导当前任务，或停止后发送' : '当前聊天不支持在手机停止，请到电脑处理；仍可发送引导';
    $('send-behavior-note').textContent = $('send-behavior').title;
    if (gpt) {
      $('active-model').textContent = '沿用电脑聊天模型';
      $('composer-hint').textContent = state.gptStatus?.hint || '继续电脑上已有的 GPT 聊天；当前接口不支持新建、切换模型、附件或停止。';
      $('prompt').disabled = !state.activeId || state.activeReadOnly;
      $('send').disabled = !state.activeId || state.sending || state.activeReadOnly;
      if (running) { $('send').disabled = true; $('composer-hint').textContent = 'GPT 正在回复，当前桌面接口暂不支持中途引导或停止，请等待回复完成。'; }
    }
    if (state.pendingCreation) { $('prompt').disabled = true; $('send').disabled = true; $('composer-hint').textContent = '聊天正在桌面创建。完成后从该项目列表打开；请勿重复发送。'; }
  }
  function scheduleThreadPoll() {
    clearTimeout(state.threadPollTimer);
    if (codexVisible() && state.activeId && ['owner', 'controller'].includes(state.role)) state.threadPollTimer = setTimeout(() => loadThread(), isRunning(state.thread) ? 1500 : 15000);
  }
  function scheduleListPoll() {
    clearTimeout(state.listPollTimer);
    if (codexVisible() && ['owner', 'controller'].includes(state.role)) state.listPollTimer = setTimeout(loadThreads, state.threads.some(isRunning) ? 5000 : 30000);
  }
  async function loadThreads() {
    if (!codexVisible() || !['owner', 'controller'].includes(state.role) || state.listBusy) return;
    const request = { identity: state.role + ':' + state.csrf, revision: state.sessionRevision, mode: state.mode };
    const current = () => request.identity === state.role + ':' + state.csrf && request.revision === state.sessionRevision && request.mode === state.mode;
    state.listBusy = request;
    try {
      const data = await api(threadApi());
      if (!current()) return;
      if (state.mode === 'gpt') { state.gptStatus = data; refreshComposerControls(); }
      state.threads = data.threads || data.data || [];
      const key = JSON.stringify(state.threads.map((t) => [t.id, t.title || t.name || t.preview, t.updatedAt, t.status, t.projectId]));
      if (key === state.lastThreads) return;
      state.lastThreads = key;
      renderThreads();
    } catch (error) {
      if (!current()) return;
      if (error.status === 401 || error.status === 403) { clearConversationCache(); await bootstrap(); }
      else if (!state.threads.length) $('thread-list').replaceChildren(node('p', 'list-empty', `任务列表暂不可用：${error.message}`));
    } finally { if (state.listBusy === request) state.listBusy = null; scheduleListPoll(); }
  }
  function renderThreads() {
    const list = $('thread-list');
    list.replaceChildren();
    const kind = state.mode === 'gpt' ? 'chatgpt' : 'codex';
    const projects = state.nativeProjects.filter(project => project.kind === kind);
    const threads = state.threads.filter(thread => thread.archived !== true && thread.isArchived !== true);
    const projectsById = new Map(projects.map(project => [project.id, project]));
    const threadsById = new Map(threads.map(thread => [thread.id, thread]));
    const memberships = new Map((state.projectCatalog?.threadMemberships || []).filter(item => item.kind === kind).map(item => [item.id, item.projectId]));
    const sections = (state.projectCatalog?.sections || []).flatMap(section => {
      const source = section.items || [];
      const items = source.filter(item => item.kind === kind && (item.type === 'project' ? projectsById.has(item.id) : item.type === 'thread' && threadsById.has(item.id)));
      return items.length || !source.length && (!section.type || section.type === 'custom') ? [{ ...section, items }] : [];
    });
    if (!threads.length && !projects.length && !sections.length) {
      list.append(node('p', 'list-empty', '还没有任务，开始第一段工作吧。'));
      return;
    }
    const threadButton = thread => {
      const button = node('button', `thread-item${thread.id === state.activeId ? ' active' : ''}`);
      button.type = 'button'; button.dataset.threadId = thread.id;
      button.append(icon('chat'));
      const text = node('span', 'thread-item-text');
      text.append(node('span', 'thread-item-title', thread.title || thread.name || thread.preview || '未命名任务'));
      text.append(node('span', 'thread-item-meta', [statusLabel(thread), dateLabel(thread.updatedAt || thread.createdAt)].filter(Boolean).join(' · ')));
      button.append(text);
      button.addEventListener('click', () => openThread(thread.id));
      return button;
    };
    const used = new Set(), usedProjects = new Set();
    const directThreads = new Set(sections.flatMap(section => section.items.filter(item => item.type === 'thread').map(item => item.id)));
    const projectGroup = project => {
      if (usedProjects.has(project.id)) return null;
      usedProjects.add(project.id);
      const group = node('details', 'sidebar-project'); group.dataset.projectId = project.id;
      sidebarDisclosure(group, 'project', project.id);
      const summary = node('summary', 'sidebar-project-heading'); summary.append(icon('folder'), node('span', '', project.name || '未命名项目'));
      const children = threads.filter(thread => {
        if (used.has(thread.id) || directThreads.has(thread.id)) return false;
        // The catalog combines native membership and canonical history. Its
        // explicit null must beat stale thread-list data after a desktop move.
        const projectId = memberships.has(thread.id) ? memberships.get(thread.id) : Object.hasOwn(thread, 'projectId') ? thread.projectId : undefined;
        return projectId !== undefined ? projectId === project.id : project.threadIds?.includes(thread.id);
      });
      const count = node('small', '', children.length); count.title = '已读取的聊天数，并非项目聊天总数'; summary.append(count); group.append(summary);
      const body = node('div', 'sidebar-project-chats');
      if (state.mode === 'codex') {
        const create = node('button', 'project-new-chat', '＋ 新建子聊天'); create.type = 'button'; create.disabled = project.capabilities?.createThread !== true;
        create.title = create.disabled ? '此桌面项目暂不支持手机新建聊天' : '在这个桌面项目内新建聊天';
        create.addEventListener('click', () => { resetConversation(); state.nativeProjectId = project.id; $('thread-title').textContent = project.name + ' · 新聊天'; $('thread-cwd').textContent = project.cwd || '沿用桌面项目'; $('project-select').disabled = true; $('prompt').placeholder = '描述新聊天要完成的任务…'; $('prompt').focus(); }); body.append(create);
      }
      for (const thread of children) { used.add(thread.id); body.append(threadButton(thread)); }
      if (!children.length) body.append(node('p', 'list-empty', '暂未读取到聊天，可在电脑打开后刷新'));
      group.append(body); return group;
    };
    for (const section of sections) {
      const group = node('details', 'sidebar-section'); group.dataset.sectionId = section.id;
      sidebarDisclosure(group, 'section', section.id);
      const summary = node('summary', 'sidebar-section-heading'); summary.append(node('span', '', section.name || '未命名分区')); group.append(summary);
      const body = node('div', 'sidebar-section-items');
      for (const item of section.items) {
        if (item.type === 'project') { const project = projectGroup(projectsById.get(item.id)); if (project) body.append(project); }
        else if (!used.has(item.id)) { used.add(item.id); body.append(threadButton(threadsById.get(item.id))); }
      }
      if (!body.children.length) body.append(node('p', 'list-empty', '此分区暂无可显示的项目或聊天'));
      group.append(body); list.append(group);
    }
    const unassignedProjects = projects.filter(project => !usedProjects.has(project.id));
    if (sections.length && unassignedProjects.length) list.append(node('div', 'unassigned-chats-label', '未分区项目'));
    for (const project of unassignedProjects) list.append(projectGroup(project));
    const others = threads.filter(thread => !used.has(thread.id));
    if ((projects.length || sections.length) && others.length) list.append(node('div', 'unassigned-chats-label', '其他聊天'));
    for (const thread of others) list.append(threadButton(thread));
  }
  async function loadDesktopProjects({ fresh = false } = {}) {
    if (!state.bootstrap?.features?.desktopProjects || !['owner', 'controller'].includes(state.role)) return;
    const revision = state.sessionRevision, generation = ++state.projectCatalogGeneration;
    const current = () => revision === state.sessionRevision && generation === state.projectCatalogGeneration && ['owner', 'controller'].includes(state.role);
    try {
      const data = await api('/api/desktop/projects' + (fresh ? '?refresh=true' : ''));
      if (!current()) return;
      state.projectCatalog = data; state.nativeProjects = data.projects || []; state.projectCatalogAt = Date.now();
      $('desktop-project-note').textContent = data.available === false ? data.hint || '请在电脑打开 Codex，连接后显示桌面项目。' : data.complete === false ? '显示当前桌面接口可访问的项目与聊天' : '';
      hidden('desktop-project-note', !$('desktop-project-note').textContent); renderThreads();
    } catch (error) { if (current()) { $('desktop-project-note').textContent = error.message; hidden('desktop-project-note', false); } }
  }
  async function changeChatMode(mode) {
    if (state.mode === mode || !['owner', 'controller'].includes(state.role)) return;
    resetConversation(); state.mode = mode; state.nativeProjectId = ''; state.threads = []; state.lastThreads = ''; state.listBusy = null;
    document.body.dataset.chatMode = mode;
    $('chat-mode-codex').setAttribute('aria-pressed', String(mode === 'codex')); $('chat-mode-gpt').setAttribute('aria-pressed', String(mode === 'gpt'));
    $('chat-mode-note').textContent = mode === 'gpt' ? '继续电脑上已有的 GPT 聊天' : '项目工作与代码任务';
    $('new-thread').disabled = mode === 'gpt'; $('mobile-new').disabled = mode === 'gpt';
    $('new-thread').title = mode === 'gpt' ? '当前桌面接口不支持新建 GPT 聊天，请在电脑创建后刷新' : '新建助手任务';
    $('thread-title').textContent = mode === 'gpt' ? '选择一个电脑 GPT 聊天' : '新的开始';
    hidden('welcome', mode === 'gpt');
    if (mode === 'gpt') $('messages').append(node('p', 'list-empty', '从左侧选择电脑上已有的 GPT 聊天。无需重复登录；新建聊天及不支持的操作仍在电脑完成。'));
    refreshComposerControls(); await loadThreads(); if (mode === 'codex') await loadModels();
  }
  function closeSidebar() { $('workspace').classList.remove('sidebar-open'); }
  function resetConversation() {
    clearAttachmentDrafts(); state.nativeProjectId = ''; state.pendingCreation = false; state.gptPage = null; state.gptHistory = []; hidden('load-gpt-history', true);
    stopConversationReads();
    state.conversationGeneration++;
    state.renderedRows.clear();
    state.recentRevision = ''; state.fullRevision = ''; state.desiredDetailsRevision = ''; state.loadedDetailsRevision = ''; state.recentMessages = []; state.progressive = false;
    state.detailAttempts = 0; state.lastDetailAt = 0;
    showView('chat');
    state.activeId = null;
    state.thread = null;
    state.activeReadOnly = false;
    state.lastThreadError = '';
    state.lastMessages = '';
    state.lastApprovals = '';
    state.selectionThread = null;
    hidden('history-notice', true);
    $('project-select').disabled = false;
    $('model-select').disabled = false;
    $('effort-select').disabled = false;
    updateStatus();
    updateProjectContext();
    $('messages').replaceChildren();
    $('approvals').replaceChildren();
    $('thread-title').textContent = '新的开始';
    hidden('welcome', false);
    hidden('thread-state', true);
    hidden('stop-turn', true);
    hidden('error-banner', true);
    $('prompt').disabled = false;
    $('prompt').placeholder = '描述你想做的事…';
    $('send').disabled = state.sending;
    renderThreads();
    closeSidebar();
  }
  function stopConversationReads() {
    clearTimeout(state.detailTimer); state.detailTimer = null;
    clearTimeout(state.threadPollTimer); state.threadPollTimer = null;
    state.readBusy?.controller?.abort(); state.detailBusy?.controller?.abort();
    state.gptHistoryBusy?.controller?.abort(); state.gptHistoryBusy = null;
    state.readBusy = false; state.detailBusy = null;
  }
  function clearConversationCache() {
    clearAttachmentDrafts(); state.nativeProjects = []; state.projectCatalog = null; state.projectCatalogGeneration++; state.gptStatus = null; state.pendingCreation = false;
    stopConversationReads();
    state.snapshots.clear(); state.snapshotChars = 0; state.renderedRows.clear();
    state.sessionRevision++; state.listBusy = null;
    state.conversationGeneration++; state.readRevision++;
    state.thread = null; state.activeId = null; state.outgoing.clear(); state.threads = []; state.lastThreads = '';
    state.gptPage = null; state.gptHistory = []; hidden('load-gpt-history', true);
    state.recentMessages = []; state.recentRevision = ''; state.fullRevision = ''; state.desiredDetailsRevision = ''; state.loadedDetailsRevision = ''; state.progressive = false;
    state.shownReady = false; state.lastMessages = ''; state.lastApprovals = '';
    $('messages').replaceChildren(); $('approvals').replaceChildren(); $('thread-list').replaceChildren();
  }
  function rememberSnapshot(data) {
    const thread = data.thread;
    if (!thread?.id || !Array.isArray(thread.messages)) return;
    const chars = thread.messages.reduce((total, message) => total + String(messageText(message)).length + 300, 0);
    const cacheId = snapshotKey(thread.id), prior = state.snapshots.get(cacheId);
    if (prior) { state.snapshotChars -= prior.chars; state.snapshots.delete(cacheId); }
    if (chars > 2000000) return;
    state.snapshots.set(cacheId, { data: { ...data, thread: { ...thread, messages: [...thread.messages] } }, chars, recentRevision: state.recentRevision, fullRevision: state.fullRevision, desiredDetailsRevision: state.desiredDetailsRevision, loadedDetailsRevision: state.loadedDetailsRevision, recentMessages: state.recentMessages, progressive: state.progressive, gptPage: state.gptPage, gptHistory: state.gptHistory });
    state.snapshotChars += chars;
    while (state.snapshots.size > 8 || state.snapshotChars > 4000000) {
      const id = state.snapshots.keys().next().value;
      state.snapshotChars -= state.snapshots.get(id).chars; state.snapshots.delete(id);
    }
  }
  function messageIdentity(message, index) { return message.id ? `id:${message.id}` : `position:${message.turnId || ''}:${message.role || message.type || ''}:${index}`; }
  function mergeRecentMessages(base, recent) {
    const result = base.map((message, index) => ({ key: messageIdentity(message, index), message }));
    let before = result.length;
    // Insert newly discovered entries before the next known entry, preserving transcript order.
    for (let index = recent.length - 1; index >= 0; index--) {
      const message = recent[index], key = messageIdentity(message, index);
      const found = result.findIndex(entry => entry.key === key);
      if (found === -1) { result.splice(before, 0, { key, message }); }
      else {
        const prior = result[found].message;
        result[found].message = message.deferred && !prior.deferred
          ? { ...prior, ...message, text: messageText(prior), deferred: false }
          : message;
        before = found;
      }
    }
    const messages = result.map(entry => entry.message);
    if (messages.length <= 400) return messages;
    // Match the server's bounded view: process output cannot evict a question or final answer.
    const process = message => message.role === 'tool' || message.role === 'assistant' && message.phase === 'commentary';
    const selected = new Set(messages.filter(message => !process(message)).slice(-400));
    const remaining = 400 - selected.size;
    if (remaining > 0) for (const message of messages.filter(process).slice(-remaining)) selected.add(message);
    return messages.filter(message => selected.has(message));
  }
  async function openThread(id) {
    if (!id || !['owner', 'controller'].includes(state.role)) return;
    resetConversation();
    state.activeId = id;
    hidden('welcome', true);
    const cached = state.snapshots.get(snapshotKey(id));
    if (cached) {
      state.snapshots.delete(snapshotKey(id)); state.snapshots.set(snapshotKey(id), cached);
      for (const key of ['recentRevision', 'fullRevision', 'desiredDetailsRevision', 'loadedDetailsRevision', 'recentMessages', 'progressive', 'gptPage', 'gptHistory']) state[key] = cached[key];
      state.thread = cached.data.thread;
      applyThreadView({ ...cached.data, approvals: [] }, true);
      $('thread-state').textContent = '已保存记录 · 正在同步'; hidden('thread-state', false);
    } else $('messages').append(node('p', 'list-empty', '正在读取近期消息…'));
    renderThreads();
    await loadThread(true);
  }
  function readStillCurrent(request) {
    return request.id === state.activeId && request.generation === state.conversationGeneration && request.revision === state.readRevision && request.identity === state.role + ':' + state.csrf && ['owner', 'controller'].includes(state.role);
  }
  async function loadThread(forceScroll = false) {
    if (!state.activeId || !codexVisible() || !['owner', 'controller'].includes(state.role)) return;
    const id = state.activeId;
    const request = { id, generation: state.conversationGeneration, revision: state.readRevision, identity: state.role + ':' + state.csrf, controller: new AbortController() };
    if (state.readBusy && state.readBusy.id === id && state.readBusy.generation === request.generation && state.readBusy.revision === request.revision) return;
    state.readBusy?.controller?.abort();
    state.readBusy = request;
    try {
      const since = !forceScroll && state.recentRevision ? '&since=' + encodeURIComponent(state.recentRevision) : '';
      const data = await api(threadApi(id) + `?stage=recent${since}`, { signal: request.controller.signal });
      if (!readStillCurrent(request)) return;
      if (data.unchanged) { if (state.progressive) scheduleDetails(); return; }
      const incoming = data.thread || data;
      if (state.mode === 'gpt' && data.page && !state.gptHistory.length) state.gptPage = data.page;
      const recent = incoming.loadingStage === 'recent';
      state.progressive = recent;
      state.recentRevision = data.revision || incoming.revision || '';
      state.recentMessages = incoming.messages || data.messages || [];
      if (recent) {
        state.desiredDetailsRevision = incoming.detailsRevision || state.recentRevision;
        state.thread = { ...incoming, messages: mergeRecentMessages(state.thread?.messages || [], state.recentMessages) };
      } else {
        state.thread = state.mode === 'gpt' && state.gptHistory.length ? { ...incoming, messages: mergeRecentMessages(state.gptHistory, incoming.messages || []) } : incoming;
        state.fullRevision = data.revision || incoming.revision || '';
        state.loadedDetailsRevision = incoming.detailsRevision || state.fullRevision;
      }
      applyThreadView(data, forceScroll);
      rememberSnapshot({ ...data, thread: state.thread });
      if (recent) scheduleDetails();
    } catch (error) {
      if (!readStillCurrent(request) || error.name === 'AbortError') return;
      if (forceScroll || (error.status !== 401 && error.status !== 403)) showError(error);
      if (error.status === 401 || error.status === 403) { clearConversationCache(); await bootstrap(); }
    } finally { if (state.readBusy === request) state.readBusy = false; scheduleThreadPoll(); }
  }
  function scheduleDetails(immediate = false) {
    if (!state.progressive || !state.activeId || !codexVisible() || !['owner', 'controller'].includes(state.role)) return;
    if (!immediate && state.loadedDetailsRevision && state.loadedDetailsRevision === state.desiredDetailsRevision) return;
    if (state.detailBusy) return;
    if (state.detailTimer && !immediate) return;
    clearTimeout(state.detailTimer);
    const expanded = Boolean($('messages').querySelector('.process-disclosure[open]'));
    const interval = expanded ? 2000 : state.detailAttempts ? Math.min(20000, 3000 * 2 ** Math.min(state.detailAttempts - 1, 3)) : 350;
    const delay = immediate ? 0 : Math.max(350, interval - (Date.now() - state.lastDetailAt));
    state.detailTimer = setTimeout(() => { state.detailTimer = null; loadThreadDetails(); }, delay);
  }
  async function loadThreadDetails() {
    if (!state.activeId || !state.progressive || !codexVisible() || state.detailBusy) return;
    const request = { id: state.activeId, generation: state.conversationGeneration, revision: state.readRevision, identity: state.role + ':' + state.csrf, controller: new AbortController() };
    state.detailBusy = request; state.lastDetailAt = Date.now(); state.detailAttempts++;
    try {
      const since = state.fullRevision ? '&since=' + encodeURIComponent(state.fullRevision) : '';
      const data = await api(threadApi(request.id) + `?stage=full${since}`, { signal: request.controller.signal });
      if (!readStillCurrent(request)) return;
      if (!data.unchanged) {
        const full = data.thread || data;
        state.fullRevision = data.revision || full.revision || '';
        state.loadedDetailsRevision = full.detailsRevision || state.fullRevision;
        // Current recent messages and metadata win over an older background snapshot.
        state.thread = { ...full, ...state.thread, messages: mergeRecentMessages(state.mode === 'gpt' ? mergeRecentMessages(state.gptHistory, full.messages || []) : full.messages || [], state.recentMessages), historyHasMore: full.historyHasMore };
        if (state.mode === 'gpt' && data.page && !state.gptHistory.length) state.gptPage = data.page;
        refreshHistoryControl();
        renderConversation(state.thread.messages, isRunning(state.thread));
        rememberSnapshot({ thread: state.thread, approvals: [] });
      } else if (data.detailsRevision) state.loadedDetailsRevision = data.detailsRevision;
    } catch (error) {
      if (readStillCurrent(request) && error.name !== 'AbortError' && (error.status === 401 || error.status === 403)) { clearConversationCache(); await bootstrap(); }
    } finally {
      if (state.detailBusy === request) state.detailBusy = null;
      if (readStillCurrent(request)) scheduleDetails();
    }
  }
  function applyThreadView(data, forceScroll = false) {
    const thread = state.thread;
    const id = state.activeId;
      const running = isRunning(thread);
      showSubmissionWarning(thread);
      if (thread.error && thread.error !== state.lastThreadError) {
        state.lastThreadError = thread.error;
        showError(new Error(thread.error));
      }
      state.activeReadOnly = Boolean(thread.readOnly || data.readOnly || thread.controllable === false || data.controllable === false);
      if (state.selectionThread !== id) {
        state.selectionThread = id;
        const project = state.projects.find(p => normalizePath(p.path) === normalizePath(thread.cwd));
        if (project) { state.projectId = project.id; $('project-select').value = project.id; }
        $('model-select').value = thread.model && state.models.some(m => m.model === thread.model) ? thread.model : '';
        renderEfforts(thread.effort);
      }
      $('thread-cwd').textContent = thread.cwd || '未指定工作目录';
      $('thread-cwd').title = thread.cwd || '';
      $('project-select').disabled = true;
      $('model-select').disabled = running && !state.activeReadOnly;
      $('effort-select').disabled = running && !state.activeReadOnly;
      $('active-model').textContent = [thread.model || (thread.native ? '沿用桌面会话设置' : $('model-select').value || 'Codex 默认模型'), thread.effort].filter(Boolean).join(' · ');
      hidden('history-notice', !state.activeReadOnly);
      $('thread-title').textContent = thread.title || thread.name || thread.preview || '任务对话';
      $('thread-state').textContent = state.activeReadOnly ? '历史记录' : `${thread.native ? '桌面原会话 · ' : ''}${statusLabel(thread)}`;
      hidden('thread-state', !state.activeReadOnly && !statusLabel(thread));
      hidden('stop-turn', !running || state.activeReadOnly || !taskPermission('stop', 'allowMobileStop'));
      updateStatus();
      $('prompt').disabled = state.activeReadOnly;
      $('prompt').placeholder = state.activeReadOnly ? '点上方「在此继续分支」，保留上下文继续工作。' : running ? 'Codex 正在工作，你可以输入下一条指令…' : '描述你想做的事…';
      $('send').disabled = state.activeReadOnly || state.sending;
      hidden('welcome', true);
      renderConversation(thread.messages || data.messages || [], running, forceScroll);
      const approvals = data.approvals || thread.approvals || [];
      const approvalKey = JSON.stringify([approvals, mobilePermission('allowMobileApprovals'), mobilePermission('allowMobileStop'), thread.capabilities?.approvals]);
      if (approvalKey !== state.lastApprovals) {
        state.lastApprovals = approvalKey;
        renderApprovals(approvals);
      }
      refreshComposerControls();
      refreshHistoryControl();
  }
  function refreshHistoryControl() {
    const visible = state.mode === 'gpt' && state.activeId && state.gptPage?.hasMore && state.gptPage?.nextCursor;
    hidden('load-gpt-history', !visible);
    const atLimit = (state.thread?.messages?.length || 0) >= 400;
    $('load-gpt-history').disabled = Boolean(state.gptHistoryBusy || atLimit);
    $('load-gpt-history').textContent = state.gptHistoryBusy ? '正在读取更早消息…' : atLimit ? '已显示 400 条消息，更早内容请在电脑查看' : '加载更早消息';
  }
  async function loadGptHistory() {
    if (state.mode !== 'gpt' || !state.activeId || state.gptHistoryBusy || !state.gptPage?.nextCursor || state.sending || (state.thread?.messages?.length || 0) >= 400) return;
    const request = { id: state.activeId, generation: state.conversationGeneration, revision: state.readRevision, identity: state.role + ':' + state.csrf, controller: new AbortController() };
    const cursor = state.gptPage.nextCursor;
    state.gptHistoryBusy = request; refreshHistoryControl();
    try {
      const data = await api(threadApi(request.id) + '?stage=full&cursor=' + encodeURIComponent(cursor), { signal: request.controller.signal });
      if (!readStillCurrent(request)) return;
      state.gptHistory = mergeRecentMessages(data.thread?.messages || [], state.gptHistory);
      state.thread = { ...state.thread, messages: mergeRecentMessages(state.gptHistory, state.thread.messages || []) };
      state.gptPage = { ...data.page, hasMore: Boolean(data.page?.hasMore && data.page?.nextCursor && data.page.nextCursor !== cursor) };
      renderConversation(state.thread.messages, isRunning(state.thread));
      rememberSnapshot({ thread: state.thread, approvals: [] });
    } catch (error) { if (readStillCurrent(request) && error.name !== 'AbortError') showError(error); }
    finally { if (state.gptHistoryBusy === request) state.gptHistoryBusy = null; refreshHistoryControl(); }
  }
  function showSubmissionWarning(thread) {
    const warning = thread?.submissionWarning || '';
    if (warning && warning !== state.lastSubmissionWarning) showError(new Error(warning));
    state.lastSubmissionWarning = warning;
  }
  function renderConversation(messages, running, forceScroll = false) {
    const visible = [...messages];
    const matched = new Set();
    for (const [key, outgoing] of state.outgoing) {
      const belongs = (outgoing.mode || 'codex') === state.mode && (outgoing.threadId ? outgoing.threadId === state.activeId : !state.activeId && outgoing.viewGeneration === state.conversationGeneration);
      if (!belongs) continue;
      // A later authenticated read can resolve an ambiguous network response.
      // Existing identical prompts are excluded, so repeated instructions remain distinct.
      const synced = outgoing.delivery === 'uncertain' && messages.find(message => message.role === 'user' && message.submitted && messageText(message) === outgoing.text && !outgoing.baselineIds.has(message.id) && !matched.has(message.id) && (!outgoing.attachments?.length || outgoing.attachments.every(attachment => message.attachments?.some(item => item.id === attachment.id))));
      if (synced) { matched.add(synced.id); state.outgoing.delete(key); continue; }
      visible.push({ id: outgoing.id, role: 'user', text: outgoing.text, attachments: outgoing.attachments || [], createdAt: outgoing.createdAt, delivery: outgoing.delivery });
    }
    const key = state.activeId || 'new';
    const scroll = $('conversation-scroll');
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
    const generation = state.conversationGeneration;
    const anchor = !forceScroll && !nearBottom ? [...$('messages').children].find(child => child.getBoundingClientRect().bottom >= scroll.getBoundingClientRect().top) : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    state.lastMessages = key;
    renderMessages(visible, running);
    requestAnimationFrame(() => {
      if (generation !== state.conversationGeneration) return;
      if (forceScroll || nearBottom) scroll.scrollTop = scroll.scrollHeight;
      else if (anchor?.isConnected) scroll.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    });
  }
  function messageText(message) {
    if (typeof message.text === 'string') return message.text;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => typeof part === 'string' ? part : part.text || '').join('\n');
    return message.output || message.command || message.summary || '';
  }
  function messageFileScope(cwd) {
    if (typeof cwd !== 'string' || !cwd) return null;
    const windows = /^[a-z]:[\\/]/i.test(cwd);
    const normalize = value => {
      const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
      return windows ? normalized.toLowerCase() : normalized;
    };
    return { cwd, windows, normalize, root: normalize(cwd) };
  }
  function messageReference(raw, context) {
    const reference = String(raw || '').trim();
    if (!reference || reference.length > 4096 || /[\u0000-\u001f\u007f]/.test(reference)) return null;
    if (/^https:/i.test(reference)) {
      try {
        const url = new URL(reference);
        if (url.protocol === 'https:' && !url.username && !url.password) return { kind: 'external', href: url.href };
      } catch {}
      return null;
    }
    const scope = messageFileScope(context.cwd);
    if (!scope || !context.threadId) return null;
    let decoded;
    try { decoded = decodeURIComponent(reference); } catch { return null; }
    // Never normalize away an attempted traversal or repeatedly decode a path.
    if (/[\u0000-\u001f\u007f]/.test(decoded) || /%[a-f\d]{2}/i.test(decoded) || /(^|[\\/])\.\.([\\/]|$)/.test(decoded)) return null;
    let candidate = decoded;
    if (/^file:/i.test(reference)) {
      try {
        const url = new URL(reference);
        if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || (url.hash && !/^#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/.test(url.hash))) return null;
        candidate = decodeURIComponent(url.pathname) + url.hash;
        if (/^\/[a-z]:\//i.test(candidate)) candidate = candidate.slice(1);
      } catch { return null; }
    } else if (/^sandbox:/i.test(reference)) candidate = decoded.slice('sandbox:'.length);
    else if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) return null;
    if (scope.windows && /^\/[a-z]:\//i.test(candidate)) candidate = candidate.slice(1);
    candidate = candidate.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, '').replace(/:\d+(?::\d+)?$/, '').replaceAll('\\', '/');
    if (!candidate || candidate === '.' || candidate.startsWith('//') || /(^|\/)\.\.(\/|$)/.test(candidate) || /[<>:"|?*]/.test(candidate.replace(/^[a-z]:/i, ''))) return null;
    if (/^(?:\/|[a-z]:\/)/i.test(candidate)) {
      const absolute = scope.normalize(candidate);
      if (!absolute.startsWith(scope.root + '/')) return null;
    }
    return { kind: 'file', reference };
  }
  function readMessageDestination(content, start) {
    let depth = 1, angle = false;
    for (let index = start; index < Math.min(content.length, start + 4300); index++) {
      const char = content[index];
      if (char === '\n' || char === '\r') return null;
      if (char === '<' && index === start) angle = true;
      else if (char === '>' && angle) angle = false;
      else if (!angle && char === '(') depth++;
      else if (!angle && char === ')' && --depth === 0) {
        let target = content.slice(start, index).trim();
        const wrapped = /^<([^<>]+)>(?:\s+["'][^"']*["'])?$/.exec(target);
        target = wrapped ? wrapped[1] : target.replace(/\s+(?:"[^"]*"|'[^']*')$/, '');
        return { target, end: index + 1 };
      }
    }
    return null;
  }
  function renderMessageContent(element, value, context) {
    const content = String(value);
    const extension = /\.(?:pdf|docx?|xlsx?|pptx?|txt|md|markdown|csv|tsv|jsonl?|ya?ml|toml|log|html?|svg|png|jpe?g|gif|webp|avif|bmp|ico|zip|gz|7z|tar|mp[34]|webm|mov|wav|ogg|py|[cm]?js|tsx?|jsx|css|sql|sh|ps1|bat|cmd|c|h|cpp|hpp|cs|java|go|rs|tex)(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)?$/i;
    const tokens = /\x60{3}[\s\S]*?(?:\x60{3}|$)|\x60([^\x60\r\n]+)\x60|!?\[([^\]\r\n]{1,200})\]\(|https:\/\/[^\s<>"'\x60]+|(?:[a-z]:[\\/]|\/|(?:\.\/)?(?:[\w.-]+\/)+)[^\s<>"'\x60()[\]{}]+/gi;
    let cursor = 0, match;
    while ((match = tokens.exec(content))) {
      const start = match.index;
      let end = tokens.lastIndex, label, target;
      if (match[0].startsWith(String.fromCharCode(96).repeat(3))) continue;
      if (match[1] !== undefined) {
        target = match[1];
        if (!extension.test(target)) continue;
        label = target;
      } else if (match[2] !== undefined) {
        const destination = readMessageDestination(content, end);
        if (!destination) continue;
        target = destination.target;
        label = match[2];
        end = destination.end;
        tokens.lastIndex = end;
      } else {
        target = match[0].replace(/[.,;!?，。；！？]+$/, '');
        if (!/^https:/i.test(target) && !extension.test(target)) continue;
        label = target;
        end = start + target.length;
      }
      const reference = messageReference(target, context);
      if (!reference) continue;
      element.append(document.createTextNode(content.slice(cursor, start)));
      if (reference.kind === 'external') {
        const link = node('a', 'message-external-link', label);
        link.href = reference.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        element.append(link);
      } else {
        element.append(messageFileCard(reference.reference, label, context));
      }
      cursor = end;
    }
    element.append(document.createTextNode(content.slice(cursor)));
  }
  function messageFileCard(reference, label, context) {
    let name = reference.replace(/#L\d+.*$/, '').replace(/:\d+(?::\d+)?$/, '').replaceAll('\\', '/').split('/').at(-1) || label;
    try { name = decodeURIComponent(name); } catch {}
    const type = window.CodexRich?.fileType(name) || 'FILE';
    const button = node('button', 'message-file-link message-file-card'); button.type = 'button'; button.title = '预览或下载：' + reference;
    button.dataset.fileReference = reference; button.setAttribute('aria-label', label);
    const glyph = node('span', 'attachment-glyph', type); glyph.dataset.type = type;
    const info = node('span', 'attachment-info'); info.append(node('strong', '', label));
    info.append(node('small', '', label === name ? '预览 / 下载' : name));
    button.append(glyph, info); button.addEventListener('click', () => openMessageFile(reference, context, button)); return button;
  }
  function richMessageContent(element, value, context) {
    if (!window.CodexRich || !/(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)|\*\*|__|`[^`]+`|```|\$[^$\n]+\$|\\[([]|\[[^\]]+\]\(/.test(value)) { renderMessageContent(element, value, context); return; }
    window.CodexRich.render(element, value, {
      text: (target, text) => renderMessageContent(target, text, context),
      link: (target, label) => {
        const reference = messageReference(target, context);
        if (!reference) return null;
        if (reference.kind === 'external') { const link = node('a', 'message-external-link', label); link.href = reference.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link; }
        return messageFileCard(reference.reference, label, context);
      },
    });
  }
  function publicDisplayText(value) {
    // Only known opaque assistant citation markers are presentation metadata.
    // User text, code and quoted examples keep their exact original characters.
    return String(value).split(/(```[\s\S]*?(?:```|$)|`[^`\r\n]*`)/).map((part, index) => index % 2 ? part : part.replace(/(^[ \t]*>.*$)|\uE200(?:cite|filecite)\uE202(?:turn[\w.-]+(?:\uE202|[ ,])?)+\uE201/gm, (match, quoted) => quoted || '')).join('');
  }
  async function previewAttachment(attachment) {
    const url = window.CodexRich?.safeUrl(attachment.previewUrl), download = window.CodexRich?.safeUrl(attachment.downloadUrl);
    if (!url || !['owner', 'controller'].includes(state.role)) return;
    const revision = state.sessionRevision, generation = ++previewGeneration;
    $('preview-title').textContent = attachment.name || '附件预览'; $('preview-content').replaceChildren(node('p', '', '正在加载…'));
    if (download) { $('preview-download').href = download; $('preview-download').download = attachment.name || ''; } else $('preview-download').removeAttribute('href');
    if (!$('preview-dialog').open) $('preview-dialog').showModal();
    const current = () => revision === state.sessionRevision && generation === previewGeneration;
    if (/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(attachment.mime || '')) {
      const img = node('img', 'file-image'); img.alt = attachment.name || '图片'; img.src = url;
      img.addEventListener('error', () => { if (current()) $('preview-content').replaceChildren(node('p', '', '图片暂不可用，可能已移动或不在授权项目内。请在电脑检查原文件。')); });
      $('preview-content').replaceChildren(img); return;
    }
    if (/^(?:text\/|application\/(?:json|xml))/.test(attachment.mime || '') && attachment.size <= 1048576) {
      try { const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }); if (!response.ok) throw new Error('预览暂不可用'); const text = await response.text(); if (current()) $('preview-content').replaceChildren(node('pre', 'file-text', text.slice(0, 1048576))); }
      catch (error) { if (current()) $('preview-content').replaceChildren(node('p', '', error.message)); }
    } else $('preview-content').replaceChildren(node('p', '', '请下载原文件，在对应应用中打开。'));
  }
  let messageFileRequest = 0;
  async function openMessageFile(reference, context, button) {
    const request = ++messageFileRequest;
    const generation = state.conversationGeneration, accessRevision = state.accessRevision;
    const current = () => accessRevision === state.accessRevision && request === messageFileRequest && generation === state.conversationGeneration && state.activeId === context.threadId && ['owner', 'controller'].includes(state.role);
    button.disabled = true;
    try {
      const scope = messageFileScope(context.cwd);
      if (!scope || !messageReference(reference, context)) throw new Error('只能打开当前聊天项目内的文件。');
      let project = state.projects.find(value => value.exists && scope.normalize(value.path) === scope.root);
      if (!project) {
        await loadProjects();
        if (!current()) return;
        project = state.projects.find(value => value.exists && scope.normalize(value.path) === scope.root);
      }
      if (!project) throw new Error('当前聊天项目尚未可访问，请刷新项目列表后重试。');
      const result = await api('/api/projects/' + encodeURIComponent(project.id) + '/resolve?reference=' + encodeURIComponent(reference));
      if (!current()) return;
      if (result.projectId !== project.id || typeof result.path !== 'string' || !result.path || /^(?:[\\/]|[a-z]:)/i.test(result.path) || result.path.split(/[\\/]/).includes('..')) throw new Error('文件路径校验未通过，请从项目文件列表重新打开。');
      await previewFile({ name: result.name || result.path.split('/').at(-1), path: result.path }, project.id);
    } catch (error) { if (current()) toast(error.message); }
    finally { if (button.isConnected) button.disabled = false; }
  }
  function publicMessageRole(item) {
    if (item.role === 'user' || item.type === 'userMessage') return 'user';
    const type = String(item.type || '').toLowerCase();
    if (item.role === 'tool' || /^(command|commandexecution|tool|filechange|mcptoolcall|dynamictoolcall|collabtoolcall|collabagenttoolcall|websearch|imagesearch)$/.test(type)) return 'tool';
    return 'assistant';
  }
  function processGroupKey(group, claimed) {
    const thread = state.mode + ':' + (state.activeId || `new:${state.conversationGeneration}`);
    const canonical = JSON.stringify([thread, group.turnId ? ['turn', group.turnId] : ['round', group.anchor]]);
    const aliases = [canonical, ...group.records.map(record => JSON.stringify([thread, 'process-item', record.item.id || ['position', record.index, record.item.type || record.role]])), JSON.stringify([thread, 'boundary', group.anchor])];
    const candidates = aliases.map(alias => state.processGroupKeys.get(alias)).filter(Boolean);
    const prior = candidates.find(value => !claimed.has(value.key) && (!group.turnId || !value.turnId || value.turnId === group.turnId) && (!group.turnId || !state.processGroupOwners.has(value.key) || state.processGroupOwners.get(value.key) === group.turnId));
    const identity = { key: prior?.key || canonical, turnId: group.turnId || prior?.turnId || null };
    // A previously unknown round may split when IDs arrive. Its children must not share a switch.
    if (!prior && !state.messageDisclosure.has(identity.key)) {
      const inherited = candidates.find(value => state.messageDisclosure.has(value.key));
      if (inherited) state.messageDisclosure.set(identity.key, state.messageDisclosure.get(inherited.key));
    }
    claimed.add(identity.key);
    if (identity.turnId) state.processGroupOwners.set(identity.key, identity.turnId);
    for (const alias of aliases) state.processGroupKeys.set(alias, identity);
    // If upstream fills in a turn ID later, also retain its canonical switch for a full page reload.
    if (canonical !== identity.key && state.messageDisclosure.has(identity.key)) state.messageDisclosure.set(canonical, state.messageDisclosure.get(identity.key));
    return identity.key;
  }
  function conversationRows(messages, running) {
    const entries = [], segments = [];
    let segment;
    const startSegment = (anchor, turnId = null) => {
      segment = { anchor, turnId, records: [] }; segments.push(segment);
    };
    startSegment(['start']);
    for (const [index, item] of messages.entries()) {
      // The bridge only supplies public records. Never render raw internal reasoning if a future source includes it.
      if (/reasoning/i.test(String(item.type || '')) || item.role === 'reasoning' || item.phase === 'analysis') continue;
      const content = messageText(item);
      if (!content && !item.deferred && !item.attachments?.length) continue;
      const role = publicMessageRole(item);
      const record = { item, index, content: content || (item.deferred ? '执行记录' : ''), role, process: role === 'tool' || role === 'assistant' && item.phase === 'commentary' };
      if (role === 'user') startSegment(['user', item.id || index], item.turnId || null);
      if (record.process) { record.segment = segment; segment.records.push(record); }
      entries.push(record);
      // Legacy assistant messages without phase remain outside, just like explicit final answers.
      if (role === 'assistant' && !record.process) startSegment(['after-answer', item.id || index]);
    }
    const groups = new Map();
    for (const section of segments) {
      const firstTurn = section.records.find(record => record.item.turnId)?.item.turnId;
      let turnId = section.turnId || firstTurn || null;
      for (const record of section.records) {
        turnId = record.item.turnId || turnId;
        const anchor = section.anchor[0] === 'start' && section.records[0]?.item.id ? ['first-process', section.records[0].item.id] : section.anchor;
        const identity = JSON.stringify(turnId ? ['turn', turnId] : ['round', anchor]);
        if (!groups.has(identity)) groups.set(identity, { turnId, anchor, records: [], running: false });
        record.group = groups.get(identity); record.group.records.push(record);
      }
    }
    let activeGroup;
    if (running) {
      const activeTurn = state.thread?.turnId;
      activeGroup = activeTurn ? [...groups.values()].find(group => group.turnId === activeTurn) : null;
      const last = entries.at(-1);
      const lastProcess = entries.findLast(entry => entry.process);
      const lastAnswer = entries.findLast(entry => entry.role === 'assistant' && !entry.process);
      // A queued/steered user message remains outside the currently running turn's group.
      if (!activeGroup && !activeTurn && lastProcess && (!lastAnswer || lastProcess.index > lastAnswer.index || last === lastAnswer)) activeGroup = lastProcess.group;
      if (!activeGroup) {
        const identity = JSON.stringify(activeTurn ? ['turn', activeTurn] : ['round', segment.anchor]);
        activeGroup = groups.get(identity) || { turnId: activeTurn || segment.turnId, anchor: segment.anchor, records: [], running: false };
        groups.set(identity, activeGroup);
      }
      activeGroup.running = true;
    }
    const rows = [], rendered = new Set();
    for (const entry of entries) {
      if (!entry.process) rows.push(entry);
      else if (!rendered.has(entry.group)) { rows.push(entry.group); rendered.add(entry.group); }
    }
    if (activeGroup && !rendered.has(activeGroup)) rows.push(activeGroup);
    const claimed = new Set();
    for (const group of groups.values()) group.key = processGroupKey(group, claimed);
    return rows;
  }
  function retainDisclosure(detail, key) {
    detail.dataset.disclosureKey = key;
    detail.open = state.messageDisclosure.get(key) === true;
    detail.addEventListener('toggle', () => {
      if (!detail.isConnected) return;
      state.messageDisclosure.delete(key); state.messageDisclosure.set(key, detail.open);
      for (const [alias, identity] of state.processGroupKeys) {
        if (identity.key === key && alias.includes('[\"turn\",')) state.messageDisclosure.set(alias, detail.open);
      }
      saveDisclosures();
    });
  }
  function messageArticle(record) {
    const { item, index, content, role } = record;
    const article = node('article', `message ${role}`);
    article.dataset.messageId = item.id || '';
    if (item.phase) article.dataset.phase = item.phase;
    article.append(node('div', 'message-avatar', role === 'user' ? '我' : role === 'tool' ? '⌘' : 'C'));
    const body = node('div', 'message-body');
    const heading = node('div', 'message-name', role === 'user' ? '' : role === 'tool' ? item.title || '执行记录' : state.mode === 'gpt' ? 'GPT' : 'Codex');
    if (item.createdAt && role !== 'user') heading.append(node('time', '', dateLabel(item.createdAt)));
    const delivery = role === 'user' && ({ sending: '发送中…', failed: '发送失败', uncertain: '结果未确认', sent: '已发送' })[item.delivery];
    if (delivery) {
      const label = node('span', 'message-delivery', delivery); label.dataset.status = item.delivery; heading.append(label);
    }
    if (role !== 'user') body.append(heading);
    const context = { threadId: state.activeId, cwd: state.thread?.cwd };
    const contentNode = () => {
      const pre = node(role === 'tool' ? 'pre' : 'div', 'message-content');
      if (item.deferred) pre.textContent = '正在加载执行记录…';
      else if (role === 'tool') renderMessageContent(pre, content, context);
      else richMessageContent(pre, role === 'assistant' ? publicDisplayText(content) : content, context);
      return pre;
    };
    if (role === 'tool') {
      const detail = node('details', 'message-disclosure');
      detail.dataset.messageId = item.id || '';
      retainDisclosure(detail, JSON.stringify([state.mode + ':' + state.activeId, 'tool', item.id ? ['id', item.id] : ['position', item.turnId || '', item.type || role, index]]));
      detail.append(node('summary', '', item.title || String(content).split('\n')[0].slice(0, 100)));
      const reveal = () => {
        if (detail.open && !detail.querySelector('.message-content')) detail.append(contentNode());
        if (detail.open && item.deferred) scheduleDetails(true);
      };
      detail.addEventListener('toggle', reveal);
      reveal();
      body.append(detail);
    } else if (content) body.append(contentNode());
    if (window.CodexRich && item.attachments?.length) {
      const cards = node('div', 'message-attachments');
      for (const attachment of item.attachments.slice(0, 8)) cards.append(window.CodexRich.card(attachment, previewAttachment));
      body.append(cards);
    }
    if (role === 'user' && heading.childNodes.length) body.append(heading);
    article.append(body);
    return article;
  }
  function recordSignature(record) {
    const { item, content, role } = record;
    return [content, role, item.phase, item.title, item.createdAt, item.delivery, item.deferred, item.turnId, item.type, state.thread?.cwd, JSON.stringify(item.attachments || [])];
  }
  function recordNode(record, cache) {
    const key = messageIdentity(record.item, record.index), signature = recordSignature(record);
    let entry = cache.get(key);
    if (!entry || !signature.every((value, index) => value === entry.signature[index])) {
      if (entry) for (const detail of entry.node.querySelectorAll('details[data-disclosure-key]')) state.messageDisclosure.set(detail.dataset.disclosureKey, detail.open);
      entry = { signature, node: messageArticle(record) };
      cache.set(key, entry);
    }
    return { key, node: entry.node };
  }
  function reconcileNodes(container, children) {
    let next = container.firstChild;
    for (const child of children) {
      if (child === next) next = next.nextSibling;
      else container.insertBefore(child, next);
    }
    while (next) { const stale = next; next = next.nextSibling; stale.remove(); }
  }
  function renderProcessContent(detail) {
    const body = detail.querySelector('.process-content'), row = detail.processRow;
    if (!detail.open) {
      for (const child of body.querySelectorAll('details[data-disclosure-key]')) state.messageDisclosure.set(child.dataset.disclosureKey, child.open);
      if (body.childNodes.length) body.replaceChildren();
      detail.recordNodes.clear();
      return;
    }
    const records = row.records.map(record => recordNode(record, detail.recordNodes));
    const keep = new Set(records.map(record => record.key));
    for (const key of detail.recordNodes.keys()) if (!keep.has(key)) detail.recordNodes.delete(key);
    const children = records.map(record => record.node);
    if (row.running) {
      detail.activity ||= node('div', 'turn-activity', 'Codex 正在工作，内容会实时更新…');
      children.push(detail.activity);
    }
    reconcileNodes(body, children);
  }
  function processNode(row) {
    const key = 'process:' + row.key;
    let entry = state.renderedRows.get(key);
    if (!entry) {
      const detail = node('details', 'process-disclosure');
      retainDisclosure(detail, row.key);
      detail.recordNodes = new Map();
      detail.append(node('summary', 'process-summary'), node('div', 'process-content'));
      detail.addEventListener('toggle', () => {
        if (!detail.isConnected) return;
        renderProcessContent(detail);
        if (detail.open && (detail.processRow.records.some(record => record.item.deferred) || state.loadedDetailsRevision !== state.desiredDetailsRevision)) scheduleDetails(true);
      });
      entry = { node: detail, summarySignature: '' };
      state.renderedRows.set(key, entry);
    }
    const detail = entry.node;
    detail.processRow = row;
    detail.dataset.turnId = row.turnId || ''; detail.dataset.processKey = row.key;
    const duration = row.records.map(record => record.item.turnDurationMs).find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const signature = `${row.running}:${duration}`;
    if (entry.summarySignature !== signature) {
      const summary = detail.querySelector('.process-summary');
      summary.replaceChildren(node('span', 'process-summary-title', '思考与过程'));
      if (row.running) summary.append(node('span', 'process-summary-status', '正在进行'));
      if (!row.running && duration !== undefined) summary.append(node('span', 'process-summary-duration', duration < 1000 ? `${Math.round(duration)} 毫秒` : `${Math.round(duration / 100) / 10} 秒`));
      entry.summarySignature = signature;
    }
    renderProcessContent(detail);
    return { key, node: detail };
  }
  function renderMessages(messages, running) {
    const list = $('messages');
    for (const detail of list.querySelectorAll('details[data-disclosure-key]')) state.messageDisclosure.set(detail.dataset.disclosureKey, detail.open);
    const rows = conversationRows(messages, running);
    const rendered = rows.map(row => row.records ? processNode(row) : recordNode(row, state.renderedRows));
    const keep = new Set(rendered.map(row => row.key));
    for (const key of state.renderedRows.keys()) if (!keep.has(key)) state.renderedRows.delete(key);
    const children = rendered.map(row => row.node);
    if (!children.length) children.push(list.querySelector('.list-empty') || node('p', 'list-empty', '这个任务还没有消息。发送一条指令，继续工作。'));
    reconcileNodes(list, children);
  }
  function renderApprovals(approvals) {
    $('approvals').replaceChildren();
    for (const approval of approvals) {
      const card = node('section', 'approval');
      const type = approval.type || approval.method || '';
      const isQuestion = /requestUserInput/i.test(type) || Array.isArray(approval.questions) || Array.isArray(approval.params?.questions);
      card.append(node('h3', '', isQuestion ? 'Codex 需要你的回答' : '操作需要你的确认'));
      const params = approval.params || approval;
      const detail = approval.description || [params.command, params.reason, params.message, params.permissions ? `请求的权限：\n${JSON.stringify(params.permissions, null, 2)}` : '', params.changes ? JSON.stringify(params.changes, null, 2) : ''].filter(Boolean).join('\n\n') || type;
      if (detail) card.append(node('pre', '', typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)));
      const inputs = [];
      if (!taskPermission('approvals', 'allowMobileApprovals') || approval.supported === false) {
        const unsupported = state.thread?.capabilities?.approvals !== true || approval.supported === false;
        card.append(node('p', 'approval-permission-note', unsupported ? '当前聊天不支持在手机处理此请求，请到电脑 Codex 完成。' : '手机审批已关闭。请在电脑端处理，或在电脑端「设置 → 手机权限」开启。'));
        if (!unsupported) {
          const settings = node('button', 'button', '查看手机权限'); settings.type = 'button';
          settings.addEventListener('click', () => document.dispatchEvent(new CustomEvent('codex:open-permissions'))); card.append(settings);
        }
        $('approvals').append(card); continue;
      }
      if (isQuestion) {
        const questions = approval.questions || params.questions || [];
        for (const question of questions) {
          const label = node('label', 'approval-question', question.question || question.prompt || question.header || '你的回答');
          let input;
          if (question.options?.length) {
            input = node('select', 'approval-answer');
            for (const option of question.options) input.append(new Option(typeof option === 'string' ? option : option.label, typeof option === 'string' ? option : option.label));
          } else { input = node('textarea', 'approval-answer'); input.rows = 2; }
          label.append(input);
          card.append(label);
          inputs.push({ id: question.id, input });
        }
      }
      const actions = node('div', 'approval-actions');
      const accept = node('button', 'button button-primary', isQuestion ? '提交回答' : '允许这次操作');
      accept.type = 'button';
      accept.addEventListener('click', async () => {
        const answers = {};
        for (const answer of inputs) answers[answer.id] = { answers: [answer.input.value] };
        await decideApproval(approval.id, 'accept', isQuestion ? answers : undefined, accept);
      });
      const decline = node('button', 'button', isQuestion ? '停止任务' : '拒绝');
      decline.type = 'button';
      if (isQuestion && !taskPermission('stop', 'allowMobileStop')) { decline.disabled = true; decline.title = '手机停止任务未开启或当前聊天不支持，请在电脑处理。'; }
      decline.addEventListener('click', () => isQuestion ? stopTurn() : decideApproval(approval.id, 'decline', undefined, decline));
      actions.append(accept, decline);
      card.append(actions);
      $('approvals').append(card);
    }
  }
  async function decideApproval(id, decision, answers, button) {
    if (!taskPermission('approvals', 'allowMobileApprovals')) { toast('手机审批未开启或当前聊天不支持，请在电脑端处理。'); return; }
    button.disabled = true;
    try {
      await api(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision, ...(answers ? { answers } : {}) } });
      toast(decision === 'accept' ? '已发送确认' : '已拒绝该操作');
      await loadThread();
    } catch (error) { showError(error); button.disabled = false; }
  }
  function resizePrompt() {
    $('prompt').style.height = 'auto';
    $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 180)}px`;
  }
  async function sendPrompt(event) {
    event.preventDefault();
    const originalInput = $('prompt').value;
    const prompt = originalInput.trim();
    if ((!prompt && !state.attachmentDrafts.length) || state.sending || state.activeReadOnly || state.pendingCreation || state.mode === 'gpt' && !state.activeId) return;
    if (state.mode === 'gpt' && isRunning(state.thread)) { toast('请等待 GPT 回复完成后再发送'); return; }
    const threadId = state.activeId;
    const generation = state.conversationGeneration;
    const session = state.sessionRevision;
    const mode = state.mode, drafts = [...state.attachmentDrafts], nativeProjectId = state.nativeProjectId;
    const action = isRunning(state.thread) ? $('send-behavior').value : 'steer';
    const outgoing = {
      id: `pending-${Date.now()}-${++state.outgoingSequence}`, threadId, mode,
      viewGeneration: generation, text: prompt, attachments: drafts.map(draft => draft.attachment || { id: draft.id, name: draft.file.name, size: draft.file.size, mime: draft.file.type, kind: draft.file.type.startsWith('image/') ? 'image' : 'file' }), createdAt: Date.now(), delivery: 'sending',
      baselineIds: new Set((state.thread?.messages || []).map(message => message.id)),
    };
    state.outgoing.set(outgoing.id, outgoing);
    while (state.outgoing.size > 40) state.outgoing.delete(state.outgoing.keys().next().value);
    const stillHere = () => state.conversationGeneration === generation && state.activeId === threadId;
    state.sending = true;
    refreshComposerControls();
    stopConversationReads();
    state.readRevision++;
    $('send').disabled = true;
    hidden('error-banner', true);
    hidden('welcome', true);
    renderConversation(state.thread?.messages || [], isRunning(state.thread), true);
    let submitted = false;
    try {
      const attachments = [];
      for (const draft of drafts) { attachments.push(await uploadAttachment(draft, session)); if (!stillHere() || session !== state.sessionRevision) throw new Error('聊天已切换，附件没有发送。'); }
      outgoing.attachments = attachments;
      const body = mode === 'gpt' ? { prompt } : { prompt, ...modelChoice(), ...(attachments.length ? { attachmentIds: attachments.map(item => item.id) } : {}), ...(isRunning(state.thread) ? { action } : {}) };
      submitted = true;
      const data = nativeProjectId && !threadId
        ? await api('/api/desktop/projects/' + encodeURIComponent(nativeProjectId) + '/threads', { method: 'POST', body })
        : await api(threadApi(threadId, threadId ? '/messages' : ''), { method: 'POST', body: threadId || mode === 'gpt' ? body : { ...body, projectId: $('project-select').value || undefined } });
      if (nativeProjectId && !threadId) {
        outgoing.delivery = 'sent';
        if (stillHere()) {
          clearAttachmentDrafts(); $('prompt').value = ''; resizePrompt();
          state.pendingCreation = true; $('thread-state').textContent = '已提交到桌面'; hidden('thread-state', false);
          $('composer-hint').textContent = '聊天正在桌面创建。完成后从该项目列表打开；请勿重复发送。';
          renderConversation([], false); await loadThreads(); await loadDesktopProjects();
          if (data.threadId && state.threads.some(thread => thread.id === data.threadId)) await openThread(data.threadId);
        }
        return;
      }
      const returnedId = data.thread?.id || data.threadId || data.id || threadId;
      if (!returnedId || !Array.isArray(data.thread?.messages)) throw new Error('指令已提交，但返回记录不完整。请刷新任务列表核对，不要重复发送。');
      const showResponse = stillHere();
      state.outgoing.delete(outgoing.id);
      state.readRevision++;
      if (showResponse) {
        clearAttachmentDrafts();
        state.activeId = returnedId;
        state.thread = mode === 'gpt' && state.gptHistory.length ? { ...data.thread, messages: mergeRecentMessages(state.gptHistory, data.thread.messages) } : data.thread;
        state.recentMessages = data.thread.messages;
        state.recentRevision = ''; state.fullRevision = ''; state.loadedDetailsRevision = '';
        rememberSnapshot({ thread: state.thread, approvals: [] });
        showSubmissionWarning(data.thread);
        state.activeReadOnly = Boolean(data.thread.readOnly || data.thread.controllable === false);
        // Render the accepted POST body immediately; a poll that began before
        // this response must not erase the just-submitted user message.
        renderConversation(state.thread.messages, isRunning(data.thread), true);
        if ($('prompt').value === originalInput) { $('prompt').value = ''; resizePrompt(); }
        renderThreads();
        await loadThread(true);
      }
      await loadThreads();
    } catch (error) {
      outgoing.delivery = !submitted || error.status >= 400 && error.status < 500 && error.status !== 408 ? 'failed' : 'uncertain';
      if (stillHere()) {
        showError(error);
        renderConversation(state.thread?.messages || [], isRunning(state.thread), true);
      }
    } finally {
      state.sending = false; $('send').disabled = state.activeReadOnly;
      refreshComposerControls(); renderAttachmentDrafts();
      if (session === state.sessionRevision && generation === state.conversationGeneration) {
        scheduleThreadPoll();
        if (state.progressive) scheduleDetails();
      }
    }
  }
  function clearAttachmentDrafts() {
    for (const request of state.uploadRequests) request.abort(); state.uploadRequests.clear();
    for (const draft of state.attachmentDrafts) if (draft.url) URL.revokeObjectURL(draft.url);
    state.attachmentDrafts = [];
    if ($('attachment-input')) $('attachment-input').value = '';
    if ($('attachment-drafts')) $('attachment-drafts').replaceChildren();
  }
  function renderAttachmentDrafts() {
    const list = $('attachment-drafts'); list.replaceChildren();
    for (const draft of state.attachmentDrafts) {
      const card = node('div', 'attachment-draft'); card.dataset.draftId = draft.id;
      if (draft.url) { const img = node('img'); img.src = draft.url; img.alt = ''; card.append(img); } else card.append(node('span', 'attachment-glyph', '▤'));
      const info = node('div', 'attachment-info'); info.append(node('strong', '', draft.file.name), node('small', '', draft.error || (draft.progress === null ? formatBytes(draft.file.size) : draft.progress < 100 ? `上传中 ${draft.progress}%` : '上传完成')));
      if (draft.progress !== null) { const progress = node('progress'); progress.max = 100; progress.value = draft.progress; progress.setAttribute('aria-label', draft.file.name + ' 上传进度'); info.append(progress); }
      const remove = node('button', 'icon-button', '×'); remove.type = 'button'; remove.disabled = state.sending; remove.setAttribute('aria-label', '移除 ' + draft.file.name);
      remove.addEventListener('click', () => { if (draft.url) URL.revokeObjectURL(draft.url); state.attachmentDrafts = state.attachmentDrafts.filter(item => item !== draft); renderAttachmentDrafts(); });
      card.append(info, remove); list.append(card);
    }
  }
  function selectAttachments(files) {
    if (!['owner', 'controller'].includes(state.role) || state.mode === 'gpt' || state.sending || state.activeReadOnly || !state.bootstrap?.features?.attachments) return;
    for (const file of files) {
      if (state.attachmentDrafts.length >= 8) { toast('每条消息最多添加 8 个附件'); break; }
      if (file.size > 25 * 1024 * 1024) { toast(file.name + ' 超过 25 MB，未添加'); continue; }
      state.attachmentDrafts.push({ id: 'draft-' + ++state.attachmentSequence, file, url: /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(file.type) ? URL.createObjectURL(file) : null, progress: null, attachment: null, error: '' });
    }
    $('attachment-input').value = ''; renderAttachmentDrafts();
  }
  function uploadAttachment(draft, session) {
    if (draft.attachment) return Promise.resolve(draft.attachment);
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest(); state.uploadRequests.add(request); draft.progress = 0; draft.error = ''; renderAttachmentDrafts();
      const fail = message => { draft.error = message; state.uploadRequests.delete(request); renderAttachmentDrafts(); reject(new Error(message)); };
      request.open('POST', '/api/attachments'); request.timeout = 120000;
      request.setRequestHeader('Content-Type', 'application/octet-stream'); request.setRequestHeader('X-CSRF-Token', state.csrf); request.setRequestHeader('X-File-Name', encodeURIComponent(draft.file.name));
      request.upload.onprogress = event => { if (session === state.sessionRevision && event.lengthComputable) { draft.progress = Math.round(event.loaded / event.total * 100); renderAttachmentDrafts(); } };
      request.onload = () => {
        state.uploadRequests.delete(request);
        if (session !== state.sessionRevision) { fail('设备连接已变化，请重新选择附件'); return; }
        let data; try { data = JSON.parse(request.responseText); } catch { fail('上传响应不可用'); return; }
        if (request.status < 200 || request.status >= 300 || typeof data.attachment?.id !== 'string') { fail(data.error || '附件上传失败'); return; }
        draft.attachment = data.attachment; draft.progress = 100; renderAttachmentDrafts(); resolve(draft.attachment);
      };
      request.onerror = () => fail('附件上传失败，请检查连接后重试'); request.ontimeout = () => fail('附件上传超时，请重试'); request.onabort = () => fail('附件上传已取消');
      request.send(draft.file);
    });
  }
  async function stopTurn() {
    if (!state.activeId) return;
    if (!taskPermission('stop', 'allowMobileStop')) { toast('手机停止未开启或当前聊天不支持，请到电脑端处理。'); return; }
    $('stop-turn').disabled = true;
    try { await api(`/api/threads/${encodeURIComponent(state.activeId)}/stop`, { method: 'POST', body: {} }); toast('已发送停止请求'); await loadThread(); }
    catch (error) { showError(error); }
    finally { $('stop-turn').disabled = false; }
  }

  const effortLabels = { none: '无', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '超高' };
  const normalizePath = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  function modelChoice() { return { model: $('model-select').value || undefined, effort: $('effort-select').value || undefined }; }
  function renderEfforts(preferred) {
    const model = state.models.find(m => m.model === $('model-select').value);
    const previous = preferred || $('effort-select').value;
    $('effort-select').replaceChildren(...(model?.supportedReasoningEfforts || []).map(e => new Option(effortLabels[e.reasoningEffort] || e.reasoningEffort, e.reasoningEffort)));
    if (!model) $('effort-select').append(new Option('沿用设置', ''));
    const values = [...$('effort-select').options].map(o => o.value);
    $('effort-select').value = values.includes(previous) ? previous : model?.defaultReasoningEffort || values[0] || '';
    if (!state.activeId) $('active-model').textContent = [model?.displayName || 'Codex 默认模型', $('effort-select').value].filter(Boolean).join(' · ');
  }
  async function loadModels() {
    if (state.mode === 'gpt') return;
    if (state.modelsBusy) return;
    state.modelsBusy = true;
    try {
      const previous = $('model-select').value;
      const data = await api('/api/models'); state.models = data.models || [];
      if (state.mode !== 'codex') return;
      $('model-select').replaceChildren(new Option('沿用默认 / 当前会话', ''), ...state.models.map(m => new Option(m.displayName || m.model, m.model)));
      $('model-select').value = state.models.some(m => m.model === previous) ? previous : '';
      renderEfforts();
    } catch (error) {
      if (!state.models.length) $('model-select').replaceChildren(new Option('模型列表未就绪 · 点击刷新', ''));
      toast(`模型列表：${error.message}`);
    } finally { state.modelsBusy = false; }
  }
  function updateProjectContext() {
    const project = state.projects.find(p => p.id === state.projectId);
    $('thread-cwd').textContent = project?.path || state.bootstrap?.defaultCwd || '请选择工作项目';
    $('thread-cwd').title = $('thread-cwd').textContent;
  }
  async function loadProjects() {
    const generation = ++state.projectsGeneration;
    try {
      const data = await api('/api/projects');
      if (generation !== state.projectsGeneration || !['owner', 'controller'].includes(state.role)) return;
      state.projects = data.projects || [];
      const defaultProject = state.projects.find(p => normalizePath(p.path) === normalizePath(state.bootstrap?.defaultCwd));
      const current = state.thread && state.projects.find(p => normalizePath(p.path) === normalizePath(state.thread.cwd));
      if (current) state.projectId = current.id;
      else if (!state.projects.some(p => p.id === state.projectId)) state.projectId = defaultProject?.id || state.projects[0]?.id || '';
      for (const id of ['project-select', 'files-project']) {
        $(id).replaceChildren(...state.projects.map(p => {
          const option = new Option(`${p.name}${p.exists ? '' : '（目录已不存在）'} · ${p.path}`, p.id);
          option.disabled = !p.exists; return option;
        }));
      }
      $('project-select').value = state.projectId;
      if (!state.projects.some(p => p.id === state.filesProjectId)) state.filesProjectId = state.projectId;
      $('files-project').value = state.filesProjectId;
      if (!state.activeId) updateProjectContext();
    } catch (error) { if (generation === state.projectsGeneration) $('files-error').textContent = error.message; }
  }
  function showView(view) {
    state.view = view; hidden('chat-panel', view !== 'chat'); hidden('files-panel', view !== 'files'); closeSidebar();
  }
  async function openFiles(preferCurrent = false) {
    showView('files'); await loadProjects();
    if (preferCurrent && state.projectId) state.filesProjectId = state.projectId;
    $('files-project').value = state.filesProjectId;
    await browseFiles('');
  }
  function fileUrl(action, filePath, projectId = state.filesProjectId) { return `/api/projects/${encodeURIComponent(projectId)}/${action}?path=${encodeURIComponent(filePath)}`; }
  function formatBytes(value) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }
  async function browseFiles(relativePath = '') {
    if (!state.filesProjectId) return;
    const generation = ++state.filesGeneration;
    $('files-error').textContent = ''; $('file-list').replaceChildren(node('p', 'list-empty', '正在读取电脑文件…'));
    try {
      const data = await api(fileUrl('files', relativePath));
      if (generation !== state.filesGeneration) return;
      state.filePath = data.path || '';
      $('files-project-path').textContent = data.project.path;
      $('file-breadcrumbs').replaceChildren();
      const crumbs = data.breadcrumbs?.length ? data.breadcrumbs : [{ name: data.project.name, path: '' }];
      for (const crumb of crumbs) {
        const button = node('button', '', crumb.name); button.type = 'button'; button.addEventListener('click', () => browseFiles(crumb.path));
        $('file-breadcrumbs').append(button, node('span', '', '/'));
      }
      $('file-count').textContent = `${data.entries.length} 项`;
      $('file-list').replaceChildren();
      for (const entry of data.entries) {
        const directory = entry.type === 'directory';
        const row = node('div', 'file-row');
        const open = node('button', 'file-open'); open.type = 'button'; open.append(icon(directory ? 'folder' : 'terminal'));
        const label = node('span', 'file-label'); label.append(node('strong', '', entry.name), node('small', '', `${directory ? '文件夹' : formatBytes(entry.size)} · ${dateLabel(entry.modifiedAt)}`)); open.append(label);
        open.addEventListener('click', () => directory ? browseFiles(entry.path) : previewFile(entry)); row.append(open);
        if (!directory) { const download = node('a', 'button file-download', '下载'); download.href = fileUrl('download', entry.path); download.setAttribute('download', entry.name); row.append(download); }
        $('file-list').append(row);
      }
      if (!data.entries.length) $('file-list').append(node('p', 'list-empty', '这个文件夹是空的。'));
    } catch (error) { if (generation === state.filesGeneration) { $('files-error').textContent = error.message; $('file-list').replaceChildren(); } }
  }
  let previewGeneration = 0;
  async function previewFile(entry, projectId = state.filesProjectId) {
    if (!['owner', 'controller'].includes(state.role) || !state.projects.some(project => project.id === projectId)) return;
    const generation = ++previewGeneration;
    const downloadUrl = fileUrl('download', entry.path, projectId), contentUrl = fileUrl('content', entry.path, projectId), textUrl = fileUrl('preview', entry.path, projectId);
    $('preview-title').textContent = entry.name; $('preview-download').href = downloadUrl; $('preview-download').download = entry.name;
    $('preview-content').replaceChildren(); $('preview-dialog').showModal();
    if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(entry.name)) {
      const img = node('img', 'file-image'); img.alt = entry.name; img.src = contentUrl;
      img.onerror = () => { if (generation === previewGeneration) $('preview-content').replaceChildren(node('p', '', '图片暂时无法预览，请下载查看。')); };
      $('preview-content').append(img); return;
    }
    if (/\.pdf$/i.test(entry.name)) {
      const open = node('a', 'button', '在新标签页阅读 PDF'); open.href = contentUrl; open.target = '_blank'; open.rel = 'noopener';
      $('preview-content').append(node('p', '', '使用浏览器的 PDF 阅读器翻页、缩放，或下载到手机阅读。'), open); return;
    }
    $('preview-content').append(node('p', '', '正在读取文件…'));
    try {
      const data = await api(textUrl); if (generation !== previewGeneration) return;
      $('preview-content').replaceChildren(node('pre', 'file-text', data.text));
    } catch (error) { if (generation === previewGeneration) $('preview-content').replaceChildren(node('p', '', `${error.message} 点击右上角「下载文件」可保存到手机。`)); }
  }
  async function forkThread() {
    if (!state.activeId || state.sending) return;
    const source = state.activeId;
    $('fork-thread').disabled = true;
    try {
      const data = await api(`/api/threads/${encodeURIComponent(source)}/fork`, { method: 'POST', body: modelChoice() });
      const id = data.thread?.id || data.threadId || data.id;
      await loadThreads(); await openThread(id);
      toast('已保留对话上下文。后续指令使用同一电脑项目，在这个分支执行。');
    } catch (error) { showError(error); }
    finally { $('fork-thread').disabled = false; }
  }

  let directoryGeneration = 0, directoryLocation = null, directoryParent = null;
  async function browseComputerDirectory(input = '') {
    if (!mobilePermission('allowOtherFiles')) { toast('请先在电脑端开启“访问其他电脑目录”。'); return; }
    const generation = ++directoryGeneration;
    $('directory-error').textContent = '';
    $('directory-list').replaceChildren(node('p', 'list-empty', '正在读取电脑目录…'));
    $('directory-add').disabled = true;
    try {
      const data = await api('/api/filesystem' + (input ? '?path=' + encodeURIComponent(input) : ''));
      if (generation !== directoryGeneration || !mobilePermission('allowOtherFiles')) return;
      directoryLocation = data.path || null; directoryParent = data.parent || null;
      $('directory-path').value = directoryLocation || '';
      $('directory-current').textContent = directoryLocation || '请选择电脑位置';
      $('directory-up').disabled = !directoryParent;
      $('directory-add').disabled = !directoryLocation;
      $('directory-list').replaceChildren();
      const entries = directoryLocation ? data.entries || [] : data.locations || [];
      for (const entry of entries) {
        const button = node('button', 'directory-entry');
        button.type = 'button';
        button.append(icon('folder'), node('span', '', entry.name || entry.path));
        button.title = entry.path;
        button.addEventListener('click', () => browseComputerDirectory(entry.path));
        $('directory-list').append(button);
      }
      if (!entries.length) $('directory-list').append(node('p', 'list-empty', '此位置没有可访问的子目录。可以添加当前目录。'));
    } catch (error) {
      if (generation === directoryGeneration) { directoryLocation = null; $('directory-list').replaceChildren(); $('directory-error').textContent = error.message; }
    }
  }
  async function addProjectPath(input) {
    if (!mobilePermission('allowOtherFiles')) throw new Error('其他目录访问已关闭，请在电脑端设置中开启。');
    const added = await api('/api/projects', { method: 'POST', body: { path: input } });
    await loadProjects();
    const id = added.id || added.project?.id;
    if (id && state.projects.some(project => project.id === id)) {
      state.filesProjectId = id; $('files-project').value = id; await browseFiles('');
    }
    toast('目录已添加为项目，可以查看文件或在此下达指令。');
  }
  $('other-files-open').addEventListener('click', () => {
    if (!mobilePermission('allowOtherFiles')) return;
    $('directory-dialog').showModal(); browseComputerDirectory('');
  });
  $('directory-close').addEventListener('click', () => $('directory-dialog').close());
  $('directory-dialog').addEventListener('close', () => { directoryGeneration++; directoryLocation = null; });
  $('directory-form').addEventListener('submit', event => { event.preventDefault(); browseComputerDirectory($('directory-path').value.trim()); });
  $('directory-locations').addEventListener('click', () => browseComputerDirectory(''));
  $('directory-up').addEventListener('click', () => { if (directoryParent) browseComputerDirectory(directoryParent); });
  $('directory-add').addEventListener('click', async () => {
    if (!directoryLocation) return;
    $('directory-add').disabled = true;
    try { await addProjectPath(directoryLocation); $('directory-dialog').close(); }
    catch (error) { $('directory-error').textContent = error.message; $('directory-add').disabled = false; }
  });
  document.addEventListener('codex:permissions-changed', event => {
    const accessChanged = fileAccessKey(state.role, state.bootstrap?.permissions) !== fileAccessKey(state.role, event.detail);
    if (accessChanged) invalidateFileAccess();
    state.bootstrap = { ...state.bootstrap, permissions: event.detail };
    updateStatus(); state.lastApprovals = '';
    if (state.activeId) loadThread();
    if (accessChanged) reloadFileAccess();
    else if (state.view === 'files') loadProjects();
  });
  async function openPairDialog() {
    if (state.role !== 'owner') return;
    if (!$('pair-dialog').open) $('pair-dialog').showModal();
    updateLanOptions();
    await Promise.allSettled([createPairing(), loadDevices()]);
  }
  function updateLanOptions() {
    let options = $('lan-options');
    if (!options) {
      options = node('div', 'lan-options'); options.id = 'lan-options';
      const label = node('label', '', '电脑网络地址'); label.htmlFor = 'lan-address';
      const select = node('select'); select.id = 'lan-address';
      select.addEventListener('change', () => { state.lanUrl = select.value; createPairing(); });
      options.append(label, select);
      $('pair-mode-description').after(options);
    }
    const urls = state.bootstrap?.connection?.lanUrls || [];
    options.classList.toggle('hidden', state.pairMode !== 'lan' || urls.length < 2);
    $('lan-address').replaceChildren(...urls.map((url) => new Option(url.replace(/^https?:\/\//, ''), url)));
    if (!urls.includes(state.lanUrl)) state.lanUrl = urls[0] || '';
    $('lan-address').value = state.lanUrl;
  }
  function updateInternetNote() {
    const info = state.bootstrap?.connection || {};
    const note = $('internet-note');
    note.replaceChildren();
    hidden('internet-note', state.pairMode !== 'internet');
    if (state.pairMode !== 'internet') return;
    if (info.publicUrl) {
      note.append(node('span', '', '互联网连接已开启。手机使用移动数据或其他 Wi-Fi，也可以扫码连接。'));
      const stop = node('button', 'text-button', '关闭互联网连接');
      stop.type = 'button'; stop.addEventListener('click', () => controlTunnel('stop'));
      note.append(stop);
    } else if (['starting', 'connecting', 'installing'].includes(info.tunnelStatus)) {
      note.append(node('span', '', '正在建立加密的互联网连接，首次启动可能需要下载连接组件。完成后会自动显示二维码。'));
    } else {
      note.append(node('span', '', info.tunnelError || '开启互联网连接后，手机可以通过移动数据远程控制这台电脑。链接仅对已确认的设备开放。'));
      const start = node('button', 'text-button', '开启互联网连接');
      start.type = 'button'; start.addEventListener('click', () => controlTunnel('start'));
      note.append(start);
    }
  }
  async function controlTunnel(action) {
    if (action === 'start') state.wantInternetPair = true;
    try {
      await api('/api/tunnel', { method: 'POST', body: { action } });
      if (action === 'stop') { state.pairing = null; state.wantInternetPair = false; }
      await bootstrap();
      if (action === 'stop') showPairPlaceholder('互联网连接已关闭');
      else if (state.bootstrap?.connection?.publicUrl) { state.wantInternetPair = false; await createPairing(); }
      else showPairPlaceholder('正在建立互联网连接…');
      updateInternetNote();
    } catch (error) { toast(error.message); state.wantInternetPair = false; }
  }
  function showPairPlaceholder(message) {
    hidden('pair-qr', true);
    hidden('qr-placeholder', false);
    $('qr-placeholder').querySelector('p').textContent = message;
    $('pair-url').value = '';
    $('pair-countdown').textContent = '请在电脑上完成连接设置';
  }
  async function createPairing() {
    if (state.pairingBusy || state.role !== 'owner') return;
    state.pairingBusy = true;
    $('refresh-pair').disabled = true;
    const mode = state.pairMode;
    updateInternetNote();
    try {
      if (mode === 'internet' && !state.bootstrap?.connection?.publicUrl) {
        state.pairing = null;
        showPairPlaceholder('开启互联网连接后生成二维码');
        return;
      }
      showPairPlaceholder('正在生成连接码');
      const data = await api('/api/pairing', { method: 'POST', body: { mode, ...(mode === 'lan' && state.lanUrl ? { baseUrl: state.lanUrl } : {}) } });
      if (mode !== state.pairMode) return;
      state.pairing = data;
      $('pair-url').value = data.url || '';
      if (data.qrDataUrl) {
        $('pair-qr').src = data.qrDataUrl;
        hidden('pair-qr', false);
        hidden('qr-placeholder', true);
      } else showPairPlaceholder('复制下方链接，在手机浏览器打开');
      $('pair-url').value = data.url || '';
      updateCountdown();
    } catch (error) {
      state.pairing = null;
      showPairPlaceholder(error.message);
    } finally { state.pairingBusy = false; $('refresh-pair').disabled = false; if (mode !== state.pairMode) createPairing(); }
  }
  function updateCountdown() {
    if (!state.pairing?.expiresAt) return;
    const expires = typeof state.pairing.expiresAt === 'number' ? state.pairing.expiresAt : new Date(state.pairing.expiresAt).getTime();
    const seconds = Math.max(0, Math.ceil(((expires < 1e12 ? expires * 1000 : expires) - Date.now()) / 1000));
    $('pair-countdown').textContent = seconds ? `二维码将在 ${seconds} 秒后过期 · 仅可使用一次` : '二维码已过期，请刷新后重新扫码';
    if (seconds === 0) { $('pair-qr').style.opacity = '.18'; $('copy-pair-url').disabled = true; if (!state.pairingBusy && $('pair-dialog').open) createPairing(); }
    else { $('pair-qr').style.opacity = '1'; $('copy-pair-url').disabled = false; }
  }
  async function loadDevices() {
    if (state.role !== 'owner' || state.devicesBusy) return;
    state.devicesBusy = true;
    try {
      const data = await api('/api/devices');
      const devices = data.devices || [];
      const key = JSON.stringify(devices);
      if (state.lastDevices === key) return;
      state.lastDevices = key;
      $('device-count').textContent = String(devices.filter((device) => device.status !== 'revoked').length);
      $('device-list').replaceChildren();
      if (!devices.length) $('device-list').append(node('p', 'list-empty', '扫码后，你的设备会显示在这里。'));
      for (const device of devices) {
        const row = node('div', 'device-row');
        row.append(icon('phone'));
        const info = node('div', 'device-info');
        info.append(node('strong', '', device.name || '未命名设备'));
        const pending = device.status === 'pending';
        info.append(node('small', '', `${pending ? '等待你的确认' : device.status === 'revoked' ? '连接已撤销' : '已允许连接'}${device.lastSeen ? ' · ' + dateLabel(device.lastSeen) : ''}`));
        row.append(info);
        if (pending) {
          const approve = node('button', 'button button-primary', '确认');
          approve.type = 'button'; approve.addEventListener('click', () => deviceAction(device.id, 'approve', approve));
          row.append(approve);
        }
        if (device.status !== 'revoked') {
          const revoke = node('button', 'button button-danger', pending ? '拒绝' : '撤销');
          revoke.type = 'button'; revoke.addEventListener('click', () => deviceAction(device.id, 'revoke', revoke));
          row.append(revoke);
        }
        $('device-list').append(row);
      }
    } catch (error) {
      if (!state.lastDevices) $('device-list').replaceChildren(node('p', 'list-empty', error.message));
    } finally { state.devicesBusy = false; }
  }
  async function deviceAction(id, action, button) {
    button.disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      toast(action === 'approve' ? '设备已确认，手机现在可以开始工作' : '已撤销此设备的连接');
      state.lastDevices = '';
      await loadDevices();
    } catch (error) { toast(error.message); button.disabled = false; }
  }
  async function submitPair(event) {
    event.preventDefault();
    const button = $('pair-form').querySelector('button');
    button.disabled = true;
    try {
      await api('/api/pair', { method: 'POST', body: { token: state.pairToken, name: $('device-name').value.trim() || '我的手机' } });
      state.pairToken = '';
      await bootstrap();
    } catch (error) { $('auth-note').textContent = error.message; }
    finally { button.disabled = false; }
  }

  $('pair-open').addEventListener('click', openPairDialog);
  $('chat-mode-codex').addEventListener('click', () => changeChatMode('codex'));
  $('chat-mode-gpt').addEventListener('click', () => changeChatMode('gpt'));
  $('desktop-project-create').addEventListener('click', () => $('desktop-project-dialog').showModal());
  $('desktop-project-close').addEventListener('click', () => $('desktop-project-dialog').close());
  $('desktop-project-refresh').addEventListener('click', async () => { await loadDesktopProjects({ fresh: true }); await loadThreads(); $('desktop-project-dialog').close(); });
  $('attach-files').addEventListener('click', () => { if (!$('attach-files').disabled) $('attachment-input').click(); });
  $('attachment-input').addEventListener('change', () => selectAttachments([...$('attachment-input').files]));
  $('reconnect').addEventListener('click', async () => {
    $('reconnect').disabled = true;
    try { await api('/api/reconnect', { method: 'POST', body: {} }); hidden('error-banner', true); state.lastStatus = ''; await bootstrap(); await loadThreads(); }
    catch (error) { showError(error); }
    finally { $('reconnect').disabled = false; }
  });
  $('welcome-pair').addEventListener('click', openPairDialog);
  $('pair-close').addEventListener('click', () => $('pair-dialog').close());
  $('pair-dialog').addEventListener('click', (event) => { if (event.target === $('pair-dialog')) { const box = $('pair-dialog').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('pair-dialog').close(); } });
  $('refresh-pair').addEventListener('click', createPairing);
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
    state.pairMode = button.dataset.mode;
    state.pairing = null;
    updateLanOptions();
    document.querySelectorAll('[data-mode]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-selected', String(item === button)); });
    $('pair-mode-description').textContent = state.pairMode === 'lan' ? '手机与电脑连接同一个 Wi-Fi 后扫码。' : '支持移动数据和其他 Wi-Fi，随时连接电脑。';
    await createPairing();
  }));
  $('copy-pair-url').addEventListener('click', async () => {
    const value = $('pair-url').value;
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else { $('pair-url').select(); if (!document.execCommand('copy')) throw new Error('copy'); }
      toast('连接地址已复制，请仅发送给你自己的设备');
    } catch { $('pair-url').select(); toast('请长按或按 Ctrl + C 复制连接地址'); }
  });
  $('pair-form').addEventListener('submit', submitPair);
  $('new-thread').addEventListener('click', resetConversation);
  $('projects-open').addEventListener('click', () => openFiles());
  $('thread-files').addEventListener('click', () => openFiles(true));
  $('files-sidebar').addEventListener('click', () => $('workspace').classList.add('sidebar-open'));
  $('files-back-chat').addEventListener('click', () => showView('chat'));
  $('files-refresh').addEventListener('click', async () => { await loadProjects(); await browseFiles(state.filePath); });
  $('files-project').addEventListener('change', () => { state.filesProjectId = $('files-project').value; browseFiles(''); });
  $('project-select').addEventListener('change', () => { state.projectId = $('project-select').value; updateProjectContext(); });
  $('project-task').addEventListener('click', () => { state.projectId = state.filesProjectId; $('project-select').value = state.projectId; resetConversation(); $('prompt').focus(); });
  $('model-select').addEventListener('change', () => renderEfforts());
  $('refresh-models').addEventListener('click', loadModels);
  $('fork-thread').addEventListener('click', forkThread);
  $('preview-close').addEventListener('click', () => $('preview-dialog').close());
  $('preview-dialog').addEventListener('close', () => { previewGeneration++; $('preview-content').replaceChildren(); });
  $('add-project-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await addProjectPath($('add-project-path').value.trim()); $('add-project-path').value = ''; }
    catch (error) { $('files-error').textContent = error.message; }
  });
  $('mobile-new').addEventListener('click', resetConversation);
  $('refresh-threads').addEventListener('click', async () => { await bootstrap(); state.lastThreads = ''; await loadDesktopProjects({ fresh: true }); await loadThreads(); toast('任务列表已刷新'); });
  $('load-gpt-history').addEventListener('click', loadGptHistory);
  $('sidebar-open').addEventListener('click', () => $('workspace').classList.add('sidebar-open'));
  $('sidebar-close').addEventListener('click', closeSidebar);
  $('sidebar-shade').addEventListener('click', closeSidebar);
  $('composer').addEventListener('submit', sendPrompt);
  $('prompt').addEventListener('input', resizePrompt);
  $('prompt').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } });
  $('stop-turn').addEventListener('click', stopTurn);
  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); clearConversationCache(); resetConversation(); await bootstrap(); }
    catch (error) { toast(error.message); }
  });
  document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; resizePrompt(); $('prompt').focus(); }));
  function refreshVisibleConversation() {
    if (codexVisible()) { loadThreads(); loadThread(); if (state.progressive) scheduleDetails(); }
    else { stopConversationReads(); clearTimeout(state.listPollTimer); state.listPollTimer = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) bootstrap(); refreshVisibleConversation(); });
  window.addEventListener('online', () => { bootstrap(); loadThread(); });
  window.addEventListener('offline', () => { state.connected = false; updateStatus(); });

  async function start() {
    const params = new URLSearchParams(location.hash.slice(1));
    const owner = params.get('owner');
    state.pairToken = params.get('pair') || '';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    const platform = /iPhone|iPad|iPod/.test(navigator.userAgent) ? '我的 iPhone' : /Android/.test(navigator.userAgent) ? '我的安卓手机' : '我的设备';
    $('device-name').value = platform;
    if (owner) {
      try { await api('/api/owner-login', { method: 'POST', body: { token: owner } }); }
      catch (error) { showAuth('电脑连接未完成', error.message, false, '请使用启动程序新打开的管理页面。'); return; }
    }
    await bootstrap();
    setInterval(() => { if (!document.hidden) bootstrap(); }, 3500);
    scheduleListPoll();
    setInterval(() => { if ($('pair-dialog').open) { updateCountdown(); loadDevices(); } }, 2000);
  }
  start();
})();
