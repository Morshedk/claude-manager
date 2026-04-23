/**
 * T-1: Ctrl+C with selection copies text, does NOT send SIGINT
 * Port: 3200
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3200;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-terminal-copy-scrollbar T-1 — Ctrl+C with selection copies, no SIGINT', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-tcs-T1-XXXXXX').toString().trim();
    console.log(`\n  [T-1] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project-tcs1', { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-tcs-1', name: 'TCS T1 Project', path: '/tmp/test-project-tcs1' }],
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
    console.log('  [T-1] Server ready');

    // Create session — resolve on session:created OR session:state running
    // (session:created may be delayed/missed due to concurrent sessions.json saves)
    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 15000);
      let capturedId = null;
      let resolved = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session:create',
          projectId: 'proj-tcs-1',
          name: 'tcs-t1-session',
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
          if (msg.state === 'running') {
            resolved = true; clearTimeout(t); ws.close(); resolve(capturedId);
          }
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`  [T-1] Session created: ${sessionId}`);
    await sleep(1000);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Ctrl+C with selection copies text and does NOT send SIGINT', async () => {
    test.setTimeout(90000);

    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    // Grant clipboard-read and clipboard-write permissions
    const ctx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
        console.log(`  [console.error] ${msg.text()}`);
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1000);

      // Navigate to project
      await page.waitForFunction(() => document.body.textContent.includes('TCS T1 Project'), { timeout: 15000 });
      await page.click('text=TCS T1 Project');
      await sleep(500);

      // Wait for sessions area to render
      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(1000);

      // Debug: dump page HTML and sessions state
      const debugInfo = await page.evaluate(() => {
        const sessionCards = document.querySelectorAll('.session-card');
        const sessionsList = document.getElementById('project-sessions-list');
        return {
          sessionCardCount: sessionCards.length,
          sessionsListContent: sessionsList ? sessionsList.innerHTML.substring(0, 500) : 'NOT FOUND',
          bodyTextSample: document.body.innerHTML.substring(2500, 5000),
        };
      });
      console.log(`  [T-1] Session card count: ${debugInfo.sessionCardCount}`);
      console.log(`  [T-1] Sessions list: ${debugInfo.sessionsListContent}`);
      console.log(`  [T-1] Body HTML 2500-5000: ${debugInfo.bodyTextSample}`);

      // Click session card titlebar (not the preview area which stops propagation)
      // to open overlay — clicking the card name link calls attachSession()
      const card = page.locator('.session-card').first();
      await card.waitFor({ state: 'visible', timeout: 15000 });
      // Click the titlebar to avoid hitting the preview area (which has stopPropagation)
      const titlebar = card.locator('.session-card-titlebar');
      await titlebar.click();
      await sleep(1000);

      // Debug: check if overlay appeared and what state the app is in
      const overlayCount = await page.locator('#session-overlay').count();
      console.log(`  [T-1] Overlay count after click: ${overlayCount}`);

      // Check sessions state more directly
      const appState = await page.evaluate(() => {
        // Check if any session-overlay-like element exists
        const all = document.querySelectorAll('[id]');
        const ids = Array.from(all).map(el => el.id).filter(id => id);
        // Check body classes
        return {
          bodyClasses: document.body.className,
          allIds: ids.join(','),
          sessionCardCount: document.querySelectorAll('.session-card').length,
        };
      });
      console.log(`  [T-1] Body classes: ${appState.bodyClasses}`);
      console.log(`  [T-1] All IDs: ${appState.allIds}`);
      console.log(`  [T-1] Card count now: ${appState.sessionCardCount}`);

      // Wait for overlay
      await page.waitForSelector('#session-overlay', { timeout: 15000 });
      console.log('  [T-1] Overlay opened');

      // Wait for xterm to render
      await page.waitForSelector('.xterm', { timeout: 20000 });
      await sleep(1500);
      console.log('  [T-1] xterm visible');

      // Send echo command via WS to produce known output
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('WS send timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:subscribed' && msg.id === sessionId) {
            ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo "COPY_TARGET_abc123"\n' }));
            setTimeout(() => { ws.close(); clearTimeout(t); resolve(); }, 1500);
          }
        });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
      });

      await sleep(2500);

      // Check terminal has output
      const termText = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        return Array.from(rows).map(r => r.textContent).join('\n');
      });
      console.log(`  [T-1] Terminal contains COPY_TARGET: ${termText.includes('COPY_TARGET_abc123')}`);

      if (!termText.includes('COPY_TARGET_abc123')) {
        console.log(`  [T-1] Terminal text sample: ${termText.substring(0, 300)}`);
        throw new Error('COPY_TARGET_abc123 not found in terminal output');
      }

      // Find the row containing the target text and drag-select it
      const rowInfo = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].textContent.includes('COPY_TARGET_abc123')) {
            const rect = rows[i].getBoundingClientRect();
            return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          }
        }
        return null;
      });

      if (!rowInfo) throw new Error('Could not find row with COPY_TARGET_abc123 for mouse drag');
      console.log(`  [T-1] Found target row at: ${JSON.stringify(rowInfo)}`);

      // Mouse drag to select text in the row
      await page.mouse.move(rowInfo.left + 5, rowInfo.top + rowInfo.height / 2);
      await page.mouse.down();
      await page.mouse.move(rowInfo.left + rowInfo.width * 0.85, rowInfo.top + rowInfo.height / 2, { steps: 10 });
      await page.mouse.up();
      await sleep(500);

      // Now press Ctrl+C while selection exists
      await page.keyboard.down('Control');
      await page.keyboard.press('c');
      await page.keyboard.up('Control');
      await sleep(1000);

      // Check for copy toast (toasts are plain divs with inline styles, no CSS class)
      const toastEl = page.locator('div').filter({ hasText: /Copied to clipboard/i });
      const toastCount = await toastEl.count();
      console.log(`  [T-1] Toast count: ${toastCount}`);

      // Check clipboard
      let clipboardText = '';
      try {
        clipboardText = await page.evaluate(() => navigator.clipboard.readText());
        console.log(`  [T-1] Clipboard text: "${clipboardText}"`);
      } catch (e) {
        console.log(`  [T-1] Clipboard read error: ${e.message}`);
      }

      // Check terminal output for ^C (SIGINT marker) AFTER the copy
      await sleep(500);
      const termTextAfter = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        return Array.from(rows).map(r => r.textContent).join('\n');
      });
      const hasSIGINT = termTextAfter.includes('^C');
      console.log(`  [T-1] Terminal has ^C: ${hasSIGINT}`);

      // Assertions
      expect(clipboardText).toContain('COPY_TARGET_abc123');
      expect(hasSIGINT).toBe(false);
      expect(toastCount).toBeGreaterThan(0);

      console.log('  [T-1] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
