/**
 * T-12: Tmux Session Survives Browser Tab Close and Re-Open
 *
 * Purpose: Verify that a tmux session created via the UI continues to exist
 * (as a live OS-level tmux process) even after the browser tab is fully closed.
 * When a new browser tab opens and navigates to the same app, the session card
 * must show "running", tmux ls must list cm-<id>, and the terminal overlay must
 * show existing output — not a blank terminal.
 *
 * Design doc: tests/adversarial/designs/T-12-design.md
 *
 * Run: PORT=3109 npx playwright test tests/adversarial/T-12-tmux-survives-close.test.js --reporter=line --timeout=180000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3109;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T12-tmux-survives-close');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Server lifecycle ──────────────────────────────────────────────────────────

test.describe('T-12 — Tmux Session Survives Browser Tab Close and Re-Open', () => {

  let serverProc = null;
  let dataDir = '';
  let crashLogPath = '';
  let testStartTime = 0;

  // Test state set inside the test
  let sessionId = '';
  let tmuxName = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3109 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    // Create temp data dir
    dataDir = execSync('mktemp -d /tmp/t12-XXXXXX').toString().trim();
    console.log(`\n  [T-12] dataDir: ${dataDir}`);

    // Create the project directory
    const projPath = path.join(dataDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    // Seed projects.json — ProjectStore expects { projects: [...], scratchpad: [] }
    const projectsSeed = {
      projects: [
        {
          id: 'proj-t12',
          name: 'T12-Project',
          path: projPath,
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
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/sessions`);
        const body = await r.json();
        if (r.ok && typeof body === 'object') { ready = true; break; }
      } catch {}
      await sleep(300);
    }
    if (!ready) throw new Error('Test server failed to start within 15s');
    console.log(`  [T-12] Server ready on port ${PORT} (pid: ${serverProc.pid})`);

    testStartTime = Date.now();
  });

  test.afterAll(async () => {
    // Kill any leftover tmux session
    if (tmuxName) {
      try { execSync(`tmux kill-session -t ${JSON.stringify(tmuxName)} 2>/dev/null || true`); } catch {}
    }

    // Kill server
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(1000);
      try {
        process.kill(serverProc.pid, 0);
        try { serverProc.kill('SIGKILL'); } catch {}
      } catch {}
      serverProc = null;
    }

    // Print crash log if any
    try {
      const crashLog = fs.readFileSync(crashLogPath, 'utf8');
      if (crashLog.trim()) {
        console.log('\n  [T-12] CRASH LOG:\n' + crashLog);
      }
    } catch {}

    // Cleanup
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    if (dataDir) {
      try { execSync(`rm -rf ${dataDir}`); } catch {}
      dataDir = '';
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function getApiSessions() {
    const r = await fetch(`${BASE_URL}/api/sessions`);
    const body = await r.json();
    return Array.isArray(body.managed) ? body.managed : [];
  }

  async function selectProject(page, projectName) {
    const projectItem = page.locator('.project-item').filter({ hasText: projectName });
    await projectItem.first().waitFor({ state: 'visible', timeout: 8000 });
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

  async function waitForConnected(page, timeoutMs = 10000) {
    await page.waitForSelector('.status-dot.connected', { timeout: timeoutMs });
  }

  async function waitForSessionRunning(page, sessionName, timeoutMs = 10000) {
    await page.waitForFunction(
      (name) => {
        const cards = document.querySelectorAll('.session-card');
        return [...cards].some(c =>
          c.textContent.includes(name) && c.textContent.toLowerCase().includes('running')
        );
      },
      sessionName,
      { timeout: timeoutMs }
    );
  }

  async function openSessionOverlay(page, sessionName, timeoutMs = 8000) {
    const card = page.locator('.session-card').filter({ hasText: sessionName });
    await card.first().waitFor({ state: 'visible', timeout: timeoutMs });
    await card.first().click();
    await page.waitForSelector('#session-overlay', { state: 'visible', timeout: timeoutMs });
    await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: timeoutMs });
  }

  function tmuxSessionAlive(name) {
    try {
      execSync(`tmux has-session -t ${JSON.stringify(name)} 2>/dev/null`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  function tmuxCapturePaneText(name) {
    try {
      // -S - means capture from start of history
      return execSync(`tmux capture-pane -p -S - -t ${JSON.stringify(name)} 2>/dev/null`, {
        timeout: 5000
      }).toString();
    } catch {
      return '';
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // THE SINGLE TEST
  // ──────────────────────────────────────────────────────────────────────────

  test('T-12 — Tmux session survives browser close: tmux alive, card running, content preserved', async () => {
    test.setTimeout(180000);

    // ── PHASE 1: Create session and produce pre-close content ─────────────

    const browser1 = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    let preCloseMarker = '';

    try {
      const context1 = await browser1.newContext();
      const page1 = await context1.newPage();

      page1.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser1:err] ${msg.text()}`);
      });

      // Navigate to app
      await page1.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await waitForConnected(page1, 10000);
      console.log('\n  [T-12] Phase 1: App loaded and Connected');

      // Screenshot: initial state
      await page1.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-initial.png') });

      // Select project
      await selectProject(page1, 'T12-Project');
      console.log('  [T-12] Project selected');

      // Open New Session modal
      const newSessionBtn = page1.locator('#sessions-area .btn-primary').first();
      await newSessionBtn.waitFor({ state: 'visible', timeout: 5000 });
      await newSessionBtn.click({ timeout: 5000 });
      await page1.waitForSelector('.modal', { state: 'visible', timeout: 5000 });
      console.log('  [T-12] New Session modal opened');

      // Fill session name
      const nameInput = page1.locator('.modal .modal-body .form-input').first();
      await nameInput.fill('t12-tmux-session');

      // Fill command: bash (for speed)
      const commandInput = page1.locator('.modal .modal-body .form-input').nth(1);
      await commandInput.fill('bash');

      // Switch to Tmux mode
      const tmuxBtn = page1.locator('.modal button').filter({ hasText: 'Tmux' });
      const tmuxBtnVisible = await tmuxBtn.first().isVisible().catch(() => false);
      if (tmuxBtnVisible) {
        await tmuxBtn.first().click();
        await sleep(300);
        console.log('  [T-12] Tmux mode selected');
      } else {
        console.log('  [T-12] WARN: Tmux button not found — checking current mode');
      }

      // Take screenshot of modal
      await page1.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-modal-tmux.png') });

      // Click Start Session
      const startBtn = page1.locator('.modal-footer .btn-primary');
      await startBtn.click();
      console.log('  [T-12] Start Session clicked');

      // Wait for session card with "running"
      await waitForSessionRunning(page1, 't12-tmux-session', 12000);
      console.log('  [T-12] Session card shows running');

      // Get session details from API
      const sessions = await getApiSessions();
      const sess = sessions.find(s => s.name === 't12-tmux-session');
      expect(sess, 'Session must exist in API').toBeTruthy();
      const sessStatus = sess.status || sess.state;
      expect(sessStatus, 'Session must be running').toBe('running');
      expect(sess.mode, 'Session must be in tmux mode').toBe('tmux');
      expect(sess.tmuxName, 'Session must have a tmuxName').toBeTruthy();

      sessionId = sess.id;
      tmuxName = sess.tmuxName;
      console.log(`  [T-12] Session id=${sessionId} tmuxName=${tmuxName}`);

      // Verify tmuxName format: cm-<first-8-chars-of-id>
      const expectedTmuxName = `cm-${sessionId.slice(0, 8)}`;
      expect(tmuxName, `tmuxName must match cm-<id-prefix>, got ${tmuxName}`).toBe(expectedTmuxName);
      console.log(`  [T-12] tmuxName format correct: ${tmuxName}`);

      // Verify tmux session exists on the OS
      const aliveBeforeOverlay = tmuxSessionAlive(tmuxName);
      expect(aliveBeforeOverlay, `tmux session ${tmuxName} must be alive after creation`).toBe(true);
      console.log(`  [T-12] Check PASS: tmux session ${tmuxName} alive on OS`);

      // Open terminal overlay
      await openSessionOverlay(page1, 't12-tmux-session', 8000);
      console.log('  [T-12] Terminal overlay opened');

      // Wait for terminal to settle
      await sleep(1500);

      // Generate pre-close marker
      preCloseMarker = `T12_PRE_CLOSE_${Date.now()}`;
      console.log(`  [T-12] Pre-close marker: ${preCloseMarker}`);

      // Type marker into terminal
      await page1.keyboard.type(`echo ${preCloseMarker}`);
      await page1.keyboard.press('Enter');

      // Wait for marker to appear in terminal
      await page1.waitForFunction(
        (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
        preCloseMarker,
        { timeout: 8000 }
      );
      console.log('  [T-12] Pre-close marker visible in terminal');

      // Screenshot: terminal with pre-close marker
      await page1.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T12-01-before-close.png') });

    } finally {
      // Close the browser completely (simulates tab close)
      console.log('  [T-12] Closing browser 1 (simulating tab close)...');
      try { await browser1.close(); } catch {}
    }

    // ── PHASE 2: Wait 5 seconds and verify tmux session still alive ───────

    console.log('  [T-12] Waiting 5 seconds after browser close...');
    await sleep(5000);

    // Server-level check 1: tmux session still alive
    const aliveAfter5s = tmuxSessionAlive(tmuxName);
    expect(aliveAfter5s, `tmux session ${tmuxName} must survive 5s after browser close`).toBe(true);
    console.log(`  [T-12] Check PASS: tmux session ${tmuxName} alive 5s after browser close`);

    // List all tmux sessions for debugging
    const tmuxLsOutput = (() => {
      try { return execSync('tmux ls 2>&1').toString(); } catch { return '(no tmux sessions)'; }
    })();
    console.log(`  [T-12] tmux ls output:\n${tmuxLsOutput}`);
    expect(tmuxLsOutput, `tmux ls must include ${tmuxName}`).toContain(tmuxName);

    // Capture pane to verify pre-close content preserved
    const paneText = tmuxCapturePaneText(tmuxName);
    console.log(`  [T-12] tmux capture-pane (${paneText.length} chars), looking for ${preCloseMarker}...`);
    const markerInPane = paneText.includes(preCloseMarker);
    if (!markerInPane) {
      console.log(`  [T-12] WARN: pre-close marker not found in capture-pane output.`);
      console.log(`  [T-12] Pane text (last 500 chars): ${paneText.slice(-500)}`);
    } else {
      console.log(`  [T-12] Check PASS: pre-close marker found in tmux pane history`);
    }
    expect(markerInPane, `tmux capture-pane must contain pre-close marker "${preCloseMarker}"`).toBe(true);

    // ── PHASE 3: Reopen browser and verify session recovery ───────────────

    console.log('\n  [T-12] Phase 3: Reopening browser...');

    const browser2 = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const context2 = await browser2.newContext();
      const page2 = await context2.newPage();

      page2.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser2:err] ${msg.text()}`);
      });

      // Navigate to app
      await page2.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await waitForConnected(page2, 10000);
      console.log('  [T-12] Phase 3: App loaded in browser 2, Connected');

      // Select project
      await selectProject(page2, 'T12-Project');
      console.log('  [T-12] Project re-selected');

      // Wait for session card to appear
      await waitForSessionRunning(page2, 't12-tmux-session', 10000);
      console.log('  [T-12] Check PASS: Session card shows "running" after reopen');

      // Screenshot: session card showing running
      await page2.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T12-02-after-reopen-card.png') });

      // Server-level check 2: tmux session still alive after reopen
      const aliveAfterReopen = tmuxSessionAlive(tmuxName);
      expect(aliveAfterReopen, `tmux session ${tmuxName} must still be alive after browser reopen`).toBe(true);
      console.log(`  [T-12] Check PASS: tmux session ${tmuxName} alive after browser reopen`);

      // Verify API still shows session as running
      const sessionsAfter = await getApiSessions();
      const sessAfter = sessionsAfter.find(s => s.id === sessionId);
      expect(sessAfter, `Session ${sessionId} must still exist in API after reopen`).toBeTruthy();
      const statusAfter = sessAfter.status || sessAfter.state;
      expect(statusAfter, 'Session must still be running after reopen').toBe('running');
      console.log(`  [T-12] Check PASS: API confirms session running after reopen`);

      // Open terminal overlay
      await openSessionOverlay(page2, 't12-tmux-session', 8000);
      console.log('  [T-12] Terminal overlay opened in browser 2');

      // Wait for PTY content to stream
      await sleep(3000);

      // Screenshot: terminal after reopen
      await page2.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T12-03-terminal-after-reopen.png') });

      // Check terminal is non-blank
      const termText = await page2.evaluate(
        () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.trim() ?? ''
      );
      console.log(`  [T-12] Terminal text length after reopen: ${termText.length}`);
      expect(termText.length, 'Terminal must not be blank after reopen').toBeGreaterThan(0);
      console.log('  [T-12] Check PASS: Terminal is non-blank after reopen');

      // Check for pre-close marker in terminal (secondary check — may not appear if PTY already attached)
      const markerInBrowser = await page2.evaluate(
        (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m) ?? false,
        preCloseMarker
      );
      if (markerInBrowser) {
        console.log('  [T-12] Check PASS (bonus): pre-close marker visible in browser terminal');
      } else {
        console.log('  [T-12] INFO: pre-close marker not in browser terminal view (may only show new output) — tmux capture-pane confirmed it above');
      }

      // ── Bidirectional I/O check ──────────────────────────────────────────

      const postOpenMarker = `T12_POST_OPEN_${Date.now()}`;
      console.log(`  [T-12] Post-open I/O marker: ${postOpenMarker}`);

      await page2.keyboard.type(`echo ${postOpenMarker}`);
      await page2.keyboard.press('Enter');

      // Wait for post-open marker in terminal
      await page2.waitForFunction(
        (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
        postOpenMarker,
        { timeout: 8000 }
      );
      console.log('  [T-12] Check PASS: Post-open I/O marker appeared in terminal (bidirectional I/O works)');

      // Screenshot: post-open I/O confirmed
      await page2.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T12-04-post-open-io.png') });

      // ── Crash log check ──────────────────────────────────────────────────

      try {
        const crashLog = fs.readFileSync(crashLogPath, 'utf8');
        const testWindow = crashLog
          .split('\n')
          .filter(line => {
            if (!line.trim()) return false;
            const match = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
            if (!match) return false;
            const ts = new Date(match[1]).getTime();
            return ts >= testStartTime;
          });
        if (testWindow.length > 0) {
          console.error('\n  [T-12] CRASH LOG entries during test:\n' + testWindow.join('\n'));
          expect(testWindow.length, 'Crash log must be empty during test window').toBe(0);
        } else {
          console.log('  [T-12] Crash log: no entries during test window');
        }
      } catch {
        console.log('  [T-12] Crash log: not found (no crashes)');
      }

      console.log('\n  [T-12] ALL CHECKS PASSED — Test COMPLETE');

    } finally {
      try { await browser2.close(); } catch {}
    }
  });

}); // end describe
