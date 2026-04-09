/**
 * T-5: Arrow keys, special keys, and DA1 regression guard
 *
 * Regression guard: CSI sequences for arrow keys (\x1b[A through \x1b[D) must NOT
 * be blocked by the expanded filter. Also verifies that DA1 responses (\x1b[?1;2c)
 * remain filtered after the regex rewrite.
 *
 * Expected to PASS on both pre-fix and post-fix code.
 *
 * Run: npx playwright test --config=playwright-da-osc-filter.config.js tests/adversarial/da-osc-filter-T5-arrow-keys.test.js --reporter=line
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
const PORT = 3304;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const PROJECT_ID = 'proj-t5-arrows';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function toHex(str) {
  return Buffer.from(str, 'binary').toString('hex').replace(/../g, h => h + ' ').trim();
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS open timeout')), 10000);
  });
}

function waitForMsg(ws, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMsg timeout')), timeout);
    const handler = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

test.describe('T-5 — Arrow keys and DA1 regression guard', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-da-T5-XXXXXX').toString().trim();
    console.log(`\n  [T-5] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const seedData = {
      projects: [{
        id: PROJECT_ID,
        name: 'T5-Project',
        path: projPath,
        createdAt: '2026-01-01T00:00:00Z',
      }],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(seedData, null, 2));

    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv-T5] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv-T5:ERR] ${d}`));

    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('T-5 server failed to start within 15s');
    console.log(`  [T-5] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(2000);
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      if (crashLog.includes('Error') || crashLog.includes('uncaught')) {
        console.log('\n  [CRASH LOG]\n' + crashLog);
      }
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('T-5 — Arrow keys flow through; DA1 responses remain filtered', async () => {
    test.setTimeout(120000);

    // Create session
    const ws = await openWs(WS_URL);
    await waitForMsg(ws, m => m.type === 'init');

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: PROJECT_ID,
      name: 'arrows-session',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const createdMsg = await waitForMsg(ws, m => m.type === 'session:created', 10000);
    const sessionId = createdMsg.session?.id || createdMsg.id;
    console.log(`  [T-5] Session: ${sessionId}`);

    try {
      await waitForMsg(ws, m => m.type === 'session:state' && m.id === sessionId && m.state === 'running', 10000);
    } catch {}
    await sleep(1500);

    const browser = await chromium.launch({ headless: true });
    let allInputFrames = [];
    let arrowFrames = [];
    let da1LeakedFrames = [];

    try {
      const page = await browser.newPage();

      page.on('websocket', ws => {
        ws.on('framesent', frame => {
          const text = frame.payload;
          if (typeof text !== 'string') return;
          let msg;
          try { msg = JSON.parse(text); } catch { return; }
          if (msg.type === 'session:input') {
            allInputFrames.push(msg);
            // Arrow/nav keys: \x1b[A, \x1b[B, \x1b[C, \x1b[D, \x1bOA, \x1bOB, etc.
            if (/^\x1b[\[O][ABCDHF]$/.test(msg.data)) {
              console.log(`  [T-5] Arrow/nav key: ${toHex(msg.data)}`);
              arrowFrames.push(msg);
            }
            // DA1 response: \x1b[?1;2c or similar
            if (/^\x1b\[\?\d+[;\d]*c$/.test(msg.data)) {
              console.log(`  [T-5] LEAKED DA1 response! hex: ${toHex(msg.data)}`);
              da1LeakedFrames.push(msg);
            }
          }
        });
      });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      await page.click('.project-item');
      await sleep(800);
      await page.click('.session-card');
      await sleep(2000);

      // Click terminal to ensure focus
      const terminalEl = await page.$('.xterm, .xterm-viewport');
      if (terminalEl) {
        await terminalEl.click();
        console.log('  [T-5] Clicked terminal for focus');
      }
      await sleep(500);

      // Part 1: Press arrow keys
      console.log('  [T-5] Pressing arrow keys: Up Down Left Right Up Down Left Right');
      await page.keyboard.press('ArrowUp');
      await sleep(80);
      await page.keyboard.press('ArrowDown');
      await sleep(80);
      await page.keyboard.press('ArrowLeft');
      await sleep(80);
      await page.keyboard.press('ArrowRight');
      await sleep(80);
      await page.keyboard.press('ArrowUp');
      await sleep(80);
      await page.keyboard.press('ArrowDown');
      await sleep(80);
      await page.keyboard.press('ArrowLeft');
      await sleep(80);
      await page.keyboard.press('ArrowRight');
      await sleep(500);

      const arrowFramesAfterKeys = arrowFrames.length;
      console.log(`  [T-5] Arrow key frames: ${arrowFramesAfterKeys}`);

      // Part 2: DA1 regression check — inject DA1 query into live PTY
      // bash executes printf '\x1b[c', writing DA1 query to stdout
      // xterm receives it, auto-replies with \x1b[?1;2c via onData
      // The filter should catch it (on both pre-fix and post-fix code)
      console.log('  [T-5] --- DA1 regression check ---');
      const da1Cmd = "printf '\\x1b[c'\n";
      console.log(`  [T-5] Injecting DA1 trigger: ${JSON.stringify(da1Cmd)}`);
      ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: da1Cmd }));

      await sleep(3000);

      console.log(`  [T-5] DA1 leaked frames: ${da1LeakedFrames.length}`);
      console.log(`  [T-5] Total session:input frames: ${allInputFrames.length}`);

    } finally {
      await browser.close();
    }

    ws.close();

    // Assert 1: At least 4 arrow key frames captured
    expect(
      arrowFrames.length,
      `Expected >= 4 arrow key session:input frames, got ${arrowFrames.length}. ` +
      `Arrow data: ${arrowFrames.map(f => toHex(f.data)).join(', ')}`
    ).toBeGreaterThanOrEqual(4);

    // Assert 2: Zero DA1 response frames leaked
    expect(
      da1LeakedFrames.length,
      `DA1 response leaked ${da1LeakedFrames.length} time(s). ` +
      `Leaked: ${da1LeakedFrames.map(f => toHex(f.data)).join(' | ')}`
    ).toBe(0);
  });
});
