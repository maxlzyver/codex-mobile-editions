import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AccessError } from './security.mjs';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_STORED_BYTES = 512 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
const IMAGE = new Map(Object.entries({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp' }));
const MIME = new Map([...IMAGE, ['.pdf', 'application/pdf'], ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.zip', 'application/zip'], ['.csv', 'text/csv'], ['.json', 'application/json']]);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const nameOf = value => path.win32.basename(path.posix.basename(String(value)));
export function isLocalAttachmentPath(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (platform === 'win32') {
    return /^[a-z]:[\\/]/i.test(value) && !/[<>:"|?*]/.test(value.slice(2))
      && !value.split(/[\\/]/).slice(1).some(part => part === '.' || part === '..' || /[. ]$/.test(part));
  }
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !value.split('/').some(part => part === '..' || part === '.');
}
function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f\\/:<>"|?*]/.test(value) || /[. ]$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new AccessError(400, '附件文件名无效。');
  return value;
}
export function isTrustedMacSystemLink(filename, target, platform = process.platform) {
  return platform === 'darwin' && ['/var', '/tmp'].includes(filename)
    && path.posix.resolve(path.posix.dirname(filename), target) === `/private${filename}`;
}
async function noLinks(filename) {
  const target = path.resolve(filename), root = path.parse(target).root;
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        const target = await readlink(current);
        if (!isTrustedMacSystemLink(current, target)) throw new AccessError(403, '附件不能经过链接目录。');
        // macOS ships these two aliases. Check their exact destination too,
        // before continuing through the alias; arbitrary nested links stay denied.
        await noLinks(path.resolve(path.dirname(current), target));
      }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Only the desktop's complete attachment envelope is removed. Ordinary Markdown
// headings, quoted examples, and the user's actual instruction remain intact.
export function parseAttachmentMessage(message) {
  let text = typeof message.text === 'string' ? message.text : '';
  const reply = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (reply) {
    try {
      const values = JSON.parse(reply[1]);
      if (Array.isArray(values) && values.length && values.every(value => typeof value.answer === 'string')) {
        text = values.map(value => value.answer).join('\n\n');
      }
    } catch { /* An ordinary quoted or malformed example remains readable text. */ }
  }
  const references = [];
  const wrapper = /^\s*# Files mentioned by the user:\s*\r?\n([\s\S]*?)\r?\n## My request:\s*\r?\n([\s\S]*)$/.exec(text);
  if (wrapper) {
    const pattern = /^## ([^\r\n]+):\s*\r?\n([^\r\n]+)(?:\r?\nImage attachment: (true|false))?/gm;
    for (const match of wrapper[1].matchAll(pattern)) {
      const reference = match[2].trim();
      if ((path.isAbsolute(reference) || path.win32.isAbsolute(reference)) && references.length < 16) references.push({ name: nameOf(match[1]), path: reference });
    }
    if (references.length) text = wrapper[2];
  }
  for (const block of Array.isArray(message.content) ? message.content : []) {
    const reference = block?.path || block?.filePath || block?.localPath || (block?.type === 'localImage' ? block.url : null);
    if (typeof reference === 'string' && (path.isAbsolute(reference) || path.win32.isAbsolute(reference)) && references.length < 16) references.push({ name: nameOf(block.name || reference), path: reference });
  }
  if (wrapper && references.length) {
    text = text.replace(/<image\b[^>]*\bpath="([^"]+)"[^>]*>[\s\S]*?<\/image>/gi, (whole, reference) => references.some(item => key(item.path) === key(reference)) ? '' : whole).trim();
  }
  return { text, references: [...new Map(references.map(item => [key(item.path), item])).values()] };
}

export class Attachments {
  constructor({ runtimeDir, projects, tempDir = os.tmpdir() }) {
    this.directory = path.join(path.resolve(runtimeDir), 'attachments');
    this.indexPath = path.join(this.directory, 'index.json');
    this.projects = projects; this.tempDir = tempDir;
    this.records = new Map(); this.references = new Map(); this.uploads = 0;
    mkdirSync(this.directory, { recursive: true });
    try {
      const saved = readFileSync(this.indexPath);
      if (saved.length > 8 * 1024 * 1024) throw new Error('oversize');
      for (const record of JSON.parse(saved).records || []) {
        if (ID.test(record.id) && typeof record.file === 'string' && /^[a-f0-9]{32}(?:\.[a-z0-9]{1,12})?$/.test(record.file) && record.file.startsWith(record.id) && Number.isSafeInteger(record.size) && record.size >= 0 && record.size <= MAX_UPLOAD_BYTES && typeof record.ownerId === 'string') {
          validName(record.name);
          record.threadIds = Array.isArray(record.threadIds) ? record.threadIds.filter(value => typeof value === 'string').slice(0, 100) : [];
          this.records.set(record.id, record);
        }
      }
    } catch { /* Missing or invalid index never grants access to loose files. */ }
  }
  save() {
    const temporary = `${this.indexPath}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, records: [...this.records.values()] }), { mode: 0o600 });
    renameSync(temporary, this.indexPath);
  }
  descriptor(record) {
    const extension = path.extname(record.name).toLowerCase();
    const mime = MIME.get(extension) || 'application/octet-stream';
    return { id: record.id, name: record.name, size: record.size ?? null, mime, kind: IMAGE.has(extension) ? 'image' : 'file',
      downloadUrl: `/api/attachments/${record.id}/download`, ...(IMAGE.has(extension) ? { previewUrl: `/api/attachments/${record.id}/content` } : {}) };
  }
  async upload(request, encodedName, session, assertAuthorized = () => {}) {
    let name;
    try { name = validName(decodeURIComponent(encodedName || '')); } catch (error) { throw new AccessError(400, error instanceof AccessError ? error.message : '附件文件名编码无效。'); }
    if (this.uploads >= 3) throw new AccessError(429, '同时上传的文件过多，请稍后重试。');
    const declared = Number(request.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw new AccessError(413, '单个附件不能超过 25 MiB。');
    if (this.records.size >= 2000 || [...this.records.values()].reduce((sum, record) => sum + record.size, 0) + (this.uploads + 1) * MAX_UPLOAD_BYTES > MAX_STORED_BYTES) throw new AccessError(413, '附件存储已满，请在电脑端整理后再上传。');
    this.uploads++;
    const id = randomBytes(16).toString('hex'), extension = path.extname(name).toLowerCase();
    const file = id + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '');
    const temporary = path.join(this.directory, `${id}.upload`), destination = path.join(this.directory, file);
    let handle, size = 0, saved = false;
    try {
      await noLinks(this.directory); await mkdir(this.directory, { recursive: true });
      handle = await open(temporary, 'wx', 0o600);
      for await (const chunk of request) {
        assertAuthorized(); size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw new AccessError(413, '单个附件不能超过 25 MiB。');
        await handle.writeFile(chunk);
      }
      await handle.close(); handle = null;
      assertAuthorized();
      if (Number.isFinite(declared) && declared !== size) throw new AccessError(400, '文件上传不完整，请重试。');
      await rename(temporary, destination);
      const record = { id, file, name, size, ownerId: session.id, threadIds: [], createdAt: Date.now() };
      this.records.set(id, record);
      try { this.save(); } catch (error) { this.records.delete(id); throw error; }
      saved = true;
      return this.descriptor(record);
    } finally {
      this.uploads--; await handle?.close();
      if (!saved) { await rm(temporary, { force: true }); await rm(destination, { force: true }); }
    }
  }
  selected(ids, session) {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !ID.test(id))) throw new AccessError(400, '每条消息最多添加 8 个有效附件。');
    return ids.map(id => {
      const record = this.records.get(id);
      if (!record || (session.role !== 'owner' && record.ownerId !== session.id)) throw new AccessError(403, '此附件不属于当前设备。');
      return record;
    });
  }
  async prepare(prompt, ids, session) {
    const selected = this.selected(ids, session);
    if (!selected.length) return { prompt, localImages: [], selected };
    if (typeof prompt !== 'string') throw new AccessError(400, '消息正文必须是文字。');
    await noLinks(this.directory);
    for (const item of selected) {
      await noLinks(path.join(this.directory, item.file));
      if (!(await stat(path.join(this.directory, item.file))).isFile()) throw new AccessError(404, '附件已不存在，请重新上传。');
    }
    const entries = selected.map(item => `## ${item.name}:\n${path.join(this.directory, item.file).replaceAll('\\', '/')}\nImage attachment: ${IMAGE.has(path.extname(item.name).toLowerCase())}`);
    return { prompt: `# Files mentioned by the user:\n\n${entries.join('\n\n')}\n\n## My request:\n${prompt.trim() || '请查看我上传的附件。'}`,
      localImages: selected.filter(item => IMAGE.has(path.extname(item.name).toLowerCase())).map(item => path.join(this.directory, item.file)), selected };
  }
  bind(selected, threadId) {
    if (typeof threadId !== 'string') return;
    for (const record of selected) if (!record.threadIds.includes(threadId)) record.threadIds.push(threadId);
    if (selected.length) { try { this.save(); } catch { this.warning = '消息已发送，但附件关联暂未保存，请勿重复发送。'; } }
  }
  async delete(id, session) {
    const [record] = this.selected([id], session);
    if (record.threadIds.length) throw new AccessError(409, '已发送的附件需要保留供聊天下载。');
    await noLinks(this.directory);
    this.records.delete(id); this.save();
    await rm(path.join(this.directory, record.file), { force: true });
    return { ok: true };
  }
  normalize(view) {
    if (!view?.thread?.messages) return view;
    const threadId = view.thread.id;
    const messages = view.thread.messages.map(message => {
      const { content, generatedImage, ...safe } = message;
      const savedPath = generatedImage?.savedPath;
      const generated = message.role === 'assistant' && isLocalAttachmentPath(savedPath) && IMAGE.has(path.extname(savedPath).toLowerCase());
      if (message.role !== 'user' && !generated) return safe;
      // Only the adapter's explicit saved local image is an output attachment.
      // Never forward image results/base64, signed URLs or arbitrary raw blocks.
      const { text, references } = generated
        ? { text: message.text, references: [{ name: nameOf(savedPath), path: savedPath }] }
        : parseAttachmentMessage(message);
      const attachments = references.map(reference => {
        const uploaded = [...this.records.values()].find(record => key(path.join(this.directory, record.file)) === key(reference.path));
        if (uploaded && uploaded.threadIds.length) return this.descriptor(uploaded);
        const id = createHash('sha256').update(`${threadId}\n${reference.path}`).digest('hex').slice(0, 32);
        const record = { id, name: reference.name, path: reference.path, threadId };
        this.references.delete(id); this.references.set(id, record);
        while (this.references.size > 5000) this.references.delete(this.references.keys().next().value);
        return this.descriptor(record);
      });
      return { ...safe, text, ...(attachments.length ? { attachments } : {}) };
    });
    return { ...view, thread: { ...view.thread, messages } };
  }
  async resolve(id, session, scope = {}) {
    if (!ID.test(id)) throw new AccessError(404, '附件不存在。');
    const uploaded = this.records.get(id);
    if (uploaded) {
      if (session.role !== 'owner' && uploaded.ownerId !== session.id && !uploaded.threadIds.length) throw new AccessError(403, '此附件尚未发送。');
      const absolutePath = path.join(this.directory, uploaded.file);
      await noLinks(absolutePath);
      const info = await stat(absolutePath).catch(() => { throw new AccessError(404, '附件文件已不存在。'); });
      if (!info.isFile()) throw new AccessError(404, '附件文件已不存在。');
      return { ...this.descriptor(uploaded), absolutePath, size: info.size };
    }
    const reference = this.references.get(id);
    if (!reference) throw new AccessError(404, '请重新打开所属聊天后再下载附件。');
    if (!isLocalAttachmentPath(reference.path)) throw new AccessError(404, '此附件不属于当前电脑的本地文件。');
    // Desktop clipboard images live outside projects. Admit only the desktop's
    // generated image names in this user's actual temporary directory, not an
    // arbitrary path mentioned in a prompt, credential folder, or symlink.
    try {
      await noLinks(reference.path);
      const filename = await realpath(reference.path);
      const temporary = await realpath(this.tempDir);
      if (key(path.dirname(filename)) === key(temporary) && /^codex-clipboard-[a-f0-9-]{36}\.(png|jpe?g|gif|webp)$/i.test(path.basename(filename))) {
        const info = await stat(filename);
        if (info.isFile()) return { ...this.descriptor(reference), absolutePath: filename, size: info.size };
      }
    } catch (error) { if (error instanceof AccessError) throw error; }
    for (const project of await this.projects.list(scope)) {
      try {
        const resolved = await this.projects.resolveReference(project.id, reference.path, scope);
        return { ...this.descriptor(reference), ...await this.projects.resolveFile(project.id, resolved.path, scope) };
      } catch { /* Try the next already authorized project, never add a root. */ }
    }
    throw new AccessError(404, '原附件已不存在，或不在当前授权的项目内。请在电脑端重新添加。');
  }
}
