import net from 'node:net';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// The bundled Codex app-tools MCP server uses 4-byte LE length-prefixed JSON-RPC.
// This adapter permits only the explicit tool allowlist below. Mutation also
// requires a local constructor opt-in; no raw JSON-RPC is exposed to HTTP callers.
// The adapter never impersonates an account or accesses credential files.
const MAX_FRAME = 8 * 1024 * 1024;
const READ_ONLY_TOOLS = new Set([
  'list_threads', 'list_archived_threads', 'read_thread', 'wait_threads',
  'list_projects', 'read_project', 'get_thread',
]);
const SUPPORTED_TOOLS = new Set([...READ_ONLY_TOOLS, 'create_thread', 'send_message_to_thread']);

export class DesktopBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      pipePath: options.pipePath || process.env.CODEX_APP_TOOLS_PIPE_PATH || null,
      callerThreadId: options.callerThreadId || process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || null,
      hostId: options.hostId || 'local',
      connectTimeoutMs: options.connectTimeoutMs ?? 900,
      requestTimeoutMs: options.requestTimeoutMs ?? 15000,
      discoveryTimeoutMs: options.discoveryTimeoutMs ?? 1500,
      allowWrites: options.allowWrites === true,
    };
    this.state = { connected: false, mode: 'desktop', error: null, toolNames: [] };
    this.pipePath = null;
    this.tools = [];
    this.socket = null;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.connecting = null;
    this.closed = false;
  }

  _state(patch) { this.state = { ...this.state, ...patch }; this.emit('state', { ...this.state }); }

  async candidatePipes() {
    const candidates = this.options.pipePath ? [this.options.pipePath] : [];
    if (process.platform === 'win32') {
      try {
        const names = await readdir('\\\\.\\pipe\\');
        for (const name of names) if (/^codex-browser-use-[0-9a-f-]{36}$/i.test(name)) candidates.push(`\\\\.\\pipe\\${name}`);
      } catch { /* An explicit inherited pipe still works when enumeration is denied. */ }
    }
    return [...new Set(candidates)].slice(0, 32);
  }

  async connect() {
    if (this.closed) throw new Error('桌面连接已关闭。');
    if (this.state.connected && this.socket && !this.socket.destroyed) return this.state;
    if (this.connecting) return this.connecting;
    this.connecting = this._discover().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _discover() {
    const candidates = await this.candidatePipes();
    for (const pipePath of candidates) {
      try {
        await this._open(pipePath);
        const result = await this._request('tools/list', { threadStartKind: 'all' }, this.options.discoveryTimeoutMs);
        if (!Array.isArray(result?.tools) || !result.tools.some(tool => tool.namespace === 'codex_app' && tool.name === 'read_thread')) throw new Error('此管道不提供桌面会话工具。');
        this.tools = result.tools;
        this.pipePath = pipePath;
        this._state({ connected: true, error: null, toolNames: this.tools.map(tool => tool.name) });
        return this.state;
      } catch {
        this._disconnect(new Error('正在尝试其他桌面工具连接。'));
      }
    }
    const error = new Error(candidates.length ? '没有发现可用的 Codex 桌面会话接口。请保持原生 Codex 已登录且窗口开启。' : '没有发现 Codex 桌面工具管道。请先打开原生 Codex。');
    this._state({ connected: false, error: error.message });
    throw error;
  }

  async _open(pipePath) {
    if (process.platform === 'win32' && !/^\\\\\.\\pipe\\codex-browser-use-[0-9a-f-]{36}$/i.test(pipePath)) throw new Error('无效的桌面工具管道。');
    this._disconnect(new Error('桌面工具连接已更换。'));
    const socket = net.createConnection(pipePath);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接桌面工具超时。')); }, this.options.connectTimeoutMs);
      const onError = (error) => { clearTimeout(timer); reject(error); };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        socket.on('data', chunk => this._data(socket, chunk));
        socket.on('error', () => this._disconnect(new Error('桌面工具连接中断。'), socket));
        socket.on('close', () => this._disconnect(new Error('桌面工具连接已关闭。'), socket));
        resolve();
      });
    });
  }

  _data(socket, chunk) {
    if (socket !== this.socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME || length === 0) { this._disconnect(new Error('桌面工具响应超出范围。'), socket); return; }
      if (this.buffer.length < length + 4) return;
      let response;
      try { response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
      catch { this._disconnect(new Error('桌面工具返回了无效数据。'), socket); return; }
      this.buffer = this.buffer.subarray(length + 4);
      const pending = this.pending.get(String(response.id));
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(String(response.id));
      if (response.error) {
        const error = new Error(String(response.error.message || '桌面工具调用失败。').slice(0, 600));
        error.code = response.error.code;
        pending.reject(error);
      } else pending.resolve(response.result);
    }
  }

  _request(method, params, timeoutMs = this.options.requestTimeoutMs) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('桌面工具尚未连接。'));
    if (this.pending.size >= 16) return Promise.reject(new Error('等待中的桌面读取请求过多。'));
    const id = ++this.sequence;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    if (payload.length > MAX_FRAME) return Promise.reject(new Error('桌面工具请求过大。'));
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0); payload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error('桌面工具读取超时。'));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.socket.write(frame, error => {
        if (!error) return;
        const pending = this.pending.get(String(id));
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(String(id)); reject(error);
      });
    });
  }

  async listTools() { await this.connect(); return this.tools.map(tool => ({ ...tool })); }

  async callReadOnly(tool, args = {}, context = {}) {
    if (!READ_ONLY_TOOLS.has(tool)) throw new Error('此桌面适配器仅允许读取会话与项目。');
    return this.call(tool, args, context);
  }

  async call(tool, args = {}, context = {}) {
    if (!SUPPORTED_TOOLS.has(tool)) throw new Error('此工具不在桌面连接的允许列表中。');
    if (!READ_ONLY_TOOLS.has(tool) && !this.options.allowWrites) throw new Error('当前桌面连接仅允许读取；写入必须由本机服务明确启用。');
    await this.connect();
    const definition = this.tools.find(item => item.namespace === 'codex_app' && item.name === tool);
    if (!definition) throw new Error(`当前桌面版本不支持 ${tool}。`);
    const threadId = context.callerThreadId || this.options.callerThreadId;
    if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('读取桌面会话需要真实的调用方聊天编号；请在本机配置，不能由公网请求自行指定。');
    const requestId = randomUUID();
    const result = await this._request('tools/call', {
      arguments: args,
      callerSource: 'codex',
      callId: `codex-mobile-read-${requestId}`,
      hostId: context.hostId || this.options.hostId,
      namespace: 'codex_app',
      threadId,
      tool,
      // This fallback matches the bundled official MCP adapter when a turn id
      // is not supplied; it is a correlation identifier, not a credential.
      turnId: context.turnId || `mcp-turn-${requestId}`,
    }, context.timeoutMs || (tool === 'wait_threads' ? Math.min((args.timeoutMs || 0) + 10000, 130000) : this.options.requestTimeoutMs));
    if (!result || !Array.isArray(result.contentItems)) throw new Error('桌面工具没有返回可识别的内容。');
    return result;
  }

  _disconnect(error, expectedSocket = this.socket) {
    if (expectedSocket !== this.socket) return;
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    socket?.destroy();
    if (this.state.connected) this._state({ connected: false, error: error.message });
  }

  async close() { this.closed = true; this._disconnect(new Error('桌面连接已关闭。')); }
}

export { READ_ONLY_TOOLS, SUPPORTED_TOOLS };
