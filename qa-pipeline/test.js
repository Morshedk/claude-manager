/**
 * QA Pipeline — bug: blank-terminal-switch-back
 *
 * Reproduces: switching away from a tmux session and back shows blank terminal.
 *
 * Flow:
 *   1. Start isolated server on temp port
 *   2. Create a tmux session via WS; grab ID from session:state (not session:created,
 *      which is blocked by the watchdog logSessionLifecycle error)
 *   3. Subscribe via WS, send "echo SWITCH_BACK_SENTINEL" as input, wait for it to
 *      appear in session:output, then close the setup WS — this populates _previewBuffer
 *      on fixed code, or leaves it empty on broken code
 *   4. Open browser with Playwright, navigate to the session
 *   5. Verify sentinel is visible in terminal (tests first-subscribe path)
 *   6. Navigate away to a second session
 *   7. Navigate back to original session (second subscribe)
 *   8. Assert sentinel is still visible — FAIL on broken code (blank), PASS on fixed code
 *
 * Port: 3488
 */

import { chromium } from 'playwright';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3488;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SENTINEL = 'SWITCH_BACK_SENTINEL';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let browser = null;
let page = null;
// Track tmux sessions created so we can clean them up
const createdTmuxSessions = [];

async function waitForServer(timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/projects`);
      if (r.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Server failed to start within ${timeout}ms`);
}

/**
 * Create a tmux session via WS. Returns the session ID.
 * Grabs ID from session:state events since session:created may be blocked
 * by the watchdog logSessionLifecycle error in the current codebase.
 */
async function createTmuxSession(projectId, name, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error(`WS timeout creating session after ${timeout}ms`));
    }, timeout);

    let sessionId = null;

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'init') {
        ws.send(JSON.stringify({
          type: 'session:create',
          projectId,
          name,
          // mode:tmux — this is the mode with the bug.
          // Command is just 'bash'; server will append --session-id which bash rejects,
          // but TmuxSession wraps it as: bash -c "bash --session-id uuid; exec bash"
          // so exec bash gives us a working shell regardless.
          mode: 'tmux',
          command: 'bash',
        }));
      }

      // Grab the session ID from state events (session:created may not arrive
      // due to watchdogManager.logSessionLifecycle not being a function)
      if ((msg.type === 'session:state' || msg.type === 'session:created') && !sessionId) {
        sessionId = msg.id || (msg.session && msg.session.id);
      }

      // Resolve once session reaches running state
      if (msg.type === 'session:state' && msg.state === 'running' && sessionId) {
        clearTimeout(t);
        ws.close();
        resolve(sessionId);
      }
    });

    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Subscribe to a session, send input, wait for sentinel to appear,
 * then close the connection. This populates _previewBuffer on fixed code.
 */
async function populateSentinel(sessionId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error(`Sentinel never appeared in session output within ${timeout}ms`));
    }, timeout);

    let subscribed = false;
    let sentinelSent = false;

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'init') {
        ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
      }

      if (msg.type === 'session:subscribed' && msg.id === sessionId) {
        subscribed = true;
        // Wait a moment for shell to be ready, then send the sentinel command
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'session:input',
            id: sessionId,
            data: `echo ${SENTINEL}\r`,
          }));
          sentinelSent = true;
        }, 1500);
      }

      if (msg.type === 'session:output' && msg.id === sessionId && sentinelSent) {
        if (msg.data && msg.data.includes(SENTINEL)) {
          clearTimeout(t);
          // Close after brief delay so _previewBuffer has time to accumulate
          setTimeout(() => { ws.close(); resolve(); }, 500);
        }
      }
    });

    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function setup() {
  try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  await sleep(500);

  tmpDir = execSync('mktemp -d /tmp/qa-switch-back-XXXXXX').toString().trim();
  console.log(`[setup] tmpDir: ${tmpDir}`);

  const projADir = path.join(tmpDir, 'project-a');
  const projBDir = path.join(tmpDir, 'project-b');
  fs.mkdirSync(projADir, { recursive: true });
  fs.mkdirSync(projBDir, { recursive: true });

  fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
    projects: [
      { id: 'proj-a', name: 'Project Alpha', path: projADir, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
      { id: 'proj-b', name: 'Project Beta',  path: projBDir, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
    ],
    scratchpad: [],
  }));

  serverProc = spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write(`[srv] ${d}`));
  serverProc.stderr.on('data', d => process.stdout.write(`[srv:ERR] ${d}`));

  await waitForServer();
  console.log('[setup] Server ready');

  // Session A — the session under test (tmux)
  console.log('[setup] Creating Session A (tmux)...');
  const sessionAId = await createTmuxSession('proj-a', 'session-a');
  console.log(`[setup] Session A: ${sessionAId}`);
  createdTmuxSessions.push(`cm-${sessionAId.slice(0, 8)}`);

  // Populate sentinel into session A via WS input, then close connection.
  // On fixed code: _previewBuffer now contains the sentinel.
  // On broken code: no buffer exists; second subscriber will get blank terminal.
  console.log('[setup] Populating sentinel into Session A...');
  await populateSentinel(sessionAId);
  console.log(`[setup] Sentinel "${SENTINEL}" confirmed in Session A output`);

  // Session B — used only as the "other session" to navigate to
  console.log('[setup] Creating Session B (tmux)...');
  const sessionBId = await createTmuxSession('proj-b', 'session-b');
  console.log(`[setup] Session B: ${sessionBId}`);
  createdTmuxSessions.push(`cm-${sessionBId.slice(0, 8)}`);

  return { sessionAId, sessionBId };
}

