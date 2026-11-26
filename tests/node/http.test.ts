import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { AuthResponse, AccountStats } from '../../games/shared/protocol.ts';
import type { StatusResponse, SessionResponse } from '../../games/minesweeper/protocol.ts';
import { FlightClient, startHub } from './helpers.ts';

let hub: Awaited<ReturnType<typeof startHub>>;
test.before(async () => { hub = await startHub(); });
test.after(async () => { await hub.close(); });

function client() {
  let cookie = '';
  return {
    cookie: () => cookie,
    async call<Result>(endpoint: string, body?: unknown, overrideCookie?: string) {
      const res = await fetch(hub.base + endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: overrideCookie ?? cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const value of res.headers.getSetCookie()) {
        const pair = value.split(';')[0];
        const name = pair.split('=')[0];
        const pairs = cookie.split('; ').filter(item => item && !item.startsWith(name + '='));
        cookie = [...pairs, pair].join('; ');
      }
      return { status: res.status, data: await res.json() as Result, res };
    },
  };
}

test('账号 HTTP 与 WS：注册、签名 Cookie、登录退出、错误密码及匿名游戏', async () => {
  const c = client();
  const username = `http_${Date.now().toString(36)}`;
  const password = 'test-password-24';
  assert.equal((await c.call<AuthResponse>('/api/auth/me')).data.user, null);
  assert.equal((await c.call('/api/me/stats')).status, 401);
  const registered = await c.call<AuthResponse>('/api/auth/register', { username, password, nickname: '类型牌友' });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.user?.username, username);
  assert.equal(registered.data.user?.nickname, '类型牌友');
  assert(registered.res.headers.get('set-cookie')?.includes('HttpOnly'));
  assert(c.cookie().startsWith('ac_session='));
  assert.equal(Object.hasOwn(registered.data.user!, 'pass_hash'), false);
  assert.equal((await c.call<AuthResponse>('/api/auth/me')).data.user?.username, username);
  assert.equal((await c.call('/api/auth/register', { username, password })).status, 409);
  assert.equal((await c.call('/api/auth/register', { username: 'weak24', password: '123' })).status, 400);
  assert.equal((await c.call('/api/auth/login', { username, password: 'incorrect' })).status, 401);
  assert.equal((await c.call('/api/auth/login', { username, password })).status, 200);
  const tampered = c.cookie().replace(/.$/, char => char === 'a' ? 'b' : 'a');
  assert.equal((await c.call<AuthResponse>('/api/auth/me', undefined, tampered)).data.user, null);
  const stats = await c.call<{ stats: AccountStats }>('/api/me/stats');
  assert.equal(stats.data.stats.games, 0);

  const logged = await FlightClient.connect(hub.base, 'http_account', c.cookie());
  const anonymous = await FlightClient.connect(hub.base, 'http_guest');
  try {
    logged.send('createRoom', { nickname: '客户端伪造昵称' });
    assert.equal((await logged.wait('roomCreated')).room.players[0].nickname, '类型牌友');
    anonymous.send('createRoom', { nickname: '路人甲' }, true);
    assert.equal((await anonymous.wait('roomCreated')).room.players[0].nickname, '路人甲');
  } finally { logged.close(); anonymous.close(); }
  assert.equal((await c.call('/api/auth/logout', {})).status, 200);
  assert.equal((await c.call<AuthResponse>('/api/auth/me')).data.user, null);
});

