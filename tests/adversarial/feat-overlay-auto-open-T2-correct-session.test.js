/**
 * feat-overlay-auto-open T-2: Overlay shows correct session (not a different session's terminal)
 *
 * Pass condition:
 *   - First overlay shows "session-alpha"
 *   - After closing and creating "session-beta", overlay shows "session-beta", not "session-alpha"
 *
 * Port: 3231
 * Run: npx playwright test tests/adversarial/feat-overlay-auto-open-T2-correct-session.test.js --reporter=list --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3231;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-overlay-auto-open T-2 — Overlay shows correct session', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-overlay-T2-XXXXXX').toString().trim();
    console.log(`\n  [T-2] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-correct',
        name: 'CorrectSession',
        path: '/tmp',
        createdAt: '2026-01-01T00:00:00.000Z',
        settings: {}
      }],
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
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Server failed to start within 20s');
    console.log('  [T-2] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(500); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('overlay switches to new session on second create', async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Select project
      await page.waitForSelector('text=CorrectSession', { timeout: 10000 });
      await page.click('text=CorrectSession');
      await sleep(500);

      // Create first session
      await page.waitForSelector('.btn.btn-primary.btn-sm', { timeout: 10000 });
      await page.click('.btn.btn-primary.btn-sm');
      const nameInput1 = page.locator('input[placeholder*="refactor"]');
      await nameInput1.waitFor({ timeout: 5000 });
      await nameInput1.fill('session-alpha');
      await sleep(200);
      await page.click('text=Start Session');

      console.log('  [T-2] Created session-alpha, waiting for overlay...');
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 15000 });
      const title1 = await page.textContent('#overlay-title');
      console.log(`  [T-2] First overlay title: "${title1}"`);
      expect(title1).toContain('session-alpha');

      // Close overlay
      await page.click('#btn-detach');
      await page.waitForSelector('#session-overlay', { state: 'hidden', timeout: 5000 });
      console.log('  [T-2] Overlay closed');
      await sleep(500);

      // Create second session
      await page.waitForSelector('.btn.btn-primary.btn-sm', { timeout: 10000 });
      await page.click('.btn.btn-primary.btn-sm');
      const nameInput2 = page.locator('input[placeholder*="refactor"]');
      await nameInput2.waitFor({ timeout: 5000 });
      await nameInput2.fill('session-beta');
      await sleep(200);
      await page.click('text=Start Session');

      console.log('  [T-2] Created session-beta, waiting for overlay...');
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 15000 });
      const title2 = await page.textContent('#overlay-title');
      console.log(`  [T-2] Second overlay title: "${title2}"`);
      expect(title2).toContain('session-beta');
      expect(title2).not.toContain('session-alpha');

      // Verify both sessions exist on server
      const sessionsData = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
      const managed = sessionsData.managed || [];
      expect(managed.length).toBeGreaterThanOrEqual(2);
      console.log(`  [T-2] Server has ${managed.length} sessions — correct`);

      console.log('  [T-2] PASS: overlay shows correct session on second create');
    } finally {
      await browser.close();
    }
  });
});
