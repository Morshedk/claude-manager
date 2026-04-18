/**
 * T-3: Same-origin safety — WebSocket URL is built from window.location
 *
 * Verifies that both the initial WS connection and the manual-reconnect WS
 * connect to exactly ws://localhost:3203/, and that connection.js derives
 * its URL from location.host (not a hardcoded URL).
 *
 * Port: 3203
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3203;
const BASE_URL = `http://localhost:${PORT}`;
const EXPECTED_WS_URL = `ws://localhost:${PORT}/`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-reconnect-indicator-T3');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServerReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
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

test.describe('T-3 — Same-origin safety: WebSocket URL built from window.location', () => {
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

  test('both WS URLs match ws://localhost:3203/ exactly; source uses location.host derivation', async () => {
    test.setTimeout(60000);

    const serverProc = spawnServer(dataDir, PORT);
    serverProc.stdout.on('data', d => process.stdout.write(`  [T3-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T3-srv:ERR] ${d}`));

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
    });

    try {
      await waitForServerReady(PORT, 15000);
      console.log(`  [T-3] Server ready (pid=${serverProc.pid})`);

      // Step 2: Set up WebSocket URL capture BEFORE navigating
      const capturedWsUrls = [];

      const context = await browser.newContext();
      const page = await context.newPage();

      page.on('websocket', ws => {
        capturedWsUrls.push(ws.url());
        console.log(`  [T-3] WS opened: ${ws.url()}`);
      });

      // Step 3: Navigate and wait for connected
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('.status-dot.connected', { timeout: 10000 });
      console.log('  [T-3] App connected ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-connected.png') });

      // Step 4: Assert exactly one WS URL, and it equals expected
      expect(capturedWsUrls.length, 'Exactly one WS connection should have been made').toBe(1);
      expect(capturedWsUrls[0], 'Initial WS URL must equal ws://localhost:3203/ exactly').toBe(EXPECTED_WS_URL);
      console.log(`  [T-3] Initial WS URL: "${capturedWsUrls[0]}" ✓`);

      // Step 5: Kill server, wait for error state
      console.log(`  [T-3] Killing server pid=${serverProc.pid}`);
      try { process.kill(serverProc.pid, 'SIGKILL'); } catch {}

      await page.waitForSelector('.status-dot.error', { timeout: 8000 });
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.system-status');
          return el && el.tagName === 'BUTTON';
        },
        { timeout: 8000 }
      );
      console.log('  [T-3] Disconnected, button visible ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-disconnected.png') });

      // Restart server
      const serverProc2 = spawnServer(dataDir, PORT);
      serverProc2.stdout.on('data', d => process.stdout.write(`  [T3-srv2] ${d}`));
      serverProc2.stderr.on('data', d => process.stdout.write(`  [T3-srv2:ERR] ${d}`));

      await waitForServerReady(PORT, 15000);
      console.log(`  [T-3] Server restarted (pid=${serverProc2.pid})`);

      try {
        // Step 6: Click reconnect button
        const buttonLocator = page.locator('button.system-status');
        await buttonLocator.waitFor({ state: 'visible', timeout: 5000 });
        await buttonLocator.click({ force: true });

        // Wait for reconnected
        await page.waitForSelector('.status-dot.connected', { timeout: 5000 });
        console.log('  [T-3] Reconnected after click ✓');
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-reconnected.png') });

        // Step 7: Assert second WS URL also equals expected
        expect(capturedWsUrls.length, 'Exactly two WS connections total').toBe(2);
        expect(capturedWsUrls[1], 'Manual reconnect WS URL must also equal ws://localhost:3203/ exactly').toBe(EXPECTED_WS_URL);
        console.log(`  [T-3] Reconnect WS URL: "${capturedWsUrls[1]}" ✓`);

        // Same protocol, host, port as page origin
        expect(capturedWsUrls[0]).toBe(capturedWsUrls[1]);
        console.log('  [T-3] Both WS URLs are identical ✓');

        // Step 8: Static source assertion — read connection.js directly from disk
        // (Avoids fetch URL confusion; server serves public/ as root, so path would be /js/ws/connection.js)
        const connJsSource = fs.readFileSync(
          path.join(APP_DIR, 'public', 'js', 'ws', 'connection.js'),
          'utf8'
        );

        // Must contain location.host template literal (literal text check on source file)
        const hasLocationHost = connJsSource.includes('location.host');
        expect(hasLocationHost, 'connection.js must derive URL from location.host').toBe(true);
        console.log('  [T-3] connection.js uses location.host ✓');

        // More precise: must use ${proto}//${location.host} pattern in connect()
        const hasProtoTemplate = connJsSource.includes('location.host}');
        expect(hasProtoTemplate, 'connection.js must use template literal with location.host').toBe(true);
        console.log('  [T-3] connection.js template literal confirmed ✓');

        // Must NOT contain a hardcoded ws:// URL as prefix in connect/reconnectNow
        // Check that "ws://" doesn't appear as a standalone string (not inside the template)
        // The template itself starts with ${proto} not ws://, so any raw ws:// is a bug
        const sourceLines = connJsSource.split('\n');
        const hardcodedWsLines = sourceLines.filter(line => {
          // Filter out comments
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
          // Look for hardcoded ws:// (not inside a template ${proto}...)
          return trimmed.includes('"ws://') || trimmed.includes("'ws://") || trimmed.includes('`ws://');
        });

        expect(hardcodedWsLines.length, `connection.js must NOT contain hardcoded ws:// string. Found: ${hardcodedWsLines.join('; ')}`).toBe(0);
        console.log('  [T-3] No hardcoded ws:// URL in connection.js ✓');
        console.log('  [T-3] ALL ASSERTIONS PASSED');

      } finally {
        try { process.kill(serverProc2.pid, 'SIGKILL'); } catch {}
      }

    } finally {
      await browser.close();
      try { process.kill(serverProc.pid, 'SIGKILL'); } catch {}
    }
  });
});
