import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { repairInstallation } from './update-repair/repair-update.mjs';
import { buildRepairBundle } from './build-update-repair.mjs';

const WORK = path.resolve(process.env.CODEX_UPDATE_E2E_OUTPUT || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../v120-upgrade-verification'));
const sha = value => createHash('sha256').update(value).digest('hex');
const write = async (filename, bytes) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); };
async function fixture(t, version = '1.0.1', edition = 'windows11') {
  await mkdir(WORK, { recursive: true }); const scratch = await mkdtemp(path.join(WORK, 'repair-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(scratch)), WORK); assert(path.basename(scratch).startsWith('repair-test-')); await rm(scratch, { recursive: true, force: true }); });
  const root = path.join(scratch, 'old 中文'), bundleDir = await buildRepairBundle(path.join(scratch, 'bundle'), [edition]);
  const profile = { id: edition, platform: edition === 'macos' ? 'macOS universal' : edition === 'windows11' ? 'Windows 11 x64' : 'Windows 10 x64', version, repository: 'maxlzyver/codex-mobile-editions', updatePath: 'editions/' + edition, assetName: `codex-mobile-${edition}-${version}-${edition === 'macos' ? 'universal' : 'x64'}.zip` };
  const originals = { 'edition.json': JSON.stringify(profile), 'package.json': JSON.stringify({ name: 'codex-mobile-console', version }), 'lib/updater.mjs': 'old updater', 'lib/update-installer.mjs': 'old installer', [edition === 'macos' ? 'tools/apply-update.mjs' : 'tools/apply-update.ps1']: 'old helper', '.runtime/devices.json': 'paired phone', '.runtime/mobile-permissions.json': 'private permissions', 'runtime/node.exe': 'existing runtime', 'workspace/user.txt': 'user project' };
  for (const [name, bytes] of Object.entries(originals)) await write(path.join(root, name), bytes);
  return { root, bundleDir, originals, profile };
}
test('repair all three legacy versions and editions without changing identity, runtime or personal data', async t => {
  for (const edition of ['windows11', 'windows10', 'macos']) for (const version of ['1.0.0', '1.0.1', '1.1.0']) {
    const f = await fixture(t, version, edition), result = await repairInstallation(f.root, f);
    assert.equal(result.repaired, true); assert.equal(result.edition.version, version);
    const manifest = JSON.parse(await readFile(path.join(f.bundleDir, 'repair.json'), 'utf8'));
    for (const file of manifest.editions[edition].files) {
      assert.equal(sha(await readFile(path.join(f.root, file.path))), file.sha256);
      assert.equal(await readFile(path.join(result.backup, file.path), 'utf8'), f.originals[file.path]);
    }
    for (const [name, bytes] of Object.entries(f.originals).filter(([name]) => !name.startsWith('lib/') && !name.startsWith('tools/'))) assert.equal(await readFile(path.join(f.root, name), 'utf8'), bytes);
  }
});
test('repair refuses live services and never terminates their process', async t => {
  const f = await fixture(t); await write(path.join(f.root, '.runtime/server.json'), JSON.stringify({ pid: process.pid, root: f.root }));
  await assert.rejects(repairInstallation(f.root, f), /请先退出/); process.kill(process.pid, 0);
  for (const [name, bytes] of Object.entries(f.originals)) assert.equal(await readFile(path.join(f.root, name), 'utf8'), bytes);
});
test('tampered payload fails before any installed file is changed', async t => {
  const f = await fixture(t); await write(path.join(f.bundleDir, 'payload/windows11/lib/updater.mjs'), 'tampered');
  await assert.rejects(repairInstallation(f.root, f), /校验失败/);
  for (const [name, bytes] of Object.entries(f.originals)) assert.equal(await readFile(path.join(f.root, name), 'utf8'), bytes);
});
test('mismatched edition, missing payload and invalid process records fail closed', async t => {
  const f = await fixture(t); await write(path.join(f.root, 'edition.json'), JSON.stringify({ ...f.profile, platform: 'macOS universal' }));
  await assert.rejects(repairInstallation(f.root, f), /官方/);
  await write(path.join(f.root, 'edition.json'), f.originals['edition.json']);
  await write(path.join(f.root, '.runtime/server.json'), JSON.stringify({ pid: -1 }));
  await assert.rejects(repairInstallation(f.root, f), /进程记录无效/);
  await rm(path.join(f.root, '.runtime/server.json')); await rm(path.join(f.bundleDir, 'payload/windows11/lib/updater.mjs'));
  await assert.rejects(repairInstallation(f.root, f), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.root, 'lib/updater.mjs'), 'utf8'), 'old updater');
});
