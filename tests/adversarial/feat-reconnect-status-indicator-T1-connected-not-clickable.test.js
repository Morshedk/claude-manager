/**
 * T-1: Connected state — indicator is NOT clickable
 *
 * Verifies that when connected, .system-status renders as a <div> (not a <button>),
 * has title="Already connected", has no pointer cursor, and clicking produces no toast.
 *
 * Port: 3201
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3201;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-reconnect-indicator-T1');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('T-1 — Connected state: indicator is NOT clickable', () => {
  let serverProc = null;
  let dataDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on this port
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    dataDir = execSync('mktemp -d /tmp/qa-feat-XXXXXX').toString().trim();

    // Seed data files
    fs.writeFileSync(
      path.join(dataDir, 'projects.json'),
      JSON.stringify({ projects: [], scratchpad: [] })
    );
    fs.writeFileSync(
      path.join(dataDir, 'sessions.json'),
      JSON.stringify({ sessions: [] })
    );

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [T1-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T1-srv:ERR] ${d}`));

    // Wait for server ready
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/`);
        if (r.ok) break;
      } catch {}
      await sleep(200);
    }
    console.log(`  [T-1] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    if (dataDir) {
      try { execSync(`rm -rf ${dataDir}`); } catch {}
    }
  });

  test('connected status element is a DIV, not clickable, click produces no toast', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Step 3: Wait for .status-dot.connected visible — confirms WS handshake done
      await page.waitForSelector('.status-dot.connected', { timeout: 10000 });
      console.log('  [T-1] Status dot connected visible');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-connected.png') });

      // Step 4: Locate the status block
      const locator = page.locator('.system-status');
      await locator.waitFor({ state: 'visible', timeout: 5000 });

      // Step 5: Assert element is DIV not BUTTON
      const tagName = await locator.evaluate(el => el.tagName);
      expect(tagName, 'Connected status must be a DIV, not a BUTTON').toBe('DIV');
      console.log(`  [T-1] tagName = ${tagName} ✓`);

      // Step 6: Assert title attribute
      const title = await locator.getAttribute('title');
      expect(title, 'Connected status must have title="Already connected"').toBe('Already connected');
      console.log(`  [T-1] title = "${title}" ✓`);

      // Step 7: Assert no pointer cursor
      const cursor = await locator.evaluate(el => getComputedStyle(el).cursor);
      expect(cursor, 'Connected status must NOT have cursor:pointer').not.toBe('pointer');
      console.log(`  [T-1] cursor = "${cursor}" (not pointer) ✓`);

      // Step 8: Click the element (Playwright allows click on a div)
      await locator.click({ force: true });

      // Step 9: Wait 500ms and assert no toast appeared
      await sleep(500);
      const toastCount = await page.locator('[style*="position:fixed"][style*="bottom"]').count();
      // Also check by text content matching "Reconnecting"
      const reconnectingToast = await page.locator('text=Reconnecting').count();
      expect(reconnectingToast, 'No "Reconnecting" toast should appear when clicking while connected').toBe(0);
      console.log(`  [T-1] No reconnecting toast after click ✓`);

      // Step 10: Assert dot is still connected
      const dotStillConnected = await page.locator('.status-dot.connected').count();
      expect(dotStillConnected, 'Status dot must still be .connected after click').toBeGreaterThan(0);
      console.log(`  [T-1] Dot still connected ✓`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-after-click.png') });

      console.log('  [T-1] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
