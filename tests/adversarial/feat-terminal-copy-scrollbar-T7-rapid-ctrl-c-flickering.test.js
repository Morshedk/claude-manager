/**
 * T-7: Adversarial — rapid Ctrl+C with flickering selection
 * Port: 3206
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3206;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-terminal-copy-scrollbar T-7 — Rapid Ctrl+C with flickering selection', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-tcs-T7-XXXXXX').toString().trim();
    console.log(`\n  [T-7] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project-tcs7', { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-tcs-7', name: 'TCS T7 Project', path: '/tmp/test-project-tcs7' }],
      scratchpad: []
    }));

    const crashLog = path.join(tmpDir, 'crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLog },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Server failed to start within 20s');
    console.log('  [T-7] Server ready');

    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 15000);
      let capturedId = null; let resolved = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session:create',
          projectId: 'proj-tcs-7',
          name: 'tcs-t7-session',
          command: 'bash',
          mode: 'direct',
          cols: 120, rows: 30,
        }));
      });
      ws.on('message', (data) => {
        if (resolved) return;
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session:created') {
          resolved = true; clearTimeout(t); ws.close(); resolve(msg.session.id);
        } else if (msg.type === 'session:state') {
          capturedId = msg.id;
          if (msg.state === 'running') { resolved = true; clearTimeout(t); ws.close(); resolve(capturedId); }
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`  [T-7] Session created: ${sessionId}`);
    await sleep(1000);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('No crashes or unhandled errors during rapid Ctrl+C with flickering selection', async () => {
    test.setTimeout(90000);

    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const ctx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    const unhandledErrors = [];
    const consoleErrors = [];
    let toastHistoryCount = 0; // Track all toasts that ever appeared, even if expired

    page.on('pageerror', (err) => {
      unhandledErrors.push(err.message);
      console.log(`  [T-7] Page error: ${err.message}`);
    });

    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
        console.log(`  [console.error] ${msg.text()}`);
      }
      // Track toast appearances via console (inject observer logs them)
      if (msg.text().includes('[T7-TOAST]')) {
        toastHistoryCount++;
        console.log(`  [T-7] Toast detected: ${msg.text()}`);
      }
    });

    // Inject MutationObserver to track toast appearances before they expire
    await page.addInitScript(() => {
      window._toastHistory = [];
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1 && node.textContent && node.textContent.includes('Copied to clipboard')) {
              window._toastHistory.push({ text: node.textContent.trim(), time: Date.now() });
              console.log('[T7-TOAST] Copied to clipboard toast appeared');
            }
          }
        }
      });
      // Start observing after DOM is ready
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1000);

      await page.waitForFunction(() => document.body.textContent.includes('TCS T7 Project'), { timeout: 15000 });
      await page.click('text=TCS T7 Project');
      await sleep(500);

      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);

      const card = page.locator('.session-card').first();
      await card.waitFor({ state: 'visible', timeout: 15000 });
      // Click titlebar to open overlay (preview area has stopPropagation)
      const titlebar = card.locator('.session-card-titlebar');
      await titlebar.click();
      await sleep(500);

      await page.waitForSelector('#session-overlay', { timeout: 15000 });
      console.log('  [T-7] Overlay opened');

      await page.waitForSelector('.xterm', { timeout: 20000 });
      await sleep(1500);
      console.log('  [T-7] xterm visible');

      // Start continuous output (use a loop with slight pacing so selections can form)
      // 'yes' floods too fast for xterm to hold selections; use a controlled loop instead
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('WS send timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:subscribed' && msg.id === sessionId) {
            // Use a loop with tiny sleep so output is continuous but not instant-flooding
            ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'while true; do echo "line_output_stress"; sleep 0.05; done\n' }));
            setTimeout(() => { ws.close(); clearTimeout(t); resolve(); }, 800);
          }
        });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
      });

      await sleep(600);

      // Rapid sequence: select, Ctrl+C, select, Ctrl+C, select, Ctrl+C
      const xtermBox = await page.locator('.xterm').boundingBox();
      const midY = xtermBox.y + xtermBox.height * 0.5;
      const startX = xtermBox.x + 20;
      const endX = xtermBox.x + xtermBox.width * 0.6;

      console.log('  [T-7] Starting rapid Ctrl+C sequence...');

      // 3 rapid cycles of select + Ctrl+C
      // Brief pauses (80ms) between drag operations allow xterm to register the selection
      for (let i = 0; i < 3; i++) {
        // Select some text via drag
        await page.mouse.move(startX, midY);
        await page.mouse.down();
        await page.mouse.move(endX, midY, { steps: 3 });
        await page.mouse.up();
        await sleep(80); // let xterm register the selection

        // Ctrl+C while selection exists
        await page.keyboard.down('Control');
        await page.keyboard.press('c');
        await page.keyboard.up('Control');
        await sleep(50); // brief gap between cycles
      }

      await sleep(1000);
      console.log('  [T-7] Rapid sequence complete');

      // Check for at least one toast via MutationObserver history (toasts expire in 3s, may be gone)
      const toastHistory = await page.evaluate(() => window._toastHistory || []);
      const toastCount = toastHistory.length + toastHistoryCount; // combine both tracking methods
      console.log(`  [T-7] Toast count (history): ${toastCount}, history: ${JSON.stringify(toastHistory)}`);

      // Check for errors
      console.log(`  [T-7] Unhandled page errors: ${unhandledErrors.length}`);
      console.log(`  [T-7] Console errors: ${consoleErrors.length}`);
      if (unhandledErrors.length > 0) console.log(`  [T-7] Errors: ${unhandledErrors.join(', ')}`);

      // Clear any running process with plain Ctrl+C (no selection)
      await page.mouse.click(xtermBox.x + 10, xtermBox.y + 10); // focus + clear selection
      await sleep(200);
      await page.keyboard.down('Control');
      await page.keyboard.press('c');
      await page.keyboard.up('Control');
      await sleep(1500);

      // Send echo "T7_ALIVE" to verify terminal is responsive
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('WS send timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:subscribed' && msg.id === sessionId) {
            ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo "T7_ALIVE"\n' }));
            setTimeout(() => { ws.close(); clearTimeout(t); resolve(); }, 1500);
          }
        });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
      });

      await sleep(2000);

      const termTextFinal = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        return Array.from(rows).map(r => r.textContent).join('\n');
      });
      const isAlive = termTextFinal.includes('T7_ALIVE');
      console.log(`  [T-7] Terminal alive after stress: ${isAlive}`);

      // Assertions
      // 1. No clipboard/xterm errors
      const clipboardErrors = unhandledErrors.filter(e =>
        e.toLowerCase().includes('clipboard') || e.toLowerCase().includes('xterm')
      );
      const clipboardConsoleErrors = consoleErrors.filter(e =>
        e.toLowerCase().includes('clipboard') || e.toLowerCase().includes('xterm')
      );
      expect(clipboardErrors).toHaveLength(0);
      expect(clipboardConsoleErrors).toHaveLength(0);
      console.log('  [T-7] No clipboard/xterm errors: PASS');

      // 2. At least one toast appeared (copy was attempted)
      expect(toastCount).toBeGreaterThan(0);
      console.log('  [T-7] At least one toast appeared: PASS');

      // 3. Terminal is still responsive
      expect(isAlive).toBe(true);
      console.log('  [T-7] Terminal responsive after stress: PASS');

      console.log('  [T-7] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
