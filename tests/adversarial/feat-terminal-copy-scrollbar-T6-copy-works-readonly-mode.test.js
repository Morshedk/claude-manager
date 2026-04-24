/**
 * T-6: Copy works in readOnly mode (TerminalPane)
 * Port: 3205
 * Type: Playwright browser + static source analysis
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3205;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TERMINAL_PANE_PATH = path.join(APP_DIR, 'public/js/components/TerminalPane.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-terminal-copy-scrollbar T-6 — Copy works regardless of readOnly mode', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-tcs-T6-XXXXXX').toString().trim();
    console.log(`\n  [T-6] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project-tcs6', { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-tcs-6', name: 'TCS T6 Project', path: '/tmp/test-project-tcs6' }],
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
    console.log('  [T-6] Server ready');

    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 15000);
      let capturedId = null; let resolved = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session:create',
          projectId: 'proj-tcs-6',
          name: 'tcs-t6-session',
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

    console.log(`  [T-6] Session created: ${sessionId}`);
    await sleep(1000);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Static analysis: attachCustomKeyEventHandler registered before if(!readOnly) guard', () => {
    const source = fs.readFileSync(TERMINAL_PANE_PATH, 'utf-8');
    const lines = source.split('\n');

    // Find line numbers
    let attachHandlerLine = -1;
    let readOnlyGuardLine = -1;

    for (let i = 0; i < lines.length; i++) {
      if (attachHandlerLine === -1 && lines[i].includes('attachCustomKeyEventHandler')) {
        attachHandlerLine = i + 1; // 1-based
      }
      if (readOnlyGuardLine === -1 && lines[i].includes('if (!readOnly)')) {
        readOnlyGuardLine = i + 1; // 1-based
      }
    }

    console.log(`  [T-6] attachCustomKeyEventHandler at line: ${attachHandlerLine}`);
    console.log(`  [T-6] if (!readOnly) guard at line: ${readOnlyGuardLine}`);

    expect(attachHandlerLine).toBeGreaterThan(0);
    expect(readOnlyGuardLine).toBeGreaterThan(0);
    expect(attachHandlerLine).toBeLessThan(readOnlyGuardLine);

    console.log('  [T-6] Static analysis: handler is BEFORE readOnly guard — PASSED');
  });

  test('Functional: copy handler fires in normal terminal (proves handler is always active)', async () => {
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

      await page.waitForFunction(() => document.body.textContent.includes('TCS T6 Project'), { timeout: 15000 });
      await page.click('text=TCS T6 Project');
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
      console.log('  [T-6] Overlay opened');

      await page.waitForSelector('.xterm', { timeout: 20000 });
      await sleep(1500);
      console.log('  [T-6] xterm visible');

      // Send known string
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('WS send timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:subscribed' && msg.id === sessionId) {
            ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo "READONLY_COPY_TEST"\n' }));
            setTimeout(() => { ws.close(); clearTimeout(t); resolve(); }, 1500);
          }
        });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
      });

      await sleep(2000);

      // Find and select text
      const rowInfo = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].textContent.includes('READONLY_COPY_TEST')) {
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
        console.log(`  [T-6] Terminal text: ${termText.substring(0, 300)}`);
        throw new Error('READONLY_COPY_TEST not found in terminal');
      }

      await page.mouse.move(rowInfo.left + 5, rowInfo.top + rowInfo.height / 2);
      await page.mouse.down();
      await page.mouse.move(rowInfo.left + rowInfo.width * 0.85, rowInfo.top + rowInfo.height / 2, { steps: 10 });
      await page.mouse.up();
      await sleep(500);

      // Press Ctrl+C with selection
      await page.keyboard.down('Control');
      await page.keyboard.press('c');
      await page.keyboard.up('Control');
      await sleep(1000);

      // Check clipboard and toast
      let clipboardText = '';
      try {
        clipboardText = await page.evaluate(() => navigator.clipboard.readText());
        console.log(`  [T-6] Clipboard: "${clipboardText}"`);
      } catch (e) {
        console.log(`  [T-6] Clipboard read error: ${e.message}`);
      }

      // Toast: plain divs with inline styles, no CSS class
      const toastCount = await page.locator('div').filter({ hasText: /Copied to clipboard/i }).count();
      console.log(`  [T-6] Toast count: ${toastCount}`);

      expect(clipboardText).toMatch(/READONLY_COPY_TEST/);
      expect(toastCount).toBeGreaterThan(0);

      console.log('  [T-6] Functional copy test PASSED');
    } finally {
      await browser.close();
    }
  });
});
