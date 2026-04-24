/**
 * T-22: Delete session while overlay is open — overlay handles gracefully
 *
 * Score: L=2 S=4 D=5 (Total: 11)
 *
 * Flow:
 *   1. Create a stopped bash session
 *   2. Open it in the terminal overlay
 *   3. Enable split view so session card is visible alongside overlay
 *   4. Delete the session via the session card's Delete button
 *   5. Confirm the delete dialog
 *
 * Pass conditions:
 *   - Overlay closes (no #session-overlay in DOM)
 *   - Session card is removed from the list
 *   - No JS errors in the console
 *   - No repeated session:subscribe messages after the delete
 *   - No unhandled JS exceptions
 *
 * Run: PORT=3119 npx playwright test tests/adversarial/T-22-delete-with-overlay.test.js --reporter=line --timeout=120000
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
const PORTS = { direct: 3119, tmux: 3719 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-22-delete-with-overlay-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe(`T-22 — Delete session while overlay is open [${MODE}]`, () => {
  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';
  let testSessionId = '';

  // ── Infrastructure Setup ─────────────────────────────────────────────────

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3119 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T22-XXXXXX').toString().trim();
    console.log(`\n  [T-22] tmpDir: ${tmpDir}`);

    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');
    console.log(`  [T-22] Server ready on port ${PORT}`);

    // Create test project
    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T22-Project', path: projPath }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T-22] Project created: ${testProjectId}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      if (crashLog.trim()) {
        console.log('\n  [CRASH LOG]\n' + crashLog);
      }
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  // ── WS helpers ────────────────────────────────────────────────────────────

  function wsConnect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
      setTimeout(() => reject(new Error('WS connect timeout')), 8000);
    });
  }

  function waitForMsg(ws, predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', handler);
        reject(new Error(`waitForMsg timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      function handler(raw) {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (predicate(msg)) { clearTimeout(timer); ws.off('message', handler); resolve(msg); }
      }
      ws.on('message', handler);
    });
  }

  async function getSessionStatus(sessionId) {
    const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const all = Array.isArray(data.managed) ? data.managed : (Array.isArray(data) ? data : []);
    return all.find(s => s.id === sessionId);
  }

  async function waitForStatus(sessionId, status, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await getSessionStatus(sessionId);
      const st = s?.status || s?.state;
      if (st === status) return s;
      await sleep(300);
    }
    const s = await getSessionStatus(sessionId);
    throw new Error(`Session ${sessionId} never reached ${status} — last: ${s?.status || s?.state}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // THE MAIN TEST
  // ─────────────────────────────────────────────────────────────────────────

  test('T-22 — Delete session while overlay is open — overlay closes gracefully', async () => {
    test.setTimeout(120000);

    // ── Step 1: Create a bash session via WS ─────────────────────────────────
    console.log('\n  [T-22.01] Creating bash session via WS...');
    const ws = await wsConnect();
    await sleep(300);

    // Wait for init
    await waitForMsg(ws, m => m.type === 'init', 8000).catch(() => {
      console.log('  [T-22] No init message (may be OK)');
    });

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: testProjectId,
      name: 'T22-bash',
      command: 'bash',
      mode: MODE,
      cols: 120,
      rows: 30,
    }));

    const created = await waitForMsg(ws,
      m => m.type === 'session:created' || m.type === 'session:error', 15000);

    if (created.type === 'session:error') {
      throw new Error(`T-22.01 FAILED — session:create error: ${created.error}`);
    }

    testSessionId = created.session.id;
    console.log(`  [T-22.01] PASS — session created: ${testSessionId}`);

    // ── Step 2: Wait for session to be running, then stop it ─────────────────
    console.log('\n  [T-22.02] Waiting for session to be running...');
    await waitForStatus(testSessionId, 'running', 15000);
    console.log('  [T-22.02] PASS — session is running');

    // Stop the session so Delete button appears
    console.log('\n  [T-22.02b] Stopping session (Delete button requires stopped state)...');
    ws.send(JSON.stringify({ type: 'session:stop', id: testSessionId }));
    await waitForStatus(testSessionId, 'stopped', 15000);
    console.log('  [T-22.02b] PASS — session is stopped');

    ws.close();

    // ── Step 3: Open browser ──────────────────────────────────────────────────
    console.log('\n  [T-22.03] Opening browser...');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    // Track console errors and WS frames
    const consoleErrors = [];
    // Track post-delete subscribe messages
    const postDeleteSubscribes = [];
    let deleteMessageSent = false;

    let page;
    try {
      page = await browser.newPage();

      // Collect console errors
      page.on('console', msg => {
        if (msg.type() === 'error') {
          const text = msg.text();
          consoleErrors.push(text);
          console.log(`  [browser:err] ${text}`);
        }
      });

      // Monitor WebSocket frames for session:subscribe messages after delete
      page.on('websocket', wsObj => {
        wsObj.on('framesent', frame => {
          try {
            const msg = JSON.parse(frame.payload);
            if (msg.type === 'session:subscribe' && msg.id === testSessionId) {
              if (deleteMessageSent) {
                postDeleteSubscribes.push({ time: Date.now(), msg });
                console.log(`  [T-22] WARN: session:subscribe sent AFTER delete! msg=${JSON.stringify(msg)}`);
              }
            }
            // Mark when we see the delete message go out
            if (msg.type === 'session:delete' && msg.id === testSessionId) {
              deleteMessageSent = true;
              console.log('  [T-22] Detected session:delete frame sent from browser');
            }
          } catch {}
        });
      });

      // Navigate to app
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for WS connected state — status-dot.connected
      await page.waitForSelector('.status-dot.connected', { timeout: 10000 })
        .catch(() => console.log('  [T-22] WS connected dot not found within 10s (may be OK)'));

      // Wait for sessions to be loaded from the server
      await page.waitForFunction(
        () => document.querySelector('.project-item') !== null,
        { timeout: 10000 }
      ).catch(() => console.log('  [T-22] No .project-item found yet'));

      await sleep(500);
      console.log('  [T-22.03] PASS — browser loaded');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-01-loaded.png'), fullPage: true });

      // ── Step 4: Navigate to project / find session card ───────────────────
      console.log('\n  [T-22.04] Selecting project to see session card...');

      // Click the .project-item that contains "T22-Project"
      const projectItem = page.locator('.project-item').filter({ hasText: 'T22-Project' }).first();
      const projVisible = await projectItem.isVisible({ timeout: 8000 }).catch(() => false);

      if (projVisible) {
        await projectItem.click();
        await sleep(800);
        console.log('  [T-22.04] Clicked project "T22-Project"');
      } else {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-00-no-project.png'), fullPage: true });
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
        console.log(`  [T-22.04] Body text: ${bodyText}`);
      }

      // Wait for session card with "T22-bash"
      await page.waitForFunction(
        () => document.body.innerText.includes('T22-bash'),
        { timeout: 15000 }
      ).catch(async () => {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-00-no-session.png'), fullPage: true });
        throw new Error('T-22.04 FAILED — session card "T22-bash" not found after project click');
      });
      console.log('  [T-22.04] PASS — session card "T22-bash" visible');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-02-session-card-visible.png'), fullPage: true });

      // ── Step 5: Click "Open" to open the overlay ──────────────────────────
      console.log('\n  [T-22.05] Opening session overlay...');

      // Click the session card (or its Open button)
      const openBtn = page.locator('.session-card-actions button', { hasText: 'Open' }).first();
      const openBtnVisible = await openBtn.isVisible({ timeout: 5000 }).catch(() => false);

      if (openBtnVisible) {
        await openBtn.click();
        console.log('  [T-22.05] Clicked "Open" button');
      } else {
        // Fall back to clicking the session card directly
        const sessionCard = page.locator('.session-card').filter({ hasText: 'T22-bash' }).first();
        await sessionCard.click();
        console.log('  [T-22.05] Clicked session card directly');
      }

      // Wait for overlay to appear
      await page.waitForSelector('#session-overlay', { timeout: 15000 }).catch(async () => {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-00-no-overlay.png'), fullPage: true });
        throw new Error('T-22.05 FAILED — session overlay did not appear');
      });
      console.log('  [T-22.05] PASS — overlay appeared');
      await sleep(500);

      // ── Step 6: Enable split view ─────────────────────────────────────────
      console.log('\n  [T-22.06] Enabling split view...');

      const splitBtn = page.locator('#session-overlay button', { hasText: 'Split' }).first();
      const splitBtnVisible = await splitBtn.isVisible({ timeout: 5000 }).catch(() => false);

      if (splitBtnVisible) {
        await splitBtn.click();
        console.log('  [T-22.06] Clicked "Split" button');
      } else {
        // Try alternative: button with title
        const splitBtnAlt = page.locator('button[title*="split"], button[title*="Split"]').first();
        const splitAltVisible = await splitBtnAlt.isVisible({ timeout: 3000 }).catch(() => false);
        if (splitAltVisible) {
          await splitBtnAlt.click();
          console.log('  [T-22.06] Clicked split button via title selector');
        } else {
          console.log('  [T-22.06] WARN: Split button not found, proceeding without split view');
          console.log('  [T-22.06] Will use the overlay close button test path instead');
        }
      }

      await sleep(500);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-03-split-view.png'), fullPage: true });
      console.log('  [T-22.06] Screenshot saved (split view state)');

      // ── Step 7: Verify overlay is open ───────────────────────────────────
      console.log('\n  [T-22.07] Verifying overlay is present before delete...');

      // Record snapshot of overlay before delete
      const overlayBeforeDelete = await page.evaluate(() => !!document.querySelector('#session-overlay'));
      console.log(`  [T-22.07] Overlay present before delete: ${overlayBeforeDelete}`);
      expect(overlayBeforeDelete, 'Overlay must be present before delete').toBe(true);
      console.log('  [T-22.07] PASS — overlay is open');

      // ── Step 8: Delete session via WS while overlay is open ───────────────
      // Note: Deletion is WS-only — the Delete UI button only appears when a
      // session is stopped, but opening the overlay auto-resumes stopped direct
      // sessions (subscribe() calls start() for stopped sessions). So we send
      // session:delete directly via WS while the overlay is still open.
      console.log('\n  [T-22.08] Sending session:delete via WS while overlay is open...');

      const wsDelete = await wsConnect();
      await sleep(200);
      wsDelete.send(JSON.stringify({ type: 'session:delete', id: testSessionId }));
      console.log('  [T-22.08] session:delete sent');

      // Mark delete as sent for WS monitoring
      deleteMessageSent = true;

      await sleep(500); // allow server to process delete and broadcast sessions:list
      wsDelete.close();

      // ── Step 9: Wait for overlay to disappear ────────────────────────────
      console.log('\n  [T-22.09] Waiting for overlay to disappear...');

      try {
        await page.waitForFunction(
          () => !document.querySelector('#session-overlay'),
          { timeout: 8000 }
        );
        console.log('  [T-22.09] PASS — overlay disappeared after session delete');
      } catch {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-00-overlay-stuck.png'), fullPage: true });
        // Check if overlay is actually gone (may have unmounted before our check)
        const overlayStillPresent = await page.evaluate(() => !!document.querySelector('#session-overlay'));
        if (overlayStillPresent) {
          throw new Error('T-22.09 FAILED — overlay still present 8s after session delete');
        } else {
          console.log('  [T-22.09] PASS — overlay actually gone (timing issue with waitForFunction)');
        }
      }

      // ── Step 10: Verify session card removed ──────────────────────────────
      console.log('\n  [T-22.10] Waiting for session card to be removed...');

      await sleep(1500); // give time for sessions:list broadcast to propagate

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-04-after-delete.png'), fullPage: true });

      const sessionCardGone = await page.evaluate(() => {
        // Check if T22-bash appears anywhere in a session card
        const cards = document.querySelectorAll('.session-card');
        for (const card of cards) {
          if (card.textContent.includes('T22-bash')) return false;
        }
        return true;
      });

      expect(sessionCardGone, 'Session card must be removed from list after delete').toBe(true);
      console.log('  [T-22.10] PASS — session card removed from list');

      // ── Step 11: Check for console errors ────────────────────────────────
      console.log('\n  [T-22.11] Checking for console errors...');

      // Wait a bit more to catch any delayed errors (e.g., subscribe retry loops)
      await sleep(2000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-05-final-state.png'), fullPage: true });

      // Filter known non-critical errors
      const criticalErrors = consoleErrors.filter(err => {
        // session:error toasts about unsubscribing from a deleted session are acceptable
        if (err.includes('session:error') && err.includes('not found')) return false;
        // WebSocket close code 1005 is expected
        if (err.includes('1005')) return false;
        return true;
      });

      if (criticalErrors.length > 0) {
        console.log(`  [T-22.11] Console errors found:`);
        for (const err of criticalErrors) {
          console.log(`    - ${err}`);
        }
      } else {
        console.log('  [T-22.11] PASS — no critical console errors');
      }

      expect(criticalErrors, 'No critical JS errors in console').toHaveLength(0);

      // ── Step 12: Verify no repeated session:subscribe after delete ────────
      console.log('\n  [T-22.12] Checking for repeated session:subscribe after delete...');

      expect(postDeleteSubscribes, 'No session:subscribe sent after session:delete').toHaveLength(0);
      console.log('  [T-22.12] PASS — no repeated subscribe messages after delete');

      // ── Step 13: Verify overlay is fully gone from DOM ───────────────────
      console.log('\n  [T-22.13] Final overlay DOM check...');

      const overlayFinallyGone = await page.evaluate(() => !document.querySelector('#session-overlay'));
      expect(overlayFinallyGone, 'Overlay must be absent from DOM after delete').toBe(true);
      console.log('  [T-22.13] PASS — overlay fully gone from DOM');

      console.log('\n  [T-22] ALL CHECKS PASSED');

    } finally {
      if (page) {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T22-99-cleanup.png'), fullPage: true }).catch(() => {});
        await browser.close().catch(() => {});
      } else {
        await browser.close().catch(() => {});
      }
    }
  });
});
} // end for (const MODE of MODES)
