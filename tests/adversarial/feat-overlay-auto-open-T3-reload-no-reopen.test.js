/**
 * feat-overlay-auto-open T-3: Browser reload does NOT re-open overlay automatically
 *
 * Pass condition:
 *   - Overlay auto-opens after session create (confirms feature works)
 *   - After page.reload(), overlay is NOT visible (signal resets to null on fresh load)
 *
 * Port: 3232
 * Run: npx playwright test tests/adversarial/feat-overlay-auto-open-T3-reload-no-reopen.test.js --reporter=list --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3232;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-overlay-auto-open T-3 — Reload does not re-open overlay', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-overlay-T3-XXXXXX').toString().trim();
    console.log(`\n  [T-3] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-reload',
        name: 'ReloadTest',
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
    console.log('  [T-3] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(500); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('overlay does not reopen after page reload', async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Select project
      await page.waitForSelector('text=ReloadTest', { timeout: 10000 });
      await page.click('text=ReloadTest');
      await sleep(500);

      // Create session
      await page.waitForSelector('.btn.btn-primary.btn-sm', { timeout: 10000 });
      await page.click('.btn.btn-primary.btn-sm');
      const nameInput = page.locator('input[placeholder*="refactor"]');
      await nameInput.waitFor({ timeout: 5000 });
      await nameInput.fill('reload-test');
      await sleep(200);
      await page.click('text=Start Session');

      // Wait for overlay to appear — confirms auto-open worked (precondition for the real assertion)
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 15000 });
      console.log('  [T-3] Overlay auto-opened — precondition confirmed');

      // Reload the page
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(3000); // Wait for WS reconnect + data load

      // Overlay must NOT be visible after reload
      const overlay = await page.$('#session-overlay');
      if (overlay) {
        const vis = await overlay.isVisible();
        console.log(`  [T-3] overlay.isVisible() after reload: ${vis}`);
        expect(vis).toBe(false);
      } else {
        console.log('  [T-3] #session-overlay not in DOM after reload — correct');
      }

      console.log('  [T-3] PASS: overlay did not reopen after reload');
    } finally {
      await browser.close();
    }
  });
});
