/**
 * T-5: Browser UI — Edit button opens modal, move session disappears from list (Story 1)
 *
 * Pass condition:
 *   - "Edit" button exists on session card (no "Open" button)
 *   - Clicking Edit opens a modal with heading "Edit Session"
 *   - Name input is pre-filled with session name
 *   - Project dropdown has "Project Alpha" selected
 *   - Selecting "Project Beta" and clicking Save moves the session
 *   - Modal closes after Save
 *   - Toast "Session updated" appears
 *   - Session card no longer visible under Project Alpha
 *   - Session card appears under Project Beta
 *
 * Port: 3404
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3404;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-move-session T-5 — Browser UI: Edit button + move session', () => {

  test.beforeAll(async () => {
    // Kill anything on the port
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-move-T5-XXXXXX').toString().trim();
    console.log(`\n  [T-5] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/project-a-t5', { recursive: true });
    fs.mkdirSync('/tmp/project-b-t5', { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [
        { id: 'proj-a', name: 'Project Alpha', path: '/tmp/project-a-t5', createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
        { id: 'proj-b', name: 'Project Beta', path: '/tmp/project-b-t5', createdAt: '2026-01-01T00:00:00.000Z', settings: {} }
      ],
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

    // Wait for server
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Server failed to start within 20s');
    console.log('  [T-5] Server ready');

    // Create the session via WS
    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout creating session')); }, 10000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-a',
            name: 'misplaced-session',
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

    console.log(`  [T-5] Session created: ${sessionId}`);
    await sleep(500); // Let UI settle
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(500); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Edit button opens modal, save moves session between projects', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Step 3: Click on "Project Alpha" in the sidebar
      await page.waitForSelector('text=Project Alpha', { timeout: 10000 });
      await page.click('text=Project Alpha');
      await sleep(1000);

      // Step 4: Wait for session card to appear
      await page.waitForSelector('.session-card', { timeout: 10000 });
      console.log('  [T-5] Session card visible under Project Alpha');

      // Step 5: Verify there is NO "Open" button on the session card
      const openButton = await page.$('.session-card button:has-text("Open")');
      expect(openButton).toBeNull();
      console.log('  [T-5] PASS: No "Open" button on session card');

      // Step 6: Click the "Edit" button on the session card
      const editButton = page.locator('.session-card button:has-text("Edit")');
      await editButton.waitFor({ state: 'visible', timeout: 5000 });
      await editButton.click();
      console.log('  [T-5] Clicked Edit button');

      // Step 7: Verify the Edit Session modal is visible
      await page.waitForSelector('text=Edit Session', { timeout: 5000 });
      console.log('  [T-5] Edit Session modal visible');

      // Step 8: Verify the name input is pre-filled
      const nameInput = page.locator('.form-input[placeholder="e.g. auth refactor"]');
      await nameInput.waitFor({ state: 'visible', timeout: 3000 });
      const nameValue = await nameInput.inputValue();
      expect(nameValue).toBe('misplaced-session');
      console.log(`  [T-5] Name pre-filled: "${nameValue}"`);

      // Step 9: Verify project dropdown has "Project Alpha" selected
      const projectSelect = page.locator('select.form-input');
      await projectSelect.waitFor({ state: 'visible', timeout: 3000 });
      const selectedValue = await projectSelect.inputValue();
      expect(selectedValue).toBe('proj-a');
      console.log('  [T-5] Project dropdown pre-selected: proj-a (Project Alpha)');

      // Step 10: Select "Project Beta" from the dropdown
      await projectSelect.selectOption('proj-b');
      await sleep(200);
      console.log('  [T-5] Selected Project Beta');

      // Step 11: Click "Save"
      const saveButton = page.locator('.btn.btn-primary:has-text("Save")');
      await saveButton.click();
      console.log('  [T-5] Clicked Save');

      // Step 12: Wait for modal to close
      await page.waitForSelector('text=Edit Session', { state: 'detached', timeout: 10000 });
      console.log('  [T-5] Modal closed');

      // Step 13: Wait for toast "Session updated"
      await page.waitForSelector('text=Session updated', { timeout: 10000 });
      console.log('  [T-5] Toast "Session updated" appeared');

      // Step 14: Verify session card is no longer visible under Project Alpha
      // We are still viewing Project Alpha — the session should have disappeared
      await sleep(500);
      const sessionCardsUnderAlpha = await page.$$('.session-card');
      // Could be 0 or the card for a different session — ours should not show misplaced-session
      const alphaHasMisplaced = false;
      for (const card of sessionCardsUnderAlpha) {
        const text = await card.textContent();
        if (text.includes('misplaced-session')) {
          throw new Error('Session card still visible under Project Alpha after move');
        }
      }
      console.log('  [T-5] Session no longer visible under Project Alpha — PASS');

      // Step 15: Click "Project Beta" in the sidebar
      await page.click('text=Project Beta');
      await sleep(1000);

      // Step 16: Verify session card appears under Project Beta
      await page.waitForSelector('.session-card', { timeout: 10000 });
      const betaCards = await page.$$('.session-card');
      let foundUnderBeta = false;
      for (const card of betaCards) {
        const text = await card.textContent();
        if (text.includes('misplaced-session')) {
          foundUnderBeta = true;
          break;
        }
      }
      expect(foundUnderBeta).toBe(true);
      console.log('  [T-5] Session visible under Project Beta — PASS');

    } finally {
      await browser.close();
    }
  });
});
