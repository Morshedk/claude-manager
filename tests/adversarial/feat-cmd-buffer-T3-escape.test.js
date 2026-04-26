/**
 * feat-cmd-buffer T-3: Escape clears textarea content
 *
 * Port: 3202
 * Run: npx playwright test tests/adversarial/feat-cmd-buffer-T3-escape.test.js --reporter=list --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2-cmd-buffer';
const PORT = 3202;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-cmd-buffer T-3 — Escape clears textarea', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-cmd-buffer-T3-XXXXXX').toString().trim();

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-escape',
        name: 'EscapeTest',
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
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(500); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('pressing Escape clears the textarea', async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Select project
      await page.click('text=EscapeTest');
      await sleep(500);

      // Create session
      await page.click('text=New Claude Session');
      await sleep(500);
      const nameInput = await page.waitForSelector('.modal input.form-input', { timeout: 5000 });
      await nameInput.fill('escape-test');
      await sleep(200);
      const directBtn = await page.$('.modal button:has-text("Direct")');
      if (directBtn) { await directBtn.click(); await sleep(200); }
      const cmdInput = await page.$('.modal input[placeholder="claude"]');
      if (cmdInput) { await cmdInput.fill('bash'); await sleep(200); }
      await page.click('.modal button:has-text("Start Session")');
      await sleep(3000);

      // Verify overlay and command buffer
      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      const textarea = await page.waitForSelector('.command-buffer textarea', { timeout: 5000 });

      // Type some text using keyboard (not fill, so events fire correctly)
      await textarea.click();
      await textarea.fill('some text that should be cleared');
      await sleep(200);

      // Verify it has content
      let val = await textarea.inputValue();
      expect(val).toBe('some text that should be cleared');
      console.log('  [T-3] Textarea has content before Escape');

      // Press Escape
      await textarea.press('Escape');
      await sleep(200);

      // Verify cleared
      val = await textarea.inputValue();
      expect(val).toBe('');
      console.log('  [T-3] PASS: Textarea cleared after Escape');

    } finally {
      await page.close();
      await ctx.close();
      await browser.close();
    }
  });
});
