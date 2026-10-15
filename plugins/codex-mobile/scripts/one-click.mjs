import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, lstat, writeFile } from 'node:fs/promises';
import { dataDirectory, readJson, noLinks, validateInstallation, validateWorkspace, findCodex } from '../lib/config.mjs';
import { setup, registeredMarketplace, installDiagnostic } from './setup.mjs';
export { installDiagnostic } from './setup.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
async function optionalJson(filename) { try { return await readJson(filename); } catch { return {}; } }
const supported = version => /^\d+\.\d+\.\d+$/.test(version) && (Number(version.split('.')[0]) > 1 || (Number(version.split('.')[0]) === 1 && Number(version.split('.')[1]) >= 3));

export async function resolveDataDirectory({ dataDir, env = process.env, home = os.homedir(), installationRoot, discoverCodex = findCodex, executeFile } = {}) {
  if (dataDir || env.CODEX_MOBILE_PLUGIN_DATA) return path.resolve(dataDir || env.CODEX_MOBILE_PLUGIN_DATA);
  const cache = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'plugins/cache/codex-mobile-local/codex-mobile');
  let versions; try { await noLinks(cache); versions = await readdir(cache, { withFileTypes: true }); } catch { versions = []; }
  versions = versions.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^\d+\.\d+\.\d+$/.test(entry.name)).sort((a, b) => { const av = a.name.split('.').map(Number), bv = b.name.split('.').map(Number); return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2]; }).slice(0, 50);
  for (const version of versions) {
    try {
      const root = path.join(cache, version.name), identity = await readJson(path.join(root, 'plugin.json'));
      if (identity.name !== 'codex-mobile' || identity.version !== version.name) continue;
      const candidate = (await readJson(path.join(root, 'mcp.json')))?.mcpServers?.mobile?.env?.CODEX_MOBILE_PLUGIN_DATA;
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
      await noLinks(candidate);
      const config = await readJson(path.join(candidate, 'config.json'));
      if (config.schema !== 1 || typeof config.installationRoot !== 'string' || typeof config.pluginSourceRoot !== 'string' || normalize(config.pluginSourceRoot) !== normalize(path.join(candidate, 'marketplace/plugins/codex-mobile'))) continue;
      return path.resolve(candidate);
    } catch { }
  }
  const codexBinary = await discoverCodex(installationRoot, { env, home });
  const registered = await registeredMarketplace(codexBinary, executeFile);
  if (registered && typeof registered.root === 'string' && path.isAbsolute(registered.root)) {
    const marketplaceRoot = path.resolve(registered.root), candidate = path.dirname(marketplaceRoot);
    try {
      await noLinks(path.join(candidate, 'config.json'));
      const config = await readJson(path.join(candidate, 'config.json'));
      if (config.schema !== 1 || typeof config.installationRoot !== 'string' || !path.isAbsolute(config.installationRoot)
        || typeof config.marketplaceRoot !== 'string' || normalize(config.marketplaceRoot) !== normalize(marketplaceRoot)
        || normalize(path.join(candidate, 'marketplace')) !== normalize(marketplaceRoot)
        || typeof config.pluginSourceRoot !== 'string' || normalize(config.pluginSourceRoot) !== normalize(path.join(marketplaceRoot, 'plugins/codex-mobile'))) throw new Error();
      const manifestPath = path.join(marketplaceRoot, '.agents/plugins/marketplace.json'); await noLinks(manifestPath);
      const manifest = await readJson(manifestPath);
      if (manifest.name !== 'codex-mobile-local' || !manifest.plugins?.some(item => item.name === 'codex-mobile' && item.source?.source === 'local' && item.source.path === './plugins/codex-mobile')) throw new Error();
      return candidate;
    } catch {
      throw Object.assign(new Error('检测到旧的移动助手插件源，但其配置无法核验。请用 --data-dir 明确指定原插件数据目录；安装器不会移除原插件源。'), { stage: 'marketplace-config' });
    }
  }
  return dataDirectory(env);
}

export async function discoverInstallation({ installationRoot, dataDir = dataDirectory(), source = packageRoot, home = os.homedir(), searchRoots, validate = validateInstallation } = {}) {
  async function accept(directory, explicit = false) {
    if (!directory || typeof directory !== 'string') return null;
    try {
      const result = await validate(path.resolve(directory));
      if (!supported(result.profile.version)) throw new Error('请使用 Editions 1.3.0 或更新版本的完整软件目录。');
      return result;
    } catch (error) { if (explicit) throw error; return null; }
  }
  if (installationRoot) return accept(installationRoot, true);
  const previous = await optionalJson(path.join(dataDir, 'config.json'));
  const saved = await accept(previous.installationRoot); if (saved) return saved;
  const nearby = [source, path.dirname(source)], roots = searchRoots || [path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(home, 'Applications'), ...(process.platform === 'darwin' ? ['/Applications'] : [])];
  async function search(roots) {
  const queue = roots.map(directory => ({ directory: path.resolve(directory), depth: 0 })), seen = new Set();
  let visited = 0; const matches = new Map();
  while (queue.length && visited < 300) {
    const { directory, depth } = queue.shift(), key = normalize(directory);
    if (seen.has(key) || normalize(path.parse(directory).root) === key) continue;
    seen.add(key); visited++;
    try { if ((await lstat(directory)).isSymbolicLink()) continue; } catch { continue; }
    const result = await accept(directory); if (result) { matches.set(normalize(result.root), result); continue; }
    if (depth >= 2) continue;
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !['node_modules', 'runtime', 'Library', 'AppData'].includes(entry.name)) queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
  }
  if (matches.size === 1) return matches.values().next().value;
  if (matches.size > 1) throw new Error('找到多套 Editions 软件，未自动选择。请将需要使用的软件文件夹拖到 Install-Plugin.cmd 上，或用 -InstallationRoot/--installation-root 明确指定目录。');
  return null;
  }
  const found = await search(nearby) || await search(roots.filter(root => !nearby.some(directory => normalize(directory) === normalize(root))));
  if (found) return found;
  throw new Error('未找到 Editions 完整软件目录。请把完整解压的插件文件夹放在软件文件夹旁边后重试；Windows 也可将软件文件夹拖到 Install-Plugin.cmd 上。无需提前打开 Codex。');
}

