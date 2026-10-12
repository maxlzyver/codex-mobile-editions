import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { UpdateManager, parseVersion, compareVersions, readEditionProfile, editionAssetName, UPDATE_REPOSITORY, LATEST_RELEASE_URL, REPOSITORY_COMMIT_URL } from '../lib/updater.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORK = fileURLToPath(new URL('../../../../../work/', import.meta.url));
const edition = readEditionProfile(ROOT);
// Keep the simulated installation independent of the release currently under test.
const PROFILE = { ...edition, version: '1.0.0', assetName: editionAssetName(edition, '1.0.0') };
const COMMIT = 'a'.repeat(40), NEXT_COMMIT = 'b'.repeat(40);
const RAW = 'https://raw.githubusercontent.com/' + UPDATE_REPOSITORY + '/' + COMMIT + '/' + PROFILE.updatePath + '/update.json';
const ARCHIVE = 'https://codeload.github.com/' + UPDATE_REPOSITORY + '/zip/' + COMMIT;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('mock archive; never execute')]);
const reply = (body = '', status = 200, headers = {}) => new Response(body, { status, headers });
const json = value => Buffer.from(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function timers() {
  const active = new Set();
  return { active, setTimeout(fn, delay) { const timer = { fn, delay, unref() {} }; active.add(timer); return timer; }, clearTimeout(timer) { active.delete(timer); } };
}
async function fixture(t, { routes = new Map(), ...options } = {}) {
  await mkdir(WORK, { recursive: true });
  const rootDir = await mkdtemp(path.join(WORK, 'edition-updater-test-'));
  await writeFile(path.join(rootDir, 'edition.json'), JSON.stringify(PROFILE));
  const calls = [], scheduled = [];
  const manager = new UpdateManager({ rootDir, currentVersion: PROFILE.version, isBusy: () => false,
    installPrepared: async prepared => { scheduled.push(prepared); return { scheduled: true, version: prepared.version }; },
    fetchImpl: async (url, init) => { calls.push({ url, init }); const handler = routes.get(url); return typeof handler === 'function' ? handler(init) : handler === undefined ? reply('', 404) : reply(handler); }, ...options });
  t.after(async () => { await manager.close(); const relative = path.relative(WORK, rootDir); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await rm(rootDir, { recursive: true, force: true }); });
  return { manager, rootDir, calls, scheduled, routes };
}
function repository({ version = '1.0.1', manifest: overrides = {}, zip = ZIP } = {}) {
  const targetProfile = { ...PROFILE, version, assetName: editionAssetName(PROFILE, version) };
  const manifest = { name: 'Codex 移动助手', edition: PROFILE.id, version, repository: UPDATE_REPOSITORY, platform: PROFILE.platform, runtimePolicy: 'preserve', files: [
    { path: 'server.mjs', bytes: 4, sha256: digest('mock') }, { path: 'package.json', bytes: 2, sha256: digest('{}') },
    { path: 'edition.json', bytes: json(targetProfile).length, sha256: digest(json(targetProfile)) },
  ], ...overrides };
  return { manifest, routes: new Map([[REPOSITORY_COMMIT_URL, json({ sha: COMMIT })], [RAW, json(manifest)], [ARCHIVE, zip]]) };
}

test('strict SemVer compares numeric components, prereleases and ignored build metadata', () => {
  for (const value of ['01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-01', '../1.2.3', '1.2.3\n']) assert.equal(parseVersion(value), null, value);
  assert.equal(parseVersion('v1.2.3+build.1').version, '1.2.3+build.1');
  for (const [left, right] of [['1.10.0', '1.9.9'], ['2.0.0', '1.999.999'], ['1.0.0', '1.0.0-rc.1'], ['1.0.0-beta.10', '1.0.0-beta.9'], ['1.0.0-alpha.a', '1.0.0-alpha.10'], ['99999999999999999999.0.0', '99999999999999999998.0.0']]) {
    assert.equal(compareVersions(left, right), 1); assert.equal(compareVersions(right, left), -1);
  }
  assert.equal(compareVersions('1.2.3+a', '1.2.3+b'), 0);
  assert.throws(() => compareVersions('bad', '1.0.0'), { status: 400 });
});


test('default is opt-out with no network, state is isolated and setting persists', async t => {
  const clock = timers();
  const f = await fixture(t, clock);
  assert.equal(f.manager.getState().autoUpdate, false); assert.equal(f.calls.length, 0); assert.equal(clock.active.size, 0);
  const state = f.manager.getState(); state.autoUpdate = true;
  assert.equal(f.manager.getState().autoUpdate, false);
  await assert.rejects(f.manager.configure({ autoUpdate: 'true' }), { status: 400 });
  await f.manager.configure({ autoUpdate: true });
  assert.equal(clock.active.size, 1); assert.equal([...clock.active][0].delay, 0); assert.equal(f.calls.length, 0);
  const restarted = new UpdateManager({ rootDir: f.rootDir, ...clock });
  assert.equal(restarted.getState().autoUpdate, true); await restarted.close();
  await f.manager.configure({ autoUpdate: false }); assert.equal(clock.active.size, 0);
  assert.deepEqual(JSON.parse(await readFile(f.manager.configPath, 'utf8')), { autoUpdate: false });
});


test('repository main resolves once to a fixed commit and reads only the matching edition folder', async t => {
  const f = await fixture(t, repository());
  const state = await f.manager.check();
  assert.equal(state.status, 'available'); assert.equal(state.source, 'repository'); assert.equal(state.sourceCommit, COMMIT);
  assert.equal(state.latestVersion, '1.0.1'); assert.equal(f.calls.length, 2); assert.equal(f.scheduled.length, 0);
  assert.equal(JSON.stringify(state).includes(f.rootDir), false);
  f.routes.set(REPOSITORY_COMMIT_URL, json({ sha: NEXT_COMMIT }));
  const prepared = await f.manager.prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(f.calls.at(-1).url, ARCHIVE);
  assert.equal(f.manager.prepared.archivePrefix, `codex-mobile-editions-${COMMIT}/${PROFILE.updatePath}/`);
  assert.match(prepared.reason, /逐文件校验/);
  assert.equal(f.scheduled.length, 0);
});


test('same or older repository versions are never downloaded or installed', async t => {
  for (const version of ['1.0.0', '0.9.99']) {
    const f = await fixture(t, repository({ version }));
    assert.equal((await f.manager.install()).status, 'upToDate'); assert.equal(f.calls.length, 2); assert.equal(f.scheduled.length, 0);
  }
});


test('repository manifests reject bad identity, prereleases, traversal, aliases and duplicate paths', async t => {
  const safe = { path: 'server.mjs', bytes: 1, sha256: '0'.repeat(64) };
  const variants = [{ repository: 'attacker/app' }, { platform: 'linux' }, { version: '1.3.0-beta.1' }, { files: [] }, ...['../evil', '/evil', 'C:/evil', 'folder\\evil', 'folder/./file', 'folder//file', 'folder/file. ', 'update.json'].map(path => ({ files: [{ ...safe, path }] })), { files: [safe, { ...safe, path: 'SERVER.MJS' }] }, { files: [{ ...safe, sha256: 'no' }] }, { files: [{ ...safe, bytes: -1 }] }];
  for (const manifest of variants) {
    const f = await fixture(t, repository({ manifest }));
    await assert.rejects(f.manager.check(), { status: 502 }); assert.equal(f.manager.getState().status, 'error'); assert.equal(f.scheduled.length, 0);
  }
});


test('malformed repository metadata does not silently fall back to another update source', async t => {
  const f = await fixture(t, { routes: new Map([[REPOSITORY_COMMIT_URL, json({ sha: 'main' })]]) });
  await assert.rejects(f.manager.check(), /SHA/); assert.equal(f.calls.length, 1);
  f.routes.set(REPOSITORY_COMMIT_URL, json({ sha: COMMIT })); f.routes.set(RAW, Buffer.from('not-json'));
  await assert.rejects(f.manager.check(), /JSON/); assert.equal(f.calls.some(call => call.url === LATEST_RELEASE_URL), false);
});


test('repository archive size is bounded both by header and streamed bytes', async t => {
  for (const declared of [true, false]) {
    const r = repository(); if (declared) r.routes.set(ARCHIVE, () => reply(ZIP, 200, { 'content-length': '9999999' }));
    const f = await fixture(t, { ...r, maxArchiveBytes: ZIP.length - 1 });
    await assert.rejects(f.manager.install(), /大小/); assert.equal(f.scheduled.length, 0);
  }
});


test('same operation joins one network check and competing operations fail with 409', async t => {
  const gate = defer(), r = repository(); r.routes.set(REPOSITORY_COMMIT_URL, () => gate.promise);
  const f = await fixture(t, r); const first = f.manager.check(), second = f.manager.check(); assert.equal(first, second);
  await assert.rejects(f.manager.prepare(), { status: 409 }); gate.resolve(reply(json({ sha: COMMIT })));
  await first; assert.equal(f.calls.length, 2);
});


test('busy manual install and uncertain task state never download or install', async t => {
  for (const isBusy of [() => true, () => undefined, () => { throw new Error('desktop unavailable'); }]) {
    const f = await fixture(t, { ...repository(), isBusy });
    assert.equal((await f.manager.install()).status, 'waitingForIdle'); assert.equal(f.calls.length, 0); assert.equal(f.scheduled.length, 0);
  }
});


test('automatic updates wait without downloading, then retry idle and schedule exactly one install', async t => {
  let busy = true; const clock = timers(), f = await fixture(t, { ...repository(), ...clock, isBusy: () => busy });
  await f.manager.configure({ autoUpdate: true }); await f.manager.automaticCycle();
  assert.equal(f.manager.getState().status, 'waitingForIdle'); assert.equal(f.calls.length, 2); assert.equal(f.scheduled.length, 0);
  assert.equal([...clock.active].at(-1).delay, 60000);
  busy = false; await f.manager.automaticCycle();
  assert.equal(f.scheduled.length, 1); assert.equal(f.manager.getState().installScheduled, true);
});


test('automatic checker runs every six hours when no update and recovers from prior unknown busy state', async t => {
  const clock = timers(), f = await fixture(t, { ...clock, isBusy: () => true });
  await f.manager.install(); assert.equal(f.calls.length, 0);
  await f.manager.configure({ autoUpdate: true }); await f.manager.automaticCycle();
  assert.equal(f.manager.getState().status, 'unpublished'); assert.equal(f.calls.length, 1);
  assert.equal([...clock.active].at(-1).delay, 6 * 60 * 60 * 1000);
});


test('disabling auto during download retains package but prevents installer callback', async t => {
  const gate = defer(), started = defer(), r = repository(), clock = timers();
  r.routes.set(ARCHIVE, () => { started.resolve(); return gate.promise; });
  const f = await fixture(t, { ...r, ...clock }); await f.manager.configure({ autoUpdate: true });
  const operation = f.manager.automaticCycle(); await started.promise; await f.manager.configure({ autoUpdate: false }); gate.resolve(reply(ZIP)); await operation;
  assert.equal(f.scheduled.length, 0); assert.equal(f.manager.getState().status, 'prepared'); assert.equal(f.manager.getState().autoUpdate, false); assert.equal(clock.active.size, 0);
});


test('task becoming busy during preparation defers installation without discarding verified package', async t => {
  let polls = 0; const f = await fixture(t, { ...repository(), isBusy: () => ++polls >= 2 });
  assert.equal((await f.manager.install()).status, 'waitingForIdle'); assert.equal(f.scheduled.length, 0); assert.ok(f.manager.prepared);
});


test('a prior auto cycle cannot overwrite the timer after auto is disabled and enabled again', async t => {
  const gate = defer(), started = defer(), r = repository(), clock = timers();
  r.routes.set(ARCHIVE, () => { started.resolve(); return gate.promise; });
  const f = await fixture(t, { ...r, ...clock }); await f.manager.configure({ autoUpdate: true });
  const operation = f.manager.automaticCycle(); await started.promise;
  await f.manager.configure({ autoUpdate: false }); await f.manager.configure({ autoUpdate: true });
  gate.resolve(reply(ZIP)); await operation;
  assert.equal(f.scheduled.length, 0); assert.equal(clock.active.size, 1); assert.equal([...clock.active][0].delay, 0);
});


test('installer failures expose an error and never claim installation completed', async t => {
  const f = await fixture(t, { ...repository(), installPrepared: async () => { throw new Error('file is locked'); } });
  await assert.rejects(f.manager.install(), /locked/); assert.equal(f.manager.getState().status, 'error'); assert.equal(f.manager.getState().installScheduled, false);
  const g = await fixture(t, { ...repository(), installPrepared: async () => ({ scheduled: false }) });
  await assert.rejects(g.manager.install(), /没有确认/); assert.equal(g.manager.getState().status, 'error');
});


test('a delayed installer handoff rejection releases installing state and permits check and retry', async t => {
  const gate = defer(), entered = defer(); let attempts = 0;
  const f = await fixture(t, { ...repository(), installPrepared: async () => {
    attempts++;
    if (attempts === 1) { entered.resolve(); return gate.promise; }
    return { scheduled: true, version: '1.0.1' };
  } });
  const installing = f.manager.install(); await entered.promise;
  assert.equal(f.manager.getState().status, 'installing');
  assert.equal(f.manager.getState().installScheduled, false, 'handoff must succeed before installation is marked scheduled');
  await assert.rejects(f.manager.check(), { status: 409 });
  gate.reject(new Error('任务状态在关闭前发生变化，安装已取消。'));
  await assert.rejects(installing, /安装已取消/);
  const failed = f.manager.getState();
  assert.equal(failed.status, 'error'); assert.equal(failed.installScheduled, false);
  assert.ok(failed.preparedVersion, 'the verified download remains available for retry');
  assert.equal((await f.manager.check()).status, 'prepared', 'failure must not leave the exclusive guard or scheduled guard locked');
  const retried = await f.manager.install();
  assert.equal(retried.installScheduled, true); assert.equal(attempts, 2);
});


test('closing the updater during successful installer handoff never awaits its own pending operation', async t => {
  const f = await fixture(t, repository());
  f.manager.options.installPrepared = async () => {
    await f.manager.close();
    return { scheduled: true, version: '1.0.1' };
  };
  const state = await f.manager.install();
  assert.equal(state.installScheduled, true); assert.equal(f.manager.closed, true);
});


test('public errors remove local installation paths and URL credentials', async t => {
  const f = await fixture(t, repository());
  f.manager.options.installPrepared = async () => { throw new Error(`locked ${f.rootDir}\\.runtime\\updates\\secret.zip; https://user:password@github.com/file?token=private`); };
  await assert.rejects(f.manager.install());
  const error = f.manager.getState().error;
  assert.equal(error.includes(f.rootDir), false); assert.equal(error.includes('password'), false); assert.equal(error.includes('private'), false);
});


test('downloaded manifest and ZIP tampering are detected again before installer is called', async t => {
  for (const target of ['manifest', 'zip']) {
    const f = await fixture(t, repository()); await f.manager.prepare();
    const p = f.manager.prepared;
    if (target === 'manifest') await writeFile(p.manifestPath, JSON.stringify({ ...JSON.parse(await readFile(p.manifestPath, 'utf8')), files: [] }));
    else { const bytes = Buffer.from(ZIP); bytes[5] ^= 1; await writeFile(p.zipPath, bytes); }
    await assert.rejects(f.manager.verifyPrepared(), /变化/);
    f.routes.set(ARCHIVE, () => { throw new Error('cannot re-download'); });
    await assert.rejects(f.manager.install(), /re-download/); assert.equal(f.scheduled.length, 0);
  }
});


test('close aborts in-flight network and subsequent operations fail closed', async t => {
  const started = defer(); const f = await fixture(t, { fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started.resolve(); }) });
  const check = f.manager.check(); await started.promise; await f.manager.close(); await assert.rejects(check, /关闭/);
  await assert.rejects(f.manager.check(), { status: 409 }); assert.equal(f.scheduled.length, 0);
});


