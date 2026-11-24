import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const ownedData = !process.env.YG_TEST_DATA_DIR;
const dataDir = path.resolve(process.env.YG_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'yg-ts-test-')));
process.env.GAME_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'isolated-typescript-tests';
// Load config only after the isolated data directory is selected.
const { createApplication } = await import('../backend/app.ts');
const application = await createApplication();
application.server.listen(Number(process.env.PORT ?? 3139), '127.0.0.1');
await once(application.server, 'listening');
const { port } = application.server.address() as AddressInfo;
process.send?.({ port, dataDir });
console.log(`测试服务 http://127.0.0.1:${port}`);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const closed = application.close();
  // All tests have ended; release the shutdown request's keep-alive connection.
  setImmediate(() => application.server.closeAllConnections());
  await closed;
  if (ownedData) {
    const resolved = fs.realpathSync.native(dataDir);
    const expectedParent = fs.realpathSync.native(os.tmpdir());
    if (path.relative(expectedParent, path.dirname(resolved)) !== '' || !path.basename(resolved).startsWith('yg-ts-test-')) {
      throw new Error('测试目录清理路径校验失败');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  process.exit(0);
}
// A local fixture control route allows Playwright to close SQLite before Windows
// terminates its process tree. This route is never mounted by backend/server.ts.
application.app.post('/__test/shutdown', (_req, res) => {
  res.once('finish', () => { void shutdown(); });
  res.json({ dataDir, ownedData, pid: process.pid });
});
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void shutdown(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown(); });
