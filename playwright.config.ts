import { defineConfig } from '@playwright/test';

// Locally the tests run in the installed Edge/Chrome (PW_CHANNEL=msedge|chrome); CI uses Playwright's own Chromium.
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5178',
    channel,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Software WebGL2 so the painter runs on machines without a GPU (CI).
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5178 --strictPort',
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
