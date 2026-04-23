/**
 * T-2: Ctrl+C with NO selection sends SIGINT (does not copy)
 * Port: 3201
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3201;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-terminal-copy-scrollbar T-2 — Ctrl+C no selection sends SIGINT', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-tcs-T2-XXXXXX').toString().trim();
    console.log(`\n  [T-2] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project-tcs2', { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-tcs-2', name: 'TCS T2 Project', path: '/tmp/test-project-tcs2' }],
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
    console.log('  [T-2] Server ready');

    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 15000);
      let capturedId = null; let resolved = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session:create',
          projectId: 'proj-tcs-2',
          name: 'tcs-t2-session',
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

    console.log(`  [T-2] Session created: ${sessionId}`);
    await sleep(1000);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Ctrl+C with no selection sends SIGINT — no copy toast', async () => {
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

      await page.waitForFunction(() => document.body.textContent.includes('TCS T2 Project'), { timeout: 15000 });
      await page.click('text=TCS T2 Project');
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
      console.log('  [T-2] Overlay opened');

      await page.waitForSelector('.xterm', { timeout: 20000 });
      await sleep(1500);
      console.log('  [T-2] xterm visible');

      // Start sleep 30 via WS
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

      // Ensure no text is selected — click a spot with no text to clear selection
      const xtermBox = await page.locator('.xterm').boundingBox();
      // Click in the xterm to ensure focus (and clear selection)
      await page.mouse.click(xtermBox.x + 10, xtermBox.y + 10);
      await sleep(300);

      // Verify no selection
      const selBefore = await page.evaluate(() => window.getSelection()?.toString() || '');
      console.log(`  [T-2] Selection before Ctrl+C: "${selBefore}"`);

      // Press Ctrl+C with NO selection
      await page.keyboard.down('Control');
      await page.keyboard.press('c');
      await page.keyboard.up('Control');
      await sleep(2000);

      // Check terminal for ^C (SIGINT)
      const termText = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        return Array.from(rows).map(r => r.textContent).join('\n');
      });
      console.log(`  [T-2] Terminal text after Ctrl+C: ${termText.substring(0, 300)}`);
      const hasSIGINT = termText.includes('^C');
      console.log(`  [T-2] Has ^C (SIGINT): ${hasSIGINT}`);

      // Check no copy toast appeared (toasts are plain divs with inline styles, no CSS class)
      const toastEl = page.locator('div').filter({ hasText: /Copied to clipboard/i });
      const toastCount = await toastEl.count();
      console.log(`  [T-2] Copy toast count: ${toastCount}`);

      // Verify shell is responsive: send echo STILL_ALIVE
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('WS echo timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:subscribed' && msg.id === sessionId) {
            ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo "STILL_ALIVE"\n' }));
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
      console.log(`  [T-2] Terminal text with STILL_ALIVE: ${termTextFinal.substring(0, 400)}`);
      const hasStillAlive = termTextFinal.includes('STILL_ALIVE');
      console.log(`  [T-2] Shell responsive (STILL_ALIVE): ${hasStillAlive}`);

      // Assertions
      expect(hasSIGINT).toBe(true);
      expect(toastCount).toBe(0);
      expect(hasStillAlive).toBe(true);

      console.log('  [T-2] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
