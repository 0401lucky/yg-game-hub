import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { HubRoom } from '../../web/operationsProtocol.ts';
import { capture } from './fixtures.ts';

const KEY = 'isolated-admin-key-24';
const runtimeErrors = new WeakMap<Page, string[]>();
test.use({ extraHTTPHeaders: { 'CF-Connecting-IP': 'operations-browser-tests' } });
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; runtimeErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() === 404) errors.push(`404 ${response.url()}`); });
});
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

async function login(page: Page): Promise<void> {
  await expect(page.locator('#adminLogin')).toBeEnabled();
  await page.locator('#adminKey').fill(KEY); await page.locator('#adminLogin').click();
  await expect(page.locator('#adminContent')).toBeVisible();
  await expect(page.locator('.admin-game-card')).toHaveCount(4);
  await page.locator('#autoRefresh').uncheck();
}

test('运营面板：错误密钥被拒绝、验证后加载、刷新保留会话、退出后重新验证', async ({ page, context }, info) => {
  const overviewRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/overview') overviewRequests.push(request.url()); });
  await page.goto('/admin');
  await expect(page.locator('#adminGate')).toBeVisible(); await expect(page.locator('#adminContent')).toBeHidden();
  await expect(page.locator('#adminLogin')).toBeEnabled(); expect(overviewRequests).toHaveLength(0);
  expect((await page.request.get('/api/stats')).status()).toBe(401);
  await page.locator('#adminKey').fill('wrong-management-key'); await page.locator('#adminKeyToggle').click();
  await expect(page.locator('#adminKey')).toHaveAttribute('type', 'text');
  await page.locator('#adminKeyToggle').click(); await page.locator('#adminLogin').click();
  await expect(page.locator('#adminGateMessage')).toContainText('管理密钥不正确');
  await expect(page.locator('#adminContent')).toBeHidden(); expect(overviewRequests).toHaveLength(0);
  await login(page);
  const cookie = (await context.cookies()).find(cookie => cookie.name === 'yg_admin_session');
  expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Strict'); expect(cookie?.path).toBe('/api');
  expect(await page.locator('#adminKey').inputValue()).toBe('');
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(KEY);
  await page.locator('.history-details summary').click(); await expect(page.locator('#historyRows tr')).toHaveCount(7);
  await page.locator('#cleanupButton').click(); await expect(page.locator('#cleanupDialog')).toBeVisible();
  await page.locator('#cancelCleanup').click(); await expect(page.locator('#cleanupDialog')).toBeHidden();
  await page.locator('#cleanupButton').click(); await page.locator('#confirmCleanup').click();
  await expect(page.locator('#opsFeedback')).toContainText('已清理'); await expect(page.locator('#cleanupDialog')).toBeHidden();
  await page.reload(); await expect(page.locator('#adminContent')).toBeVisible(); await expect(page.locator('.admin-game-card')).toHaveCount(4);
  await capture(page, info, 'operations-authenticated');
  await page.locator('#adminLogout').click(); await expect(page.locator('#adminGate')).toBeVisible();
  await expect(page.locator('#adminGateMessage')).toContainText('已退出管理');
  expect((await page.request.get('/api/admin/overview')).status()).toBe(401);
  await page.reload(); await expect(page.locator('#adminGate')).toBeVisible(); await expect(page.locator('#adminContent')).toBeHidden();
});

test('运营面板：入口未配置时关闭；会话失效时隐藏并清除运营数据', async ({ page }) => {
  await page.route('**/api/admin/session', route => route.fulfill({ json: { configured: false, authenticated: false, expiresAt: null } }));
  await page.goto('/admin'); await expect(page.locator('#adminLogin')).toBeDisabled();
  await expect(page.locator('#adminGateMessage')).toContainText('管理入口尚未启用'); await expect(page.locator('#adminContent')).toBeHidden();
  await page.unroute('**/api/admin/session'); await page.reload(); await login(page);
  await page.route('**/api/admin/overview', route => route.fulfill({ status: 401, json: { error: '管理会话已失效' } }));
  await page.locator('#refreshButton').click();
  await expect(page.locator('#adminGate')).toBeVisible(); await expect(page.locator('#adminGateMessage')).toContainText('管理会话已失效');
  await expect(page.locator('#adminContent')).toBeHidden(); await expect(page.locator('#historyRows tr')).toHaveCount(0);
  await expect(page.locator('#onlineUsers')).toBeEmpty(); await expect(page.locator('#roomsGrid')).toBeEmpty();
});

