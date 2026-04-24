/**
 * T-02: Browser Hard-Reload Reconnects and Shows Live Session
 *
 * Purpose: Verify that after a hard browser reload (cache bypassed via CDP),
 * the app reconnects via WebSocket and the existing bash session remains live
 * (same PTY PID, bidirectional I/O). Runs 3 reload rounds.
 *
 * Design doc: tests/adversarial/designs/T-02-design.md
 *
 * Run: npx playwright test tests/adversarial/T-02-browser-reload.test.js --reporter=line --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORTS = { direct: 3099, tmux: 3699 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `t02-hard-reload-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Server lifecycle ──────────────────────────────────────────────────────────
test.describe(`T-02 — Browser Hard-Reload Reconnects and Shows Live Session [${MODE}]`, () => {

  let serverProc = null;
  let dataDir = '';
  let crashLogPath = '';
  let testStartTime = 0;

  // Per-test state (set inside the single test)
  let sessionId = '';
  let ptyPid = 0;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3099 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    // Create temp data dir
    dataDir = execSync('mktemp -d /tmp/t02-XXXXXX').toString().trim();
    console.log(`\n  [T-02] dataDir: ${dataDir}`);

    // Seed projects.json with one test project pointing to /tmp
    // NOTE: ProjectStore expects { projects: [...], scratchpad: [] } format, NOT a plain array
    const projectsSeed = {
      projects: [
        {
          id: 'proj-t02',
          name: 'T02-Project',
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

    // Wait for server ready — poll /api/sessions
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/sessions`);
        const body = await r.json();
        if (r.ok && typeof body === 'object') { ready = true; break; }
      } catch {}
      await sleep(200);
    }
    if (!ready) throw new Error('Test server failed to start within 8s');
    console.log(`  [T-02] Server ready on port ${PORT} (pid: ${serverProc.pid})`);

    testStartTime = Date.now();
  });

  test.afterAll(async () => {
    // Kill server
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(1000);
      try {
        process.kill(serverProc.pid, 0);
        // Still alive — force kill
        try { serverProc.kill('SIGKILL'); } catch {}
      } catch {}
      serverProc = null;
    }

    // Kill bash PTY if still alive
    if (ptyPid) {
      try { process.kill(ptyPid, 'SIGKILL'); } catch {}
    }

    // Print crash log if any
    try {
      const crashLog = fs.readFileSync(crashLogPath, 'utf8');
      if (crashLog.trim()) {
        console.log('\n  [T-02] CRASH LOG:\n' + crashLog);
      }
    } catch {}

    // Clean up data dir
    if (dataDir) {
      try { execSync(`rm -rf ${dataDir}`); } catch {}
      dataDir = '';
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function getApiSessions() {
    const r = await fetch(`${BASE_URL}/api/sessions`);
    const body = await r.json();
    const all = Array.isArray(body.managed) ? body.managed : [];
    return all;
  }

  async function getSessionById(id) {
    const all = await getApiSessions();
    return all.find(s => s.id === id) || null;
  }

  /**
   * Perform a hard reload using CDP to bypass cache.
   */
  async function hardReload(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  /**
   * Wait for the TopBar "Connected" status dot.
   */
  async function waitForConnected(page, timeoutMs = 8000) {
    await page.waitForSelector('.status-dot.connected', { timeout: timeoutMs });
  }

  /**
   * Click a project item by name and verify it becomes active.
   */
  async function selectProject(page, projectName) {
    // Find the project item containing the project name — wait for it to exist first
    const projectItem = page.locator('.project-item').filter({ hasText: projectName });
    await projectItem.first().waitFor({ state: 'visible', timeout: 5000 });
    await projectItem.first().click({ timeout: 5000 });
    // Wait for it to have the active class
    await page.waitForFunction(
      (name) => {
        const items = document.querySelectorAll('.project-item');
        return [...items].some(el => el.textContent.includes(name) && el.classList.contains('active'));
      },
      projectName,
      { timeout: 5000 }
    );
  }

  /**
   * Wait for a session card to show "running".
   */
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

  /**
   * Open the session overlay by clicking the session card.
   */
  async function openSessionOverlay(page, sessionName, timeoutMs = 8000) {
    // Click the session card
    const card = page.locator('.session-card').filter({ hasText: sessionName });
    await card.first().click();
    // Wait for overlay to appear
    await page.waitForSelector('#session-overlay', { state: 'visible', timeout: timeoutMs });
    // Wait for xterm screen
    await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: timeoutMs });
  }

  /**
   * Type a unique marker into the terminal and wait for it to appear.
   * NOTE: Uses \r (carriage return) not \n — xterm/PTY needs CR.
   */
  async function typeAndVerifyMarker(page, marker, timeoutMs = 8000) {
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
      marker,
      { timeout: timeoutMs }
    );
  }

  /**
   * Close the session overlay by pressing Escape (or clicking btn-detach).
   */
  async function closeSessionOverlay(page) {
    // Try clicking the detach button first
    const detachBtn = page.locator('#btn-detach');
    const visible = await detachBtn.isVisible().catch(() => false);
    if (visible) {
      await detachBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    // Wait for overlay to disappear
    await page.waitForSelector('#session-overlay', { state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  /**
   * Run all post-reload checks for one round.
   */
  async function runPostReloadChecks(page, roundNum, reloadTimestamp, overlayWasOpen) {
    console.log(`\n  [T-02] Round ${roundNum}: post-reload checks starting...`);

    // Check 1: Page loaded
    await page.waitForSelector('#topbar', { state: 'visible', timeout: 5000 });
    console.log(`  [T-02] Round ${roundNum}: Check 1 PASS — #topbar visible`);

    // Check 2: WS reconnects, status dot shows "Connected"
    await waitForConnected(page, 8000);
    const wsReconnectTime = Date.now() - reloadTimestamp;
    console.log(`  [T-02] Round ${roundNum}: Check 2 PASS — Connected dot visible (${wsReconnectTime}ms)`);
    expect(wsReconnectTime, 'WS must reconnect within 5000ms').toBeLessThan(5000);

    // Also verify status-text
    const statusText = await page.locator('.status-text').first().textContent().catch(() => '');
    expect(statusText, 'Status text should say Connected').toContain('Connected');

    // Check 3: Project list loads
    await page.waitForFunction(
      () => document.querySelector('#project-list')?.textContent?.includes('T02-Project'),
      { timeout: 5000 }
    );
    console.log(`  [T-02] Round ${roundNum}: Check 3 PASS — Project list shows T02-Project`);

    // Check 4: Select project, session card shows "running"
    await selectProject(page, 'T02-Project');
    await waitForSessionCard(page, 't02-bash-session', 5000);
    console.log(`  [T-02] Round ${roundNum}: Check 4 PASS — Session card shows running`);

    // Check 5: Server-side verification
    const session = await getSessionById(sessionId);
    expect(session, `Session ${sessionId} must exist in API`).toBeTruthy();
    const sessionStatus = session.status || session.state;
    expect(sessionStatus, 'Session must still be running').toBe('running');
    expect(session.pid, 'Session PID must match pre-reload PID').toBe(ptyPid);
    console.log(`  [T-02] Round ${roundNum}: Check 5 PASS — API confirms running, pid=${session.pid}`);

    // Check 6: PTY process alive
    try {
      process.kill(ptyPid, 0);
      console.log(`  [T-02] Round ${roundNum}: Check 6 PASS — PTY pid=${ptyPid} alive`);
    } catch (err) {
      throw new Error(`Check 6 FAIL — PTY pid=${ptyPid} is dead: ${err.message}`);
    }

    // Check 7: Open session overlay
    await openSessionOverlay(page, 't02-bash-session', 5000);
    console.log(`  [T-02] Round ${roundNum}: Check 7 PASS — Session overlay opened, xterm mounted`);

    // Wait 500ms for initial data burst
    await sleep(500);

    // Condition A: terminal not blank
    const termText = await page.evaluate(
      () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.trim() ?? ''
    );
    expect(termText.length, 'Terminal must not be blank after overlay opens').toBeGreaterThan(0);
    console.log(`  [T-02] Round ${roundNum}: Check 8a PASS — Terminal not blank (${termText.length} chars)`);

    // Check 8: Freshness test — type unique marker
    const marker = `T02_ROUND_${roundNum}_${Date.now()}`;
    await typeAndVerifyMarker(page, marker, 8000);
    console.log(`  [T-02] Round ${roundNum}: Check 8b PASS — Marker ${marker} appeared in terminal`);

    // Take screenshot
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `0${roundNum + 2}-post-reload-round-${roundNum}.png`) });
    console.log(`  [T-02] Round ${roundNum}: All checks PASSED`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // THE SINGLE TEST
  // ──────────────────────────────────────────────────────────────────────────

  test('T-02 — Hard reload 3x: session survives, PTY alive, bidirectional I/O works', async () => {
    test.setTimeout(120000);

    // Launch browser
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    let page;
    try {
      const context = await browser.newContext();
      page = await context.newPage();

      // Log browser console errors
      page.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
        if (msg.type() === 'warning') console.log(`  [browser:warn] ${msg.text()}`);
      });

      // Navigate to app
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Wait for Connected indicator
      await waitForConnected(page, 8000);
      console.log('\n  [T-02] App loaded and Connected');

      // Screenshot: before session
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-pre-session.png') });

      // ── Section 2: Session Setup ──────────────────────────────────────────

      // Step 1: Select the T02-Project in sidebar
      await selectProject(page, 'T02-Project');
      console.log('  [T-02] Project selected');

      // Step 2: Open the New Session modal
      const newSessionBtn = page.locator('#sessions-area .btn-primary').first();
      await newSessionBtn.waitFor({ state: 'visible', timeout: 5000 });
      await newSessionBtn.click({ timeout: 5000 });
      await page.waitForSelector('.modal', { state: 'visible', timeout: 5000 });
      console.log('  [T-02] New Session modal opened');

      // Step 3: Fill session name
      const nameInput = page.locator('.modal .modal-body .form-input').first();
      await nameInput.fill('t02-bash-session');

      // Step 4: Set command to "bash" — the second .form-input with font-family:var(--font-mono)
      // The second form-input in modal-body is the command input (has monospace font)
      const commandInput = page.locator('.modal .modal-body .form-input').nth(1);
      await commandInput.fill('bash');

      // Step 5: Direct mode should already be active — verify
      const directBtn = page.locator('.modal button').filter({ hasText: 'Direct' });
      const directBg = await directBtn.evaluate(el => el.style.background || getComputedStyle(el).background);
      console.log(`  [T-02] Direct mode button background: ${directBg.substring(0, 60)}`);

      // Step 6: Click "Start Session"
      const startBtn = page.locator('.modal-footer .btn-primary');
      await startBtn.click();
      console.log('  [T-02] Start Session clicked');

      // Step 7: Wait for session card with "running"
      await waitForSessionCard(page, 't02-bash-session', 8000);
      console.log('  [T-02] Session card shows running');

      // Confirm via API
      const allSessions = await getApiSessions();
      const sess = allSessions.find(s => s.name === 't02-bash-session');
      expect(sess, 'Session must exist in API').toBeTruthy();
      const sessStatus = sess.status || sess.state;
      expect(sessStatus, 'Session must be running').toBe('running');
      expect(sess.pid, 'Session must have a positive PID').toBeGreaterThan(0);
      expect(sess.mode, 'Session must be in direct mode').toBe('direct');

      // Record session ID and PID
      sessionId = sess.id;
      ptyPid = sess.pid;
      console.log(`  [T-02] Session id=${sessionId} pid=${ptyPid}`);

      // ── Generate baseline terminal output ─────────────────────────────────

      // Attach to session
      await openSessionOverlay(page, 't02-bash-session', 5000);

      // Type marker ALPHA — use keyboard.press('Enter') for CR, not \n
      await sleep(500);
      await page.keyboard.type('echo T02_MARKER_ALPHA');
      await page.keyboard.press('Enter');

      // Verify marker appears
      await page.waitForFunction(
        () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes('T02_MARKER_ALPHA'),
        { timeout: 5000 }
      );
      console.log('  [T-02] Baseline marker T02_MARKER_ALPHA appeared');

      // Screenshot: session running with marker
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-session-running.png') });

      // ── Section 3: Pre-Reload State Capture ──────────────────────────────

      const preReloadScreenText = await page.evaluate(
        () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent ?? ''
      );
      console.log(`  [T-02] Pre-reload terminal text length: ${preReloadScreenText.length}`);

      // Verify server PID alive
      try {
        process.kill(serverProc.pid, 0);
        console.log(`  [T-02] Server pid=${serverProc.pid} alive`);
      } catch {
        throw new Error('Server process is dead before any reload!');
      }

      // ── 3 Reload Rounds ───────────────────────────────────────────────────

      // Round 1: overlay OPEN at reload time
      console.log('\n  [T-02] === ROUND 1: overlay OPEN at reload ===');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-pre-reload-round-1.png') });

      let reloadTimestamp = Date.now();
      await hardReload(page);
      await runPostReloadChecks(page, 1, reloadTimestamp, true);

      // Round 2: overlay CLOSED at reload time — close it first
      console.log('\n  [T-02] === ROUND 2: overlay CLOSED at reload ===');
      await closeSessionOverlay(page);
      await sleep(300);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-pre-reload-round-2-overlay-closed.png') });

      reloadTimestamp = Date.now();
      await hardReload(page);
      await runPostReloadChecks(page, 2, reloadTimestamp, false);

      // Round 3: overlay OPEN at reload time (same as round 1, for confidence)
      console.log('\n  [T-02] === ROUND 3: overlay OPEN at reload ===');
      // Overlay is already open from round 2 checks
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-pre-reload-round-3.png') });

      reloadTimestamp = Date.now();
      await hardReload(page);
      await runPostReloadChecks(page, 3, reloadTimestamp, true);

      // ── Final State ───────────────────────────────────────────────────────

      // Screenshot final state
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-final-state.png') });

      // Save final API state as JSON
      const finalSessions = await getApiSessions();
      fs.writeFileSync(
        path.join(SCREENSHOTS_DIR, '06-final-api-state.json'),
        JSON.stringify(finalSessions, null, 2)
      );

      // Check crash log — should be empty
      try {
        const crashLog = fs.readFileSync(crashLogPath, 'utf8');
        const testWindow = crashLog
          .split('\n')
          .filter(line => {
            if (!line.trim()) return false;
            // Check if the log entry is during our test
            const match = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
            if (!match) return false;
            const ts = new Date(match[1]).getTime();
            return ts >= testStartTime;
          });
        if (testWindow.length > 0) {
          console.error('\n  [T-02] CRASH LOG entries during test:\n' + testWindow.join('\n'));
          expect(testWindow.length, 'Crash log must be empty during test window (unhandled exceptions indicate a real bug)').toBe(0);
        } else {
          console.log('  [T-02] Crash log: no entries during test window');
        }
      } catch {
        console.log('  [T-02] Crash log: not found (no crashes)');
      }

      // Final server alive check
      try {
        process.kill(serverProc.pid, 0);
        console.log(`  [T-02] Final check: server pid=${serverProc.pid} still alive`);
      } catch {
        throw new Error('Server process died during the test!');
      }

      console.log('\n  [T-02] ALL 3 ROUNDS PASSED — Test COMPLETE');

    } finally {
      if (page) {
        try { await browser.close(); } catch {}
      } else {
        try { await browser.close(); } catch {}
      }
    }
  });

}); // end describe
} // end for (const MODE of MODES)