test('SQLite 战绩与 HTTP 汇总：飞行棋、农民共同获胜、扫雷最佳用时及账号表兼容', async () => {
  const c = client();
  const user = (await c.call<AuthResponse>('/api/auth/register', {
    username: `stats_${Date.now().toString(36)}`, password: 'stats-password-24', nickname: '战绩号',
  })).data.user;
  assert(user);
  const authUrl = pathToFileURL(path.resolve('backend/auth.ts')).href;
  const script = `
    import assert from 'node:assert/strict';
    import * as auth from ${JSON.stringify(authUrl)};
    auth.init();
    const players = [{userId:${user.id}, playerId:'stats-player', nickname:'战绩号', color:1}, {playerId:'anonymous', color:2}];
    assert(auth.recordMatch({roomCode:'TST9', mode:'classic', players, winnerColor:1, durationMs:123000}));
    assert(auth.recordMatch({roomCode:'TST8', mode:'skill', players, winnerColor:2, durationMs:60000}));
    assert.equal(auth.recordMatch({roomCode:'ANON', players:[{playerId:'anonymous', color:1}], winnerColor:1}), null);
    assert(auth.recordMatch({gameId:'doudizhu', players, winnerColors:[1,2], durationMs:30000}));
    assert(auth.recordMatch({gameId:'minesweeper', mode:'classic:easy', players, winnerColors:[1], durationMs:45000}));
    auth.close();
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GAME_DATA_DIR: hub.dataDir, SESSION_SECRET: 'isolated-typescript-tests' },
  });
  const stats = (await c.call<{ stats: AccountStats }>('/api/me/stats')).data.stats;
  assert.equal(stats.games, 4); assert.equal(stats.wins, 3); assert.equal(stats.winRate, 75);
  assert.equal(stats.recent.filter(match => match.isWinner).length, 3);
  assert.deepEqual(stats.byGame.map(item => item.gameId).sort(), ['doudizhu', 'flight', 'minesweeper']);
  const mines = (await c.call<StatusResponse>('/api/minesweeper/status')).data;
  assert.equal(mines.stats?.bestTimes.classic.easy, 45000);
  const db = new DatabaseSync(path.join(hub.dataDir, 'app.db'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), ['match_players', 'matches', 'users', 'watermelon_results']);
    assert.deepEqual(db.prepare('PRAGMA table_info(users)').all().map(row => row.name), ['id', 'username', 'pass_hash', 'nickname', 'created_at', 'last_login_at']);
  } finally { db.close(); }
});

test('扫雷 HTTP：游客 Cookie、首击保护、幂等操作、陈旧版本同步、刷新续玩', async () => {
  const c = client();
  const initial = await c.call<StatusResponse>('/api/minesweeper/status');
  assert.equal(initial.status, 200); assert.equal(initial.data.session, null);
  assert(c.cookie().includes('yg_mine_guest='));
  let session = (await c.call<SessionResponse>('/api/minesweeper/start', { mode: 'classic', difficulty: 'easy' })).data.session;
  assert.equal(session.state.cells.length, 81);
  assert.equal(session.running, false);
  assert.equal(Object.hasOwn(session.state, 'seed'), false);
  assert.equal(Object.hasOwn(session.state.cells[0], 'mine'), false);
  const action = { sessionId: session.id, revision: session.revision, requestId: 'request-first-reveal', action: { type: 'reveal', index: 40 } };
  const response = await c.call<SessionResponse>('/api/minesweeper/action', action);
  assert.equal(response.status, 200);
  session = response.data.session;
  assert.equal(session.state.status, 'playing'); assert.equal(session.state.cells[40].display, 'revealed');
  assert(session.state.revealedSafe > 0); assert.equal(session.running, true);
  const retry = await c.call<SessionResponse>('/api/minesweeper/action', action);
  assert.equal(retry.data.session.revision, session.revision);
  const stale = await c.call<SessionResponse>('/api/minesweeper/action', { ...action, requestId: 'request-new-stale' });
  assert.equal(stale.status, 409); assert.equal(stale.data.session.id, session.id);
  assert.equal((await c.call<StatusResponse>('/api/minesweeper/status')).data.session?.id, session.id);
});

test('所有构建页面、Hash 静态引用、游戏注册表和旧路径兼容', async () => {
  assert(fs.existsSync('dist/index.html'), '先运行 npm run build');
  const pages = ['/', '/rooms.html', '/games/flight/', '/games/doudizhu/', '/games/minesweeper/',
    '/games/flight/game.html', '/games/flight/spectate.html', '/games/flight/replay.html', '/games/flight/stats.html', '/games/flight/admin.html'];
  const resources = new Set<string>();
  for (const page of pages) {
    const res = await fetch(hub.base + page); assert.equal(res.status, 200, page);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    const html = await res.text();
    assert(!/<script[^>]*src=["'][^"']+\.(?:ts|mjs)["']/.test(html), page);
    for (const [, ref] of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      if (!ref || /^(?:#|data:|https?:|mailto:|javascript:)/.test(ref)) continue;
      const url = new URL(ref, hub.base + page);
      if (url.origin === hub.base) resources.add(url.href);
    }
  }
  for (const resource of resources) {
    const res = await fetch(resource); assert.equal(res.status, 200, resource);
    if (/\/assets\/.*\.(?:js|css)$/.test(resource)) assert.match(res.headers.get('cache-control') || '', /immutable/);
  }
  for (const [from, to] of Object.entries({ '/game': '/games/flight/game.html', '/stats': '/games/flight/stats.html', '/spectate': '/games/flight/spectate.html', '/replay': '/games/flight/replay.html', '/admin': '/games/flight/admin.html', '/flight': '/games/flight/' })) {
    const res = await fetch(hub.base + from + '?room=test', { redirect: 'manual' });
    assert.equal(res.status, 302); assert.equal(res.headers.get('location'), to + '?room=test');
  }
  assert.equal((await fetch(hub.base + '/games/flight/stats')).status, 200);
  const registry = await fetch(hub.base + '/games.json').then(res => res.json()) as { games: { id: string; status: string }[] };
  assert.equal(registry.games.find(game => game.id === 'minesweeper')?.status, 'online');
});
