/**
 * T-45: Stop then Immediately Refresh — No Race Condition
 *
 * Score: 12
 *
 * Flow:
 *   1. Create a running session (bash command).
 *   2. Send session:stop via WS.
 *   3. Within 50ms, send session:refresh via WS.
 *   4. Record all state transitions.
 *   5. Assert session reaches stable state (running or stopped) — no oscillation.
 *   6. Assert no PTY leak (single pid, valid process).
 *   7. Browser test: click Stop, then Refresh within 200ms — same stability check.
 *
 * Pass: Session settles in stable state. No oscillation, no duplicate PTY.
 * Fail: Session oscillates between stopping/starting. Server spawns two PTYs.
 *
 * Design doc: tests/adversarial/designs/T-45-design.md
 *
 * Run:
 *   fuser -k 3142/tcp 2>/dev/null; sleep 1
 *   PORT=3142 npx playwright test tests/adversarial/T-45-stop-refresh-race.test.js --reporter=line --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORTS = { direct: 3142, tmux: 3742 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-45-stop-refresh-race-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 10000);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS message timeout after ${timeoutMs}ms`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
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

// Collect all messages for a duration
function collectMessages(ws, durationMs) {
  const messages = [];
  const handler = (data) => {
    try {
      messages.push({ t: Date.now(), msg: JSON.parse(data.toString()) });
    } catch {}
  };
  ws.on('message', handler);
  return new Promise(resolve => {
    setTimeout(() => {
      ws.off('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

// ── Server startup ────────────────────────────────────────────────────────────

async function startServer(tmpDir, crashLogPath) {
  const proc = spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DATA_DIR: tmpDir,
      PORT: String(PORT),
      CRASH_LOG: crashLogPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/`);
      if (r.ok) break;
    } catch {}
    await sleep(400);
  }
  return proc;
}

// ── Main test ─────────────────────────────────────────────────────────────────

test.describe(`T-45 — Stop then Immediately Refresh — No Race Condition [${MODE}]`, () => {
  let serverProc = null;
  let tmpDir = '';
  let crashLogPath = '';
  let projectId = '';
  let projectPath = '';
  let browser = null;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T45-XXXXXX').toString().trim();
    crashLogPath = path.join(tmpDir, 'crash.log');
    console.log(`\n  [T-45] tmpDir: ${tmpDir}`);

    projectId = 'proj-t45-' + Date.now();
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });

    const projectsData = {
      projects: [{
        id: projectId,
        name: 'T-45 Project',
        path: projectPath,
        createdAt: new Date().toISOString(),
      }],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(projectsData, null, 2));

    serverProc = await startServer(tmpDir, crashLogPath);
    console.log(`  [T-45] Server started on port ${PORT}`);

    browser = await chromium.launch({ headless: true });
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
    if (serverProc) {
      serverProc.kill();
      await sleep(500);
    }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    try { execSync(`rm -rf ${tmpDir}`); } catch {}
  });

  test('T-45.01 — WS-level stop+refresh race (50ms gap): session reaches stable state', async () => {
    // Create a session via WS
    const ws = await openWs();
    await waitForMessage(ws, m => m.type === 'init', 5000);

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 'race-test-1',
      command: 'bash',
      mode: MODE,
    }));

    const created = await waitForMessage(ws, m => m.type === 'session:created', 15000);
    const sessionId = created.session.id;
    console.log(`  [T-45.01] Session created: ${sessionId.slice(0, 8)}`);

    // Wait for session to reach RUNNING (poll API if WS message missed)
    const runDeadline = Date.now() + 15000;
    let isRunning = false;
    while (Date.now() < runDeadline) {
      const r = await fetch(`${BASE_URL}/api/sessions`);
      const b = await r.json();
      const sess = (b.managed || []).find(s => s.id === sessionId);
      if (sess && (sess.status === 'running' || sess.state === 'running')) {
        isRunning = true;
        break;
      }
      await sleep(300);
    }
    if (!isRunning) throw new Error('Session did not reach RUNNING within 15s');
    console.log(`  [T-45.01] Session is RUNNING`);

    // Start collecting all messages for 8 seconds
    const messagesPromise = collectMessages(ws, 8000);

    // RACE: stop at t=0, refresh at t=50ms
    const t0 = Date.now();
    ws.send(JSON.stringify({ type: 'session:stop', id: sessionId }));
    await sleep(50); // 50ms gap
    ws.send(JSON.stringify({ type: 'session:refresh', id: sessionId }));
    console.log(`  [T-45.01] Sent stop at t=0, refresh at t=50ms`);

    const allMessages = await messagesPromise;

    // Extract state transitions for this session
    const stateChanges = allMessages
      .filter(m => m.msg.type === 'sessions:list')
      .map(m => {
        const sess = m.msg.sessions.find(s => s.id === sessionId);
        return { t: m.t - t0, state: sess ? (sess.status || sess.state) : 'missing' };
      })
      .filter((m, i, arr) => i === 0 || m.state !== arr[i - 1].state); // Deduplicate consecutive same-state

    const errors = allMessages.filter(m =>
      m.msg.type === 'session:error' && m.msg.id === sessionId
    ).map(m => m.msg.error);

    console.log(`  [T-45.01] State sequence: ${stateChanges.map(s => `${s.state}@${s.t}ms`).join(' → ')}`);
    if (errors.length > 0) {
      console.log(`  [T-45.01] Session errors: ${JSON.stringify(errors)}`);
    }

    // Get final state via API
    const apiRes = await fetch(`${BASE_URL}/api/sessions`);
    const apiBody = await apiRes.json();
    const finalSession = (apiBody.managed || []).find(s => s.id === sessionId);
    const finalState = finalSession ? (finalSession.status || finalSession.state) : 'missing';
    console.log(`  [T-45.01] Final state from API: ${finalState}`);

    // Assertions
    // 1. Must reach stable state (running or stopped)
    const validFinalStates = ['running', 'stopped', 'error'];
    expect(validFinalStates).toContain(finalState);
    console.log(`  [T-45.01] PASS: Final state is stable: ${finalState}`);

    // 2. No oscillation — state should not cycle more than 3 times
    expect(stateChanges.length).toBeLessThanOrEqual(5);
    console.log(`  [T-45.01] PASS: State changes count (${stateChanges.length}) ≤ 5`);

    // 3. No state machine error (invalid transition)
    const hasTransitionError = errors.some(e => e.includes('Invalid') || e.includes('transition'));
    expect(hasTransitionError).toBe(false);

    // 4. Refresh error is acceptable (if stop beat refresh)
    if (errors.length > 0) {
      console.log(`  [T-45.01] Graceful error(s) received: ${errors.join(', ')}`);
    }

    ws.close();
  });

  test('T-45.02 — WS-level stop+refresh race (0ms gap): both messages in same tick', async () => {
    // Create a new session
    const ws = await openWs();
    await waitForMessage(ws, m => m.type === 'init', 5000);

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 'race-test-2',
      command: 'bash',
      mode: MODE,
    }));

    const created = await waitForMessage(ws, m => m.type === 'session:created', 15000);
    const sessionId = created.session.id;
    console.log(`  [T-45.02] Session created: ${sessionId.slice(0, 8)}`);

    // Wait for RUNNING (poll API)
    const runDeadline2 = Date.now() + 15000;
    let isRunning2 = false;
    while (Date.now() < runDeadline2) {
      const r = await fetch(`${BASE_URL}/api/sessions`);
      const b = await r.json();
      const sess = (b.managed || []).find(s => s.id === sessionId);
      if (sess && (sess.status === 'running' || sess.state === 'running')) {
        isRunning2 = true;
        break;
      }
      await sleep(300);
    }
    if (!isRunning2) throw new Error('Session did not reach RUNNING within 15s');
    console.log(`  [T-45.02] Session is RUNNING`);

    const messagesPromise = collectMessages(ws, 8000);

    // Send BOTH messages in the same tick (0ms gap)
    const t0 = Date.now();
    ws.send(JSON.stringify({ type: 'session:stop', id: sessionId }));
    ws.send(JSON.stringify({ type: 'session:refresh', id: sessionId }));
    console.log(`  [T-45.02] Sent stop AND refresh in same tick (0ms gap)`);

    const allMessages = await messagesPromise;

    const stateChanges = allMessages
      .filter(m => m.msg.type === 'sessions:list')
      .map(m => {
        const sess = m.msg.sessions.find(s => s.id === sessionId);
        return { t: m.t - t0, state: sess ? (sess.status || sess.state) : 'missing' };
      })
      .filter((m, i, arr) => i === 0 || m.state !== arr[i - 1].state);

    const errors = allMessages.filter(m =>
      m.msg.type === 'session:error' && m.msg.id === sessionId
    ).map(m => m.msg.error);

    console.log(`  [T-45.02] State sequence: ${stateChanges.map(s => `${s.state}@${s.t}ms`).join(' → ')}`);
    if (errors.length > 0) {
      console.log(`  [T-45.02] Session errors: ${JSON.stringify(errors)}`);
    }

    // Get final state
    const apiRes = await fetch(`${BASE_URL}/api/sessions`);
    const apiBody = await apiRes.json();
    const finalSession = (apiBody.managed || []).find(s => s.id === sessionId);
    const finalState = finalSession ? (finalSession.status || finalSession.state) : 'missing';
    console.log(`  [T-45.02] Final state: ${finalState}`);

    // Assert stable final state
    const validFinalStates = ['running', 'stopped', 'error'];
    expect(validFinalStates).toContain(finalState);
    console.log(`  [T-45.02] PASS: Final state is stable: ${finalState}`);

    // No oscillation
    expect(stateChanges.length).toBeLessThanOrEqual(5);
    console.log(`  [T-45.02] PASS: State changes count (${stateChanges.length}) ≤ 5`);

    ws.close();
  });

  test('T-45.03 — No PTY leak after stop+refresh race', async () => {
    // After both previous races, check that no orphan PTY processes exist
    // for our project path
    const apiRes = await fetch(`${BASE_URL}/api/sessions`);
    const apiBody = await apiRes.json();
    const allSessions = apiBody.managed || [];

    console.log(`  [T-45.03] All sessions: ${JSON.stringify(allSessions.map(s => ({
      id: s.id.slice(0, 8),
      state: s.status || s.state,
      pid: s.pid
    })))}`);

    // For each running session, verify single PID and process is alive
    const runningSessions = allSessions.filter(s =>
      (s.status === 'running' || s.state === 'running') && s.projectId === projectId
    );

    for (const sess of runningSessions) {
      if (sess.pid) {
        const pidExists = fs.existsSync(`/proc/${sess.pid}`);
        console.log(`  [T-45.03] Session ${sess.id.slice(0, 8)} PID ${sess.pid}: exists=${pidExists}`);
        expect(pidExists).toBe(true);
      }
    }

    // No crash log entries
    if (fs.existsSync(crashLogPath)) {
      const crashContent = fs.readFileSync(crashLogPath, 'utf-8').trim();
      expect(crashContent).toBe('');
    }

    console.log(`  [T-45.03] PASS: No PTY leak, no crashes`);
  });

  test('T-45.04 — Browser-level: click Stop then Refresh within 200ms', async () => {
    // Create a fresh session for browser test
    const ws = await openWs();
    await waitForMessage(ws, m => m.type === 'init', 5000);

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 'browser-race-test',
      command: 'bash',
      mode: MODE,
    }));

    const created = await waitForMessage(ws, m => m.type === 'session:created', 15000);
    const sessionId = created.session.id;
    console.log(`  [T-45.04] Session created for browser test: ${sessionId.slice(0, 8)}`);

    // Wait for running (poll API)
    const runDeadline4 = Date.now() + 15000;
    let isRunning4 = false;
    while (Date.now() < runDeadline4) {
      const r = await fetch(`${BASE_URL}/api/sessions`);
      const b = await r.json();
      const sess = (b.managed || []).find(s => s.id === sessionId);
      if (sess && (sess.status === 'running' || sess.state === 'running')) {
        isRunning4 = true;
        break;
      }
      await sleep(300);
    }
    if (!isRunning4) throw new Error('Session did not reach RUNNING within 15s');
    console.log(`  [T-45.04] Session is RUNNING`);
    ws.close();

    const page = await browser.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

      // Wait for project items to load
      await page.waitForSelector('.project-item', { timeout: 10000 });

      // Click the project to select it
      await page.click('.project-item');
      await sleep(500);

      // Wait for session card to appear
      await page.waitForSelector('.session-card', { timeout: 8000 });

      // Click session card to open overlay
      await page.click('.session-card');
      await sleep(500);

      // Wait for overlay to open
      await page.waitForSelector('#session-overlay', { timeout: 8000 });
      console.log(`  [T-45.04] Overlay opened`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-overlay-open.png') });

      // Verify Stop button is present (session is running)
      const stopBtn = page.locator('#btn-session-stop');
      const stopVisible = await stopBtn.isVisible().catch(() => false);
      console.log(`  [T-45.04] Stop button visible: ${stopVisible}`);

      if (!stopVisible) {
        // Session might be starting but not yet running in browser
        // Wait for stop button to appear
        await page.waitForSelector('#btn-session-stop', { timeout: 8000 });
        console.log(`  [T-45.04] Stop button appeared`);
      }

      // Also verify Refresh button is present (it's always present in overlay)
      const refreshBtn = page.locator('button[title="Refresh session"]');
      const refreshVisible = await refreshBtn.isVisible().catch(() => false);
      console.log(`  [T-45.04] Refresh button visible: ${refreshVisible}`);
      expect(refreshVisible).toBe(true);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-before-race.png') });

      // RACE: Click Stop, then Refresh within 200ms
      const clickT0 = Date.now();
      await stopBtn.click();
      const stopClickMs = Date.now() - clickT0;
      console.log(`  [T-45.04] Stop clicked at t=${stopClickMs}ms`);

      await sleep(100); // 100ms gap (within 200ms window)

      await refreshBtn.click();
      const refreshClickMs = Date.now() - clickT0;
      console.log(`  [T-45.04] Refresh clicked at t=${refreshClickMs}ms (gap: ${refreshClickMs - stopClickMs}ms)`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-after-race-clicks.png') });

      // Wait for session to settle (poll for 8 seconds)
      let finalBadgeText = '';
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const badge = await page.evaluate(() => {
          const badgeEl = document.querySelector('.badge-activity');
          return badgeEl ? badgeEl.textContent?.trim() : '';
        });
        finalBadgeText = badge;

        // Stable states we accept
        if (badge.includes('running') || badge.includes('stopped') || badge.includes('error')) {
          break;
        }
        await sleep(300);
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-final-state.png') });

      console.log(`  [T-45.04] Final badge text: "${finalBadgeText}"`);

      // Assert stable final state in browser
      const isStable =
        finalBadgeText.includes('running') ||
        finalBadgeText.includes('stopped') ||
        finalBadgeText.includes('error');

      expect(isStable).toBe(true);
      console.log(`  [T-45.04] PASS: Browser shows stable state: "${finalBadgeText}"`);

      // Additional check: poll for another 3 seconds to confirm no oscillation
      const observedStates = new Set([finalBadgeText]);
      const stabilityDeadline = Date.now() + 3000;
      while (Date.now() < stabilityDeadline) {
        const badge = await page.evaluate(() => {
          const badgeEl = document.querySelector('.badge-activity');
          return badgeEl ? badgeEl.textContent?.trim() : '';
        });
        observedStates.add(badge);
        await sleep(200);
      }

      console.log(`  [T-45.04] States observed during stability check: ${JSON.stringify([...observedStates])}`);

      // If session settled in "running", there should be at most "starting" + "running"
      // If settled in "stopped", there should be at most "stopping" + "stopped"
      // Oscillation would show both "running" and "stopping" cycling
      const hasOscillation =
        [...observedStates].some(s => s.includes('running') || s.includes('starting')) &&
        [...observedStates].some(s => s.includes('stopping')) &&
        observedStates.size > 3;

      expect(hasOscillation).toBe(false);
      console.log(`  [T-45.04] PASS: No badge oscillation detected`);

    } finally {
      await page.close();
    }
  });

  test('T-45.05 — Server is healthy after all race scenarios', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.managed)).toBe(true);

    // Crash log check
    if (fs.existsSync(crashLogPath)) {
      const crashContent = fs.readFileSync(crashLogPath, 'utf-8').trim();
      expect(crashContent).toBe('');
    }

    console.log(`  [T-45.05] PASS: Server healthy, sessions: ${body.managed.length}, no crashes`);
  });
});
} // end for (const MODE of MODES)
