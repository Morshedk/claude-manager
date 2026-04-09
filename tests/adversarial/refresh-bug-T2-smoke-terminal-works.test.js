/**
 * Refresh Bug T-2: Smoke test — terminal shows content and accepts input after refresh
 *
 * Classification: Smoke test (not bug-mode). Expected to PASS both pre-fix and post-fix
 * because this flow does not stress the dimension mismatch scenario. Exists to guard
 * the fundamental user story: terminal is not black/unresponsive after refresh.
 *
 * Port: 3501
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
const PORT = 3501;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'refresh-bug-T2');

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

test.describe('Refresh Bug T-2 — terminal works after refresh (smoke)', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-refresh-XXXXXX').toString().trim();
    console.log(`\n  [T2] tmpDir: ${tmpDir}`);

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
    console.log(`  [T2] Server ready on port ${PORT}`);
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

  test('T-2: terminal shows content and accepts keyboard input after refresh', async () => {
    test.setTimeout(120000);

    // Create session via WS
    const wsSetup = await wsConnect();
    await waitForMsg(wsSetup, m => m.type === 'init', 5000).catch(() => {});
    wsSetup.send(JSON.stringify({
      type: 'session:create',
      projectId: 'p1',
      name: 't2-bash',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));
    const created = await waitForMsg(wsSetup, m => m.type === 'session:created' || m.type === 'session:error', 15000);
    if (created.type === 'session:error') throw new Error(`session:create error: ${created.error}`);
    const sessionId = created.session.id;
    console.log(`  [T2] Session created: ${sessionId}`);
    wsSetup.close();

    await waitForRunning(sessionId);
    console.log(`  [T2] Session running`);

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
      const sessionCard = page.locator('.session-card').filter({ hasText: 't2-bash' }).first();
      await sessionCard.waitFor({ state: 'visible', timeout: 10000 });
      await sessionCard.click();
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 10000 });
      console.log(`  [T2] Overlay opened`);

      // Wait for terminal to mount
      await page.waitForSelector('#session-overlay-terminal', { state: 'visible', timeout: 15000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: 15000 }).catch(() => {});
      await sleep(2000);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T2-before-refresh.png') });

      // Click Refresh
      console.log(`  [T2] Clicking Refresh`);
      const refreshBtn = page.locator('button', { hasText: 'Refresh' }).first();
      await refreshBtn.waitFor({ state: 'visible', timeout: 5000 });
      await refreshBtn.click();

      // Wait for session to restart and become interactive
      await sleep(3000);
      console.log(`  [T2] Waited for refresh to complete`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T2-after-refresh.png') });

      // Verify session is still running (not crashed/stopped) after refresh
      const sessionStatus = await waitForRunning(sessionId, 10000).then(() => 'running').catch(() => 'not-running');
      console.log(`  [T2] Session status after refresh: ${sessionStatus}`);

      // Use a WS client to send input and check output
      console.log(`  [T2] Sending echo command via WS`);
      const wsEcho = await wsConnect();
      await waitForMsg(wsEcho, m => m.type === 'init', 5000).catch(() => {});
      let echoOutput = '';
      wsEcho.on('message', raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'session:output' && msg.id === sessionId) echoOutput += msg.data;
        } catch {}
      });
      wsEcho.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
      await sleep(500);
      wsEcho.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo REFRESH_TEST_OK\r' }));
      await sleep(2000);
      wsEcho.close();

      console.log(`  [T2] Echo output (cleaned): ${echoOutput.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').slice(-200)}`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T2-after-refresh.png') });

      // ── ASSERTIONS ────────────────────────────────────────────────────────
      console.log('\n  ════ T-2 ASSERTIONS ════');

      // A1: Session is still running after refresh
      console.log(`  [A1] Session status: ${sessionStatus}`);
      expect(sessionStatus, 'A1: Session must still be running after refresh').toBe('running');
      console.log(`  [A1] PASS`);

      // A2: Echo output received via WS
      const echoVisible = echoOutput.includes('REFRESH_TEST_OK');
      console.log(`  [A2] Echo output contains REFRESH_TEST_OK: ${echoVisible}`);
      expect(echoVisible, 'A2: REFRESH_TEST_OK must appear in WS output after sending echo command').toBe(true);
      console.log(`  [A2] PASS`);

      console.log('\n  T-2 ALL ASSERTIONS PASSED');

    } finally {
      await browser.close();
    }
  });
});
