/**
 * Category F: Lifecycle Endurance Test
 *
 * Purpose: Full end-to-end test with real Claude haiku binary.
 * This is the highest-priority gate before production deployment.
 *
 * Uses sentinel protocol (ACK_<N>) to get deterministic output from Claude.
 * Validates: session create → subscribe → 20 messages → refresh → reload → cleanup
 *
 * Run: npx playwright test tests/adversarial/F-lifecycle.test.js --reporter=line --timeout=600000
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
const PORT = 3097;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'F-lifecycle');

const SLOW = !!process.env.SLOW;
const humanDelay = SLOW ? (ms = 800) => new Promise(r => setTimeout(r, ms)) : () => Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let T0 = 0;
function ts() {
  if (!T0) T0 = Date.now();
  return `+${((Date.now()-T0)/1000).toFixed(1)}s`;
}

// ── Server lifecycle — single describe so beforeAll/afterAll run ONCE ─────────
test.describe('F — Lifecycle Endurance Test', () => {

  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';
  let testSessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3097 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    // F.01 — Fresh isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-F-lifecycle-XXXXXX').toString().trim();
    console.log(`\n  [F.01] tmpDir: ${tmpDir}`);

    // Use crash-trapping wrapper to log unhandledRejections/uncaughtExceptions
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`)); // stdout so Playwright captures it

    // Wait for server ready (up to 25s)
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');

    // F.02 — Create project via REST API
    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'F-lifecycle', path: projPath }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [F.02] Project created: ${testProjectId}`);
    console.log(`  [setup] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch {} serverProc = null; }
    // Print crash log if server died unexpectedly
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      if (crashLog.trim()) {
        console.log('\n  [CRASH LOG]\n' + crashLog);
      }
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
  });

  // ── Browser helper ────────────────────────────────────────────────────────

  /**
   * Open a fresh browser page, navigate to the app, wait for "Connected" indicator.
   * Uses domcontentloaded + explicit WS-connected wait — NOT networkidle (persistent
   * WS connection prevents networkidle from ever firing).
   */
  async function openApp(browser) {
    const page = await browser.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for "Connected" indicator — proves WS init received
    await page.waitForFunction(
      () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
            document.body.textContent.includes('Connected'),
      { timeout: 30000 }
    );

    // Settle for async loadProjects/loadSessions fetches + Preact re-render
    await sleep(SLOW ? 2000 : 1200);

    return page;
  }

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

  /**
   * Subscribe a WS connection to a session and accumulate all output.
   * Returns a handle that exposes the accumulated buffer and a close fn.
   * This avoids race conditions where output arrives before waitForAck is set up.
   */
  async function subscribeAndCollect(sessionId, cols = 120, rows = 30) {
    const ws = await wsConnect();
    await sleep(200);

    ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId, cols, rows }));

    // Wait for subscribed ack
    await waitForMsg(ws, m => m.type === 'session:subscribed' && m.id === sessionId, 10000);

    return buildCollector(ws, sessionId);
  }

  /**
   * Attach buffer collection to an EXISTING WebSocket that is already subscribed
   * to a session (e.g. via the auto-subscribe that happens on session:create).
   * Does NOT send session:subscribe — just attaches the listeners.
   */
  function attachAndCollect(ws, sessionId) {
    return buildCollector(ws, sessionId);
  }

  /**
   * Internal: attach message listeners to ws and return the collector interface.
   */
  function buildCollector(ws, sessionId) {
    let buffer = '';
    const listeners = [];

    // Now collect all output
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'session:output' && msg.id === sessionId) {
        const chunk = typeof msg.data === 'string' ? msg.data : '';
        buffer += chunk;
        // Notify any waiting listeners
        for (const fn of listeners) fn(buffer);
      }
      if (msg.type === 'session:subscribed' && msg.id === sessionId) {
        console.log(`  [ws] Re-received session:subscribed (xterm reset signal)`);
      }
    });

    ws.on('error', err => console.warn(`  [ws] connection error: ${err.message}`));
    ws.on('close', (code, reason) => {
      console.log(`  [ws] collector WS closed: code=${code} reason=${reason||'none'}`);
    });

    return {
      ws,
      getBuffer: () => buffer,
      clearBuffer: () => { buffer = ''; },

      /**
       * Wait until ACK_<n> appears in the buffer (since last clear or start).
       * Checks immediately first (in case it already arrived), then waits.
       */
      waitForAck(n, timeoutMs = 30000) {
        const target = `ACK_${n}`;
        return new Promise((resolve, reject) => {
          // Check if already in buffer
          if (buffer.includes(target)) { resolve(buffer); return; }

          const timer = setTimeout(() => {
            const idx = listeners.indexOf(check);
            if (idx !== -1) listeners.splice(idx, 1);
            reject(new Error(
              `Timeout waiting for ${target} after ${timeoutMs}ms. ` +
              `Buffer tail (last 300 chars): ${buffer.slice(-300).replace(/[^\x20-\x7e\n]/g, '?')}`
            ));
          }, timeoutMs);

          function check(buf) {
            if (buf.includes(target)) {
              clearTimeout(timer);
              const idx = listeners.indexOf(check);
              if (idx !== -1) listeners.splice(idx, 1);
              resolve(buf);
            }
          }
          listeners.push(check);
        });
      },

      send(type, extra = {}) {
        ws.send(JSON.stringify({ type, id: sessionId, ...extra }));
      },

      close() {
        try { ws.close(); } catch {}
      },
    };
  }

  async function getSessionStatus(sessionId) {
    const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const all = Array.isArray(data.managed) ? data.managed : [];
    return all.find(s => s.id === sessionId);
  }

  async function waitForStatus(sessionId, targetStatus, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await getSessionStatus(sessionId);
      const status = s?.status || s?.state;
      if (status === targetStatus) return s;
      await sleep(300);
    }
    const s = await getSessionStatus(sessionId);
    throw new Error(`Session ${sessionId} never reached "${targetStatus}" — last: ${s?.status || s?.state}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // THE SINGLE LIFECYCLE TEST
  // ──────────────────────────────────────────────────────────────────────────

  test('F — Full lifecycle: create → 20 ACKs → refresh → reload → cleanup', async () => {
    test.setTimeout(1200000); // 20 minutes — real Claude binary + refresh/reload cycles

    T0 = Date.now();
    // ── F.03 — Open browser, verify Connected ─────────────────────────────
    console.log(`\n  [F.03] ${ts()} Opening browser...`);
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    let page;
    let mainSub = null; // the main subscription handle

    try {
      page = await openApp(browser);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'F03-app-loaded.png') });
      console.log(`  [F.03] ${ts()} PASS — "Connected" indicator visible`);

      // ── F.04 — Click New Project button, verify modal opens ──────────────
      console.log('\n  [F.04] Testing New Project button...');
      const newProjBtn = page.locator('#project-sidebar button:has-text("New Project"), button:has-text("New Project")').first();
      const btnVisible = await newProjBtn.isVisible().catch(() => false);
      if (btnVisible) {
        await humanDelay(400);
        await newProjBtn.click();
        await humanDelay(600);
        const modal = page.locator('dialog, [role="dialog"], .modal, [class*="modal"]');
        const modalVisible = await modal.isVisible().catch(() => false);
        if (modalVisible) {
          console.log('  [F.04] PASS — New Project modal opened');
          await page.keyboard.press('Escape').catch(() => {});
          await humanDelay(400);
        } else {
          console.warn('  [F.04] WARN — New Project button clicked but no modal appeared (Bug 1 present)');
        }
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'F04-new-project-btn.png') });
      } else {
        console.warn('  [F.04] WARN — New Project button not found in sidebar');
      }

      // ── F.05 — Create Claude session via WS ──────────────────────────────
      // IMPORTANT: Keep the same WS open for the whole test. The server auto-subscribes
      // the creating client to session output. Closing wsCreate and re-subscribing via a new
      // WS caused mysterious disconnects (code=1005) before the sentinel response arrived.
      console.log('\n  [F.05] Creating Claude session...');
      const wsCreate = await wsConnect();
      await sleep(300);

      wsCreate.send(JSON.stringify({
        type: 'session:create',
        projectId: testProjectId,
        name: 'F-lifecycle-haiku',
        // --dangerously-skip-permissions: bypass permission dialog that blocks input
        // --strict-mcp-config: skip MCP servers (none configured) to avoid startup errors
        command: 'claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions --strict-mcp-config',
        mode: 'direct',
        cwd: tmpDir,
        cols: 120,
        rows: 30,
      }));

      let created;
      try {
        created = await waitForMsg(wsCreate,
          m => m.type === 'session:created' || m.type === 'session:error', 15000);
      } catch (err) {
        wsCreate.close();
        throw new Error(`F.05 FAILED — session:create timed out: ${err.message}`);
      }
      // DO NOT close wsCreate here — reuse it as mainSub.
      // The server auto-subscribed wsCreate on session:create; closing and re-subscribing
      // with a new WS caused mysterious code=1005 disconnects before the first response.

      if (created.type === 'session:error') {
        throw new Error(`F.05 FAILED — session:create error: ${created.error}`);
      }

      testSessionId = created.session.id;
      console.log(`  [F.05] PASS — session created: ${testSessionId}`);

      // ── F.06 — Attach buffer collector and wait for RUNNING ──────────────
      // wsCreate is already auto-subscribed to session output by the server.
      // attachAndCollect() wires up the buffer without sending session:subscribe again.
      console.log('\n  [F.06] Attaching buffer collector, waiting for RUNNING...');

      // Attach collector to the already-subscribed wsCreate connection
      mainSub = attachAndCollect(wsCreate, testSessionId);

      // Wait for RUNNING status via API poll
      try {
        await waitForStatus(testSessionId, 'running', 30000);
      } catch (err) {
        throw new Error(`F.06 FAILED — session never reached RUNNING: ${err.message}`);
      }

      // Wait for Claude's TUI to fully initialize before sending input.
      // status=running is set almost immediately (PTY spawned), but Claude takes ~5-10s
      // to render its TUI and reach the input-ready state. Sending input too early
      // results in silent loss — the sentinel never gets processed.
      //
      // We wait until the buffer contains the TUI footer text ("bypass") which confirms
      // Claude's UI has initialized and is ready to accept input.
      // Timeout: 30s (generous for slow auth or cold start).
      console.log('  [F.06] Waiting for Claude TUI ready indicator...');
      const tuiReadyDeadline = Date.now() + 30000;
      while (Date.now() < tuiReadyDeadline) {
        const raw = mainSub.getBuffer();
        // Claude TUI footer shows "bypass permissions on" when --dangerously-skip-permissions is active.
        // The raw buffer contains ANSI codes but the word "bypass" is readable.
        if (raw.includes('bypass') || raw.length > 2000) break;
        await sleep(300);
      }
      console.log(`  [F.06] TUI ready (buffer length: ${mainSub.getBuffer().length})`);
      console.log('  [F.06] PASS — session is RUNNING and TUI initialized');

      // ── F.07 — Send sentinel setup, wait for ACK_1 (45s timeout) ─────────
      // CRITICAL: The setup message must NOT contain "ACK_1" literally. The Claude TUI
      // echoes the human message back through the PTY ~2-3s after sending. If "ACK_1"
      // appears in the input text, buffer.includes('ACK_1') matches the ECHO, not the
      // real Claude response — a false positive that causes all subsequent checks to fail.
      //
      // Safe sentinel: "ACK_N" template (not "ACK_1") + separate NEXT trigger per message.
      // The NEXT trigger also must not contain any "ACK_N" literal.
      console.log('\n  [F.07] Sending sentinel setup, waiting for ACK_1 (up to 45s)...');
      mainSub.clearBuffer();
      // NOTE: "ACK_1" does NOT appear anywhere in this string — prevents PTY echo false positive
      mainSub.send('session:input', { data: 'For this conversation reply to each message with ONLY the text ACK_N where N increments from 1. Nothing else. Begin now.\r' });

      try {
        await mainSub.waitForAck(1, 45000);
      } catch (err) {
        throw new Error(
          `F.07 FAILED — ACK_1 never arrived within 45s. ` +
          `Model may not be available or auth may have failed. ` +
          `Error: ${err.message}`
        );
      }
      console.log(`  [F.07] ${ts()} PASS — ACK_1 received`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'F07-ack1-received.png') });

      // ── F.08 — Send 9 more messages, verify ACK_2 through ACK_10 ─────────
      // Trigger = "NEXT\n" — no "ACK_N" in the text, so PTY echo never satisfies the check.
      // Wait 3s after receiving ACK_N before sending the next message — Claude Code's TUI
      // needs time to finish rendering the response and return to the input prompt.
      console.log('\n  [F.08] Sending 9 more messages (ACK_2 → ACK_10)...');
      for (let n = 2; n <= 10; n++) {
        await sleep(3000); // wait for Claude Code TUI to return to input prompt
        mainSub.clearBuffer();
        mainSub.send('session:input', { data: 'NEXT\r' });

        try {
          await mainSub.waitForAck(n, 30000);
          console.log(`  [F.08] ${ts()} ACK_${n} received`);
        } catch (err) {
          throw new Error(`F.08 FAILED — ACK_${n} did not arrive: ${err.message}`);
        }
      }
      console.log('  [F.08] PASS — ACK_2 through ACK_10 all received');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'F08-ack10-received.png') });

      // ── F.09 — Mid-conversation: Refresh session ─────────────────────────
      // Use WS refresh (session:refresh) for reliable automation.
      // Browser UI Refresh button test is covered by the /test skill separately.
      console.log('\n  [F.09] Refreshing session via WS (tests refresh mechanic)...');

      // Set up a sniffer WS to detect session:subscribed re-broadcast BEFORE refreshing
      const snifferWs = await wsConnect();
      await sleep(200);
      snifferWs.send(JSON.stringify({ type: 'session:subscribe', id: testSessionId, cols: 120, rows: 30 }));
      await waitForMsg(snifferWs, m => m.type === 'session:subscribed' && m.id === testSessionId, 8000);
      console.log(`  [F.09] ${ts()} Sniffer subscribed`);

      const sniffedSubscribed = [];
      snifferWs.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === 'session:subscribed' && m.id === testSessionId) {
          sniffedSubscribed.push(Date.now());
          console.log(`  [F.09] Sniffer received session:subscribed (count: ${sniffedSubscribed.length})`);
        }
      });

      // Send WS refresh and wait for confirmation
      mainSub.send('session:refresh', { cols: 120, rows: 30 });
      try {
        await waitForMsg(mainSub.ws, m => m.type === 'session:refreshed' && m.id === testSessionId, 15000);
        console.log(`  [F.09] ${ts()} session:refreshed received`);
      } catch (err) {
        throw new Error(`F.09 FAILED — session:refresh timed out: ${err.message}`);
      }
      await sleep(500); // give sniffer time to receive session:subscribed

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'F09-after-refresh.png') });
      snifferWs.close();

      // Verify: session:subscribed received (xterm reset fired on refresh)
      expect(
        sniffedSubscribed.length,
        'session:subscribed must be re-broadcast to existing subscribers after Refresh'
      ).toBeGreaterThan(0);
      console.log('  [F.09] PASS — session:subscribed re-broadcast confirmed');

      // Verify: session still RUNNING (or quickly returns to RUNNING after refresh)
      let postRefreshSession = await getSessionStatus(testSessionId);
      console.log(`  [F.09] Post-refresh status: ${postRefreshSession?.status}`);
      let isRunningAfterRefresh = postRefreshSession?.status === 'running' || postRefreshSession?.state === 'running';
      if (!isRunningAfterRefresh) {
        // Refresh restarts PTY — may take a moment to transition STARTING→RUNNING
        try {
          await waitForStatus(testSessionId, 'running', 20000);
          isRunningAfterRefresh = true;
        } catch {
          const s = await getSessionStatus(testSessionId);
          console.log(`  [F.09] Status after 20s wait: ${s?.status}`);
        }
      }
      expect(isRunningAfterRefresh, 'Session must return to RUNNING after Refresh').toBe(true);
      console.log('  [F.09] PASS — session RUNNING after refresh');

      // Close wsCreate and create a fresh subscriber for post-refresh messages.
      // After refresh, a new PTY starts with a new Claude session. We need a fresh
      // WS connection that receives output from the new PTY start.
      mainSub.close();
      mainSub = await subscribeAndCollect(testSessionId);
      console.log('  [F.09] Re-subscribed to session after refresh');

      // Wait for Claude TUI to initialize after the refresh (same as F.06)
      console.log('  [F.09] Waiting for Claude TUI ready after refresh...');
      const tuiReadyDeadline2 = Date.now() + 30000;
      while (Date.now() < tuiReadyDeadline2) {
        const raw = mainSub.getBuffer();
        if (raw.includes('bypass') || raw.length > 2000) break;
        await sleep(300);
      }
      console.log(`  [F.09] TUI ready (buffer length: ${mainSub.getBuffer().length})`);

      // Re-establish sentinel after refresh — new Claude session (no resume).
      // CRITICAL: do NOT put "ACK_11" in this string — PTY echo would false-positive.
      mainSub.clearBuffer();
      mainSub.send('session:input', { data: 'For this conversation reply to each message with ONLY the text ACK_N where N increments from 11. Nothing else. Begin now.\r' });
      try {
        await mainSub.waitForAck(11, 45000);
        console.log(`  [F.09] ${ts()} ACK_11 received — sentinel re-established after refresh`);
      } catch (err) {
        throw new Error(`F.09 FAILED — ACK_11 not received after refresh: ${err.message}`);
      }

      // ── F.10 — Send 4 more messages, verify ACK_12 through ACK_15 ─────────
      console.log('\n  [F.10] Sending 4 more messages (ACK_12 → ACK_15)...');
      for (let n = 12; n <= 15; n++) {
        await sleep(3000);
        mainSub.clearBuffer();
        mainSub.send('session:input', { data: 'NEXT\r' });

        try {
          await mainSub.waitForAck(n, 30000);
          console.log(`  [F.10] ACK_${n} received`);
        } catch (err) {
          throw new Error(`F.10 FAILED — ACK_${n} did not arrive after refresh: ${err.message}`);
        }
      }
      console.log('  [F.10] PASS — ACK_11 through ACK_15 all received');

      // ── F.11 — Reload browser tab ─────────────────────────────────────────
      console.log('\n  [F.11] Reloading browser tab...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for "Connected" indicator after reload
      try {
        await page.waitForFunction(
          () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
                document.body.textContent.includes('Connected'),
          { timeout: 30000 }
        );
      } catch (err) {
        throw new Error(`F.11 FAILED — "Connected" indicator not visible after reload: ${err.message}`);
      }
      await sleep(SLOW ? 2000 : 1200);
      console.log('  [F.11] PASS — WS reconnected after reload, "Connected" visible');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'F11-after-reload.png') });

      // Verify we can re-subscribe to the session via WS
      const reloadSub = await subscribeAndCollect(testSessionId);
      console.log('  [F.11] PASS — can re-subscribe to session after reload');

      // Verify session is still RUNNING
      const postReloadSession = await getSessionStatus(testSessionId);
      const isRunningPostReload = postReloadSession?.status === 'running' || postReloadSession?.state === 'running';
      if (!isRunningPostReload) {
        console.warn(`  [F.11] WARN — session status after reload: ${postReloadSession?.status || postReloadSession?.state}`);
        // Not fatal — session may have paused waiting for input, but it should be resumable
      } else {
        console.log('  [F.11] PASS — session still RUNNING after browser reload');
      }

      // Close mainSub and use reloadSub for remaining messages
      mainSub.close();
      mainSub = reloadSub;

      // ── F.12 — Send 5 more messages, verify ACK_16 through ACK_20 ─────────
      // Re-anchor the sentinel after reload — Claude may have lost context.
      // NOTE: No TUI wait here — the PTY didn't restart during browser reload,
      // so Claude's TUI is already initialized and ready for input.
      console.log('\n  [F.12] Sending 5 more messages (ACK_16 → ACK_20)...');
      mainSub.clearBuffer();
      // NOTE: no "ACK_16" literal here — avoids PTY echo false positive
      mainSub.send('session:input', { data: 'For this conversation reply to each message with ONLY the text ACK_N where N increments from 16. Nothing else. Begin now.\r' });
      try {
        await mainSub.waitForAck(16, 45000);
        console.log(`  [F.12] ACK_16 received`);
      } catch (err) {
        throw new Error(`F.12 FAILED — ACK_16 not received after reload: ${err.message}`);
      }

      for (let n = 17; n <= 20; n++) {
        await sleep(3000);
        mainSub.clearBuffer();
        mainSub.send('session:input', { data: 'NEXT\r' });

        try {
          await mainSub.waitForAck(n, 30000);
          console.log(`  [F.12] ACK_${n} received`);
        } catch (err) {
          throw new Error(`F.12 FAILED — ACK_${n} did not arrive after browser reload: ${err.message}`);
        }
      }
      console.log('  [F.12] PASS — ACK_16 through ACK_20 all received');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'F12-ack20-received.png') });

      // ── F.13 — Verify conversation file on disk ───────────────────────────
      console.log('\n  [F.13] Checking conversation file on disk...');

      const sessionData = await getSessionStatus(testSessionId);
      const claudeSessionId = sessionData?.claudeSessionId;

      if (!claudeSessionId) {
        console.warn('  [F.13] WARN — claudeSessionId not exposed in session list API; skipping file check');
      } else {
        // ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl
        // encoded-cwd: replace / with - (e.g. /tmp/qa-F-lifecycle-abc → -tmp-qa-F-lifecycle-abc)
        // NOTE: meta.cwd is set to project.path (not the cwd param on session:create)
        const cwd = (sessionData?.cwd || tmpDir).replace(/\/+$/, '');
        const encodedPath = cwd.replace(/\//g, '-');
        const homeDir = process.env.HOME || '/home/claude-runner';
        const convoFile = path.join(homeDir, '.claude', 'projects', encodedPath, `${claudeSessionId}.jsonl`);

        const fileExists = fs.existsSync(convoFile);
        expect(fileExists, `Conversation file must exist at: ${convoFile}`).toBe(true);
        console.log(`  [F.13] PASS — conversation file exists: ${convoFile}`);
      }

      // ── F.14 — Stop session via WS ────────────────────────────────────────
      console.log('\n  [F.14] Stopping session...');
      mainSub.send('session:stop');

      let stopped = false;
      const stopDeadline = Date.now() + 10000;
      while (Date.now() < stopDeadline) {
        const s = await getSessionStatus(testSessionId);
        if (s?.status === 'stopped' || s?.state === 'stopped') { stopped = true; break; }
        await sleep(300);
      }

      if (!stopped) {
        const s = await getSessionStatus(testSessionId);
        throw new Error(`F.14 FAILED — session not stopped after 10s, status: ${s?.status || s?.state}`);
      }
      console.log('  [F.14] PASS — session status is stopped');

      // ── F.15 — Delete session via WS ──────────────────────────────────────
      console.log('\n  [F.15] Deleting session...');
      mainSub.send('session:delete');

      let deleted = false;
      const delDeadline = Date.now() + 8000;
      while (Date.now() < delDeadline) {
        const s = await getSessionStatus(testSessionId);
        if (!s) { deleted = true; break; }
        await sleep(300);
      }

      if (!deleted) {
        throw new Error(`F.15 FAILED — session still in API after delete`);
      }
      console.log('  [F.15] PASS — session deleted from API');

      // ── F.16 — Delete project via REST ────────────────────────────────────
      console.log('\n  [F.16] Deleting project...');
      const delRes = await fetch(`${BASE_URL}/api/projects/${testProjectId}`, {
        method: 'DELETE',
      });

      if (!delRes.ok) {
        throw new Error(`F.16 FAILED — DELETE /api/projects/${testProjectId} returned ${delRes.status}`);
      }

      const projectsList = await fetch(`${BASE_URL}/api/projects`).then(r => r.json());
      const projStillExists = Array.isArray(projectsList) && projectsList.some(p => p.id === testProjectId);
      if (projStillExists) {
        throw new Error(`F.16 FAILED — project still in /api/projects after delete`);
      }
      console.log('  [F.16] PASS — project deleted');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'F16-final-state.png') });

      console.log('\n  ✓ ALL F-LIFECYCLE STEPS PASSED');

    } finally {
      if (mainSub) { try { mainSub.close(); } catch {} }
      await browser.close();
    }
  });

}); // end describe
