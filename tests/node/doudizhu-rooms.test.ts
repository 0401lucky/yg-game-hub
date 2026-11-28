import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { chooseAction } from '../../games/doudizhu/bot.ts';
import { DoudizhuService } from '../../games/doudizhu/server/service.ts';
import type { AccountMatch } from '../../games/shared/protocol.ts';
import { CardClient, delay, waitUntil } from './helpers.ts';

async function fixture() {
  const matches: AccountMatch[] = [];
  const service = new DoudizhuService({ auth: {
    userFromCookieHeader: cookie => cookie === 'test_user=1' ? { id: 1, nickname: '账号牌友' } : null,
    recordMatch: match => matches.push(match),
  }, botDelayMs: 25, bidMs: 10000, turnMs: 10000, disconnectGraceMs: 40, tickMs: 12 });
  await service.ready;
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => service.handleConnection(ws, req));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clients: CardClient[] = [];
  async function connect({ token, nickname = '牌友', cookie }: { token?: string | null; nickname?: string; cookie?: string } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/doudizhu`, cookie ? { headers: { cookie } } : {});
    const client = new CardClient(ws);
    clients.push(client);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token, nickname }));
    await waitUntil(() => client.token);
    return client;
  }
  return { service, server, wss, clients, matches, connect, close: async () => {
    for (const client of clients) client.ws.terminate();
    service.close();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('两位真人加人机：建房幂等、准备同步、隐藏手牌、合法出牌与再来一局', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const host = await f.connect();
    const guest = await f.connect();
    host.send('create', { difficulty: 'hard', nickname: '房主' }, 'same-create');
    await waitUntil(() => host.state!);
    const code = host.state!.room.code;
    assert.equal(host.state!.room.players.filter(Boolean).length, 2);
    host.send('create', { difficulty: 'hard' }, 'same-create');
    await delay(40);
    assert.equal(f.service.rooms.size, 1);
    assert.equal(host.state!.room.code, code);
    guest.send('join', { code, nickname: '朋友' });
    await waitUntil(() => guest.state!?.room.code === code);
    assert.equal(guest.state!.me.seat, 1);
    host.send('start');
    await waitUntil(() => host.messages.find(message => message.type === 'error' && (message.type === 'error' ? message.code : undefined) === 'notReady'));
    assert.equal(host.state!.game!, null);
    guest.send('start');
    await waitUntil(() => guest.messages.find(message => (message.type === 'error' ? message.code : undefined) === 'hostOnly'));
    guest.send('ready', { ready: true });
    await waitUntil(() => host.state!.room.players[1]!.ready);
    host.send('start');
    await waitUntil(() => host.state!?.game!?.phase === 'bidding' && guest.state!?.game!?.phase === 'bidding');
    assert.deepEqual(host.state!.game!.counts, [17, 17, 17]);
    assert.equal(host.state!.game!.hand.length, 17);
    assert.equal(Object.hasOwn(host.state!.game!, 'hands'), false);
    assert.equal(Object.hasOwn(host.state!.game!, 'seed'), false);
    assert.equal(host.state!.game!.revealedHands, undefined);
    assert.deepEqual(host.state!.game!.bottom, []);
    assert.notDeepEqual(host.state!.game!.hand, guest.state!.game!.hand);

    const domain = f.service.rooms.get(code)!;
    while (domain.game!.phase === 'bidding') {
      if (domain.game!.turn === 2) await delay(40);
      else {
        const client = domain.game!.turn === 0 ? host : guest;
        const seq = domain.game!.seq;
        client.send('action', { type: 'bid', score: 3 });
        await waitUntil(() => domain.game!.seq > seq);
      }
    }
    await waitUntil(() => host.state!.game!.phase === 'playing' && guest.state!.game!.phase === 'playing');
    const wrong = domain.game!.turn === 0 ? guest : host;
    const beforeSeq = domain.game!.seq;
    wrong.send('action', { type: 'pass' });
    await waitUntil(() => wrong.messages.find(message => (message.type === 'error' ? message.code : undefined) === 'notYourTurn'));
    assert.equal(domain.game!.seq, beforeSeq);

    // 当前出牌的真人尝试冒用一张不在自己手里的牌。
    if (domain.game!.turn !== 2) {
      const client = domain.game!.turn === 0 ? host : guest;
      const otherCard = domain.game!.hands[(domain.game!.turn! + 1) % 3][0];
      client.send('action', { type: 'play', cards: [otherCard] });
      await waitUntil(() => client.messages.find(message => (message.type === 'error' ? message.code : undefined) === 'notOwned'));
    }

    let steps = 0;
    while (domain.game!.phase !== 'ended' && steps < 180) {
      if (domain.game!.turn === 2) { await delay(30); continue; }
      const client = domain.game!.turn === 0 ? host : guest;
      await waitUntil(() => client.state!.game!.seq === domain.game!.seq);
      const seq = domain.game!.seq;
      const action = chooseAction({ ...client.state!.game!, seat: client.state!.me.seat }, 'hard', { thinkMs: 15 });
      assert(action);
      client.send('action', action);
      await waitUntil(() => domain.game!.seq > seq);
      steps++;
    }
    assert.equal(domain.game!.phase, 'ended');
    assert.equal(f.matches.length, 1);
    assert.equal(f.matches[0].gameId, 'doudizhu');
    assert.equal(f.matches[0].winnerColors?.length, domain.game!.winnerSide === 'landlord' ? 1 : 2);
    await waitUntil(() => host.state!.game!.phase === 'ended' && guest.state!.game!.phase === 'ended');
    assert.deepEqual(host.state!.game!.revealedHands, domain.game!.hands);
    host.send('rematch');
    await waitUntil(() => guest.state!.room.players[0]!.rematchReady);
    assert.equal(domain.round, 1);
    guest.send('rematch');
    await waitUntil(() => domain.round === 2);
    assert.equal(domain.game!.phase, 'bidding');
  } finally { await f.close(); }
});
test('断线保留同一局与手牌，人机临时接管，重连恢复手动控制；旧连接不会回写离线状态', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const original = await f.connect({ nickname: '重连牌友' });
    original.send('create', { solo: true, difficulty: 'easy' });
    await waitUntil(() => original.state!?.game!);
    const code = original.state!.room.code;
    const domain = f.service.rooms.get(code)!;
    await waitUntil(() => domain.game!.turn === 0);
    original.ws.close();
    await waitUntil(() => !domain.players[0]!.connected);
    await waitUntil(() => domain.players[0]!.autoReason === 'offline');
    const round = domain.round;
    const resumed = await f.connect({ token: original.token });
    await waitUntil(() => resumed.state!);
    assert.equal(resumed.token, original.token);
    assert.equal(resumed.playerId, original.playerId);
    assert.equal(resumed.state!.room.code, code);
    assert.equal(resumed.state!.room.round, round);
    assert.deepEqual(resumed.state!.game!.hand, domain.game!.hands[0]);
    assert.equal(resumed.state!.room.players[0]!.connected, true);
    assert.equal(resumed.state!.room.players[0]!.auto, false);
    const replacement = await f.connect({ token: resumed.token });
    await waitUntil(() => resumed.closeCode === 4001);
    await waitUntil(() => replacement.state!);
    assert.equal(replacement.state!.room.players[0]!.connected, true);
    assert(resumed.messages.some(message => message.type === 'superseded'));
  } finally { await f.close(); }
});

test('同一账号不能占两个座位，已登录玩家的恢复 token 不能被匿名连接冒用', async () => {
  const f = await fixture();
  try {
    const host = await f.connect({ cookie: 'test_user=1' });
    host.send('create', { difficulty: 'hard' });
    await waitUntil(() => host.state!);
    assert.equal(host.state!.room.players[0]!.nickname, '账号牌友');
    const duplicate = await f.connect({ cookie: 'test_user=1' });
    duplicate.send('join', { code: host.state!.room.code });
    await waitUntil(() => duplicate.messages.find(message => (message.type === 'error' ? message.code : undefined) === 'sameAccount'));
    const outsider = await f.connect({ token: host.token });
    assert.notEqual(outsider.token, host.token);
    assert.equal(outsider.state!, null);
    assert.equal(host.ws.readyState, WebSocket.OPEN);
  } finally { await f.close(); }
});

test('游客开房后登录接回原座位并绑定战绩，退出账号保留牌局并停止绑定', async () => {
  const f = await fixture();
  try {
    const guest = await f.connect({ nickname: '游客牌友' });
    guest.send('create', { difficulty: 'hard' });
    await waitUntil(() => guest.state!);
    const code = guest.state!.room.code;
    const logged = await f.connect({ token: guest.token, cookie: 'test_user=1' });
    await waitUntil(() => logged.state!);
    assert.equal(logged.playerId, guest.playerId);
    assert.equal(logged.state!.room.code, code);
    assert.equal(logged.state!.room.players[0]!.nickname, '账号牌友');
    assert.equal(f.service.rooms.get(code)!.players[0]!.userId, 1);
    logged.send('detachAccount');
    await waitUntil(() => logged.messages.find(message => message.type === 'accountDetached'));
    assert.equal(f.service.rooms.get(code)!.players[0]!.userId, null);
    const anonymous = await f.connect({ token: logged.token });
    await waitUntil(() => anonymous.state!);
    assert.equal(anonymous.playerId, guest.playerId);
    assert.equal(anonymous.state!.room.code, code);
    assert.equal(f.service.rooms.size, 1);
  } finally { await f.close(); }
});

test('游客登录已在本桌入座的账号时接回账号座位，不会占用两个座位', async () => {
  const f = await fixture();
  try {
    const host = await f.connect();
    host.send('create', { difficulty: 'hard' });
    await waitUntil(() => host.state!);
    const code = host.state!.room.code;
    const account = await f.connect({ cookie: 'test_user=1' });
    account.send('join', { code });
    await waitUntil(() => account.state!);
    const switched = await f.connect({ token: host.token, cookie: 'test_user=1' });
    await waitUntil(() => switched.state!);
    assert.equal(switched.playerId, account.playerId);
    assert.equal(switched.state!.me.seat, 1);
    await waitUntil(() => account.closeCode === 4001);
    const players = f.service.rooms.get(code)!.players.filter((player): player is NonNullable<typeof player> => Boolean(player));
    assert.equal(players.filter(player => player.userId === 1).length, 1);
    assert.equal(players.filter(player => !player.isBot).length, 1);
    assert.equal(switched.state!.room.hostId, switched.playerId);
  } finally { await f.close(); }
});

test('房主调节三档人机、给第三位真人腾座；房主离开后转移权限', async () => {
  const f = await fixture();
  try {
    const host = await f.connect(); const second = await f.connect(); const third = await f.connect();
    host.send('create', { difficulty: 'easy', autoFill: false });
    await waitUntil(() => host.state!);
    const code = host.state!.room.code;
    second.send('join', { code }); await waitUntil(() => second.state!);
    third.send('join', { code }); await waitUntil(() => third.messages.find(message => (message.type === 'error' ? message.code : undefined) === 'roomFull'));
    host.send('settings', { difficulty: 'hell' }); await waitUntil(() => second.state!.room.difficulty === 'hell');
    assert.equal(second.state!.room.players[2]!.level, 'hell');
    host.send('bot', { seat: 2, enabled: false }); await waitUntil(() => !host.state!.room.players[2]);
    third.send('join', { code }); await waitUntil(() => third.state!?.room.code === code);
    assert.equal(third.state!.me.seat, 2);
    host.send('bot', { seat: 1, enabled: true }); await waitUntil(() => host.messages.find(message => (message.type === 'error' ? message.code : undefined) === 'humanSeat'));
    host.send('leave'); await waitUntil(() => second.state!.room.hostId === second.state!.me.id);
    assert.equal(f.service.rooms.get(code)!.hostId, second.state!.me.id);
    assert.equal(second.state!.room.players[1]!.ready, true);
    third.send('join', { code: '000000' }); await waitUntil(() => third.messages.find(message => (message.type === 'error' ? message.code : undefined) === 'roomGone'));
    assert.equal(third.state!.room.code, code, '错误房间码不应破坏原房间');
  } finally { await f.close(); }
});

test('癞子模式设置、明牌同步与倍率翻倍、双真人农民互相确认投降与人机禁投降', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const host = await f.connect({ nickname: '房主甲' });
    const guest = await f.connect({ nickname: '牌友乙' });
    host.send('create', { difficulty: 'hard', mode: 'laizi' });
    await waitUntil(() => host.state!);
    const code = host.state!.room.code;
    assert.equal(host.state!.room.mode, 'laizi');
    guest.send('join', { code });
    await waitUntil(() => guest.state?.room.code === code);
    guest.send('ready', { ready: true });
    await waitUntil(() => host.state!.room.players[1]!.ready);
    host.send('start');
    await waitUntil(() => host.state!.game?.phase === 'bidding' && guest.state!.game?.phase === 'bidding');
    assert.equal(host.state!.game!.mode, 'laizi');
    assert(host.state!.game!.laiziRank !== null);
    const domain = f.service.rooms.get(code)!;

    // 叫分阶段禁止投降
    host.send('surrender', { decision: 'request' });
    await waitUntil(() => host.messages.some(m => m.type === 'error' && m.code === 'notPlaying'));

    // 叫分阶段房主明牌，牌友立即看到房主手牌且倍率翻倍
    const multBefore = domain.game!.multiplier;
    host.send('openHand');
    await waitUntil(() => guest.state!.game!.openSeats[0]);
    assert.equal(domain.game!.multiplier, multBefore * 2);
    assert.deepEqual(guest.state!.game!.openHands[0], domain.game!.hands[0]);

    // 让座位 2 的人机成为地主，测试双真人农民互相确认投降
    // 先把状态设为进入出牌阶段，座位 2 为地主（人机），座位 0、1 为两位真人农民
    while (domain.game!.phase === 'bidding') {
      if (domain.game!.turn === 2) await delay(30);
      else {
        const client = domain.game!.turn === 0 ? host : guest;
        const seq = domain.game!.seq;
        client.send('action', { type: 'bid', score: 0 });
        await waitUntil(() => domain.game!.seq > seq);
      }
      // 如果重发且人机不叫，直接通过引擎强制进出牌阶段确保人机为地主
      if (domain.game!.deal >= 2) break;
    }
    if (domain.game!.phase !== 'playing' || domain.game!.landlordSeat !== 2) {
      domain.game!.phase = 'playing';
      domain.game!.landlordSeat = 2;
      domain.game!.highestBid = 2;
      domain.game!.turn = 0;
      f.service.publish(domain);
      await waitUntil(() => host.state!.game!.phase === 'playing' && host.state!.game!.landlordSeat === 2);
    }

    // 房主（真人农民）发起投降：不立即结束，等待另一位真人农民确认
    host.send('surrender', { decision: 'request' });
    await waitUntil(() => guest.state!.game!.surrenderVote?.initiator === 0);
    assert.equal(domain.game!.phase, 'playing');
    // 牌友拒绝投降：取消投票，对局继续
    guest.send('surrender', { decision: 'reject' });
    await waitUntil(() => host.state!.game!.surrenderVote === null);
    assert.equal(domain.game!.phase, 'playing');
    // 再次发起并同意：立即结束，地主（座位 2）获胜
    host.send('surrender', { decision: 'request' });
    await waitUntil(() => guest.state!.game!.surrenderVote?.initiator === 0);
    guest.send('surrender', { decision: 'agree' });
    await waitUntil(() => host.state!.game!.phase === 'ended' && guest.state!.game!.phase === 'ended');
    assert.equal(domain.game!.winnerSide, 'landlord');
    assert.equal(domain.game!.surrenderBy, 0);
    assert.equal(f.matches.length, 1);
    assert.equal(f.matches[0].mode, 'laizi-hard');
  } finally { await f.close(); }
});

test('单人模式（真人配人机）：真人投降无需队友确认直接判负，人机永远不会触发投降', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const solo = await f.connect({ nickname: '单人玩家' });
    solo.send('create', { solo: true, difficulty: 'easy', mode: 'classic' });
    await waitUntil(() => solo.state?.game?.phase === 'bidding');
    const domain = f.service.rooms.get(solo.state!.room.code)!;
    while (domain.game!.phase === 'bidding') {
      if (domain.game!.turn !== 0) await delay(30);
      else {
        const seq = domain.game!.seq;
        solo.send('action', { type: 'bid', score: 3 });
        await waitUntil(() => domain.game!.seq > seq);
      }
    }
    await waitUntil(() => solo.state!.game!.phase === 'playing');
    // 人机不允许投降：直接调用服务端处理也必须被拒绝
    const fakeSession = [...f.service.sessions.values()][0];
    f.service.handleSurrender(domain, 1, 'request', fakeSession);
    assert.equal(domain.game!.phase, 'playing');
    // 真人点击投降立即结算
    solo.send('surrender', { decision: 'request' });
    await waitUntil(() => solo.state!.game!.phase === 'ended');
    assert.equal(domain.game!.surrenderBy, 0);
    assert.equal(domain.game!.winnerSide, domain.game!.landlordSeat === 0 ? 'farmers' : 'landlord');
  } finally { await f.close(); }
});

