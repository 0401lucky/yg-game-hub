import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function globalTeardown(): Promise<void> {
  const response = await fetch('http://127.0.0.1:3139/__test/shutdown', {
    method: 'POST', signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  // A startup failure may already have closed the fixture process.
  if (!response) return;
  if (!response.ok) throw new Error(`测试服务清理失败: HTTP ${response.status}`);
  const { dataDir, ownedData, pid } = await response.json() as { dataDir: string; ownedData: boolean; pid: number };
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('测试服务进程信息无效');
  const running = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error; }
  };
  const deadline = Date.now() + 5000;
  while (running() && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  if (running()) throw new Error('测试服务未退出');
  // The existing daily-statistics exit hook may save once more during exit.
  // Remove owned data only after that hook and SQLite have both finished.
  if (ownedData && fs.existsSync(dataDir)) {
    const resolved = fs.realpathSync.native(dataDir);
    if (path.relative(fs.realpathSync.native(os.tmpdir()), path.dirname(resolved)) !== '' || !path.basename(resolved).startsWith('yg-ts-test-')) {
      throw new Error('测试目录清理路径校验失败');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
