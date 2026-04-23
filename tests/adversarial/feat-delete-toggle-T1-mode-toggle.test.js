/**
 * T-1: Delete mode toggle gates Delete button rendering and persists across reload
 * Port: 3360
 * Type: Playwright browser
 *
 * Pass condition:
 *   - No Delete buttons on fresh load (delete mode off by default)
 *   - Toggle → Delete buttons appear on stopped session cards
 *   - localStorage key 'claude-delete-mode' = '1' when armed, '0' when disarmed
 *   - Toggle state survives page.reload()
 *   - Buttons are absent from DOM entirely (not CSS-hidden) when toggle is off
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3360;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let projectId = '';

test.describe('T-1 — Delete mode toggle: rendering gate + localStorage persistence', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    tmpDir = execSync('mktemp -d /tmp/qa-T1-del-toggle-XXXXXX').toString().trim();
    console.log(`\n  [T-1] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project-dir');
    fs.mkdirSync(projPath, { recursive: true });

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
    if (!ready) throw new Error('Server did not start within 20s');
    console.log(`  [T-1] Server ready`);

    // Create project via REST
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T1-project', path: projPath }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);
    console.log(`  [T-1] Project: ${projectId}`);

    // Create two sessions via WS and stop them
    for (const name of ['session-alpha', 'session-beta']) {
      const sessionId = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const timer = setTimeout(() => { ws.close(); reject(new Error(`Timeout creating session ${name}`)); }, 15000);
        ws.on('message', raw => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'init') {
            ws.send(JSON.stringify({ type: 'session:create', projectId, name, mode: 'direct', command: 'bash' }));
          }
          if (msg.type === 'session:created') {
            clearTimeout(timer);
            resolve(msg.session.id);
            ws.close();
          }
        });
        ws.on('error', reject);
      });

      // Stop it
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const timer = setTimeout(() => { ws.close(); resolve(); }, 12000);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'session:stop', id: sessionId })));
        ws.on('message', raw => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'sessions:list') {
            const s = (msg.sessions || []).find(x => x.id === sessionId);
            if (s && s.status !== 'running' && s.status !== 'starting') {
              clearTimeout(timer); ws.close(); resolve();
            }
          }
        });
        ws.on('error', () => { clearTimeout(timer); resolve(); });
      });
      console.log(`  [T-1] Created+stopped session: ${name} (${sessionId})`);
    }
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} await sleep(1000); try { serverProc.kill('SIGKILL'); } catch {} serverProc = null; }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  test('T-1: Toggle gates Delete buttons and persists across reload', async () => {
    test.setTimeout(120000);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);

      // Navigate to project
      await page.waitForSelector('text=T1-project', { timeout: 15000 });
      await page.click('text=T1-project');
      await sleep(1500);

      // Step 4: Assert — no Delete buttons on fresh load
      const deleteBtnsBefore = await page.locator('.session-card button:has-text("Delete")').count();
      console.log(`  [T-1] Delete buttons on fresh load: ${deleteBtnsBefore}`);
      expect(deleteBtnsBefore, 'Delete buttons must be absent from DOM when toggle is off').toBe(0);

      // Verify localStorage before toggle
      const lsBefore = await page.evaluate(() => localStorage.getItem('claude-delete-mode'));
      console.log(`  [T-1] localStorage before toggle: ${lsBefore}`);
      // Should be '0' or null (not '1')
      expect(lsBefore === '1', 'Delete mode should not be armed on fresh load').toBe(false);

      // Step 5: Click "Delete mode" toggle
      const toggleBtn = page.locator('button:has-text("Delete mode")');
      await toggleBtn.waitFor({ state: 'visible', timeout: 10000 });
      await toggleBtn.click();
      await sleep(800);

      // Step 6: Assert toggle has btn-danger, Delete buttons appear
      const toggleClass = await toggleBtn.getAttribute('class');
      console.log(`  [T-1] Toggle class after arming: ${toggleClass}`);
      expect(toggleClass, 'Toggle should have btn-danger when armed').toContain('btn-danger');

      const deleteBtnsAfterArm = await page.locator('.session-card button:has-text("Delete")').count();
      console.log(`  [T-1] Delete buttons after arming: ${deleteBtnsAfterArm}`);
      expect(deleteBtnsAfterArm, 'Delete buttons should appear on stopped session cards when armed').toBeGreaterThan(0);

      // Check localStorage
      const lsArmed = await page.evaluate(() => localStorage.getItem('claude-delete-mode'));
      console.log(`  [T-1] localStorage after arming: ${lsArmed}`);
      expect(lsArmed, "localStorage should be '1' when armed").toBe('1');

      // Step 7: Reload the page
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(2000);
      await page.waitForSelector('text=T1-project', { timeout: 15000 });
      await page.click('text=T1-project');
      await sleep(1500);

      // Step 8: After reload, toggle should still be armed
      const toggleAfterReload = page.locator('button:has-text("Delete mode")');
      await toggleAfterReload.waitFor({ state: 'visible', timeout: 10000 });
      const toggleClassAfterReload = await toggleAfterReload.getAttribute('class');
      console.log(`  [T-1] Toggle class after reload: ${toggleClassAfterReload}`);
      expect(toggleClassAfterReload, 'Toggle should remain armed after reload').toContain('btn-danger');

      const deleteBtnsAfterReload = await page.locator('.session-card button:has-text("Delete")').count();
      console.log(`  [T-1] Delete buttons after reload: ${deleteBtnsAfterReload}`);
      expect(deleteBtnsAfterReload, 'Delete buttons should remain visible after reload').toBeGreaterThan(0);

      // Step 9: Click toggle again to disarm
      await toggleAfterReload.click();
      await sleep(800);

      // Step 10: Delete buttons should vanish from DOM
      const deleteBtnsDisarmed = await page.locator('.session-card button:has-text("Delete")').count();
      console.log(`  [T-1] Delete buttons after disarming: ${deleteBtnsDisarmed}`);
      expect(deleteBtnsDisarmed, 'Delete buttons must be absent from DOM after disarming').toBe(0);

      const lsDisarmed = await page.evaluate(() => localStorage.getItem('claude-delete-mode'));
      console.log(`  [T-1] localStorage after disarming: ${lsDisarmed}`);
      expect(lsDisarmed, "localStorage should be '0' after disarming").toBe('0');

      // Step 11: Reload once more
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(2000);
      await page.waitForSelector('text=T1-project', { timeout: 15000 });
      await page.click('text=T1-project');
      await sleep(1500);

      // Step 12: Toggle remains disarmed
      const toggleFinal = page.locator('button:has-text("Delete mode")');
      await toggleFinal.waitFor({ state: 'visible', timeout: 10000 });
      const toggleClassFinal = await toggleFinal.getAttribute('class');
      console.log(`  [T-1] Toggle class after second reload: ${toggleClassFinal}`);
      expect(toggleClassFinal, 'Toggle should remain disarmed after second reload').not.toContain('btn-danger');

      const deleteBtnsFinal = await page.locator('.session-card button:has-text("Delete")').count();
      console.log(`  [T-1] Delete buttons after second reload: ${deleteBtnsFinal}`);
      expect(deleteBtnsFinal, 'Delete buttons must be absent from DOM after second reload').toBe(0);

      console.log('\n  [T-1] PASSED — all steps verified');

    } finally {
      await browser.close();
    }
  });
});
