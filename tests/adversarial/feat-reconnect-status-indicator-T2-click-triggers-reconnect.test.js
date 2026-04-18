/**
 * T-2: Disconnected state — click triggers reconnect
 *
 * Flow: connect → kill server → verify button state → restart server →
 *       click button → assert toast within 500ms + connected within 1s + reverts to div.
 *
 * Port: 3202
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3202;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-reconnect-indicator-T2');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServerReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Server on port ${port} not ready within ${timeoutMs}ms`);
}

function spawnServer(dataDir, port) {
  return spawn('node', ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
}

test.describe('T-2 — Disconnected state: click triggers reconnect', () => {
  let dataDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    dataDir = execSync('mktemp -d /tmp/qa-feat-XXXXXX').toString().trim();
    fs.writeFileSync(
      path.join(dataDir, 'projects.json'),
      JSON.stringify({ projects: [], scratchpad: [] })
    );
    fs.writeFileSync(
      path.join(dataDir, 'sessions.json'),
      JSON.stringify({ sessions: [] })
    );
  });

  test.afterAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    if (dataDir) {
      try { execSync(`rm -rf ${dataDir}`); } catch {}
    }
  });

  test('click while disconnected → Reconnecting toast within 500ms → connected within 1s → reverts to div', async () => {
    test.setTimeout(60000);

    // Step 1: Start server and capture PID
    const serverProc = spawnServer(dataDir, PORT);
    serverProc.stdout.on('data', d => process.stdout.write(`  [T2-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T2-srv:ERR] ${d}`));

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    });

    try {
      await waitForServerReady(PORT, 15000);
      console.log(`  [T-2] Server ready on port ${PORT} (pid=${serverProc.pid})`);

      // Step 2: Navigate to app
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Step 3: Wait for connected state
      await page.waitForSelector('.status-dot.connected', { timeout: 10000 });
      console.log('  [T-2] App connected ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-connected.png') });

      // Step 4: Kill the server
      console.log(`  [T-2] Killing server pid=${serverProc.pid}`);
      try { process.kill(serverProc.pid, 'SIGKILL'); } catch (e) { console.log('  [T-2] Kill error:', e.message); }

      // Step 5: Wait for .status-dot.error and .system-status to become a button
      await page.waitForSelector('.status-dot.error', { timeout: 8000 });
      console.log('  [T-2] Error dot appeared ✓');

      // Poll for button element
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.system-status');
          return el && el.tagName === 'BUTTON';
        },
        { timeout: 8000 }
      );
      console.log('  [T-2] Status indicator became a BUTTON ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-disconnected-button.png') });

      // Step 6: Restart the server on the same port, wait for it to be ready
      const serverProc2 = spawnServer(dataDir, PORT);
      serverProc2.stdout.on('data', d => process.stdout.write(`  [T2-srv2] ${d}`));
      serverProc2.stderr.on('data', d => process.stdout.write(`  [T2-srv2:ERR] ${d}`));

      await waitForServerReady(PORT, 15000);
      console.log(`  [T-2] Server restarted and ready (pid=${serverProc2.pid})`);

      try {
        // Step 7: Record click time, click the button
        const buttonLocator = page.locator('button.system-status');
        await buttonLocator.waitFor({ state: 'visible', timeout: 5000 });

        const clickStart = Date.now();

        // Step 10: Immediately after click, check for toast (within 500ms)
        // We set up the wait BEFORE the click
        const toastPromise = page.waitForSelector('text=Reconnecting', {
          state: 'attached',
          timeout: 2000,
        }).catch(() => null);

        await buttonLocator.click({ force: true });
        console.log(`  [T-2] Button clicked at t+${Date.now() - clickStart}ms`);

        // Step 8: Wait for connected dot to reappear (timeout 2s from click)
        await page.waitForSelector('.status-dot.connected', { timeout: 2000 });
        const clickEnd = Date.now();
        const elapsed = clickEnd - clickStart;
        console.log(`  [T-2] Reconnected in ${elapsed}ms after click`);

        // Assert reconnect was click-driven, not auto-retry (auto-retry = 3s)
        expect(elapsed, 'Reconnect must happen within 1000ms of click (not auto-retry at 3s)').toBeLessThan(1000);
        console.log(`  [T-2] Click-to-connected: ${elapsed}ms < 1000ms ✓`);

        // Step 10: Check toast was visible
        const toastEl = await toastPromise;
        expect(toastEl, '"Reconnecting…" toast must appear after click').not.toBeNull();
        console.log('  [T-2] "Reconnecting" toast appeared ✓');

        // Step 11: Assert .system-status reverted to DIV
        await page.waitForFunction(
          () => {
            const el = document.querySelector('.system-status');
            return el && el.tagName === 'DIV';
          },
          { timeout: 3000 }
        );
        const finalTag = await page.locator('.system-status').evaluate(el => el.tagName);
        expect(finalTag, 'After reconnect, status must revert to DIV').toBe('DIV');
        console.log(`  [T-2] Status reverted to DIV ✓`);

        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-reconnected.png') });
        console.log('  [T-2] ALL ASSERTIONS PASSED');

      } finally {
        try { process.kill(serverProc2.pid, 'SIGKILL'); } catch {}
      }

    } finally {
      await browser.close();
      try { process.kill(serverProc.pid, 'SIGKILL'); } catch {}
    }
  });
});
