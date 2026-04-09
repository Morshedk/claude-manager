// @ts-check
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './tests/adversarial',
  testMatch: ['**/da-osc-filter-T*.test.js', '**/da-osc-debug*.test.js'],
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['line']],
  use: {
    headless: true,
    launchOptions: {
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
