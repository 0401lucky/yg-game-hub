import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightClient, startHub } from './helpers.ts';
import type { PackedReplay } from '../../games/flight/types.ts';

let hub: Awaited<ReturnType<typeof startHub>>;
test.before(async () => { hub = await startHub(); });
test.after(async () => { await hub.close(); });

test('飞行棋房间：幂等建房、准备广播、权限、换座、设置与过期房间错误', async () => {
  const host = await FlightClient.connect(hub.base);
  const guest = await FlightClient.connect(hub.base);
  try {
    host.send('createRoom', { requestId: 'same-create', nickname: '房主', gameMode: 'multiplayer' });
    const room = (await host.wait('roomCreated')).room;
    host.send('createRoom', { requestId: 'same-create', nickname: '房主', gameMode: 'multiplayer' });
    assert.equal((await host.wait('roomCreated', message => message.replayed)).room.code, room.code);
    guest.send('join_room', { roomCode: room.code }, true);
    assert.equal((await guest.wait('roomJoined')).room.code, room.code);
    guest.send('toggle_ready', { isReady: true });
    assert.equal((await host.wait('playerReadyStatusChanged', message => message.playerId === guest.playerId)).isReady, true);
    guest.send('select_color', { colorIndex: 3 });
    assert.equal((await guest.wait('playerUpdated', message => message.room?.players.some(player => player.id === guest.playerId && player.color === 3))).room?.players.find(player => player.id === guest.playerId)?.color, 3);
    guest.send('updateSettings', { settings: { pieceCount: 1 } });
    assert.match((await guest.wait('error')).message, /房主|权限/);
    host.send('updateSettings', { settings: { pieceCount: 2, happyMode: true, skillMode: false } });
    assert.equal((await guest.wait('settingsUpdated')).settings.pieceCount, 2);
    guest.send('join_room', { roomCode: 'ZZZZ' });
    assert.equal((await guest.wait('error', message => message.code === 'roomGone')).code, 'roomGone');
    guest.send('getReconnectInfo');
    assert.equal((await guest.wait('reconnectInfo')).source, 'room');
    host.send('listRooms');
    assert((await host.wait('roomsList')).rooms.some(item => item.code === room.code));
  } finally { host.close(); guest.close(); }
});

test('飞行棋权威 WS：开局、非法出手、观战、旧棋面报告隔离、同局重连和 HTTP 回放', async () => {
  const host = await FlightClient.connect(hub.base);
  const guest = await FlightClient.connect(hub.base);
  const spectator = await FlightClient.connect(hub.base);
  let resumed: FlightClient | undefined;
  try {
    host.send('createRoom', { nickname: '房主' });
    const room = (await host.wait('roomCreated')).room;
    guest.send('join_room', { roomCode: room.code }); await guest.wait('roomJoined');
    host.send('updateSettings', { settings: { pieceCount: 1 } }); await host.wait('settingsUpdated');
    guest.send('toggle_ready', { isReady: true }); await host.wait('playerReadyStatusChanged');
    host.send('start_game');
    const { gameSessionId } = await host.wait('gameStarted');
    const initial = await host.wait('gameSnapshot');
    assert.equal(initial.seq, 0); assert.equal(initial.pieceCount, 1);
    host.send('audioLoaded', { gameSessionId }); guest.send('audioLoaded', { gameSessionId });
    await host.wait('allAudioLoaded');
    host.clear(); guest.clear();
    guest.send('intent', { intent: { type: 'roll' } });
    await guest.wait('intentRejected');
    host.send('intent', { intent: { type: 'roll', value: 6 } });
    const rolled = await host.wait('gameSnapshot', message => message.seq === 1);
    const dice = rolled.events.find(event => event.type === 'dice');
    assert(dice && dice.value >= 1 && dice.value <= 6);
    assert.deepEqual((await guest.wait('gameSnapshot', message => message.seq === 1)).playerChess, rolled.playerChess);
    host.send('boardSyncData', { playerChess: { 1: [{ position: 56, finished: true }] } });
    host.send('snapshotRequest');
    assert.deepEqual((await host.wait('gameSnapshot', message => message.seq === 1)).playerChess, rolled.playerChess);
    spectator.send('spectate_room', { roomCode: room.code });
    assert.equal((await spectator.wait('spectateJoined')).gameSessionId, gameSessionId);
    const spectatorSnapshot = await spectator.wait('gameSnapshot');
    assert.equal(spectatorSnapshot.seq, 1);
    host.close();
    resumed = await FlightClient.connect(hub.base, host.playerId);
    resumed.send('rejoinGameSession', { gameSessionId, needsHistory: true });
    assert.equal((await resumed.wait('gameSessionConnected')).gameSessionId, gameSessionId);
    const resumedSnapshot = await resumed.wait('gameSnapshot');
    assert.equal(resumedSnapshot.seq, 1); assert.deepEqual(resumedSnapshot.playerChess, rolled.playerChess);
    await resumed.wait('gameInfoHistory');
    const res = await fetch(`${hub.base}/api/replay/${gameSessionId}?download=1`);
    assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition') || '', /attachment/);
    const replay = await res.json() as PackedReplay;
    assert.equal(replay.format, 1); assert.equal(replay.actionCount, 1); assert.equal(replay.pieceCount, 1);
  } finally { host.close(); guest.close(); spectator.close(); resumed?.close(); }
});
