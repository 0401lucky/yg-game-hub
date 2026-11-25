import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import WebSocket from 'ws';
import { mountAdminAuth } from '../../backend/adminAuth.ts';
import type { AdminOverview, AdminSession, HubRoomsResponse, HubStatus } from '../../web/operationsProtocol.ts';
import type { SessionResponse } from '../../games/minesweeper/types.ts';
import { CardClient, FlightClient, startHub, waitUntil } from './helpers.ts';

const KEY = 'isolated-admin-key-24';
let hub: Awaited<ReturnType<typeof startHub>>;
test.before(async () => { hub = await startHub(); });
test.after(async () => { await hub.close(); });

async function call<Result>(base: string, endpoint: string, body?: unknown, cookie = '', extraHeaders: Record<string, string> = {}) {
  const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, status: response.status, data: await response.json() as Result };
}
function cookieOf(response: Response): string { return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; '); }

test('管理密钥：保护新旧接口、独立于玩家账号、拒绝伪造会话、退出撤销会话、阻止跨站写入', async () => {
  const session = await call<AdminSession>(hub.base, '/api/admin/session');
  assert.deepEqual(session.data, { configured: true, authenticated: false, expiresAt: null });
  const protectedReads = ['/api/admin/overview', '/api/rooms', '/api/stats', '/api/sessions', '/api/online-users', '/api/daily-stats', '/api/daily-history'];
  for (const endpoint of protectedReads) {
    const result = await call(hub.base, endpoint);
    assert.equal(result.status, 401, endpoint); assert.match(result.response.headers.get('cache-control') || '', /no-store/);
  }
  for (const endpoint of ['/api/cleanup', '/api/admin/cleanup']) assert.equal((await call(hub.base, endpoint, {})).status, 401);
  const player = await call(hub.base, '/api/auth/register', { username: 'ordinary_operator_test', nickname: '普通玩家', password: 'players-cannot-admin' });
  assert.equal(player.status, 200);
  assert.equal((await call(hub.base, '/api/admin/overview', undefined, cookieOf(player.response))).status, 401);
  assert.equal((await call(hub.base, '/api/admin/login', { key: 'incorrect' })).status, 401);
  assert.equal((await call(hub.base, '/api/admin/login', { key: { toString: KEY } })).status, 401);
  assert.equal((await call(hub.base, '/api/admin/login', { key: KEY }, '', { Origin: 'https://foreign.example' })).status, 403);
  const login = await call<AdminSession>(hub.base, '/api/admin/login', { key: KEY });
  assert.equal(login.status, 200); assert(login.data.authenticated);
  const setCookie = login.response.headers.get('set-cookie')!;
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Path=\/api/); assert.match(setCookie, /Max-Age=28800/);
  assert(!setCookie.includes(KEY));
  const cookie = cookieOf(login.response);
  const tampered = cookie.replace(/.$/, char => char === 'a' ? 'b' : 'a');
  assert.equal((await call(hub.base, '/api/admin/overview', undefined, tampered)).status, 401);
  for (const endpoint of protectedReads) assert.equal((await call(hub.base, endpoint, undefined, cookie)).status, 200, endpoint);
  for (const endpoint of ['/api/cleanup', '/api/admin/cleanup', '/api/admin/logout']) {
    assert.equal((await call(hub.base, endpoint, {}, cookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, endpoint);
  }
  assert.equal((await call<AdminSession>(hub.base, '/api/admin/session', undefined, cookie)).data.authenticated, true);
  const oneDay = await call<{ days: unknown[] }>(hub.base, '/api/daily-history?days=1', undefined, cookie);
  assert.equal(oneDay.data.days.length, 1);
  assert.equal((await call(hub.base, '/api/admin/logout', {}, cookie)).status, 200);
  assert.equal((await call(hub.base, '/api/admin/overview', undefined, cookie)).status, 401);
  assert.equal((await call<AdminSession>(hub.base, '/api/admin/session', undefined, cookie)).data.authenticated, false);
  assert.equal((await call(hub.base, '/api/replays')).status, 200);
});

test('公开房间与运营汇总：多游戏、私密房间隔离、无内部状态、全游戏日统计与安全清理', async () => {
  const login = await call<AdminSession>(hub.base, '/api/admin/login', { key: KEY });
  const cookie = cookieOf(login.response);
  const before = (await call<AdminOverview>(hub.base, '/api/admin/overview', undefined, cookie)).data;
  const host = await FlightClient.connect(hub.base);
  const privateHost = await FlightClient.connect(hub.base);
  const socket = new WebSocket(hub.base.replace(/^http/, 'ws') + '/ws/doudizhu');
  const opened = once(socket, 'open');
  const cards = new CardClient(socket);
  try {
    host.send('createRoom', { nickname: '公开房主' });
    const publicRoom = (await host.wait('roomCreated')).room;
    privateHost.send('createRoom', { nickname: '私密房主' });
    const privateRoom = (await privateHost.wait('roomCreated')).room;
    privateHost.send('update_room_privacy', { isPrivate: true }); await privateHost.wait('roomPrivacyUpdated', message => message.isPrivate);
    await opened; cards.send('hello', { nickname: '测试牌友' }); await waitUntil(() => cards.token);
    cards.send('create', { nickname: '测试牌友' }); await waitUntil(() => cards.state?.room);
    const cardCode = cards.state!.room.code;
    const publicData = await call<HubRoomsResponse>(hub.base, '/api/hub/rooms');
    assert.equal(publicData.status, 200);
    assert(publicData.data.rooms.some(room => room.code === publicRoom.code && room.gameId === 'flight'));
    assert(publicData.data.rooms.some(room => room.code === cardCode && room.gameId === 'doudizhu'));
    assert(!publicData.data.rooms.some(room => room.code === privateRoom.code));
    const publicJson = JSON.stringify(publicData.data);
    for (const secret of [privateRoom.code, host.playerId, cards.token!, 'roomChatHistory', 'gameData', 'seed', 'hands']) assert(!publicJson.includes(String(secret)), String(secret));
    assert.equal(publicData.data.rooms.find(room => room.code === publicRoom.code)?.joinUrl, `/games/flight/?room=${publicRoom.code}`);
    assert.equal(publicData.data.rooms.find(room => room.code === cardCode)?.joinUrl, `/games/doudizhu/?room=${cardCode}`);
    cards.send('start'); await waitUntil(() => cards.state?.game);
    const mineStatus = await call(hub.base, '/api/minesweeper/status');
    const mineCookie = cookieOf(mineStatus.response);
    const mine = (await call<SessionResponse>(hub.base, '/api/minesweeper/start', { difficulty: 'easy' }, mineCookie)).data.session;
    const action = { sessionId: mine.id, revision: mine.revision, requestId: 'ops-first-reveal', action: { type: 'reveal', index: 40 } };
    assert.equal((await call(hub.base, '/api/minesweeper/action', action, mineCookie)).status, 200);
    assert.equal((await call(hub.base, '/api/minesweeper/action', action, mineCookie)).status, 200);
    const overview = (await call<AdminOverview>(hub.base, '/api/admin/overview', undefined, cookie)).data;
    assert.deepEqual(overview.games.map(game => game.id).sort(), ['doudizhu', 'flight', 'minesweeper']);
    assert(overview.rooms.some(room => room.code === privateRoom.code && room.isPrivate));
    assert.equal(overview.daily.gamesPlayed, before.daily.gamesPlayed + 2);
    assert(overview.daily.uniquePlayers >= 4); assert(overview.daily.peakOnline >= 3);
    assert.equal(overview.games.find(game => game.id === 'minesweeper')?.savedSessions, 1);
    assert.equal(overview.history.length, 7);
    for (let index = 1; index < overview.history.length; index++) assert(overview.history[index].date < overview.history[index - 1].date);
    const summary = (await call<HubStatus>(hub.base, '/api/hub/status')).data;
    assert.equal(summary.totals.rooms, overview.totals.rooms); assert.equal(summary.totals.onlinePlayers, 3);
    assert(!JSON.stringify(summary).includes(privateRoom.code));
    const startedRooms = (await call<HubRoomsResponse>(hub.base, '/api/hub/rooms')).data.rooms;
    assert.equal(startedRooms.find(room => room.code === cardCode)?.joinUrl, null);
    assert.equal((await call(hub.base, '/api/admin/cleanup', {}, cookie)).status, 200);
    const after = (await call<AdminOverview>(hub.base, '/api/admin/overview', undefined, cookie)).data;
    for (const code of [publicRoom.code, privateRoom.code, cardCode]) assert(after.rooms.some(room => room.code === code), code);
  } finally { host.close(); privateHost.close(); socket.terminate(); }
});

async function isolatedAuth(t: TestContext, key: string): Promise<string> {
  const oldKey = process.env.ADMIN_KEY; const oldSecure = process.env.COOKIE_SECURE;
  process.env.ADMIN_KEY = key; process.env.COOKIE_SECURE = '0';
  const app = express(); app.use(express.json()); mountAdminAuth(app);
  app.get('/api/admin/overview', (_req, res) => { res.json({ protected: true }); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = oldKey;
    if (oldSecure === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = oldSecure;
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('未配置管理密钥时保持关闭，不接受空密钥', async t => {
  const base = await isolatedAuth(t, '');
  assert.deepEqual((await call<AdminSession>(base, '/api/admin/session')).data, { configured: false, authenticated: false, expiresAt: null });
  assert.equal((await call(base, '/api/admin/login', { key: '' })).status, 503);
  for (const endpoint of ['/api/admin/overview', '/api/rooms', '/api/stats']) assert.equal((await call(base, endpoint)).status, 503);
});

test('管理会话八小时过期；输错限流到期可恢复，其他客户端不受影响', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const base = await isolatedAuth(t, KEY);
  const login = await call<AdminSession>(base, '/api/admin/login', { key: KEY }); const cookie = cookieOf(login.response);
  assert.equal(login.data.expiresAt, now + 8 * 60 * 60 * 1000);
  now += 8 * 60 * 60 * 1000 + 1;
  assert.equal((await call(base, '/api/admin/overview', undefined, cookie)).status, 401);
  assert.equal((await call<AdminSession>(base, '/api/admin/session', undefined, cookie)).data.authenticated, false);
  const headers = { 'CF-Connecting-IP': 'rate-limit-test' };
  for (let index = 0; index < 5; index++) assert.equal((await call(base, '/api/admin/login', { key: 'wrong' }, '', headers)).status, 401);
  const limited = await call(base, '/api/admin/login', { key: KEY }, '', headers);
  assert.equal(limited.status, 429); assert.equal(limited.response.headers.get('retry-after'), '60');
  assert.equal((await call(base, '/api/admin/login', { key: KEY }, '', { 'CF-Connecting-IP': 'another-client' })).status, 200);
  now += 60001;
  assert.equal((await call(base, '/api/admin/login', { key: KEY }, '', headers)).status, 200);
});
