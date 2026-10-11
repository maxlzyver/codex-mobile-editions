import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { APP_INFO } from './app-info.mjs';

const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 128;

function publicError(error) {
  return String(error?.message || error || 'Unknown bridge error')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/((?:token|secret|password|api_key|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi, '$1[redacted]')
    .slice(0, 1000);
}

export class CodexRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${publicError(error)}`);
    this.name = 'CodexRpcError';
    this.code = error?.code;
  }
}

/**
 * A local JSONL RPC bridge. Shared mode only attaches to an already running
 * managed daemon; it never starts, stops, or reconfigures that daemon.
 * Standalone mode shares Codex's persisted history/account, not the desktop's
 * in-memory turns or desktop-only tool integrations.
 */
export class CodexBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      codexPath: options.codexPath || options.binary || process.env.CODEX_BINARY || 'codex',
      cwd: options.cwd || process.cwd(),
      env: options.env,
      preferProxy: options.preferProxy ?? options.preferShared ?? true,
      proxySocket: options.proxySocket,
      requestTimeoutMs: options.requestTimeoutMs ?? 45000,
      startTimeoutMs: options.startTimeoutMs ?? 20000,
      // These are programmatic host options, never populated from a phone request.
      standaloneArgs: options.standaloneArgs ?? [],
    };
    this.state = { connected: false, mode: null, error: null };
    this.serverInfo = null;
    this.diagnostics = { stderrBytes: 0, lastStderrAt: null };
    this._child = null;
    this._pending = new Map();
    this._incoming = new Set();
    this._sequence = 0;
    this._starting = null;
    this._closed = false;
    this._epoch = 0;
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', { ...this.state });
  }

  async start() {
    if (this.state.connected) return this.state;
    if (this._starting) return this._starting;
    if (this._closed) throw new Error('Codex bridge is closed');
    const epoch = ++this._epoch;
    this._starting = this._start(epoch).finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start(epoch) {
    const modes = this.options.preferProxy ? ['shared', 'standalone'] : ['standalone'];
    let proxyUnavailable = false;
    for (const mode of modes) {
      if (this._closed || this._epoch !== epoch) throw new Error('Codex bridge is closed');
      this._setState({ connected: false, mode, error: null });
      try {
        this._spawnTransport(mode);
        const result = await this._request('initialize', {
          clientInfo: { name: 'codex_mobile_bridge', title: APP_INFO.name, version: APP_INFO.version },
          capabilities: { experimentalApi: true },
        }, mode === 'shared' ? Math.min(this.options.startTimeoutMs, 5000) : this.options.startTimeoutMs);
        if (this._closed || this._epoch !== epoch) throw new Error('Codex bridge is closed');
        this._write({ method: 'initialized', params: {} });
        this.serverInfo = result;
        this._setState({
          connected: true,
          mode,
          error: null,
          notice: mode === 'standalone'
            ? (proxyUnavailable ? 'Shared desktop daemon unavailable. ' : '')
              + 'Independent local Codex process: desktop history is readable; active desktop turns and desktop-only tools are not shared.'
            : null,
        });
        return this.state;
      } catch (error) {
        await this._stopTransport();
        if (this._closed || this._epoch !== epoch) throw new Error('Codex bridge is closed');
        if (mode === 'shared') {
          proxyUnavailable = true;
          continue;
        }
        this._setState({ connected: false, mode, error: publicError(error) });
        throw error;
      }
    }
  }

  _spawnTransport(mode) {
    const args = mode === 'shared'
      ? ['app-server', 'proxy', ...(this.options.proxySocket ? ['--sock', this.options.proxySocket] : [])]
      : ['app-server', '--stdio', ...this.options.standaloneArgs];
    const child = spawn(this.options.codexPath, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env || {}) },
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._child = child;
    let parts = [];
    let bytes = 0;
    let failed = false;
    const fail = (error) => {
      if (failed || this._child !== child) return;
      failed = true;
      this._rejectPending(error);
      this._incoming.clear();
      this._setState({ connected: false, error: publicError(error) });
      child.kill();
    };
    child.stdout.on('data', (chunk) => {
      if (failed || this._child !== child) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(offset, end);
        bytes += piece.length;
        if (bytes > MAX_LINE_BYTES) {
          fail(new Error('Codex sent a response exceeding the 32 MiB safety limit'));
          return;
        }
        if (piece.length) parts.push(piece);
        if (newline < 0) return;
        const line = Buffer.concat(parts, bytes).toString('utf8').trim();
        parts = [];
        bytes = 0;
        offset = end + 1;
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { fail(new Error('Codex emitted an invalid JSON RPC response')); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          fail(new Error('Codex emitted an invalid RPC message')); return;
        }
        this._handleMessage(message);
      }
    });
    child.stderr.on('data', (chunk) => {
      // Do not retain/log stderr text: plugins may print credentials or URLs.
      this.diagnostics.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.diagnostics.stderrBytes + chunk.length);
      this.diagnostics.lastStderrAt = Date.now();
    });
    child.on('error', (error) => fail(new Error(`Could not launch Codex (${error.code || 'process error'})`)));
    child.stdin.on('error', (error) => fail(new Error(`Codex input closed (${error.code || 'pipe error'})`)));
    child.on('close', (code, signal) => {
      if (this._child !== child) return;
      const error = new Error(`Codex connection closed (${signal || code || 'normal exit'})`);
      this._child = null;
      this._rejectPending(error);
      this._incoming.clear();
      this._setState({ connected: false, error: this._closed ? null : publicError(error) });
    });
  }

  _handleMessage(message) {
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if (this._incoming.size >= MAX_PENDING) {
          this._write({ id: message.id, error: { code: -32000, message: 'Too many pending requests' } });
          return;
        }
        this._incoming.add(message.id);
        this.emit('request', { id: message.id, method: message.method, params: message.params ?? {} });
      } else {
        if (message.method === 'serverRequest/resolved') this._incoming.delete(message.params?.requestId);
        this.emit('notification', { method: message.method, params: message.params ?? {} });
      }
      return;
    }
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new CodexRpcError(pending.method, message.error));
    else pending.resolve(message.result);
  }

  _write(message) {
    const child = this._child;
    if (!child || child.exitCode !== null || child.stdin.destroyed) throw new Error('Codex is not connected');
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > MAX_WRITE_BYTES) throw new Error('Codex request exceeds 8 MiB');
    if (child.stdin.writableLength > MAX_WRITE_BYTES) throw new Error('Codex input queue is full');
    child.stdin.write(line);
  }

  _request(method, params, timeoutMs) {
    if (this._pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending Codex requests'));
    if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('RPC method is required'));
    const id = `mobile-${++this._sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const error = new Error(`Codex request timed out: ${method}. The request may still have been accepted; refresh status before retrying.`);
        error.code = 'RPC_TIMEOUT';
        reject(error);
      }, timeoutMs ?? this.options.requestTimeoutMs);
      timer.unref?.();
      this._pending.set(id, { resolve, reject, timer, method });
      try { this._write({ id, method, params: params ?? {} }); }
      catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params = {}, timeoutMs) {
    if (!this.state.connected) await this.start();
    return this._request(method, params, timeoutMs);
  }

  reply(id, result) {
    if (!this._incoming.has(id)) throw new Error('Codex request is no longer pending');
    this._write({ id, result });
    this._incoming.delete(id);
  }

  replyError(id, message = 'This client does not support this request', code = -32601) {
    if (!this._incoming.has(id)) return false;
    this._write({ id, error: { code, message } });
    this._incoming.delete(id);
    return true;
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  async _stopTransport() {
    const child = this._child;
    this._child = null;
    this._rejectPending(new Error('Codex connection stopped'));
    this._incoming.clear();
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
      timer.unref?.();
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }

  async close() {
    this._closed = true;
    ++this._epoch;
    await this._stopTransport();
    this._setState({ connected: false, error: null });
  }
}

export default CodexBridge;
