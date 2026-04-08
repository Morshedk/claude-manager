/**
 * T-01: Double-click "Start Session" Creates Duplicate Sessions
 *
 * Source: Story 3 (Create a Direct-Mode Session)
 * Score: L=4 S=5 D=4 (Total: 13)
 *
 * Tests whether rapid double-clicking the "Start Session" button creates
 * duplicate sessions. The modal closes after the first click (via Preact signal),
 * but the second click may fire before the DOM updates — the race condition window.
 *
 * Run: npx playwright test tests/adversarial/T-01-double-click.test.js --reporter=line --timeout=120000
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
const PORT = 3098;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-01-double-click');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('T-01 — Double-click "Start Session" Creates Duplicate Sessions', () => {

  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';

  // ── Infrastructure Setup ─────────────────────────────────────────────────

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3098 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // 1a — Fresh isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-T01-XXXXXX').toString().trim();
    console.log(`\n  [T-01] tmpDir: ${tmpDir}`);

    // 1b — Start server with crash log
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready — poll GET /api/projects up to 10s
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(500);
    }
    if (!ready) throw new Error('Test server failed to start within 10s');
    console.log(`  [T-01] Server ready on port ${PORT}`);

    // 1c — Create test project via REST API
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T01-TestProject', path: '/tmp' }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T-01] Project created: ${testProjectId} (${proj.name})`);
  });

  test.afterAll(async () => {
    // Always kill server even if test fails
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(3000);
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    // Print crash log if any
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      // Only print crash log if it contains actual errors (not just our own SIGTERM cleanup)
      const meaningfulCrash = crashLog.split('\n').some(line =>
        line.includes('Error') || line.includes('Exception') || line.includes('uncaught') || line.includes('unhandledRejection')
      );
      if (meaningfulCrash) console.log('\n  [CRASH LOG]\n' + crashLog);
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
  });

  // ── Helper: get all sessions for the test project ─────────────────────

  async function getProjectSessions() {
    const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const all = Array.isArray(data.managed) ? data.managed : (Array.isArray(data) ? data : []);
    return all.filter(s => s.projectId === testProjectId);
  }

  /**
   * Delete a session via WebSocket (the server has no REST DELETE /api/sessions/:id endpoint).
   * Sends session:delete and waits for the session to disappear from the API.
   */
  async function deleteSessionViaWS(sessionId) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`deleteSession WS connect timeout for ${sessionId}`));
      }, 5000);

      ws.once('open', () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'session:delete', id: sessionId }));
        // Give the server a moment to process, then close
        setTimeout(() => {
          ws.close();
          resolve();
        }, 800);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ── Helper: open app and navigate to test project ─────────────────────

  async function openApp(browser) {
    const page = await browser.newPage();

    // Capture WS create messages for the double-click counter
    let wsCreateCount = 0;
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('[T01-WS-SEND]')) {
        wsCreateCount++;
      }
      if (msg.type() === 'error') console.log(`  [browser:err] ${text}`);
    });

    // Inject WS send interceptor before navigation
    await page.addInitScript(() => {
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'session:create') {
            console.log('[T01-WS-SEND] session:create intercepted');
          }
        } catch {}
        return origSend.call(this, data);
      };
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for WS connected indicator
    await page.waitForFunction(
      () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
            document.body.textContent.includes('Connected'),
      { timeout: 30000 }
    );
    await sleep(1200);

    // 1d — Navigate to test project: click it in sidebar
    // Wait for T01-TestProject to appear in sidebar
    await page.waitForSelector('text=T01-TestProject', { timeout: 15000 });
    await page.click('text=T01-TestProject');

    // Wait for sessions area to be visible
    await page.waitForSelector('#sessions-area', { timeout: 10000 });

    // Verify title contains project name
    const titleText = await page.textContent('#sessions-area-title').catch(() => '');
    console.log(`  [T-01] Sessions area title: "${titleText}"`);

    return { page, getWsCreateCount: () => wsCreateCount, resetWsCount: () => { wsCreateCount = 0; } };
  }

  // ── THE MAIN TEST ──────────────────────────────────────────────────────

  test('T-01 — Double-click "Start Session" must not create duplicate sessions (5 iterations)', async () => {
    test.setTimeout(300000); // 5 minutes — 5 iterations × ~30s each + browser setup

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const { page, getWsCreateCount, resetWsCount } = await openApp(browser);

    const iterResults = [];

    try {
      // ── Pre-test assertions ──────────────────────────────────────────

      // 2.1 — No sessions exist
      const initialSessions = await getProjectSessions();
      expect(initialSessions.length, 'Pre-test: zero sessions should exist for project').toBe(0);
      console.log('\n  [T-01] Pre-test: 0 sessions confirmed');

      // 2.2 — UI shows empty state
      const emptyText = await page.textContent('#project-sessions-list').catch(() => '');
      expect(emptyText, 'Pre-test: sessions list should show "No sessions"').toContain('No sessions');

      // 2.3 — No session cards in DOM
      const initialCardCount = await page.evaluate(() =>
        document.querySelectorAll('.session-card').length
      );
      expect(initialCardCount, 'Pre-test: no session cards should exist').toBe(0);
      console.log('  [T-01] Pre-test: 0 session cards in DOM');

      // 2.4 — "New Claude Session" button visible
      const newSessionBtn = page.locator('#sessions-area .area-header button:has-text("New Claude Session"), #sessions-area .area-header button:has-text("New Session")').first();
      await expect(newSessionBtn, 'Pre-test: "New Claude Session" button must be visible').toBeVisible();
      console.log('  [T-01] Pre-test: "New Claude Session" button visible');

      // ── 5 Iterations ────────────────────────────────────────────────

      for (let iter = 1; iter <= 5; iter++) {
        console.log(`\n  ════════════════════════════════════`);
        console.log(`  [T-01] Iteration ${iter}/5`);
        console.log(`  ════════════════════════════════════`);

        const iterScreenshotPrefix = path.join(SCREENSHOTS_DIR, `iter-${iter}`);

        // 3a — Screenshot before opening modal
        await page.screenshot({ path: `${iterScreenshotPrefix}-00-pre-modal.png` });

        // 3a — Open the New Session modal
        const newBtn = page.locator('#sessions-area .area-header button').first();
        await newBtn.click();
        await page.waitForSelector('.modal-overlay', { timeout: 10000 });

        // Verify modal header
        const modalHeader = await page.textContent('.modal-overlay').catch(() => '');
        console.log(`  [T-01] iter ${iter}: Modal opened (contains "New Session": ${modalHeader.includes('New Session')})`);

        // 3b — Fill in session name
        const nameInput = page.locator('.modal .form-input[placeholder="e.g. refactor, auth, bugfix"]');
        await nameInput.fill('test-double');

        // 3c — Override command with echo hello
        const cmdInput = page.locator('.modal .form-input[placeholder="claude"]');
        await cmdInput.fill('echo hello');

        // Screenshot after filling modal
        await page.screenshot({ path: `${iterScreenshotPrefix}-01-modal-filled.png` });
        console.log(`  [T-01] iter ${iter}: Modal filled — name="test-double" cmd="echo hello"`);

        // 3d — Execute the double-click via page.evaluate (synchronous, same event loop tick)
        resetWsCount();
        await page.evaluate(() => {
          const btn = document.querySelector('.modal-footer .btn-primary');
          if (!btn) throw new Error('Start Session button not found');
          btn.click();
          btn.click(); // second click fires before Preact can re-render
        });

        // Screenshot 1s after double-click
        await sleep(1000);
        await page.screenshot({ path: `${iterScreenshotPrefix}-02-after-double-click.png` });

        // 3e — Wait for settlement (5 seconds)
        await sleep(4000); // already waited 1s above, total = 5s

        // Screenshot at settlement
        await page.screenshot({ path: `${iterScreenshotPrefix}-03-settled.png` });

        const wsCreatesSent = getWsCreateCount();
        console.log(`  [T-01] iter ${iter}: WS session:create messages sent = ${wsCreatesSent}`);

        // ── Server-side verification ─────────────────────────────────

        const sessions = await getProjectSessions();
        const testDoubleSessions = sessions.filter(s => s.name === 'test-double');
        const apiCount = testDoubleSessions.length;

        // Save API response for forensics
        fs.writeFileSync(
          path.join(SCREENSHOTS_DIR, `iter-${iter}-api-response.json`),
          JSON.stringify(sessions, null, 2)
        );

        console.log(`  [T-01] iter ${iter}: API session count (name=test-double) = ${apiCount}`);

        // 4b — Count total sessions for project
        const totalCount = sessions.length;
        console.log(`  [T-01] iter ${iter}: Total project sessions = ${totalCount}`);

        // 4c — Verify session state (must not be "error")
        for (const s of testDoubleSessions) {
          const state = s.status || s.state;
          console.log(`  [T-01] iter ${iter}: Session ${s.id} state = ${state}`);
          expect(state, `Session state must not be "error"`).not.toBe('error');
        }

        // ── UI verification ──────────────────────────────────────────

        // 5a — Count session cards in DOM
        const domCardCount = await page.evaluate(() =>
          document.querySelectorAll('.session-card').length
        );
        console.log(`  [T-01] iter ${iter}: DOM card count = ${domCardCount}`);

        // 5b — Verify session card name
        if (domCardCount > 0) {
          const cardName = await page.evaluate(() => {
            const el = document.querySelector('.session-card .session-card-name, .session-card [class*="name"]');
            return el ? el.textContent.trim() : '';
          });
          console.log(`  [T-01] iter ${iter}: Session card name = "${cardName}"`);
        }

        // 5c — Check for ghost spinner (badge stuck on "starting")
        // Wait up to 10s for badge to leave "starting" state
        let badgeText = '';
        const badgeDeadline = Date.now() + 10000;
        while (Date.now() < badgeDeadline) {
          badgeText = await page.evaluate(() => {
            const badge = document.querySelector('.session-card .badge, .session-card [class*="badge"], .session-card [class*="status"]');
            return badge ? badge.textContent.trim() : '';
          });
          if (badgeText && badgeText !== 'starting') break;
          await sleep(500);
        }
        const isGhostSpinner = badgeText === 'starting';
        console.log(`  [T-01] iter ${iter}: Badge text = "${badgeText}", ghost spinner = ${isGhostSpinner}`);

        // Determine pass/fail for this iteration
        const iterPass = apiCount === 1 && domCardCount === 1 && !isGhostSpinner;
        const iterResult = {
          iter,
          apiCount,
          domCardCount,
          wsCreatesSent,
          badgeText,
          isGhostSpinner,
          pass: iterPass,
          note: wsCreatesSent === 1 ? 'INCONCLUSIVE (only 1 WS message sent, second click may not have fired)' :
                wsCreatesSent === 2 && apiCount === 1 ? 'GENUINE PASS (2 WS messages sent, server deduplicated)' :
                wsCreatesSent === 2 && apiCount === 2 ? 'GENUINE FAIL (2 WS messages sent, server created duplicate)' :
                `ws_count=${wsCreatesSent}`,
        };
        iterResults.push(iterResult);

        console.log(`  [T-01] Iteration ${iter}: API count=${apiCount}, DOM count=${domCardCount}, badge="${badgeText}" -> ${iterPass ? 'PASS' : 'FAIL'}`);
        if (!iterPass) {
          console.log(`  [T-01] FAIL detail: ${iterResult.note}`);
          await page.screenshot({ path: `${iterScreenshotPrefix}-04-FAIL.png` });
        }

        // ── Cleanup for next iteration ───────────────────────────────

        // Delete all sessions for the project via WS (no REST DELETE endpoint)
        const allSessions = await getProjectSessions();
        for (const s of allSessions) {
          await deleteSessionViaWS(s.id);
          console.log(`  [T-01] Deleted session ${s.id}`);
        }

        // Wait 2s for cleanup, verify empty
        await sleep(2000);
        const remainingSessions = await getProjectSessions();
        console.log(`  [T-01] After cleanup: ${remainingSessions.length} sessions remain`);

        // Wait for DOM to update (session cards should disappear)
        try {
          await page.waitForFunction(
            () => document.querySelectorAll('.session-card').length === 0,
            { timeout: 8000 }
          );
        } catch {
          console.warn(`  [T-01] iter ${iter}: Session cards did not clear from DOM within 8s`);
        }
      }

      // ── 6b — Scoring ──────────────────────────────────────────────

      console.log('\n  ════════════════════════════════════');
      console.log('  [T-01] ITERATION SUMMARY');
      console.log('  ════════════════════════════════════');

      let passCount = 0;
      let inconclusiveCount = 0;
      for (const r of iterResults) {
        const conclusive = r.wsCreatesSent !== 1;
        if (r.pass) passCount++;
        if (!conclusive) inconclusiveCount++;
        console.log(`  Iteration ${r.iter}: API=${r.apiCount} DOM=${r.domCardCount} ws_sends=${r.wsCreatesSent} badge="${r.badgeText}" -> ${r.pass ? 'PASS' : 'FAIL'} [${r.note}]`);
      }

      console.log(`\n  Pass rate: ${passCount}/5`);
      if (inconclusiveCount > 0) {
        console.log(`  WARN: ${inconclusiveCount}/5 iterations were INCONCLUSIVE (second click did not fire — race not exercised)`);
      }

      // 7 — Pass/Fail criteria
      const failCount = 5 - passCount;
      expect(failCount, `${failCount}/5 iterations produced duplicates (threshold: ≤1 for pass)`).toBeLessThanOrEqual(1);

      if (passCount === 5) {
        console.log('\n  [T-01] RESULT: PASS (5/5 iterations produced exactly 1 session)');
        if (inconclusiveCount === 5) {
          console.log('  NOTE: All iterations INCONCLUSIVE — second click never reached the server. Test may not have exercised the race condition.');
        } else if (inconclusiveCount > 0) {
          console.log(`  NOTE: ${inconclusiveCount} iteration(s) INCONCLUSIVE — consider increasing iterations to verify coverage.`);
        } else {
          console.log('  NOTE: All 5 iterations confirmed 2 WS messages sent, server handled deduplication correctly (or client-side protection worked).');
        }
      } else if (passCount === 4) {
        console.log('\n  [T-01] RESULT: FLAKY (4/5 pass — race window exists but rarely triggers)');
      } else {
        console.log(`\n  [T-01] RESULT: FAIL (${passCount}/5 pass — duplicate creation bug confirmed)`);
      }

    } finally {
      // 9 — Cleanup: delete remaining sessions via WS, then delete project via REST
      try {
        const sessions = await getProjectSessions();
        for (const s of sessions) {
          await deleteSessionViaWS(s.id);
        }
      } catch {}

      try {
        await fetch(`${BASE_URL}/api/projects/${testProjectId}`, { method: 'DELETE' });
        console.log(`  [T-01] Test project deleted`);
      } catch {}

      await browser.close();
    }
  });

});