function sampleRooms(): HubRoom[] {
  const now = Date.now();
  const player = { nickname: '周末牌友', isAI: false, connected: true, isHost: true, ready: true };
  const base: HubRoom = { gameId: 'flight', code: 'ABCD', name: '周末一起飞', mode: '经典 · 4 枚棋子', state: 'waiting', phaseLabel: '等待开局',
    players: [player], capacity: 4, createdAt: now, isPrivate: false, joinUrl: '/games/flight/?room=ABCD', spectateUrl: null };
  return [base,
    { ...base, code: 'EFGH', name: '朋友的对局', state: 'playing', phaseLabel: '对局中', joinUrl: null, spectateUrl: '/games/flight/spectate.html?room=EFGH' },
    { ...base, code: 'FULL', name: '四人满座', players: [player, player, player, player], joinUrl: null },
    { ...base, gameId: 'doudizhu', code: '123456', name: '晚间牌桌', capacity: 3, mode: '经典斗地主 · 困难人机', joinUrl: '/games/doudizhu/?room=123456',
      players: [{ ...player, nickname: '<img src=x onerror="window.__opsXss=1">' }] },
  ];
}

test('房间列表：游戏、状态和昵称筛选、满房提示、观战入口、复制邀请与更新失败重试', async ({ page, context }, info) => {
  let failure = false;
  let refreshes = 0;
  await page.route('**/api/hub/rooms', route => { refreshes++; return route.fulfill(failure ? { status: 500, json: { error: 'test outage' } }
    : { json: { timestamp: new Date().toISOString(), rooms: sampleRooms() } }); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/rooms.html'); await expect(page.locator('.room-card')).toHaveCount(4); await page.locator('#autoRefresh').uncheck();
  await expect(page.locator('#publicRoomCount')).toHaveText('4'); await expect(page.locator('#joinableRoomCount')).toHaveText('2');
  await expect(page.locator('.room-card img')).toHaveCount(0); expect(await page.evaluate(() => Object.hasOwn(window, '__opsXss'))).toBe(false);
  await page.locator('#roomGame').selectOption('flight'); await expect(page.locator('.room-card')).toHaveCount(3);
  await page.locator('#roomState').selectOption('playing'); await expect(page.locator('.room-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: '观看对局 →' })).toHaveAttribute('href', '/games/flight/spectate.html?room=EFGH');
  await page.locator('#roomState').selectOption('waiting'); await page.locator('#roomSearch').fill('FULL');
  await expect(page.locator('.room-card')).toHaveCount(1); await expect(page.getByRole('button', { name: '房间已满' })).toBeDisabled();
  await page.locator('#roomSearch').fill('不存在的名字'); await expect(page.locator('.ops-empty')).toContainText('没找到符合条件');
  await page.getByRole('button', { name: '清除筛选' }).click(); await expect(page.locator('.room-card')).toHaveCount(4);
  await page.locator('#roomSearch').fill('周末牌友'); await expect(page.locator('.room-card')).toHaveCount(3);
  await page.locator('#roomSearch').fill('ABCD'); const room = page.locator('.room-card[data-room-code="ABCD"]');
  await expect(room.getByRole('link', { name: '加入房间 →' })).toHaveAttribute('href', '/games/flight/?room=ABCD');
  await room.getByRole('button', { name: '复制邀请' }).click(); await expect(page.locator('#opsFeedback')).toContainText('邀请链接已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL('/games/flight/?room=ABCD', page.url()).href);
  await page.locator('#roomSearch').fill(''); await capture(page, info, 'public-room-list');
  failure = true; await page.locator('#refreshButton').click(); await expect(page.locator('#opsFeedback')).toContainText('暂时无法更新');
  await expect(page.locator('.room-card')).toHaveCount(4);
  failure = false; await page.locator('#refreshButton').click(); await expect(page.locator('#connectionStatus')).toHaveText('房间实时更新');
  await page.locator('#autoRefresh').check(); await expect(page.locator('#refreshButton')).toBeEnabled();
  const beforeReturn = refreshes;
  await page.locator('footer').getByRole('link', { name: '回到游戏大厅' }).click(); await page.goBack();
  await expect(page.locator('.room-card')).toHaveCount(4); await expect.poll(() => refreshes).toBeGreaterThan(beforeReturn);
  const afterReturn = refreshes;
  await expect.poll(() => refreshes, { timeout: 8000 }).toBeGreaterThan(afterReturn);
});

test('房间列表的加入按钮可以进入真实斗地主好友房', async ({ page, browser, baseURL }, info) => {
  const hostContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined, isMobile: Boolean(info.project.use.isMobile), hasTouch: Boolean(info.project.use.hasTouch), reducedMotion: 'reduce' });
  const host = await hostContext.newPage();
  try {
    await host.goto(new URL('/games/doudizhu/', baseURL).href); await host.locator('#createButton').click();
    await expect(host.locator('#tableView')).toBeVisible(); await expect(host.locator('#roomLabel')).toContainText(/\d{6}/);
    const code = (await host.locator('#roomLabel').innerText()).match(/\d{6}/)![0];
    await page.goto('/rooms.html'); await page.locator('#roomSearch').fill(code);
    const room = page.locator(`.room-card[data-room-code="${code}"]`); await expect(room).toBeVisible();
    await room.getByRole('link', { name: '加入房间 →' }).click();
    await expect(page.locator('#tableView')).toBeVisible(); await expect(page.locator('#roomLabel')).toContainText(code);
    await expect(page.locator('#waitingPanel')).toContainText('等待开始'); await capture(page, info, 'public-room-joined');
  } finally { await hostContext.close(); }
});
