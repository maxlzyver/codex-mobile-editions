import path from 'node:path';
import { lstat, open, readFile } from 'node:fs/promises';

async function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('安装入口不能经过符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}

export async function ensurePluginInstallerShortcut(root, platform = process.platform) {
  const directory = path.resolve(root), name = platform === 'darwin' ? 'Install-Plugin.command' : 'Install-Plugin.cmd';
  const source = path.join(directory, 'tools', name), target = path.join(directory, name);
  await noLinks(directory);
  try { await lstat(target); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await noLinks(source);
  const content = await readFile(source);
  let handle;
  try { handle = await open(target, 'wx', platform === 'darwin' ? 0o755 : 0o644); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { await handle.writeFile(content); if (platform === 'darwin') await handle.chmod(0o755); }
  finally { await handle.close(); }
  return true;
}
