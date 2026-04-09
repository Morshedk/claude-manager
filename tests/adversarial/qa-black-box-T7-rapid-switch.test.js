/**
 * T-7: Rapid session switching does not produce black box (rAF-after-dispose race)
 *
 * When session A's terminal is opened, the fix defers fit() via double-rAF.
 * If the user immediately switches to session B, session A's cleanup runs
 * (xterm.dispose()), but the deferred rAF callback may still fire. This test
 * verifies that rapid switching does not produce a black box or console errors.
 *
 * Port: 3406
 */

import { test, expect, chromium } from 'playwright/test';
import WebSocket from 'ws';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3406;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'black-box-T7');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 10000);
  });
}

function waitForMsg(ws, pred, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('waitForMsg timeout')); }, timeoutMs);
    function h(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (pred(m)) { clearTimeout(t); ws.off('message', h); resolve(m); }
    }
    ws.on('message', h);
  });
}

test.describe('T-7 — Rapid session switching does not produce black box', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionIdA = '';
  let sessionIdB = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-bb-T7-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [T7-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T7-srv:err] ${d}`));

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) break; } catch {}
      await sleep(500);
    }

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T7-Project', path: '/tmp' }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    // Create both sessions on a SINGLE WS connection to avoid the auto-subscribe race.
    // When session A is created, the server auto-subscribes wsA to session A.
    // If wsA closes before wsB connects, the server cleanup can interfere with wsB's
    // connection setup (server-side race: session A output callback fires during wsB's init).
    // Using one WS for both creates avoids this — the server handles both sequentially.
    const wsSetup = await wsConnect(PORT);
    await waitForMsg(wsSetup, m => m.type === 'init');

    // Create session A
    wsSetup.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 't7-bash-A',
      command: 'bash',
      mode: 'direct',
      cwd: '/tmp',
      cols: 120,
      rows: 30,
    }));
    const createdA = await waitForMsg(wsSetup, m => m.type === 'session:created' || m.type === 'session:error', 20000);
    if (createdA.type === 'session:error') throw new Error(`Session A create error: ${createdA.error}`);
    sessionIdA = createdA.session.id;

    // Create session B on the same WS connection
    wsSetup.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 't7-bash-B',
      command: 'bash',
      mode: 'direct',
      cwd: '/tmp',
      cols: 120,
      rows: 30,
    }));
    // Wait for the second session:created (different id from A)
    const createdB = await waitForMsg(
      wsSetup,
      m => (m.type === 'session:created' || m.type === 'session:error') && m.session?.id !== sessionIdA,
      20000
    );
    wsSetup.close();
    if (createdB.type === 'session:error') throw new Error(`Session B create error: ${createdB.error}`);
    sessionIdB = createdB.session.id;

    // Wait for both sessions to be running
    const deadline2 = Date.now() + 15000;
    while (Date.now() < deadline2) {
      const sessions = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
      const all = [...(sessions.managed || []), ...(sessions.detected || [])];
      const sA = all.find(s => s.id === sessionIdA);
      const sB = all.find(s => s.id === sessionIdB);
      const aRunning = sA && (sA.status === 'running' || sA.state === 'running');
      const bRunning = sB && (sB.status === 'running' || sB.state === 'running');
      if (aRunning && bRunning) break;
      await sleep(500);
    }
    console.log(`  [T7] Setup: project=${projectId}, sessionA=${sessionIdA}, sessionB=${sessionIdB}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} await sleep(1000); try { serverProc.kill('SIGKILL'); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('T-7: session B renders correctly after rapid switch from session A', async () => {
    test.setTimeout(90000);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('pageerror', err => {
      consoleErrors.push(`pageerror: ${err.message}`);
      console.log(`  [T7-browser:pageerror] ${err.message}`);
    });
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        consoleErrors.push(text);
        console.log(`  [T7-browser:err] ${text}`);
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      // Click the project
      await page.waitForSelector('text=T7-Project', { timeout: 15000 });
      await page.click('text=T7-Project');
      await page.waitForSelector('.session-card', { timeout: 10000 });
      await sleep(500);

      // The project should now show 2 session cards
      const cardCount = await page.locator('.session-card').count();
      console.log(`  [T7] Session card count: ${cardCount}`);
      expect(cardCount, 'Must have 2 session cards (A and B)').toBeGreaterThanOrEqual(2);

      // Click session A's card (first card)
      const cardA = page.locator('.session-card').nth(0);
      await cardA.click();

      // Wait for overlay to open but do NOT wait for terminal to fully render
      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      console.log('  [T7] Session A overlay opened — waiting for canvas to appear...');

      // Wait for canvas to appear (terminal A is mounting)
      await page.waitForSelector('#session-overlay-terminal .xterm-screen canvas', { timeout: 10000 });
      console.log('  [T7] Session A canvas appeared — immediately switching to session B');

      // Take screenshot just before rapid switch
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-session-a-mounting.png') });

      // Rapid switch: The default UI is split mode (session list visible on left, overlay on right).
      // In split mode, session cards are visible and clickable without closing the overlay.
      // We click session B's card immediately — this triggers session A's cleanup (dispose)
      // while its deferred rAF may still be pending. This is the race condition under test.

      // First, close the current overlay to simulate the user switching sessions.
      // Use the detach button (✕) which is present in the overlay header.
      const detachBtn = page.locator('#btn-detach');
      const detachVisible = await detachBtn.isVisible().catch(() => false);
      if (detachVisible) {
        await detachBtn.click();
        console.log('  [T7] Overlay closed via detach button');
      } else {
        // Fall back: Escape key or direct session card click (split mode)
        await page.keyboard.press('Escape');
        console.log('  [T7] Overlay close attempted via Escape');
      }

      // Minimal wait — the double-rAF for session A is still pending (~2 frames ≈ 33ms)
      // We click session B immediately to trigger the dispose+rAF race
      await sleep(50);

      // Click session B's card (either overlay is closed or we're in split mode)
      const cardB = page.locator('.session-card').nth(1);
      await cardB.click();

      console.log('  [T7] Session B card clicked (rapid switch done)');

      // Wait for session B's overlay and canvas
      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen canvas', { timeout: 10000 });

      // Wait for rows to render
      await page.waitForFunction(() => {
        const rows = document.querySelector('#session-overlay-terminal .xterm-rows');
        return rows && rows.children.length > 2;
      }, { timeout: 15000 }).catch(() => {});

      await sleep(2000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-session-b-after-switch.png') });

      // Send sentinel to session B
      const ws2 = await wsConnect(PORT);
      await waitForMsg(ws2, m => m.type === 'init');
      ws2.send(JSON.stringify({ type: 'session:subscribe', id: sessionIdB, cols: 120, rows: 30 }));
      await waitForMsg(ws2,
        m => (m.type === 'session:subscribed' && m.id === sessionIdB) || (m.type === 'session:output' && m.id === sessionIdB),
        10000
      );
      await sleep(500);
      ws2.send(JSON.stringify({ type: 'session:input', id: sessionIdB, data: 'echo SESSION_B_OK\n' }));

      const markerFound = await page.waitForFunction(() => {
        const rows = document.querySelector('#session-overlay-terminal .xterm-rows');
        return rows && rows.textContent.includes('SESSION_B_OK');
      }, { timeout: 8000 }).then(() => true).catch(() => false);

      ws2.close();
      console.log(`  [T7] SESSION_B_OK marker found in terminal B: ${markerFound}`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-session-b-with-output.png') });

      // Check xterm-screen dimensions
      const screenDims = await page.evaluate(() => {
        const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
        const rect = screen ? screen.getBoundingClientRect() : null;
        return { width: rect ? rect.width : 0, height: rect ? rect.height : 0 };
      });
      console.log('  [T7] Session B screen dims:', JSON.stringify(screenDims));

      // Filter console errors: ignore WebGL errors (expected in headless)
      const criticalErrors = consoleErrors.filter(e =>
        !e.includes('WebGL') &&
        !e.includes('webgl') &&
        !e.includes('CONTEXT_LOST') &&
        !e.includes('WebglAddon') &&
        !e.includes('CanvasAddon') &&
        e.trim().length > 0
      );
      console.log(`  [T7] Critical console errors: ${JSON.stringify(criticalErrors)}`);

      // Assertions
      expect(screenDims.width, 'Session B xterm-screen width must be > 0 after rapid switch').toBeGreaterThan(0);
      expect(screenDims.height, 'Session B xterm-screen height must be > 0 after rapid switch').toBeGreaterThan(0);
      expect(markerFound, 'SESSION_B_OK must appear in session B terminal after rapid switch').toBe(true);
      expect(criticalErrors.length,
        `No critical errors from disposed session A rAF callbacks. Got: ${JSON.stringify(criticalErrors)}`
      ).toBe(0);

      console.log('  [T7] PASS');
    } finally {
      await browser.close();
    }
  });
});
