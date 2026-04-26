/**
 * feat-cmd-buffer T-7: Layout integrity — terminal has non-zero height with buffer present
 *
 * Port: 3206
 * Run: npx playwright test tests/adversarial/feat-cmd-buffer-T7-layout.test.js --reporter=list --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2-cmd-buffer';
const PORT = 3206;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-cmd-buffer T-7 — Layout integrity', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-cmd-buffer-T7-XXXXXX').toString().trim();

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-layout',
        name: 'LayoutTest',
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

  test('terminal and command buffer both have non-zero dimensions', async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Select project
      await page.click('text=LayoutTest');
      await sleep(500);

      // Open new session modal
      await page.click('text=New Claude Session');
      await sleep(500);

      // Fill name
      const nameInput = await page.waitForSelector('.modal input.form-input', { timeout: 5000 });
      await nameInput.fill('layout-test');
      await sleep(200);

      // Switch to Direct mode + bash command
      const directBtn = await page.$('.modal button:has-text("Direct")');
      if (directBtn) { await directBtn.click(); await sleep(200); }

      const cmdInput = await page.$('.modal input[placeholder="claude"]');
      if (cmdInput) { await cmdInput.fill('bash'); await sleep(200); }

      // Start session
      await page.click('.modal button:has-text("Start Session")');
      await sleep(3000);

      // Verify overlay opened
      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      console.log('  [T-7] Overlay opened');

      // Measure terminal
      const termRect = await page.evaluate(() => {
        const el = document.getElementById('session-overlay-terminal');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
      });

      console.log('  [T-7] Terminal rect:', JSON.stringify(termRect));
      expect(termRect).not.toBeNull();
      expect(termRect.height).toBeGreaterThan(100);
      expect(termRect.width).toBeGreaterThan(100);

      // Measure command buffer
      const bufferRect = await page.evaluate(() => {
        const el = document.querySelector('.command-buffer');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
      });

      console.log('  [T-7] Buffer rect:', JSON.stringify(bufferRect));
      expect(bufferRect).not.toBeNull();
      expect(bufferRect.height).toBeGreaterThan(30);

      // Verify no overlap: terminal bottom <= buffer top (with 2px tolerance for border)
      expect(termRect.bottom).toBeLessThanOrEqual(bufferRect.top + 2);
      console.log('  [T-7] No overlap confirmed');

      // Verify textarea and button exist
      const textarea = await page.$('.command-buffer textarea');
      expect(textarea).not.toBeNull();
      expect(await textarea.isVisible()).toBe(true);

      const sendBtn = await page.$('.command-buffer button');
      expect(sendBtn).not.toBeNull();
      expect(await sendBtn.isVisible()).toBe(true);

      console.log('  [T-7] PASS');

    } finally {
      await page.close();
      await ctx.close();
      await browser.close();
    }
  });
});
