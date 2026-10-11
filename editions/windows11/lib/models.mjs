import { AccessError } from './security.mjs';

const hasChoice = value => value !== undefined && value !== null && value !== '';

/** The available catalog always comes from this machine's authenticated Codex. */
export class Models {
  constructor(bridge, { cacheMs = 30000 } = {}) {
    this.bridge = bridge;
    this.cacheMs = cacheMs;
    this.cache = null;
    this.updatedAt = 0;
    this.pending = null;
    bridge.on?.('state', state => { if (!state.connected) this.updatedAt = 0; });
  }

  async list({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.updatedAt < this.cacheMs) return structuredClone(this.cache);
    if (this.pending) return structuredClone(await this.pending);
    this.pending = this.fetch().finally(() => { this.pending = null; });
    return structuredClone(await this.pending);
  }

  async fetch() {
    if (!this.bridge.state.connected) await this.bridge.start();
    const models = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const result = await this.bridge.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const entry of result.data || []) {
        if (entry.hidden || typeof entry.id !== 'string' || typeof entry.model !== 'string') continue;
        const supportedReasoningEfforts = (entry.supportedReasoningEfforts || [])
          .filter(e => typeof e.reasoningEffort === 'string' && e.reasoningEffort)
          .map(e => ({ reasoningEffort: e.reasoningEffort, description: typeof e.description === 'string' ? e.description : '' }));
        models.set(entry.id, {
          id: entry.id,
          model: entry.model,
          displayName: entry.displayName || entry.model,
          supportedReasoningEfforts,
          defaultReasoningEffort: typeof entry.defaultReasoningEffort === 'string' ? entry.defaultReasoningEffort : null,
          isDefault: Boolean(entry.isDefault),
        });
      }
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new AccessError(502, 'Codex 模型列表分页异常，请重新连接后重试。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.cache = [...models.values()];
    this.updatedAt = Date.now();
    return this.cache;
  }

  async resolve(options = {}, fallback = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new AccessError(400, '模型设置必须是对象。');
    for (const key of ['model', 'effort']) {
      if (hasChoice(options[key]) && (typeof options[key] !== 'string' || options[key].length > 200 || /[\u0000-\u001f]/.test(options[key]))) {
        throw new AccessError(400, '无效的模型或推理强度。');
      }
    }
    let catalog = await this.list();
    const requested = hasChoice(options.model) ? options.model : fallback.model;
    const find = () => hasChoice(requested)
      ? catalog.find(m => m.id === requested || m.model === requested)
      : catalog.find(m => m.isDefault) || catalog[0];
    let selected = find();
    // Refresh once when a saved/UI selection is absent from the short-lived cache.
    if (!selected && hasChoice(requested)) { catalog = await this.list({ refresh: true }); selected = find(); }
    if (!selected) throw new AccessError(400, hasChoice(requested) ? '所选模型当前不可用，请从电脑返回的模型列表重新选择。' : '当前 Codex 账户没有可用模型，请检查登录状态。');
    const sameModel = !hasChoice(fallback.model) || [selected.id, selected.model].includes(fallback.model);
    const effort = hasChoice(options.effort) ? options.effort
      : sameModel && hasChoice(fallback.effort) ? fallback.effort : selected.defaultReasoningEffort;
    if (hasChoice(effort) && !selected.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) {
      throw new AccessError(400, '此模型不支持所选推理强度，请重新选择。');
    }
    return { model: selected.model, effort: hasChoice(effort) ? effort : null };
  }
}

export default Models;
