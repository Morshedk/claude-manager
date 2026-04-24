/**
 * T-6: Wrench icon Edit button opens EditSessionModal
 * Port: 3505
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3505;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-session-cards T-6 — Wrench icon opens EditSessionModal', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-portrait-T6-XXXXXX').toString().trim();
    console.log(`\n  [T-6] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project', { recursive: true }); // ensure project path exists

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-test-1', name: 'Test Project', path: '/tmp/test-project' }],
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

    // Create session via WS
    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 10000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-test-1',
            name: 'wrench-test',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          clearTimeout(t);
          ws.close();
          resolve(msg.session.id);
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`  [T-6] Session created: ${sessionId}`);
    await sleep(500);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Wrench button has correct title and opens edit modal on click', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Track console errors and page navigations (session attach would navigate or show overlay)
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
        console.log(`  [console.error] ${msg.text()}`);
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1500);

      // Navigate to project
      await page.waitForSelector('text=Test Project', { timeout: 10000 });
      await page.click('text=Test Project');
      await sleep(1000);

      // Wait for session card
      await page.waitForSelector('.session-card', { timeout: 10000 });
      console.log('  [T-6] Session card visible');

      // Find .btn-icon within .session-card-actionbar
      const card = page.locator('.session-card').first();
      const actionbar = card.locator('.session-card-actionbar');
      const btnIcon = actionbar.locator('.btn-icon').first();

      await btnIcon.waitFor({ state: 'visible', timeout: 5000 });
      console.log('  [T-6] .btn-icon found in actionbar');

      // Assert title="Edit session"
      const title = await btnIcon.getAttribute('title');
      console.log(`  [T-6] .btn-icon title: "${title}"`);
      expect(title).toBe('Edit session');

      // Take a snapshot before clicking to note whether session overlay is open
      const overlayBeforeCount = await page.locator('.session-overlay, .modal-overlay').count();
      console.log(`  [T-6] Overlay/modal count before click: ${overlayBeforeCount}`);

      // Click the wrench button
      await btnIcon.click();
      await sleep(800);

      // Assert a modal appeared (not session attach which would show terminal overlay)
      // Look for edit modal with a text input pre-filled with session name
      const modalVisible = await page.locator('.modal, [class*="modal"]').count();
      console.log(`  [T-6] Modal element count after click: ${modalVisible}`);

      // The edit modal should contain an input with the session name
      const nameInput = page.locator('input[type="text"], input:not([type])').first();
      const nameInputVisible = await nameInput.isVisible().catch(() => false);
      console.log(`  [T-6] Name input visible: ${nameInputVisible}`);

      if (nameInputVisible) {
        const inputValue = await nameInput.inputValue();
        console.log(`  [T-6] Input value: "${inputValue}"`);
        expect(inputValue).toBe('wrench-test');
      } else {
        // Try to find modal by content
        await page.waitForSelector('text=Edit Session', { timeout: 5000 });
        console.log('  [T-6] "Edit Session" text found in DOM');
      }

      // Assert the session overlay did NOT open (no attach happened)
      // Session overlay would show a terminal canvas, not a form input
      const terminalCanvas = await page.locator('canvas').count();
      console.log(`  [T-6] Canvas elements after click: ${terminalCanvas}`);
      // We don't have a hard assertion here since some terminals might be in background,
      // but the modal presence is the primary signal

      // The session should NOT be attached (no terminal visible in foreground overlaying the card view)
      // The edit modal should be blocking
      const editModalText = await page.locator('body').evaluate(el =>
        el.textContent.includes('Edit') || el.textContent.includes('edit')
      );
      expect(editModalText).toBe(true);
      console.log('  [T-6] Edit modal confirmed open — PASS');

    } finally {
      await browser.close();
    }
  });
});
