/**
 * T-04: Stop Button Actually Kills the Process
 *
 * Purpose: Verify that clicking Stop (or sending session:stop via WS) actually
 * kills the underlying PTY process at the OS level. The silent failure mode is
 * "UI says stopped but PTY still alive (credits still burning)."
 *
 * Kill-0 check: process.kill(pid, 0) from Node.js — asks the OS directly.
 * REST check: GET /api/sessions — server-side state verification.
 * UI check: badge shows "stopped", Stop button disappears.
 *
 * Run: PORT=3101 npx playwright test tests/adversarial/T-04-stop-kills-process.test.js --reporter=line --timeout=180000
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
const PORT = 3101;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T04-stop-kills');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Server lifecycle ──────────────────────────────────────────────────────────

test.describe('T-04 — Stop Button Actually Kills the Process', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3101 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Fresh isolated temp data directory
    tmpDir = execSync('mktemp -d /tmp/qa-T04-XXXXXX').toString().trim();
    console.log(`\n  [T-04] tmpDir: ${tmpDir}`);

    // Create project directory
    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    // Seed projects.json — CRITICAL: must use { "projects": [...], "scratchpad": [] } format
    // A plain array silently yields an empty project list (T-02 lesson)
    const projectsSeed = {
      projects: [{
        id: 'proj-t04',
        name: 'T04-Project',
        path: projPath,
        createdAt: '2026-01-01T00:00:00Z',
      }],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(projectsSeed, null, 2));

    const crashLogPath = path.join(tmpDir, 'crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready (up to 25s)
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');
    console.log(`  [T-04] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    // Print crash log if server died unexpectedly
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf8');
      if (crashLog.trim()) {
        console.log('\n  [CRASH LOG]\n' + crashLog);
      }
    } catch {}
    if (tmpDir) {
      try { execSync(`rm -rf ${tmpDir}`); } catch {}
      tmpDir = '';
    }
    // Safety net port cleanup
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

  function waitForMsg(ws, predicate, timeoutMs = 15000) {
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

  // ── REST helpers ──────────────────────────────────────────────────────────

  async function getSessions() {
    const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    return Array.isArray(data.managed) ? data.managed : (Array.isArray(data) ? data : []);
  }

  async function getSessionById(sessionId) {
    const sessions = await getSessions();
    return sessions.find(s => s.id === sessionId) || null;
  }

  async function waitForStatus(sessionId, targetStatus, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await getSessionById(sessionId);
      const status = s?.status || s?.state;
      if (status === targetStatus) return s;
      await sleep(300);
    }
    const s = await getSessionById(sessionId);
    throw new Error(`Session ${sessionId} never reached "${targetStatus}" — last: ${s?.status || s?.state}`);
  }

  // ── OS-level process check ────────────────────────────────────────────────

  function isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true; // No throw = process exists
    } catch (err) {
      if (err.code === 'ESRCH') return false; // Process does not exist
      throw err; // EPERM or other unexpected error
    }
  }

  // ── Create session helper ─────────────────────────────────────────────────

  async function createBashSession(name) {
    const ws = await wsConnect();
    await sleep(300);

    // Wait for init message
    await waitForMsg(ws, m => m.type === 'init', 8000).catch(() => {
      console.log(`  [T-04] No init message received (may be OK)`);
    });

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: 'proj-t04',
      name,
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const created = await waitForMsg(ws, m =>
      m.type === 'session:created' || m.type === 'session:error', 15000);

    if (created.type === 'session:error') {
      throw new Error(`session:create error: ${created.error}`);
    }

    const sessionId = created.session.id;
    console.log(`  [T-04] Session created: ${sessionId}`);

    // Wait for running status
    await waitForStatus(sessionId, 'running', 10000);
    console.log(`  [T-04] Session is running`);

    // Get PID from REST API
    const sessionData = await getSessionById(sessionId);
    const ptyPid = sessionData?.pid;
    if (!ptyPid || ptyPid <= 0) {
      throw new Error(`No valid PID in session data: ${JSON.stringify(sessionData)}`);
    }
    console.log(`  [T-04] PTY PID: ${ptyPid}`);

    return { ws, sessionId, ptyPid };
  }

  // ── Delete session via WS ─────────────────────────────────────────────────

  async function deleteSessionViaWS(ws, sessionId) {
    ws.send(JSON.stringify({ type: 'session:delete', id: sessionId }));
    await sleep(1000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // THE MAIN TEST
  // ─────────────────────────────────────────────────────────────────────────────

  test('T-04 — Stop button kills process: 3 iterations (UI + WS + UI)', async () => {
    test.setTimeout(180000);

    const iterations = [
      { name: 't04-bash-stop-1', path: 'UI', label: 'Iteration 1 (Path A - UI stop)' },
      { name: 't04-bash-stop-2', path: 'WS', label: 'Iteration 2 (Path B - WS stop)' },
      { name: 't04-bash-stop-3', path: 'UI', label: 'Iteration 3 (Path A - UI stop)' },
    ];

    for (let i = 0; i < iterations.length; i++) {
      const { name, path: stopPath, label } = iterations[i];
      console.log(`\n  ════════════════════════════════════`);
      console.log(`  [T-04] ${label}`);
      console.log(`  ════════════════════════════════════`);

      // ── Create session ────────────────────────────────────────────────────
      const { ws, sessionId, ptyPid } = await createBashSession(name);

      // ── Baseline kill-0 check: process must be alive before stop ──────────
      console.log(`\n  [T-04.${i+1}a] Baseline kill-0 check: PID ${ptyPid}`);
      const aliveBeforeStop = isProcessAlive(ptyPid);
      if (!aliveBeforeStop) {
        ws.close();
        throw new Error(`INCONCLUSIVE — Baseline FAIL: PTY process ${ptyPid} already dead before stop was called`);
      }
      console.log(`  [T-04.${i+1}a] PASS — Process ${ptyPid} is alive (baseline confirmed)`);

      // ── Trigger stop ──────────────────────────────────────────────────────
      if (stopPath === 'WS') {
        // Path B: direct WS stop
        console.log(`\n  [T-04.${i+1}b] Path B: Stopping via WS session:stop...`);
        ws.send(JSON.stringify({ type: 'session:stop', id: sessionId }));
        console.log(`  [T-04.${i+1}b] session:stop sent`);
        await sleep(5000);

      } else {
        // Path A: UI browser stop
        console.log(`\n  [T-04.${i+1}b] Path A: Stopping via UI browser...`);
        const browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });

        let page;
        try {
          page = await browser.newPage();
          page.on('console', msg => {
            if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
          });

          // Navigate — use domcontentloaded (networkidle never fires with persistent WS)
          await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

          // Wait for "Connected" indicator
          await page.waitForFunction(
            () => document.querySelector('.status-connected, [class*="connected"], .status-dot') !== null ||
                  document.body.textContent.includes('Connected'),
            { timeout: 15000 }
          );
          await sleep(800);
          console.log(`  [T-04.${i+1}b] Browser loaded and connected`);

          // Select the project — wait for it to be visible first
          const projectItem = page.locator('.project-item, [class*="project"]').filter({ hasText: 'T04-Project' }).first();
          await projectItem.waitFor({ state: 'visible', timeout: 8000 });
          await projectItem.click();
          await sleep(500);
          console.log(`  [T-04.${i+1}b] Project selected`);

          // Wait for session card to appear
          const sessionCard = page.locator('.session-card').filter({ hasText: name }).first();
          await sessionCard.waitFor({ state: 'visible', timeout: 8000 });
          console.log(`  [T-04.${i+1}b] Session card visible`);

          // Take screenshot: running state baseline
          await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-00-session-running.png`),
            fullPage: true,
          });

          // Click session card to open overlay
          await sessionCard.click();
          await sleep(300);

          // Wait for session overlay
          await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 8000 });
          console.log(`  [T-04.${i+1}b] Session overlay opened`);

          // Wait for Stop button
          const stopBtn = page.locator('#btn-session-stop');
          await stopBtn.waitFor({ state: 'visible', timeout: 8000 });
          console.log(`  [T-04.${i+1}b] Stop button visible`);

          // Screenshot: stop button visible
          await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-01-stop-button.png`),
            fullPage: true,
          });

          // Click Stop
          await stopBtn.click();
          console.log(`  [T-04.${i+1}b] Stop button clicked`);

          // Wait 5 seconds per spec
          await sleep(5000);

          // Verify UI badge changed to "stopped"
          console.log(`\n  [T-04.${i+1}c] Verifying UI badge...`);
          const badgeUpdated = await page.evaluate((sessionName) => {
            const cards = document.querySelectorAll('.session-card');
            for (const card of cards) {
              if (card.textContent.includes(sessionName)) {
                // Check for stopped badge text (⏹ or "stopped")
                return card.textContent.includes('stopped') || card.textContent.includes('⏹');
              }
            }
            return false;
          }, name);

          // Screenshot: post-stop state
          await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-02-post-stop.png`),
            fullPage: true,
          });

          expect(badgeUpdated, `[${label}] UI badge must show "stopped" after 5s`).toBe(true);
          console.log(`  [T-04.${i+1}c] PASS — UI badge shows "stopped"`);

          // Verify Stop button is gone (it only renders when session is active)
          const stopBtnGone = await page.locator('#btn-session-stop').isVisible().catch(() => false);
          expect(stopBtnGone, `[${label}] Stop button must disappear after stop`).toBe(false);
          console.log(`  [T-04.${i+1}c] PASS — Stop button is gone`);

        } finally {
          if (page) await browser.close().catch(() => {});
          else await browser.close().catch(() => {});
        }
      }

      // ── REST API check ────────────────────────────────────────────────────
      console.log(`\n  [T-04.${i+1}d] REST API check...`);
      const sessionAfterStop = await getSessionById(sessionId);

      expect(sessionAfterStop, `[${label}] Session must still exist in API (stop ≠ delete)`).not.toBeNull();
      console.log(`  [T-04.${i+1}d] Session still in API list ✓`);

      const statusAfterStop = sessionAfterStop?.status || sessionAfterStop?.state;
      expect(statusAfterStop, `[${label}] Session status must be "stopped"`).toBe('stopped');
      console.log(`  [T-04.${i+1}d] PASS — API status="${statusAfterStop}"`);

      // ── OS-level kill-0 check (THE CRITICAL CHECK) ────────────────────────
      console.log(`\n  [T-04.${i+1}e] OS-level kill-0 check: PID ${ptyPid}...`);
      const aliveAfterStop = isProcessAlive(ptyPid);

      if (aliveAfterStop) {
        // Take failure screenshot if browser was involved
        console.error(`  [T-04.${i+1}e] SILENT FAILURE DETECTED: process ${ptyPid} still alive!`);
        throw new Error(
          `[${label}] SILENT FAILURE: process.kill(${ptyPid}, 0) succeeded — ` +
          `PTY still alive after stop! API says "stopped" but credits are still burning.`
        );
      }

      console.log(`  [T-04.${i+1}e] PASS — process.kill(${ptyPid}, 0) → ESRCH (process is dead)`);

      // ── Server process liveness ────────────────────────────────────────────
      const serverAlive = isProcessAlive(serverProc.pid);
      expect(serverAlive, `[${label}] Server process must still be alive`).toBe(true);
      console.log(`  [T-04.${i+1}f] PASS — server process still alive`);

      // ── Cleanup: delete session ────────────────────────────────────────────
      console.log(`\n  [T-04.${i+1}] Cleanup: deleting session ${sessionId}...`);
      await deleteSessionViaWS(ws, sessionId);
      ws.close();
      await sleep(1000);

      console.log(`\n  [T-04] ${label} → ALL CHECKS PASSED`);
    }

    // ── Post-test crash log check ─────────────────────────────────────────
    console.log('\n  [T-04] Checking crash log...');
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf8');
      const unhandledErrors = crashLog
        .split('\n')
        .filter(line => line.includes('UnhandledRejection') || line.includes('UncaughtException'));
      expect(unhandledErrors.length, `Crash log must have no unhandled errors. Found: ${unhandledErrors.join(', ')}`).toBe(0);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.log('  [T-04] No crash log found (server ran cleanly)');
    }

    console.log('\n  ✓ T-04 ALL ITERATIONS PASSED — Stop button kills process at OS level');
  });
});
