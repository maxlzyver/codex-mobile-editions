import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopProjects } from '../lib/desktop-projects.mjs';

const response = value => ({ structuredContent: value });
function fixture(t) {
  const desktop = new EventEmitter(), calls = [];
  Object.assign(desktop, { options: { hostId: 'local', callerThreadId: 'fixture-caller' }, tools: ['list_projects', 'list_threads'].map(name => ({ name, namespace: 'codex_app' })), connect: async () => {} });
  const state = {
    projects: [{ projectId: 'shared', projectKind: 'local', hostId: 'local', label: '同名项目' }, { projectId: 'second', projectKind: 'local', hostId: 'local', label: '同名项目' }, { projectId: 'shared', projectKind: 'chatgpt', label: 'GPT 项目' }, { projectId: 'remote', projectKind: 'remote', hostId: 'remote', label: '其他电脑' }],
    threads: [
      { id: 'shared-chat', kind: 'codex', hostId: 'local', projectId: 'shared' },
      { id: 'shared-chat', kind: 'chatgpt', projectId: 'shared' },
      { id: 'codex-only', kind: 'codex', hostId: 'local', projectId: 'shared' },
      { id: 'gpt-only', kind: 'chatgpt', projectId: 'shared' },
      { id: 'loose', kind: 'codex', hostId: 'local', projectId: null },
      { id: 'removed', kind: 'codex', hostId: 'local', projectId: null },
      { id: 'archived', kind: 'codex', hostId: 'local', projectId: 'shared', archived: true },
      { id: 'foreign', kind: 'codex', hostId: 'remote', projectId: 'remote' },
    ],
    sections: [
      { sectionId: 'pinned', name: 'Pinned', itemKeys: [] },
      { sectionId: 'work', name: '课程作业', itemKeys: ['codex:project:second', 'codex:thread:local:loose', 'chatgpt:project:shared', 'codex:project:shared', 'codex:thread:local:old', 'codex:project:second', 'codex:thread:local:archived', 'codex:thread:remote:foreign', 'codex:project:remote', 'codex:thread:local:missing'] },
      { sectionId: 'empty', name: '空分区', itemKeys: [] },
      { sectionId: 'threads', name: 'Projects', itemKeys: [] },
      { sectionId: 'chats', name: 'Tasks', itemKeys: ['codex:thread:local:removed'] },
    ],
    saved: [{ id: 'old', projectId: 'shared' }, { id: 'removed', projectId: 'shared' }, { id: 'archived', projectId: 'shared' }],
  };
  desktop.callReadOnly = async name => { calls.push(name); return response(name === 'list_projects' ? { projects: state.projects } : { threads: state.threads, sections: state.sections }); };
  const catalog = new DesktopProjects({ desktop, tasks: { list: async () => state.saved } }, { cacheMs: 60000, projectCacheMs: 60000 });
  t.after(() => catalog.close());
  return { catalog, desktop, state, calls };
}

test('section API preserves desktop section order and mixed member order, filtering inaccessible references', async t => {
  const { catalog } = fixture(t), result = await catalog.list();
  assert.equal(result.available, true);
  assert.deepEqual(result.sections.map(section => [section.id, section.type]), [['pinned', 'pinned'], ['work', 'custom'], ['empty', 'custom'], ['threads', 'projects'], ['chats', 'threads']]);
  assert.deepEqual(result.sections[1].items, [
    { type: 'project', kind: 'codex', id: 'second' },
    { type: 'thread', kind: 'codex', id: 'loose' },
    { type: 'project', kind: 'chatgpt', id: 'shared' },
    { type: 'project', kind: 'codex', id: 'shared' },
    { type: 'thread', kind: 'codex', id: 'old' },
  ]);
  assert.deepEqual(result.sections[1].projectIds, ['second', 'shared', 'shared']);
  assert.deepEqual(result.sections[1].threadIds, ['loose', 'old']);
  assert.equal(result.sections[2].name, '空分区');
  assert.equal(result.complete, false);
});

test('shared project and thread IDs do not mix GPT/Codex membership; explicit removals beat saved history', async t => {
  const { catalog } = fixture(t), result = await catalog.list();
  assert.deepEqual(result.projects.find(item => item.kind === 'codex' && item.id === 'shared').threadIds, ['old', 'shared-chat', 'codex-only']);
  assert.deepEqual(result.projects.find(item => item.kind === 'chatgpt').threadIds, ['shared-chat', 'gpt-only']);
  assert.deepEqual(result.threadMemberships.find(item => item.id === 'removed'), { id: 'removed', kind: 'codex', projectId: null });
  assert(!result.threadMemberships.some(item => item.id === 'archived'));
  assert(result.projects.every(item => item.threadsComplete === false && item.threadCount === null));
});

test('malformed or duplicate sections cannot duplicate UI identities or inherit object properties', async t => {
  const { catalog, state } = fixture(t);
  state.sections.push({ sectionId: 'work', name: 'Duplicate', itemKeys: [] }, { sectionId: '', itemKeys: [] }, { name: 'No ID' }, { sectionId: '__proto__', name: '<script>literal</script>', itemKeys: 'invalid' });
  const result = await catalog.list();
  assert.equal(result.available, true);
  assert.equal(result.sections.filter(item => item.id === 'work').length, 1);
  assert.deepEqual(result.sections.at(-1), { id: '__proto__', type: 'custom', name: '<script>literal</script>', items: [], projectIds: [], threadIds: [] });
});

test('creating a Codex child resolves its local project even when GPT has the same project ID first', async t => {
  const { catalog, desktop, state } = fixture(t);
  state.projects.reverse(); desktop.options.allowWrites = true;
  desktop.tools.push({ name: 'create_thread', namespace: 'codex_app', inputSchema: { properties: { target: { anyOf: [{ properties: { type: { enum: ['project'] } } }] } } } });
  let target;
  desktop.call = async (tool, args) => { assert.equal(tool, 'create_thread'); target = args.target; return response({ threadId: 'new-child', hostId: 'local' }); };
  const result = await catalog.createThread('shared', { prompt: 'Mock only' });
  assert.equal(result.threadId, 'new-child');
  assert.deepEqual(target, { type: 'project', projectId: 'shared', environment: { type: 'local' } });
});

test('forced refresh sees desktop moves without waiting for catalog TTL, while normal reads share cache', async t => {
  const { catalog, state, calls } = fixture(t);
  await catalog.list(); await catalog.list();
  assert.equal(calls.length, 2);
  state.sections = [{ sectionId: 'moved', name: '移动之后', itemKeys: ['codex:project:shared', 'codex:project:second'] }];
  assert.equal((await catalog.list()).sections[1].id, 'work');
  const result = await catalog.list({ fresh: true });
  assert.deepEqual(result.sections.map(section => section.id), ['moved']);
  assert.deepEqual(result.sections[0].projectIds, ['shared', 'second']);
  assert.equal(calls.length, 4);
});
