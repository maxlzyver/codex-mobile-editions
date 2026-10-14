import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, copyFile, lstat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDirectory, readJson, writeJson, noLinks, validateInstallation, materializeMcp, validateWorkspace, findCodex } from '../lib/config.mjs';
import { Backend } from '../lib/backend.mjs';
import { validatePluginPath } from '../lib/plugin-updater.mjs';

const execute = promisify(execFile);
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directories = new Set(['lib', 'dist', 'ui', 'scripts', 'skills', 'assets', 'licenses', '.codex-plugin']);
const rootFiles = new Set(['plugin.json', 'mcp.json', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Install-Plugin.ps1', 'Install-Plugin.command', 'update.json']);
export async function setup({ installationRoot, defaultCwd, dataDir = dataDirectory(), source = packageRoot, register = false, validate = validateInstallation, discoverCodex = findCodex, startBackend }) {
  const installation = await validate(installationRoot);
  if (defaultCwd) defaultCwd = await validateWorkspace(defaultCwd, installation.root);
  await noLinks(dataDir); await noLinks(source);
  const marketplaceRoot = path.join(dataDir, 'marketplace'), pluginSourceRoot = path.join(marketplaceRoot, 'plugins/codex-mobile');
  const sourceIdentity = await readJson(path.join(source, 'plugin.json'));
  if (sourceIdentity.name !== 'codex-mobile') throw new Error('所选插件包身份无效。');
  let previous = {}; try { previous = await readJson(path.join(dataDir, 'config.json')); } catch { }
  const configuredCwd = defaultCwd || (previous.installationRoot === installation.root ? previous.defaultCwd : undefined);
  const codexBinary = await discoverCodex(installation.root);
  const config = { schema: 1, installationRoot: installation.root, nodePath: installation.nodePath, codexBinary, ...(configuredCwd ? { defaultCwd: configuredCwd } : {}), pluginSourceRoot, marketplaceRoot };
  // Only package-owned files are copied. Runtime credentials and other plugins never enter this source.
  async function copy(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && !(entry.isDirectory() ? directories.has(entry.name) : rootFiles.has(entry.name))) continue;
      if (entry.isSymbolicLink()) throw new Error('插件包不能包含符号链接。');
      if (['ui/app.js', 'ui/template.html', 'scripts/build.mjs', 'scripts/test-ui.mjs'].includes(rel)) continue;
      if (entry.isDirectory()) { await copy(path.join(directory, entry.name), rel); continue; }
      if (!entry.isFile()) throw new Error('插件包包含非普通文件。');
      if (rel !== 'update.json') validatePluginPath(rel);
      const target = path.join(pluginSourceRoot, rel); await noLinks(target);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (path.resolve(directory, entry.name) !== path.resolve(target)) await copyFile(path.join(directory, entry.name), target);
    }
  }
  await copy(source);
  await writeJson(path.join(pluginSourceRoot, 'mcp.json'), materializeMcp(await readJson(path.join(source, 'mcp.json')), config, dataDir));
  await writeJson(path.join(dataDir, 'config.json'), config);
  await writeJson(path.join(marketplaceRoot, '.agents/plugins/marketplace.json'), {
    name: 'codex-mobile-local', interface: { displayName: 'Codex 移动助手' }, plugins: [{ name: 'codex-mobile', source: { source: 'local', path: './plugins/codex-mobile' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  });
  let registered = false;
  if (register) {
    await execute(codexBinary, ['plugin', 'marketplace', 'add', marketplaceRoot], { windowsHide: true, timeout: 45000, maxBuffer: 64000 });
    await execute(codexBinary, ['plugin', 'add', 'codex-mobile@codex-mobile-local', '--json'], { windowsHide: true, timeout: 45000, maxBuffer: 64000 }); registered = true;
    await (startBackend ? startBackend(config) : new Backend(config).ensureStarted());
  }
  return { version: sourceIdentity.version, marketplaceRoot, pluginSourceRoot, dataDir, registered };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = {};
  for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index];
    if (key === '--register') values.register = true;
    else if (['--installation-root', '--default-cwd', '--data-dir'].includes(key) && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) values[{ '--installation-root': 'installationRoot', '--default-cwd': 'defaultCwd', '--data-dir': 'dataDir' }[key]] = path.resolve(process.argv[++index]);
    else throw new Error('参数无效。使用 --installation-root PATH [--default-cwd PATH] [--register]。');
  }
  setup(values).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
