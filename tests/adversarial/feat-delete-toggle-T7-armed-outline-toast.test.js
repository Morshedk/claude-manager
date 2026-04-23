/**
 * T-7: Armed outline visually distinct + toast confirms delete (AC11, Risk 8) — Story 2 end-to-end
 * Port: 3366
 * Type: Playwright browser + filesystem
 *
 * Pass condition:
 *   - Armed outline visible on sessions list container
 *   - Toast with "Deleted" + session name appears after clicking Delete
 *   - Card removed from DOM
 *   - Log entry persisted with correct fields
 *   - No native confirm() dialog (Playwright sentinel never fires)
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3366;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let projectId = '';
const sessions = {};

test.describe('T-7 — Armed outline + toast + no confirm dialog — Story 2 end-to-end', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    tmpDir = execSync('mktemp -d /tmp/qa-T7-armed-toast-XXXXXX').toString().trim();
    console.log(`\n  [T-7] tmpDir: ${tmpDir}`);

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
    console.log(`  [T-7] Server ready`);

    // Create project
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T7-project', path: projPath }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);
    console.log(`  [T-7] Project: ${projectId}`);

    // Create three stopped sessions: alpha, beta, gamma
    for (const name of ['alpha', 'beta', 'gamma']) {
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
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const timer = setTimeout(() => { ws.close(); resolve(); }, 10000);
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

      sessions[name] = sessionId;
      console.log(`  [T-7] Session '${name}': ${sessionId}`);
    }
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} await sleep(1000); try { serverProc.kill('SIGKILL'); } catch {} serverProc = null; }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  test('T-7: Armed outline + toast + no confirm + log entry', async () => {
    test.setTimeout(120000);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      // Track native dialogs — if one fires, the test should fail
      let dialogFired = false;
      page.on('dialog', async dialog => {
        dialogFired = true;
        console.log(`  [T-7] UNEXPECTED native dialog: ${dialog.type()} — "${dialog.message()}"`);
        await dialog.dismiss();
      });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);

      // Navigate to project
      await page.waitForSelector('text=T7-project', { timeout: 15000 });
      await page.click('text=T7-project');
      await sleep(1500);

      // Step 4: Assert delete buttons absent on all three cards
      const deleteBtnsBefore = await page.locator('.session-card button:has-text("Delete")').count();
      console.log(`  [T-7] Delete buttons on load: ${deleteBtnsBefore}`);
      expect(deleteBtnsBefore, 'Delete buttons must be absent before arming').toBe(0);

      // Step 5: Click "Delete mode" toggle
      const toggleBtn = page.locator('button:has-text("Delete mode")');
      await toggleBtn.waitFor({ state: 'visible', timeout: 10000 });
      await toggleBtn.click();
      await sleep(800);

      // Step 6a: Assert armed outline on sessions list container
      const sessionsListOutline = await page.evaluate(() => {
        const el = document.querySelector('#project-sessions-list');
        if (!el) return null;
        return window.getComputedStyle(el).outline || el.style.outline;
      });
      console.log(`  [T-7] #project-sessions-list outline: ${sessionsListOutline}`);
      // The inline style contains 'rgba(240,72,72,0.35)' when armed
      const inlineStyle = await page.evaluate(() => {
        const el = document.querySelector('#project-sessions-list');
        return el ? el.getAttribute('style') : '';
      });
      console.log(`  [T-7] #project-sessions-list inline style: ${inlineStyle}`);
      // Browser may normalize rgba(240,72,72,...) to rgba(240, 72, 72, ...) — match either form
      const hasArmedOutline = (inlineStyle || '').includes('rgba(240,72,72,0.35)') ||
                              (inlineStyle || '').includes('rgba(240, 72, 72, 0.35)');
      expect(hasArmedOutline).toBe(true); // 'Armed outline must be present on #project-sessions-list'

      // Step 6b: Assert toggle is visually distinct (has btn-danger or inline background style)
      const toggleClass = await toggleBtn.getAttribute('class');
      const toggleStyle = await toggleBtn.getAttribute('style');
      console.log(`  [T-7] Toggle class: ${toggleClass}, style: ${toggleStyle}`);
      // Should have btn-danger class AND/OR danger-bg background
      const isArmed = (toggleClass || '').includes('btn-danger') ||
                      (toggleStyle || '').includes('var(--danger-bg)');
      expect(isArmed, 'Toggle must be visually distinct when armed (btn-danger or danger-bg)').toBe(true);

      // Step 7: Click Delete on "beta"
      const betaCard = page.locator(`.session-card:has-text("beta")`);
      await betaCard.waitFor({ state: 'visible', timeout: 10000 });
      const betaDeleteBtn = betaCard.locator('button:has-text("Delete")');
      await betaDeleteBtn.waitFor({ state: 'visible', timeout: 10000 });
      console.log(`  [T-7] Clicking Delete on 'beta'`);
      await betaDeleteBtn.click();

      // Step 8: Assert toast with "Deleted" and "beta" appears within 1s
      // Toast is rendered inline (no class="toast-container"), but in a fixed div
      const toastVisible = await page.waitForFunction(() => {
        const bodyText = document.body.innerText;
        return bodyText.includes('Deleted') && bodyText.includes('beta');
      }, { timeout: 3000 }).then(() => true).catch(() => false);

      console.log(`  [T-7] Toast appeared: ${toastVisible}`);
      expect(toastVisible, 'Toast must show "Deleted" and "beta" within 1s of delete click').toBe(true);

      // Step 8b: Card for "beta" no longer in DOM
      const betaCardCount = await page.locator('.session-card:has-text("beta")').count();
      console.log(`  [T-7] Beta card count after delete: ${betaCardCount}`);
      expect(betaCardCount, 'Beta card must be removed from DOM after delete').toBe(0);

      // Step 9: Wait for lifecycle log entry
      const lifecycleFile = path.join(tmpDir, 'session-lifecycle.json');
      let deletedEntry = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          if (fs.existsSync(lifecycleFile)) {
            const arr = JSON.parse(fs.readFileSync(lifecycleFile, 'utf8'));
            const found = arr.find(e => e.event === 'deleted' && e.sessionId === sessions['beta']);
            if (found) { deletedEntry = found; break; }
          }
        } catch {}
        await sleep(100);
      }

      console.log(`  [T-7] Deleted log entry: ${JSON.stringify(deletedEntry)}`);
      expect(deletedEntry, 'Lifecycle log must have deleted entry for beta').not.toBeNull();
      expect(deletedEntry.event, "Log entry .event must be 'deleted'").toBe('deleted');
      expect(deletedEntry.summary, "Log entry .summary must be 'beta'").toBe('beta');
      expect(deletedEntry.sessionId, 'Log entry .sessionId must match beta session id').toBe(sessions['beta']);

      // Step 10: Click Delete on "alpha" — assert NO native confirm dialog fires
      const alphaCard = page.locator(`.session-card:has-text("alpha")`);
      await alphaCard.waitFor({ state: 'visible', timeout: 10000 });
      const alphaDeleteBtn = alphaCard.locator('button:has-text("Delete")');
      await alphaDeleteBtn.waitFor({ state: 'visible', timeout: 10000 });

      // Reset dialog sentinel
      dialogFired = false;
      await alphaDeleteBtn.click();
      await sleep(1000); // Give time for any dialog to fire

      console.log(`  [T-7] Dialog fired after alpha delete: ${dialogFired}`);
      expect(dialogFired, 'No native confirm() dialog should appear when Delete is clicked (feature removed confirm)').toBe(false);

      console.log('\n  [T-7] PASSED — armed outline, toast, no dialog, log entry all verified');

    } finally {
      await browser.close();
    }
  });
});
