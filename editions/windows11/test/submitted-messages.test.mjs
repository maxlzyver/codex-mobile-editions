import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { SubmittedMessages, transcriptMessages } from '../lib/submitted-messages.mjs';

const user = (id, text, turnId = 'turn') => ({ id, role: 'user', text, turnId });
const answer = (id, text = 'Answer', turnId = 'turn') => ({ id, role: 'assistant', text, turnId });
async function directory(t) {
  const work = fileURLToPath(new URL('../../../../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  const folder = await mkdtemp(path.join(work, 'submitted-messages-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test('only accepted receipts survive restart and appear while the transcript is delayed', async t => {
  const folder = await directory(t);
  const store = new SubmittedMessages(folder);
  store.begin('thread', 'not accepted', []);
  assert.deepEqual(store.merge('thread', []), []);
  const accepted = store.accept(store.begin('thread', 'mobile prompt', [answer('old', 'Older')]), 'next');
  const restored = new SubmittedMessages(folder);
  const displayed = restored.merge('thread', [answer('old', 'Older'), answer('new', 'Working', 'next')]);
  assert.deepEqual(displayed.map(message => message.text), ['Older', 'mobile prompt', 'Working']);
  assert.equal(displayed[1].id, accepted.id);
  assert.equal(displayed[1].delivery, 'sent');
  assert.equal(displayed[1].createdAt, accepted.createdAt);
  assert.deepEqual(restored.merge('other-thread', []), []);
  const persisted = JSON.parse(await readFile(path.join(folder, 'submitted-messages.json'), 'utf8'));
  assert.equal(persisted.records.length, 1);
});

test('two identical instructions reconcile one-to-one without consuming an older identical message', () => {
  const store = new SubmittedMessages();
  const baseline = [user('historic-user', 'Again', 'old'), answer('historic-answer', 'Done', 'old')];
  const first = store.accept(store.begin('thread', 'Again', baseline), 'turn');
  const second = store.accept(store.begin('thread', 'Again', baseline), 'turn');
  const partial = [...baseline, user('first-user', 'Again'), answer('working')];
  const displayed = store.merge('thread', partial);
  assert.deepEqual(displayed.filter(message => message.role === 'user').map(message => message.id), ['historic-user', first.id, second.id]);
  assert.equal(displayed.find(message => message.id === first.id).serverId, 'first-user');
  assert.equal(displayed.find(message => message.id === second.id).serverId, undefined);
  const complete = [...baseline, user('first-user', 'Again'), user('second-user', 'Again'), answer('working')];
  const reconciled = store.merge('thread', complete);
  assert.deepEqual(reconciled.filter(message => message.role === 'user').map(message => message.id), ['historic-user', first.id, second.id]);
  assert.equal(reconciled.find(message => message.id === second.id).serverId, 'second-user');
  assert.deepEqual(store.merge('thread', reconciled), reconciled, 'merging an already rendered view is idempotent');
});

test('receipts reconcile a late user message after assistant streaming without changing their stable ID', async t => {
  const folder = await directory(t);
  const store = new SubmittedMessages(folder);
  const receipt = store.accept(store.begin('thread', 'Start', []), 'turn');
  assert.deepEqual(store.merge('thread', [answer('a')]).map(message => message.text), ['Start', 'Answer']);
  const matched = store.merge('thread', [user('real', 'Start'), answer('a')]);
  assert.equal(matched[0].id, receipt.id);
  assert.equal(matched[0].serverId, 'real');
  assert.deepEqual(transcriptMessages(matched), [user('real', 'Start'), answer('a')].map((message, index) => index ? message : { ...message, createdAt: receipt.createdAt }));
  const restored = new SubmittedMessages(folder);
  assert.equal(restored.merge('thread', [user('real', 'Start')])[0].id, receipt.id);
  assert.equal(restored.merge('thread', [])[0].text, 'Start', 'a stale snapshot must not erase an accepted instruction');
});

test('an identical user message from another turn or before the anchor does not absorb a receipt', () => {
  const store = new SubmittedMessages();
  const baseline = [answer('anchor', 'Old', 'old')];
  const receipt = store.accept(store.begin('thread', 'Same', baseline), 'new');
  const displayed = store.merge('thread', [user('earlier', 'Same', 'old'), ...baseline, user('elsewhere', 'Same', 'different')]);
  assert.equal(displayed.filter(message => message.role === 'user').length, 3);
  assert.equal(displayed.find(message => message.id === receipt.id).serverId, undefined);
});

test('when an anchor scrolls out of history, ambiguous matching does not hide either message', () => {
  const store = new SubmittedMessages();
  const receipt = store.accept(store.begin('thread', 'Same', [answer('missing-anchor') ]));
  const displayed = store.merge('thread', [user('unknown-old-user', 'Same')]);
  assert.equal(displayed.length, 2);
  assert.equal(displayed.find(message => message.id === receipt.id).serverId, undefined);
});

test('receipt retention is bounded and discards the oldest entries first', () => {
  const store = new SubmittedMessages();
  for (let index = 0; index < 230; index++) store.accept(store.begin('thread', `Prompt ${index}`, []));
  assert.equal(store.records.length, 200);
  assert.equal(store.merge('thread', [])[0].text, 'Prompt 30');
  for (let index = 0; index < 900; index++) store.accept(store.begin(`thread-${index}`, 'Small', []));
  assert.equal(store.records.length, 1000);
});

test('a disk failure preserves successful delivery in memory and does not pretend it can retry safely', async t => {
  const folder = await directory(t);
  const store = new SubmittedMessages(path.join(folder, 'missing-directory'));
  const receipt = store.accept(store.begin('thread', 'Accepted by Codex', []));
  assert.equal(store.merge('thread', [])[0].id, receipt.id);
  assert.match(store.warning, /已发送/);
  assert.match(store.warning, /勿重复发送/);
});
