import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';

const LIMIT = 1000;
const PER_THREAD = 200;
const MAX_BYTES = 4 * 1024 * 1024;
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 300;

// Remove local-only echoes before reconciling with a fresh upstream transcript.
export function transcriptMessages(messages = []) {
  return messages.flatMap(message => {
    if (!message.submitted) return [{ ...message }];
    if (!message.serverId) return [];
    const { submitted, delivery, serverId, ...original } = message;
    return [{ ...original, id: serverId }];
  });
}

/** Receipts acknowledge successful sends, independently of upstream transcript lag. */
export class SubmittedMessages {
  constructor(directory = null) {
    this.file = directory ? path.join(directory, 'submitted-messages.json') : null;
    this.records = [];
    this.warning = null;
    if (!this.file) return;
    try {
      if (statSync(this.file).size > MAX_BYTES) throw new Error('oversize');
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.records)) throw new Error('format');
      this.records = saved.records.filter(record => identifier(record.id) && identifier(record.threadId)
        && typeof record.text === 'string' && record.text.length <= 30000 && Number.isFinite(record.createdAt)
        && Array.isArray(record.anchors) && record.anchors.length <= 8 && record.anchors.every(identifier)
        && Array.isArray(record.beforeUserIds) && record.beforeUserIds.length <= 400 && record.beforeUserIds.every(identifier)
        && (record.turnId === null || identifier(record.turnId)) && (record.matchedId === null || identifier(record.matchedId)));
      this.trim();
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = '本地发送记录读取失败；当前聊天记录仍可刷新。';
    }
  }

  begin(threadId, prompt, messages, turnId = null) {
    const original = transcriptMessages(messages).slice(-400);
    return {
      id: `mobile-user-${randomUUID()}`, threadId, text: prompt, createdAt: Date.now(),
      turnId: turnId || null, matchedId: null, emptyBefore: original.length === 0,
      anchors: original.slice(-8).map(message => message.id).filter(identifier),
      beforeUserIds: original.filter(message => message.role === 'user' && sameText(message.text, prompt)).map(message => message.id).filter(identifier),
    };
  }

  accept(draft, turnId = null) {
    const record = { ...draft, turnId: turnId || draft.turnId || null };
    this.records.push(record);
    this.save();
    return record;
  }

  trim() {
    const counts = new Map();
    this.records = this.records.slice().reverse().filter(record => {
      const count = (counts.get(record.threadId) || 0) + 1;
      counts.set(record.threadId, count);
      return count <= PER_THREAD;
    }).slice(0, LIMIT).reverse();
    while (this.records.length && Buffer.byteLength(JSON.stringify({ version: 1, records: this.records })) > MAX_BYTES) this.records.shift();
  }

  save() {
    this.trim();
    if (!this.file) return;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, records: this.records }), { mode: 0o600 });
      renameSync(temporary, this.file);
      this.warning = null;
    } catch {
      // The send already succeeded: retain the echo in memory and never invite a resend.
      this.warning = '指令已发送，但本地回执暂未保存到磁盘；请勿重复发送。';
      try { rmSync(temporary, { force: true }); } catch {}
    }
  }

  merge(threadId, messages = []) {
    const original = transcriptMessages(messages);
    const records = this.records.filter(record => record.threadId === threadId);
    if (!records.length) return original;
    const indexes = new Map(original.map((message, index) => [message.id, index]));
    const claimed = new Set(records.map(record => record.matchedId).filter(Boolean));
    const overlays = new Map();
    const insertions = new Map();
    let changed = false;
    let afterEarlierReceipt = 0;
    for (const record of records) {
      const anchor = record.anchors.map(id => indexes.get(id)).filter(index => index !== undefined).at(-1);
      let index = record.matchedId ? indexes.get(record.matchedId) : undefined;
      if (index === undefined && !record.matchedId) {
        index = original.findIndex((message, position) => {
          if (message.role !== 'user' || !identifier(message.id) || claimed.has(message.id) || record.beforeUserIds.includes(message.id) || !sameText(message.text, record.text)) return false;
          if (record.turnId && message.turnId && record.turnId !== message.turnId) return false;
          if (anchor !== undefined) return position > anchor;
          if (record.turnId && message.turnId === record.turnId) return true;
          if (Number.isFinite(message.createdAt)) return message.createdAt >= record.createdAt;
          return record.emptyBefore;
        });
        if (index === -1) index = undefined;
        else { record.matchedId = original[index].id; claimed.add(record.matchedId); changed = true; }
      }
      const echo = { id: record.id, role: 'user', text: record.text, turnId: record.turnId, createdAt: record.createdAt, submitted: true, delivery: 'sent' };
      if (index !== undefined) {
        overlays.set(index, { ...original[index], ...echo, turnId: original[index].turnId || record.turnId, serverId: record.matchedId });
        afterEarlierReceipt = Math.max(afterEarlierReceipt, index + 1);
      } else {
        // Place before the new answer, at the point where this instruction was sent.
        const firstInTurn = record.turnId ? original.findIndex(message => message.turnId === record.turnId) : -1;
        const position = Math.max(afterEarlierReceipt, anchor !== undefined ? anchor + 1 : firstInTurn >= 0 ? firstInTurn : record.emptyBefore ? 0 : original.length);
        if (!insertions.has(position)) insertions.set(position, []);
        insertions.get(position).push(echo);
      }
    }
    if (changed) this.save();
    const combined = [];
    for (let index = 0; index <= original.length; index++) {
      combined.push(...(insertions.get(index) || []));
      if (index < original.length) combined.push(overlays.get(index) || original[index]);
    }
    return combined.slice(-400);
  }
}
