/**
 * feat-watchdog-panel-default-tab: Default Tab Is Sessions (Regression Guard)
 *
 * Test Design: 03-test-designs.md Test 5
 * Port: 3214
 *
 * Verifies that Sessions is the default active tab, and that switching tabs
 * correctly shows/hides the session list vs WatchdogPanel + New Session button.
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3214;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'feat-watchdog-default-tab');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('feat-watchdog-panel-default-tab — Default tab is Sessions, switching works correctly', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-wd-default-XXXXXX').toString().trim();
    const crashLogPath = path.join(tmpDir, 'server-crash.log');

    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(300);
    }
    if (!ready) throw new Error('Server failed to start within 10s');

    await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'WD-Default-TestProject', path: '/tmp' }),
    });
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(1500);
      try { serverProc.kill('SIGKILL'); } catch {}
    }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Sessions is default tab; switching to Watchdog hides session list and button; switching back restores them', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Click project
    const projectItem = page.locator('.project-item, [data-project-id], .sidebar-project').first();
    if (await projectItem.count() > 0) {
      await projectItem.click();
    } else {
      await page.click('text=WD-Default-TestProject');
    }
    await page.waitForTimeout(800);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-default-sessions-tab.png') });

    // === Step 1: Default state — Sessions tab active ===
    await expect(page.locator('#project-sessions-list')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#watchdog-panel-container')).toHaveCount(0); // Not in DOM
    // "New Claude Session" button should be visible
    const newSessionBtn = page.locator('button', { hasText: /New Claude Session/i });
    await expect(newSessionBtn).toBeVisible({ timeout: 3000 });

    // === Step 2: Click Watchdog tab ===
    await page.locator('#watchdog-tab-btn').click();
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-watchdog-tab.png') });

    // Session list should be gone
    await expect(page.locator('#project-sessions-list')).toHaveCount(0);
    // Watchdog panel should appear
    await expect(page.locator('#watchdog-panel-container')).toBeVisible({ timeout: 5000 });
    // New Session button should be hidden
    await expect(newSessionBtn).toHaveCount(0);

    // === Step 3: Click Sessions tab — back to sessions ===
    // Find the Sessions tab button (first tab-btn, or button with text "Sessions")
    const sessionsTabBtn = page.locator('.sessions-tab-bar button', { hasText: 'Sessions' });
    await expect(sessionsTabBtn).toBeVisible({ timeout: 3000 });
    await sessionsTabBtn.click();
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-back-to-sessions.png') });

    // Session list restored
    await expect(page.locator('#project-sessions-list')).toBeVisible({ timeout: 5000 });
    // Watchdog panel gone
    await expect(page.locator('#watchdog-panel-container')).toHaveCount(0);
    // New Session button restored
    await expect(newSessionBtn).toBeVisible({ timeout: 3000 });

    await browser.close();
  });
});
