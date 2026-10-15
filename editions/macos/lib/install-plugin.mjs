import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';

const editionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootFiles = new Set(['plugin.json', 'package.json', 'mcp.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Install-Plugin.ps1', 'Install-Plugin.command', 'update.json']);
const directories = new Set(['lib', 'dist', 'ui', 'scripts', 'skills', 'assets', 'licenses']);
const required = ['plugin.json', 'package.json', '.codex-plugin/plugin.json', 'mcp.json', 'dist/server.mjs', 'ui/app.html', 'scripts/one-click.mjs', 'skills/mobile/SKILL.md', 'skills/setup/SKILL.md', 'update.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('插件安装目录不能经过符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}

export function validateBundle(bundle) {
  if (bundle?.schema !== 1 || bundle.name !== 'codex-mobile' || !/^\d+\.\d+\.\d+$/.test(bundle.version || '') || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 301) throw new Error('软件内置插件包的身份或清单无效，请重新完整解压软件包。');
  const files = new Map(), seen = new Set(); let total = 0;
  for (const file of bundle.files) {
    const name = file.path, parts = typeof name === 'string' ? name.split('/') : [];
    if (!parts.length || name.length > 220 || /[\\\u0000-\u001f<>:"|?*]/.test(name)
      || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      || !(parts.length === 1 ? rootFiles.has(name) : directories.has(parts[0]) || name === '.codex-plugin/plugin.json')
      || parts.some(part => ['.runtime', '.git', '.env', '.codex', 'node_modules', 'config.json', 'owner-url.txt', 'auth.json', 'devices.json', 'credentials.json'].includes(part))
      || /\.(?:log|sqlite|db|key|pem|pfx)$/i.test(name) || seen.has(name.toLowerCase())) throw new Error('软件内置插件包包含不安全或重复的文件路径。');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256 || '') || typeof file.data !== 'string' || file.data.length > 12 * 1024 * 1024) throw new Error('软件内置插件包的文件记录无效。');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length !== file.bytes || bytes.toString('base64') !== file.data || digest(bytes) !== file.sha256) throw new Error('软件内置插件包校验失败，请重新下载并完整解压。');
    total += bytes.length; if (total > 24 * 1024 * 1024) throw new Error('软件内置插件包超出大小限制。');
    seen.add(name.toLowerCase()); files.set(name, bytes);
  }
  if (required.some(name => !files.has(name))) throw new Error('软件内置插件包缺少必要文件。');
  for (const [name, identity] of [['plugin.json', 'codex-mobile'], ['package.json', 'codex-mobile-plugin'], ['.codex-plugin/plugin.json', 'codex-mobile']]) {
    const value = JSON.parse(files.get(name).toString('utf8'));
    if (value.name !== identity || value.version !== bundle.version) throw new Error('软件内置插件版本不一致。');
  }
  const manifest = JSON.parse(files.get('update.json').toString('utf8'));
  if (manifest.schema !== 1 || manifest.name !== bundle.name || manifest.version !== bundle.version || !Array.isArray(manifest.files) || manifest.files.length !== files.size - 1) throw new Error('软件内置插件更新清单不一致。');
  const manifestSeen = new Set();
  for (const entry of manifest.files) {
    const bytes = files.get(entry.path);
    if (entry.path === 'update.json' || manifestSeen.has(entry.path) || !bytes || bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error('软件内置插件更新清单校验失败。');
    manifestSeen.add(entry.path);
  }
  return files;
}

export async function extractBundle({ root = editionRoot, bundlePath = path.join(root, 'lib/plugin-bundle.json') } = {}) {
  await noLinks(root); await noLinks(bundlePath);
  if ((await lstat(bundlePath)).size > 40 * 1024 * 1024) throw new Error('软件内置插件包过大。');
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8')), files = validateBundle(bundle);
  const destination = path.join(path.resolve(root), '.runtime/plugin-installer');
  await noLinks(destination); await mkdir(destination, { recursive: true, mode: 0o700 });
  const source = await mkdtemp(path.join(destination, `${bundle.version}-`));
  for (const [relative, bytes] of files) {
    const target = path.resolve(source, relative), inside = path.relative(source, target);
    if (!inside || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('插件解包路径无效。');
    await noLinks(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: relative.endsWith('.command') ? 0o755 : 0o600 });
    if (process.platform !== 'win32' && relative.endsWith('.command')) await chmod(target, 0o755);
  }
  return { source, version: bundle.version, files: files.size };
}

export async function installBundledPlugin(options = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请使用软件完整包自带的 Node.js 24 或更新版本。');
  const root = options.root || editionRoot, extracted = await extractBundle({ root });
  const { installOneClick, installErrorMessage, resolveDataDirectory } = await import(pathToFileURL(path.join(extracted.source, 'scripts/one-click.mjs')).href);
  const dataDir = await resolveDataDirectory({ dataDir: options.dataDir });
  try { return await installOneClick({ installationRoot: root, source: extracted.source, defaultCwd: options.defaultCwd, dataDir, documentsDir: options.documentsDir }); }
  catch (error) { const safe = new Error(installErrorMessage(error)); safe.dataDir = dataDir; throw safe; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resultFile = path.join(editionRoot, '.runtime/plugin-install-result.txt');
  async function record(message, dataDir) {
    for (const filename of [resultFile, ...(dataDir ? [path.join(dataDir, 'install-result.txt')] : [])]) {
      try { await noLinks(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, `${new Date().toISOString()}\n${message}\n`, { mode: 0o600 }); } catch { }
    }
  }
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index++) {
      const flag = process.argv[index], key = { '--data-dir': 'dataDir', '--default-cwd': 'defaultCwd', '--documents-dir': 'documentsDir' }[flag];
      if (!key || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('安装参数无效。支持 --data-dir PATH 和 --default-cwd PATH。');
      options[key] = path.resolve(process.argv[++index]);
    }
    const result = await installBundledPlugin(options);
    const message = '插件已安装并绑定当前软件。无需提前打开 Codex；使用时打开 Codex，在插件详情点击“打开”。首次打开面板才启动后台，手机连接前请确保 Codex 已登录。';
    console.log(message); await record(message + '\n' + JSON.stringify(result, null, 2), result.dataDir);
  } catch (error) { const message = String(error.message || '插件安装未完成，请重新完整解压软件包后重试。'); console.error(message); await record(message, error.dataDir); process.exitCode = 1; }
  console.log(`安装结果：${resultFile}`);
}
