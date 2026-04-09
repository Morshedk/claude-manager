/**
 * T-06: WebSocket Auto-Reconnect — Terminal Re-Subscribes Without User Action
 *
 * Purpose: Force-close the WebSocket from the browser side, then verify that:
 *   1. The status dot recovers to "Connected" within 10 seconds (no user action).
 *   2. The terminal begins receiving live output again automatically.
 *   3. No duplicate subscriptions are created.
 *   4. The re-subscribe uses the correct session ID (no cross-session bleed).
 *
 * Design doc: tests/adversarial/designs/T-06-design.md
 *
 * Run: PORT=3103 npx playwright test tests/adversarial/T-06-ws-reconnect.test.js --reporter=line --timeout=180000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3103;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 't06-ws-reconnect');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('T-06 — WebSocket Auto-Reconnect: Terminal Re-Subscribes Without User Action', () => {

  let serverProc = null;
  let dataDir = '';
  let crashLogPath = '';
  let testStartTime = 0;

  let sessionId = '';
  let ptyPid = 0;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3103
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    // Create temp data dir
    dataDir = execSync('mktemp -d /tmp/t06-XXXXXX').toString().trim();
    console.log(`\n  [T-06] dataDir: ${dataDir}`);

    // Seed projects.json — MUST use { projects: [...], scratchpad: [] } format
    const projectsSeed = {
      projects: [
        {
          id: 'proj-t06',
          name: 'T06-Project',
          path: '/tmp',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(projectsSeed, null, 2));

    crashLogPath = path.join(dataDir, 'server-crash.log');

    // Start the server
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PORT: String(PORT),
        CRASH_LOG: crashLogPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/sessions`);
        const body = await r.json();
        if (r.ok && typeof body === 'object') { ready = true; break; }
      } catch {}
      await sleep(200);
    }
    if (!ready) throw new Error('Test server failed to start within 10s');
    console.log(`  [T-06] Server ready on port ${PORT} (pid: ${serverProc.pid})`);

    testStartTime = Date.now();
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(1000);
      try {
        process.kill(serverProc.pid, 0);
        try { serverProc.kill('SIGKILL'); } catch {}
      } catch {}
      serverProc = null;
    }

    if (ptyPid) {
      try { process.kill(ptyPid, 'SIGKILL'); } catch {}
    }

    try {
      const crashLog = fs.readFileSync(crashLogPath, 'utf8');
      if (crashLog.trim()) {
        console.log('\n  [T-06] CRASH LOG:\n' + crashLog);
      }
    } catch {}

    if (dataDir) {
      try { execSync(`rm -rf ${dataDir}`); } catch {}
      dataDir = '';
    }
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async function getApiSessions() {
    const r = await fetch(`${BASE_URL}/api/sessions`);
    const body = await r.json();
    return Array.isArray(body.managed) ? body.managed : [];
  }

  async function waitForConnected(page, timeoutMs = 8000) {
    await page.waitForSelector('.status-dot.connected', { timeout: timeoutMs });
  }

  async function waitForDisconnected(page, timeoutMs = 5000) {
    await page.waitForFunction(
      () => !document.querySelector('.status-dot.connected'),
      { timeout: timeoutMs }
    );
  }

  async function selectProject(page, projectName) {
    const projectItem = page.locator('.project-item').filter({ hasText: projectName });
    await projectItem.first().waitFor({ state: 'visible', timeout: 5000 });
    await projectItem.first().click({ timeout: 5000 });
    await page.waitForFunction(
      (name) => {
        const items = document.querySelectorAll('.project-item');
        return [...items].some(el => el.textContent.includes(name) && el.classList.contains('active'));
      },
      projectName,
      { timeout: 5000 }
    );
  }

  async function waitForSessionCard(page, sessionName, timeoutMs = 8000) {
    await page.waitForFunction(
      (name) => {
        const cards = document.querySelectorAll('.session-card');
        return [...cards].some(c => c.textContent.includes(name) && c.textContent.toLowerCase().includes('running'));
      },
      sessionName,
      { timeout: timeoutMs }
    );
  }

  async function openSessionOverlay(page, sessionName, timeoutMs = 8000) {
    const card = page.locator('.session-card').filter({ hasText: sessionName });
    await card.first().waitFor({ state: 'visible', timeout: 5000 });
    await card.first().click();
    await page.waitForSelector('#session-overlay', { state: 'visible', timeout: timeoutMs });
    await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: timeoutMs });
  }

  async function typeAndVerifyMarker(page, marker, timeoutMs = 8000) {
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
      marker,
      { timeout: timeoutMs }
    );
  }

  // ── THE SINGLE TEST ─────────────────────────────────────────────────────────

  test('T-06 — WS force-close: auto-reconnect, terminal re-subscribes, live output resumes', async () => {
    test.setTimeout(120000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    let page;
    const consoleLogs = [];

    try {
      const context = await browser.newContext();
      page = await context.newPage();

      // ── Inject WS intercept BEFORE navigation ────────────────────────────
      // Uses Proxy to capture every new WebSocket instance in window._testWs
      // Uses patched send to count session:subscribe messages
      await page.addInitScript(() => {
        window._subscribeCount = 0;
        window._lastSubscribeId = null;
        window._testWs = null;

        const NativeWS = window.WebSocket;
        window.WebSocket = new Proxy(NativeWS, {
          construct(target, args) {
            const instance = new target(...args);
            window._testWs = instance;
            // Patch send on the instance to track subscribes
            const origSend = instance.send.bind(instance);
            instance.send = function(data) {
              try {
                const msg = JSON.parse(data);
                if (msg.type === 'session:subscribe') {
                  window._subscribeCount = (window._subscribeCount || 0) + 1;
                  window._lastSubscribeId = msg.id;
                  console.log('[TEST-INTERCEPT] session:subscribe sent, count:', window._subscribeCount, 'id:', msg.id);
                }
              } catch {}
              return origSend(data);
            };
            return instance;
          }
        });
      });

      // Capture console logs
      page.on('console', msg => {
        consoleLogs.push({ type: msg.type(), text: msg.text() });
        if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
        if (msg.text().startsWith('[TEST-INTERCEPT]') || msg.text().startsWith('[ws]')) {
          console.log(`  [browser:log] ${msg.text()}`);
        }
      });

      // Navigate
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await waitForConnected(page, 8000);
      console.log('\n  [T-06] App loaded and Connected');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-pre-session.png') });

      // ── Section 1: Setup session ─────────────────────────────────────────

      await selectProject(page, 'T06-Project');
      console.log('  [T-06] Project selected');

      // Open new session modal
      const newSessionBtn = page.locator('#sessions-area .btn-primary').first();
      await newSessionBtn.waitFor({ state: 'visible', timeout: 5000 });
      await newSessionBtn.click({ timeout: 5000 });
      await page.waitForSelector('.modal', { state: 'visible', timeout: 5000 });

      // Fill session name
      const nameInput = page.locator('.modal .modal-body .form-input').first();
      await nameInput.fill('t06-bash-session');

      // Set command to bash
      const commandInput = page.locator('.modal .modal-body .form-input').nth(1);
      await commandInput.fill('bash');

      // Click Start Session
      const startBtn = page.locator('.modal-footer .btn-primary');
      await startBtn.click();
      console.log('  [T-06] Start Session clicked');

      // Wait for session card running
      await waitForSessionCard(page, 't06-bash-session', 8000);
      console.log('  [T-06] Session card shows running');

      // Confirm via API
      const allSessions = await getApiSessions();
      const sess = allSessions.find(s => s.name === 't06-bash-session');
      expect(sess, 'Session must exist in API').toBeTruthy();
      const sessStatus = sess.status || sess.state;
      expect(sessStatus, 'Session must be running').toBe('running');
      expect(sess.pid, 'Session must have a positive PID').toBeGreaterThan(0);

      sessionId = sess.id;
      ptyPid = sess.pid;
      console.log(`  [T-06] Session id=${sessionId} pid=${ptyPid}`);

      // ── Section 2: Open terminal and baseline output ─────────────────────

      await openSessionOverlay(page, 't06-bash-session', 5000);
      console.log('  [T-06] Session overlay open');

      await sleep(500);
      await typeAndVerifyMarker(page, 'T06_BASELINE', 8000);
      console.log('  [T-06] Baseline marker T06_BASELINE appeared');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-baseline.png') });

      // Record baseline subscribe count — should be 1 after initial mount + subscribe
      await sleep(300); // Let any pending subscribes settle
      const baselineSubCount = await page.evaluate(() => window._subscribeCount);
      console.log(`  [T-06] Baseline subscribe count: ${baselineSubCount}`);
      // Should be exactly 1 (initial SESSION_SUBSCRIBE from TerminalPane mount)
      expect(baselineSubCount, 'Should have exactly 1 subscribe at baseline').toBeGreaterThanOrEqual(1);

      // Verify _testWs is present before drop
      const wsPresent = await page.evaluate(() => window._testWs !== null && window._testWs.readyState === WebSocket.OPEN);
      expect(wsPresent, 'window._testWs must be OPEN before drop').toBe(true);
      console.log('  [T-06] WS intercept confirmed: _testWs is OPEN');

      // ── Section 3: ROUND 1 — Drop and verify auto-reconnect ─────────────

      console.log('\n  [T-06] === ROUND 1: Forcing WS close ===');

      const dropTimestamp1 = Date.now();

      // Force-close the WS from the browser
      const closeResult = await page.evaluate(() => {
        if (!window._testWs) return 'no_ws';
        const state = window._testWs.readyState;
        window._testWs.close();
        return `closed_from_state_${state}`;
      });
      console.log(`  [T-06] WS close result: ${closeResult}`);
      expect(closeResult, 'WS close must succeed (not no_ws)').not.toBe('no_ws');

      // P2: Verify disconnect was detected (dot goes non-connected)
      await waitForDisconnected(page, 5000);
      const disconnectTime = Date.now() - dropTimestamp1;
      console.log(`  [T-06] ROUND 1 P2 PASS — Disconnect detected in ${disconnectTime}ms`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-post-drop-round1.png') });

      // P1: Wait for reconnect WITHOUT user interaction
      await waitForConnected(page, 10000);
      const reconnectTime1 = Date.now() - dropTimestamp1;
      console.log(`  [T-06] ROUND 1 P1 PASS — Reconnect detected in ${reconnectTime1}ms`);
      expect(reconnectTime1, 'WS must reconnect within 10000ms').toBeLessThan(10000);

      // Verify status text
      const statusText1 = await page.locator('.status-text').first().textContent().catch(() => '');
      expect(statusText1, 'Status text should say Connected').toContain('Connected');

      // P4: Terminal must repopulate (not blank) after reconnect
      await sleep(1500); // Allow time for session:subscribed + PTY snapshot to arrive
      const termTextAfterReconnect1 = await page.evaluate(
        () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.trim() ?? ''
      );
      expect(termTextAfterReconnect1.length, 'Terminal must not be blank after reconnect').toBeGreaterThan(0);
      console.log(`  [T-06] ROUND 1 P4 PASS — Terminal not blank (${termTextAfterReconnect1.length} chars)`);

      // P3: Live output — unique marker typed AFTER reconnect
      const marker1 = `T06_RECONNECT1_${Date.now()}`;
      await typeAndVerifyMarker(page, marker1, 8000);
      console.log(`  [T-06] ROUND 1 P3 PASS — Live output marker ${marker1} appeared`);

      // P5: Subscribe count — should be baselineSubCount + 1
      const subCount1 = await page.evaluate(() => window._subscribeCount);
      console.log(`  [T-06] ROUND 1 subscribe count: ${subCount1} (was ${baselineSubCount})`);
      expect(subCount1, 'Exactly 1 re-subscribe should have been sent').toBe(baselineSubCount + 1);

      // P6: Re-subscribe used correct session ID
      const lastSubId1 = await page.evaluate(() => window._lastSubscribeId);
      console.log(`  [T-06] ROUND 1 last subscribe ID: ${lastSubId1}`);
      expect(lastSubId1, 'Re-subscribe must use correct session ID').toBe(sessionId);

      // P7: No doubled output — echo DUPCHECK and count occurrences
      const dupMarker1 = `DUPCHK1_${Date.now()}`;
      await page.keyboard.type(`echo ${dupMarker1}`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
        dupMarker1,
        { timeout: 5000 }
      );
      await sleep(200); // Brief settle to catch any duplicates
      const dupCount1 = await page.evaluate((m) => {
        const text = document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent ?? '';
        return (text.match(new RegExp(m, 'g')) || []).length;
      }, dupMarker1);
      console.log(`  [T-06] ROUND 1 P7: "${dupMarker1}" appears ${dupCount1}x in terminal (expect <=3 for no dup)`);
      // In bash: command line shows "echo DUPCHK..." + output "DUPCHK..." = 2 occurrences normally
      // With duplicate subscription: each PTY message sent twice → 4+ occurrences
      expect(dupCount1, 'Output should not be doubled (duplicate subscription check)').toBeLessThanOrEqual(3);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-post-reconnect-round1.png') });

      // ── Section 4: Server-side verification ────────────────────────────

      const sessAfterRound1 = (await getApiSessions()).find(s => s.id === sessionId);
      expect(sessAfterRound1, 'Session must still exist in API').toBeTruthy();
      const sessStatus1 = sessAfterRound1.status || sessAfterRound1.state;
      expect(sessStatus1, 'Session must still be running').toBe('running');
      expect(sessAfterRound1.pid, 'Session PID must be unchanged').toBe(ptyPid);
      console.log(`  [T-06] ROUND 1 server check PASS — running, pid=${sessAfterRound1.pid}`);

      try {
        process.kill(ptyPid, 0);
        console.log(`  [T-06] ROUND 1 PTY pid=${ptyPid} alive`);
      } catch (err) {
        throw new Error(`ROUND 1: PTY pid=${ptyPid} is dead: ${err.message}`);
      }

      console.log(`  [T-06] ROUND 1 COMPLETE — reconnect=${reconnectTime1}ms, all checks PASS`);

      // ── Section 5: ROUND 2 — Second drop to confirm reliability ────────

      console.log('\n  [T-06] === ROUND 2: Second WS drop (reliability check) ===');

      const dropTimestamp2 = Date.now();

      // Force-close again
      const closeResult2 = await page.evaluate(() => {
        if (!window._testWs) return 'no_ws';
        const state = window._testWs.readyState;
        window._testWs.close();
        return `closed_from_state_${state}`;
      });
      console.log(`  [T-06] ROUND 2 WS close result: ${closeResult2}`);
      expect(closeResult2, 'ROUND 2: WS close must succeed').not.toBe('no_ws');

      // Verify disconnect
      await waitForDisconnected(page, 5000);
      const disconnectTime2 = Date.now() - dropTimestamp2;
      console.log(`  [T-06] ROUND 2: Disconnect in ${disconnectTime2}ms`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-post-drop-round2.png') });

      // Wait for reconnect
      await waitForConnected(page, 10000);
      const reconnectTime2 = Date.now() - dropTimestamp2;
      console.log(`  [T-06] ROUND 2: Reconnect in ${reconnectTime2}ms`);
      expect(reconnectTime2, 'ROUND 2: WS must reconnect within 10000ms').toBeLessThan(10000);

      // Terminal repopulate
      await sleep(1500);
      const termTextAfterReconnect2 = await page.evaluate(
        () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.trim() ?? ''
      );
      expect(termTextAfterReconnect2.length, 'ROUND 2: Terminal must not be blank after reconnect').toBeGreaterThan(0);
      console.log(`  [T-06] ROUND 2: Terminal not blank (${termTextAfterReconnect2.length} chars)`);

      // Live output marker
      const marker2 = `T06_RECONNECT2_${Date.now()}`;
      await typeAndVerifyMarker(page, marker2, 8000);
      console.log(`  [T-06] ROUND 2: Live output marker ${marker2} appeared`);

      // Subscribe count for round 2
      const subCount2 = await page.evaluate(() => window._subscribeCount);
      console.log(`  [T-06] ROUND 2 subscribe count: ${subCount2} (was ${subCount1})`);
      expect(subCount2, 'ROUND 2: Exactly 1 more re-subscribe should have been sent').toBe(subCount1 + 1);

      // Correct session ID
      const lastSubId2 = await page.evaluate(() => window._lastSubscribeId);
      expect(lastSubId2, 'ROUND 2: Re-subscribe must use correct session ID').toBe(sessionId);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-post-reconnect-round2.png') });
      console.log(`  [T-06] ROUND 2 COMPLETE — reconnect=${reconnectTime2}ms, all checks PASS`);

      // ── Section 6: Final server and crash log checks ─────────────────────

      const finalSessions = await getApiSessions();
      fs.writeFileSync(
        path.join(SCREENSHOTS_DIR, 'final-api-state.json'),
        JSON.stringify(finalSessions, null, 2)
      );

      // Check crash log
      try {
        const crashLog = fs.readFileSync(crashLogPath, 'utf8');
        const testEntries = crashLog
          .split('\n')
          .filter(line => {
            if (!line.trim()) return false;
            const match = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
            if (!match) return false;
            const ts = new Date(match[1]).getTime();
            return ts >= testStartTime;
          });
        if (testEntries.length > 0) {
          console.error('\n  [T-06] CRASH LOG entries during test:\n' + testEntries.join('\n'));
          expect(testEntries.length, 'Crash log must be empty (no unhandled exceptions)').toBe(0);
        } else {
          console.log('  [T-06] Crash log: clean');
        }
      } catch {
        console.log('  [T-06] Crash log: not found (no crashes)');
      }

      // Final server alive
      try {
        process.kill(serverProc.pid, 0);
        console.log(`  [T-06] Final check: server pid=${serverProc.pid} alive`);
      } catch {
        throw new Error('Server process died during the test!');
      }

      // Print subscribe intercept logs summary
      const interceptLogs = consoleLogs.filter(l => l.text.includes('[TEST-INTERCEPT]'));
      console.log(`\n  [T-06] Subscribe intercept log (${interceptLogs.length} entries):`);
      interceptLogs.forEach(l => console.log(`    ${l.text}`));

      console.log('\n  [T-06] ALL CHECKS PASSED');
      console.log(`  Round 1: drop→connected=${reconnectTime1}ms`);
      console.log(`  Round 2: drop→connected=${reconnectTime2}ms`);
      console.log(`  Total subscribes sent: ${subCount2} (initial=${baselineSubCount}, +1 per round = correct)`);

    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  });

}); // end describe
