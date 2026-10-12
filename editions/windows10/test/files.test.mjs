import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { Projects } from '../lib/files.mjs';

const hasStatus = expected => error => {
  assert.equal(error.status, expected, error.message);
  return true;
};

test('mobile-added project roots are separate, persist, and disappear from the restricted scope', async t => {
  const { projects, options, outside, projectA } = await fixture(t);
  const added = await projects.addRoot(outside, { source: 'mobile' });
  assert.ok((await projects.list()).some(project => project.id === added.id));
  assert.ok(!(await projects.list({ includeMobileRoots: false })).some(project => project.id === added.id));
  await assert.rejects(projects.browse(added.id, '', { includeMobileRoots: false }), hasStatus(404));
  await assert.rejects(projects.preview(added.id, 'outside.txt', { includeMobileRoots: false }), hasStatus(404));
  const reopened = new Projects(options);
  assert.ok((await reopened.list()).some(project => project.id === added.id));
  assert.ok(!(await reopened.list({ includeMobileRoots: false })).some(project => project.id === added.id));
  assert.ok((await reopened.list({ includeMobileRoots: false })).some(project => project.path === projectA));
  await reopened.addRoot(outside);
  assert.ok((await reopened.list({ includeMobileRoots: false })).some(project => project.id === added.id), 'An explicit owner grant remains available');
});

test('disabling broad mobile roots retains only concrete task working directories', async t => {
  const { projects, outside, options } = await fixture(t);
  const selected = await projects.addRoot(outside, { source: 'mobile' });
  const child = path.join(outside, 'real-project'); await mkdir(child); await writeFile(path.join(child, 'result.txt'), 'task result');
  projects.tasks = { list: async () => [{ id: 'created-task', cwd: child }] };
  const scope = { includeMobileRoots: false }, visible = await projects.list(scope);
  assert.ok(!visible.some(project => project.id === selected.id));
  const actual = visible.find(project => project.path === child); assert.ok(actual);
  assert.equal((await projects.preview(actual.id, 'result.txt', scope)).text, 'task result');
  await assert.rejects(projects.resolveFile(actual.id, '../outside.txt', scope), hasStatus(400));
});

test('other-directory picker never opens credentials, private state, network aliases, or files', async t => {
  const { projects, projectA, outside, runtimeDir, privateAccount } = await fixture(t);
  const credentials = path.join(outside, '.codex'), ssh = path.join(outside, '.ssh');
  await mkdir(credentials); await mkdir(ssh); await writeFile(path.join(credentials, 'auth.json'), 'must stay private');
  const accountLink = path.join(outside, 'account-link');
  await symlink(privateAccount, accountLink, process.platform === 'win32' ? 'junction' : 'dir');
  const listing = await projects.browseDirectories(outside);
  assert.equal(listing.path, await realpath(outside));
  assert.ok(!listing.entries.some(entry => ['.codex', '.ssh', 'outside.txt', 'account-link'].includes(entry.name)));
  for (const target of [credentials, ssh, runtimeDir, privateAccount, accountLink]) {
    await assert.rejects(projects.browseDirectories(target), hasStatus(403));
    await assert.rejects(projects.addRoot(target, { source: 'mobile' }), hasStatus(403));
  }
  for (const invalid of ['relative', 'C:\\folder:stream', '\\\\host\\share', '\\\\?\\C:\\Windows', path.join(projectA, '..', '..') + '/../escape']) {
    await assert.rejects(projects.browseDirectories(invalid), error => [400, 404].includes(error.status));
  }
  await assert.rejects(projects.browseDirectories(path.join(outside, 'outside.txt')), hasStatus(400));
  const shortcuts = await projects.browseDirectories();
  assert.equal(shortcuts.path, null); assert.deepEqual(shortcuts.entries, []); assert.ok(Array.isArray(shortcuts.locations));
});

