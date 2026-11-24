import { test, expect, capture, register } from './fixtures.ts';
import type { Page, Response } from '@playwright/test';
import type { SessionResponse, StatusResponse } from '../../games/minesweeper/protocol.ts';

async function action(page: Page, operation: () => Promise<unknown>): Promise<SessionResponse['session']> {
  const [response] = await Promise.all([
    page.waitForResponse(res => res.url().endsWith('/api/minesweeper/action') && res.request().method() === 'POST'), operation(),
  ]);
  expect(response.status()).toBe(200);
  return (await response.json() as SessionResponse).session;
}
async function start(page: Page): Promise<SessionResponse['session']> {
  await expect(page.locator('#startButton')).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(res => res.url().endsWith('/api/minesweeper/start')), page.locator('#startButton').click()]);
  expect(response.status()).toBe(200);
  await expect(page.locator('#readyOverlay')).toBeHidden();
  return (await response.json() as SessionResponse).session;
}

test('扫雷：首击、工具、插旗、键盘、暂停停表及刷新续玩', async ({ page }, info) => {
  await page.goto('/games/minesweeper/');
  let session = await start(page);
  session = await action(page, () => page.locator('[data-cell="40"]').click());
  expect(session.state.cells[40].display).toBe('revealed'); expect(session.state.status).toBe('playing');
  const hidden = session.state.cells.find(cell => cell.display === 'hidden')!.index;
  await page.locator('#flagTool').click();
  session = await action(page, () => page.locator(`[data-cell="${hidden}"]`).click());
  expect(session.state.flagsUsed).toBe(1);
  await page.locator('#revealTool').click();
  await page.locator(`[data-cell="${hidden}"]`).focus();
  await page.keyboard.press('f');
  await expect(page.locator('#flagTool')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('f');
  session = await action(page, () => page.locator('#pauseButton').click());
  expect(session.paused).toBe(true);
  await expect(page.locator('#pauseOverlay')).toBeVisible();
  const clock = await page.locator('#elapsedTime').innerText();
  await page.waitForTimeout(1200);
  await expect(page.locator('#elapsedTime')).toHaveText(clock);
  session = await action(page, () => page.locator('#pauseOverlay [data-command="resume"]').click());
  expect(session.paused).toBe(false);
  const [response] = await Promise.all([page.waitForResponse(res => res.url().endsWith('/api/minesweeper/status')), page.reload()]);
  expect((await response.json() as StatusResponse).session?.id).toBe(session.id);
  await expect(page.locator('#pauseOverlay')).toBeHidden();
  await capture(page, info, 'minesweeper-classic');
});

test('每日扫雷：同图同起点、开局计时、暂停继续计时和每日布局', async ({ page, browser, audit }, info) => {
  const twinContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: Boolean(info.project.use.isMobile), hasTouch: Boolean(info.project.use.hasTouch) });
  const twin = await twinContext.newPage(); audit.watch(twin);
  try {
    await page.goto('/games/minesweeper/'); await page.locator('[data-mode="daily"]').click();
    const session = await start(page);
    await twin.goto(new URL('/games/minesweeper/', page.url()).href); await twin.locator('[data-mode="daily"]').click();
    const second = await start(twin);
    expect(second.state).toEqual(session.state); expect(session.state.firstRevealDone).toBe(true);
    const paused = await action(page, () => page.locator('#pauseButton').click());
    expect(paused.running).toBe(true);
    const before = paused.elapsedMs;
    await page.waitForTimeout(1200);
    const status = await page.request.get('/api/minesweeper/status').then(res => res.json()) as StatusResponse;
    expect(status.session!.elapsedMs).toBeGreaterThan(before + 900);
    await action(page, () => page.locator('#pauseOverlay [data-command="resume"]').click());
    await capture(page, info, 'minesweeper-daily');
  } finally { await twinContext.close(); }
});

test('扫雷长按与拖动：长按插旗、滑动不误触、较大棋盘与重开确认', async ({ page }, info) => {
  await page.goto('/games/minesweeper/');
  await page.locator('[data-difficulty="hard"]').click();
  let session = await start(page);
  const cell = page.locator('[data-cell="0"]');
  if (info.project.use.hasTouch) {
    await cell.scrollIntoViewIfNeeded();
    const box = (await cell.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const flagged = page.waitForResponse(res => res.url().endsWith('/api/minesweeper/action'));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(550);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    session = (await (await flagged).json() as SessionResponse).session;
    expect(session.state.flagsUsed).toBe(1); expect(session.state.firstRevealDone).toBe(false);
    const other = page.locator('[data-cell="2"]'); await other.scrollIntoViewIfNeeded();
    const next = (await other.boundingBox())!;
    const startPoint = { x: next.x + next.width / 2, y: next.y + next.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [startPoint] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startPoint.x + 28, y: startPoint.y + 12 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const status = await page.request.get('/api/minesweeper/status').then(res => res.json()) as StatusResponse;
    expect(status.session!.revision).toBe(session.revision);
    await cdp.detach();
  } else {
    session = await action(page, () => cell.click({ button: 'right' }));
    expect(session.state.flagsUsed).toBe(1);
  }
  session = await action(page, () => page.locator('[data-cell="136"]').click());
  expect(session.state.status).toBe('playing');
  await page.locator('#restartButton').click();
  await expect(page.locator('#confirmDialog')).toBeVisible();
  const response = page.waitForResponse(res => res.url().endsWith('/api/minesweeper/start'));
  await page.locator('[data-command="confirmStart"]').click();
  expect((await (await response).json() as SessionResponse).session.id).not.toBe(session.id);
  await capture(page, info, 'minesweeper-hard');
});

test('扫雷账号结算：游客局中注册接回、手记落库、再探一片与账号战绩', async ({ page }, info) => {
  await page.goto('/games/minesweeper/');
  let session = await start(page);
  session = await action(page, () => page.locator('[data-cell="40"]').click());
  const id = session.id;
  await register(page, 'mine');
  await expect(page.locator('#recordAccountNote')).toBeVisible();
  await expect.poll(async () => (await page.request.get('/api/minesweeper/status').then(res => res.json()) as StatusResponse).session?.id).toBe(id);
  for (let step = 0; session.state.status === 'playing' && step < 81; step++) {
    const hidden = session.state.cells.find(cell => cell.display === 'hidden');
    expect(hidden).toBeTruthy();
    session = await action(page, () => page.locator(`[data-cell="${hidden!.index}"]`).click());
  }
  expect(session.state.status).not.toBe('playing'); expect(session.result?.recorded).toBe(true);
  await expect(page.locator('#resultDialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.accountUI?.getStats()?.games)).toBe(1);
  await capture(page, info, 'minesweeper-result');
  const response = page.waitForResponse(res => res.url().endsWith('/api/minesweeper/start'));
  await page.locator('#playAgainButton').click();
  expect((await (await response).json() as SessionResponse).session.id).not.toBe(id);
});
