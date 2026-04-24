/**
 * T-51: Typing after Refresh without clicking terminal (auto-focus)
 *
 * Regression test for two bugs fixed together:
 *
 * Bug A — Server: TmuxSession._wirePty() PTY reference race condition
 *   After refresh(), the old PTY's async onExit handler fired AFTER the new PTY
 *   was created, clobbering this.pty = null. All subsequent write() calls were
 *   no-ops — the session appeared running but was deaf to all input.
 *   Fix: capture ptyRef at wire time; only null out if this.pty === ptyRef.
 *
 * Bug B — Client: TerminalPane missing xterm.focus() after refresh
 *   TerminalPane had no handler for 'session:refreshed', so xterm.focus() was
 *   never called. Browser focus stayed on the Refresh button after clicking it.
 *   Subsequent keystrokes went to the button, not the terminal.
 *   Fix: call xterm.focus() in handleSubscribed's rAF and add handleRefreshed.
 *
 * The test catches BOTH bugs together in end-to-end fashion:
 * - If Bug A: typing sends keystrokes, PTY is null → no echo → FAIL
 * - If Bug B: focus stays on button → keystrokes never reach xterm onData → FAIL
 *
 * The critical assertion: after clicking Refresh, WITHOUT clicking the terminal,
 * type a command and verify it echoes back. This is only possible if both:
 *   1. xterm has browser focus (Bug B fixed)
 *   2. PTY is alive and receiving input (Bug A fixed)
 *
 * Run: npx playwright test tests/adversarial/T-51-refresh-typing.test.js --reporter=line --timeout=90000
 * Run slow: SLOW=1 npx playwright test ...
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
const PORTS = { direct: 3151, tmux: 3751 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T51-refresh-typing-${MODE}`);

const SLOW = !!process.env.SLOW;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const humanDelay = SLOW ? (ms = 800) => sleep(ms) : () => Promise.resolve();

// ── Server lifecycle ──────────────────────────────────────────────────────────

test.describe(`T-51 — Typing after Refresh without clicking terminal [${MODE}]`, () => {
  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    tmpDir = execSync('mktemp -d /tmp/qa-T51-XXXXXX').toString().trim();
    console.log(`\n  [T-51] tmpDir: ${tmpDir}`);

    const crashLogPath = path.join(tmpDir, 'server-crash.log');
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

    // Create test project via REST API
    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T51-refresh-typing', path: projPath }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T-51] Project: ${testProjectId}, server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch {} serverProc = null; }
    // Print crash log if it has content
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      if (crashLog.trim()) console.log('\n  [CRASH LOG]\n' + crashLog);
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
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

  // ── Main test ────────────────────────────────────────────────────────────

  test('T-51 — typing after Refresh without clicking terminal (no-click auto-focus)', async () => {
    test.setTimeout(90000);

    // ── Step 1: Create bash session via WS, BEFORE opening browser ─────────
    // Creating before browser opens prevents the Playwright WS proxy from
    // interfering with the session:create handshake.
    console.log('\n  [T-51.01] Creating bash session via WS...');

    const wsCreate = await wsConnect();
    await sleep(300);

    wsCreate.send(JSON.stringify({
      type: 'session:create',
      projectId: testProjectId,
      name: 'T51-bash',
      command: 'bash',
      mode: 'tmux',
      cols: 120,
      rows: 30,
    }));

    const created = await waitForMsg(wsCreate,
      m => m.type === 'session:created' || m.type === 'session:error', 15000);

    if (created.type === 'session:error') {
      throw new Error(`T-51.01 FAILED — session:create error: ${created.error}`);
    }

    const sessionId = created.session.id;
    console.log(`  [T-51.01] PASS — session created: ${sessionId}`);
    wsCreate.close();

    // ── Step 2: Wait for session to be running and PTY to produce output ───
    console.log('\n  [T-51.02] Waiting for session to be running and produce scrollback...');

    const deadline02 = Date.now() + 20000;
    let sessionRunning = false;
    while (Date.now() < deadline02) {
      const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
      const sessions = Array.isArray(data.managed) ? data.managed : [];
      const s = sessions.find(x => x.id === sessionId);
      if (s && (s.status === 'running' || s.state === 'running')) {
        sessionRunning = true;
        break;
      }
      await sleep(400);
    }
    if (!sessionRunning) throw new Error('T-51.02 FAILED — session never reached running');
    console.log('  [T-51.02] PASS — session is running');

    // Wait for scrollback to be non-empty (tmux needs to produce at least a prompt)
    const deadline02b = Date.now() + 20000;
    let scrollbackReady = false;
    while (Date.now() < deadline02b) {
      try {
        const sb = await fetch(`${BASE_URL}/api/sessions/${sessionId}/scrollback/raw`).then(r => r.text());
        if (sb && sb.trim().length > 0) { scrollbackReady = true; break; }
      } catch {}
      await sleep(500);
    }
    console.log(`  [T-51.02] Scrollback ready: ${scrollbackReady}`);

    // ── Step 3: Open browser ────────────────────────────────────────────────
    console.log('\n  [T-51.03] Opening browser...');

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await browser.newPage();
      page.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
        if (msg.type() === 'log' && msg.text().includes('[TerminalPane]')) {
          console.log(`  [browser:log] ${msg.text()}`);
        }
      });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for "Connected" indicator in app
      await page.waitForFunction(
        () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
              document.body.textContent.includes('Connected'),
        { timeout: 30000 }
      );
      await sleep(SLOW ? 2000 : 1200);
      console.log('  [T-51.03] PASS — browser loaded, Connected');

      // ── Step 4: Open session overlay ──────────────────────────────────────
      console.log('\n  [T-51.04] Opening session overlay...');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-01-app-loaded.png') });

      // Step 4a: Click the project in the sidebar to select it
      const projectItem = page.locator('.project-item').filter({ hasText: 'T51-refresh-typing' }).first();
      try {
        await projectItem.waitFor({ state: 'visible', timeout: 10000 });
        await projectItem.click();
        console.log('  [T-51.04a] Clicked project item');
      } catch (e) {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-00-no-project.png'), fullPage: true });
        throw new Error(`T-51.04 FAILED — project item not found: ${e.message}`);
      }
      await sleep(800);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-02-project-selected.png') });

      // Step 4b: Wait for session card to appear, then click the session name link.
      // NOTE: The session-card-preview area has e.stopPropagation(), so clicking the
      // card center hits the preview and won't trigger attachSession(). Click the name.
      const sessionNameLink = page.locator('.session-card-name').filter({ hasText: 'T51-bash' }).first();
      try {
        await sessionNameLink.waitFor({ state: 'visible', timeout: 10000 });
        console.log('  [T-51.04b] Session name link found, clicking...');
        await sessionNameLink.click();
      } catch (e) {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-00-no-card.png'), fullPage: true });
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 600));
        throw new Error(`T-51.04 FAILED — session card name not found: ${e.message}. Body: ${bodyText}`);
      }
      await humanDelay(800);

      // Wait for terminal to appear in overlay
      try {
        await page.waitForSelector('#session-overlay .terminal-container', { timeout: 15000 });
      } catch {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-00-no-terminal.png') });
        throw new Error('T-51.04 FAILED — terminal container did not appear in overlay');
      }

      await sleep(1500); // Let xterm subscribe, receive scrollback, render
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-02-session-open.png') });
      console.log('  [T-51.04] PASS — session overlay open, terminal visible');

      // ── Step 5: Baseline — type before Refresh (must work) ────────────────
      console.log('\n  [T-51.05] Baseline: clicking terminal and typing BEFORE_REFRESH...');

      // Click the terminal first for baseline (proves the test infra works)
      await page.click('#session-overlay .terminal-container');
      await humanDelay(400);

      await page.keyboard.type('echo BEFORE_REFRESH', { delay: 30 });
      await page.keyboard.press('Enter');

      // Verify via WS that the session echoes it back
      const wsVerify = await wsConnect();
      await sleep(200);
      wsVerify.send(JSON.stringify({ type: 'session:subscribe', id: sessionId, cols: 120, rows: 30 }));
      await waitForMsg(wsVerify, m => m.type === 'session:subscribed' && m.id === sessionId, 8000);

      let baselineOk = false;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Baseline typing timeout')), 10000);
          wsVerify.on('message', raw => {
            let m; try { m = JSON.parse(raw); } catch { return; }
            if (m.type === 'session:output' && m.id === sessionId &&
                typeof m.data === 'string' && m.data.includes('BEFORE_REFRESH')) {
              clearTimeout(timer); baselineOk = true; resolve();
            }
          });
        });
      } catch (e) {
        wsVerify.close();
        throw new Error(`T-51.05 FAILED — baseline typing not working: ${e.message}`);
      }
      wsVerify.close();

      console.log(`  [T-51.05] PASS — baseline typing works (BEFORE_REFRESH echoed)`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-03-before-refresh.png') });

      // ── Step 6: Click Refresh button ──────────────────────────────────────
      console.log('\n  [T-51.06] Clicking Refresh button (session overlay Refresh)...');

      // Use title="Refresh session" to target specifically the session overlay's
      // Refresh button, NOT the global browser refresh or other buttons.
      const refreshBtn = page.locator('button[title="Refresh session"]');
      await expect(refreshBtn).toBeVisible({ timeout: 5000 });
      await refreshBtn.click();
      await humanDelay(SLOW ? 2500 : 1500);

      // Wait for server to process refresh and re-send session:subscribed
      // We know it arrives after the refresh completes
      await sleep(1000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-04-after-refresh.png') });
      console.log('  [T-51.06] PASS — Refresh clicked, waiting for session:subscribed...');

      // ── Step 7: Verify active element is xterm textarea (focus check) ─────
      console.log('\n  [T-51.07] Checking active element after Refresh (focus check)...');

      const activeElementInfo = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          tag: el?.tagName,
          className: el?.className,
          id: el?.id,
          isXtermTextarea: el?.classList?.contains('xterm-helper-textarea'),
        };
      });

      console.log(`  [T-51.07] Active element: ${JSON.stringify(activeElementInfo)}`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-05-active-element-check.png') });

      // ── Step 8: THE CRITICAL ASSERTION — type WITHOUT clicking terminal ────
      // This is the test that would fail on the pre-fix codebase:
      //   - Bug A: PTY is null after refresh, write() is a no-op
      //   - Bug B: focus stays on Refresh button, keystrokes never reach xterm
      console.log('\n  [T-51.08] CRITICAL: typing WITHOUT clicking terminal after Refresh...');

      // DO NOT CLICK the terminal. Just type.
      const sentinel = `AFTER_REFRESH_${Date.now()}`;
      await page.keyboard.type(`echo ${sentinel}`, { delay: 50 });
      await page.keyboard.press('Enter');

      console.log(`  [T-51.08] Typed: echo ${sentinel}`);

      // Now verify via a fresh WS connection that the session echoed the sentinel
      const wsCheck = await wsConnect();
      await sleep(200);
      wsCheck.send(JSON.stringify({ type: 'session:subscribe', id: sessionId, cols: 120, rows: 30 }));
      await waitForMsg(wsCheck, m => m.type === 'session:subscribed' && m.id === sessionId, 8000);

      let afterRefreshOk = false;
      let outputReceived = '';
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(
              `No echo of sentinel "${sentinel}" after Refresh.\n` +
              `This means EITHER:\n` +
              `  - Bug A: PTY is null after refresh (ptyRef race condition)\n` +
              `  - Bug B: xterm has no focus, keystrokes went to the Refresh button\n` +
              `Output received so far: ${outputReceived.slice(-300).replace(/[^\x20-\x7e\n]/g, '?')}`
            ));
          }, 15000);
          wsCheck.on('message', raw => {
            let m; try { m = JSON.parse(raw); } catch { return; }
            if (m.type === 'session:output' && m.id === sessionId && typeof m.data === 'string') {
              outputReceived += m.data;
              if (outputReceived.includes(sentinel)) {
                clearTimeout(timer);
                afterRefreshOk = true;
                resolve();
              }
            }
          });
        });
      } catch (e) {
        wsCheck.close();
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-FAIL-no-echo.png') });
        throw new Error(`T-51.08 FAILED — ${e.message}`);
      }
      wsCheck.close();

      console.log(`  [T-51.08] PASS — sentinel "${sentinel}" echoed back`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T51-06-after-refresh-typed.png') });

      // ── Step 9: Verify active element is still xterm textarea ─────────────
      const finalActiveElement = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          tag: el?.tagName,
          className: el?.className,
          isXtermTextarea: el?.classList?.contains('xterm-helper-textarea'),
        };
      });
      console.log(`  [T-51.09] Final active element: ${JSON.stringify(finalActiveElement)}`);

      // ── Assertions ────────────────────────────────────────────────────────

      expect(
        activeElementInfo.isXtermTextarea,
        `After Refresh, xterm textarea must have focus (Bug B regression check). ` +
        `Active element was: ${JSON.stringify(activeElementInfo)}`
      ).toBe(true);

      expect(
        afterRefreshOk,
        `Sentinel must be echoed back after Refresh without clicking terminal (Bug A + B regression check)`
      ).toBe(true);

      console.log('\n  [T-51] ALL CHECKS PASSED');
      console.log('  [T-51] Bug A (PTY null race) — VERIFIED FIXED');
      console.log('  [T-51] Bug B (missing xterm focus) — VERIFIED FIXED');

    } finally {
      await browser.close().catch(() => {});
    }
  });
});
} // end for (const MODE of MODES)
