/**
 * T-4: Normal input still flows after fix (anti-over-filter)
 *
 * Regression guard: the fix must not block legitimate user input.
 * "echo hello" followed by Enter must produce session:input frames for each character.
 *
 * Expected to PASS on both pre-fix and post-fix code.
 *
 * Run: npx playwright test --config=playwright-da-osc-filter.config.js tests/adversarial/da-osc-filter-T4-normal-input.test.js --reporter=line
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
const PORT = 3303;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const PROJECT_ID = 'proj-t4-input';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

test.describe('T-4 — Normal input still flows (anti-over-filter)', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-da-T4-XXXXXX').toString().trim();
    console.log(`\n  [T-4] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const seedData = {
      projects: [{
        id: PROJECT_ID,
        name: 'T4-Project',
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

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv-T4] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv-T4:ERR] ${d}`));

    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('T-4 server failed to start within 15s');
    console.log(`  [T-4] Server ready on port ${PORT}`);
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

  test('T-4 — Normal keyboard input (echo hello) flows through as session:input', async () => {
    test.setTimeout(90000);

    // Create session
    const ws = await openWs(WS_URL);
    await waitForMsg(ws, m => m.type === 'init');

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: PROJECT_ID,
      name: 'input-session',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const createdMsg = await waitForMsg(ws, m => m.type === 'session:created', 10000);
    const sessionId = createdMsg.session?.id || createdMsg.id;
    console.log(`  [T-4] Session: ${sessionId}`);

    try {
      await waitForMsg(ws, m => m.type === 'session:state' && m.id === sessionId && m.state === 'running', 10000);
    } catch {}
    await sleep(1500);
    ws.close();

    const browser = await chromium.launch({ headless: true });
    let allInputFrames = [];
    let inputDataConcat = '';

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
            inputDataConcat += msg.data;
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
        console.log('  [T-4] Clicked terminal for focus');
      }
      await sleep(500);

      // Reset captured frames — only measure typing frames
      allInputFrames = [];
      inputDataConcat = '';

      console.log('  [T-4] Typing "echo hello" + Enter');
      await page.keyboard.type('echo hello');
      await page.keyboard.press('Enter');

      await sleep(3000);

      console.log(`  [T-4] Frames from typing: ${allInputFrames.length}`);
      console.log(`  [T-4] Input data: ${JSON.stringify(inputDataConcat)}`);

    } finally {
      await browser.close();
    }

    const expectedChars = ['e', 'c', 'h', 'o', ' ', 'h', 'e', 'l', 'l', 'o'];
    const missingChars = expectedChars.filter(ch => !inputDataConcat.includes(ch));
    console.log(`  [T-4] Missing chars: ${JSON.stringify(missingChars)}`);

    expect(
      allInputFrames.length,
      `Expected >= 10 session:input frames from typing "echo hello", got ${allInputFrames.length}. ` +
      `Input: ${JSON.stringify(inputDataConcat)}`
    ).toBeGreaterThanOrEqual(10);

    expect(
      missingChars.length,
      `Missing chars from "echo hello": ${JSON.stringify(missingChars)}. ` +
      `Captured: ${JSON.stringify(inputDataConcat)}`
    ).toBe(0);
  });
});
