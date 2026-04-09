/**
 * T-30: Tmux session refresh — Claude PID unchanged (process not killed)
 *
 * Score: 13
 * Port: 3127
 * Type: Server-level + Playwright browser
 *
 * Flow: Create tmux session (bash). Get PID inside pane via tmux send-keys.
 * Send session:refresh via WS. Get PID again. Assert identical.
 *
 * Pass: PID before === PID after refresh. Tmux session name unchanged.
 * Fail: PID changed — refresh killed and restarted the process inside tmux.
 *
 * Run: PORT=3127 npx playwright test tests/adversarial/T-30-tmux-pid-unchanged.test.js --reporter=line --timeout=90000
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
const PORT = 3127;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-30-tmux-pid');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 20000) {
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
    const timer = setTimeout(() => reject(new Error(`wsWaitFor timeout after ${timeoutMs}ms`)), timeoutMs);
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

/**
 * Get the PID of the process running inside a tmux pane using tmux display-message.
 * This avoids the $$ expansion problem: $$ in execSync's shell gives the sh -c PID,
 * not the bash-inside-tmux PID. tmux display-message -p '#{pane_pid}' gives the
 * correct PID from the tmux server itself.
 */
function getTmuxPanePid(tmuxName) {
  const result = execSync(`tmux display-message -t ${JSON.stringify(tmuxName)} -p '#{pane_pid}'`, { timeout: 3000 });
  const pid = result.toString().trim();
  if (!pid || !/^\d+$/.test(pid)) {
    throw new Error(`Invalid pane_pid from tmux: "${pid}"`);
  }
  return pid;
}

