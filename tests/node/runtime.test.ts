import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { removeTestDirectory } from './helpers.ts';

test('生产运行目录：仅 backend、dist 和收集的游戏源码，无 web 源码也可启动并使用运营接口', async t => {
  const project = path.resolve(import.meta.dirname, '../..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-ts-test-'));
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
      const killer = setTimeout(() => child?.kill(), 5000);
      await exited; clearTimeout(killer);
    }
    removeTestDirectory(directory);
  });
  execFileSync(process.execPath, ['tools/copy-runtime.ts'], { cwd: project, windowsHide: true, stdio: 'pipe' });
  fs.mkdirSync(path.join(directory, 'backend'));
  for (const entry of fs.readdirSync(path.join(project, 'backend'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) fs.copyFileSync(path.join(project, 'backend', entry.name), path.join(directory, 'backend', entry.name));
  }
  fs.cpSync(path.join(project, 'runtime-games'), path.join(directory, 'games'), { recursive: true });
  fs.cpSync(path.join(project, 'dist'), path.join(directory, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(project, 'package.json'), path.join(directory, 'package.json'));
  fs.symlinkSync(path.join(project, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.existsSync(path.join(directory, 'web')), false);
  fs.writeFileSync(path.join(directory, 'serve.ts'), `
    import { once } from 'node:events';
    import { createApplication } from './backend/app.ts';
    const application = await createApplication();
    application.server.listen(0, '127.0.0.1');
    await once(application.server, 'listening');
    process.send?.({ port: application.server.address().port });
    process.on('message', async message => {
      if (message?.type !== 'shutdown') return;
      const closing = application.close();
      setImmediate(() => application.server.closeAllConnections());
      await closing; process.exit(0);
    });
  `);
  child = fork(path.join(directory, 'serve.ts'), [], { execPath: process.execPath, cwd: directory,
    env: { ...process.env, GAME_DATA_DIR: path.join(directory, 'data'), SESSION_SECRET: 'runtime-test-session-secret', ADMIN_KEY: 'runtime-test-admin-key', COOKIE_SECURE: '0', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let logs = '';
  child.stdout?.on('data', chunk => { logs = (logs + String(chunk)).slice(-10000); });
  child.stderr?.on('data', chunk => { logs = (logs + String(chunk)).slice(-10000); });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`生产目录启动超时\n${logs}`)), 15000);
    child!.on('message', message => {
      if (message && typeof message === 'object' && 'port' in message && typeof message.port === 'number') { clearTimeout(timeout); resolve(message.port); }
    });
    child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`生产目录启动失败 ${code}\n${logs}`)); });
    child!.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  for (const route of ['/', '/rooms.html', '/admin', '/api/hub/rooms', '/games/watermelon/', '/games/watermelon/assets/fruits/watermelon.webp', '/api/watermelon/status']) assert.equal((await fetch(base + route)).status, 200, route);
  const status = await fetch(base + '/api/hub/status').then(response => response.json()) as { games: { id: string }[] };
  assert.deepEqual(status.games.map(game => game.id).sort(), ['doudizhu', 'flight', 'minesweeper', 'watermelon']);
  assert.equal((await fetch(base + '/api/admin/overview')).status, 401);
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'runtime-test-admin-key' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { Cookie: cookie } })).status, 200);
});
