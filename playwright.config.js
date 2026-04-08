// @ts-check
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/adversarial/B-rendering.test.js', '**/adversarial/F-bug-reproductions.test.js'],
  timeout: 180_000,
  retries: 0,
  workers: 1, // sequential — tests share a single server process
  reporter: [['line'], ['json', { outputFile: 'qa-screenshots/adversarial-B/results.json' }]],
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
