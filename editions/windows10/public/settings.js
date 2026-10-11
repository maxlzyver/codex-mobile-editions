(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const storageKey = 'codex-mobile.windows10.appearance.v1';
  const defaults = Object.freeze({ theme: 'blue', font: 'system', size: 16, accent: null, text: null });
  const fonts = Object.freeze({
    system: '"PingFang SC","Microsoft YaHei UI","Segoe UI",sans-serif',
    yahei: '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif',
    pingfang: '"PingFang SC","Microsoft YaHei UI",sans-serif',
    segoe: '"Segoe UI","Microsoft YaHei UI",sans-serif',
    serif: '"Songti SC","SimSun",Georgia,serif',
    mono: '"Cascadia Code",Consolas,"Microsoft YaHei UI",monospace',
  });
  const themes = Object.freeze({
    blue: { accent: '#3565e8', ink: '#202c40', muted: '#647187', line: '#e2e7f0', paper: '#ffffff', canvas: '#f5f7fb', surface: '#eef2f8' },
    sage: { accent: '#39765b', ink: '#233c32', muted: '#617568', line: '#dfe7e0', paper: '#ffffff', canvas: '#f5f8f4', surface: '#edf2eb' },
    violet: { accent: '#7954ca', ink: '#352b49', muted: '#756985', line: '#e7e0ef', paper: '#ffffff', canvas: '#f8f6fc', surface: '#f0ecf7' },
    rose: { accent: '#b64e73', ink: '#442e39', muted: '#826975', line: '#ecdfe4', paper: '#ffffff', canvas: '#fcf6f8', surface: '#f7ecf0' },
    dark: { accent: '#8eaafd', ink: '#e4eaf5', muted: '#a6b2c5', line: '#354156', paper: '#202b3c', canvas: '#16202f', surface: '#293549' },
  });
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const isColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const sanitize = (value) => ({
    theme: own(themes, value?.theme) ? value.theme : defaults.theme,
    font: own(fonts, value?.font) ? value.font : defaults.font,
    size: Number.isFinite(Number(value?.size)) ? Math.min(22, Math.max(14, Math.round(Number(value.size)))) : defaults.size,
    accent: isColor(value?.accent) ? value.accent : null,
    text: isColor(value?.text) ? value.text : null,
  });
  let appearance = { ...defaults };
  try { const saved = localStorage.getItem(storageKey); if (saved) appearance = sanitize(JSON.parse(saved)); } catch { /* Private browsing may disable storage. */ }
  function rgb(hex) { return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)); }
  function blend(front, back, amount) { const a = rgb(front); return `#${rgb(back).map((n, i) => Math.round(a[i] * amount + n * (1 - amount)).toString(16).padStart(2, '0')).join('')}`; }
  function foreground(hex) {
    const c = rgb(hex).map((v) => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2] > .179 ? '#142035' : '#ffffff';
  }
  function applyAppearance(save = false) {
    appearance = sanitize(appearance);
    const palette = themes[appearance.theme];
    const accent = appearance.accent || palette.accent;
    const root = document.documentElement;
    root.dataset.theme = appearance.theme;
    for (const key of ['muted', 'line', 'paper', 'canvas', 'surface']) root.style.setProperty(`--${key}`, palette[key]);
    root.style.setProperty('--ink', appearance.text || palette.ink);
    root.style.setProperty('--green', accent);
    root.style.setProperty('--green-soft', blend(accent, palette.paper, appearance.theme === 'dark' ? .17 : .1));
    root.style.setProperty('--on-accent', foreground(accent));
    root.style.setProperty('--danger', appearance.theme === 'dark' ? '#ffaaa3' : '#b54040');
    root.style.setProperty('--danger-soft', appearance.theme === 'dark' ? '#422d36' : '#fff0ef');
    root.style.setProperty('--warning', appearance.theme === 'dark' ? '#ead29d' : '#805b20');
    root.style.setProperty('--warning-soft', appearance.theme === 'dark' ? '#39362e' : '#fff8e9');
    root.style.fontFamily = fonts[appearance.font];
    root.style.fontSize = `${appearance.size}px`;
    root.style.colorScheme = appearance.theme === 'dark' ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.canvas);
    document.querySelectorAll('[data-theme-choice]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === appearance.theme)));
    $('appearance-accent').value = accent;
    $('appearance-text').value = appearance.text || palette.ink;
    $('appearance-font').value = appearance.font;
    $('appearance-size').value = appearance.size;
    $('appearance-size-value').textContent = `${appearance.size} px`;
    if (save) {
      try { localStorage.setItem(storageKey, JSON.stringify(appearance)); $('appearance-feedback').textContent = '已保存到当前浏览器，手机和电脑可使用不同外观。'; }
      catch { $('appearance-feedback').textContent = '外观已生效。当前浏览器无法保存偏好，重新打开后可能需要再次设置。'; }
    }
  }
  applyAppearance();
  document.querySelectorAll('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => {
    appearance.theme = button.dataset.themeChoice; appearance.accent = null; appearance.text = null; applyAppearance(true);
  }));
  $('appearance-accent').addEventListener('input', (event) => { appearance.accent = event.target.value; applyAppearance(true); });
  $('appearance-text').addEventListener('input', (event) => { appearance.text = event.target.value; applyAppearance(true); });
  $('appearance-font').addEventListener('change', (event) => { appearance.font = event.target.value; applyAppearance(true); });
  $('appearance-size').addEventListener('input', (event) => { appearance.size = Number(event.target.value); applyAppearance(true); });
  $('appearance-reset').addEventListener('click', () => { appearance = { ...defaults }; applyAppearance(true); });
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return;
    try { appearance = event.newValue ? sanitize(JSON.parse(event.newValue)) : { ...defaults }; applyAppearance(); } catch { /* Ignore malformed data in another tab. */ }
  });

  const dialog = $('settings-dialog');
  const tabs = [...document.querySelectorAll('.settings-tabs [role="tab"]')];
  let activeTab = 'appearance';
  let role = 'anonymous';
  let csrf = '';
  let updateState = null;
  let updateBusy = false;
  let updateLoading = false;
  let updateTimer = null;
  function selectTab(name) {
    activeTab = name;
    tabs.forEach((tab) => {
      const active = tab.id === `settings-tab-${name}`;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute('aria-controls')).classList.toggle('hidden', !active);
    });
    if (name === 'about') loadUpdates();
    else clearTimeout(updateTimer);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.id.slice('settings-tab-'.length)));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); selectTab(tabs[next].id.slice('settings-tab-'.length));
    });
  });
  $('settings-open').addEventListener('click', () => { dialog.showModal(); if (activeTab === 'about') loadUpdates(); });
  $('settings-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => clearTimeout(updateTimer));
  const supportDialog = $('support-dialog');
  $('support-open').addEventListener('click', () => supportDialog.showModal());
  $('support-close').addEventListener('click', () => supportDialog.close());
  supportDialog.addEventListener('click', (event) => {
    if (event.target !== supportDialog) return;
    const rect = supportDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) supportDialog.close();
  });
  async function request(path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf; }
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `请求失败（${response.status}）`);
    return result;
  }
  async function identity() {
    const data = await request('/api/bootstrap');
    role = data.role || 'anonymous'; csrf = data.csrfToken || '';
    if (data.app?.version) $('about-version').textContent = `v${data.app.version}`;
    return role === 'owner' || role === 'controller';
  }
  function accessMessage() {
    return role === 'owner' ? '更新安装在这台电脑上，手机端会随之使用新版本。' : role === 'controller' ? '请在电脑端控制台管理更新；此设备可以查看更新状态。' : '连接并批准设备后，可查看这台电脑的更新状态。';
  }
  function renderUpdates() {
    const state = updateState || { status: 'idle' };
    const version = state.latestVersion ? `v${state.latestVersion}` : '新版本';
    const labels = {
      idle: '尚未检查更新', checking: '正在检查 GitHub 上的新版本…', unpublished: '仓库尚未提供版本清单或安装包',
      upToDate: '当前已是最新版本', available: `发现新版本 ${version}`, downloading: `正在下载 ${version}…`,
      prepared: '更新已下载，待安装', waitingForIdle: '等待任务空闲后更新', installing: '正在安装更新，连接可能暂时中断',
      installed: '更新已安装，刷新页面即可使用', error: '更新未完成',
    };
    const status = state.status || 'idle';
    document.querySelector('.update-card').dataset.status = status;
    $('update-status').textContent = labels[status] || '正在获取更新状态';
    if (state.currentVersion) $('about-version').textContent = `v${state.currentVersion}`;
    const parts = [];
    if (state.error) parts.push(String(state.error));
    if (state.reason && state.reason !== state.error) parts.push(String(state.reason));
    if (status === 'unpublished') parts.push('作者把本版文件和 update.json 上传 GitHub 的 editions/windows10 目录后，即可检查本平台更新。');
    if (state.checkedAt) {
      const date = new Date(state.checkedAt);
      if (Number.isFinite(date.getTime())) parts.push(`上次检查：${date.toLocaleString('zh-CN', { hour12: false })}`);
    }
    $('update-detail').textContent = parts.join(' · ');
    $('update-detail').classList.toggle('hidden', !parts.length);
    const inflight = ['checking', 'downloading', 'installing'].includes(status);
    const owner = role === 'owner';
    $('update-check').disabled = !owner || updateBusy || inflight;
    $('update-check').textContent = status === 'checking' ? '正在检查…' : '检查更新';
    const canInstall = ['available', 'prepared', 'waitingForIdle'].includes(status) || status === 'error' && state.latestVersion && state.latestVersion !== state.currentVersion;
    $('update-install').classList.toggle('hidden', !canInstall);
    $('update-install').textContent = status === 'waitingForIdle' ? '重新尝试安装' : '安装更新';
    $('update-install').disabled = !owner || updateBusy || inflight;
    $('update-auto').checked = Boolean(state.autoUpdate);
    $('update-auto').disabled = !owner || updateBusy;
    $('update-permission').textContent = accessMessage();
    const releaseUrl = typeof state.releaseUrl === 'string' && /^https:\/\/github\.com\/maxlzyver\/codex-mobile-editions(?:\/|$)/i.test(state.releaseUrl) ? state.releaseUrl : null;
    $('update-release').classList.toggle('hidden', !releaseUrl);
    if (releaseUrl) $('update-release').href = releaseUrl;
    const amount = typeof state.progress === 'number' ? state.progress : state.progress?.total > 0
      ? state.progress.received / state.progress.total * 100 : Number(state.progress?.percent);
    $('update-progress').classList.toggle('hidden', status !== 'downloading');
    if (Number.isFinite(amount)) $('update-progress').value = Math.max(0, Math.min(100, amount));
    else $('update-progress').removeAttribute('value');
  }
  function scheduleUpdateRefresh() {
    clearTimeout(updateTimer);
    if (dialog.open && activeTab === 'about' && ['owner', 'controller'].includes(role)) updateTimer = setTimeout(loadUpdates, ['checking', 'downloading', 'prepared', 'waitingForIdle', 'installing'].includes(updateState?.status) ? 1600 : 12000);
  }
  async function loadUpdates() {
    if (updateLoading || updateBusy) return;
    updateLoading = true;
    try {
      if (await identity()) updateState = await request('/api/updates');
      else updateState = null;
      renderUpdates();
    } catch (error) {
      renderUpdates();
      $('update-status').textContent = updateState?.status === 'installing' ? '正在重启移动助手，请稍候…' : '暂时无法获取更新状态';
      $('update-detail').textContent = error.message;
      $('update-detail').classList.remove('hidden');
    } finally { updateLoading = false; scheduleUpdateRefresh(); }
  }
  async function changeUpdate(path, payload) {
    if (updateBusy || role !== 'owner') return;
    const previousState = updateState;
    if (path === '/api/updates/settings') updateState = { ...updateState, autoUpdate: payload.autoUpdate };
    if (path === '/api/updates/check') updateState = { ...updateState, status: 'checking', error: null, reason: null };
    updateBusy = true; clearTimeout(updateTimer); renderUpdates();
    try {
      if (!(await identity()) || role !== 'owner') throw new Error('请在电脑端控制台管理更新。');
      updateState = await request(path, payload);
      renderUpdates();
    } catch (error) {
      updateState = previousState;
      renderUpdates();
      $('update-status').textContent = '操作未完成'; $('update-detail').textContent = error.message; $('update-detail').classList.remove('hidden');
    } finally { updateBusy = false; renderButtons(); scheduleUpdateRefresh(); }
  }
  function renderButtons() {
    const status = updateState?.status;
    const busy = updateBusy || ['checking', 'downloading', 'installing'].includes(status);
    $('update-check').disabled = role !== 'owner' || busy;
    $('update-install').disabled = role !== 'owner' || busy;
    $('update-auto').disabled = role !== 'owner' || updateBusy;
  }
  $('update-check').addEventListener('click', () => changeUpdate('/api/updates/check', {}));
  $('update-install').addEventListener('click', () => changeUpdate('/api/updates/install', {}));
  $('update-auto').addEventListener('change', (event) => changeUpdate('/api/updates/settings', { autoUpdate: event.target.checked }));
  renderUpdates();
})();
