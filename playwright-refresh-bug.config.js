// @ts-check
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './tests/adversarial',
  testMatch: ['**/refresh-bug-*.test.js'],
  timeout: 120_000,
  retries: 0,
  workers: 1, // sequential — each test has its own isolated server
  reporter: [['line']],
  use: {
    headless: true,
    launchOptions: {
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
