/**
 * Refresh Bug T-1: handleSubscribed sends resize after refresh
 *
 * Bug mode: FAIL pre-fix (handleSubscribed only calls xterm.reset(), no resize sent)
 *           PASS post-fix (Fix C adds fitAddon.fit() + SESSION_RESIZE in handleSubscribed)
 *
 * Purpose: Assert that after clicking Refresh in the overlay, the client sends at
 * least one session:resize message AFTER the session:refresh message. Pre-fix this
 * never happens because handleSubscribed only calls xterm.reset(). Post-fix the
 * requestAnimationFrame in handleSubscribed fires fitAddon.fit() + send(SESSION_RESIZE).
 *
 * Port: 3500
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
const PORT = 3500;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'refresh-bug-T1');

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

test.describe('Refresh Bug T-1 — resize sent after refresh', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-refresh-XXXXXX').toString().trim();
    console.log(`\n  [T1] tmpDir: ${tmpDir}`);

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
    console.log(`  [T1] Server ready on port ${PORT}`);
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

  test('T-1: session:resize is sent after clicking Refresh (Fix C behavior)', async () => {
    test.setTimeout(120000);

    // Create session via WS
    const wsSetup = await wsConnect();
    await waitForMsg(wsSetup, m => m.type === 'init', 5000).catch(() => {});
    wsSetup.send(JSON.stringify({
      type: 'session:create',
      projectId: 'p1',
      name: 't1-bash',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));
    const created = await waitForMsg(wsSetup, m => m.type === 'session:created' || m.type === 'session:error', 15000);
    if (created.type === 'session:error') throw new Error(`session:create error: ${created.error}`);
    const sessionId = created.session.id;
    console.log(`  [T1] Session created: ${sessionId}`);
    wsSetup.close();

    await waitForRunning(sessionId);
    console.log(`  [T1] Session running`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    try {
      const page = await browser.newPage();
      page.on('console', msg => { if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`); });

      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Select project and open session
      await page.waitForSelector('text=TestProject', { timeout: 15000 });
      await page.click('text=TestProject');
      await page.waitForSelector('.session-card', { timeout: 10000 });
      await sleep(500);

      // Open session overlay
      const sessionCard = page.locator('.session-card').filter({ hasText: 't1-bash' }).first();
      await sessionCard.waitFor({ state: 'visible', timeout: 10000 });
      await sessionCard.click();
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 10000 });
      console.log(`  [T1] Overlay opened`);

      // Wait for terminal to render — wait for the xterm-screen element, then for canvas or rows
      await page.waitForSelector('#session-overlay-terminal', { state: 'visible', timeout: 15000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: 15000 }).catch(() => {});
      // Allow terminal to finish mounting (subscribe, fit, initial output)
      await sleep(3000);
      console.log(`  [T1] Terminal rendered`);

      // Install WS spy AFTER page is loaded and terminal is working.
      // Patch WebSocket.prototype.send so ALL existing and future WS instances are intercepted.
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
      console.log(`  [T1] WS spy installed`);

      // Record timestamp just before click
      const refreshClickTime = Date.now();
      console.log(`  [T1] Clicking Refresh at ${refreshClickTime}`);

      // Click the Refresh button
      const refreshBtn = page.locator('button', { hasText: 'Refresh' }).first();
      await refreshBtn.waitFor({ state: 'visible', timeout: 5000 });
      await refreshBtn.click();

      // Wait for session to restart and produce output (session:subscribed fires then xterm renders)
      // Just wait a fixed amount — the rAF in Fix C fires within 1 frame (~16ms)
      await sleep(3000);

      // Collect WS log
      const wsLog = await page.evaluate(() => window._wsLog);
      console.log(`  [T1] Captured ${wsLog.length} outgoing WS messages after refresh`);
      console.log(`  [T1] Message types: ${wsLog.map(m => m.type).join(', ')}`);

      const resizeMsgs = wsLog.filter(m => m.type === 'session:resize');
      console.log(`  [T1] session:resize messages: ${resizeMsgs.length}`);
      if (resizeMsgs.length > 0) {
        console.log(`  [T1] Resize messages: ${JSON.stringify(resizeMsgs)}`);
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T1-after-refresh.png') });

      // ── ASSERTIONS ────────────────────────────────────────────────────────
      console.log('\n  ════ T-1 ASSERTIONS ════');

      // A1: At least one session:resize was sent after the refresh
      console.log(`  [A1] session:resize count: ${resizeMsgs.length} (need >= 1)`);
      expect(resizeMsgs.length, 'A1: At least one session:resize must be sent after clicking Refresh').toBeGreaterThan(0);
      console.log(`  [A1] PASS`);

      // A2: The resize message has valid cols and rows
      const lastResize = resizeMsgs[resizeMsgs.length - 1];
      console.log(`  [A2] Resize cols=${lastResize.cols} rows=${lastResize.rows}`);
      expect(lastResize.cols, 'A2: session:resize cols must be > 0').toBeGreaterThan(0);
      expect(lastResize.rows, 'A2: session:resize rows must be > 0').toBeGreaterThan(0);
      console.log(`  [A2] PASS`);

      console.log('\n  T-1 ALL ASSERTIONS PASSED');

    } finally {
      await browser.close();
    }
  });
});
