/**
 * T-2: OSC color query response leak — \x1b]10;rgb:...\x07
 *
 * Root cause: TerminalPane.js:127 — no OSC filter exists. The regex only
 * handles CSI sequences (\x1b[), so OSC responses (\x1b]...) pass through entirely.
 *
 * Pre-fix: at least one session:input frame must start with \x1b].
 * Post-fix: zero session:input frames match /^\x1b\]/.
 *
 * Trigger: After browser subscribes, inject OSC color queries into live PTY stream.
 * xterm receives them, auto-replies with color values via onData.
 *
 * Run: npx playwright test --config=playwright-da-osc-filter.config.js tests/adversarial/da-osc-filter-T2-osc-leak.test.js --reporter=line
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
const PORT = 3301;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const PROJECT_ID = 'proj-t2-osc';

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

test.describe('T-2 — OSC color query response leak', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-da-T2-XXXXXX').toString().trim();
    console.log(`\n  [T-2] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const seedData = {
      projects: [{
        id: PROJECT_ID,
        name: 'T2-Project',
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

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv-T2] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv-T2:ERR] ${d}`));

    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('T-2 server failed to start within 15s');
    console.log(`  [T-2] Server ready on port ${PORT}`);
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

  test('T-2 — OSC response must be detected pre-fix, filtered post-fix', async () => {
    test.setTimeout(90000);

    // Step 1: Create session
    const ws = await openWs(WS_URL);
    await waitForMsg(ws, m => m.type === 'init');

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: PROJECT_ID,
      name: 'osc-session',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const createdMsg = await waitForMsg(ws, m => m.type === 'session:created', 10000);
    const sessionId = createdMsg.session?.id || createdMsg.id;
    console.log(`  [T-2] Session created: ${sessionId}`);

    try {
      await waitForMsg(ws, m => m.type === 'session:state' && m.id === sessionId && m.state === 'running', 10000);
    } catch {}
    await sleep(1500);

    // Step 2: Open browser with WS interceptor
    const browser = await chromium.launch({ headless: true });
    let leakedFrames = [];
    let allInputFrames = [];

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
            // OSC response: starts with \x1b]
            if (/^\x1b\]/.test(msg.data)) {
              console.log(`  [T-2] LEAKED OSC frame! hex: ${toHex(msg.data)}`);
              leakedFrames.push(msg);
            }
          }
        });
      });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      await page.click('.project-item');
      await sleep(800);

      await page.click('.session-card');

      // Wait for terminal to mount and subscribe
      await sleep(2000);

      // Step 3: AFTER browser subscribes, inject OSC color queries into live PTY
      // bash executes: printf '\x1b]10;?\x07' && printf '\x1b]11;?\x07'
      // xterm receives OSC queries in live stream and auto-replies via onData
      const oscCmd = "printf '\\x1b]10;?\\x07' && printf '\\x1b]11;?\\x07'\n";
      console.log(`  [T-2] Injecting OSC trigger into live session`);
      ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: oscCmd }));

      // Wait for xterm to process and auto-reply
      await sleep(3000);

      console.log(`  [T-2] Total session:input frames: ${allInputFrames.length}`);
      console.log(`  [T-2] OSC leaked frames: ${leakedFrames.length}`);
      for (const f of leakedFrames) {
        console.log(`    Leaked hex: ${toHex(f.data)}`);
      }

    } finally {
      await browser.close();
    }

    ws.close();

    expect(
      leakedFrames.length,
      `OSC response leaked ${leakedFrames.length} time(s) as session:input. ` +
      `Leaked: ${leakedFrames.map(f => toHex(f.data)).join(' | ')}. ` +
      `Total session:input frames: ${allInputFrames.length}`
    ).toBe(0);
  });
});
