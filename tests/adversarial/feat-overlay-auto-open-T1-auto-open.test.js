/**
 * feat-overlay-auto-open T-1: Overlay opens automatically after Start Session — no card click
 *
 * Pass condition:
 *   - #session-overlay becomes visible without clicking any session card
 *   - #overlay-title contains "auto-open-test"
 *   - Pre-condition: overlay was NOT visible before create action
 *
 * Port: 3230
 * Run: npx playwright test tests/adversarial/feat-overlay-auto-open-T1-auto-open.test.js --reporter=list --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3230;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-overlay-auto-open T-1 — Overlay opens automatically', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-overlay-T1-XXXXXX').toString().trim();
    console.log(`\n  [T-1] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-autoopen',
        name: 'AutoTest',
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
    console.log('  [T-1] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(500); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('overlay auto-opens after Start Session without card click', async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // PRE-CONDITION: overlay must NOT be visible before create
      const overlayBefore = await page.$('#session-overlay');
      if (overlayBefore) {
        const vis = await overlayBefore.isVisible();
        expect(vis).toBe(false);
      }
      console.log('  [T-1] Pre-condition: overlay not visible — OK');

      // Select project
      await page.waitForSelector('text=AutoTest', { timeout: 10000 });
      await page.click('text=AutoTest');
      await sleep(500);

      // Open modal
      await page.waitForSelector('.btn.btn-primary.btn-sm', { timeout: 10000 });
      await page.click('.btn.btn-primary.btn-sm');
      await sleep(500);

      // Fill session name (required)
      const nameInput = page.locator('input[placeholder*="refactor"]');
      await nameInput.waitFor({ timeout: 5000 });
      await nameInput.fill('auto-open-test');
      await sleep(200);

      // Click Start Session — do NOT click any session card after this
      await page.click('text=Start Session');
      console.log('  [T-1] Clicked Start Session — waiting for overlay without card click');

      // Overlay must appear automatically
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 15000 });

      // Verify title is correct
      const title = await page.textContent('#overlay-title');
      console.log(`  [T-1] Overlay title: "${title}"`);
      expect(title).toContain('auto-open-test');

      console.log('  [T-1] PASS: overlay auto-opened with correct session title');
    } finally {
      await browser.close();
    }
  });
});
