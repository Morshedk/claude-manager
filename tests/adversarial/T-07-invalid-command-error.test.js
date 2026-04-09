/**
 * T-07: Session Created with Invalid Command Shows Error Badge — Not Spinner Forever
 *
 * Source: Story 20
 * Score: L=3 S=5 D=5 (Total: 13)
 *
 * Flow: Create a session with command "claude-nonexistent-binary-xyz".
 * Wait 10 seconds. The session card badge must show "error", not "starting".
 * No infinite spinner. No JS exceptions.
 *
 * Run: PORT=3104 npx playwright test tests/adversarial/T-07-invalid-command-error.test.js --reporter=line --timeout=120000
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
const PORT = 3104;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T07-invalid-command');

const INVALID_CMD = 'claude-nonexistent-binary-xyz';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Open a WebSocket and wait for a message matching predicate.
 * Returns the matching message parsed from JSON.
 */
function waitForMsg(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waitForMsg timeout after ${timeoutMs}ms`)), timeoutMs);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

/**
 * Create a session via WebSocket and collect state change messages.
 * Returns { sessionId, stateHistory }.
 */
async function createSessionAndCollectStates(wsUrl, projectId, sessionName) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const stateHistory = [];
    let sessionId = null;
    let createdTs = null;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('createSessionAndCollectStates timeout'));
    }, 15000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session:create',
        projectId,
        name: sessionName,
        command: INVALID_CMD,
        mode: 'direct',
        cols: 120,
        rows: 30,
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'session:created') {
          sessionId = msg.session.id;
          createdTs = Date.now();
        }
        if (msg.type === 'session:state') {
          stateHistory.push({ state: msg.state, previousState: msg.previousState, ts: Date.now() });
        }
      } catch {}
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Keep collecting for 12 seconds after session is created, then resolve
    const checkInterval = setInterval(() => {
      if (sessionId && Date.now() - createdTs > 12000) {
        clearInterval(checkInterval);
        clearTimeout(timer);
        ws.close();
        resolve({ sessionId, stateHistory, ws });
      }
    }, 200);
  });
}

test.describe('T-07 — Invalid Command Error Badge', () => {
  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';
  const consoleErrors = [];
  const pageErrors = [];

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Verify the binary truly does not exist
    try {
      execSync(`which ${INVALID_CMD} 2>/dev/null`);
      throw new Error(`Binary "${INVALID_CMD}" unexpectedly exists — test invalid`);
    } catch (e) {
      if (e.message.includes('test invalid')) throw e;
      // which returned non-zero (not found) — good
    }

    // Kill anything on port 3104 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Create isolated temp dir
    tmpDir = execSync('mktemp -d /tmp/qa-T07-XXXXXX').toString().trim();
    console.log(`\n  [T-07] tmpDir: ${tmpDir}`);

    // Create project directory
    const projDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projDir, { recursive: true });

    // Start server with crash log
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Poll for server ready
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 15s');
    console.log(`  [T-07] Server ready on port ${PORT}`);

    // Create test project via REST
    const projDir2 = path.join(tmpDir, 'project');
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T07-TestProject', path: projDir2 }),
    }).then(r => r.json());
    testProjectId = proj.id || proj.project?.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T-07] Test project ID: ${testProjectId}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      serverProc.kill('SIGKILL');
      await sleep(500);
    }

    // Check crash log
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    if (fs.existsSync(crashLogPath)) {
      const crashContent = fs.readFileSync(crashLogPath, 'utf8').trim();
      if (crashContent) {
        console.log(`\n  [T-07] SERVER CRASH LOG:\n${crashContent}`);
      }
    }

    // Safety net port cleanup
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}

    // Cleanup temp dir
    if (tmpDir) {
      try { execSync(`rm -rf ${tmpDir}`); } catch {}
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Helper: Run one full T-07 check cycle
  // ─────────────────────────────────────────────────────────────────────────
  async function runOneCheck(browser, runNum) {
    console.log(`\n  [T-07] === Run ${runNum} ===`);

    const sessionName = `T07-invalid-cmd-${runNum}`;

    // ── Create session and collect state changes over WS ──────────────────
    console.log(`  [T-07] Creating session "${sessionName}" with invalid command...`);
    const wsUrl = `ws://127.0.0.1:${PORT}`;
    const ws = new WebSocket(wsUrl);

    // Track state history
    const stateHistory = [];
    let sessionId = null;
    const sessionCreatedPromise = waitForMsg(ws, m => m.type === 'session:created', 10000);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'session:state') {
          stateHistory.push({ state: msg.state, previousState: msg.previousState, ts: Date.now() });
          console.log(`  [T-07]   state change: ${msg.previousState} → ${msg.state}`);
        }
      } catch {}
    });

    await new Promise(resolve => ws.on('open', resolve));

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: testProjectId,
      name: sessionName,
      command: INVALID_CMD,
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const createdMsg = await sessionCreatedPromise;
    sessionId = createdMsg.session.id;
    const createdAt = Date.now();
    console.log(`  [T-07] Session created: ${sessionId}`);
    console.log(`  [T-07] Initial state: ${createdMsg.session.state || createdMsg.session.status}`);

    // ── Open browser and navigate ─────────────────────────────────────────
    const context = await browser.newContext();
    const page = await context.newPage();

    const runConsoleErrors = [];
    const runPageErrors = [];

    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error' || /uncaught|typeerror|referenceerror|unexpected/i.test(text)) {
        runConsoleErrors.push({ type: msg.type(), text });
        console.log(`  [T-07] CONSOLE ERROR: [${msg.type()}] ${text}`);
      }
    });
    page.on('pageerror', err => {
      runPageErrors.push(err.message);
      console.log(`  [T-07] PAGE ERROR: ${err.message}`);
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    // Verify not blank page
    const bodyText = await page.evaluate(() => document.body.innerHTML.length);
    console.log(`  [T-07] Page body length: ${bodyText}`);
    expect(bodyText).toBeGreaterThan(100);

    // Navigate to test project
    try {
      await page.waitForSelector('text=T07-TestProject', { timeout: 8000 });
      await page.click('text=T07-TestProject');
      console.log(`  [T-07] Clicked project "T07-TestProject"`);
    } catch (e) {
      console.log(`  [T-07] WARN: Could not find/click project in sidebar: ${e.message}`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `T07-run${runNum}-no-project.png`), fullPage: true });
    }
    await sleep(1000);

    // ── Wait 10 seconds from session creation (spec requirement) ───────────
    const elapsed = Date.now() - createdAt;
    const remaining = Math.max(0, 10000 - elapsed);
    console.log(`  [T-07] Waiting ${remaining}ms more to reach 10s mark...`);
    await sleep(remaining + 500); // slight overshoot

    // ── Screenshot after 10 seconds ───────────────────────────────────────
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `T07-0${runNum * 2 - 1}-after-10s-run${runNum}.png`),
      fullPage: true,
    });
    console.log(`  [T-07] Screenshot saved: after-10s-run${runNum}`);

    // ── Check badge via waitForFunction ───────────────────────────────────
    console.log(`  [T-07] Checking badge state...`);

    // First check if ANY badge is visible for this session
    const badgeInfo = await page.evaluate((sName) => {
      const cards = document.querySelectorAll('.session-card');
      const results = [];
      for (const card of cards) {
        const nameEl = card.querySelector('.session-card-name');
        const badge = card.querySelector('.badge-activity');
        if (nameEl && badge) {
          results.push({ name: nameEl.textContent.trim(), badgeText: badge.textContent.trim() });
        }
      }
      return results;
    }, sessionName);

    console.log(`  [T-07] All session badges: ${JSON.stringify(badgeInfo)}`);

    // Find badge for our specific session
    const ourSession = badgeInfo.find(b => b.name === sessionName || b.name.includes('T07'));
    const badgeText = ourSession?.badgeText || '';
    console.log(`  [T-07] Our session badge: "${badgeText}"`);

    // Also check via waitForFunction with a generous timeout
    let badgeFoundError = false;
    try {
      await page.waitForFunction(
        (sName) => {
          const cards = document.querySelectorAll('.session-card');
          for (const card of cards) {
            const nameEl = card.querySelector('.session-card-name');
            const badge = card.querySelector('.badge-activity');
            if (nameEl && badge && (nameEl.textContent.includes(sName) || nameEl.textContent.includes('T07'))) {
              return badge.textContent.includes('error');
            }
          }
          return false;
        },
        sessionName,
        { timeout: 5000 }
      );
      badgeFoundError = true;
      console.log(`  [T-07] ✓ Badge confirmed "error" via waitForFunction`);
    } catch (e) {
      console.log(`  [T-07] waitForFunction for "error" badge timed out: ${e.message}`);
    }

    // Check that badge is NOT "starting" or "running"
    const badgeIsStarting = badgeInfo.some(b =>
      (b.name === sessionName || b.name.includes('T07')) &&
      (b.badgeText.includes('starting') || b.badgeText.includes('running'))
    );

    if (badgeIsStarting) {
      console.log(`  [T-07] FAIL: Badge still shows "starting"/"running" after 10s — infinite spinner bug!`);
    }

    // ── Check WS state history ────────────────────────────────────────────
    const finalState = stateHistory.length > 0
      ? stateHistory[stateHistory.length - 1].state
      : (createdMsg.session.state || createdMsg.session.status);
    console.log(`  [T-07] WS state history: ${JSON.stringify(stateHistory.map(s => s.state))}`);
    console.log(`  [T-07] Final state from WS: ${finalState}`);

    // ── Optional: open overlay to check terminal output ────────────────────
    try {
      if (ourSession) {
        const cards = page.locator('.session-card');
        const count = await cards.count();
        for (let i = 0; i < count; i++) {
          const card = cards.nth(i);
          const nameText = await card.locator('.session-card-name').textContent().catch(() => '');
          if (nameText.includes('T07') || nameText.includes(sessionName)) {
            await card.click();
            await sleep(2000);
            await page.screenshot({
              path: path.join(SCREENSHOTS_DIR, `T07-0${runNum * 2}-terminal-run${runNum}.png`),
              fullPage: true,
            });
            console.log(`  [T-07] Screenshot: terminal overlay for run ${runNum}`);
            // Check terminal has some content (error output)
            const termContent = await page.evaluate(() => {
              const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
              return Array.from(rows).map(r => r.textContent.trim()).filter(t => t.length > 0);
            }).catch(() => []);
            console.log(`  [T-07] Terminal content rows: ${termContent.length}`);
            if (termContent.length > 0) {
              console.log(`  [T-07] First content rows: ${termContent.slice(0, 3).join(' | ')}`);
            }
            // Close overlay
            const closeBtn = page.locator('#btn-detach');
            if (await closeBtn.isVisible().catch(() => false)) {
              await closeBtn.click();
              await sleep(500);
            }
            break;
          }
        }
      }
    } catch (e) {
      console.log(`  [T-07] Could not open overlay: ${e.message}`);
    }

    // ── Cleanup this run ──────────────────────────────────────────────────
    await context.close();
    ws.close();

    // Delete session via WS
    const wsCleanup = new WebSocket(wsUrl);
    await new Promise(resolve => wsCleanup.on('open', resolve));
    wsCleanup.send(JSON.stringify({ type: 'session:delete', id: sessionId }));
    await sleep(500);
    wsCleanup.close();

    // ── Return results for assertions ─────────────────────────────────────
    return {
      runNum,
      sessionId,
      sessionName,
      badgeText,
      badgeFoundError,
      badgeIsStarting,
      stateHistory,
      finalState,
      consoleErrors: runConsoleErrors,
      pageErrors: runPageErrors,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main test: 3 runs
  // ─────────────────────────────────────────────────────────────────────────

  test('T-07 Run 1: invalid command shows error badge within 10s', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
      const result = await runOneCheck(browser, 1);

      console.log(`\n  [T-07] === Run 1 Results ===`);
      console.log(`  Badge text: "${result.badgeText}"`);
      console.log(`  Badge shows error: ${result.badgeFoundError}`);
      console.log(`  Badge is starting: ${result.badgeIsStarting}`);
      console.log(`  Final WS state: ${result.finalState}`);
      console.log(`  Console errors: ${result.consoleErrors.length}`);
      console.log(`  Page errors: ${result.pageErrors.length}`);

      // Core assertions
      expect(result.badgeIsStarting, 'Badge must NOT be "starting" after 10s').toBeFalsy();
      expect(result.badgeFoundError || result.finalState === 'error',
        `Badge must show "error" or WS state must be "error". Badge="${result.badgeText}", WS state="${result.finalState}"`
      ).toBeTruthy();
      expect(result.pageErrors.length, `No JS page errors. Got: ${result.pageErrors.join(', ')}`).toBe(0);
      expect(result.consoleErrors.length, `No console errors. Got: ${JSON.stringify(result.consoleErrors)}`).toBe(0);
      expect(result.finalState, 'WS final state must be "error"').toBe('error');

    } finally {
      await browser.close();
    }
  });

  test('T-07 Run 2: repeat — invalid command shows error badge (not transient)', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
      const result = await runOneCheck(browser, 2);

      console.log(`\n  [T-07] === Run 2 Results ===`);
      console.log(`  Badge text: "${result.badgeText}"`);
      console.log(`  Badge shows error: ${result.badgeFoundError}`);
      console.log(`  Badge is starting: ${result.badgeIsStarting}`);
      console.log(`  Final WS state: ${result.finalState}`);

      expect(result.badgeIsStarting, 'Run 2: Badge must NOT be "starting" after 10s').toBeFalsy();
      expect(result.badgeFoundError || result.finalState === 'error',
        `Run 2: Badge must show "error". Badge="${result.badgeText}", WS state="${result.finalState}"`
      ).toBeTruthy();
      expect(result.pageErrors.length, `Run 2: No page errors`).toBe(0);
      expect(result.finalState, 'Run 2: WS final state must be "error"').toBe('error');

    } finally {
      await browser.close();
    }
  });

  test('T-07 Run 3: third repetition — consistent error badge behavior', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
      const result = await runOneCheck(browser, 3);

      console.log(`\n  [T-07] === Run 3 Results ===`);
      console.log(`  Badge text: "${result.badgeText}"`);
      console.log(`  Badge shows error: ${result.badgeFoundError}`);
      console.log(`  Badge is starting: ${result.badgeIsStarting}`);
      console.log(`  Final WS state: ${result.finalState}`);

      expect(result.badgeIsStarting, 'Run 3: Badge must NOT be "starting" after 10s').toBeFalsy();
      expect(result.badgeFoundError || result.finalState === 'error',
        `Run 3: Badge must show "error". Badge="${result.badgeText}", WS state="${result.finalState}"`
      ).toBeTruthy();
      expect(result.pageErrors.length, `Run 3: No page errors`).toBe(0);
      expect(result.finalState, 'Run 3: WS final state must be "error"').toBe('error');

    } finally {
      await browser.close();
    }
  });
});
