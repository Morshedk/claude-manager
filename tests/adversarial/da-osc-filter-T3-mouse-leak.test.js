/**
 * T-3: SGR mouse event leak — \x1b[<0;col;rowM
 *
 * Root cause: TerminalPane.js:127 — regex [\?]? does not match <, so SGR mouse
 * reports pass through as session:input when SGR mouse mode is active.
 *
 * Pre-fix: at least one session:input frame must match /\x1b\[</.
 * Post-fix: zero session:input frames match /^\x1b\[<[\d;]+[Mm]$/.
 *
 * Trigger: After browser subscribes, inject SGR mouse mode enable into live PTY,
 * then move the mouse over the terminal element.
 *
 * Run: npx playwright test --config=playwright-da-osc-filter.config.js tests/adversarial/da-osc-filter-T3-mouse-leak.test.js --reporter=line
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
const PORT = 3302;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const PROJECT_ID = 'proj-t3-mouse';

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

test.describe('T-3 — SGR mouse event leak', () => {
  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-da-T3-XXXXXX').toString().trim();
    console.log(`\n  [T-3] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const seedData = {
      projects: [{
        id: PROJECT_ID,
        name: 'T3-Project',
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

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv-T3] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv-T3:ERR] ${d}`));

    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('T-3 server failed to start within 15s');
    console.log(`  [T-3] Server ready on port ${PORT}`);
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

  test('T-3 — SGR mouse events must be detected pre-fix, filtered post-fix', async () => {
    test.setTimeout(90000);

    // Step 1: Create session
    const ws = await openWs(WS_URL);
    await waitForMsg(ws, m => m.type === 'init');

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: PROJECT_ID,
      name: 'mouse-session',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const createdMsg = await waitForMsg(ws, m => m.type === 'session:created', 10000);
    const sessionId = createdMsg.session?.id || createdMsg.id;
    console.log(`  [T-3] Session created: ${sessionId}`);

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

      let outputDataConcat = '';
      page.on('websocket', ws => {
        ws.on('framesent', frame => {
          const text = frame.payload;
          if (typeof text !== 'string') return;
          let msg;
          try { msg = JSON.parse(text); } catch { return; }
          if (msg.type === 'session:input') {
            allInputFrames.push(msg);
            // SGR mouse pattern: \x1b[< followed by digits/semicolons then M or m
            if (/^\x1b\[<[\d;]+[Mm]$/.test(msg.data)) {
              console.log(`  [T-3] LEAKED mouse frame! hex: ${toHex(msg.data)}`);
              leakedFrames.push(msg);
            }
          }
        });
        ws.on('framereceived', frame => {
          const text = frame.payload;
          if (typeof text !== 'string') return;
          let msg;
          try { msg = JSON.parse(text); } catch { return; }
          if (msg.type === 'session:output' && msg.data) {
            outputDataConcat += msg.data;
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

      // Step 3a: Inject SGR mouse mode enable into live PTY via session:input
      // bash executes: printf '\x1b[?1000h\x1b[?1006h', writing raw escapes to PTY stdout
      // xterm receives them in live stream, activating SGR mouse tracking mode
      const mouseEnableCmd = "printf '\\x1b[?1000h\\x1b[?1006h'\n";
      console.log(`  [T-3] Enabling SGR mouse mode via live PTY injection`);
      ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: mouseEnableCmd }));

      // Wait for output to reach xterm
      await sleep(1500);

      // Step 3b: Also force mouse mode directly via xterm.input() API as backup
      // This ensures mouse mode is active regardless of PTY timing
      const mouseEnabled = await page.evaluate(() => {
        // Try to find the xterm terminal instance
        const xtermEl = document.querySelector('.xterm');
        if (!xtermEl) return 'no-xterm';
        // Look for the Terminal instance on any property
        const keys = Object.keys(xtermEl).filter(k => k.startsWith('_'));
        for (const k of keys) {
          const obj = xtermEl[k];
          if (obj && typeof obj.input === 'function' && typeof obj.onData === 'function') {
            // Found the terminal - inject mouse mode directly
            obj.input('\x1b[?1000h');  // VT200 button tracking
            obj.input('\x1b[?1006h');  // SGR encoding
            return 'direct-input-ok';
          }
        }
        return 'no-terminal-api';
      });
      console.log(`  [T-3] Direct mouse mode enable: ${mouseEnabled}`);

      // Step 4: Move mouse and click over terminal to generate mouse events
      // xterm listens on .xterm-screen (not .xterm-viewport)
      const terminalEl = await page.$('.xterm-screen');
      if (!terminalEl) {
        console.log('  [T-3] WARNING: .xterm-screen not found, trying .xterm');
      }
      const targetEl = terminalEl || await page.$('.xterm');
      if (targetEl) {
        const box = await targetEl.boundingBox();
        if (box) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          console.log(`  [T-3] Moving mouse over terminal (${cx}, ${cy}), box: ${JSON.stringify(box)}`);
          // Use dispatchEvent for more reliable headless mouse event delivery
          await page.evaluate(({ x, y }) => {
            const el = document.querySelector('.xterm-screen') || document.querySelector('.xterm');
            if (!el) return;
            const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 };
            el.dispatchEvent(new MouseEvent('mousemove', { ...opts, buttons: 0 }));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
          }, { x: cx, y: cy });
          await sleep(300);
          // Also use Playwright's native mouse events
          await page.mouse.move(cx, cy);
          await sleep(100);
          await page.mouse.down();
          await sleep(100);
          await page.mouse.up();
          await sleep(200);
          await page.mouse.move(cx + 15, cy + 5);
          await sleep(100);
          await page.mouse.down();
          await sleep(100);
          await page.mouse.up();
        } else {
          console.log('  [T-3] WARNING: terminal element has no bounding box');
        }
      } else {
        console.log('  [T-3] WARNING: no terminal element found, using page center');
        await page.mouse.move(640, 400);
        await page.mouse.click(640, 400);
      }

      // Collect frames for 3 seconds
      await sleep(3000);

      // Check xterm mouse mode state
      const mouseState = await page.evaluate(() => {
        const vp = document.querySelector('.xterm-viewport');
        if (!vp) return 'no-viewport';
        // Try to access xterm internal state
        const xtermEl = document.querySelector('.xterm');
        if (!xtermEl || !xtermEl._core) return 'no-_core';
        const cs = xtermEl._core.coreMouseService;
        return cs ? `protocol=${cs.activeProtocol} encoding=${cs.activeEncoding}` : 'no-mouseService';
      });
      console.log(`  [T-3] xterm mouse state: ${mouseState}`);
      console.log(`  [T-3] Output received from PTY (hex snippet): ${toHex(outputDataConcat.slice(0, 50))}`);
      console.log(`  [T-3] Output includes 1006h: ${outputDataConcat.includes('?1006h') || outputDataConcat.includes('\x1b[?1006h')}`);
      console.log(`  [T-3] Total session:input frames: ${allInputFrames.length}`);
      console.log(`  [T-3] SGR mouse leaked frames: ${leakedFrames.length}`);
      for (const f of leakedFrames) {
        console.log(`    Leaked hex: ${toHex(f.data)}`);
      }

    } finally {
      await browser.close();
    }

    ws.close();

    expect(
      leakedFrames.length,
      `SGR mouse events leaked ${leakedFrames.length} time(s) as session:input. ` +
      `Leaked: ${leakedFrames.map(f => toHex(f.data)).join(' | ')}. ` +
      `Total session:input frames: ${allInputFrames.length}`
    ).toBe(0);
  });
});
