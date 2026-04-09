/**
 * feat-watchdog-panel-500: Adversarial — Panel Handles /api/watchdog/logs 500 Gracefully
 *
 * Test Design: 03-test-designs.md Test 4
 * Port: 3213
 *
 * Intercepts /api/watchdog/logs to return HTTP 500. Verifies the panel
 * renders in degraded-but-functional state with no JS crash.
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3213;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'feat-watchdog-500');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('feat-watchdog-panel-500 — Panel handles /api/watchdog/logs 500 gracefully', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-wd-500-XXXXXX').toString().trim();
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
      body: JSON.stringify({ name: 'WD-500-TestProject', path: '/tmp' }),
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

  test('Panel renders gracefully when /api/watchdog/logs returns 500', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));

    // Intercept /api/watchdog/logs to return 500
    await page.route('**/api/watchdog/logs', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal Server Error' }),
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Navigate to project
    const projectItem = page.locator('.project-item, [data-project-id], .sidebar-project').first();
    if (await projectItem.count() > 0) {
      await projectItem.click();
    } else {
      await page.click('text=WD-500-TestProject');
    }
    await page.waitForTimeout(800);

    // Click Watchdog tab
    await expect(page.locator('#watchdog-tab-btn')).toBeVisible({ timeout: 5000 });
    await page.locator('#watchdog-tab-btn').click();
    await page.waitForTimeout(1000); // Give time for fetch to complete

    // Panel must still be visible (no crash/blank)
    await expect(page.locator('#watchdog-panel-container')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-after-500.png') });

    // Verify no JS errors (network errors from the 500 are expected but should be silently swallowed)
    const filteredErrors = consoleErrors.filter(e =>
      // WatchdogPanel swallows the fetch error — should produce no console errors
      !e.includes('watchdog/logs') &&
      !e.includes('net::ERR') &&
      !e.includes('Failed to fetch') &&
      !e.includes('404') &&
      !e.includes('500')
    );
    expect(filteredErrors).toHaveLength(0);

    // Panel body is still rendered (not blank)
    const container = page.locator('#watchdog-panel-container');
    const containerHtml = await container.innerHTML();
    expect(containerHtml.length).toBeGreaterThan(50); // Panel has content

    // Refresh button should be present and clickable
    const refreshBtn = container.locator('button', { hasText: 'Refresh' });
    await expect(refreshBtn).toBeVisible({ timeout: 3000 });
    // Click refresh — should not throw
    await refreshBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-after-refresh.png') });

    await browser.close();
  });
});
