import { test, expect, capture, register } from './fixtures.ts';

const pages = [
  ['/', '游戏大厅'], ['/rooms.html', '房间列表'], ['/games/flight/', '飞行棋'], ['/games/doudizhu/', '斗地主'], ['/games/minesweeper/', '扫雷'], ['/games/watermelon/', '合成大西瓜'],
  ['/games/flight/stats.html', '统计数据'], ['/games/flight/admin.html', '运营面板'],
] as const;
for (const [path, title] of pages) {
  test(`页面资源与响应式布局 ${path}`, async ({ page }, info) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(title));
    await page.waitForLoadState('networkidle');
    if (path === '/') await expect(page.locator('.hub-card.live')).toHaveCount(4);
    await capture(page, info, 'page');
  });
}

test('共享账号：注册、游戏间识别、退出与重新登录', async ({ page }, info) => {
  await page.goto('/');
  const username = await register(page, info.project.name);
  await page.goto('/games/doudizhu/');
  await expect(page.locator('#nickname')).toHaveValue('测试牌友');
  await page.locator('.ac-chip').click();
  await page.locator('.ac-panel').getByRole('button', { name: '退出登录' }).click();
  await expect(page.locator('.ac-chip')).toContainText('登录 / 注册');
  await page.locator('.ac-chip').click();
  await expect(page.locator('#acUsername')).toBeFocused();
  await page.locator('#acUsername').fill(username);
  await page.locator('#acPassword').fill('playwright-24-password');
  await page.locator('#acSubmit').click();
  await expect(page.locator('.ac-chip')).toContainText('测试牌友');
  await page.goto('/games/minesweeper/');
  await expect(page.locator('#recordAccountNote')).toBeVisible();
});
