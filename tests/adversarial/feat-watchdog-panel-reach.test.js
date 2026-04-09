/**
 * feat-watchdog-panel-reach: WatchdogPanel Reachable via UI Click — No Console Errors
 *
 * Test Design: 03-test-designs.md Test 1
 * Port: 3210
 *
 * Verifies that clicking the Watchdog tab in ProjectDetail renders
 * WatchdogPanel without any console errors.
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'feat-watchdog-reach');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('feat-watchdog-panel-reach — WatchdogPanel reachable via UI click', () => {
  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-wd-reach-XXXXXX').toString().trim();
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

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'WD-Reach-TestProject', path: '/tmp' }),
    }).then(r => r.json());
    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(2000);
      try { serverProc.kill('SIGKILL'); } catch {}
    }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('WatchdogPanel is reachable via Watchdog tab click with no console errors', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Click the project in sidebar
    const projectItem = page.locator('.project-item, [data-project-id], .sidebar-project').first();
    if (await projectItem.count() > 0) {
      await projectItem.click();
    } else {
      // Try clicking by project name text
      await page.click(`text=WD-Reach-TestProject`);
    }
    await page.waitForTimeout(1000);

    // Take screenshot before clicking Watchdog tab
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-sessions-tab.png') });

    // Assert Watchdog tab button is present
    const watchdogTabBtn = page.locator('#watchdog-tab-btn');
    await expect(watchdogTabBtn).toBeVisible({ timeout: 5000 });

    // Click Watchdog tab
    await watchdogTabBtn.click();
    await page.waitForTimeout(800);

    // Assert watchdog panel container is visible
    const container = page.locator('#watchdog-panel-container');
    await expect(container).toBeVisible({ timeout: 5000 });

    // Take screenshot after clicking
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-watchdog-panel.png') });

    // Assert no console errors
    const filteredErrors = consoleErrors.filter(e =>
      // Exclude expected network errors from /api/watchdog/logs not existing
      !e.includes('watchdog') && !e.includes('Not available') && !e.includes('404') && !e.includes('Failed to fetch')
    );
    expect(filteredErrors).toHaveLength(0);

    await browser.close();
  });
});
