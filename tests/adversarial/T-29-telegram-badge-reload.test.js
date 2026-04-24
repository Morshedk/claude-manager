/**
 * T-29: Telegram session shows TG badge after browser reload
 *
 * Score: 8
 * Port: 3126
 * Type: Playwright browser test
 *
 * Flow: Create a session with telegram:true via WS. Confirm "TG" badge appears.
 * Hard-reload browser. Navigate back to project. Verify TG badge still visible.
 *
 * Pass: TG badge visible before reload AND still visible after reload.
 * Fail: TG badge disappears after reload (telegramEnabled not persisted/delivered).
 *
 * Run: PORT=3126 npx playwright test tests/adversarial/T-29-telegram-badge-reload.test.js --reporter=line --timeout=60000
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
const PORTS = { direct: 3126, tmux: 3726 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-29-telegram-badge-${MODE}`);

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

test.describe(`T-29 — Telegram badge persists after browser reload [${MODE}]`, () => {
  let serverProc = null;
  let tmpDir = '';
  let projPath = '';
  const projectId = 'proj-t29';
  const projectName = 'T29-Project';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3126
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T29-XXXXXX').toString().trim();
    console.log(`\n  [T-29] tmpDir: ${tmpDir}`);

    projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    // Seed projects.json — must use { "projects": [...], "scratchpad": [] } format
    const projectsSeed = {
      projects: [{
        id: projectId,
        name: projectName,
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
      if (code !== null && code !== 0) console.log(`  [T-29] Server exited with code ${code}`);
    });

    await waitForServer(`${BASE_URL}/api/projects`);
    console.log(`  [T-29] Server ready on port ${PORT}`);
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

  test('TG badge persists after hard browser reload', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // ── Step 1: Open browser and select project ────────────────────────────
      console.log('\n  [T-29] Step 1: Navigate to app and select project...');
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

      // Wait for WS connection
      await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
      console.log('  [T-29] WS connected');

      // Click the project in sidebar
      await page.waitForSelector('.project-item', { timeout: 10000 });
      await page.click('.project-item');
      await sleep(500);

      // ── Step 2: Create session with telegram:true via WS ───────────────────
      console.log('  [T-29] Step 2: Creating session with telegram:true via WS...');
      const ws = await wsConnect(`ws://127.0.0.1:${PORT}`);

      let sessionId;
      try {
        wsSend(ws, {
          type: 'session:create',
          projectId,
          name: 'T29-tg-session',
          command: 'bash',
          args: [],
          telegram: true,
        });

        wsSend(ws, {
          type: 'session:create',
          projectId,
          name: 'T29-tg-session',
          command: 'bash',
          args: [],
          telegram: true,
        });

        const created = await wsWaitFor(ws, m => m.type === 'session:created', 15000);
        sessionId = created.session?.id || created.sessionId;
        if (!sessionId) throw new Error('session:created did not include session id: ' + JSON.stringify(created));
        console.log(`  [T-29] Session created: ${sessionId}`);
      } finally {
        ws.close();
      }

      // ── Step 3: Verify TG badge appears before reload ──────────────────────
      console.log('  [T-29] Step 3: Checking for TG badge before reload...');
      await page.waitForSelector('.badge-telegram', { timeout: 8000 });
      const badgeTextBefore = await page.$eval('.badge-telegram', el => el.textContent.trim());
      console.log(`  [T-29] Badge before reload: "${badgeTextBefore}"`);

      if (!badgeTextBefore.includes('TG')) {
        throw new Error(`TG badge text wrong before reload: "${badgeTextBefore}"`);
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-before-reload.png') });

      // ── Step 4: Hard-reload browser ────────────────────────────────────────
      console.log('  [T-29] Step 4: Hard-reloading browser...');
      await page.evaluate(() => location.reload());
      await page.waitForLoadState('domcontentloaded');

      // Wait for WS reconnect
      await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
      console.log('  [T-29] After reload: WS reconnected');

      // Re-click the project
      await page.waitForSelector('.project-item', { timeout: 5000 });
      await page.click('.project-item');
      await sleep(800);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-after-reload.png') });

      // ── Step 5: Verify TG badge is still visible ───────────────────────────
      console.log('  [T-29] Step 5: Checking for TG badge after reload...');
      await page.waitForSelector('.badge-telegram', { timeout: 8000 });
      const badgeTextAfter = await page.$eval('.badge-telegram', el => el.textContent.trim());
      console.log(`  [T-29] Badge after reload: "${badgeTextAfter}"`);

      expect(badgeTextAfter).toContain('TG');
      console.log('  [T-29] PASS: TG badge persists after hard reload');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-badge-confirmed.png') });

    } finally {
      await page.close();
      await context.close();
      await browser.close();
    }

    // ── Crash log check ────────────────────────────────────────────────────
    const crashLogPath = path.join(tmpDir, 'crash.log');
    if (fs.existsSync(crashLogPath)) {
      const crashLog = fs.readFileSync(crashLogPath, 'utf8').trim();
      if (crashLog.length > 0) {
        console.log(`  [T-29] Crash log contents:\n${crashLog}`);
        expect(crashLog).toBe('');
      }
    }
  });
});
} // end for (const MODE of MODES)
