/**
 * T-26: Split view — terminal fully functional after toggle
 *
 * Score: L=4 S=3 D=3 (Total: 10)
 *
 * Tests that:
 * - SessionOverlay split/full toggle correctly resizes the terminal
 * - ResizeObserver fires fitAddon.fit() and sends SESSION_RESIZE to PTY
 * - Input/output works in both split and full modes
 * - No zero-dimension terminal after toggle
 *
 * Run: PORT=3123 npx playwright test tests/adversarial/T-26-split-view.test.js --reporter=line --timeout=120000
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
const PORT = 3123;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-26-split-view');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('T-26 — Split view terminal fully functional after toggle', () => {

  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';

  // ── Infrastructure Setup ─────────────────────────────────────────────────

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3123 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Fresh isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-T26-XXXXXX').toString().trim();
    console.log(`\n  [T-26] tmpDir: ${tmpDir}`);

    // Start server
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready — poll GET /api/projects up to 15s
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(500);
    }
    if (!ready) throw new Error('Test server failed to start within 15s');
    console.log(`  [T-26] Server ready on port ${PORT}`);

    // Create test project via REST API
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T26-TestProject', path: '/tmp' }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T-26] Project created: ${testProjectId} (${proj.name})`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(3000);
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    // Print crash log if meaningful
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      const meaningful = crashLog.split('\n').some(line =>
        line.includes('Error') || line.includes('Exception') || line.includes('uncaught') || line.includes('unhandledRejection')
      );
      if (meaningful) console.log('\n  [CRASH LOG]\n' + crashLog);
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Wait for a text marker to appear somewhere in the xterm-rows DOM.
   * Returns true if found within timeoutMs, false otherwise.
   */
  async function waitForTerminalText(page, marker, timeoutMs = 15000) {
    try {
      await page.waitForFunction(
        (m) => {
          const rows = document.querySelector('.xterm-rows');
          return rows && rows.textContent.includes(m);
        },
        marker,
        { timeout: timeoutMs }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get terminal container dimensions and xterm state.
   */
  async function getTerminalDimensions(page) {
    return page.evaluate(() => {
      const container = document.querySelector('.terminal-container');
      const overlay = document.getElementById('session-overlay');
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const overlayRect = overlay ? overlay.getBoundingClientRect() : null;
      const vp = container.querySelector('.xterm-viewport');
      const scrollState = vp && vp._scrollState ? vp._scrollState() : null;
      // Count visible xterm rows
      const rowEls = container.querySelectorAll('.xterm-rows > div');
      return {
        containerWidth: rect.width,
        containerHeight: rect.height,
        overlayLeft: overlayRect ? overlayRect.left : null,
        overlayWidth: overlayRect ? overlayRect.width : null,
        xtermRowCount: rowEls.length,
        scrollState,
        windowWidth: window.innerWidth,
      };
    });
  }

  /**
   * Click into the terminal to focus it, then send input.
   */
  async function typeInTerminal(page, text) {
    // Click the terminal viewport to focus xterm
    const container = page.locator('.terminal-container');
    await container.click();
    await sleep(200);
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  }

  // ── THE MAIN TEST ─────────────────────────────────────────────────────────

  test('T-26 — Split/Full toggle: terminal resizes and input works in both modes', async () => {
    test.setTimeout(120000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();

    // Track WS resize messages
    const resizesSent = [];
    await page.addInitScript(() => {
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'session:resize') {
            window.__t26ResizesSent = window.__t26ResizesSent || [];
            window.__t26ResizesSent.push({ cols: parsed.cols, rows: parsed.rows, ts: Date.now() });
          }
        } catch {}
        return origSend.call(this, data);
      };
    });

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });

    try {
      // ── Navigate to app ──────────────────────────────────────────────
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.setViewportSize({ width: 1280, height: 800 });

      // Wait for WS connected
      await page.waitForFunction(
        () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
              document.body.textContent.includes('Connected'),
        { timeout: 30000 }
      ).catch(() => {}); // Non-fatal — proceed even if connected indicator uses different class
      await sleep(1000);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-initial.png') });
      console.log('  [T-26] App loaded');

      // ── Navigate to test project ─────────────────────────────────────
      await page.waitForSelector('text=T26-TestProject', { timeout: 15000 });
      await page.click('text=T26-TestProject');
      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);

      console.log('  [T-26] Navigated to T26-TestProject');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-project-selected.png') });

      // ── Create session with bash command ─────────────────────────────
      // Click "New Claude Session" button
      const newBtn = page.locator('#sessions-area .area-header button').first();
      await newBtn.click();
      await page.waitForSelector('.modal-overlay', { timeout: 10000 });

      // Fill in session name
      const nameInput = page.locator('.modal .form-input[placeholder="e.g. refactor, auth, bugfix"]');
      await nameInput.fill('t26-split-test');

      // Override command with bash for reliable echo
      const cmdInput = page.locator('.modal .form-input[placeholder="claude"]');
      await cmdInput.fill('bash');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-modal-filled.png') });

      // Submit form
      const submitBtn = page.locator('.modal-footer .btn-primary');
      await submitBtn.click();

      console.log('  [T-26] Session creation submitted (cmd=bash)');

      // Wait for session card to appear in the list
      const sessionCard = page.locator('.session-card').filter({ hasText: 't26-split-test' }).first();
      await sessionCard.waitFor({ state: 'visible', timeout: 15000 });
      console.log('  [T-26] Session card appeared');

      // Wait for session to reach running state before clicking
      await page.waitForFunction(
        () => {
          const cards = Array.from(document.querySelectorAll('.session-card'));
          const card = cards.find(c => c.textContent.includes('t26-split-test'));
          return card && card.textContent.includes('running');
        },
        { timeout: 15000 }
      );
      console.log('  [T-26] Session is running');

      // Click the session card to open the overlay
      await sessionCard.click();
      await sleep(500);

      // Wait for session overlay to appear
      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      console.log('  [T-26] Session overlay appeared');

      // Wait for terminal to be ready (xterm renders rows)
      await page.waitForFunction(
        () => {
          const rows = document.querySelector('.xterm-rows');
          return rows && rows.children.length > 2;
        },
        { timeout: 20000 }
      );
      console.log('  [T-26] Terminal rows rendered');

      // Extra wait for bash to fully initialize
      await sleep(2000);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-terminal-ready.png') });

      // ── Capture baseline dimensions (full mode) ──────────────────────
      const dimsBeforeSplit = await getTerminalDimensions(page);
      console.log(`  [T-26] FULL mode dimensions:`, JSON.stringify(dimsBeforeSplit));

      expect(dimsBeforeSplit, 'Terminal container should exist in full mode').not.toBeNull();
      expect(dimsBeforeSplit.containerWidth, 'Container width should be > 0 in full mode').toBeGreaterThan(0);
      expect(dimsBeforeSplit.containerHeight, 'Container height should be > 0 in full mode').toBeGreaterThan(0);

      // In full mode, overlay left should be ~0
      expect(dimsBeforeSplit.overlayLeft, 'In full mode, overlay.left should be near 0').toBeLessThan(10);

      // ── Step A: Type in terminal in FULL mode ────────────────────────
      console.log('\n  [T-26] STEP A: Typing echo marker in FULL mode');
      await typeInTerminal(page, 'echo MARKER_T26_A');

      const markerAFound = await waitForTerminalText(page, 'MARKER_T26_A', 10000);
      console.log(`  [T-26] STEP A: Marker found in terminal = ${markerAFound}`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-full-mode-echo.png') });

      expect(markerAFound, 'STEP A: echo MARKER_T26_A must appear in terminal (full mode)').toBe(true);
      console.log('  [T-26] STEP A: PASS — input works in full mode');

      // ── Step B: Click "Split" button ─────────────────────────────────
      console.log('\n  [T-26] STEP B: Clicking Split button');

      // Capture resize count before split
      const resizesBeforeSplit = await page.evaluate(() => (window.__t26ResizesSent || []).length);

      const splitBtn = page.locator('button:has-text("Split")');
      await expect(splitBtn, 'Split button must be visible').toBeVisible();
      await splitBtn.click();

      // Wait for layout to settle (ResizeObserver fires async)
      await sleep(1500);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-split-mode.png') });

      const dimsAfterSplit = await getTerminalDimensions(page);
      console.log(`  [T-26] SPLIT mode dimensions:`, JSON.stringify(dimsAfterSplit));

      // ── Split mode assertions ────────────────────────────────────────

      // A5: Container must not be zero-sized
      expect(dimsAfterSplit.containerWidth, 'STEP B: Container width must be > 0 in split mode').toBeGreaterThan(0);
      expect(dimsAfterSplit.containerHeight, 'STEP B: Container height must be > 0 in split mode').toBeGreaterThan(0);

      // A1: In split mode, overlay should be at ~50% of the viewport
      const expectedSplitLeft = dimsAfterSplit.windowWidth / 2;
      console.log(`  [T-26] SPLIT: overlay.left=${dimsAfterSplit.overlayLeft}, expected ~${expectedSplitLeft}`);
      expect(dimsAfterSplit.overlayLeft, 'In split mode, overlay.left should be approximately half the viewport')
        .toBeGreaterThan(expectedSplitLeft * 0.85);

      // Split mode container should be narrower than full mode
      console.log(`  [T-26] SPLIT: containerWidth=${dimsAfterSplit.containerWidth} (was ${dimsBeforeSplit.containerWidth} in full)`);
      expect(dimsAfterSplit.containerWidth, 'Container should be narrower in split mode than full mode')
        .toBeLessThan(dimsBeforeSplit.containerWidth * 0.8);

      // A6: Check PTY resize was sent after split
      const resizesAfterSplit = await page.evaluate(() => (window.__t26ResizesSent || []).length);
      const newResizesForSplit = resizesAfterSplit - resizesBeforeSplit;
      console.log(`  [T-26] STEP B: SESSION_RESIZE sent after split = ${newResizesForSplit}`);
      expect(newResizesForSplit, 'At least one SESSION_RESIZE must be sent after split toggle').toBeGreaterThanOrEqual(1);

      // Capture last resize dimensions
      const lastResize = await page.evaluate(() => {
        const arr = window.__t26ResizesSent || [];
        return arr.length > 0 ? arr[arr.length - 1] : null;
      });
      console.log(`  [T-26] STEP B: Last resize sent = ${JSON.stringify(lastResize)}`);
      if (lastResize) {
        expect(lastResize.cols, 'Split mode PTY cols should be > 0').toBeGreaterThan(0);
        expect(lastResize.rows, 'Split mode PTY rows should be > 0').toBeGreaterThan(0);
        // In split mode (~640px wide), cols should be notably less than ~120
        console.log(`  [T-26] STEP B: Split mode PTY cols=${lastResize.cols} (should be < full-width cols)`);
      }

      console.log('  [T-26] STEP B: PASS — split mode dimensions verified');

      // ── Step C: Type in terminal in SPLIT mode ───────────────────────
      console.log('\n  [T-26] STEP C: Typing echo marker in SPLIT mode');
      await typeInTerminal(page, 'echo MARKER_T26_B');

      const markerBFound = await waitForTerminalText(page, 'MARKER_T26_B', 10000);
      console.log(`  [T-26] STEP C: Marker found in terminal = ${markerBFound}`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-split-mode-echo.png') });

      expect(markerBFound, 'STEP C: echo MARKER_T26_B must appear in terminal (split mode)').toBe(true);
      console.log('  [T-26] STEP C: PASS — input works in split mode');

      // ── Step D: Click "Full" button ──────────────────────────────────
      console.log('\n  [T-26] STEP D: Clicking Full button');

      const resizesBeforeFull = await page.evaluate(() => (window.__t26ResizesSent || []).length);

      const fullBtn = page.locator('button:has-text("Full")');
      await expect(fullBtn, 'Full button must be visible after split').toBeVisible();
      await fullBtn.click();

      // Wait for layout to settle
      await sleep(1500);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-full-mode-restored.png') });

      const dimsAfterFull = await getTerminalDimensions(page);
      console.log(`  [T-26] FULL (restored) mode dimensions:`, JSON.stringify(dimsAfterFull));

      // A2: Container should be wide again in full mode
      expect(dimsAfterFull.overlayLeft, 'In restored full mode, overlay.left should be near 0').toBeLessThan(10);
      expect(dimsAfterFull.containerWidth, 'Container should be wider in full mode than split mode')
        .toBeGreaterThan(dimsAfterSplit.containerWidth * 1.3);

      // A6: Check PTY resize was sent after toggling back to full
      const resizesAfterFull = await page.evaluate(() => (window.__t26ResizesSent || []).length);
      const newResizesForFull = resizesAfterFull - resizesBeforeFull;
      console.log(`  [T-26] STEP D: SESSION_RESIZE sent after full toggle = ${newResizesForFull}`);
      expect(newResizesForFull, 'At least one SESSION_RESIZE must be sent after full toggle').toBeGreaterThanOrEqual(1);

      console.log('  [T-26] STEP D: PASS — full mode dimensions verified');

      // ── Step E: Type in terminal in FULL mode (restored) ─────────────
      console.log('\n  [T-26] STEP E: Typing echo marker in FULL mode (restored)');
      await typeInTerminal(page, 'echo MARKER_T26_C');

      const markerCFound = await waitForTerminalText(page, 'MARKER_T26_C', 10000);
      console.log(`  [T-26] STEP E: Marker found in terminal = ${markerCFound}`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08-full-restored-echo.png') });

      expect(markerCFound, 'STEP E: echo MARKER_T26_C must appear in terminal (full mode, restored)').toBe(true);
      console.log('  [T-26] STEP E: PASS — input works in restored full mode');

      // ── Final summary ─────────────────────────────────────────────────
      const allResizes = await page.evaluate(() => window.__t26ResizesSent || []);
      console.log('\n  [T-26] All SESSION_RESIZE messages sent:', JSON.stringify(allResizes, null, 2));

      console.log('\n  ════════════════════════════════════');
      console.log('  [T-26] FINAL RESULT: PASS');
      console.log('  ════════════════════════════════════');
      console.log('  A: Full mode input      → PASS');
      console.log('  B: Split mode resize    → PASS');
      console.log('  C: Split mode input     → PASS');
      console.log('  D: Full mode resize     → PASS');
      console.log('  E: Full mode input      → PASS');

    } finally {
      await browser.close();
    }
  });

});
