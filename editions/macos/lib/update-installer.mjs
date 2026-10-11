import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessError } from './security.mjs';
import { delay, fileHash, noLinks, prepareUpdate, signalApplyReady, validatePreparedUpdate, validateUpdatePath } from '../tools/apply-update.mjs';
export { validatePreparedUpdate, validateUpdatePath };

/** Resolves only when the independent helper has accepted a completed shutdown. */
export function createInstaller({ rootDir, runtimeDir, isBusy = () => false, onBeforeInstall,
  spawnProcess = spawn, handshakeTimeoutMs = 30000, beforeShutdownDelayMs = 300,
}) {
  const root = path.resolve(rootDir), runtime = path.resolve(runtimeDir);
  let pending = false;
  return async function installPrepared(prepared) {
    if (pending || await isBusy()) throw new AccessError(409, '任务或更新仍在运行，请稍后重试。');
    if (typeof onBeforeInstall !== 'function') throw new Error('没有配置安全关闭回调。');
    pending = true; let job;
    try {
      await validatePreparedUpdate(prepared, { rootDir: root, runtimeDir: runtime });
      const state = JSON.parse(await readFile(path.join(runtime, 'server.json'), 'utf8'));
      const server = JSON.parse(await readFile(path.join(runtime, 'mac-process.json'), 'utf8'));
      if (state.pid !== process.pid || state.root !== root || server.pid !== process.pid || server.root !== root) throw new Error('无法验证当前 macOS 控制台进程。请从 Start.command 启动。');
      job = path.join(runtime, 'updates', `install-${prepared.version}-${randomBytes(6).toString('hex')}`);
      await noLinks(job); await mkdir(job, { recursive: true, mode: 0o700 });
      const helper = path.join(job, 'apply-update.mjs'), node = path.join(job, 'node');
      await copyFile(path.join(root, 'tools/apply-update.mjs'), helper);
      const bundledNode = path.join(root, 'runtime', `darwin-${process.arch}`, 'bin/node');
      await noLinks(bundledNode); await copyFile(bundledNode, node); await chmod(node, 0o700);
      if (await fileHash(node) !== await fileHash(bundledNode) || await fileHash(helper) !== await fileHash(path.join(root, 'tools/apply-update.mjs'))) throw new Error('独立更新助手复制校验失败。');
      const plan = { schema: 1, rootDir: root, runtimeDir: runtime, jobDir: job,
        ...Object.fromEntries(['version','zipPath','sha256','size','manifestPath','manifestSha256','releaseUrl','assetName','source','sourceCommit','archivePrefix','editionId'].map(key => [key, prepared[key]])),
        server, restartPort: state.port, testMode: false,
      };
      await prepareUpdate(plan);
      plan.inventorySha256 = await fileHash(path.join(job, 'inventory.json'));
      const planPath = path.join(job, 'plan.json');
      await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
      if (await isBusy()) throw new AccessError(409, '校验期间有任务开始执行，更新已取消。');
      const child = spawnProcess(node, [helper, planPath, await fileHash(planPath)], { detached: true, stdio: 'ignore', cwd: job, env: { ...process.env } });
      let failed = null;
      child.once('exit', code => { failed = new Error(`更新助手在接管前退出（${code}）。`); });
      child.once('error', error => { failed = error; });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      const statusPath = path.join(job, 'status.json'), deadline = Date.now() + handshakeTimeoutMs;
      let waiting = false;
      while (Date.now() < deadline) {
        if (failed) throw failed;
        let status;
        try { status = JSON.parse(await readFile(statusPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (failed) throw failed;
        if (['error','rolled-back','rollback-failed'].includes(status?.status)) throw new Error(`更新助手验证失败：${status.message}`);
        if (status?.version === prepared.version && status.status === 'waiting') { waiting = true; break; }
        await delay(100);
      }
      if (!waiting) throw new Error('更新助手握手超时，服务保持运行。');
      await delay(beforeShutdownDelayMs);
      if (failed) throw failed;
      if (await isBusy()) throw new AccessError(409, '仍有任务运行，安装已取消。');
      if (failed) throw failed;
      await onBeforeInstall();
      if (failed) throw failed;
      await signalApplyReady(job);
      return { scheduled: true, version: prepared.version, statusPath };
    } catch (error) {
      pending = false;
      if (job) await writeFile(path.join(job, 'cancel.json'), JSON.stringify({ cancelled: true }), { mode: 0o600 }).catch(() => {});
      throw error;
    }
  };
}
