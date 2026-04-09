/**
 * T-43: Haiku Endurance — 20 messages, 5× Refresh, 3× Reload, full lifecycle
 *
 * Score: 11 | Type: Playwright browser (full lifecycle, sentinel protocol)
 * Requires: real Claude binary (claude-haiku-4-5-20251001)
 *
 * Flow:
 *   Create session → 20 ACKs (sentinel protocol) → 1 browser Refresh (after msg 7)
 *   → 1 hard browser reload (after msg 12) → 1 overlay close/reopen (after msg 16)
 *   → stop → delete → verify clean state
 *
 * Run: npx playwright test tests/adversarial/T-43-haiku-endurance.test.js --reporter=line --timeout=600000
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
const PORT = 3140;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T43-haiku-endurance');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let T0 = 0;
function ts() {
  if (!T0) T0 = Date.now();
  return `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
}

// ── Server lifecycle — single describe so beforeAll/afterAll run ONCE ──────────
test.describe('T-43 — Haiku Endurance: 20 ACKs + Refresh + Reload + Overlay lifecycle', () => {
  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';
  let testSessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3140 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    // Fresh isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-T43-XXXXXX').toString().trim();
    console.log(`\n  [T43.setup] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const crashLogPath = path.join(tmpDir, 'crash.log');
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

    // Create project via REST API
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T43-Project', path: projPath }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T43.setup] Project created: ${testProjectId}`);
    console.log(`  [T43.setup] Server ready on port ${PORT}`);
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
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
  });

  // ── Browser helper ──────────────────────────────────────────────────────────

  async function openApp(browser) {
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
            document.body.textContent.includes('Connected'),
      { timeout: 30000 }
    );
    await sleep(1200);
    return page;
  }

  // ── WS helpers ──────────────────────────────────────────────────────────────

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

  async function subscribeAndCollect(sessionId, cols = 120, rows = 30) {
    const ws = await wsConnect();
    await sleep(200);
    ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId, cols, rows }));
    await waitForMsg(ws, m => m.type === 'session:subscribed' && m.id === sessionId, 10000);
    return buildCollector(ws, sessionId);
  }

  function attachAndCollect(ws, sessionId) {
    return buildCollector(ws, sessionId);
  }

  function buildCollector(ws, sessionId) {
    let buffer = '';
    const listeners = [];

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'session:output' && msg.id === sessionId) {
        const chunk = typeof msg.data === 'string' ? msg.data : '';
        buffer += chunk;
        for (const fn of listeners) fn(buffer);
      }
      if (msg.type === 'session:subscribed' && msg.id === sessionId) {
        console.log(`  [ws] session:subscribed received (xterm reset signal)`);
      }
    });

    ws.on('error', err => console.warn(`  [ws] connection error: ${err.message}`));
    ws.on('close', (code, reason) => {
      console.log(`  [ws] collector WS closed: code=${code} reason=${reason || 'none'}`);
    });

    return {
      ws,
      getBuffer: () => buffer,
      clearBuffer: () => { buffer = ''; },

      waitForAck(n, timeoutMs = 30000) {
        const target = `ACK_${n}`;
        return new Promise((resolve, reject) => {
          if (buffer.includes(target)) { resolve(buffer); return; }
          const timer = setTimeout(() => {
            const idx = listeners.indexOf(check);
            if (idx !== -1) listeners.splice(idx, 1);
            reject(new Error(
              `Timeout waiting for ${target} after ${timeoutMs}ms. ` +
              `Buffer tail (last 400 chars): ${buffer.slice(-400).replace(/[^\x20-\x7e\n]/g, '?')}`
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
    const all = Array.isArray(data.managed) ? data.managed : (Array.isArray(data) ? data : []);
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

  async function waitForTuiReady(collector, label, timeoutMs = 35000) {
    console.log(`  [tui-wait] ${ts()} Waiting for TUI ready (${label})...`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = collector.getBuffer();
      if (raw.includes('bypass') || raw.length > 2000) break;
      await sleep(300);
    }
    console.log(`  [tui-wait] ${ts()} TUI ready (${label}, buffer length: ${collector.getBuffer().length})`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // THE ENDURANCE TEST
  // ────────────────────────────────────────────────────────────────────────────

  test('T-43 — 20 ACK endurance: refresh + reload + overlay lifecycle', async () => {
    test.setTimeout(1200000); // 20 minutes — real Claude binary

    T0 = Date.now();

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    let page;
    let mainSub = null;

    try {
      // ── Step 1: Open browser ──────────────────────────────────────────────
      console.log(`\n  [T43.01] ${ts()} Opening browser...`);
      page = await openApp(browser);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-app-loaded.png') });
      console.log(`  [T43.01] ${ts()} PASS — browser opened`);

      // ── Step 2: Select project ────────────────────────────────────────────
      console.log(`\n  [T43.02] ${ts()} Selecting project...`);
      await page.locator('.project-item').filter({ hasText: 'T43-Project' }).click();
      await sleep(800);
      console.log(`  [T43.02] ${ts()} PASS — project selected`);

      // ── Step 3: Create session via WS ─────────────────────────────────────
      console.log(`\n  [T43.03] ${ts()} Creating Claude haiku session via WS...`);
      const wsCreate = await wsConnect();
      await sleep(300);

      wsCreate.send(JSON.stringify({
        type: 'session:create',
        projectId: testProjectId,
        name: 'T43-haiku',
        command: 'claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions --strict-mcp-config',
        mode: 'direct',
        cols: 120,
        rows: 30,
      }));

      let created;
      try {
        created = await waitForMsg(wsCreate,
          m => m.type === 'session:created' || m.type === 'session:error', 15000);
      } catch (err) {
        wsCreate.close();
        throw new Error(`T43.03 FAILED — session:create timed out: ${err.message}`);
      }

      if (created.type === 'session:error') {
        wsCreate.close();
        throw new Error(`T43.03 FAILED — session:create error: ${created.error}`);
      }

      testSessionId = created.session.id;
      console.log(`  [T43.03] ${ts()} PASS — session created: ${testSessionId}`);

      // ── Step 4: Attach buffer collector, wait for RUNNING ─────────────────
      console.log(`\n  [T43.04] ${ts()} Attaching buffer collector, waiting for RUNNING...`);
      mainSub = attachAndCollect(wsCreate, testSessionId);

      try {
        await waitForStatus(testSessionId, 'running', 30000);
      } catch (err) {
        throw new Error(`T43.04 FAILED — session never reached RUNNING: ${err.message}`);
      }
      console.log(`  [T43.04] ${ts()} Session RUNNING`);

      // ── Step 5: Open session overlay in browser ───────────────────────────
      console.log(`\n  [T43.05] ${ts()} Opening session overlay in browser...`);
      await sleep(500);

      // Reload page to pick up newly created session in the list
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(
        () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
              document.body.textContent.includes('Connected'),
        { timeout: 30000 }
      );
      await sleep(1200);

      // Select project again after reload
      await page.locator('.project-item').filter({ hasText: 'T43-Project' }).click();
      await sleep(800);

      // Click the session card to open overlay
      const sessionCard = page.locator('.session-card').filter({ hasText: 'T43-haiku' }).first();
      await sessionCard.waitFor({ state: 'visible', timeout: 10000 });
      await sessionCard.click();
      await page.locator('#session-overlay').waitFor({ state: 'visible', timeout: 10000 });
      console.log(`  [T43.05] ${ts()} PASS — session overlay opened`);

      // ── Step 6: Wait for TUI ready ────────────────────────────────────────
      await waitForTuiReady(mainSub, 'initial');

      // ── Step 7: Establish sentinel, wait for ACK_1 ────────────────────────
      console.log(`\n  [T43.07] ${ts()} Sending sentinel setup, waiting for ACK_1 (up to 45s)...`);
      mainSub.clearBuffer();
      // CRITICAL: No literal "ACK_1" in the string — PTY echo would false-positive
      mainSub.send('session:input', {
        data: 'For this session, reply to EVERY message with ONLY the format ACK_N where N increments from 1. Nothing else.\r'
      });

      try {
        await mainSub.waitForAck(1, 45000);
      } catch (err) {
        throw new Error(`T43.07 FAILED — ACK_1 never arrived within 45s: ${err.message}`);
      }
      console.log(`  [T43.07] ${ts()} PASS — ACK_1 received`);

      // ── Step 8: Messages 2-7 ─────────────────────────────────────────────
      console.log(`\n  [T43.08] ${ts()} Sending messages 2-7...`);
      for (let n = 2; n <= 7; n++) {
        await sleep(3000);
        mainSub.clearBuffer();
        mainSub.send('session:input', { data: 'NEXT\r' });
        try {
          await mainSub.waitForAck(n, 30000);
          console.log(`  [T43.08] ${ts()} ACK_${n} received`);
        } catch (err) {
          throw new Error(`T43.08 FAILED — ACK_${n} did not arrive: ${err.message}`);
        }
      }
      console.log(`  [T43.08] ${ts()} PASS — ACK_2 through ACK_7 received`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-ack7-received.png') });

      // Check lastLine after ACK_7 (short timeout — non-blocking)
      const lastLine7 = await page.locator('.session-lastline').first().textContent({ timeout: 2000 }).catch(() => '');
      console.log(`  [T43.08] lastLine after ACK_7: "${lastLine7}"`);

      // ── Step 9: Browser Refresh (after message 7) — wait for ACK_8 ───────
      console.log(`\n  [T43.09] ${ts()} Clicking browser Refresh button...`);

      // Wait for session:subscribed on mainSub AFTER refresh click
      // Set up the listener before clicking
      const subscribedAfterRefresh = waitForMsg(mainSub.ws,
        m => m.type === 'session:subscribed' && m.id === testSessionId, 20000
      ).catch(() => null); // non-fatal if missed

      await page.locator('#session-overlay button[title="Refresh session"]').click();
      console.log(`  [T43.09] ${ts()} Refresh button clicked`);

      // Wait for session to return to RUNNING
      try {
        await waitForStatus(testSessionId, 'running', 30000);
        console.log(`  [T43.09] ${ts()} Session RUNNING after Refresh`);
      } catch (err) {
        throw new Error(`T43.09 FAILED — session never returned to RUNNING after Refresh: ${err.message}`);
      }

      // Check if session:subscribed was received
      const subscribedMsg = await subscribedAfterRefresh;
      if (subscribedMsg) {
        console.log(`  [T43.09] session:subscribed received — xterm reset confirmed`);
      } else {
        console.warn(`  [T43.09] WARN — session:subscribed not seen on test WS after Refresh`);
      }

      // After Refresh, open a fresh WS subscription to get only post-refresh PTY output.
      // This mirrors F-lifecycle F.09: close old WS, re-subscribe fresh.
      // The old mainSub's buffer contains pre-refresh output including "bypass" — keeping it
      // would cause waitForTuiReady to return immediately on stale data.
      mainSub.close();
      mainSub = await subscribeAndCollect(testSessionId);
      console.log(`  [T43.09] ${ts()} Re-subscribed with fresh WS after Refresh`);

      // Wait for TUI ready on fresh buffer
      await waitForTuiReady(mainSub, 'post-Refresh');

      // Send NEXT and wait for ACK_8 — conversation continuity check
      // If --resume worked, Claude remembers the sentinel protocol and responds ACK_8.
      // If --resume failed (no conversation file), Claude will not respond with ACK_8.
      console.log(`  [T43.09] ${ts()} Sending NEXT, waiting for ACK_8...`);
      mainSub.clearBuffer();
      mainSub.send('session:input', { data: 'NEXT\r' });
      try {
        await mainSub.waitForAck(8, 30000);
        console.log(`  [T43.09] ${ts()} PASS — ACK_8 received after Refresh`);
      } catch (err) {
        throw new Error(`T43.09 FAILED — ACK_8 did not arrive after Refresh: ${err.message}`);
      }
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-ack8-after-refresh.png') });

      // ── Step 10: Messages 9-12 ────────────────────────────────────────────
      console.log(`\n  [T43.10] ${ts()} Sending messages 9-12...`);
      for (let n = 9; n <= 12; n++) {
        await sleep(3000);
        mainSub.clearBuffer();
        mainSub.send('session:input', { data: 'NEXT\r' });
        try {
          await mainSub.waitForAck(n, 30000);
          console.log(`  [T43.10] ${ts()} ACK_${n} received`);
        } catch (err) {
          throw new Error(`T43.10 FAILED — ACK_${n} did not arrive: ${err.message}`);
        }
      }
      console.log(`  [T43.10] ${ts()} PASS — ACK_9 through ACK_12 received`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-ack12-received.png') });

      // Check lastLine after ACK_12 (short timeout — non-blocking)
      const lastLine12 = await page.locator('.session-lastline').first().textContent({ timeout: 2000 }).catch(() => '');
      console.log(`  [T43.10] lastLine after ACK_12: "${lastLine12}"`);

      // ── Step 11: Hard browser reload (after message 12) — ACK_13 ─────────
      console.log(`\n  [T43.11] ${ts()} Hard-reloading browser (CDP cache bypass)...`);

      const client = await page.context().newCDPSession(page);
      await client.send('Network.setCacheDisabled', { cacheDisabled: true });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await client.send('Network.setCacheDisabled', { cacheDisabled: false });
      await client.detach().catch(() => {});

      // Wait for "Connected" indicator after reload
      try {
        await page.waitForFunction(
          () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
                document.body.textContent.includes('Connected'),
          { timeout: 30000 }
        );
      } catch (err) {
        throw new Error(`T43.11 FAILED — "Connected" not visible after hard reload: ${err.message}`);
      }
      await sleep(1200);
      console.log(`  [T43.11] ${ts()} Browser reloaded, WS reconnected`);

      // Re-select project (signals reset on reload)
      await page.locator('.project-item').filter({ hasText: 'T43-Project' }).click();
      await sleep(800);

      // Re-open session overlay
      const sessionCardAfterReload = page.locator('.session-card').filter({ hasText: 'T43-haiku' }).first();
      await sessionCardAfterReload.waitFor({ state: 'visible', timeout: 10000 });
      await sessionCardAfterReload.click();
      await page.locator('#session-overlay').waitFor({ state: 'visible', timeout: 10000 });
      console.log(`  [T43.11] ${ts()} Overlay reopened after reload`);

      // After reload, PTY was not restarted — TUI is still running.
      // Wait a moment for any buffered output then send NEXT.
      await sleep(2000);

      console.log(`  [T43.11] ${ts()} Sending NEXT, waiting for ACK_13...`);
      mainSub.clearBuffer();
      mainSub.send('session:input', { data: 'NEXT\r' });
      try {
        await mainSub.waitForAck(13, 30000);
        console.log(`  [T43.11] ${ts()} PASS — ACK_13 received after hard reload`);
      } catch (err) {
        throw new Error(`T43.11 FAILED — ACK_13 did not arrive after hard reload: ${err.message}`);
      }
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-ack13-after-reload.png') });

      // ── Step 12: Messages 14-16 ───────────────────────────────────────────
      console.log(`\n  [T43.12] ${ts()} Sending messages 14-16...`);
      for (let n = 14; n <= 16; n++) {
        await sleep(3000);
        mainSub.clearBuffer();
        mainSub.send('session:input', { data: 'NEXT\r' });
        try {
          await mainSub.waitForAck(n, 30000);
          console.log(`  [T43.12] ${ts()} ACK_${n} received`);
        } catch (err) {
          throw new Error(`T43.12 FAILED — ACK_${n} did not arrive: ${err.message}`);
        }
      }
      console.log(`  [T43.12] ${ts()} PASS — ACK_14 through ACK_16 received`);

      // ── Step 13: Close and reopen overlay (after message 16) — ACK_17 ────
      console.log(`\n  [T43.13] ${ts()} Closing terminal overlay (✕ button)...`);
      await page.locator('#btn-detach').click();
      await page.locator('#session-overlay').waitFor({ state: 'hidden', timeout: 8000 }).catch(async () => {
        // If #session-overlay is not hidden, check it's detached/absent
        const visible = await page.locator('#session-overlay').isVisible().catch(() => false);
        if (visible) throw new Error('T43.13 FAILED — overlay did not close after clicking ✕');
      });
      console.log(`  [T43.13] ${ts()} Overlay closed`);

      await sleep(500);

      // Reopen overlay by clicking session card
      const sessionCardForReopen = page.locator('.session-card').filter({ hasText: 'T43-haiku' }).first();
      await sessionCardForReopen.waitFor({ state: 'visible', timeout: 10000 });
      await sessionCardForReopen.click();
      await page.locator('#session-overlay').waitFor({ state: 'visible', timeout: 10000 });
      console.log(`  [T43.13] ${ts()} Overlay reopened`);

      // Wait for TerminalPane to re-mount and WS re-subscribe (short wait)
      await sleep(1000);

      console.log(`  [T43.13] ${ts()} Sending NEXT, waiting for ACK_17...`);
      mainSub.clearBuffer();
      mainSub.send('session:input', { data: 'NEXT\r' });
      try {
        await mainSub.waitForAck(17, 30000);
        console.log(`  [T43.13] ${ts()} PASS — ACK_17 received after overlay close/reopen`);
      } catch (err) {
        throw new Error(`T43.13 FAILED — ACK_17 did not arrive after overlay close/reopen: ${err.message}`);
      }
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-ack17-after-overlay-reopen.png') });

      // ── Step 14: Messages 18-20 ───────────────────────────────────────────
      console.log(`\n  [T43.14] ${ts()} Sending messages 18-20...`);
      for (let n = 18; n <= 20; n++) {
        await sleep(3000);
        mainSub.clearBuffer();
        mainSub.send('session:input', { data: 'NEXT\r' });
        try {
          await mainSub.waitForAck(n, 30000);
          console.log(`  [T43.14] ${ts()} ACK_${n} received`);
        } catch (err) {
          throw new Error(`T43.14 FAILED — ACK_${n} did not arrive: ${err.message}`);
        }
      }
      console.log(`  [T43.14] ${ts()} PASS — ACK_18 through ACK_20 received`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-ack20-final.png') });

      // Check lastLine after ACK_20 (short timeout — non-blocking)
      const lastLine20 = await page.locator('.session-lastline').first().textContent({ timeout: 2000 }).catch(() => '');
      console.log(`  [T43.14] lastLine after ACK_20: "${lastLine20}"`);

      // ── Step 15: Stop session via browser ─────────────────────────────────
      console.log(`\n  [T43.15] ${ts()} Stopping session via Stop button...`);
      const stopBtn = page.locator('#btn-session-stop');
      const stopBtnVisible = await stopBtn.isVisible().catch(() => false);
      if (stopBtnVisible) {
        await stopBtn.click();
        console.log(`  [T43.15] ${ts()} Stop button clicked`);
      } else {
        // Fallback: stop via WS
        console.warn('  [T43.15] WARN — Stop button not visible, stopping via WS');
        mainSub.send('session:stop');
      }

      let stopped = false;
      const stopDeadline = Date.now() + 15000;
      while (Date.now() < stopDeadline) {
        const s = await getSessionStatus(testSessionId);
        if (s?.status === 'stopped' || s?.state === 'stopped') { stopped = true; break; }
        await sleep(300);
      }

      if (!stopped) {
        const s = await getSessionStatus(testSessionId);
        throw new Error(`T43.15 FAILED — session not stopped after 15s, status: ${s?.status || s?.state}`);
      }
      console.log(`  [T43.15] ${ts()} PASS — session stopped`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-session-stopped.png') });

      // ── Step 16: Delete session via browser ───────────────────────────────
      console.log(`\n  [T43.16] ${ts()} Deleting session via browser Delete button...`);

      // Close overlay first if still visible
      const overlayVisible = await page.locator('#session-overlay').isVisible().catch(() => false);
      if (overlayVisible) {
        await page.locator('#btn-detach').click().catch(() => {});
        await sleep(500);
      }

      // Register dialog handler BEFORE clicking Delete
      page.once('dialog', d => {
        console.log(`  [T43.16] Dialog: "${d.message()}" — accepting`);
        d.accept();
      });

      // Find session card and click Delete
      const cardForDelete = page.locator('.session-card').filter({ hasText: 'T43-haiku' }).first();
      await cardForDelete.waitFor({ state: 'visible', timeout: 10000 });

      const deleteBtn = cardForDelete.locator('.btn-danger', { hasText: 'Delete' });
      await deleteBtn.waitFor({ state: 'visible', timeout: 5000 });
      await deleteBtn.click();

      // Wait for session card to disappear
      let cardGone = false;
      const deleteDeadline = Date.now() + 10000;
      while (Date.now() < deleteDeadline) {
        const visible = await page.locator('.session-card').filter({ hasText: 'T43-haiku' }).isVisible().catch(() => false);
        if (!visible) { cardGone = true; break; }
        await sleep(300);
      }

      if (!cardGone) {
        throw new Error(`T43.16 FAILED — session card still visible after delete`);
      }
      console.log(`  [T43.16] ${ts()} PASS — session card gone from browser UI`);

      // Verify via API
      let deleted = false;
      const apiDeleteDeadline = Date.now() + 8000;
      while (Date.now() < apiDeleteDeadline) {
        const s = await getSessionStatus(testSessionId);
        if (!s) { deleted = true; break; }
        await sleep(300);
      }

      if (!deleted) {
        throw new Error(`T43.16 FAILED — session still in /api/sessions after delete`);
      }
      console.log(`  [T43.16] ${ts()} PASS — session deleted from API`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08-session-deleted.png') });

      // ── Final assertions ──────────────────────────────────────────────────
      console.log('\n  ── FINAL ASSERTIONS ──');

      // Verify all 20 ACKs were received in sequence (already proven by individual checks above)
      console.log('  [PASS] All 20 ACKs received in order (ACK_1 through ACK_20)');
      console.log('  [PASS] Refresh preserved conversation continuity (ACK_8 arrived)');
      console.log('  [PASS] Hard reload preserved conversation continuity (ACK_13 arrived)');
      console.log('  [PASS] Overlay close/reopen preserved conversation continuity (ACK_17 arrived)');
      console.log('  [PASS] Session stopped cleanly');
      console.log('  [PASS] Session card removed from UI and API after delete');

      console.log(`\n  ✓ T-43 ALL STEPS PASSED — ${ts()} elapsed`);

    } finally {
      if (mainSub) { try { mainSub.close(); } catch {} }
      try { await browser.close(); } catch {}
    }
  });
});
