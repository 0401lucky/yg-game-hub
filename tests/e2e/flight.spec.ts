import { test, expect, capture } from './fixtures.ts';

test('本地飞行棋：配置、掷骰、规则、音效及明暗主题持久化', async ({ page }, info) => {
  await page.goto('/games/flight/');
  await page.locator('#menuLocalBtn').click();
  await expect(page.locator('#localStartGameBtn')).toContainText('2人');
  await page.locator('#localStartGameBtn').click();
  await page.waitForURL('**/game.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#diceDisplay')).toBeVisible();
  await page.locator('#diceDisplay').click();
  await expect.poll(() => page.evaluate(() => Object.values(window.gameState?.diceStatistics || {}).flatMap(stats => Object.values(stats)).reduce((sum, n) => sum + n, 0))).toBeGreaterThan(0);
  await page.locator('#showRules').click();
  await expect(page.locator('#rules-modal')).toBeVisible();
  await page.locator('#rules-close').click();
  await expect(page.locator('#rules-modal')).toBeHidden();
  await page.locator('#toggleAudio').click();
  await expect(page.locator('#toggleAudio')).toContainText('开启音效');
  await capture(page, info, 'flight-light');
  await page.locator('.theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForLoadState('networkidle');
  await capture(page, info, 'flight-dark');
});

test('在线飞行棋：双人房、设置、聊天、准备、开局、刷新重连、观战与回放页', async ({ page, browser, audit }, info) => {
  const guestContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: Boolean(info.project.use.isMobile), hasTouch: Boolean(info.project.use.hasTouch), reducedMotion: 'reduce' });
  const guest = await guestContext.newPage(); audit.watch(guest);
  const spectatorContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: Boolean(info.project.use.isMobile), hasTouch: Boolean(info.project.use.hasTouch), reducedMotion: 'reduce' });
  const spectator = await spectatorContext.newPage(); audit.watch(spectator);
  try {
    await page.goto('/games/flight/');
    await page.locator('#menuOnlineBtn').click();
    await page.locator('#createRoomBtn').click();
    await expect(page.locator('#roomCodeDisplay')).toHaveText(/^[A-Z0-9]{4}$/);
    const code = (await page.locator('#roomCodeDisplay').innerText()).trim();
    await page.locator('.piece-count-option[data-count="1"]:visible').click();
    await guest.goto(new URL(`/games/flight/?room=${code}`, page.url()).href);
    await expect(guest.locator('#roomCodeDisplay')).toHaveText(code);
    await page.locator('#roomChatToggleBtn').click();
    await page.locator('#roomChatInput').fill('一起起飞');
    await page.locator('#roomChatInput').press('Enter');
    await expect(guest.locator('#roomChatMessages')).toContainText('一起起飞');
    await guest.locator('#playerReadyBtn').click();
    await expect(page.locator('#multiplayerStartGame')).toBeEnabled();
    await page.locator('#multiplayerStartGame').click();
    await Promise.all([page.waitForURL('**/game.html*'), guest.waitForURL('**/game.html*')]);
    await expect.poll(() => page.evaluate(() => window.gameState?.gamePhase)).toBe('rolling');
    const session = await page.evaluate(() => window.gameInstance?.multiplayerGameManager?.gameSessionId);
    expect(session).toBeTruthy();
    await page.locator('#diceDisplay').click();
    await expect.poll(() => page.evaluate(() => Object.values(window.gameState?.diceStatistics || {}).flatMap(stats => Object.values(stats)).reduce((sum, n) => sum + n, 0))).toBeGreaterThan(0);
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.gameInstance?.multiplayerGameManager?.gameSessionId)).toBe(session);
    await spectator.goto(new URL(`/games/flight/spectate.html?room=${code}`, page.url()).href);
    await expect.poll(() => spectator.evaluate(() => window.gameInstance?.multiplayerGameManager?.isSpectator)).toBe(true);
    await capture(page, info, 'flight-online');
    await capture(spectator, info, 'flight-spectator');
    const replay = await guestContext.newPage(); audit.watch(replay);
    await replay.goto(new URL(`/games/flight/replay.html?id=${session}`, page.url()).href);
    await expect(replay.locator('#diceDisplay')).toBeVisible();
    await replay.waitForLoadState('networkidle');
    await capture(replay, info, 'flight-replay');
  } finally { await guestContext.close(); await spectatorContext.close(); }
});
