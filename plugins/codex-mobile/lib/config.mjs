import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, lstat, realpath, readdir } from 'node:fs/promises';
const execute = promisify(execFile);

export function dataDirectory(env = process.env, platform = process.platform) {
  if (env.CODEX_MOBILE_PLUGIN_DATA) return path.resolve(env.CODEX_MOBILE_PLUGIN_DATA);
  return platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'CodexMobile/plugin')
    : path.join(os.homedir(), platform === 'darwin' ? 'Library/Application Support/CodexMobile/plugin' : '.local/share/codex-mobile/plugin');
}
export const readJson = async filename => JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
export async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, filename);
}
export async function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('安装及配置目录不能经过符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
export async function loadConfig(dataDir = dataDirectory()) {
  await noLinks(dataDir);
  try { return await readJson(path.join(dataDir, 'config.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('插件配置无法读取，请重新运行安装绑定工具。'); }
}
export function bundledNode(root, platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return path.join(root, 'runtime/node.exe');
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return path.join(root, `runtime/darwin-${arch}/bin/node`);
  throw new Error('插件仅支持 Windows x64 和 macOS Apple 芯片/Intel。');
}
export async function validateInstallation(directory, { platform = process.platform, arch = process.arch, checkRuntime = true } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择完整安装包解压后的绝对路径。');
  await noLinks(directory);
  const root = await realpath(directory), profile = await readJson(path.join(root, 'edition.json'));
  const pkg = await readJson(path.join(root, 'package.json'));
  if (!['windows11', 'windows10', 'macos'].includes(profile.id) || pkg.name !== 'codex-mobile-console' || profile.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('所选目录不是有效的 Editions 安装。');
  if ((platform === 'win32' && profile.id === 'macos') || (platform === 'darwin' && profile.id !== 'macos')) throw new Error('所选安装与当前系统不匹配。');
  const nodePath = bundledNode(root, platform, arch);
  if (checkRuntime) {
    await noLinks(nodePath);
    if (!(await lstat(nodePath)).isFile()) throw new Error('缺少完整包中的 Node.js 运行组件。');
    const { stdout } = await execute(nodePath, ['--version'], { timeout: 5000, windowsHide: true });
    if (Number(/^v(\d+)/.exec(stdout)?.[1]) < 24 || !/^v\d+/.test(stdout)) throw new Error('需要完整包中的 Node.js 24 或更新版本。');
  }
  return { root, profile, nodePath };
}
export function materializeMcp(template, config, dataDir) {
  if (!template?.mcpServers?.mobile) throw new Error('插件 MCP 配置缺少 mobile 服务。');
  const result = structuredClone(template);
  const executable = path.basename(config.nodePath);
  if (!['node', 'node.exe'].includes(executable)) throw new Error('绑定的运行组件名称无效。');
  const inheritedPath = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] || '';
  result.mcpServers.mobile = { ...result.mcpServers.mobile, type: 'stdio', command: executable,
    args: ['${PLUGIN_ROOT}/dist/server.mjs'], cwd: '${PLUGIN_ROOT}',
    env: { CODEX_MOBILE_PLUGIN_DATA: dataDir, PATH: [path.dirname(config.nodePath), inheritedPath].filter(Boolean).join(path.delimiter) } };
  return result;
}

export async function verifyRuntime(config, executable = process.execPath) {
  if (!config) return;
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const [actual, expected] = await Promise.all([realpath(executable), realpath(config.nodePath)]);
  if (normalize(actual) !== normalize(expected)) throw new Error('插件必须使用绑定的软件运行组件。请重新运行安装绑定工具，刷新 Codex 插件后重试。');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('插件需要绑定软件中的 Node.js 24 或更新版本。');
}

export async function validateWorkspace(directory, installationRoot) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await lstat(directory)).isDirectory()) throw new Error('工作目录必须是已存在的独立项目文件夹。');
  const resolved = await realpath(directory), installation = await realpath(installationRoot);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const value = normalize(resolved), root = normalize(installation);
  if (value === normalize(path.parse(resolved).root) || value === root || value.startsWith(root + path.sep)) throw new Error('工作目录不能是磁盘根目录、助手安装目录或其子目录。');
  return resolved;
}

export async function findCodex(installationRoot, { env = process.env, platform = process.platform, home = os.homedir(), executeFile = execute } = {}) {
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  async function usable(candidate) {
    if (!candidate || !path.isAbsolute(candidate) || (platform === 'win32' && !candidate.toLowerCase().endsWith('.exe'))) return null;
    try { const file = await realpath(candidate); if (!(await lstat(file)).isFile()) return null;
      const { stdout } = await executeFile(file, ['--version'], { timeout: 6000, maxBuffer: 4096, windowsHide: true });
      return /codex/i.test(stdout) ? file : null;
    } catch { return null; }
  }
  if (env.CODEX_BINARY) { const found = await usable(env.CODEX_BINARY); if (!found) throw new Error('CODEX_BINARY 没有指向可运行的 Codex CLI，请修正后重试。'); return found; }
  let saved; try { saved = (await readJson(path.join(installationRoot, '.runtime/launcher.json'))).codexBinary; } catch { }
  const candidates = [saved, ...(env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/g, ''), executable))];
  if (platform === 'darwin') candidates.push('/Applications/Codex.app/Contents/Resources/codex', path.join(home, 'Applications/Codex.app/Contents/Resources/codex'), path.join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  for (const candidate of candidates) { const found = await usable(candidate); if (found) return found; }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData/Local'), roaming = env.APPDATA || path.join(home, 'AppData/Roaming');
    const roots = [[path.join(local, 'OpenAI/Codex/bin'), 5], [path.join(local, 'Programs/Codex'), 6], [path.join(roaming, 'npm/node_modules/@openai/codex'), 10], [path.join(home, '.codex/bin'), 3]];
    let visited = 0;
    async function search(directory, depth) {
      if (depth < 0 || ++visited > 1200) return null;
      let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return null; }
      for (const item of entries) if (item.isFile() && item.name.toLowerCase() === 'codex.exe') { const found = await usable(path.join(directory, item.name)); if (found) return found; }
      for (const item of entries) if (item.isDirectory() && !item.isSymbolicLink()) { const found = await search(path.join(directory, item.name), depth - 1); if (found) return found; }
      return null;
    }
    for (const [directory, depth] of roots) { const found = await search(directory, depth); if (found) return found; }
  }
  throw new Error('未找到兼容的 Codex CLI。请先安装 Codex，或将 CODEX_BINARY 指向其 CLI 可执行文件。');
}
