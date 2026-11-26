import { test, expect, capture, register } from './fixtures.ts';
import type { Page, TestInfo } from '@playwright/test';
import type { WatermelonStatus } from '../../games/watermelon/protocol.ts';
import type { AccountStats } from '../../games/shared/protocol.ts';
import { spawnLevel } from '../../games/watermelon/engine.ts';

async function drop(page: Page, info: TestInfo, fraction = .5): Promise<void> {
  const canvas = page.locator('#gameCanvas'), rect = await canvas.boundingBox();
  if (!rect) throw new Error('果盘未显示');
  const position = { x: rect.width * fraction, y: rect.height * .35 };
  if (info.project.name === 'desktop') await canvas.click({ position });
  else await canvas.tap({ position });
}
async function collect(page: Page): Promise<void> {
  await page.locator('#finishButton').click();
  await expect(page.locator('#confirmDialog')).toBeVisible();
  await page.locator('#confirmButton').click();
  await expect(page.locator('#resultDialog')).toBeVisible();
}

test('西瓜练习：投放、撤回、暂停、刷新续玩与本机收获', async ({ page }, info) => {
  await page.goto('/games/watermelon/');
  await expect(page.locator('#startButton')).toBeEnabled();
  await capture(page, info, 'watermelon-ready');
  await page.locator('#startButton').click();
  await drop(page, info); await expect(page.locator('#moveCount')).toHaveText('1');
  await page.locator('#undoButton').click(); await expect(page.locator('#moveCount')).toHaveText('0');
  await drop(page, info, .35); await expect(page.locator('#moveCount')).toHaveText('1');
  await page.locator('#pauseButton').click(); await expect(page.locator('#pauseOverlay')).toBeVisible();
  const frozen = await page.evaluate(() => localStorage.getItem('yg.watermelon.practice.v1'));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => localStorage.getItem('yg.watermelon.practice.v1'))).toBe(frozen);
  await page.reload(); await expect(page.locator('#pauseOverlay')).toBeVisible();
  await expect(page.locator('#moveCount')).toHaveText('1');
  await page.locator('#pauseOverlay [data-command="resume"]').click();
  await page.waitForTimeout(650); await drop(page, info, .65); await expect(page.locator('#moveCount')).toHaveText('2');
  await collect(page); await expect(page.locator('#resultMoves')).toHaveText('2 颗');
  await expect(page.locator('#resultSaved')).toHaveText('练习成绩已保存在本机');
  await expect(page.locator('#recordGames')).toHaveText('1');
  await capture(page, info, 'watermelon-practice-result');
});

test('西瓜挑战：真实合成、登录接管、账号战绩与重复结算', async ({ page }, info) => {
  await page.goto('/games/watermelon/');
  await page.locator('[data-mode="challenge"]').click();
  await expect(page.locator('#startButton')).toBeEnabled();
  await page.locator('#gameCanvas').focus(); await page.keyboard.press('Space');
  await expect(page.locator('#readyOverlay')).toBeVisible();
  await page.locator('#startButton').click();
  const started = await page.request.get('/api/watermelon/status').then(response => response.json()) as WatermelonStatus;
  const seed = started.active_session!.seed;
  for (let move = 1; move <= 6; move++) {
    await drop(page, info, .28 + spawnLevel(seed, move - 1) * .22); await expect(page.locator('#moveCount')).toHaveText(String(move));
    await page.waitForTimeout(650);
  }
  await expect.poll(async () => Number(await page.locator('#score').textContent())).toBeGreaterThan(0);
  await capture(page, info, 'watermelon-playing');
  await register(page, `melon_${info.project.name}`);
  await expect(page.locator('#recordSource')).toHaveText('账号战绩');
  await expect(page.locator('#pauseOverlay')).toBeVisible();
  await expect(page.locator('#moveCount')).toHaveText('6');
  await page.locator('#pauseOverlay [data-command="resume"]').click();
  await collect(page); await expect(page.locator('#resultMoves')).toHaveText('6 颗');
  await expect(page.locator('#resultSaved')).toHaveText('已保存到你的账号');
  const score = Number(await page.locator('#resultScore').textContent());
  const status = await page.request.get('/api/watermelon/status').then(response => response.json()) as WatermelonStatus;
  expect(status.stats?.bestScore).toBe(score); expect(status.active_session?.result?.moves).toBe(6);
  const active = status.active_session!;
  await page.request.post('/api/watermelon/finish', { data: {
    request_id: crypto.randomUUID(), session_id: active.session_id, base_tick: active.base_tick,
    base_moves: active.base_moves, to_tick: active.base_tick, drops: [], paused: true,
  } });
  const account = await page.request.get('/api/auth/me').then(response => response.json()) as { stats: AccountStats };
  expect(account.stats.byGame.find(game => game.gameId === 'watermelon')?.games).toBe(1);
  expect(account.stats.recent[0].score).toBe(score);
  await capture(page, info, 'watermelon-account-result');
});

test('西瓜挑战：刷新保留尚未同步的投放，恢复后结算一致', async ({ page }, info) => {
  await page.goto('/games/watermelon/'); await page.locator('[data-mode="challenge"]').click();
  await expect(page.locator('#startButton')).toBeEnabled(); await page.locator('#startButton').click();
  await drop(page, info); await expect(page.locator('#moveCount')).toHaveText('1');
  await page.reload(); await expect(page.locator('#pauseOverlay')).toBeVisible();
  await expect(page.locator('#moveCount')).toHaveText('1');
  await page.locator('#pauseOverlay [data-command="resume"]').click(); await collect(page);
  await expect(page.locator('#resultMoves')).toHaveText('1 颗');
  const status = await page.request.get('/api/watermelon/status').then(response => response.json()) as WatermelonStatus;
  expect(status.active_session?.result?.moves).toBe(1);
});
