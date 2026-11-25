import { test, expect, capture, register } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { createGame, applyAction, publicState, sortCards, DECK, rankOf } from '../../games/doudizhu/engine.ts';
import { clientProtocol, serverProtocol } from '../../games/doudizhu/protocol.ts';
import type { ClientMessage, Response, ServerMessage } from '../../games/doudizhu/protocol.ts';
import type { GameState, PlayerInfo } from '../../games/doudizhu/types.ts';

async function observeTable(page: Page) {
  const observed: { state: Response<'state'> | null; messages: ServerMessage[]; sent: ClientMessage[] } = { state: null, messages: [], sent: [] };
  await page.routeWebSocket('**/ws/doudizhu', route => {
    const server = route.connectToServer();
    route.onMessage(raw => {
      observed.sent.push(serverProtocol.decode(JSON.parse(String(raw))));
      server.send(raw);
    });
    server.onMessage(raw => {
      const message = clientProtocol.decode(JSON.parse(String(raw)));
      observed.messages.push(message);
      if (message.type === 'state') observed.state = message;
      route.send(raw);
    });
  });
  return observed;
}
async function hand(page: Page): Promise<string[]> {
  return page.locator('#hand .card').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.card!).sort());
}

test('斗地主好友房：设置、准备、叫分、私有手牌、表情和刷新续局', async ({ page, browser, audit }, info) => {
  const guestContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: Boolean(info.project.use.isMobile), hasTouch: Boolean(info.project.use.hasTouch), reducedMotion: 'reduce' });
  const guest = await guestContext.newPage(); audit.watch(guest);
  const hostTable = await observeTable(page);
  const guestTable = await observeTable(guest);
  try {
    await page.goto('/games/doudizhu/');
    await page.locator('#createButton').click();
    await expect.poll(() => hostTable.state?.room.code).toMatch(/^\d{6}$/);
    const code = hostTable.state!.room.code;
    await guest.goto(new URL('/games/doudizhu/', page.url()).href);
    await guest.locator('#roomCodeInput').fill(code);
    await guest.locator('#joinForm').getByRole('button').click();
    await expect.poll(() => guestTable.state?.room.code).toBe(code);
    await page.locator('[data-command="roomLevel"][data-level="hell"]').click();
    await expect.poll(() => guestTable.state?.room.difficulty).toBe('hell');
    await guest.locator('[data-command="ready"]').click();
    await expect.poll(() => hostTable.state?.room.players[1]?.ready).toBe(true);
    await page.locator('[data-command="start"]').click();
    await expect.poll(() => hostTable.state?.game?.phase).toBe('bidding');
    await expect.poll(() => guestTable.state?.game?.phase).toBe('bidding');
    expect(hostTable.state!.game!.hand).toHaveLength(17);
    expect(guestTable.state!.game!.hand).toHaveLength(17);
    expect(hostTable.state!.game!.hand).not.toEqual(guestTable.state!.game!.hand);
    for (const snapshot of [hostTable.state!, guestTable.state!]) {
      expect(Object.hasOwn(snapshot.game!, 'hands')).toBe(false);
      expect(Object.hasOwn(snapshot.game!, 'seed')).toBe(false);
      expect(snapshot.game!.bottom).toEqual([]);
    }
    // The first bidder may be the bot; wait for an actionable human turn.
    await expect.poll(async () => hostTable.state?.game?.phase === 'playing'
      || await page.locator('[data-command="bid"][data-score="3"]').isEnabled()
      || await guest.locator('[data-command="bid"][data-score="3"]').isEnabled()).toBe(true);
    if (hostTable.state?.game?.phase === 'bidding') {
      const bidder = await page.locator('[data-command="bid"][data-score="3"]').isEnabled() ? page : guest;
      await bidder.locator('[data-command="bid"][data-score="3"]').click();
    }
    await expect.poll(() => hostTable.state?.game?.phase).toBe('playing');
    await page.locator('#chatButton').click();
    await page.locator('[data-command="reaction"][data-key="hello"]').click();
    await expect.poll(() => guestTable.messages.some(message => message.type === 'reaction' && message.key === 'hello')).toBe(true);
    const before = await hand(page);
    await page.reload();
    await expect(page.locator('#hand .card')).toHaveCount(before.length);
    expect(await hand(page)).toEqual(before);
    expect(new URL(page.url()).searchParams.get('room')).toBe(code);
    await capture(page, info, 'doudizhu-online');
  } finally { await guestContext.close(); }
});

