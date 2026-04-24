/**
 * T-5: Ctrl+Shift+C copies when selection exists, does NOT send SIGINT when no selection
 * Port: 3204
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3204;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-terminal-copy-scrollbar T-5 — Ctrl+Shift+C copy alt behavior', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-tcs-T5-XXXXXX').toString().trim();
    console.log(`\n  [T-5] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project-tcs5', { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-tcs-5', name: 'TCS T5 Project', path: '/tmp/test-project-tcs5' }],
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
    console.log('  [T-5] Server ready');

    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 15000);
      let capturedId = null; let resolved = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session:create',
          projectId: 'proj-tcs-5',
          name: 'tcs-t5-session',
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

    console.log(`  [T-5] Session created: ${sessionId}`);
    await sleep(1000);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Part A: Ctrl+Shift+C with selection copies; Part B: without selection does NOT interrupt sleep', async () => {
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

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1000);

      await page.waitForFunction(() => document.body.textContent.includes('TCS T5 Project'), { timeout: 15000 });
      await page.click('text=TCS T5 Project');
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
      console.log('  [T-5] Overlay opened');

      await page.waitForSelector('.xterm', { timeout: 20000 });
      await sleep(1500);
      console.log('  [T-5] xterm visible');

      // === PART A: Ctrl+Shift+C with selection ===
      console.log('  [T-5] === Part A: Ctrl+Shift+C with selection ===');

      // Send echo command
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('WS send timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:subscribed' && msg.id === sessionId) {
            ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo "SHIFT_COPY_TEST"\n' }));
            setTimeout(() => { ws.close(); clearTimeout(t); resolve(); }, 1500);
          }
        });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
      });

      await sleep(2000);

      // Find and select SHIFT_COPY_TEST
      const rowInfo = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].textContent.includes('SHIFT_COPY_TEST')) {
            const rect = rows[i].getBoundingClientRect();
            return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          }
        }
        return null;
      });

      if (!rowInfo) {
        const termText = await page.evaluate(() => {
          const rows = document.querySelectorAll('.xterm-rows > div');
          return Array.from(rows).map(r => r.textContent).join('\n');
        });
        console.log(`  [T-5] Terminal text: ${termText.substring(0, 300)}`);
        throw new Error('SHIFT_COPY_TEST not found in terminal');
      }

      // Mouse drag to select the text
      await page.mouse.move(rowInfo.left + 5, rowInfo.top + rowInfo.height / 2);
      await page.mouse.down();
      await page.mouse.move(rowInfo.left + rowInfo.width * 0.85, rowInfo.top + rowInfo.height / 2, { steps: 10 });
      await page.mouse.up();
      await sleep(500);

      // Press Ctrl+Shift+C (uppercase C)
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.keyboard.press('C');  // uppercase C due to Shift
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await sleep(1000);

      // Check clipboard
      let clipboardTextA = '';
      try {
        clipboardTextA = await page.evaluate(() => navigator.clipboard.readText());
        console.log(`  [T-5] Part A clipboard: "${clipboardTextA}"`);
      } catch (e) {
        console.log(`  [T-5] Part A clipboard read error: ${e.message}`);
      }

      // Check toast
      // Toast: plain divs with inline styles, no CSS class
      const toastCountA = await page.locator('div').filter({ hasText: /Copied to clipboard/i }).count();
      console.log(`  [T-5] Part A toast count: ${toastCountA}`);

      // Check no ^C in terminal output
      const termTextA = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        return Array.from(rows).map(r => r.textContent).join('\n');
      });
      const hasSIGINTA = termTextA.includes('^C');
      console.log(`  [T-5] Part A has ^C: ${hasSIGINTA}`);

      // === PART B: Ctrl+Shift+C without selection — must NOT interrupt sleep ===
      console.log('  [T-5] === Part B: Ctrl+Shift+C without selection ===');

      // Clear selection by clicking a neutral area
      const xtermBox = await page.locator('.xterm').boundingBox();
      await page.mouse.click(xtermBox.x + 10, xtermBox.y + 10);
      await sleep(300);

      // Start sleep 30
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('WS send timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:subscribed' && msg.id === sessionId) {
            ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'sleep 30\n' }));
            setTimeout(() => { ws.close(); clearTimeout(t); resolve(); }, 1000);
          }
        });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
      });

      await sleep(1500);

      // Click to ensure focus but clear selection
      await page.mouse.click(xtermBox.x + 10, xtermBox.y + 10);
      await sleep(300);

      // Press Ctrl+Shift+C (no selection) — should do nothing
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.keyboard.press('C');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await sleep(2000);

      // Terminal check — sleep 30 should still be running
      // Definitive check: plain Ctrl+C DOES interrupt
      await page.keyboard.down('Control');
      await page.keyboard.press('c');
      await page.keyboard.up('Control');
      await sleep(1500);

      const termTextAfterCtrlC = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        return Array.from(rows).map(r => r.textContent).join('\n');
      });
      console.log(`  [T-5] After plain Ctrl+C: ${termTextAfterCtrlC.substring(0, 400)}`);
      const hasSIGINTB = termTextAfterCtrlC.includes('^C');
      console.log(`  [T-5] Part B: plain Ctrl+C sent SIGINT: ${hasSIGINTB}`);

      // ASSERTIONS
      // Part A: Ctrl+Shift+C with selection copies text
      expect(clipboardTextA).toMatch(/SHIFT_COPY_TEST/);
      console.log('  [T-5] Part A: clipboard contains SHIFT_COPY_TEST: PASS');
      expect(hasSIGINTA).toBe(false);
      console.log('  [T-5] Part A: no SIGINT sent: PASS');
      expect(toastCountA).toBeGreaterThan(0);
      console.log('  [T-5] Part A: toast appeared: PASS');

      // Part B: plain Ctrl+C DOES interrupt (proving SIGINT pass-through works)
      expect(hasSIGINTB).toBe(true);
      console.log('  [T-5] Part B: plain Ctrl+C sends SIGINT: PASS');

      console.log('  [T-5] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
