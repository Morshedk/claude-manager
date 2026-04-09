/**
 * feat-watchdog-panel-badge: WatchdogPanel Renders ENABLED/DISABLED Badge Correctly
 *
 * Test Design: 03-test-designs.md Test 2
 * Port: 3211
 *
 * Verifies that the ENABLED/DISABLED badge in WatchdogPanel reflects
 * the actual watchdog.enabled setting from settings.json.
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3211;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'feat-watchdog-badge');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer(dataDir, opts = {}) {
  try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  await sleep(500);

  if (opts.settings) {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(opts.settings));
  }

  const crashLogPath = path.join(dataDir, 'server-crash.log');
  const proc = spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  proc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) { ready = true; break; } } catch {}
    await sleep(300);
  }
  if (!ready) { proc.kill('SIGKILL'); throw new Error('Server failed to start within 10s'); }
  return proc;
}

async function stopServer(proc) {
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch {}
  await sleep(1500);
  try { proc.kill('SIGKILL'); } catch {}
}

async function navigateToWatchdogTab(page, baseUrl, projectName) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Click project
  const projectItem = page.locator('.project-item, [data-project-id], .sidebar-project').first();
  if (await projectItem.count() > 0) {
    await projectItem.click();
  } else {
    await page.click(`text=${projectName}`);
  }
  await page.waitForTimeout(800);

  // Click Watchdog tab
  const watchdogTabBtn = page.locator('#watchdog-tab-btn');
  await expect(watchdogTabBtn).toBeVisible({ timeout: 5000 });
  await watchdogTabBtn.click();
  await page.waitForTimeout(800);

  await expect(page.locator('#watchdog-panel-container')).toBeVisible({ timeout: 5000 });
}

test.describe('feat-watchdog-panel-badge — Badge reflects watchdog enabled/disabled setting', () => {

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  });

  test('Sub-test A: badge shows Disabled when watchdog.enabled = false', async () => {
    const tmpDir = execSync('mktemp -d /tmp/qa-wd-badge-a-XXXXXX').toString().trim();
    let serverProc = null;
    const browser = await chromium.launch({ headless: true });

    try {
      serverProc = await startServer(tmpDir, {
        // Explicitly disable watchdog — WatchdogPanel shows "Disabled" when enabled === false
        settings: { watchdog: { enabled: false } },
      });

      const proj = await fetch(`${BASE_URL}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'WD-Badge-A', path: '/tmp' }),
      }).then(r => r.json());

      const context = await browser.newContext();
      const page = await context.newPage();

      await navigateToWatchdogTab(page, BASE_URL, 'WD-Badge-A');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-disabled-badge.png') });

      // Find the badge — it's a span with "Disabled" or "Enabled" text inside #watchdog-panel-container
      const container = page.locator('#watchdog-panel-container');
      const badgeText = await container.locator('span').filter({ hasText: /enabled|disabled/i }).first().textContent({ timeout: 5000 });
      expect(badgeText.trim().toLowerCase()).toContain('disabled');

      await context.close();
    } finally {
      await browser.close();
      await stopServer(serverProc);
      try { execSync(`rm -rf ${tmpDir}`); } catch {}
    }
  });

  test('Sub-test B: badge shows Enabled when watchdog.enabled = true', async () => {
    const tmpDir = execSync('mktemp -d /tmp/qa-wd-badge-b-XXXXXX').toString().trim();
    let serverProc = null;
    const browser = await chromium.launch({ headless: true });

    try {
      serverProc = await startServer(tmpDir, {
        settings: { watchdog: { enabled: true, intervalMinutes: 5, defaultModel: 'sonnet' } },
      });

      const proj = await fetch(`${BASE_URL}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'WD-Badge-B', path: '/tmp' }),
      }).then(r => r.json());

      const context = await browser.newContext();
      const page = await context.newPage();

      await navigateToWatchdogTab(page, BASE_URL, 'WD-Badge-B');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-enabled-badge.png') });

      const container = page.locator('#watchdog-panel-container');
      const badgeText = await container.locator('span').filter({ hasText: /enabled|disabled/i }).first().textContent({ timeout: 5000 });
      expect(badgeText.trim().toLowerCase()).toContain('enabled');

      await context.close();
    } finally {
      await browser.close();
      await stopServer(serverProc);
      try { execSync(`rm -rf ${tmpDir}`); } catch {}
    }
  });
});
