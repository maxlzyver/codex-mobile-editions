import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildRepairBundle(destination, editions) {
  const target = path.resolve(destination); await mkdir(target, { recursive: true });
  const mac = editions.length === 1 && editions[0] === 'macos';
  for (const name of ['repair-update.mjs', ...(mac ? ['Repair-Update.command'] : ['Repair-Update.cmd', 'Repair-Update.ps1'])]) {
    await cp(path.join(REPO, 'tools/update-repair', name), path.join(target, name)); if (name.endsWith('.command')) await chmod(path.join(target, name), 0o755);
  }
  const manifest = { schema: 1, repository: 'maxlzyver/codex-mobile-editions', editions: {} };
  for (const edition of editions) {
    if (!['windows11', 'windows10', 'macos'].includes(edition)) throw new Error('Unknown edition');
    const names = ['lib/updater.mjs', 'lib/update-installer.mjs', edition === 'macos' ? 'tools/apply-update.mjs' : 'tools/apply-update.ps1'];
    const files = [];
    for (const name of names) {
      const bytes = await readFile(path.join(REPO, 'editions', edition, name)); const to = path.join(target, 'payload', edition, name);
      await mkdir(path.dirname(to), { recursive: true }); await writeFile(to, bytes);
      files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    manifest.editions[edition] = { files };
  }
  await writeFile(path.join(target, 'repair.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(target, 'README.txt'), 'Codex 移动助手旧版更新修复\n适用 V1.0 / V1.0.1 / V1.1.0 完整专用版。\n1. 先完成当前任务，然后退出移动助手：Windows 托盘右键退出；Mac 双击旧目录 Stop.command。无需退出官方 Codex。\n2. 解压本修复包到独立文件夹（不要覆盖旧程序）。\n3. 双击 Repair-Update' + (mac ? '.command' : '.cmd') + '，选择旧程序目录。工具只修复安装器3个文件，并在旧目录 .runtime/updates/repair-* 保存备份。\n4. 工具重启旧程序并请求通过 GitHub 检查和安装新版。若有活动任务，旧程序会暂缓安装；空闲后在设置中点击安装。\n5. 完成后仍从原目录启动。账号、配对、设置、运行环境及项目保留。\n修复不修改旧版号；真正下载、逐文件校验、替换并重启成功后才升级版本。修复包无需 GitHub 登录。\n若程序提示仍在运行，请先正确退出移动助手，不要结束官方 Codex 或其他 Node 进程。\n');
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]; if (!directory) throw new Error('Usage: node tools/build-update-repair.mjs OUTPUT_DIRECTORY [windows|macos]');
  await buildRepairBundle(directory, process.argv[3] === 'macos' ? ['macos'] : ['windows11', 'windows10']);
  console.log('Repair bundle built: ' + path.resolve(directory));
}
