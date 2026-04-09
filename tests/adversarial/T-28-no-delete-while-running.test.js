/**
 * T-28: Delete button absent on running session card
 *
 * Score: L=4 S=3 D=2 (Total: 9)
 * Test type: Playwright browser test
 *
 * Flow: Create a bash session and wait until it reaches "running" state.
 * Inspect the session card's action buttons.
 *
 * Pass: Stop button IS present. Delete button is NOT present. Refresh button is NOT present.
 * Fail: Delete button appears on a running session card.
 *
 * Complementary: After stopping, assert Delete IS present and Stop is NOT.
 *
 * Run: PORT=3125 npx playwright test tests/adversarial/T-28-no-delete-while-running.test.js --reporter=line --timeout=120000
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
const PORT = 3125;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-28-no-delete-running');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server did not start at ${url} within ${timeoutMs}ms`);
}

// ── WS helpers ────────────────────────────────────────────────────────────────

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 8000);
  });
}

function wsSend(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function wsWaitFor(ws, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wsWaitFor timeout')), timeoutMs);
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

async function createBashSession(ws, projectId, projPath) {
  wsSend(ws, {
    type: 'session:create',
    projectId,
    command: 'bash',
    args: [],
    cwd: projPath,
    name: 'T28-bash',
  });

  const created = await wsWaitFor(ws, m => m.type === 'session:created', 15000);
  const sessionId = created.session?.id || created.sessionId;
  if (!sessionId) throw new Error('session:created did not include session id: ' + JSON.stringify(created));
  return sessionId;
}

async function waitForSessionRunning(ws, sessionId, timeoutMs = 20000) {
  return wsWaitFor(ws, m => {
    // Server broadcasts sessions:list after create (bulk list)
    if (m.type === 'sessions:list') {
      const s = m.sessions?.find(s => s.id === sessionId);
      return s && (s.state === 'running' || s.status === 'running');
    }
    // Server broadcasts session:state on state changes (id field, not sessionId)
    if (m.type === 'session:state' && (m.id === sessionId || m.sessionId === sessionId)) {
      return m.state === 'running';
    }
    // Fallback: legacy stateChange format
    if (m.type === 'session:stateChange' && (m.id === sessionId || m.sessionId === sessionId)) {
      return m.state === 'running' || m.status === 'running';
    }
    return false;
  }, timeoutMs);
}

async function stopSessionViaWS(ws, sessionId) {
  // Server expects { type: 'session:stop', id: ... }
  wsSend(ws, { type: 'session:stop', id: sessionId });
}

async function waitForSessionStopped(ws, sessionId, timeoutMs = 20000) {
  return wsWaitFor(ws, m => {
    if (m.type === 'sessions:list') {
      const s = m.sessions?.find(s => s.id === sessionId);
      return s && (s.state === 'stopped' || s.status === 'stopped' || s.state === 'exited' || s.status === 'exited');
    }
    // Server broadcasts session:state (id field)
    if (m.type === 'session:state' && (m.id === sessionId || m.sessionId === sessionId)) {
      return m.state === 'stopped' || m.state === 'exited';
    }
    if (m.type === 'session:stateChange' && (m.id === sessionId || m.sessionId === sessionId)) {
      return m.state === 'stopped' || m.state === 'exited';
    }
    return false;
  }, timeoutMs);
}

// ── Main test ─────────────────────────────────────────────────────────────────

test.describe('T-28 — Delete button absent on running session', () => {
  let serverProc = null;
  let tmpDir = '';
  let projPath = '';
  let projectId = 'proj-t28';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3125 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Fresh isolated temp data directory
    tmpDir = execSync('mktemp -d /tmp/qa-T28-XXXXXX').toString().trim();
    console.log(`\n  [T-28] tmpDir: ${tmpDir}`);

    projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    // Seed projects.json — must use { "projects": [...], "scratchpad": [] } format
    const projectsSeed = {
      projects: [{
        id: projectId,
        name: 'T28-Project',
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
    serverProc.on('exit', (code) => {
      if (code !== null && code !== 0) console.log(`  [T-28] Server exited with code ${code}`);
    });

    await waitForServer(`${BASE_URL}/api/projects`);
    console.log(`  [T-28] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await sleep(2000);
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
    if (tmpDir) {
      try { execSync(`rm -rf "${tmpDir}"`); } catch {}
    }
  });

  test('Running session shows Stop but not Delete', async () => {
    const WS_URL = `ws://127.0.0.1:${PORT}`;

    // 1. Create bash session via WS
    console.log('\n  [T-28] Step 1: Creating bash session via WS...');
    const ws = await wsConnect(WS_URL);

    let sessionId;
    try {
      sessionId = await createBashSession(ws, projectId, projPath);
      console.log(`  [T-28] Session created: ${sessionId}`);
    } finally {
      ws.close();
    }

    // 2. Poll REST API until session reaches running state
    console.log('  [T-28] Step 2: Polling REST API for running state...');
    const runningDeadline = Date.now() + 20000;
    let isRunning = false;
    while (Date.now() < runningDeadline) {
      try {
        const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
        const allSessions = Array.isArray(data) ? data : (Array.isArray(data.managed) ? data.managed : []);
        const s = allSessions.find(s => s.id === sessionId);
        if (s && (s.state === 'running' || s.status === 'running')) {
          isRunning = true;
          break;
        }
      } catch {}
      await sleep(500);
    }
    if (!isRunning) throw new Error(`Session ${sessionId} did not reach running state within 20s`);
    console.log('  [T-28] Session is running');

    // 3. Open browser and navigate to app
    console.log('  [T-28] Step 3: Opening browser...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      // 4. Select the project
      console.log('  [T-28] Step 4: Selecting project...');
      const projectItem = page.locator('.project-item, [class*="project-list"] li, [class*="sidebar"] *')
        .filter({ hasText: 'T28-Project' }).first();
      await projectItem.waitFor({ state: 'visible', timeout: 10000 });
      await projectItem.click();
      await sleep(600);
      console.log('  [T-28] Project selected');

      // 5. Wait for session card to appear with running badge
      console.log('  [T-28] Step 5: Waiting for session card with running badge...');
      const sessionCard = page.locator('.session-card').filter({ hasText: 'T28-bash' }).first();
      await sessionCard.waitFor({ state: 'visible', timeout: 12000 });

      // Wait for the card to show 'running' badge
      await page.waitForFunction(
        () => {
          const cards = Array.from(document.querySelectorAll('.session-card'));
          const card = cards.find(c => c.textContent.includes('T28-bash'));
          return card && card.textContent.includes('running');
        },
        { timeout: 15000 }
      );
      console.log('  [T-28] Session card shows running badge');

      // Screenshot: running state
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-running-state.png'), fullPage: true });

      // ── CORE ASSERTIONS: running state ──────────────────────────────────────

      // 6. Assert Stop button IS present in the session card actions
      console.log('  [T-28] Step 6: Checking Stop button is present...');
      const stopBtn = sessionCard.locator('.session-card-actions button').filter({ hasText: 'Stop' });
      const stopVisible = await stopBtn.isVisible().catch(() => false);
      expect(stopVisible, 'Stop button must be visible on a running session card').toBe(true);
      console.log('  [T-28] PASS — Stop button is present');

      // 7. Assert Delete button is NOT present in the session card actions
      console.log('  [T-28] Step 7: Checking Delete button is absent...');
      const deleteBtn = sessionCard.locator('.session-card-actions button').filter({ hasText: 'Delete' });
      const deleteCount = await deleteBtn.count();
      expect(deleteCount, 'Delete button must NOT be present on a running session card').toBe(0);
      console.log('  [T-28] PASS — Delete button is absent (count=0)');

      // 8. Assert Refresh button is also NOT present (sanity check)
      console.log('  [T-28] Step 8: Checking Refresh button is absent...');
      const refreshBtn = sessionCard.locator('.session-card-actions button').filter({ hasText: 'Refresh' });
      const refreshCount = await refreshBtn.count();
      expect(refreshCount, 'Refresh button must NOT be present on a running session card').toBe(0);
      console.log('  [T-28] PASS — Refresh button is absent (count=0)');

      // ── DOM inspection: check for ANY delete-like button ──────────────────
      console.log('  [T-28] Step 9: Full DOM check for any delete-related button...');
      const anyDeleteInCard = await sessionCard.evaluate(card => {
        const buttons = Array.from(card.querySelectorAll('button'));
        return buttons.filter(b =>
          b.textContent.toLowerCase().includes('delete') ||
          b.dataset.action === 'delete' ||
          b.id?.includes('delete') ||
          b.className?.includes('delete')
        ).map(b => ({ text: b.textContent.trim(), id: b.id, cls: b.className }));
      });
      expect(anyDeleteInCard.length, `No delete-related buttons anywhere in running session card. Found: ${JSON.stringify(anyDeleteInCard)}`).toBe(0);
      console.log('  [T-28] PASS — No delete-related elements in running session card DOM');

      // ── Stop the session and verify buttons flip ──────────────────────────

      console.log('\n  [T-28] Step 10: Stopping session to verify stopped-state buttons...');
      const wsStop = await wsConnect(WS_URL);
      try {
        await stopSessionViaWS(wsStop, sessionId);
      } finally {
        wsStop.close();
      }

      // Poll REST API until session reaches stopped/exited state
      const stoppedDeadline = Date.now() + 20000;
      let isStopped = false;
      while (Date.now() < stoppedDeadline) {
        try {
          const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
          const allSessions = Array.isArray(data) ? data : (Array.isArray(data.managed) ? data.managed : []);
          const s = allSessions.find(s => s.id === sessionId);
          if (s && (s.state === 'stopped' || s.status === 'stopped' || s.state === 'exited' || s.status === 'exited')) {
            isStopped = true;
            break;
          }
        } catch {}
        await sleep(500);
      }
      if (!isStopped) throw new Error(`Session ${sessionId} did not reach stopped state within 20s`);
      console.log('  [T-28] Session stopped');

      // Wait for UI to update to stopped badge
      await page.waitForFunction(
        () => {
          const cards = Array.from(document.querySelectorAll('.session-card'));
          const card = cards.find(c => c.textContent.includes('T28-bash'));
          return card && (card.textContent.includes('stopped') || card.textContent.includes('⏹'));
        },
        { timeout: 15000 }
      );
      console.log('  [T-28] Session card shows stopped badge');

      // Screenshot: stopped state
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-stopped-state.png'), fullPage: true });

      // 11. Assert Delete button IS now present when stopped
      console.log('  [T-28] Step 11: Checking Delete button appears after stop...');
      const deleteBtnStopped = sessionCard.locator('.session-card-actions button').filter({ hasText: 'Delete' });
      const deleteVisibleStopped = await deleteBtnStopped.isVisible().catch(() => false);
      expect(deleteVisibleStopped, 'Delete button must appear on a stopped session card').toBe(true);
      console.log('  [T-28] PASS — Delete button IS present on stopped session');

      // 12. Assert Stop button is NOT present when stopped
      console.log('  [T-28] Step 12: Checking Stop button is absent when stopped...');
      const stopBtnStopped = sessionCard.locator('.session-card-actions button').filter({ hasText: 'Stop' });
      const stopCountStopped = await stopBtnStopped.count();
      expect(stopCountStopped, 'Stop button must NOT be present on a stopped session card').toBe(0);
      console.log('  [T-28] PASS — Stop button absent on stopped session');

      // 13. Assert Refresh button IS present when stopped
      console.log('  [T-28] Step 13: Checking Refresh button appears when stopped...');
      const refreshBtnStopped = sessionCard.locator('.session-card-actions button').filter({ hasText: 'Refresh' });
      const refreshVisibleStopped = await refreshBtnStopped.isVisible().catch(() => false);
      expect(refreshVisibleStopped, 'Refresh button must appear on a stopped session card').toBe(true);
      console.log('  [T-28] PASS — Refresh button IS present on stopped session');

      // Screenshot: stopped state final
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-stopped-buttons-final.png'), fullPage: true });

      console.log('\n  [T-28] ALL CHECKS PASSED');

    } finally {
      await browser.close().catch(() => {});
    }

    // ── Crash log check ───────────────────────────────────────────────────────
    console.log('\n  [T-28] Checking crash log...');
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf8');
      const unhandledErrors = crashLog
        .split('\n')
        .filter(line => line.includes('UnhandledRejection') || line.includes('UncaughtException'));
      expect(unhandledErrors.length, `Crash log must have no unhandled errors. Found: ${unhandledErrors.join(', ')}`).toBe(0);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.log('  [T-28] No crash log found (server ran cleanly)');
    }
  });
});