test('network timeouts and rate limiting have safe failure states', async t => {
  const clock = timers(), started = defer(); const f = await fixture(t, { ...clock, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started.resolve(); }) });
  const check = f.manager.check(); await started.promise; [...clock.active][0].fn(); await assert.rejects(check, /超时/); assert.equal(f.manager.getState().status, 'error');
  const g = await fixture(t, { routes: new Map([[REPOSITORY_COMMIT_URL, () => reply('', 403)]]) });
  await assert.rejects(g.manager.check(), /请求限制/); assert.equal(g.manager.getState().status, 'error');
});

test('missing profile or mismatch with the running version fails closed without network', async t => {
  const f = await fixture(t);
  await assert.rejects(async () => new UpdateManager({ rootDir: f.rootDir, currentVersion: '9.0.0' }), /版本/);
  for (const patch of [{ repository: 'maxlzyver/codex-mobile' }, { updatePath: 'editions/other' }, { platform: 'other' }, { assetName: 'other.zip' }, { id: 'other' }, { id: '__proto__', platform: undefined, updatePath: 'editions/__proto__', assetName: 'codex-mobile-__proto__-1.0.0-undefined.zip' }, { version: 'v1.0.0' }]) {
    await writeFile(path.join(f.rootDir, 'edition.json'), JSON.stringify({ ...PROFILE, ...patch }));
    assert.throws(() => readEditionProfile(f.rootDir), /edition.json/);
  }
  await rm(path.join(f.rootDir, 'edition.json')); assert.throws(() => readEditionProfile(f.rootDir), /edition.json/);
  assert.equal(f.calls.length, 0);
});

