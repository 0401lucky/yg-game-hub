import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTIES, createGame, applyAction, buildView, neighbors, calculateScore } from '../../games/minesweeper/engine.ts';
import { MinesweeperService, GameError, dayKey } from '../../games/minesweeper/server/service.ts';
import type { GridAction, GameAction, GameState, GameMode, GameStats, AccountMatch, SessionView } from '../../games/minesweeper/types.ts';

function apply(state: GameState, action: GridAction): GameState {
  const result = applyAction(state, action);
  assert(result.ok, result.message);
  return result.state;
}

test('扫雷三档：确定性布雷、首击与周围八格保护、空白展开、隐藏信息及输入不可变', () => {
  for (const difficulty of Object.keys(DIFFICULTIES) as (keyof typeof DIFFICULTIES)[]) {
    for (let seed = 0; seed < 12; seed++) {
      const original = createGame(`seed-${seed}`, difficulty);
      const first = seed % 2 ? 0 : Math.floor(original.cells.length / 2);
      const snapshot = JSON.stringify(original);
      const next = apply(original, { type: 'reveal', index: first });
      assert.equal(JSON.stringify(original), snapshot);
      assert.equal(next.cells.filter(cell => cell.mine).length, DIFFICULTIES[difficulty].mines);
      assert([first, ...neighbors(next, first)].every(index => !next.cells[index].mine));
      assert.equal(next.cells[first].revealed, true);
      assert.deepEqual(next, apply(createGame(`seed-${seed}`, difficulty), { type: 'reveal', index: first }));
      const view = buildView(next);
      assert.equal(Object.hasOwn(view, 'seed'), false);
      assert(view.cells.every(cell => !Object.hasOwn(cell, 'mine')));
      assert(view.cells.filter(cell => cell.display === 'hidden').every(cell => cell.adjacent === 0));
      assert.equal(next.revealedSafe, next.cells.filter(cell => cell.revealed && !cell.mine).length);
    }
  }
});

test('扫雷标记与快速展开：正确插旗揭安全格、误标触雷、揭完安全格获胜和得分', () => {
  let state = apply(createGame('chord-example', 'normal'), { type: 'reveal', index: 78 });
  const numbered = state.cells.findIndex((cell, index) => cell.revealed && cell.adjacent > 0 && neighbors(state, index).some(i => !state.cells[i].revealed && !state.cells[i].mine));
  assert(numbered >= 0);
  const adjacentMines = neighbors(state, numbered).filter(index => state.cells[index].mine);
  for (const index of adjacentMines) state = apply(state, { type: 'flag', index });
  const before = state.revealedSafe;
  state = apply(state, { type: 'chord', index: numbered });
  assert.equal(state.status, 'playing'); assert(state.revealedSafe > before);

  let wrong = apply(createGame('chord-example', 'normal'), { type: 'reveal', index: 78 });
  const safeHidden = neighbors(wrong, numbered).filter(index => !wrong.cells[index].revealed && !wrong.cells[index].mine);
  assert(safeHidden.length);
  wrong = apply(wrong, { type: 'flag', index: safeHidden[0] });
  for (const index of adjacentMines.slice(1)) wrong = apply(wrong, { type: 'flag', index });
  wrong = apply(wrong, { type: 'chord', index: numbered });
  assert.equal(wrong.status, 'lost'); assert.notEqual(wrong.exploded, null);
  assert(buildView(wrong).cells.some(cell => cell.display === 'wrongflag'));

  let won = apply(createGame('winning-example'), { type: 'reveal', index: 40 });
  for (let index = 0; index < won.cells.length; index++) if (!won.cells[index].mine && !won.cells[index].revealed) won = apply(won, { type: 'reveal', index });
  assert.equal(won.status, 'won'); assert.equal(won.revealedSafe, 71);
  assert.equal(won.flagsUsed, 10, '只揭安全格即可获胜，通关后自动标记全部地雷');
  assert(calculateScore(won, 1000) > calculateScore(won, 360000));
  assert(calculateScore(wrong, 1000) >= 0);
});

