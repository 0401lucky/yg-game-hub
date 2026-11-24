import { defineConfig } from '@playwright/test';

const externalBase = process.env.E2E_BASE_URL;
const baseURL = externalBase || 'http://127.0.0.1:3139';
export default defineConfig({
  testDir: './tests/e2e',
  globalTeardown: externalBase ? undefined : './tests/e2e/globalTeardown.ts',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : 3,
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }], ['html', { open: 'never' }]],
  use: {
    baseURL,
    actionTimeout: 10000,
    navigationTimeout: 20000,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'landscape', use: { browserName: 'chromium', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true } },
  ],
  webServer: externalBase ? undefined : {
    command: 'node tools/test-server.ts',
    url: baseURL + '/api/auth/me',
    env: { PORT: '3139' },
    reuseExistingServer: false,
    timeout: 20000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
