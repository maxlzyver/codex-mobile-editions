import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MobilePermissions, MOBILE_PERMISSION_DEFAULTS } from '../lib/permissions.mjs';

async function fixture(t) {
  const work = fileURLToPath(new URL('../../../../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(path.join(work, 'mobile-permissions-test-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(work)); assert.ok(path.basename(directory).startsWith('mobile-permissions-test-')); await rm(directory, { recursive: true, force: true }); });
  return { directory, permissions: new MobilePermissions(directory) };
}

test('mobile permissions default closed, have role-specific management, and owners bypass only mobile gates', async t => {
  const { permissions } = await fixture(t);
  assert.deepEqual(permissions.view('controller'), { ...MOBILE_PERMISSION_DEFAULTS, canManage: false });
  assert.equal(permissions.view('owner').canManage, true);
  for (const key of Object.keys(MOBILE_PERMISSION_DEFAULTS)) {
    assert.throws(() => permissions.require('controller', key), { status: 403 });
    assert.throws(() => permissions.require('pending', key), { status: 401 });
    assert.doesNotThrow(() => permissions.require('owner', key));
  }
  const view = permissions.view('owner'); view.allowOtherFiles = true;
  assert.equal(permissions.view('owner').allowOtherFiles, false);
});

test('known boolean patches persist across restart and invalid patches never partially enable privileges', async t => {
  const { directory, permissions } = await fixture(t);
  permissions.configure({ allowMobileStop: true });
  permissions.configure({ allowOtherFiles: true });
  const saved = await readFile(permissions.file, 'utf8');
  const restarted = new MobilePermissions(directory);
  assert.deepEqual(restarted.view('controller'), { allowMobileApprovals: false, allowMobileStop: true, allowOtherFiles: true, canManage: false });
  for (const invalid of [null, [], true, { allowMobileApprovals: 'true' }, { allowMobileApprovals: true, canManage: true }, { unknown: false }, JSON.parse('{"__proto__":true}')]) {
    assert.throws(() => permissions.configure(invalid), { status: 400 });
    assert.equal(await readFile(permissions.file, 'utf8'), saved);
    assert.equal(permissions.view('owner').allowMobileApprovals, false);
  }
  restarted.configure({ allowOtherFiles: false, allowMobileStop: false });
  assert.deepEqual(new MobilePermissions(directory).state, MOBILE_PERMISSION_DEFAULTS);
});

test('corrupt, unknown, or nonboolean stored settings fail closed', async t => {
  const { directory, permissions } = await fixture(t);
  for (const value of ['{broken', JSON.stringify({ allowMobileStop: true, allowOtherFiles: 'true' }), JSON.stringify({ allowMobileStop: true, canManage: true })]) {
    await writeFile(permissions.file, value);
    assert.deepEqual(new MobilePermissions(directory).state, MOBILE_PERMISSION_DEFAULTS);
  }
});
