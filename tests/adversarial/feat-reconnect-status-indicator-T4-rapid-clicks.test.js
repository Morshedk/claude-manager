/**
 * T-4 (adversarial): Rapid clicks while disconnected — only one socket per real close
 *
 * Ten rapid clicks on the reconnect button while the server is down must produce
 * AT MOST ONE new WebSocket URL (not ten). Total WS count across the test must be ≤ 4.
 *
 * Port: 3204
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3204;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-reconnect-indicator-T4');

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

test.describe('T-4 — Rapid clicks while disconnected: at most one new socket', () => {
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

  test('10 rapid clicks while disconnected produce at most 1 new WebSocket; total WS count ≤ 4', async () => {
    test.setTimeout(60000);

    const serverProc = spawnServer(dataDir, PORT);
    serverProc.stdout.on('data', d => process.stdout.write(`  [T4-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T4-srv:ERR] ${d}`));

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    });

    try {
      await waitForServerReady(PORT, 15000);
      console.log(`  [T-4] Server ready (pid=${serverProc.pid})`);

      // Step 2: Set up WS URL capture
      const wsEvents = [];

      const context = await browser.newContext();
      const page = await context.newPage();

      page.on('websocket', ws => {
        wsEvents.push({ url: ws.url(), t: Date.now() });
        console.log(`  [T-4] WS opened: ${ws.url()} at t=${Date.now()}`);
      });

      // Step 3: Navigate and connect
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('.status-dot.connected', { timeout: 10000 });
      console.log('  [T-4] Connected ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-connected.png') });

      // Snapshot initial count (expect 1)
      const initialCount = wsEvents.length;
      console.log(`  [T-4] Initial WS count: ${initialCount}`);
      expect(initialCount, 'Should have exactly 1 WS connection on initial load').toBe(1);

      // Step 4: Kill server
      console.log(`  [T-4] Killing server pid=${serverProc.pid}`);
      try { process.kill(serverProc.pid, 'SIGKILL'); } catch {}

      // Wait for error state and button
      await page.waitForSelector('.status-dot.error', { timeout: 8000 });
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.system-status');
          return el && el.tagName === 'BUTTON';
        },
        { timeout: 8000 }
      );
      console.log('  [T-4] Disconnected, button visible ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-disconnected.png') });

      // Step 5: Rapid-click the button 10 times while server is still down
      const buttonLocator = page.locator('button.system-status');
      await buttonLocator.waitFor({ state: 'visible', timeout: 5000 });

      console.log('  [T-4] Rapid-clicking 10 times...');
      for (let i = 0; i < 10; i++) {
        await buttonLocator.click({ force: true });
      }
      console.log('  [T-4] 10 clicks done');

      // Step 6: Wait 500ms
      await sleep(500);

      // Step 7: Count new WS URLs created since snapshot
      const wsCountAfterClicks = wsEvents.length;
      const newWsDuringClicks = wsCountAfterClicks - initialCount;
      console.log(`  [T-4] WS count after rapid clicks: ${wsCountAfterClicks} (${newWsDuringClicks} new)`);

      // Hard assertion: NOT MORE THAN 1 new URL from 10 clicks
      expect(newWsDuringClicks, '10 rapid clicks must produce at most 1 new WS (not 10 — guard must be working)').toBeLessThanOrEqual(1);
      console.log(`  [T-4] Rapid-click guard: ${newWsDuringClicks} new sockets (≤1) ✓`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-after-clicks.png') });

      // Step 8: Restart server and wait for auto-reconnect or next click reconnect
      const serverProc2 = spawnServer(dataDir, PORT);
      serverProc2.stdout.on('data', d => process.stdout.write(`  [T4-srv2] ${d}`));
      serverProc2.stderr.on('data', d => process.stdout.write(`  [T4-srv2:ERR] ${d}`));

      try {
        await waitForServerReady(PORT, 15000);
        console.log(`  [T-4] Server restarted (pid=${serverProc2.pid})`);

        // Wait for reconnect (auto-retry from close handler or manual click)
        await page.waitForSelector('.status-dot.connected', { timeout: 10000 });
        console.log('  [T-4] Reconnected after server restart ✓');
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-reconnected.png') });

        // Step 9: Final assertion on total WS count
        const totalWsCount = wsEvents.length;
        console.log(`  [T-4] Total WS URLs: ${totalWsCount}`);
        console.log('  [T-4] All WS URLs:', wsEvents.map(e => e.url));

        // ≤ 4 total: 1 initial + 1 from rapid clicks + 2 from possible interleaved retry
        expect(totalWsCount, `Total WS count must be ≤ 4, but got ${totalWsCount}. If 11+ then guard is broken.`).toBeLessThanOrEqual(4);
        console.log(`  [T-4] Total WS count: ${totalWsCount} ≤ 4 ✓`);

        console.log('  [T-4] ALL ASSERTIONS PASSED');

      } finally {
        try { process.kill(serverProc2.pid, 'SIGKILL'); } catch {}
      }

    } finally {
      await browser.close();
      try { process.kill(serverProc.pid, 'SIGKILL'); } catch {}
    }
  });
});
