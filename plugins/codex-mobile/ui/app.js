import { App, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'Codex 移动助手', version: '1.3.1' }, {}, { autoResize: true });
const $ = id => document.getElementById(id);
let state = {}, activeTab = 'connect', inFlight = false, connected = false, pairing = null;
const recentlyApproved = new Set();
const names = { connect: '手机连接', devices: '设备', permissions: '手机权限', help: '使用说明', updates: '更新', about: '关于' };
const statusNames = { current: '已是最新版本', upToDate: '已是最新版本', unpublished: '尚无已发布更新', prepared: '更新已下载，等待安装', scheduled: '已安排安装', waitingForIdle: '等待任务空闲', idle: '尚未检查', checking: '正在检查', available: '有可用更新', downloading: '正在下载并校验', installing: '正在安装', waiting: '等待任务空闲', pending_restart: '已安装，待 Codex 重新加载', error: '更新失败', stopped: '未启用', running: '已连接', starting: '正在连接', connected: '已连接', connecting: '正在连接' };
function text(id, value) { $(id).textContent = value ?? '—'; }
function showTab(tab) { if (!names[tab]) return; activeTab = tab; for (const pane of document.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab; for (const button of document.querySelectorAll('[data-tab]')) { button.classList.toggle('selected', button.dataset.tab === tab); button.setAttribute('aria-selected', String(button.dataset.tab === tab)); } }
function notice(message, error = false) { text('notice', message); $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
function deviceRow(device, { summary = false } = {}) {
  const pending = device.status === 'pending';
  const row = document.createElement('div'); row.className = 'device'; row.dataset.deviceId = device.id;
  const label = document.createElement('div'), title = document.createElement('strong'), description = document.createElement('small');
  title.textContent = device.name || '新设备';
  description.textContent = pending ? '已扫码，等待你批准连接' : summary ? '连接已批准，可以在手机上继续。' : '已批准';
  label.append(title, description); row.append(label);
  if (summary && !pending) {
    const status = document.createElement('span'); status.className = 'device-approved'; status.textContent = '已批准'; row.append(status);
  } else {
    const button = document.createElement('button'); button.textContent = pending ? '批准连接' : '撤销权限'; button.className = pending ? 'primary' : '';
    button.disabled = inFlight; button.onclick = () => call('mobile_device_change', { id: device.id, action: pending ? 'approve' : 'revoke' }); row.append(button);
  }
  return row;
}
function renderDevices(devices) {
  const deviceList = $('device-list'); deviceList.replaceChildren(...devices.map(device => deviceRow(device)));
  if (!devices.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '暂时没有待批准或已授权的设备。'; deviceList.append(empty); }
  for (const id of recentlyApproved) if (!devices.some(device => device.id === id && device.status === 'approved')) recentlyApproved.delete(id);
  const pending = devices.filter(device => device.status === 'pending');
  const approved = devices.filter(device => recentlyApproved.has(device.id));
  $('pending-devices').hidden = pending.length + approved.length === 0;
  text('pending-heading', pending.length ? '批准新设备连接' : '连接已批准');
  text('pending-summary', pending.length ? `${pending.length} 台设备正在等待。在这里批准后，即可在手机上继续。` : '设备已经可以使用，无需离开当前页面。');
  $('pending-device-list').replaceChildren(...[...pending, ...approved].map(device => deviceRow(device, { summary: true })));
  $('dismiss-approved').hidden = approved.length === 0; $('dismiss-approved').disabled = inFlight;
}
function render(next, { initial = false } = {}) {
  if (!next) return; state = next;
  const backend = state.backend, permissions = backend?.permissions || {};
  text('version', `插件 ${state.pluginVersion || '1.3.1'}`);
  text('service-status', backend ? `后台 ${backend.app?.version || backend.status?.version || ''} · ${statusNames[backend.status?.codex] || backend.status?.codex || '就绪'}` : state.configured ? '后台尚未连接' : '需要首次安装绑定');
  text('connection-error', state.error || backend?.status?.error || '');
  $('start').disabled = inFlight || !state.configured;
  for (const button of document.querySelectorAll('[data-needs-service]')) button.disabled = inFlight || !backend;
  text('lan-addresses', backend?.connection?.lanUrls?.join(' · ') || '启动后显示当前局域网入口');
  text('tunnel-status', statusNames[backend?.connection?.tunnelStatus] || backend?.connection?.tunnelStatus || '未启用');
  text('tunnel-error', backend?.connection?.tunnelError || '');
  for (const key of ['allowMobileApprovals', 'allowMobileStop', 'allowOtherFiles']) {
    if (!inFlight) $(key).checked = permissions[key] === true;
    $(key).disabled = inFlight || !backend;
    text(`${key}-state`, $(key).checked ? '已开启' : '已关闭');
  }
  text('permission-manager-note', backend ? '权限与软件版共用，保存后立即生效。仅开启你需要的权限。' : '连接后台后，可以在这里管理手机权限。');
  renderDevices(backend?.devices || []);
  renderUpdate('plugin', state.pluginUpdate, true); renderUpdate('backend', backend?.updates, false);
  text('about-versions', `插件运行版本：${state.pluginVersion || '1.3.1'}；后台版本：${backend?.app?.version || backend?.status?.version || '未连接'}`);
  text('busy-state', backend?.busy ? '当前有任务执行或状态尚未确认，更新会等待。' : '当前后台空闲。');
  if (initial && state.focus) showTab(state.focus);
}
function renderUpdate(prefix, update, plugin) {
  text(`${prefix}-loaded`, plugin ? update?.loadedVersion : update?.currentVersion);
  text(`${prefix}-latest`, update?.latestVersion || '尚未检查');
  text(`${prefix}-update-status`, statusNames[update?.status] || (update?.status ? '状态待确认' : '尚未检查'));
  text(`${prefix}-notes`, update?.releaseNotes || '检查更新后显示版本说明。');
  text(`${prefix}-update-error`, update?.error || '');
  if (!inFlight) $(`${prefix}-auto`).checked = update?.autoUpdate === true;
  $(`${prefix}-auto`).disabled = inFlight || (!plugin && !state.backend) || !state.configured;
  $(`${prefix}-install`).disabled = inFlight || !update?.hasUpdate;
  $(`${prefix}-check`).disabled = inFlight || !state.configured || (!plugin && !state.backend);
  if (plugin) { text('plugin-installed', update?.installedVersion); text('plugin-refresh', update?.pendingRestart ? update.hostRefresh || '插件文件已安装。请重新加载插件或重启 Codex，当前会话仍运行旧版。' : '当前加载版本已生效。'); }
}
async function call(name, args = {}, { quiet = false } = {}) {
  if (!connected || inFlight) return;
  inFlight = true; render(state); if (!quiet) notice('正在处理…');
  try {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.find(v => v.type === 'text')?.text || '操作失败。');
    if (name === 'mobile_device_change') {
      if (args.action === 'approve' && result.structuredContent?.backend?.devices?.some(device => device.id === args.id && device.status === 'approved')) recentlyApproved.add(args.id);
      if (args.action === 'revoke') recentlyApproved.delete(args.id);
    }
    if (result.structuredContent?.configured !== undefined) render(result.structuredContent);
    if (result._meta?.mobile?.pairing) { pairing = result._meta.mobile.pairing; $('pairing-box').hidden = false; $('pairing-qr').src = pairing.qrDataUrl; text('pairing-link', pairing.url); text('pairing-expiry', '二维码 2 分钟内有效且仅可使用一次。扫码后，新设备会显示在本页上方，点击“批准连接”即可。'); }
    if (name === 'mobile_diagnose') { $('diagnostics').replaceChildren(); for (const check of result.structuredContent?.checks || []) { const p = document.createElement('p'); p.textContent = `${check.ok ? '✓' : '•'} ${check.name}：${check.message}`; $('diagnostics').append(p); } }
    if (!quiet) notice('已完成。');
    return result;
  } catch (error) { if (!quiet) notice(error.message, true); }
  finally { inFlight = false; render(state); }
}
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => showTab(button.dataset.tab);
$('start').onclick = () => call('mobile_start'); $('refresh').onclick = () => call('mobile_status'); $('reconnect').onclick = () => call('mobile_reconnect');
$('pair-lan').onclick = () => call('mobile_pairing', { mode: 'lan' }); $('pair-internet').onclick = () => call('mobile_pairing', { mode: 'internet' });
$('internet-on').onclick = () => call('mobile_tunnel', { action: 'start' }); $('internet-off').onclick = () => call('mobile_tunnel', { action: 'stop' });
$('diagnose').onclick = () => call('mobile_diagnose');
$('dismiss-approved').onclick = () => { recentlyApproved.clear(); renderDevices(state.backend?.devices || []); };
for (const [id, url] of Object.entries({ repository: 'https://github.com/maxlzyver/codex-mobile-editions', feedback: 'mailto:lzyuan666666@gmail.com', license: 'https://github.com/maxlzyver/codex-mobile-editions/blob/main/LICENSE' })) $(id).onclick = async () => {
  try { const result = await app.openLink({ url }); if (result.isError) throw new Error(); }
  catch { notice(`宿主未打开链接，可手动使用：${url}`); }
};
for (const key of ['allowMobileApprovals', 'allowMobileStop', 'allowOtherFiles']) $(key).onchange = () => call('mobile_permissions', { [key]: $(key).checked });
for (const prefix of ['plugin', 'backend']) {
  $(`${prefix}-check`).onclick = () => call(`mobile_${prefix}_update`, { action: 'check' });
  $(`${prefix}-install`).onclick = () => call(`mobile_${prefix}_update`, { action: 'install' });
  $(`${prefix}-auto`).onchange = () => call(`mobile_${prefix}_auto_update`, { autoUpdate: $(`${prefix}-auto`).checked });
}
app.ontoolresult = value => { if (value.structuredContent?.configured !== undefined) render(value.structuredContent, { initial: true }); };
app.onhostcontextchanged = context => { if (context.styles?.variables) applyHostStyleVariables(context.styles.variables); document.documentElement.dataset.theme = context.theme || 'light'; };
try {
  await app.connect(); connected = true;
  const context = app.getHostContext(); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables); document.documentElement.dataset.theme = context?.theme || 'light';
  notice(''); await call('mobile_status', {}, { quiet: true });
  setInterval(() => { if (document.visibilityState !== 'hidden' && !inFlight) call('mobile_status', {}, { quiet: true }); if (pairing && pairing.expiresAt <= Date.now()) { pairing = null; $('pairing-qr').removeAttribute('src'); text('pairing-link', ''); text('pairing-expiry', '二维码已过期，请重新生成。'); } }, 5000);
} catch { notice('当前宿主未建立 MCP Apps 页面连接。请在支持该插件的 Codex 桌面版本中重新打开。', true); }