test('missing matching manifest is unpublished and never reads another edition or old Releases', async t => {
  const f = await fixture(t, { routes: new Map([[REPOSITORY_COMMIT_URL, json({ sha: COMMIT })]]) });
  const state = await f.manager.check(); assert.equal(state.status, 'unpublished'); assert.match(state.reason, /不代表/);
  assert.deepEqual(f.calls.map(call => call.url), [REPOSITORY_COMMIT_URL, RAW]);
  assert.equal(state.editionId, PROFILE.id); assert.equal(state.platform, PROFILE.platform);
});

test('every cross-edition or cross-platform manifest is rejected before ZIP fetch', async t => {
  for (const id of ['windows11', 'windows10', 'macos'].filter(id => id !== PROFILE.id)) {
    const f = await fixture(t, repository({ manifest: { edition: id } }));
    await assert.rejects(f.manager.install(), /平台/); assert.equal(f.calls.length, 2); assert.equal(f.scheduled.length, 0);
  }
  const wrongPlatform = await fixture(t, repository({ manifest: { platform: PROFILE.id === 'windows11' ? 'Windows 10 x64' : 'Windows 11 x64' } }));
  await assert.rejects(wrongPlatform.manager.check(), /平台/);
});

test('prepared identity is pinned to this edition, commit, folder and target asset', async t => {
  const f = await fixture(t, repository()); const state = await f.manager.install();
  assert.equal(state.installScheduled, true); assert.equal(f.scheduled.length, 1);
  const p = f.scheduled[0];
  assert.equal(p.source, 'repository'); assert.equal(p.editionId, PROFILE.id); assert.equal(p.sourceCommit, COMMIT);
  assert.equal(p.archivePrefix, 'codex-mobile-editions-' + COMMIT + '/' + PROFILE.updatePath + '/');
  assert.equal(p.assetName, editionAssetName(PROFILE, '1.0.1'));
  assert.equal(p.releaseUrl, 'https://github.com/' + UPDATE_REPOSITORY + '/tree/' + COMMIT);
  assert.equal(p.sha256, digest(ZIP)); assert.equal(p.size, ZIP.length);
  assert.equal(JSON.parse(await readFile(p.manifestPath, 'utf8')).edition, PROFILE.id);
  await assert.rejects(f.manager.check(), { status: 409 }); await assert.rejects(f.manager.prepare(), { status: 409 });
  assert.equal(f.manager.getState().status, 'installing'); await f.manager.install(); assert.equal(f.scheduled.length, 1);
});