test.describe('T-30 — Tmux refresh does not kill process inside pane', () => {
  let serverProc = null;
  let tmpDir = '';
  let projPath = '';
  const projectId = 'proj-t30';

  test.beforeAll(async () => {
    // Pre-condition: tmux must be available
    try {
      execSync('tmux -V', { timeout: 3000 });
    } catch {
      throw new Error('tmux is not available on this system — T-30 cannot run');
    }

    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3127
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T30-XXXXXX').toString().trim();
    console.log(`\n  [T-30] tmpDir: ${tmpDir}`);

    projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const projectsSeed = {
      projects: [{
        id: projectId,
        name: 'T30-Project',
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
      if (code !== null && code !== 0) console.log(`  [T-30] Server exited with code ${code}`);
    });

    await waitForServer(`${BASE_URL}/api/projects`);
    console.log(`  [T-30] Server ready on port ${PORT}`);
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

  test('Tmux PID inside pane is unchanged after session refresh', async () => {
    const WS_URL = `ws://127.0.0.1:${PORT}`;

    // ── Step 1: Create tmux bash session ──────────────────────────────────────
    console.log('\n  [T-30] Step 1: Creating tmux bash session...');
    const ws = await wsConnect(WS_URL);

    wsSend(ws, {
      type: 'session:create',
      projectId,
      name: 'T30-tmux-bash',
      command: 'bash',
      args: [],
      mode: 'tmux',
    });

    const created = await wsWaitFor(ws, m => m.type === 'session:created', 15000);
    const sessionId = created.session?.id || created.sessionId;
    if (!sessionId) throw new Error('session:created did not include session id: ' + JSON.stringify(created));
    console.log(`  [T-30] Session created: ${sessionId}`);

    const tmuxName = `cm-${sessionId.slice(0, 8)}`;
    console.log(`  [T-30] Expected tmux name: ${tmuxName}`);

    // Bash transitions to running very fast — don't wait for WS state message
    // (it may have fired before listener was set up). Instead verify via tmux directly.
    await sleep(800); // Allow tmux session to initialize

    // Verify tmux session exists (this is the authoritative check for tmux mode)
    const deadline = Date.now() + 8000;
    let tmuxFound = false;
    while (Date.now() < deadline) {
      try {
        execSync(`tmux has-session -t ${JSON.stringify(tmuxName)} 2>/dev/null`, { timeout: 2000 });
        tmuxFound = true;
        break;
      } catch {
        await sleep(300);
      }
    }
    if (!tmuxFound) throw new Error(`Tmux session "${tmuxName}" not found after session started`);
    console.log(`  [T-30] Session running: confirmed tmux session "${tmuxName}" exists`);

    // ── Step 2: Wait for PTY to be active ─────────────────────────────────────
    // The session was created and _attachPty was called in start(). Just wait briefly.
    await sleep(500);

    // ── Step 3: Get PID before refresh via tmux display-message ───────────────
    console.log('  [T-30] Step 3: Getting PID before refresh...');

    // Use tmux display-message -p '#{pane_pid}' to get the PID of the process
    // running inside the tmux pane. This avoids the $$ expansion issue where
    // execSync's sh -c shell would expand $$ to its own PID, not the bash inside tmux.
    let pidBefore;
    try {
      pidBefore = getTmuxPanePid(tmuxName);
    } catch (e) {
      throw new Error(`Could not get PID before refresh: ${e.message}`);
    }
    console.log(`  [T-30] PID before refresh: ${pidBefore}`);

    // ── Step 4: Send refresh via WS ───────────────────────────────────────────
    console.log('  [T-30] Step 4: Sending session:refresh...');
    wsSend(ws, { type: 'session:refresh', id: sessionId });

    // Server sends: session:subscribed (broadcast) THEN session:refreshed (to requester)
    // Collect both — order may vary
    let gotRefreshed = false;
    let gotSubscribed = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for refresh+subscribed messages')), 15000);
      function handler(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === 'session:refreshed' && msg.id === sessionId) {
          gotRefreshed = true;
          console.log('  [T-30] session:refreshed received');
        }
        if (msg.type === 'session:subscribed' && msg.id === sessionId) {
          gotSubscribed = true;
          console.log('  [T-30] session:subscribed received (PTY re-attached)');
        }
        if (gotRefreshed && gotSubscribed) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve();
        }
      }
      ws.on('message', handler);
    });

    await sleep(1000); // Let PTY re-attach settle

    // ── Step 5: Verify tmux session still alive ───────────────────────────────
    console.log('  [T-30] Step 5: Verifying tmux session still alive...');
    try {
      execSync(`tmux has-session -t ${JSON.stringify(tmuxName)}`, { timeout: 3000 });
      console.log(`  [T-30] Confirmed tmux session "${tmuxName}" still alive after refresh`);
    } catch {
      throw new Error(`Tmux session "${tmuxName}" died after refresh — FAIL`);
    }

    // ── Step 6: Get PID after refresh via tmux display-message ───────────────
    console.log('  [T-30] Step 6: Getting PID after refresh...');

    let pidAfter;
    try {
      pidAfter = getTmuxPanePid(tmuxName);
    } catch (e) {
      throw new Error(`Could not get PID after refresh: ${e.message}`);
    }
    console.log(`  [T-30] PID after refresh: ${pidAfter}`);

    // ── Step 7: Assert PIDs are identical ─────────────────────────────────────
    console.log(`  [T-30] Comparing PIDs: before=${pidBefore}, after=${pidAfter}`);
    expect(pidAfter).toBe(pidBefore);
    console.log('  [T-30] PASS: PID unchanged — process inside tmux was not killed by refresh');

    ws.close();

    // ── Optional browser check ─────────────────────────────────────────────────
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
      await page.waitForSelector('.project-item', { timeout: 5000 });
      await page.click('.project-item');
      await sleep(500);

      // Verify session card shows running state
      await page.waitForSelector('.badge-activity-busy', { timeout: 5000 });
      console.log('  [T-30] Browser confirms session still running after refresh');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-after-refresh.png') });
    } finally {
      await page.close();
      await context.close();
      await browser.close();
    }

    // ── Crash log check ───────────────────────────────────────────────────────
    const crashLogPath = path.join(tmpDir, 'crash.log');
    if (fs.existsSync(crashLogPath)) {
      const crashLog = fs.readFileSync(crashLogPath, 'utf8').trim();
      if (crashLog.length > 0) {
        console.log(`  [T-30] Crash log contents:\n${crashLog}`);
        expect(crashLog).toBe('');
      }
    }
  });
});
