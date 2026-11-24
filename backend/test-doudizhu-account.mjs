import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('账号战绩：两位农民同时获胜，并兼容飞行棋的单人胜负记录', () => {
  // 复制账号模块到独立临时目录，真实 SQLite 验证不触碰玩家数据库。
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-ddz-account-test-'));
  const authFile = path.join(tempRoot, 'auth.cjs');
  fs.copyFileSync(fileURLToPath(new URL('./auth.cjs', import.meta.url)), authFile);
  try {
    const script = `
      const assert = require('node:assert/strict');
      const { DatabaseSync } = require('node:sqlite');
      const auth = require(${JSON.stringify(authFile)});
      assert.equal(auth.enabled, true);
      const db = new DatabaseSync(${JSON.stringify(path.join(tempRoot, 'data', 'app.db'))});
      const insert = db.prepare('INSERT INTO users (id, username, pass_hash, nickname, created_at) VALUES (?, ?, ?, ?, ?)');
      for (let id = 1; id <= 3; id++) insert.run(id, 'account_' + id, 'unused-test-hash', '牌友' + id, new Date().toISOString());
      const players = [0, 1, 2].map(color => ({ userId: color + 1, color, playerId: 'ddz_test_' + color, nickname: '牌友' + (color + 1) }));
      assert(auth.recordMatch({ gameId: 'doudizhu', roomCode: '123456', players, winnerColors: [1, 2], durationMs: 30000 }));
      assert.equal(auth.statsOf(1).wins, 0);
      assert.equal(auth.statsOf(2).wins, 1);
      assert.equal(auth.statsOf(3).wins, 1);
      assert.equal(auth.statsOf(2).recent[0].gameId, 'doudizhu');
      auth.recordMatch({ gameId: 'flight', roomCode: 'TEST', players, winnerColor: 0, durationMs: 50000 });
      assert.equal(auth.statsOf(1).wins, 1);
      assert.equal(auth.statsOf(2).wins, 1);
      assert.equal(auth.statsOf(3).wins, 1);
      assert.equal(auth.statsOf(1).games, 2);
      db.close();
      console.log('TEAM_STATS_OK');
    `;
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
    assert.match(output, /TEAM_STATS_OK/);
  } finally {
    const resolved = fs.realpathSync(tempRoot);
    const expectedParent = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('yg-ddz-account-test-')) throw new Error('临时目录清理路径校验失败');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
