/**
 * feat-cmd-buffer T-1: Send command via buffer — text arrives in terminal
 *
 * Port: 3200
 * Run: npx playwright test tests/adversarial/feat-cmd-buffer-T1-send.test.js --reporter=list --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2-cmd-buffer';
const PORT = 3200;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-cmd-buffer T-1 — Send command via buffer', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-cmd-buffer-T1-XXXXXX').toString().trim();

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-cmdbuf',
        name: 'CmdBufTest',
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

  test('text typed in buffer arrives in terminal when Send is clicked', async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Select project
      await page.click('text=CmdBufTest');
      await sleep(500);

      // Create session
      await page.click('text=New Claude Session');
      await sleep(500);
      const nameInput = await page.waitForSelector('.modal input.form-input', { timeout: 5000 });
      await nameInput.fill('buffer-send-test');
      await sleep(200);
      const directBtn = await page.$('.modal button:has-text("Direct")');
      if (directBtn) { await directBtn.click(); await sleep(200); }
      const cmdInput = await page.$('.modal input[placeholder="claude"]');
      if (cmdInput) { await cmdInput.fill('bash'); await sleep(200); }
      await page.click('.modal button:has-text("Start Session")');
      await sleep(3000);

      // Verify overlay is open
      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      console.log('  [T-1] Overlay open');

      // Verify command buffer textarea exists
      const textarea = await page.waitForSelector('.command-buffer textarea', { timeout: 5000 });
      expect(await textarea.isVisible()).toBe(true);
      console.log('  [T-1] Command buffer textarea found');

      // Type the echo command + a newline (so it executes)
      await textarea.click();
      await textarea.fill('echo BUFFER_TEST_MARKER_12345\n');
      await sleep(300);

      // Click Send button
      const sendBtn = await page.locator('.command-buffer button').last();
      await sendBtn.click();
      await sleep(500);

      // Verify textarea is cleared after send
      const textareaAfter = await textarea.inputValue();
      expect(textareaAfter).toBe('');
      console.log('  [T-1] Textarea cleared after send');

      // Wait for the echo output to appear in terminal
      await sleep(2000);

      // Check terminal output for our marker
      // Note: xterm wraps long lines across multiple row divs, so we concatenate
      // all rows WITHOUT newlines to detect the marker spanning row boundaries.
      const terminalText = await page.evaluate(() => {
        const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
        let text = '';
        for (const row of rows) {
          text += row.textContent;
        }
        return text;
      });

      console.log('  [T-1] Terminal text (first 500 chars):', terminalText.slice(0, 500));
      expect(terminalText).toContain('BUFFER_TEST_MARKER_12345');
      console.log('  [T-1] PASS: Marker found in terminal output');

    } finally {
      await page.close();
      await ctx.close();
      await browser.close();
    }
  });
});
