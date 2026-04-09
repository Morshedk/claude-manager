/**
 * feat-watchdog-panel-reload: Panel Survives Browser Reload — Still Reachable
 *
 * Test Design: 03-test-designs.md Test 3
 * Port: 3212
 *
 * Verifies that WatchdogPanel is still reachable after a full browser page reload.
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3212;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'feat-watchdog-reload');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('feat-watchdog-panel-reload — Panel survives browser reload', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-wd-reload-XXXXXX').toString().trim();
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
      body: JSON.stringify({ name: 'WD-Reload-TestProject', path: '/tmp' }),
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

  test('WatchdogPanel still reachable after page reload', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));

    // === First visit ===
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Click project
    const projectItem = page.locator('.project-item, [data-project-id], .sidebar-project').first();
    if (await projectItem.count() > 0) {
      await projectItem.click();
    } else {
      await page.click('text=WD-Reload-TestProject');
    }
    await page.waitForTimeout(800);

    // Click Watchdog tab
    await expect(page.locator('#watchdog-tab-btn')).toBeVisible({ timeout: 5000 });
    await page.locator('#watchdog-tab-btn').click();
    await page.waitForTimeout(600);

    // Verify panel visible before reload
    await expect(page.locator('#watchdog-panel-container')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-before-reload.png') });

    // === Reload ===
    consoleErrors.length = 0; // Reset error collection
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // After reload, tab state resets to 'sessions' — click project again then Watchdog tab
    const projectItem2 = page.locator('.project-item, [data-project-id], .sidebar-project').first();
    if (await projectItem2.count() > 0) {
      await projectItem2.click();
    } else {
      await page.click('text=WD-Reload-TestProject');
    }
    await page.waitForTimeout(800);

    // Watchdog tab must still be present
    await expect(page.locator('#watchdog-tab-btn')).toBeVisible({ timeout: 5000 });
    await page.locator('#watchdog-tab-btn').click();
    await page.waitForTimeout(600);

    // Panel must still render
    await expect(page.locator('#watchdog-panel-container')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-after-reload.png') });

    // Filter out expected network errors from missing watchdog logs endpoint
    const filteredErrors = consoleErrors.filter(e =>
      !e.includes('watchdog') && !e.includes('Not available') && !e.includes('404') && !e.includes('Failed to fetch')
    );
    expect(filteredErrors).toHaveLength(0);

    await browser.close();
  });
});