export async function chooseWorkspace({ installation, defaultCwd, dataDir = dataDirectory(), home = os.homedir(), documentsDir = path.join(home, 'Documents') }) {
  if (defaultCwd) return validateWorkspace(path.resolve(defaultCwd), installation.root);
  const previous = await optionalJson(path.join(dataDir, 'config.json'));
  const launcher = await optionalJson(path.join(installation.root, '.runtime/launcher.json'));
  const candidates = [typeof previous.installationRoot === 'string' && normalize(previous.installationRoot) === normalize(installation.root) ? previous.defaultCwd : null, launcher.defaultCwd];
  for (const candidate of candidates) { if (!candidate) continue; try { return await validateWorkspace(candidate, installation.root); } catch { } }
  const workspace = path.resolve(documentsDir, 'Codex-Mobile-Workspace');
  const relative = path.relative(installation.root, workspace);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('默认项目目录位于软件安装目录内。请用 -DefaultCwd/--default-cwd 指定独立项目文件夹。');
  await noLinks(workspace); await mkdir(workspace, { recursive: true });
  return validateWorkspace(workspace, installation.root);
}

export async function installOneClick(options = {}) {
  const dataDir = await resolveDataDirectory(options);
  const installation = await discoverInstallation({ ...options, dataDir });
  const defaultCwd = await chooseWorkspace({ ...options, installation, dataDir });
  const result = await (options.setupFn || setup)({ installationRoot: installation.root, defaultCwd, dataDir, source: options.source || packageRoot,
    register: options.register !== false, startBackend: async () => {}, ...(options.validate ? { validate: options.validate } : {}) });
  return { ...result, installationRoot: installation.root, defaultCwd, backendStarted: false };
}

export function installErrorMessage(error) {
  const message = String(error?.message || ''), details = message + '\n' + String(error?.stderr || '');
  if (/already added from a different source/i.test(details)) return '已注册的移动助手插件源位于另一目录。请复用原插件数据目录后重试；安装器不会移除原插件源。';
  if (/back up plugin cache|os error 5|access is denied|EBUSY|EPERM|拒绝访问/i.test(details)) return '插件注册未完成：当前插件缓存正被占用或没有写入权限。请关闭 Codex 中的移动助手插件后重试；安装器不会操作你的窗口或重启 Codex。';
  if (/[\u4e00-\u9fff]/.test(message) && !message.startsWith('Command failed:')) return message.slice(0, 700);
  return '插件安装未完成。请确认 Codex 已安装、软件完整包已解压且安装目录可以写入，再重试。无需提前打开 Codex；开始手机连接前需已登录 Codex。';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  async function record(message) { const directory = options.dataDir || dataDirectory(); try { await noLinks(directory); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'install-result.txt'), `${new Date().toISOString()}\n${message}\n`, 'utf8'); } catch { } }
  try {
    for (let index = 2; index < process.argv.length; index++) {
      const flag = process.argv[index];
      if (flag === '--manual') options.register = false;
      else if (flag === '--register') options.register = true;
      else if (flag === '--search-root' && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) (options.searchRoots ||= []).push(path.resolve(process.argv[++index]));
      else if (['--installation-root', '--default-cwd', '--data-dir', '--documents-dir'].includes(flag) && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) options[{ '--installation-root': 'installationRoot', '--default-cwd': 'defaultCwd', '--data-dir': 'dataDir', '--documents-dir': 'documentsDir' }[flag]] = path.resolve(process.argv[++index]);
      else throw new Error('安装参数无效。支持 --installation-root PATH、--default-cwd PATH、--data-dir PATH、--manual 和 --register。');
    }
    options.dataDir = await resolveDataDirectory(options);
    const result = await installOneClick(options);
    console.log(JSON.stringify(result, null, 2));
    const message = result.registered ? '插件已安装。无需提前打开 Codex；需要使用时打开 Codex，在插件详情点击“打开”。首次打开面板才启动后台，手机连接前请确保 Codex 已登录。' : '插件绑定已准备。使用 --register 完成注册；后台尚未启动。';
    console.log(message); await record(message + '\n' + JSON.stringify(result, null, 2));
  } catch (error) { const message = installErrorMessage(error) + '\n' + installDiagnostic(error); process.stderr.write(message + '\n'); await record(message); process.exitCode = 1; }
}
