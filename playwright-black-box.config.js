// @ts-check
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './tests/adversarial',
  testMatch: ['**/qa-black-box-*.test.js'],
  timeout: 120_000,
  retries: 0,
  workers: 1, // sequential — each test has its own server
  reporter: [['line']],
  use: {
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