async function fixture(t) {
  const work = fileURLToPath(new URL('../../../../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  const scratch = await mkdtemp(path.join(work, 'project-files-test-'));
  t.after(async () => {
    // Every recursive cleanup is checked against this test's workspace root.
    const target = path.resolve(scratch);
    assert.equal(path.dirname(target).toLowerCase(), path.resolve(work).toLowerCase());
    assert.ok(path.basename(target).startsWith('project-files-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const projectA = path.join(scratch, 'Project A');
  const projectB = path.join(scratch, 'Project B');
  const outside = path.join(scratch, 'Outside');
  const runtimeDir = path.join(projectA, '.runtime');
  const privateAccount = path.join(projectA, '.account');
  const subdir = path.join(projectA, '资料');
  await Promise.all([projectA, projectB, outside, runtimeDir, privateAccount, subdir].map(directory => mkdir(directory, { recursive: true })));
  await Promise.all([
    writeFile(path.join(projectA, 'README.md'), '# 项目说明\n你好，手机！\n', 'utf8'),
    writeFile(path.join(projectA, 'report.json'), '{"result":"正常项目 JSON"}\n', 'utf8'),
    writeFile(path.join(subdir, '结论.txt'), '验证 UTF-8，中文与 emoji 🚀。\n', 'utf8'),
    writeFile(path.join(runtimeDir, 'devices.json'), '{"private":"test-device"}', 'utf8'),
    writeFile(path.join(privateAccount, 'auth.json'), '{"private":"test-account"}', 'utf8'),
    writeFile(path.join(outside, 'outside.txt'), 'outside-project', 'utf8'),
  ]);
  const tasks = {
    async list(options) {
      assert.deepEqual(options, { all: true });
      return [
        { id: 'a1', cwd: projectA }, { id: 'a2', cwd: projectA },
        { id: 'b1', cwd: projectB }, { id: 'missing', cwd: path.join(scratch, 'Removed') },
        { id: 'private', cwd: privateAccount }, { id: 'invalid', cwd: 'relative-directory' },
      ];
    },
  };
  const options = { tasks, defaultCwd: projectA, runtimeDir, protectedPaths: [privateAccount] };
  const projects = new Projects(options);
  const project = (await projects.list()).find(entry => entry.path === projectA);
  assert.ok(project, 'the default project is discoverable');
  return { projects, options, project, projectA, projectB, outside, runtimeDir, privateAccount, subdir };
}

test('projects aggregate task working directories and have stable canonical IDs', async t => {
  const { projects, options, project, projectA, projectB } = await fixture(t);
  const list = await projects.list();
  assert.equal(list.length, 3);
  assert.equal(project.threadCount, 2);
  assert.equal(project.exists, true);
  assert.match(project.id, /^[a-f0-9]{24}$/);
  assert.ok(list.some(entry => entry.path === projectB && entry.threadCount === 1));
  assert.ok(list.some(entry => entry.name === 'Removed' && entry.exists === false));
  const second = new Projects(options);
  assert.equal((await second.list()).find(entry => entry.path === projectA).id, project.id);
  assert.equal((await projects.resolveProject(project.id)).path, await realpath(projectA));
  await assert.rejects(projects.resolveProject('C:\\Windows'), hasStatus(404));
});

test('browse returns directories, Unicode filenames and relative breadcrumbs', async t => {
  const { projects, project } = await fixture(t);
  const root = await projects.browse(project.id);
  assert.equal(root.path, '');
  assert.equal(root.entries[0].type, 'directory');
  assert.deepEqual(root.breadcrumbs, [{ name: 'Project A', path: '' }]);
  const nested = await projects.browse(project.id, '资料');
  assert.deepEqual(nested.breadcrumbs.map(entry => entry.path), ['', '资料']);
  const file = nested.entries.find(entry => entry.name === '结论.txt');
  assert.equal(file.path, '资料/结论.txt');
  assert.equal(file.type, 'file');
  assert.ok(file.size > 0);
  assert.ok(Number.isFinite(file.modifiedAt));
  await assert.rejects(projects.browse(project.id, 'README.md'), hasStatus(400));
});

test('path traversal, absolute paths, Windows ADS and normalization aliases are rejected', async t => {
  const { projects, project } = await fixture(t);
  for (const input of [
    '../Outside/outside.txt', '资料/../../Outside/outside.txt', '..\\Outside\\outside.txt',
    '/etc/passwd', 'C:\\Windows\\win.ini', 'C:win.ini', '\\\\server\\share\\file.txt',
    'README.md:alternate', 'README.md::$DATA', '.. /outside.txt', '资料./结论.txt',
    'README.md ', 'NUL', 'COM1.txt', 'README.md\0',
  ]) {
    await assert.rejects(projects.resolveFile(project.id, input), hasStatus(400), input);
  }
  await assert.rejects(projects.resolveFile(project.id, ''), hasStatus(400));
});

test('chat references resolve local absolute, encoded, relative and file URI paths with line markers', async t => {
  const { projects, project, subdir } = await fixture(t);
  const absolute = path.join(subdir, '结论.txt');
  for (const reference of [
    '资料/结论.txt', './资料/结论.txt:12:3', '资料/结论.txt#L12C3', encodeURI('资料/结论.txt'),
    absolute, `${absolute}:12`, pathToFileURL(absolute).href + '#L12', `sandbox:${absolute}`,
  ]) {
    const resolved = await projects.resolveReference(project.id, reference);
    assert.equal(resolved.projectId, project.id);
    assert.equal(resolved.path, '资料/结论.txt', reference);
    assert.equal(resolved.name, '结论.txt');
    assert.equal(resolved.mime, 'text/plain');
    assert(resolved.size > 0);
    assert.equal(resolved.absolutePath, undefined);
    assert.match((await projects.preview(project.id, resolved.path)).text, /中文/);
  }
});

test('chat references cannot cross their selected project or expose private state', async t => {
  const { projects, project, projectB, outside, runtimeDir, privateAccount } = await fixture(t);
  await writeFile(path.join(projectB, 'other.txt'), 'Another authorized project');
  for (const reference of [path.join(outside, 'outside.txt'), path.join(projectB, 'other.txt')]) {
    await assert.rejects(projects.resolveReference(project.id, reference), hasStatus(403));
  }
  for (const reference of [path.join(runtimeDir, 'devices.json'), pathToFileURL(path.join(privateAccount, 'auth.json')).href]) {
    await assert.rejects(projects.resolveReference(project.id, reference), hasStatus(403));
  }
  for (const reference of ['../Outside/outside.txt', '%2e%2e%2fOutside%2foutside.txt', 'javascript:alert(1)', 'https://example.com/a.pdf', 'file://remote-server/share/a.txt', 'README.md:secret', 'README.md::$DATA', 'README.md%00', 'sandbox:relative.txt']) {
    await assert.rejects(projects.resolveReference(project.id, reference), hasStatus(400), reference);
  }
  await assert.rejects(projects.resolveReference(project.id, 'missing.txt'), hasStatus(404));
  await assert.rejects(projects.resolveReference(project.id, '资料'), hasStatus(400));
});

test('private state is hidden and denied while normal project JSON remains readable', async t => {
  const { projects, project } = await fixture(t);
  const root = await projects.browse(project.id);
  assert.ok(!root.entries.some(entry => ['.runtime', '.account'].includes(entry.name)));
  await assert.rejects(projects.browse(project.id, '.runtime'), hasStatus(403));
  await assert.rejects(projects.resolveFile(project.id, '.runtime/devices.json'), hasStatus(403));
  await assert.rejects(projects.preview(project.id, '.account/auth.json'), hasStatus(403));
  const ordinary = await projects.preview(project.id, 'report.json');
  assert.equal(ordinary.mime, 'application/json');
  assert.equal(JSON.parse(ordinary.text).result, '正常项目 JSON');
});

test('directory links cannot escape a project or expose private state', async t => {
  const { projects, project, projectA, outside, privateAccount, subdir } = await fixture(t);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await symlink(outside, path.join(projectA, 'escape'), type);
    await symlink(privateAccount, path.join(projectA, 'private-link'), type);
    await symlink(subdir, path.join(projectA, 'inside-link'), type);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`This filesystem cannot create directory links: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(projects.resolveFile(project.id, 'escape/outside.txt'), hasStatus(403));
  await assert.rejects(projects.resolveReference(project.id, 'escape/outside.txt'), hasStatus(403));
  await assert.rejects(projects.resolveReference(project.id, 'private-link/auth.json'), hasStatus(403));
  await assert.rejects(projects.browse(project.id, 'escape'), hasStatus(403));
  await assert.rejects(projects.preview(project.id, 'private-link/auth.json'), hasStatus(403));
  const names = (await projects.browse(project.id)).entries.map(entry => entry.name);
  assert.ok(!names.includes('escape'));
  assert.ok(!names.includes('private-link'));
  assert.ok(names.includes('inside-link'));
  assert.match((await projects.preview(project.id, 'inside-link/结论.txt')).text, /UTF-8/);
  assert.equal((await projects.resolveReference(project.id, 'inside-link/结论.txt')).path, 'inside-link/结论.txt');
});

test('text preview decodes UTF-8 without modifying files', async t => {
  const { projects, project, projectA, subdir } = await fixture(t);
  const before = await readFile(path.join(subdir, '结论.txt'));
  const preview = await projects.preview(project.id, '资料\\结论.txt');
  assert.equal(preview.text, '验证 UTF-8，中文与 emoji 🚀。\n');
  assert.equal(preview.path, '资料/结论.txt');
  assert.equal(preview.size, before.length);
  assert.equal(preview.truncated, false);
  assert.deepEqual(await readFile(path.join(subdir, '结论.txt')), before);
  await writeFile(path.join(projectA, 'LICENSE'), 'UTF-8 text without extension\n');
  assert.equal((await projects.preview(project.id, 'LICENSE')).mime, 'text/plain');
});

test('binary and invalid UTF-8 previews are rejected but regular files can be downloaded', async t => {
  const { projects, project, projectA } = await fixture(t);
  await Promise.all([
    writeFile(path.join(projectA, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255])),
    writeFile(path.join(projectA, 'invalid.txt'), Buffer.from([0xc3, 0x28])),
    writeFile(path.join(projectA, 'photo.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    writeFile(path.join(projectA, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61)),
  ]);
  for (const name of ['binary.bin', 'invalid.txt', 'photo.png']) await assert.rejects(projects.preview(project.id, name), hasStatus(415));
  await assert.rejects(projects.preview(project.id, 'large.txt'), hasStatus(413));
  const download = await projects.resolveFile(project.id, 'photo.png');
  assert.equal(download.mime, 'image/png');
  assert.equal(download.size, 8);
  assert.equal(download.name, 'photo.png');
  assert.equal(download.absolutePath, path.join(projectA, 'photo.png'));
  await assert.rejects(projects.resolveFile(project.id, '资料'), hasStatus(400));
});

test('owner-added roots persist only in runtime configuration and are validated', async t => {
  const { projects, options, outside, privateAccount, runtimeDir, projectA } = await fixture(t);
  const before = (await readdir(projectA)).sort();
  const added = await projects.addRoot(outside);
  assert.equal(added.path, outside);
  assert.equal((await projects.preview(added.id, 'outside.txt')).text, 'outside-project');
  assert.deepEqual(JSON.parse(await readFile(path.join(runtimeDir, 'project-roots.json'), 'utf8')), [outside]);
  await projects.addRoot(outside);
  assert.deepEqual(JSON.parse(await readFile(path.join(runtimeDir, 'project-roots.json'), 'utf8')), [outside]);
  const reloaded = new Projects(options);
  assert.ok((await reloaded.list()).some(entry => entry.id === added.id));
  assert.deepEqual((await readdir(projectA)).sort(), before);
  await assert.rejects(projects.addRoot('relative'), hasStatus(400));
  await assert.rejects(projects.addRoot(privateAccount), hasStatus(403));
  await assert.rejects(projects.addRoot(path.join(projectA, 'README.md')), hasStatus(400));
  await assert.rejects(projects.addRoot(path.join(outside, 'missing')), hasStatus(404));
});
