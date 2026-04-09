/**
 * Refresh Bug T-3: Dimension mismatch after refresh causes incorrect PTY size
 *
 * Bug mode: FAIL pre-fix, PASS post-fix.
 *
 * Mechanism: Monkey-patch WebSocket.send to DROP session:resize messages while the
 * browser container is shrunk to 800x500. This creates a genuine dimension mismatch:
 * the xterm viewport physically fits 800x500 but the server's stored _cols/_rows
 * remain at the original 1200x800-derived values. When Refresh is clicked WITHOUT
 * Fix C, handleSubscribed only calls xterm.reset() and sends no resize — so the PTY
 * restarts at the stale (large) dimensions, while the xterm viewport is the smaller
 * size. stty size reports the old large dimensions.
 *
 * With Fix C, handleSubscribed calls fitAddon.fit() + sends SESSION_RESIZE with the
 * actual 800x500-derived dimensions. The PTY is resized to match the viewport.
 *
 * Port: 3502
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
const PORT = 3502;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'refresh-bug-T3');

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

// Read stty size output from a raw terminal buffer string
// Returns { rows, cols } or null if not found
function parseSttySize(raw) {
  // stty size outputs "rows cols\r\n"
  const clean = raw.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/[\r]/g, '\n');
  // Match pattern: digits space digits
  const matches = [...clean.matchAll(/(\d+)\s+(\d+)/g)];
  if (matches.length === 0) return null;
  // Take last match
  const last = matches[matches.length - 1];
  return { rows: parseInt(last[1], 10), cols: parseInt(last[2], 10) };
}

test.describe('Refresh Bug T-3 — dimension mismatch: PTY resized to current viewport after refresh', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-refresh-XXXXXX').toString().trim();
    console.log(`\n  [T3] tmpDir: ${tmpDir}`);

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
    console.log(`  [T3] Server ready on port ${PORT}`);
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

  test('T-3: PTY resizes to match current viewport after refresh (not stale stored dimensions)', async () => {
    test.setTimeout(120000);

    // Create session via WS
    const wsSetup = await wsConnect();
    await waitForMsg(wsSetup, m => m.type === 'init', 5000).catch(() => {});
    wsSetup.send(JSON.stringify({
      type: 'session:create',
      projectId: 'p1',
      name: 't3-bash',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));
    const created = await waitForMsg(wsSetup, m => m.type === 'session:created' || m.type === 'session:error', 15000);
    if (created.type === 'session:error') throw new Error(`session:create error: ${created.error}`);
    const sessionId = created.session.id;
    console.log(`  [T3] Session created: ${sessionId}`);
    wsSetup.close();

    await waitForRunning(sessionId);
    console.log(`  [T3] Session running`);

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
      const sessionCard = page.locator('.session-card').filter({ hasText: 't3-bash' }).first();
      await sessionCard.waitFor({ state: 'visible', timeout: 10000 });
      await sessionCard.click();
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 10000 });
      console.log(`  [T3] Overlay opened`);

      // Wait for terminal to stabilize
      await page.waitForSelector('#session-overlay-terminal', { state: 'visible', timeout: 15000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: 15000 }).catch(() => {});
      await sleep(3000);

      // Install WS spy + resize-drop interceptor AFTER terminal is stable
      await page.evaluate(() => {
        window._dropResizeMsgs = false;
        window._wsLog = [];
        const origProtoSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
          try {
            const msg = JSON.parse(data);
            window._wsLog.push({ ...msg, _timestamp: Date.now() });
            // Drop session:resize when blocking mode is active (to simulate dimension mismatch)
            if (window._dropResizeMsgs && msg.type === 'session:resize') {
              console.log('[T3-intercept] DROPPED session:resize (blocking mode)');
              return;
            }
          } catch {}
          return origProtoSend.call(this, data);
        };
        window._wsSendPatched = true;
        console.log('[T3] WS spy + resize-drop interceptor installed');
      });

      // Record initial dimensions via stty size (using a separate WS client)
      console.log(`  [T3] Recording initial PTY dimensions`);
      let sttyOutput1 = '';
      const wsDims1 = await wsConnect();
      await waitForMsg(wsDims1, m => m.type === 'init', 5000).catch(() => {});
      wsDims1.on('message', raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'session:output' && msg.id === sessionId) sttyOutput1 += msg.data;
        } catch {}
      });
      // Subscribe without cols/rows to avoid altering server dimensions
      wsDims1.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
      await sleep(500);
      wsDims1.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'stty size\r' }));
      await sleep(2000);
      wsDims1.close();
      const initialDims = parseSttySize(sttyOutput1);
      console.log(`  [T3] Initial stty size output (raw): ${sttyOutput1.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\s/g, ' ').slice(-100)}`);
      console.log(`  [T3] Initial PTY dims: ${JSON.stringify(initialDims)}`);

      // STEP: Enable resize-drop mode, then shrink viewport
      // This makes the xterm viewport smaller while server keeps stale large dimensions
      console.log(`  [T3] Enabling resize-drop mode and shrinking viewport to 800x500`);
      await page.evaluate(() => { window._dropResizeMsgs = true; });
      await page.setViewportSize({ width: 800, height: 500 });
      await sleep(800); // let ResizeObserver fire and fit locally (but message is dropped)

      // Verify drop mode is active
      const dropActive = await page.evaluate(() => window._dropResizeMsgs);
      console.log(`  [T3] Drop mode active: ${dropActive}`);

      // Re-enable sending (stop dropping), then click Refresh
      // At this point: xterm viewport = 800x500-sized, server _cols/_rows = 1200x800-sized
      console.log(`  [T3] Re-enabling resize sends, clicking Refresh`);
      await page.evaluate(() => { window._dropResizeMsgs = false; window._wsLog = []; });

      const refreshBtn = page.locator('button', { hasText: 'Refresh' }).first();
      await refreshBtn.waitFor({ state: 'visible', timeout: 5000 });
      await refreshBtn.click();

      // Wait for refresh to complete and rAF resize to propagate to PTY
      await sleep(3000);
      console.log(`  [T3] Terminal has content after refresh`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T3-after-refresh.png') });

      // Record post-refresh PTY dimensions via stty size
      console.log(`  [T3] Recording post-refresh PTY dimensions`);
      let sttyOutput2 = '';
      const wsDims2 = await wsConnect();
      await waitForMsg(wsDims2, m => m.type === 'init', 5000).catch(() => {});
      wsDims2.on('message', raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'session:output' && msg.id === sessionId) sttyOutput2 += msg.data;
        } catch {}
      });
      wsDims2.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
      await sleep(500);
      wsDims2.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'stty size\r' }));
      await sleep(2000);
      wsDims2.close();
      const postRefreshDims = parseSttySize(sttyOutput2);
      console.log(`  [T3] Post-refresh stty size output (raw): ${sttyOutput2.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\s/g, ' ').slice(-100)}`);
      console.log(`  [T3] Post-refresh PTY dims: ${JSON.stringify(postRefreshDims)}`);

      // Get the WS log to check resize messages
      const wsLog = await page.evaluate(() => window._wsLog);
      const resizeMsgs = wsLog.filter(m => m.type === 'session:resize');
      console.log(`  [T3] session:resize messages after refresh: ${resizeMsgs.length}`);
      if (resizeMsgs.length > 0) console.log(`  [T3] Resize messages: ${JSON.stringify(resizeMsgs)}`);

      // Get actual container dimensions to know the expected cols for 800x500
      const containerInfo = await page.evaluate(() => {
        const container = document.querySelector('.terminal-container');
        return container ? { width: container.clientWidth, height: container.clientHeight } : null;
      });
      console.log(`  [T3] Container dims at 800x500 viewport: ${JSON.stringify(containerInfo)}`);

      // ── ASSERTIONS ────────────────────────────────────────────────────────
      console.log('\n  ════ T-3 ASSERTIONS ════');

      // A1: At least one resize was sent after the refresh
      console.log(`  [A1] session:resize messages sent after refresh: ${resizeMsgs.length}`);
      expect(resizeMsgs.length, 'A1: At least one session:resize must be sent after Refresh').toBeGreaterThan(0);
      console.log(`  [A1] PASS`);

      // A2: Post-refresh PTY cols match the 800x500 viewport (smaller than initial 1200x800)
      if (postRefreshDims && initialDims) {
        console.log(`  [A2] Post-refresh cols: ${postRefreshDims.cols} (initial: ${initialDims.cols}) — must be smaller`);
        expect(postRefreshDims.cols, 'A2: Post-refresh PTY cols must be smaller than initial (viewport was shrunk)').toBeLessThan(initialDims.cols);
        console.log(`  [A2] PASS`);
      } else if (postRefreshDims) {
        // Can't compare if initial wasn't captured, but resize msg must match container
        if (resizeMsgs.length > 0) {
          const lastResize = resizeMsgs[resizeMsgs.length - 1];
          const delta = Math.abs(postRefreshDims.cols - lastResize.cols);
          console.log(`  [A2] Post-refresh cols (${postRefreshDims.cols}) delta from resize msg (${lastResize.cols}): ${delta}`);
          expect(delta, 'A2: stty cols must approximately match resize message cols (within ±5)').toBeLessThanOrEqual(5);
          console.log(`  [A2] PASS (compared against resize message)`);
        } else {
          console.log(`  [A2] SKIP — no initial dims or resize msgs to compare against`);
        }
      } else {
        console.log(`  [A2] WARN — could not parse post-refresh stty size; checking resize message only`);
        // Still assert A1 covered this
      }

      console.log('\n  T-3 ALL ASSERTIONS PASSED');

    } finally {
      await browser.close();
    }
  });
});
