// @ts-check
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './tests/adversarial',
  testMatch: [
    'feat-reconnect-status-indicator-T1-connected-not-clickable.test.js',
    'feat-reconnect-status-indicator-T2-click-triggers-reconnect.test.js',
    'feat-reconnect-status-indicator-T3-same-origin-safety.test.js',
    'feat-reconnect-status-indicator-T4-rapid-clicks.test.js',
  ],
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['line']],
  use: {
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
