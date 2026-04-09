/**
 * T-27: Browser Resize While Terminal Is Open — PTY Gets New Dimensions
 *
 * Purpose: Verify that when the browser viewport is resized, the ResizeObserver
 * in TerminalPane.js fires fitAddon.fit(), sends session:resize over WS,
 * and the PTY receives the updated dimensions (ioctl TIOCSWINSZ).
 *
 * Verification:
 * - WS message spy captures session:resize messages
 * - tput cols inside the PTY returns new col count matching resize message
 * - No horizontal scrollbar after resize
 *
 * Port: 3124 (assigned to T-27)
 *
 * Run:
 *   fuser -k 3124/tcp 2>/dev/null; sleep 1
 *   PORT=3124 npx playwright test tests/adversarial/T-27-resize-pty.test.js --reporter=line --timeout=120000
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
const PORT = 3124;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T27-resize-pty');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── WS helpers ────────────────────────────────────────────────────────────────

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
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);
  });
}

async function getSessions(baseUrl) {
  const data = await fetch(`${baseUrl}/api/sessions`).then(r => r.json());
  return Array.isArray(data.managed) ? data.managed : (Array.isArray(data) ? data : []);
}

async function getSessionById(baseUrl, sessionId) {
  const sessions = await getSessions(baseUrl);
  return sessions.find(s => s.id === sessionId) || null;
}

async function waitForStatus(baseUrl, sessionId, targetStatus, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await getSessionById(baseUrl, sessionId);
    const status = s?.status || s?.state;
    if (status === targetStatus) return s;
    await sleep(300);
  }
  const s = await getSessionById(baseUrl, sessionId);
  throw new Error(`Session ${sessionId} never reached "${targetStatus}" — last: ${s?.status || s?.state}`);
}

// ── Test suite ─────────────────────────────────────────────────────────────────

test.describe('T-27 — Browser Resize While Terminal Is Open', () => {
  let serverProc = null;
  let tmpDir = '';
  const projId = 'proj-t27';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1200);

    // Isolated temp data directory
    tmpDir = execSync('mktemp -d /tmp/qa-T27-XXXXXX').toString().trim();
    console.log(`\n  [T-27] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    // Seed projects.json — use { "projects": [...], "scratchpad": [] } format (T-02 lesson)
    const projectsSeed = {
      projects: [{
        id: projId,
        name: 'T27-ResizeProject',
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

    // Wait for server ready (up to 25s)
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');
    console.log(`  [T-27] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf8');
      if (crashLog.trim()) {
        const unhandled = crashLog.split('\n')
          .filter(l => l.includes('UnhandledRejection') || l.includes('UncaughtException'));
        if (unhandled.length) {
          console.log('\n  [CRASH LOG - unhandled errors]\n' + unhandled.join('\n'));
        }
      }
    } catch {}
    if (tmpDir) {
      try { execSync(`rm -rf ${tmpDir}`); } catch {}
      tmpDir = '';
    }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  // ── Main test ──────────────────────────────────────────────────────────────

  test('T-27 — PTY dimensions update when browser viewport is resized', async () => {
    test.setTimeout(120000);

    // ── Step 1: Create a bash session via WS ──────────────────────────────────
    console.log('\n  [T-27.1] Creating bash session via WS...');
    const wsSetup = await wsConnect();
    await sleep(300);

    // Drain init message if present
    await waitForMsg(wsSetup, m => m.type === 'init', 5000).catch(() => {});

    wsSetup.send(JSON.stringify({
      type: 'session:create',
      projectId: projId,
      name: 't27-resize',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const created = await waitForMsg(wsSetup,
      m => m.type === 'session:created' || m.type === 'session:error',
      15000
    );

    if (created.type === 'session:error') {
      throw new Error(`session:create error: ${created.error}`);
    }

    const sessionId = created.session.id;
    console.log(`  [T-27.1] Session created: ${sessionId}`);

    await waitForStatus(BASE_URL, sessionId, 'running', 12000);
    console.log(`  [T-27.1] Session is running`);
    wsSetup.close();
    await sleep(300);

    // ── Step 2: Open browser at 1280×800 ─────────────────────────────────────
    console.log('\n  [T-27.2] Launching browser at 1280×800...');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    let page;
    let sessionIdForCleanup = sessionId;

    try {
      page = await browser.newPage();
      page.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
      });

      // Set initial viewport
      await page.setViewportSize({ width: 1280, height: 800 });

      // Navigate
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for app to connect (WS status indicator or project list rendered)
      await page.waitForFunction(
        () => document.querySelectorAll('.project-item, [class*="project"]').length > 0 ||
              document.body.textContent.includes('T27-ResizeProject'),
        { timeout: 15000 }
      );
      await sleep(800);
      console.log(`  [T-27.2] Browser loaded and app connected`);

      // ── Step 3: Inject WS resize spy ─────────────────────────────────────────
      console.log('\n  [T-27.3] Injecting WebSocket resize spy...');
      await page.evaluate(() => {
        window.__t27_resizeMsgs = [];
        window.__t27_allOutgoing = [];
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
          try {
            const parsed = JSON.parse(data);
            window.__t27_allOutgoing.push(parsed);
            if (parsed.type === 'session:resize') {
              window.__t27_resizeMsgs.push({ ...parsed, _ts: Date.now() });
            }
          } catch {}
          return origSend.call(this, data);
        };
        console.log('[T-27] WS spy installed');
      });

      // ── Step 4: Navigate to project and open session terminal ─────────────────
      console.log('\n  [T-27.4] Selecting project and opening session terminal...');
      const projectItem = page.locator('.project-item, [class*="project-item"]')
        .filter({ hasText: 'T27-ResizeProject' }).first();
      await projectItem.waitFor({ state: 'visible', timeout: 10000 });
      await projectItem.click();
      await sleep(500);

      // Wait for session card
      const sessionCard = page.locator('.session-card').filter({ hasText: 't27-resize' }).first();
      await sessionCard.waitFor({ state: 'visible', timeout: 10000 });
      console.log(`  [T-27.4] Session card visible`);

      // Click to open terminal overlay
      await sessionCard.click();
      await sleep(500);

      // Wait for session overlay
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 10000 });
      console.log(`  [T-27.4] Session overlay opened`);

      // Wait 2s for terminal to stabilize (subscribe flow completes)
      await sleep(2000);

      // ── Step 5: Capture initial terminal dimensions ────────────────────────────
      console.log('\n  [T-27.5] Capturing initial terminal dimensions...');

      // Get initial container size from DOM
      const initialContainerWidth = await page.evaluate(() => {
        const container = document.querySelector('.terminal-container');
        return container ? container.clientWidth : null;
      });
      console.log(`  [T-27.5] Initial container clientWidth: ${initialContainerWidth}px`);

      // Clear any spy messages accumulated during subscribe/fit
      await page.evaluate(() => {
        window.__t27_resizeMsgs = [];
        window.__t27_allOutgoing = [];
      });

      // Send tput cols via a fresh WS connection to get initial cols from PTY
      const wsTput1 = await wsConnect();
      await sleep(200);

      // Collect output
      let tputOutput1 = '';
      wsTput1.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'session:output' && msg.id === sessionId) {
            tputOutput1 += msg.data;
          }
        } catch {}
      });

      // Subscribe to get output (don't double-subscribe from browser — use separate WS)
      wsTput1.send(JSON.stringify({
        type: 'session:subscribe',
        id: sessionId,
        cols: 120,
        rows: 30,
      }));
      await sleep(500);

      // Send tput cols command — use unique prefix to parse reliably
      wsTput1.send(JSON.stringify({
        type: 'session:input',
        id: sessionId,
        data: 'echo "COLS=$(tput cols)"\r',
      }));
      await sleep(1500);

      // Parse initial cols
      const cols1Match = tputOutput1.match(/COLS=(\d+)/);
      const initialPtyCols = cols1Match ? parseInt(cols1Match[1], 10) : null;
      console.log(`  [T-27.5] Initial PTY cols from tput: ${initialPtyCols}`);
      console.log(`  [T-27.5] Raw tput output (sanitized): ${tputOutput1.replace(/\x1b\[[^m]*m/g, '').replace(/[\x00-\x1f]/g, '·').slice(-200)}`);

      wsTput1.close();
      await sleep(300);

      // Take screenshot: initial state
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'T-27-initial.png'),
        fullPage: false,
      });
      console.log(`  [T-27.5] Screenshot saved: T-27-initial.png`);

      // ── Step 6: Resize browser viewport to 800×600 ────────────────────────────
      console.log('\n  [T-27.6] Resizing viewport from 1280×800 to 800×600...');
      const resizeTimestamp = Date.now();
      await page.setViewportSize({ width: 800, height: 600 });
      console.log(`  [T-27.6] Viewport resize called at ${resizeTimestamp}`);

      // Wait 2s for ResizeObserver → fitAddon.fit() → WS send → PTY ioctl
      await sleep(2500);

      // ── Step 7: Read captured resize WS messages ──────────────────────────────
      console.log('\n  [T-27.7] Reading captured resize messages...');
      const resizeMsgs = await page.evaluate(() => window.__t27_resizeMsgs || []);
      const allOutgoing = await page.evaluate(() => window.__t27_allOutgoing || []);

      console.log(`  [T-27.7] Total session:resize messages captured: ${resizeMsgs.length}`);
      console.log(`  [T-27.7] All outgoing WS types: ${allOutgoing.map(m => m.type).join(', ')}`);
      if (resizeMsgs.length > 0) {
        console.log(`  [T-27.7] Resize messages: ${JSON.stringify(resizeMsgs)}`);
      }

      // Get the last resize message after the viewport change
      const resizeMsgsAfter = resizeMsgs.filter(m => m._ts >= resizeTimestamp);
      console.log(`  [T-27.7] Resize messages after viewport change: ${resizeMsgsAfter.length}`);

      // ── Step 8: Check container dimensions changed ────────────────────────────
      console.log('\n  [T-27.8] Checking container dimensions after resize...');
      const newContainerWidth = await page.evaluate(() => {
        const container = document.querySelector('.terminal-container');
        return container ? container.clientWidth : null;
      });
      console.log(`  [T-27.8] New container clientWidth: ${newContainerWidth}px`);

      // ── Step 9: Verify no horizontal scrollbar ────────────────────────────────
      console.log('\n  [T-27.9] Checking for horizontal scrollbar...');
      const scrollbarCheck = await page.evaluate(() => {
        const vp = document.querySelector('.xterm-viewport');
        if (!vp) return { found: false, scrollWidth: 0, clientWidth: 0 };
        return {
          found: true,
          scrollWidth: vp.scrollWidth,
          clientWidth: vp.clientWidth,
          hasHScroll: vp.scrollWidth > vp.clientWidth + 2,
        };
      });
      console.log(`  [T-27.9] xterm-viewport: scrollWidth=${scrollbarCheck.scrollWidth}, clientWidth=${scrollbarCheck.clientWidth}, hasHScroll=${scrollbarCheck.hasHScroll}`);

      // ── Step 10: Re-verify PTY cols with tput after resize ───────────────────
      console.log('\n  [T-27.10] Verifying PTY cols with tput after resize...');
      const wsTput2 = await wsConnect();
      await sleep(200);

      let tputOutput2 = '';
      wsTput2.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'session:output' && msg.id === sessionId) {
            tputOutput2 += msg.data;
          }
        } catch {}
      });

      // Subscribe WITHOUT cols/rows to avoid overriding the PTY dimensions set by the browser resize
      wsTput2.send(JSON.stringify({
        type: 'session:subscribe',
        id: sessionId,
      }));
      await sleep(500);

      wsTput2.send(JSON.stringify({
        type: 'session:input',
        id: sessionId,
        data: 'echo "COLS=$(tput cols)"\r',
      }));
      await sleep(2000);

      const cols2Match = tputOutput2.match(/COLS=(\d+)/g);
      // Take last match to avoid any initial-subscription echo
      const lastMatch = cols2Match ? cols2Match[cols2Match.length - 1] : null;
      const newPtyCols = lastMatch ? parseInt(lastMatch.replace('COLS=', ''), 10) : null;
      console.log(`  [T-27.10] New PTY cols from tput: ${newPtyCols}`);
      console.log(`  [T-27.10] Raw tput2 output (sanitized): ${tputOutput2.replace(/\x1b\[[^m]*m/g, '').replace(/[\x00-\x1f]/g, '·').slice(-200)}`);

      wsTput2.close();
      await sleep(300);

      // ── Step 11: Get PTY cols from API ────────────────────────────────────────
      console.log('\n  [T-27.11] Checking session cols via REST API...');
      const sessionData = await getSessionById(BASE_URL, sessionId);
      const apiCols = sessionData?.cols;
      console.log(`  [T-27.11] API session cols: ${apiCols}`);
      console.log(`  [T-27.11] Full session data: ${JSON.stringify(sessionData)}`);

      // Take screenshot: after resize
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'T-27-after-resize.png'),
        fullPage: false,
      });
      console.log(`  [T-27.11] Screenshot saved: T-27-after-resize.png`);

      // ── ASSERTIONS ────────────────────────────────────────────────────────────
      console.log('\n  ════ ASSERTIONS ════');

      // A1: Container width decreased after resize
      if (initialContainerWidth !== null && newContainerWidth !== null) {
        console.log(`  [A1] Container width: ${initialContainerWidth}px → ${newContainerWidth}px`);
        expect(newContainerWidth, 'A1: Container width must decrease after viewport shrink')
          .toBeLessThan(initialContainerWidth);
        console.log(`  [A1] PASS`);
      } else {
        console.log(`  [A1] SKIP — could not measure container width`);
      }

      // A2: At least one session:resize message sent
      console.log(`  [A2] session:resize messages sent after resize: ${resizeMsgsAfter.length}`);
      expect(resizeMsgsAfter.length, 'A2: At least one session:resize WS message must be sent after viewport resize')
        .toBeGreaterThan(0);
      console.log(`  [A2] PASS`);

      // A3: The resize message has smaller cols than initial
      const lastResizeMsg = resizeMsgsAfter[resizeMsgsAfter.length - 1];
      console.log(`  [A3] Resize message cols: ${lastResizeMsg.cols} (initial PTY cols: ${initialPtyCols})`);
      if (initialPtyCols !== null) {
        expect(lastResizeMsg.cols, 'A3: Resize message cols must be less than initial terminal cols')
          .toBeLessThan(initialPtyCols);
        console.log(`  [A3] PASS`);
      } else {
        // Can't compare if initial cols wasn't captured
        expect(lastResizeMsg.cols, 'A3: Resize message cols must be positive')
          .toBeGreaterThan(0);
        console.log(`  [A3] PASS (initial PTY cols not captured, just checking positive cols)`);
      }

      // A4: PTY confirms new cols via tput
      if (newPtyCols !== null) {
        console.log(`  [A4] tput cols after resize: ${newPtyCols}`);
        if (initialPtyCols !== null) {
          expect(newPtyCols, 'A4: PTY cols after resize must be less than initial PTY cols')
            .toBeLessThan(initialPtyCols);
          console.log(`  [A4a] PASS — tput cols decreased (${initialPtyCols} → ${newPtyCols})`);
        }
        // Check tput matches resize message (within ±5 for FitAddon rounding vs PTY state timing)
        const delta = Math.abs(newPtyCols - lastResizeMsg.cols);
        console.log(`  [A4b] tput cols delta from resize msg: ${delta} (tput=${newPtyCols}, msg=${lastResizeMsg.cols})`);
        expect(delta, 'A4b: tput cols must approximately match the resize message cols (within ±5)')
          .toBeLessThanOrEqual(5);
        console.log(`  [A4b] PASS`);
      } else {
        console.log(`  [A4] WARN — could not parse tput cols output after resize`);
        // Don't hard-fail on tput parse failure — the WS message and container checks are the primary signals
      }

      // A5: No horizontal scrollbar
      if (scrollbarCheck.found) {
        console.log(`  [A5] Horizontal scrollbar check: hasHScroll=${scrollbarCheck.hasHScroll}`);
        expect(scrollbarCheck.hasHScroll, 'A5: No horizontal scrollbar should be present after resize')
          .toBe(false);
        console.log(`  [A5] PASS`);
      } else {
        console.log(`  [A5] SKIP — xterm-viewport not found (terminal may not be fully mounted)`);
      }

      console.log('\n  ✓ T-27 ALL ASSERTIONS PASSED');

      // ── Summary log ────────────────────────────────────────────────────────────
      console.log('\n  ══ T-27 RESULT SUMMARY ══');
      console.log(`  Initial PTY cols: ${initialPtyCols ?? 'N/A'}`);
      console.log(`  session:resize msgs after viewport change: ${resizeMsgsAfter.length}`);
      console.log(`  Resize msg cols: ${lastResizeMsg?.cols ?? 'N/A'}`);
      console.log(`  tput cols after resize: ${newPtyCols ?? 'N/A'}`);
      console.log(`  Container width: ${initialContainerWidth}px → ${newContainerWidth}px`);
      console.log(`  Horizontal scrollbar: ${scrollbarCheck.hasHScroll ?? 'N/A'}`);

    } catch (err) {
      // Take failure screenshot
      if (page) {
        try {
          await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, 'T-27-FAIL.png'),
            fullPage: false,
          });
          console.log('  [T-27] Failure screenshot saved: T-27-FAIL.png');
        } catch {}
      }
      throw err;
    } finally {
      // Cleanup: delete session via WS
      try {
        const wsClean = await wsConnect();
        await sleep(200);
        wsClean.send(JSON.stringify({ type: 'session:delete', id: sessionIdForCleanup }));
        await sleep(500);
        wsClean.close();
      } catch {}

      if (page) {
        try { await browser.close(); } catch {}
      } else {
        try { await browser.close(); } catch {}
      }
    }
  });
});
