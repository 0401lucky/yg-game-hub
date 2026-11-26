import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../../games/watermelon/engine.ts';
import { LIMITS, WatermelonService, WatermelonError } from '../../games/watermelon/server/service.ts';
import { ApiError, ChallengeSession } from '../../games/watermelon/session.ts';
import type { Recovery } from '../../games/watermelon/session.ts';
import type { WatermelonActiveSession, WatermelonAccountRecord, WatermelonDrop, WatermelonSegment, WatermelonSessionResponse, WatermelonStatus } from '../../games/watermelon/protocol.ts';
import type { AccountStats } from '../../games/shared/protocol.ts';
import { startHub } from './helpers.ts';

function segment(session: WatermelonActiveSession, toTick: number, drops: WatermelonDrop[] = [], id = crypto.randomUUID()): WatermelonSegment {
  return { request_id: id, session_id: session.session_id, base_tick: session.base_tick, base_moves: session.base_moves, to_tick: toTick, drops, paused: true };
}
const errorStatus = (status: number) => (error: unknown) => error instanceof WatermelonError && error.status === status;

test('西瓜迁移：每级真实接触合成、边界、暂停与分段重放一致', () => {
  for (let level = 0; level < engine.LEVELS.length - 1; level++) {
    const game = engine.createGame({ seed: 'migration-merge' }); engine.start(game);
    game.world = engine.createWorld({ left: -10, right: 600, bottom: 800 });
    game.world.bodies = [engine.createFruit(1, level, 140, 350), engine.createFruit(2, level, 140 + engine.LEVELS[level].radius * 2 - 1, 350)];
    game.world.bodies.forEach(body => { body.age = 1; }); game.nextId = 3;
    engine.tick(game);
    assert.equal(game.world.bodies.length, 1); assert.equal(game.world.bodies[0].level, level + 1);
    assert.equal(game.score, engine.LEVELS[level + 1].points);
    assert(game.world.bodies[0].nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
    engine.pause(game); const frozen = engine.snapshot(game); engine.step(game, 10); assert.deepEqual(engine.snapshot(game), frozen);
  }
  const initial = engine.initial('migration-replay');
  const drops = [{ tick: 0, x: 0 }, { tick: 70, x: 360 }, { tick: 140, x: 180 }];
  const direct = engine.replay('migration-replay', initial, 239, drops);
  const first = engine.replay('migration-replay', initial, 120, drops.slice(0, 2));
  assert.deepEqual(engine.replay('migration-replay', first, 239, drops.slice(2)), direct);
  assert.equal(initial.drops, 0); assert(engine.validSnapshot(direct));
  for (const body of engine.restore('migration-replay', direct).world.bodies) {
    assert(body.bounds.left >= 28 && body.bounds.right <= 332 && body.bounds.bottom <= 518);
  }
});

test('西瓜服务器：拒绝伪造和旧进度，重试幂等，保护其他玩家与正在进行的局', () => {
  const service = new WatermelonService({ now: () => 0, seedFactory: () => 'service-replay' });
  const opened = service.start('guest:first', null, { request_id: 'start-first-01' }).session;
  const packet = segment(opened, 180, [{ tick: 0, x: 180 }, { tick: 70, x: 180 }, { tick: 140, x: 180 }]);
  opened.state.score = 999999;
  assert.throws(() => service.checkpoint('guest:other', packet), errorStatus(404));
  assert.throws(() => service.checkpoint('guest:first', { ...packet, to_tick: LIMITS.max_segment_ticks + 1 }), errorStatus(400));
  assert.throws(() => service.checkpoint('guest:first', { ...packet, drops: [{ tick: 0, x: -1 }] }), errorStatus(400));
  const accepted = service.checkpoint('guest:first', { ...packet, score: 999999, highest: 8 }).session;
  const expected = engine.replay(opened.seed, engine.initial(opened.seed), 180, packet.drops);
  assert.deepEqual(accepted.state, expected);
  assert.deepEqual(service.checkpoint('guest:first', packet).session, accepted);
  assert.throws(() => service.checkpoint('guest:first', { ...packet, drops: [] }), errorStatus(400));
  assert.throws(() => service.checkpoint('guest:first', { ...packet, request_id: 'different-request' }), errorStatus(409));
  assert.throws(() => service.start('guest:first', null, { request_id: 'start-second-02' }), errorStatus(409));
  const finish = segment(accepted, accepted.base_tick);
  const result = service.checkpoint('guest:first', { ...finish, score: 123456 }, true).session.result;
  assert(result); assert.equal(result.score, expected.score); assert.equal(result.moves, expected.drops); assert.equal(result.recorded, false);
  assert.deepEqual(service.checkpoint('guest:first', finish, true).session.result, result);
  const next = service.start('guest:first', null, { request_id: 'start-second-02', replace_session_id: accepted.session_id }).session;
  assert.notEqual(next.session_id, accepted.session_id);
  assert.equal(service.start('guest:first', null, { request_id: 'start-second-02' }).session.session_id, next.session_id);
});

test('西瓜登录接管：游客未完成进度转给账号，只记录服务端成绩且只记录一次', () => {
  const records: WatermelonAccountRecord[] = [];
  const service = new WatermelonService({ seedFactory: () => 'account-adoption', auth: {
    recordWatermelonMatch(record) { records.push(record); return 1; },
    watermelonStatsOf() { return { games: records.length, wins: 0, bestScore: records[0]?.score ?? 0, highest: records[0]?.highest ?? -1, recent: [] }; },
  } });
  let active = service.start('guest:adopt', null, { request_id: 'adopt-start-01' }).session;
  active = service.checkpoint('guest:adopt', segment(active, 160, [{ tick: 0, x: 160 }, { tick: 70, x: 160 }])).session;
  const status = service.status('user:7', { id: 7, nickname: '果园玩家' }, 'guest:adopt');
  assert.equal(status.active_session?.session_id, active.session_id); assert.equal(service.sessions.has('guest:adopt'), false);
  const packet = segment(active, active.base_tick), result = service.checkpoint('user:7', packet, true).session.result;
  assert(result?.recorded); assert.equal(result.accountId, 7);
  service.checkpoint('user:7', { ...packet, request_id: 'finish-again-01' }, true);
  assert.equal(records.length, 1); assert.equal(records[0].moves, 2); assert.equal(records[0].score, active.state.score);
  const guestNext = service.start('guest:returning', null, { request_id: 'returning-start' }).session;
  assert.equal(service.status('user:7', { id: 7 }, 'guest:returning').active_session?.session_id, guestNext.session_id,
    '账号上一局已经结束时，仍能接管新的游客进度');
  service.start('guest:other', null, { request_id: 'other-guest-start' });
  assert.equal(service.status('user:7', { id: 7 }, 'guest:other').active_session?.session_id, guestNext.session_id,
    '账号存在未完成挑战时，保留账号那一局');
});

test('西瓜客户端：服务器已接受但回包丢失时，不重复投放或重复结算', async () => {
  const service = new WatermelonService({ seedFactory: () => 'lost-response' });
  const active = service.start('guest:lost', null, { request_id: 'lost-start-01' }).session;
  let lost = true, checkpoints = 0;
  const client = new ChallengeSession(active, 'test-lost', null, async (path, body) => {
    const response = service.checkpoint('guest:lost', body, path === 'finish');
    if (path === 'checkpoint') { checkpoints++; if (lost) { lost = false; throw new ApiError(0, 'lost reply'); } }
    return response;
  });
  client.drop({ tick: 0, x: 180 }, 1); client.observe(180, true);
  await assert.rejects(client.sync(), /lost reply/);
  assert.equal(service.status('guest:lost').active_session?.base_moves, 1);
  await client.sync(); assert.equal(client.active.base_moves, 1); assert.equal(checkpoints, 2);
  const response = await client.finish(); assert.equal(response.session.result?.moves, 1);
  assert.deepEqual((await client.finish()).session.result, response.session.result);
});

test('西瓜结算：等待已在途的同步后，仍会提交最后的投放与最终 tick', async () => {
  const service = new WatermelonService({ seedFactory: () => 'inflight-finish' });
  const active = service.start('guest:inflight', null, { request_id: 'inflight-start' }).session;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let first = true;
  const client = new ChallengeSession(active, 'test-inflight', null, async (path, body) => {
    if (path === 'checkpoint' && first) { first = false; await gate; }
    return service.checkpoint('guest:inflight', body, path === 'finish');
  });
  client.drop({ tick: 0, x: 180 }, 1); client.observe(80, false);
  const syncing = client.sync();
  client.drop({ tick: 140, x: 180 }, 2); client.observe(200, true);
  const finishing = client.finish(); release(); await syncing;
  const result = (await finishing).session.result;
  assert(result); assert.equal(result.moves, 2); assert.equal(result.durationMs, Math.round(200 / 120 * 1000));
});

test('西瓜刷新恢复：剔除已入库的边界投放，保留还没同步的后半局', async () => {
  let now = 0;
  const service = new WatermelonService({ now: () => now, seedFactory: () => 'refresh-boundary' });
  const active = service.start('guest:refresh', null, { request_id: 'refresh-start' }).session;
  const drops = [0, 80, 160, 240, 320, 400].map(tick => ({ tick, x: 180 }));
  now = 10000;
  const accepted = service.checkpoint('guest:refresh', segment(active, 240, drops.slice(0, 4))).session;
  const saved: Recovery = { version: 1, session: active, drops, toTick: 480, paused: true };
  const client = new ChallengeSession(accepted, 'test-refresh', saved, async (path, body) => service.checkpoint('guest:refresh', body, path === 'finish'));
  assert.deepEqual(client.init.drops, drops.slice(4)); assert.equal(client.init.to_tick, 480);
  const restored = engine.replay(accepted.seed, accepted.state, 480, client.init.drops);
  await client.sync(); assert.deepEqual(client.active.state, restored); assert.equal(client.active.base_moves, 6);
});

test('西瓜 HTTP 与 SQLite：共享账号、同源保护、真实分数、重复结算和个人战绩', async t => {
  const hub = await startHub(); t.after(() => hub.close());
  async function call<T>(path: string, body?: unknown, cookie = '', extra: Record<string, string> = {}) {
    const response = await fetch(hub.base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as T, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  const guest = await call<WatermelonStatus>('/api/watermelon/status'); assert.equal(guest.status, 200);
  const started = await call<WatermelonSessionResponse>('/api/watermelon/start', { request_id: 'http-start-001' }, guest.cookie);
  assert.equal(started.status, 200);
  const registered = await call<{ user: { id: number } }>('/api/auth/register', { username: 'melon_http_test', password: 'watermelon-tests-password', nickname: '西瓜玩家' });
  assert.equal(registered.status, 200);
  const cookie = `${guest.cookie}; ${registered.cookie}`;
  const adopted = await call<WatermelonStatus>('/api/watermelon/status', undefined, cookie);
  assert.equal(adopted.data.active_session?.session_id, started.data.session.session_id);
  const packet = segment(started.data.session, 180, [{ tick: 0, x: 180 }, { tick: 70, x: 180 }, { tick: 140, x: 180 }]);
  assert.equal((await call('/api/watermelon/checkpoint', packet, cookie, { Origin: 'https://foreign.example' })).status, 403);
  const checkpoint = await call<WatermelonSessionResponse>('/api/watermelon/checkpoint', { ...packet, score: 999999 }, cookie);
  assert.equal(checkpoint.status, 200);
  const finish = segment(checkpoint.data.session, checkpoint.data.session.base_tick);
  const completed = await call<WatermelonSessionResponse>('/api/watermelon/finish', { ...finish, score: 999999, highest: 8 }, cookie);
  assert.equal(completed.status, 200); const result = completed.data.session.result; assert(result?.recorded);
  assert.equal(result.score, checkpoint.data.session.state.score); assert.equal(result.moves, 3);
  await call('/api/watermelon/finish', finish, cookie);
  const mine = await call<{ stats: AccountStats }>('/api/auth/me', undefined, cookie);
  assert.equal(mine.data.stats.games, 1); assert.equal(mine.data.stats.byGame[0].gameId, 'watermelon');
  assert.equal(mine.data.stats.recent[0].score, result.score);
  const status = await call<WatermelonStatus>('/api/watermelon/status', undefined, cookie);
  assert.equal(status.data.stats?.games, 1); assert.equal(status.data.stats?.recent[0].id, result.id);
  const outsider = await call<WatermelonStatus>('/api/watermelon/status');
  assert.equal((await call('/api/watermelon/finish', finish, outsider.cookie)).status, 404);
});