async function clockFixture() {
  let now = Date.parse('2026-11-24T15:59:50Z');
  const matches: AccountMatch[] = [];
  const stats: GameStats = { games: 0, wins: 0, bestTimes: { classic: {}, daily: {} } };
  const service = new MinesweeperService({ now: () => now, seedFactory: () => 'fixed-service-seed', auth: {
    recordMatch(match) { matches.push(match); return matches.length; },
    minesweeperStatsOf: () => stats,
  } });
  await service.ready;
  const step = (owner: string, view: SessionView, action: GameAction, requestId = `request-${owner}-${view.revision}`) => service.step(owner, {
    sessionId: view.id, revision: view.revision, requestId, action,
  }).session;
  return { service, matches, stats, step, advance(ms: number) { now += ms; }, now: () => now };
}

test('扫雷计时：自由探索首击开始、暂停停表；每日同图、中心开局与暂停继续计时', async () => {
  const f = await clockFixture();
  const classic = f.service.start('classic', null, { difficulty: 'easy' }).session;
  f.advance(3000); assert.equal(f.service.status('classic').session?.elapsedMs, 0);
  let view = f.step('classic', classic, { type: 'reveal', index: 40 });
  f.advance(2000); view = f.step('classic', view, { type: 'pause' });
  assert.equal(view.elapsedMs, 2000); assert.equal(view.running, false);
  f.advance(5000); assert.equal(f.service.status('classic').session?.elapsedMs, 2000);
  view = f.step('classic', view, { type: 'resume' });
  f.advance(1000); assert.equal(f.service.status('classic').session?.elapsedMs, 3000);
  assert.equal(view.running, true);

  const daily = f.service.start('daily-a', null, { mode: 'daily', difficulty: 'normal' }).session;
  const twin = f.service.start('daily-b', null, { mode: 'daily', difficulty: 'normal' }).session;
  assert.deepEqual(daily.state, twin.state);
  assert(daily.state.firstRevealDone); assert.equal(daily.running, true);
  assert.equal(daily.date, dayKey(f.now()));
  f.advance(2000); const paused = f.step('daily-a', daily, { type: 'pause' });
  f.advance(5000); assert.equal(f.service.status('daily-a').session?.elapsedMs, 7000);
  assert.equal(paused.running, true);
  assert.equal(dayKey(Date.parse('2026-11-24T16:00:00Z')), '2026-11-25');
});

test('扫雷会话：重试幂等、版本冲突、重新开局确认、游客登录接回、结算只记录一次及过期', async () => {
  const f = await clockFixture();
  const guest = 'guest-owner';
  let view = f.service.start(guest, null).session;
  view = f.step(guest, view, { type: 'reveal', index: 40 }, 'first-reveal-request');
  const revision = view.revision;
  const duplicate = f.service.step(guest, { sessionId: view.id, revision: 0, requestId: 'first-reveal-request', action: { type: 'reveal', index: 40 } });
  assert.equal(duplicate.session.revision, revision);
  assert.throws(() => f.service.step(guest, { sessionId: view.id, revision: 0, requestId: 'new-stale-request', action: { type: 'pause' } }), error => error instanceof GameError && error.status === 409 && error.session?.revision === revision);
  assert.throws(() => f.service.start(guest, null), error => error instanceof GameError && error.status === 409);
  const owner = 'user-owner';
  const attached = f.service.status(owner, { id: 1, nickname: '林地牌友' }, guest).session;
  assert.equal(attached?.id, view.id);
  assert.equal(f.service.status(guest).session, null);
  const domain = f.service.sessions.get(owner)!;
  f.advance(10000);
  for (let index = 0; index < domain.state.cells.length; index++) {
    if (!domain.state.cells[index].mine && !domain.state.cells[index].revealed) view = f.step(owner, view, { type: 'reveal', index });
  }
  assert.equal(view.state.status, 'won'); assert.equal(view.result?.recorded, true);
  assert.equal(view.result?.durationMs, 10000); assert.equal(f.matches.length, 1);
  assert.equal(f.matches[0].gameId, 'minesweeper'); assert.deepEqual(f.matches[0].winnerColors, [0]);
  f.service.status(owner); assert.equal(f.matches.length, 1);
  f.advance(24 * 60 * 60 * 1000 + 1);
  assert.equal(f.service.status(owner).session, null);
});
