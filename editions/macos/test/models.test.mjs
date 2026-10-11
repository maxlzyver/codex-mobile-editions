import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Models } from '../lib/models.mjs';

const entry = (id, model, extra = {}) => ({ id, model, displayName: id, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '常规' }, { reasoningEffort: 'high', description: '更深入' }], ...extra });
class Bridge extends EventEmitter {
  constructor(handler) { super(); this.state = { connected: true }; this.calls = []; this.handler = handler; }
  async start() { this.state.connected = true; }
  async request(method, params) { assert.equal(method, 'model/list'); this.calls.push(params); return this.handler(params); }
}

test('catalog paginates, filters hidden entries, and returns the server-provided names and efforts', async () => {
  const bridge = new Bridge(params => params.cursor
    ? { data: [entry('other-picker', 'other-model')], nextCursor: null }
    : { data: [entry('default-picker', 'default-model', { isDefault: true }), entry('hidden', 'hidden', { hidden: true })], nextCursor: 'page-two' });
  const models = new Models(bridge);
  const result = await models.list();
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'default-picker');
  assert.equal(result[0].model, 'default-model');
  assert.equal(result[0].displayName, 'default-picker');
  assert.deepEqual(result[0].supportedReasoningEfforts[1], { reasoningEffort: 'high', description: '更深入' });
  assert.equal(bridge.calls[1].cursor, 'page-two');
  assert.equal(bridge.calls[0].includeHidden, false);
});

test('selection accepts picker IDs, preserves valid saved choices, and uses the new model default when switching', async () => {
  const models = new Models(new Bridge(() => ({ data: [entry('one', 'model-one', { isDefault: true }), entry('two', 'model-two', { defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] })] })));
  assert.deepEqual(await models.resolve(), { model: 'model-one', effort: 'medium' });
  assert.deepEqual(await models.resolve({ model: 'one', effort: 'high' }), { model: 'model-one', effort: 'high' });
  assert.deepEqual(await models.resolve({}, { model: 'model-one', effort: 'high' }), { model: 'model-one', effort: 'high' });
  assert.deepEqual(await models.resolve({ model: 'two' }, { model: 'model-one', effort: 'high' }), { model: 'model-two', effort: 'low' });
});

test('unknown models, unsupported efforts and malformed choices fail validation', async () => {
  const bridge = new Bridge(() => ({ data: [entry('one', 'model-one', { isDefault: true })] }));
  const models = new Models(bridge);
  for (const options of [{ model: 'not-there' }, { effort: 'unadvertised' }, { model: {} }, { effort: ['high'] }, { model: 'bad\nmodel' }, null, []]) await assert.rejects(models.resolve(options), { status: 400 });
  assert.equal(bridge.calls.length, 2, 'unknown selection refreshes the catalog once');
});

test('refresh fetches current account models and returned objects cannot mutate the cached catalog', async () => {
  let data = [entry('old', 'old-model', { isDefault: true })];
  const bridge = new Bridge(() => ({ data }));
  const models = new Models(bridge);
  const first = await models.list(); first[0].model = 'tampered'; first[0].supportedReasoningEfforts[0].reasoningEffort = 'tampered';
  assert.equal((await models.list())[0].model, 'old-model');
  data = [entry('new', 'new-model', { isDefault: true })];
  assert.equal((await models.list({ refresh: true }))[0].model, 'new-model');
  assert.deepEqual(await models.resolve(), { model: 'new-model', effort: 'medium' });
});

test('no static model fallback exists for an empty catalog and repeated cursors cannot loop forever', async () => {
  await assert.rejects(new Models(new Bridge(() => ({ data: [] }))).resolve(), { status: 400 });
  const looping = new Models(new Bridge(() => ({ data: [], nextCursor: 'same' })));
  await assert.rejects(looping.list(), { status: 502 });
});

test('concurrent catalog reads share one RPC and disconnect invalidates the cache', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const bridge = new Bridge(async () => { await wait; return { data: [entry('one', 'model-one')] }; });
  const models = new Models(bridge);
  const a = models.list(); const b = models.list();
  release();
  await Promise.all([a, b]);
  assert.equal(bridge.calls.length, 1);
  bridge.emit('state', { connected: false });
  await models.list();
  assert.equal(bridge.calls.length, 2);
});
