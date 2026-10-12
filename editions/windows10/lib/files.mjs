import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessError } from './security.mjs';

const PREVIEW_BYTES = 1024 * 1024;
const MIME_TYPES = new Map(Object.entries({
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.log': 'text/plain',
  '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.xml': 'application/xml',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain', '.ini': 'text/plain',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.jsx': 'text/plain', '.ts': 'text/plain', '.tsx': 'text/plain', '.css': 'text/css',
  '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml',
  '.py': 'text/plain', '.r': 'text/plain', '.sql': 'text/plain', '.sh': 'text/plain',
  '.ps1': 'text/plain', '.bat': 'text/plain', '.cmd': 'text/plain', '.c': 'text/plain',
  '.h': 'text/plain', '.cpp': 'text/plain', '.hpp': 'text/plain', '.cs': 'text/plain',
  '.java': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain', '.tex': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
}));

function canonicalKey(filename) {
  let value = filename;
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`;
    else if (value.startsWith('\\\\?\\')) value = value.slice(4);
  }
  value = path.resolve(value);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function contained(parent, child) {
  const relative = path.relative(canonicalKey(parent), canonicalKey(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function stableId(root) {
  return createHash('sha256').update(canonicalKey(root)).digest('hex').slice(0, 24);
}

function relativePath(input, { allowEmpty = true } = {}) {
  if (typeof input !== 'string' || input.length > 4096
    || /[\u0000-\u001f<>:"|?*]/.test(input)
    || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)
    || /^[\\/]/.test(input)) {
    throw new AccessError(400, '请使用项目内的相对路径。');
  }
  const segments = input.replaceAll('\\', '/').split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.some(segment => segment === '..' || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))) {
    throw new AccessError(400, '路径包含不允许的目录跳转或 Windows 文件名。');
  }
  if (!allowEmpty && segments.length === 0) throw new AccessError(400, '请选择项目内的文件。');
  return segments.join('/');
}

function absoluteDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 4096 || /[\u0000-\u001f]/.test(input)) throw new AccessError(400, '请填写电脑上已有目录的绝对路径。');
  if (process.platform === 'win32') {
    // Do not let a phone cause UNC/network authentication or use device/ADS aliases.
    if (!/^[a-z]:[\\/]/i.test(input)) throw new AccessError(400, '请选择本机磁盘上的目录，不支持网络或设备路径。');
    relativePath(input.slice(3));
  } else relativePath(input.slice(1));
  return path.resolve(input);
}

function filesystemError(error) {
  if (error instanceof AccessError) return error;
  if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return new AccessError(404, '该目录或文件已不存在。');
  if (['EACCES', 'EPERM'].includes(error?.code)) return new AccessError(403, '当前电脑账户没有读取此目录或文件的权限。');
  return new AccessError(500, '读取本机文件失败，请在电脑端检查该文件。');
}

function isTextMime(mime) {
  return mime.startsWith('text/') || ['application/json', 'application/x-ndjson', 'application/xml', 'image/svg+xml'].includes(mime);
}

/** Read-only file access scoped to projects discovered from local Codex tasks. */
export class Projects {
  constructor({ tasks, defaultCwd, runtimeDir, protectedPaths = [] }) {
    this.tasks = tasks;
    this.defaultCwd = path.resolve(defaultCwd || process.cwd());
    this.runtimeDir = runtimeDir ? path.resolve(runtimeDir) : null;
    this.configFile = this.runtimeDir ? path.join(this.runtimeDir, 'project-roots.json') : null;
    this.mobileConfigFile = this.runtimeDir ? path.join(this.runtimeDir, 'mobile-project-roots.json') : null;
    this.protectedPaths = [
      this.runtimeDir,
      process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'),
      path.join(os.homedir(), '.codex'),
      ...(process.platform === 'win32' ? [path.join(os.homedir(), 'AppData')] : [path.join(os.homedir(), 'Library')]),
      ...protectedPaths,
    ].filter(Boolean).map(value => path.resolve(value));
    this.extraRoots = [];
    this.mobileRoots = [];
    this.loadPromise = this.load();
    this.addQueue = Promise.resolve();
  }

  async load() {
    if (!this.configFile) return;
    for (const [file, field] of [[this.configFile, 'extraRoots'], [this.mobileConfigFile, 'mobileRoots']]) {
      try {
        const stored = JSON.parse(await readFile(file, 'utf8'));
        if (Array.isArray(stored)) this[field] = stored.filter(value => typeof value === 'string' && path.isAbsolute(value));
      } catch { /* A missing config is normal; personal Codex settings are untouched. */ }
    }
  }

  async boundaries() {
    // Keep lexical and real locations: either can lead into protected state.
    const roots = [];
    for (const value of this.protectedPaths) {
      roots.push(value);
      try { roots.push(await realpath(value)); } catch {}
    }
    return roots;
  }

  assertUnprotected(filename, boundaries) {
    const parts = path.resolve(filename).split(/[\\/]/).map(part => part.toLowerCase());
    const privateName = parts.some(part => ['.runtime', '.codex', '.ssh', '.aws', '.azure', '.gnupg', '.kube'].includes(part));
    const credentialFile = ['.npmrc', '.netrc', '.git-credentials'].includes(parts.at(-1));
    if (privateName || credentialFile || boundaries.some(root => contained(root, filename))) {
      throw new AccessError(403, '该路径包含账户凭证或控制台私有数据，不能从手机访问。');
    }
  }

  /** Returns every distinct task cwd plus the default cwd and owner-added roots. */
  async list({ includeMobileRoots = true } = {}) {
    await this.loadPromise;
    const threads = typeof this.tasks?.listAll === 'function'
      ? await this.tasks.listAll()
      : typeof this.tasks?.list === 'function' ? await this.tasks.list({ all: true }) : [];
    const inputs = new Map();
    for (const entry of [
      { cwd: this.defaultCwd, count: 0 },
      ...this.extraRoots.map(cwd => ({ cwd, count: 0 })),
      ...(includeMobileRoots ? this.mobileRoots : []).map(cwd => ({ cwd, count: 0 })),
      ...(Array.isArray(threads) ? threads : []).map(thread => ({ cwd: thread.cwd, count: 1 })),
    ]) {
      if (typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)) continue;
      const normalized = path.resolve(entry.cwd);
      const key = canonicalKey(normalized);
      const current = inputs.get(key);
      if (current) current.count += entry.count;
      else inputs.set(key, { cwd: normalized, count: entry.count });
    }
    const boundaries = await this.boundaries();
    const projects = new Map();
    for (const entry of inputs.values()) {
      let root = entry.cwd;
      let exists = false;
      try {
        this.assertUnprotected(root, boundaries);
        root = await realpath(root);
        this.assertUnprotected(root, boundaries);
        exists = (await stat(root)).isDirectory();
      } catch (error) {
        if (error instanceof AccessError) continue;
      }
      const id = stableId(root);
      const project = projects.get(id);
      if (project) project.threadCount += entry.count;
      else projects.set(id, {
        id, name: path.basename(root) || root, path: root, exists, threadCount: entry.count,
      });
    }
    return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.path.localeCompare(b.path));
  }

  async resolveProject(id, scope = {}) {
    if (typeof id !== 'string' || !/^[a-f\d]{24}$/.test(id)) throw new AccessError(404, '项目不存在，请刷新项目列表。');
    const project = (await this.list(scope)).find(entry => entry.id === id);
    if (!project) throw new AccessError(404, '项目不存在，请刷新项目列表。');
    if (!project.exists) throw new AccessError(404, '项目目录已不存在或当前无法读取。');
    try {
      const root = await realpath(project.path);
      if (stableId(root) !== id) throw new AccessError(409, '项目目录已变化，请刷新项目列表。');
      this.assertUnprotected(root, await this.boundaries());
      return { ...project, path: root };
    } catch (error) { throw filesystemError(error); }
  }

  async resolve(id, input, { allowEmpty = true, ...scope } = {}) {
    const relative = relativePath(input, { allowEmpty });
    const project = await this.resolveProject(id, scope);
    const boundaries = await this.boundaries();
    const requested = path.resolve(project.path, relative);
    if (!contained(project.path, requested)) throw new AccessError(403, '不能读取项目目录之外的文件。');
    this.assertUnprotected(requested, boundaries);
    try {
      const absolutePath = await realpath(requested);
      if (!contained(project.path, absolutePath)) throw new AccessError(403, '符号链接指向项目目录之外，已拒绝访问。');
      this.assertUnprotected(absolutePath, boundaries);
      const info = await stat(absolutePath);
      return { project, relative, absolutePath, info, boundaries };
    } catch (error) { throw filesystemError(error); }
  }

  async browse(id, input = '', scope = {}) {
    const resolved = await this.resolve(id, input, scope);
    if (!resolved.info.isDirectory()) throw new AccessError(400, '请选择一个目录。');
    let names;
    try { names = await readdir(resolved.absolutePath); } catch (error) { throw filesystemError(error); }
    const entries = [];
    // Limit concurrent filesystem requests, without recursively walking projects.
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = await Promise.all(names.slice(offset, offset + 32).map(async name => {
        const entryPath = [resolved.relative, name].filter(Boolean).join('/');
        try {
          // Windows normalization aliases must never bypass protected paths.
          relativePath(entryPath);
          const requested = path.join(resolved.absolutePath, name);
          this.assertUnprotected(requested, resolved.boundaries);
          const absolute = await realpath(requested);
          if (!contained(resolved.project.path, absolute)) return null;
          this.assertUnprotected(absolute, resolved.boundaries);
          const info = await stat(absolute);
          if (!info.isDirectory() && !info.isFile()) return null;
          return {
            name, path: entryPath, type: info.isDirectory() ? 'directory' : 'file',
            size: info.isFile() ? info.size : null, modifiedAt: info.mtimeMs,
          };
        } catch {
          // Private, broken, escaped and unreadable entries are not disclosed.
          return null;
        }
      }));
      entries.push(...batch.filter(Boolean));
    }
    entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const parts = resolved.relative ? resolved.relative.split('/') : [];
    return {
      project: resolved.project,
      path: resolved.relative,
      breadcrumbs: [{ name: resolved.project.name, path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))],
      entries,
    };
  }

  /** Only a regular file under this known project can become a download. */
  async resolveFile(id, input, scope = {}) {
    const resolved = await this.resolve(id, input, { ...scope, allowEmpty: false });
    if (!resolved.info.isFile()) throw new AccessError(400, '仅支持预览或下载普通文件。');
    return {
      absolutePath: resolved.absolutePath,
      size: resolved.info.size,
      mime: MIME_TYPES.get(path.extname(resolved.relative).toLowerCase()) || 'application/octet-stream',
      name: path.basename(resolved.relative),
      modifiedAt: resolved.info.mtimeMs,
    };
  }

  /** Resolve a chat reference without granting access outside its selected project. */
  async resolveReference(id, reference, scope = {}) {
    if (typeof reference !== 'string' || !reference.trim() || reference.length > 4096 || /[\u0000-\u001f]/.test(reference)) throw new AccessError(400, '文件引用无效。');
    let filename = reference.trim().replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, '');
    try {
      if (/^file:/i.test(filename)) {
        const url = new URL(filename);
        if (url.hostname && url.hostname.toLowerCase() !== 'localhost') throw new Error('remote');
        if (url.search || url.hash || url.username || url.password) throw new Error('url');
        filename = fileURLToPath(url);
      } else {
        const sandbox = /^sandbox:/i.test(filename);
        if (sandbox) filename = filename.slice(8);
        else if (/^[a-z][a-z\d+.-]*:/i.test(filename) && !/^[a-z]:[\\/]/i.test(filename)) throw new Error('scheme');
        if (/%[\da-f]{2}/i.test(filename) && !/%(?![\da-f]{2})/i.test(filename)) filename = decodeURIComponent(filename);
        if (sandbox && process.platform === 'win32' && /^\/[a-z]:[\\/]/i.test(filename)) filename = filename.slice(1);
        if (sandbox && !path.isAbsolute(filename)) throw new Error('sandbox');
      }
    } catch { throw new AccessError(400, '仅支持当前项目内的本机文件引用。'); }
    filename = filename.replace(/:\d+(?::\d+)?$/, '');
    const project = await this.resolveProject(id, scope);
    let relative = filename;
    if (path.isAbsolute(filename)) {
      const absolute = path.resolve(filename);
      if (!contained(project.path, absolute)) throw new AccessError(403, '文件引用不在当前项目内。');
      relative = path.relative(project.path, absolute);
    } else if (path.win32.isAbsolute(filename) || path.posix.isAbsolute(filename)) {
      throw new AccessError(400, '文件引用与当前电脑的平台不匹配。');
    }
    relative = relativePath(relative, { allowEmpty: false });
    const file = await this.resolveFile(id, relative, scope);
    return { projectId: id, path: relative, name: file.name, mime: file.mime, size: file.size };
  }

  /** UTF-8 text only; binary downloads remain available through resolveFile(). */
  async preview(id, input, scope = {}) {
    const filename = await this.resolveFile(id, input, scope);
    if (filename.size > PREVIEW_BYTES) throw new AccessError(413, '文件超过 1 MiB，无法直接预览，请下载后查看。');
    if (filename.mime !== 'application/octet-stream' && !isTextMime(filename.mime)) {
      throw new AccessError(415, '该文件不是 UTF-8 文本，请使用对应预览方式或下载后查看。');
    }
    let handle;
    try {
      handle = await open(filename.absolutePath, 'r');
      const current = await handle.stat();
      if (!current.isFile()) throw new AccessError(400, '仅支持预览普通文件。');
      if (current.size > PREVIEW_BYTES) throw new AccessError(413, '文件超过 1 MiB，无法直接预览，请下载后查看。');
      const confirmed = await this.resolveFile(id, input, scope);
      if (canonicalKey(confirmed.absolutePath) !== canonicalKey(filename.absolutePath)) throw new AccessError(409, '文件路径已变化，请重新打开。');
      const buffer = Buffer.alloc(PREVIEW_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > PREVIEW_BYTES) throw new AccessError(413, '文件超过 1 MiB，无法直接预览，请下载后查看。');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
      catch { throw new AccessError(415, '此文件不是有效的 UTF-8 文本，请下载后查看。'); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
        throw new AccessError(415, '此文件包含二进制内容，请下载后查看。');
      }
      return {
        name: filename.name, path: relativePath(input),
        mime: filename.mime === 'application/octet-stream' ? 'text/plain' : filename.mime,
        size: length, text, truncated: false,
      };
    } catch (error) { throw filesystemError(error); }
    finally { await handle?.close(); }
  }

  /** The host must authorize owner access or the mobile other-files permission. */
  async addRoot(input, { source = 'owner' } = {}) {
    input = absoluteDirectory(input);
    if (!['owner', 'mobile'].includes(source)) throw new AccessError(400, '未知项目授权来源。');
    if (!this.configFile) throw new AccessError(500, '控制台尚未配置项目目录存储。');
    const operation = this.addQueue.then(async () => {
      await this.loadPromise;
      let root;
      try {
        this.assertUnprotected(path.resolve(input), await this.boundaries());
        root = await realpath(input);
        this.assertUnprotected(root, await this.boundaries());
        if (!(await stat(root)).isDirectory()) throw new AccessError(400, '请选择已有的文件夹。');
      } catch (error) { throw filesystemError(error); }
      const field = source === 'mobile' ? 'mobileRoots' : 'extraRoots';
      const file = source === 'mobile' ? this.mobileConfigFile : this.configFile;
      if (!this[field].some(existing => canonicalKey(existing) === canonicalKey(root))) {
        const updated = [...this[field], root];
        const temporary = `${file}.${randomBytes(5).toString('hex')}.tmp`;
        await mkdir(this.runtimeDir, { recursive: true });
        await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, file);
        this[field] = updated;
      }
      return { id: stableId(root), name: path.basename(root) || root, path: root, exists: true, threadCount: 0 };
    });
    this.addQueue = operation.catch(() => {});
    return operation;
  }

  /** Directory picker only: file reads still require a separately admitted project. */
  async browseDirectories(input = null) {
    const boundaries = await this.boundaries();
    const candidates = [{ name: '主目录', path: os.homedir() }, ...(process.platform === 'win32'
      ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(drive => ({ name: `${drive}:`, path: `${drive}:\\` }))
      : [{ name: '系统根目录', path: '/' }, { name: '外置磁盘', path: '/Volumes' }])];
    const locations = (await Promise.all(candidates.map(async location => {
      try { const root = await realpath(location.path); this.assertUnprotected(root, boundaries); return (await stat(root)).isDirectory() ? { ...location, path: root } : null; } catch { return null; }
    }))).filter(Boolean);
    if (input === null || input === '') return { path: null, parent: null, locations, entries: [] };
    const requested = absoluteDirectory(input);
    this.assertUnprotected(requested, boundaries);
    let root, names;
    try {
      root = await realpath(requested); this.assertUnprotected(root, boundaries);
      if (!(await stat(root)).isDirectory()) throw new AccessError(400, '请选择已有的文件夹。');
      names = await readdir(root);
    } catch (error) { throw filesystemError(error); }
    const entries = [];
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = await Promise.all(names.slice(offset, offset + 32).map(async name => {
        try {
          relativePath(name, { allowEmpty: false }); const target = path.join(root, name); this.assertUnprotected(target, boundaries);
          const canonical = await realpath(target); this.assertUnprotected(canonical, boundaries);
          if (!(await stat(canonical)).isDirectory()) return null;
          return { name, path: canonical, type: 'directory' };
        } catch { return null; }
      }));
      entries.push(...batch.filter(Boolean));
    }
    const parentPath = path.dirname(root);
    let parent = parentPath === root ? null : parentPath;
    try { if (parent) this.assertUnprotected(parent, boundaries); } catch { parent = null; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return { path: root, parent, locations, entries };
  }
}

export default Projects;
