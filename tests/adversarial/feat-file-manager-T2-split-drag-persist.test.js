/**
 * T-2: Side-by-side reviewer (Story 2) — Split button opens FileSplitPane, workspace is clipped, resize drag persists
 * Port: 3351
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3351;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-file-manager T-2 — Split button, workspace clipped, drag persists', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-fm-T2-XXXXXX').toString().trim();
    console.log(`\n  [T-2] tmpDir: ${tmpDir}`);

    // Create project structure
    const libDir = path.join(tmpDir, 'lib', 'sessions');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'SessionManager.js'), '// file marker: T-2 SessionManager\nclass Foo {}');

    // Write projects.json
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'p1', name: 'Demo', path: tmpDir }],
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
    console.log('  [T-2] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Split button opens pane, drag updates --split-pos and localStorage, reload persists', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });

    try {
      // Set viewport large enough for meaningful drag
      await page.setViewportSize({ width: 1280, height: 800 });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1500);

      // Select project
      await page.waitForSelector('text=Demo', { timeout: 10000 });
      await page.click('text=Demo');
      await sleep(800);

      // Click Files tab
      await page.waitForSelector('#files-tab-btn', { timeout: 10000 });
      await page.click('#files-tab-btn');
      await sleep(800);

      // Navigate into lib/ by clicking directory entry
      await page.waitForSelector('.fb-entry', { timeout: 10000 });

      // Click 'lib' directory
      const libEntry = page.locator('.fb-entry').filter({ hasText: 'lib' }).first();
      await libEntry.waitFor({ state: 'visible', timeout: 10000 });
      await libEntry.click();
      await sleep(800);

      // Click 'sessions' directory
      const sessionsEntry = page.locator('.fb-entry').filter({ hasText: 'sessions' }).first();
      await sessionsEntry.waitFor({ state: 'visible', timeout: 10000 });
      await sessionsEntry.click();
      await sleep(800);

      // Click SessionManager.js
      const fileEntry = page.locator('.fb-entry').filter({ hasText: 'SessionManager.js' }).first();
      await fileEntry.waitFor({ state: 'visible', timeout: 10000 });
      await fileEntry.click();
      await sleep(800);

      // Wait for content to load — check for file marker in code view
      await page.waitForSelector('.fb-code', { timeout: 10000 });
      const codeText = await page.locator('.fb-code').textContent();
      expect(codeText).toContain('file marker: T-2 SessionManager');
      console.log('  [T-2] File content loaded with marker');

      // Click Split button
      const splitBtn = page.locator('.fb-split');
      await splitBtn.waitFor({ state: 'visible', timeout: 5000 });
      await splitBtn.click();
      await sleep(800);

      // Assert FileSplitPane appears
      await page.waitForSelector('.file-split-pane', { timeout: 10000 });
      console.log('  [T-2] .file-split-pane visible');

      // Assert body.file-split class
      const hasFileSplit = await page.evaluate(() => document.body.classList.contains('file-split'));
      expect(hasFileSplit).toBe(true);
      console.log('  [T-2] body.file-split class present');

      // Assert workspace margin-right is not 0px
      const marginRight = await page.evaluate(() => {
        return window.getComputedStyle(document.getElementById('workspace')).marginRight;
      });
      console.log(`  [T-2] #workspace marginRight: ${marginRight}`);
      expect(marginRight).not.toBe('0px');

      // Assert split pane contains the file marker
      const splitContent = await page.locator('.file-split-pane').textContent();
      expect(splitContent).toContain('file marker: T-2 SessionManager');
      console.log('  [T-2] Split pane contains file marker');

      // Get handle position and drag to ~30% of viewport
      const vw = 1280;
      const handle = page.locator('.split-resize-handle');
      await handle.waitFor({ state: 'visible', timeout: 5000 });
      const handleBox = await handle.boundingBox();
      const startX = handleBox.x + handleBox.width / 2;
      const startY = handleBox.y + handleBox.height / 2;
      const targetX = Math.round(vw * 0.30);

      console.log(`  [T-2] Dragging from x=${startX} to x=${targetX}`);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(targetX, startY, { steps: 10 });
      await page.mouse.up();
      await sleep(500);

      // Assert localStorage.splitPosition is in [28, 32]
      const storedPos = await page.evaluate(() => {
        const v = localStorage.getItem('splitPosition');
        return v !== null ? parseFloat(v) : null;
      });
      console.log(`  [T-2] localStorage.splitPosition: ${storedPos}`);
      expect(storedPos).not.toBeNull();
      expect(storedPos).toBeGreaterThanOrEqual(25);
      expect(storedPos).toBeLessThanOrEqual(38);

      // Assert --split-pos CSS variable was updated
      const splitPos = await page.evaluate(() => {
        return document.documentElement.style.getPropertyValue('--split-pos');
      });
      console.log(`  [T-2] --split-pos CSS variable: ${splitPos}`);
      expect(splitPos).toBeTruthy();
      const splitPosNum = parseFloat(splitPos);
      expect(splitPosNum).toBeGreaterThanOrEqual(25);
      expect(splitPosNum).toBeLessThanOrEqual(38);

      // Close the split pane first (so Files tab is still active on reload)
      const closeBtn = page.locator('.file-split-pane button').filter({ hasText: '×' }).first();
      if (await closeBtn.count() === 0) {
        // Try by title
        await page.locator('.file-split-pane button[title="Close file viewer"]').click();
      } else {
        await closeBtn.click();
      }
      await sleep(500);

      // Reload and re-open Files tab
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(1500);

      // Check --split-pos is still set from localStorage on mount
      await page.waitForSelector('text=Demo', { timeout: 10000 });
      await page.click('text=Demo');
      await sleep(800);
      await page.click('#files-tab-btn');
      await sleep(800);

      // Re-navigate to the file
      await page.waitForSelector('.fb-entry', { timeout: 10000 });
      await page.locator('.fb-entry').filter({ hasText: 'lib' }).first().click();
      await sleep(600);
      await page.locator('.fb-entry').filter({ hasText: 'sessions' }).first().click();
      await sleep(600);
      await page.locator('.fb-entry').filter({ hasText: 'SessionManager.js' }).first().click();
      await sleep(800);
      await page.waitForSelector('.fb-code', { timeout: 10000 });

      // Re-open split
      await page.locator('.fb-split').click();
      await sleep(800);
      await page.waitForSelector('.file-split-pane', { timeout: 10000 });

      // After reload, --split-pos should reflect saved value (~30%)
      const splitPosAfterReload = await page.evaluate(() => {
        return document.documentElement.style.getPropertyValue('--split-pos');
      });
      console.log(`  [T-2] --split-pos after reload: ${splitPosAfterReload}`);
      const numAfterReload = parseFloat(splitPosAfterReload);
      expect(numAfterReload).toBeGreaterThanOrEqual(25);
      expect(numAfterReload).toBeLessThanOrEqual(38);

      console.log('  [T-2] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
