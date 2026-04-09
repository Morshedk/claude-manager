/**
 * T-1: DA2 response leak — \x1b[>0;276;0c
 *
 * Root cause: TerminalPane.js:127 — regex [\?]? does not match >, so DA2
 * response \x1b[>0;276;0c passes through to session:input.
 *
 * Pre-fix: at least one session:input frame must contain a DA2 response.
 * Post-fix: zero session:input frames match /^\x1b\[>[;\d]*c$/.
 *
 * Trigger: After browser subscribes (TerminalPane mounted), inject DA2 query
 * into the live PTY stream via raw WS. xterm receives \x1b[>c in its live
 * stream and auto-replies with \x1b[>0;276;0c via onData.
 *
 * Run: npx playwright test --config=playwright-da-osc-filter.config.js tests/adversarial/da-osc-filter-T1-da2-leak.test.js --reporter=line
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
const PORT = 3300;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const PROJECT_ID = 'proj-t1-da2';

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

test.describe('T-1 — DA2 response leak', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-da-T1-XXXXXX').toString().trim();
    console.log(`\n  [T-1] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const seedData = {
      projects: [{
        id: PROJECT_ID,
        name: 'T1-Project',
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

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv-T1] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv-T1:ERR] ${d}`));

    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('T-1 server failed to start within 15s');
    console.log(`  [T-1] Server ready on port ${PORT}`);
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

  test('T-1 — DA2 response must be detected pre-fix, filtered post-fix', async () => {
    test.setTimeout(90000);

    // Step 1: Create session via raw WS
    const ws = await openWs(WS_URL);
    await waitForMsg(ws, m => m.type === 'init');

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: PROJECT_ID,
      name: 'da2-session',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const createdMsg = await waitForMsg(ws, m => m.type === 'session:created', 10000);
    const sessionId = createdMsg.session?.id || createdMsg.id;
    console.log(`  [T-1] Session created: ${sessionId}`);

    // Wait for running state
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

      // Intercept outgoing WS frames BEFORE navigation
      page.on('websocket', ws => {
        ws.on('framesent', frame => {
          const text = frame.payload;
          if (typeof text !== 'string') return;
          let msg;
          try { msg = JSON.parse(text); } catch { return; }
          if (msg.type === 'session:input') {
            allInputFrames.push(msg);
            // DA2 response: \x1b[> followed by digits/semicolons then c
            if (/\x1b\[>[;\d]*c/.test(msg.data)) {
              console.log(`  [T-1] LEAKED DA2 frame! hex: ${toHex(msg.data)}`);
              leakedFrames.push(msg);
            }
          }
        });
      });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      // Click project item in sidebar
      await page.click('.project-item');
      await sleep(800);

      // Click session card to open terminal overlay (mounts TerminalPane)
      await page.click('.session-card');

      // Wait for session:subscribed (terminal is now live)
      await sleep(2000);

      // Step 3: AFTER browser is subscribed, inject DA2 trigger via raw WS
      // bash executes printf '\x1b[>c', writing raw DA2 query to PTY stdout
      // xterm receives \x1b[>c in its live output stream and auto-replies via onData
      const da2Cmd = "printf '\\x1b[>c'\n";
      console.log(`  [T-1] Injecting DA2 trigger into live session: ${JSON.stringify(da2Cmd)}`);
      ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: da2Cmd }));

      // Wait for xterm to process the output and auto-reply
      await sleep(3000);

      console.log(`  [T-1] Observation complete`);
      console.log(`  [T-1] Total session:input frames: ${allInputFrames.length}`);
      console.log(`  [T-1] DA2 leaked frames: ${leakedFrames.length}`);
      for (const f of leakedFrames) {
        console.log(`    Leaked hex: ${toHex(f.data)}`);
      }

    } finally {
      await browser.close();
    }

    ws.close();

    expect(
      leakedFrames.length,
      `DA2 response leaked ${leakedFrames.length} time(s) as session:input. ` +
      `Leaked: ${leakedFrames.map(f => toHex(f.data)).join(' | ')}. ` +
      `Total session:input frames: ${allInputFrames.length}`
    ).toBe(0);
  });
});
