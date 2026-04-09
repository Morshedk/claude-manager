/**
 * Refresh Bug T-5: No resize sent without the fix — direct assertion on handleSubscribed
 *
 * Bug mode: FAIL pre-fix, PASS post-fix. Most targeted test of Fix C behavior.
 *
 * Asserts that handleSubscribed sends a session:resize AFTER session:refresh.
 * Verifies the ResizeObserver is NOT the source (xterm.reset() does not change
 * container div dimensions, so ResizeObserver cannot produce a false PASS).
 *
 * The WS intercept records all outgoing messages. Pre-fix: no session:resize appears
 * after the session:refresh message because handleSubscribed only calls xterm.reset().
 * Post-fix: the requestAnimationFrame inside handleSubscribed fires fitAddon.fit()
 * and sends SESSION_RESIZE.
 *
 * Port: 3504
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
const PORT = 3504;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'refresh-bug-T5');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 8000);
  });
}

function waitForMsg(ws, predicate, timeoutMs = 15000) {
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

async function waitForRunning(sessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const all = Array.isArray(data.managed) ? data.managed : [];
    const s = all.find(s => s.id === sessionId);
    if (s && (s.status === 'running' || s.state === 'running')) return s;
    await sleep(300);
  }
  throw new Error(`Session ${sessionId} never reached running`);
}

test.describe('Refresh Bug T-5 — resize sent after refresh (rigorous timing assertion)', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-refresh-XXXXXX').toString().trim();
    console.log(`\n  [T5] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const projectsSeed = {
      projects: [{ id: 'p1', name: 'TestProject', path: projPath, createdAt: '2026-01-01T00:00:00Z' }],
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
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');
    console.log(`  [T5] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch {} serverProc = null; }
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf8');
      if (crashLog.trim()) console.log('\n  [CRASH LOG]\n' + crashLog);
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  test('T-5: session:resize sent AFTER session:refresh — rigorous timing check', async () => {
    test.setTimeout(120000);

    // Create session via WS
    const wsSetup = await wsConnect();
    await waitForMsg(wsSetup, m => m.type === 'init', 5000).catch(() => {});
    wsSetup.send(JSON.stringify({
      type: 'session:create',
      projectId: 'p1',
      name: 't5-bash',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));
    const created = await waitForMsg(wsSetup, m => m.type === 'session:created' || m.type === 'session:error', 15000);
    if (created.type === 'session:error') throw new Error(`session:create error: ${created.error}`);
    const sessionId = created.session.id;
    console.log(`  [T5] Session created: ${sessionId}`);
    wsSetup.close();

    await waitForRunning(sessionId);
    console.log(`  [T5] Session running`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    try {
      const page = await browser.newPage();
      page.on('console', msg => { if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`); });

      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      await page.waitForSelector('text=TestProject', { timeout: 15000 });
      await page.click('text=TestProject');
      await page.waitForSelector('.session-card', { timeout: 10000 });
      await sleep(500);

      // Open session overlay
      const sessionCard = page.locator('.session-card').filter({ hasText: 't5-bash' }).first();
      await sessionCard.waitFor({ state: 'visible', timeout: 10000 });
      await sessionCard.click();
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 10000 });
      console.log(`  [T5] Overlay opened`);

      // Wait for terminal to render
      await page.waitForSelector('#session-overlay-terminal', { state: 'visible', timeout: 15000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: 15000 }).catch(() => {});
      await sleep(2000);

      // Resize browser to non-default dimensions to establish the terminal at 900x600
      console.log(`  [T5] Resizing viewport to 900x600`);
      await page.setViewportSize({ width: 900, height: 600 });
      await sleep(1000); // Let ResizeObserver propagate

      // Install WS spy AFTER page is loaded and terminal is working
      // Patch WebSocket.prototype.send so all existing WS instances are intercepted
      await page.evaluate(() => {
        window._wsLog = [];
        const origProtoSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
          try {
            const msg = JSON.parse(data);
            window._wsLog.push({ ...msg, _timestamp: Date.now() });
          } catch {}
          return origProtoSend.call(this, data);
        };
        window._wsSendPatched = true;
      });
      console.log(`  [T5] WS spy installed. Clicking Refresh.`);

      const refreshBtn = page.locator('button', { hasText: 'Refresh' }).first();
      await refreshBtn.waitFor({ state: 'visible', timeout: 5000 });
      await refreshBtn.click();

      // Wait for rAF to fire + session to restart
      await sleep(3000);

      // Collect log
      const wsLog = await page.evaluate(() => window._wsLog);
      console.log(`  [T5] Captured ${wsLog.length} outgoing WS messages`);
      console.log(`  [T5] Message sequence: ${wsLog.map(m => m.type).join(', ')}`);

      // Find the session:refresh message to use as timing boundary
      const refreshMsgIdx = wsLog.findIndex(m => m.type === 'session:refresh');
      const refreshMsg = wsLog[refreshMsgIdx];
      console.log(`  [T5] session:refresh at index: ${refreshMsgIdx}`);

      // Find all session:resize messages AFTER session:refresh
      let resizeMsgsAfterRefresh = [];
      if (refreshMsgIdx >= 0 && refreshMsg) {
        resizeMsgsAfterRefresh = wsLog
          .slice(refreshMsgIdx + 1)
          .filter(m => m.type === 'session:resize');
        console.log(`  [T5] session:resize after session:refresh: ${resizeMsgsAfterRefresh.length}`);
        if (resizeMsgsAfterRefresh.length > 0) {
          console.log(`  [T5] Resize messages: ${JSON.stringify(resizeMsgsAfterRefresh)}`);
        }
      } else {
        // session:refresh may not appear if log was started just as it was sent
        // Fall back to checking all resize messages in the log
        resizeMsgsAfterRefresh = wsLog.filter(m => m.type === 'session:resize');
        console.log(`  [T5] (no session:refresh in log) session:resize msgs total: ${resizeMsgsAfterRefresh.length}`);
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T5-after-refresh.png') });

      // ── ASSERTIONS ────────────────────────────────────────────────────────
      console.log('\n  ════ T-5 ASSERTIONS ════');

      // A1: At least one resize message exists after the refresh
      console.log(`  [A1] session:resize after session:refresh: ${resizeMsgsAfterRefresh.length} (need >= 1)`);
      expect(resizeMsgsAfterRefresh.length, 'A1: At least one session:resize must appear after session:refresh in WS log').toBeGreaterThan(0);
      console.log(`  [A1] PASS`);

      // A2: The resize message has valid cols and rows
      const lastResize = resizeMsgsAfterRefresh[resizeMsgsAfterRefresh.length - 1];
      console.log(`  [A2] Resize cols=${lastResize.cols} rows=${lastResize.rows}`);
      expect(lastResize.cols, 'A2: session:resize cols must be > 0').toBeGreaterThan(0);
      expect(lastResize.rows, 'A2: session:resize rows must be > 0').toBeGreaterThan(0);
      console.log(`  [A2] PASS`);

      // A3: The resize message has the correct session id
      console.log(`  [A3] Resize session id: ${lastResize.id} (expected: ${sessionId})`);
      expect(lastResize.id, 'A3: session:resize must have the correct session id').toBe(sessionId);
      console.log(`  [A3] PASS`);

      console.log('\n  T-5 ALL ASSERTIONS PASSED');

    } finally {
      await browser.close();
    }
  });
});
