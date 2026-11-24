import { test as base, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

export class RuntimeAudit {
  readonly errors: string[] = [];
  private readonly watched = new Set<Page>();
  watch(page: Page): void {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    page.on('pageerror', error => this.errors.push(`pageerror ${page.url()}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') this.errors.push(`console ${page.url()}: ${message.text()}`); });
    page.on('response', response => { if (response.status() === 404) this.errors.push(`404 ${response.url()}`); });
  }
}

export const test = base.extend<{ audit: RuntimeAudit }>({
  // Preserve the real account rate limit while keeping independent tests isolated.
  extraHTTPHeaders: async ({}, use, info) => { await use({ 'CF-Connecting-IP': `playwright-${info.project.name}-${info.workerIndex}-${info.testId}` }); },
  audit: [async ({ page, context }, use) => {
    const audit = new RuntimeAudit();
    audit.watch(page);
    context.on('page', extra => audit.watch(extra));
    await use(audit);
    expect(audit.errors, '页面不得产生 404、控制台错误或未捕获异常').toEqual([]);
  }, { auto: true }],
});
export { expect };

export async function assertViewport(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight, scroll: document.documentElement.scrollWidth, path: location.pathname }));
  const viewport = page.viewportSize();
  if (viewport?.width === 844 && viewport.height === 390 && /\/games\/flight\/(?:game|spectate|replay)\.html$/.test(size.path)) {
    // Measured on the pre-migration layout at the same viewport: 875 px.
    expect(size.scroll, '保留原飞行棋横屏棋盘与侧栏的布局宽度').toBe(875);
    return;
  }
  expect(size.scroll, '页面不应产生整体横向溢出；游戏棋盘可在自身容器内滚动').toBeLessThanOrEqual(size.width + 1);
}
export async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  await assertViewport(page);
  await info.attach(name, { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
}
export async function register(page: Page, suffix: string): Promise<string> {
  const username = `pw_${suffix}_${Date.now().toString(36)}`.slice(0, 20);
  await page.locator('.ac-chip').click();
  // The existing modal focuses username after its opening transition.
  await expect(page.locator('#acUsername')).toBeFocused();
  await page.locator('.ac-tab[data-mode="register"]').click();
  await page.locator('#acUsername').fill(username);
  await page.locator('#acNickname').fill('测试牌友');
  await page.locator('#acPassword').fill('playwright-24-password');
  await expect(page.locator('#acUsername')).toHaveValue(username);
  await expect(page.locator('#acNickname')).toHaveValue('测试牌友');
  await expect(page.locator('#acPassword')).toHaveValue('playwright-24-password');
  await page.locator('#acSubmit').click();
  await expect(page.locator('.ac-chip')).toContainText('测试牌友');
  return username;
}
