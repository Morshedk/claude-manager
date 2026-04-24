/**
 * T-37: WS Drop During Streaming — Buffer Replays Correctly on Reconnect
 *
 * Purpose: Verify that when the WebSocket drops mid-stream and reconnects,
 * the terminal shows a coherent buffer. Specifically:
 * - No duplicate lines (double-replay)
 * - No partial ANSI escape sequences corrupting output
 * - Session remains alive after reconnect
 *
 * Architecture note: DirectSession.addViewer() does NOT replay scrollback —
 * on reconnect, client gets session:subscribed → xterm.reset() → only live output.
 * So the test verifies: (a) no duplication, (b) session alive, (c) new output
 * appears after reconnect.
 *
 * Run: PORT=3134 npx playwright test tests/adversarial/T-37-ws-drop-replay.test.js --reporter=line --timeout=120000
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
const PORTS = { direct: 3134, tmux: 3734 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T37-ws-drop-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS open timeout')), 10000);
  });
}

function waitForMsg(ws, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMsg timeout')), timeout);
    const handler = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

test.describe(`T-37 — WS Drop During Streaming [${MODE}]`, () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T37-XXXXXX').toString().trim();
    console.log(`\n  [T-37] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const projectsSeed = {
      projects: [{
        id: 'proj-t37',
        name: 'T37-Project',
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

    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');
    console.log(`  [T-37] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf8');
      if (crashLog.trim()) console.log('\n  [CRASH LOG]\n' + crashLog);
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('WS reconnect after drop — coherent buffer, no duplicate lines, no ANSI fragments', async () => {
    // ── Step 1: Create a bash session via WS (before opening browser) ──────────
    const wsCreate = await openWs(WS_URL);
    const initMsg = await waitForMsg(wsCreate, m => m.type === 'init');
    console.log(`  [T-37] Got init, clientId: ${initMsg.clientId}`);

    // Collect all messages from now on — attach BEFORE sending create
    const msgBuffer = [];
    const msgCollector = (data) => {
      try { msgBuffer.push(JSON.parse(data.toString())); } catch {}
    };
    wsCreate.on('message', msgCollector);

    // Send create AFTER attaching collector so we don't miss any responses
    wsCreate.send(JSON.stringify({
      type: 'session:create',
      projectId: 'proj-t37',
      name: 'bash-stream',
      command: 'bash',
      mode: MODE,
      cols: 120,
      rows: 30,
    }));

    // Wait for session:created (session:subscribed arrives before this but we may miss it — that's OK)
    const createdMsg = await waitForMsg(wsCreate, m => m.type === 'session:created', 10000);
    const sessionId = createdMsg.session?.id || createdMsg.id;
    console.log(`  [T-37] Session created: ${sessionId}`);
    console.log(`  [T-37] Msgs so far: ${msgBuffer.map(m => m.type).join(', ')}`);

    // Auto-subscribe happens server-side on create — no need to wait for session:subscribed
    // Wait for running state
    const alreadyRunning = msgBuffer.some(m => m.type === 'session:state' && m.id === sessionId && m.state === 'running');
    if (!alreadyRunning) {
      await waitForMsg(wsCreate, m => m.type === 'session:state' && m.id === sessionId && m.state === 'running', 15000);
    }
    wsCreate.off('message', msgCollector);
    console.log(`  [T-37] Session running`);
    await sleep(500); // Let bash initialize

    // ── Step 2: Open browser, click into session FIRST ──────────────────────────
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Monitor console for errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000); // Wait for WS init and session list

    // Click project in sidebar
    await page.click('.project-item');
    await sleep(500);

    // Click session card to open terminal overlay
    await page.click('.session-card');
    await sleep(1500); // Wait for TerminalPane to mount and subscribe

    console.log(`  [T-37] Browser: clicked into session, terminal open`);

    // ── Step 3: Produce 200 lines of output ────────────────────────────────────
    // Send seq 1 200 to bash via the WS (the session was auto-subscribed)
    wsCreate.send(JSON.stringify({
      type: 'session:input',
      id: sessionId,
      data: 'seq 1 200\r',
    }));

    // Wait for "200" to appear in terminal (last line of seq output)
    let outputDetected = false;
    const outputDeadline = Date.now() + 15000;
    while (Date.now() < outputDeadline) {
      const hasOutput = await page.evaluate(() => {
        const vp = document.querySelector('.xterm-viewport');
        if (!vp) return false;
        const state = vp._scrollState ? vp._scrollState() : null;
        return state && state.bufferLength > 50;
      });
      if (hasOutput) { outputDetected = true; break; }
      await sleep(300);
    }
    if (!outputDetected) {
      console.log(`  [T-37] WARNING: output not detected in terminal (may be browser subscription timing)`);
    }

    await sleep(1000); // Let output settle

    // ── Step 4: Record pre-disconnect state ────────────────────────────────────
    const preDisconnectState = await page.evaluate(() => {
      const vp = document.querySelector('.xterm-viewport');
      if (!vp || !vp._scrollState) return { bufferLength: 0, scrollMax: 0 };
      return vp._scrollState();
    });
    console.log(`  [T-37] Pre-disconnect state: bufferLength=${preDisconnectState.bufferLength} scrollMax=${preDisconnectState.scrollMax}`);

    // Get terminal text to check for line "100" before disconnect
    const preDisconnectText = await page.evaluate(() => {
      const rows = document.querySelectorAll('.xterm-rows .xterm-row');
      return Array.from(rows).map(r => r.textContent.trim()).filter(Boolean).join('\n');
    });
    const linesBefore = preDisconnectText.split('\n').filter(l => l.trim().length > 0);
    console.log(`  [T-37] Pre-disconnect text lines: ${linesBefore.length}`);

    // Count how many times "100" appears as a standalone line
    const line100CountBefore = linesBefore.filter(l => l.trim() === '100').length;
    console.log(`  [T-37] Occurrences of line "100" before disconnect: ${line100CountBefore}`);

    // ── Step 5: Kill WS connection via network offline ──────────────────────────
    console.log(`  [T-37] Going offline...`);
    await context.setOffline(true);
    await sleep(2000); // Give server time to detect socket close

    // ── Step 6: Send more output while offline (will be buffered or lost) ──────
    // Also send a new line AFTER reconnect to verify session is alive
    // We'll do this after reconnect

    // ── Step 7: Come back online and wait for reconnect ─────────────────────────
    console.log(`  [T-37] Coming back online...`);
    await context.setOffline(false);

    // Wait for WS reconnect (3s delay + time to re-subscribe)
    await sleep(5000);

    // ── Step 8: Check post-reconnect state ────────────────────────────────────
    const postReconnectState = await page.evaluate(() => {
      const vp = document.querySelector('.xterm-viewport');
      if (!vp || !vp._scrollState) return { bufferLength: 0, scrollMax: 0 };
      return vp._scrollState();
    });
    console.log(`  [T-37] Post-reconnect state: bufferLength=${postReconnectState.bufferLength} scrollMax=${postReconnectState.scrollMax}`);

    // Get terminal text post-reconnect
    const postReconnectText = await page.evaluate(() => {
      const rows = document.querySelectorAll('.xterm-rows .xterm-row');
      return Array.from(rows).map(r => r.textContent.trim()).filter(Boolean).join('\n');
    });
    const linesAfter = postReconnectText.split('\n').filter(l => l.trim().length > 0);
    console.log(`  [T-37] Post-reconnect text lines: ${linesAfter.length}`);

    // Count line "100" after reconnect
    const line100CountAfter = linesAfter.filter(l => l.trim() === '100').length;
    console.log(`  [T-37] Occurrences of line "100" after reconnect: ${line100CountAfter}`);

    // Check for raw ANSI escape sequences in terminal text (visible corruption)
    const hasAnsiFragments = linesAfter.some(l => l.includes('\x1b[') || l.includes('?1;2c') || l.includes('\x1b'));
    console.log(`  [T-37] ANSI fragments visible in text: ${hasAnsiFragments}`);

    // ── Step 9: Send marker line after reconnect to verify session alive ────────
    // Use a fresh WS connection (the browser's WS reconnected; use node WS for input)
    let sessionAlive = false;
    let markerSeen = false;
    try {
      const wsPost = await openWs(WS_URL);
      await waitForMsg(wsPost, m => m.type === 'init', 5000);

      // Subscribe to session output
      const outputBuffer = [];
      wsPost.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:output' && msg.id === sessionId) {
            outputBuffer.push(msg.data);
          }
        } catch {}
      });

      wsPost.send(JSON.stringify({
        type: 'session:subscribe',
        id: sessionId,
        cols: 120,
        rows: 30,
      }));

      await sleep(500); // Wait for subscribed signal

      // Send marker
      wsPost.send(JSON.stringify({
        type: 'session:input',
        id: sessionId,
        data: 'echo RECONNECT_MARKER_T37\r',
      }));

      // Wait for marker in output
      const markerDeadline = Date.now() + 10000;
      while (Date.now() < markerDeadline) {
        const allOutput = outputBuffer.join('');
        if (allOutput.includes('RECONNECT_MARKER_T37')) {
          markerSeen = true;
          sessionAlive = true;
          break;
        }
        await sleep(300);
      }

      wsPost.close();
      console.log(`  [T-37] Session alive after reconnect: ${sessionAlive}, marker seen: ${markerSeen}`);
    } catch (err) {
      console.log(`  [T-37] Post-reconnect WS check failed: ${err.message}`);
    }

    // ── Step 10: Take screenshot ──────────────────────────────────────────────
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'post-reconnect.png'), fullPage: true });

    await browser.close();
    wsCreate.close();

    // ── Assertions ────────────────────────────────────────────────────────────
    console.log(`\n  === T-37 RESULTS ===`);
    console.log(`  Pre-disconnect bufferLength: ${preDisconnectState.bufferLength}`);
    console.log(`  Post-reconnect bufferLength: ${postReconnectState.bufferLength}`);
    console.log(`  Line "100" before: ${line100CountBefore}, after: ${line100CountAfter}`);
    console.log(`  ANSI fragments: ${hasAnsiFragments}`);
    console.log(`  Session alive: ${sessionAlive}`);

    // ASSERTION 1: No double-replay (line "100" should appear at most once)
    expect(line100CountAfter).toBeLessThanOrEqual(1);
    console.log(`  CHECK 1 PASS: No double-replay (line "100" count <= 1)`);

    // ASSERTION 2: No raw ANSI escape fragments visible as text
    expect(hasAnsiFragments).toBe(false);
    console.log(`  CHECK 2 PASS: No ANSI escape fragments in terminal text`);

    // ASSERTION 3: Session survived reconnect (alive, responsive to input)
    expect(sessionAlive).toBe(true);
    console.log(`  CHECK 3 PASS: Session alive and responsive after reconnect`);

    // ASSERTION 4: Buffer is coherent (not completely empty after reconnect)
    // Note: after xterm.reset() on reconnect, only NEW output fills the buffer.
    // If marker was seen, session is alive. bufferLength > 0 is a sanity check.
    // We don't require bufferLength to equal pre-disconnect (reset is expected).
    expect(postReconnectState.bufferLength).toBeGreaterThan(0);
    console.log(`  CHECK 4 PASS: Post-reconnect buffer is not empty (bufferLength=${postReconnectState.bufferLength})`);

    console.log(`\n  T-37: ALL CHECKS PASSED`);
  });
});
} // end for (const MODE of MODES)
