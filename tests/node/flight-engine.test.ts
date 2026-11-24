import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as engine from '../../games/shared/engine.ts';
import { chooseAction } from '../../games/shared/bot.ts';
import { encodeReplayAction, decodeReplayAction, encodeArchive, decodeArchive } from '../../games/shared/replayCodec.ts';
import { createAuthoritySession } from '../../games/flight/server/authority.ts';
import { SnapshotGate } from '../../games/flight/js/snapshotGate.ts';
import { normalizeInboundMessage, flightClientProtocol } from '../../games/flight/protocol.ts';
import type { FlightAction, ReplayArchive } from '../../games/flight/types.ts';
import type { StateOptions } from '../../games/shared/engine.ts';

interface GoldenGame { options: StateOptions; seed: number; expected: { steps: number; winner: number; hash: string; eventTypes: string[] } }
const golden = JSON.parse(fs.readFileSync(new URL('../fixtures/flight-golden.json', import.meta.url), 'utf8')) as GoldenGame[];

test('与迁移前 JS 基线对照：36 局、各人数/棋子数/模式的动作、快照、AI 与回放元组完全一致', () => {
  for (const { options, seed, expected } of golden) {
    let state = engine.createState(options);
    const rng = engine.makeRng(seed);
    const hash = createHash('sha256');
    const eventTypes = new Set<string>();
    let steps = 0;
    while (state.phase !== 'ended' && steps < 4000) {
      const player = state.currentPlayer;
      const action = chooseAction(state, player, { rng, difficulty: player % 2 ? 'hard' : 'easy' });
      assert(action);
      const before = JSON.stringify(state);
      const result = engine.apply(state, player, action, rng);
      assert.equal(JSON.stringify(state), before, '规则引擎不可修改输入棋面');
      state = result.state;
      for (const event of result.events) eventTypes.add(event.type);
      hash.update(JSON.stringify({ action: encodeReplayAction(action), events: result.events, snapshot: engine.toSnapshot(state) }));
      steps++;
    }
    assert.equal(state.phase, 'ended');
    assert.deepEqual({ steps, winner: state.winner, hash: hash.digest('hex'), eventTypes: [...eventTypes].sort() }, expected, JSON.stringify({ options, seed }));
  }
});

test('回放兼容：省略尾零、所有动作与道具、旧版裸掷骰、紧凑存档及原始动作', () => {
  const actions: FlightAction[] = [
    { type: 'roll' }, { type: 'roll', value: 6 }, { type: 'roll', value: 12, maxDice: 12, noBonus: true, item: 'polyhedral-dice' },
    { type: 'move', chessIndex: 0 }, { type: 'move', chessIndex: 3 }, { type: 'teleport', chessIndex: 0 },
    { type: 'item', item: 'remote-dice' }, { type: 'item', item: 'teleport' }, { type: 'item', item: 'mysteryBox' },
    { type: 'skip' }, { type: 'skip', reason: 'mysteryBox' }, { type: 'debug', op: 'energy', player: 1, delta: 15 },
  ];
  for (const action of actions) assert.deepEqual(decodeReplayAction(encodeReplayAction(action)), action);
  assert.deepEqual(encodeReplayAction({ type: 'roll' }), [0]);
  assert.equal(decodeReplayAction([9]), 0, '保留旧原始动作元组的默认值');
  assert.equal(decodeReplayAction([99]), null);
  const archive: ReplayArchive = {
    engineVersion: 1, mode: 'ai', seed: 24, colors: [1, 3], pieceCount: 2, happy: true, skillMode: false,
    startEnergy: 0, players: [{ color: 1, nickname: '玩家', isAI: false, emoji: null }],
    finished: false, winner: null, turn: 2, actionCount: 2,
    actions: [{ p: 1, a: { type: 'roll' } }, { p: 1, a: { type: 'move', chessIndex: 0 } }],
  };
  const packed = encodeArchive(archive);
  assert.equal(encodeArchive(packed), packed);
  assert.deepEqual(decodeArchive(packed), archive);
  const oldPacked: typeof packed = { ...packed, actions: [[1]] };
  assert.deepEqual(decodeArchive(oldPacked).actions, [{ p: 1, a: { type: 'roll' } }]);
});

test('权威意图：拒绝越权和非法道具、普通点数由服务端决定、记录快照与可重建回放', async () => {
  const session = await createAuthoritySession({ gameSessionId: 'authority-test', colors: [3, 1], pieceCount: 1, seed: 24 });
  assert.deepEqual(session.colors, [1, 3]);
  assert.equal(session.applyIntent(9, { type: 'roll' }).ok, false);
  assert.equal(session.applyIntent(1, { type: 'roll', item: 'remote-dice', value: 7 }).ok, false);
  assert.equal(session.seq, 0);
  const roll = session.applyIntent(1, { type: 'roll', value: 0 });
  assert(roll.ok);
  assert.equal(roll.snapshot.diceValue, 2, '普通点数使用本局种子，不接受客户端伪造值');
  assert.equal(session.applyIntent(3, { type: 'move', chessIndex: 0 }).ok, false);
  assert.equal(session.seq, 1);
  const move = session.applyIntent(1, { type: 'move', chessIndex: 0 });
  assert(move.ok); assert.equal(move.snapshot.seq, 2);
  const archive = decodeArchive(session.getReplay());
  let replay = engine.createState({ players: archive.colors, piecesPerPlayer: archive.pieceCount });
  const rng = engine.makeRng(archive.seed);
  for (const item of archive.actions) replay = engine.apply(replay, item.p, item.a, rng).state;
  assert.deepEqual(replay, session.state);
});

test('快照去重：旧帧、重连强制同步及新会话重置水位', () => {
  const gate = new SnapshotGate();
  assert(gate.accept({ gameSessionId: 'a', seq: 4 }));
  assert.equal(gate.accept({ gameSessionId: 'a', seq: 4 }), false);
  assert.equal(gate.accept({ gameSessionId: 'a', seq: 3 }), false);
  gate.forceNext(); assert(gate.accept({ gameSessionId: 'a', seq: 3 }));
  assert.equal(gate.seq, 4);
  assert(gate.accept({ gameSessionId: 'b', seq: 0 }));
  assert.equal(gate.seq, 0);
  gate.reset(); assert.equal(gate.accept(null), false); assert.equal(gate.seq, -1);
});

test('历史 WS 封装：扁平载荷和 data 信封等价，type 保留信封判别字段', () => {
  const flat = { type: 'join_room', roomCode: 'ABCD', playerId: 'p1' };
  assert.deepEqual(normalizeInboundMessage(flat), flat);
  assert.deepEqual(normalizeInboundMessage({ type: 'join_room', playerId: 'p1', data: { roomCode: 'ABCD', type: 'fake' } }), flat);
  assert.deepEqual(flightClientProtocol.decode({ type: 'roomsList', data: { rooms: [] } }), { type: 'roomsList', rooms: [] });
});