test('斗地主长牌型：16 张飞机带翅膀、提示与不出、桌面和触屏布局', async ({ page }, info) => {
  const take = (ranks: number[], copies: number) => ranks.flatMap(rank => DECK.filter(id => rankOf(id) === rank).slice(0, copies));
  const played = [...take([7, 8, 9, 10], 3), ...take([3, 4, 5, 6], 1)];
  const pool = DECK.filter(id => !played.includes(id));
  let state: GameState = { ...createGame({ seed: 99 }), phase: 'playing', landlordSeat: 1, turn: 1, highestBid: 3, bids: [0, 3, 0],
    hands: [sortCards(pool.slice(4, 21)), sortCards([...played, ...pool.slice(0, 4)]), sortCards(pool.slice(21))], bottom: pool.slice(0, 3) };
  for (const [seat, action] of [[1, { type: 'play', cards: played }], [2, { type: 'pass' }]] as const) {
    const result = applyAction(state, seat, action.type === 'play' ? { type: 'play', cards: [...action.cards] } : action);
    expect(result.ok).toBe(true); if (result.ok) state = result.state;
  }
  const players: PlayerInfo[] = [0, 1, 2].map(seat => ({ id: `dense-${seat}`, nickname: ['你的座位', '长牌型玩家', '牌友'][seat], seat,
    isBot: false, ready: true, connected: true, auto: false, rematchReady: false, avatar: ['queen', 'raven', 'joker-green'][seat] }));
  let revision = 0;
  await page.routeWebSocket('**/ws/doudizhu', route => {
    const publish = () => route.send(JSON.stringify({ type: 'state', revision: ++revision, serverNow: Date.now(),
      room: { code: '888888', hostId: players[0].id, players, round: 1, difficulty: 'hard', autoFill: true },
      me: { id: players[0].id, seat: 0 }, game: { ...publicState(state, 0), deadline: Date.now() + 30000 } } satisfies Response<'state'>));
    route.onMessage(raw => {
      const message = serverProtocol.decode(JSON.parse(String(raw)));
      if (message.type === 'hello') { route.send(JSON.stringify({ type: 'welcome', token: 'dense-fixture-only', playerId: players[0].id, roomCode: '888888', serverNow: Date.now() })); publish(); }
      if (message.type === 'action' && message.data) {
        const result = applyAction(state, 0, message.data);
        if (result.ok) { state = result.state; publish(); }
      }
    });
  });
  await page.goto('/games/doudizhu/');
  await expect(page.locator('#hand .card')).toHaveCount(17);
  await expect(page.locator('#playRight .card')).toHaveCount(16);
  await page.locator('[data-command="pass"]').click();
  await expect(page.locator('#playSelf')).toContainText('不出');
  await capture(page, info, 'doudizhu-long-play');
});

test('斗地主完整对局：游客登录接回、退出续局、托管结算、账号战绩与再来一局', async ({ page }, info) => {
  test.setTimeout(150000);
  const table = await observeTable(page);
  await page.goto('/games/doudizhu/');
  await page.locator('#soloButton').click();
  await expect(page.locator('#hand .card')).toHaveCount(17);
  const before = await hand(page);
  const code = new URL(page.url()).searchParams.get('room');
  const username = await register(page, 'ddz');
  await expect(page.locator('#selfPlayer .player-name')).toContainText('测试牌友');
  expect(await hand(page)).toEqual(before);
  await page.locator('.ac-chip').click();
  await page.locator('.ac-panel').getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.locator('.ac-chip')).toContainText('登录 / 注册');
  await page.reload();
  await expect(page.locator('#hand .card')).toHaveCount(17);
  expect(await hand(page)).toEqual(before); expect(new URL(page.url()).searchParams.get('room')).toBe(code);
  await page.locator('.ac-chip').click();
  await expect(page.locator('#acUsername')).toBeFocused();
  await page.locator('#acUsername').fill(username); await page.locator('#acPassword').fill('playwright-24-password');
  await expect(page.locator('#acUsername')).toHaveValue(username);
  await expect(page.locator('#acPassword')).toHaveValue('playwright-24-password');
  await page.locator('#acSubmit').click();
  await expect(page.locator('.ac-chip')).toContainText('测试牌友');
  await expect(page.locator('#selfPlayer .player-name')).toContainText('测试牌友');
  await expect(page.locator('#connectionBanner')).toBeHidden();
  await expect.poll(() => table.state?.room.players[0]?.nickname).toBe('测试牌友');
  if (info.project.use.hasTouch) await page.locator('#autoButton').tap();
  else await page.locator('#autoButton').click();
  await expect.poll(() => table.sent.filter(message => message.type === 'auto').map(message => message.data)).toContainEqual({ enabled: true });
  await expect.poll(() => table.state?.room.players[table.state.me.seat]?.auto).toBe(true);
  await expect(page.locator('#autoButton')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#resultDialog')).toBeVisible({ timeout: 120000 });
  await expect.poll(() => page.evaluate(() => window.accountUI?.getStats()?.games)).toBe(1);
  expect(table.state?.game?.phase).toBe('ended');
  expect(table.state?.game?.revealedHands).toBeTruthy();
  await capture(page, info, 'doudizhu-result');
  const round = table.state!.room.round;
  await page.locator('#resultDialog [data-command="rematch"]').click();
  await expect.poll(() => table.state?.room.round).toBe(round + 1);
  await expect(page.locator('#hand .card')).toHaveCount(17);
});