test('remote manifest must include the hashed edition.json identity', async t => {
  const r = repository(); r.manifest.files = r.manifest.files.filter(file => file.path !== 'edition.json'); r.routes.set(RAW, json(r.manifest));
  const f = await fixture(t, r); await assert.rejects(f.manager.check(), /edition.json/); assert.equal(f.calls.length, 2);
});

test('URL guard rejects old repo, cross-edition, arbitrary domains and HTTP sources', async t => {
  const f = await fixture(t);
  for (const url of ['https://raw.githubusercontent.com/maxlzyver/codex-mobile/' + COMMIT + '/update.json', 'http://raw.githubusercontent.com/' + UPDATE_REPOSITORY + '/' + COMMIT + '/' + PROFILE.updatePath + '/update.json', 'https://evil.example/update.json', RAW.replace(PROFILE.updatePath, 'editions/other'), RAW + '?token=private', 'https://user:password@raw.githubusercontent.com/' + UPDATE_REPOSITORY + '/' + COMMIT + '/' + PROFILE.updatePath + '/update.json']) assert.throws(() => f.manager.validateUrl(url, { asset: true }));
  assert.equal(f.calls.length, 0);
});

test('hostile redirect and non-ZIP download are rejected without invoking installer', async t => {
  const r = repository(); r.routes.set(ARCHIVE, () => reply('', 302, { location: 'https://evil.example/steal' }));
  const f = await fixture(t, r); await assert.rejects(f.manager.install()); assert.equal(f.calls.some(call => call.url.includes('evil.example')), false); assert.equal(f.scheduled.length, 0);
  const g = await fixture(t, repository({ zip: Buffer.from('version https://git-lfs.github.com/spec/v1') }));
  await assert.rejects(g.manager.install(), /ZIP/); assert.equal(g.scheduled.length, 0);
});

test('a redirect to a different commit is rejected even inside the correct edition folder', async t => {
  const r=repository(); r.routes.set(RAW,()=>reply('',302,{location:RAW.replace(COMMIT,NEXT_COMMIT)}));
  const f=await fixture(t,r); await assert.rejects(f.manager.check(),/其他提交/);
  assert.equal(f.calls.length,2); assert.equal(f.scheduled.length,0);
});