async function teardown() {
  if (page) { try { await page.close(); } catch {} }
  if (browser) { try { await browser.close(); } catch {} }
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} }
  for (const name of createdTmuxSessions) {
    try { execSync(`tmux kill-session -t ${name} 2>/dev/null || true`); } catch {}
  }
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  console.log('[teardown] Complete');
}

async function getTerminalText() {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    return Array.from(rows).map(r => r.textContent).join('\n');
  });
}

async function run() {
  let passed = false;
  let failReason = '';

  try {
    const { sessionAId } = await setup();

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });

    // ── Step 1: Navigate to app ───────────────────────────────────────────────
    console.log('\n[T] Step 1: Navigate to app...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await page.screenshot({ path: `${tmpDir}/step1-loaded.png` });

    // ── Step 2: Open Project Alpha → Session A ────────────────────────────────
    console.log('[T] Step 2: Open Session A...');
    await page.locator('text=Project Alpha').first().waitFor({ timeout: 10000 });
    await page.locator('text=Project Alpha').first().click();
    await sleep(600);
    await page.locator('text=session-a').first().waitFor({ timeout: 10000 });
    await page.locator('text=session-a').first().click();
    await sleep(1500);
    await page.screenshot({ path: `${tmpDir}/step2-session-a.png` });

    // ── Step 3: Verify sentinel visible in terminal ───────────────────────────
    console.log('[T] Step 3: Waiting for sentinel in terminal...');
    let sentinelVisible = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const text = await getTerminalText();
      if (text.includes(SENTINEL)) { sentinelVisible = true; break; }
      await sleep(500);
    }
    if (!sentinelVisible) {
      const t = await getTerminalText();
      await page.screenshot({ path: `${tmpDir}/step3-no-sentinel.png` });
      throw new Error(`Sentinel never appeared before switch-away. Terminal: "${t.slice(0, 300)}"`);
    }
    console.log('[T] ✓ Sentinel visible before switch-away');
    await page.screenshot({ path: `${tmpDir}/step3-sentinel-visible.png` });

    // ── Step 4: Navigate away to Project Beta → Session B ─────────────────────
    console.log('[T] Step 4: Navigate away to Session B...');
    await page.locator('text=Project Beta').first().click();
    await sleep(400);
    await page.locator('text=session-b').first().waitFor({ timeout: 10000 });
    await page.locator('text=session-b').first().click();
    await sleep(1000);
    await page.screenshot({ path: `${tmpDir}/step4-session-b.png` });
    console.log('[T] Navigated to Session B');

    // ── Step 5: Navigate back to Session A ───────────────────────────────────
    console.log('[T] Step 5: Navigate back to Session A...');
    await page.locator('text=Project Alpha').first().click();
    await sleep(400);
    await page.locator('text=session-a').first().waitFor({ timeout: 10000 });
    await page.locator('text=session-a').first().click();
    await sleep(1500);
    await page.screenshot({ path: `${tmpDir}/step5-returned.png` });

    // ── Step 6: Assert sentinel still visible after switch-back ──────────────
    console.log('[T] Step 6: Asserting sentinel visible after switch-back...');
    const textAfter = await getTerminalText();
    console.log(`[T] Terminal text after return (first 300): "${textAfter.slice(0, 300)}"`);

    if (textAfter.includes(SENTINEL)) {
      passed = true;
      console.log('[T] ✓ PASS — sentinel visible after switch-back');
    } else {
      failReason = `Terminal blank after switch-back. Got: "${textAfter.slice(0, 200)}"`;
      console.log(`[T] ✗ FAIL — ${failReason}`);
    }
    await page.screenshot({ path: `${tmpDir}/step6-final.png` });

  } catch (err) {
    failReason = err.message;
    console.error(`\n[T] ✗ ERROR — ${err.message}`);
    if (page) await page.screenshot({ path: `${tmpDir}/error.png` }).catch(() => {});
  } finally {
    await teardown();
  }

  if (passed) {
    console.log('\n=== RESULT: PASS ===');
    process.exit(0);
  } else {
    console.log(`\n=== RESULT: FAIL ===\nReason: ${failReason}`);
    process.exit(1);
  }
}

run();
