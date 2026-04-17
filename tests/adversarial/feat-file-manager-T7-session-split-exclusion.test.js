/**
 * T-7: Session + file-split mutual exclusion (AC #11, F5) — adversarial ordering
 * Port: 3356
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3356;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-file-manager T-7 — session overlay + file split mutual exclusion', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-fm-T7-XXXXXX').toString().trim();
    console.log(`\n  [T-7] tmpDir: ${tmpDir}`);

    // Create a test file
    fs.writeFileSync(path.join(tmpDir, 'test-file.md'), '# Test\n\nSome content.\n');

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
    console.log('  [T-7] Server ready');

    // Create session via WS
    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 10000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'p1',
            name: 'test-session',
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

    console.log(`  [T-7] Session created: ${sessionId}`);
    await sleep(500);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  /**
   * Helper: navigate to app, select project, open Files tab, select test-file.md
   */
  async function setupFileView(page) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    await page.waitForSelector('text=Demo', { timeout: 10000 });
    await page.click('text=Demo');
    await sleep(800);

    await page.waitForSelector('#files-tab-btn', { timeout: 10000 });
    await page.click('#files-tab-btn');
    await sleep(800);

    await page.waitForSelector('.fb-entry', { timeout: 10000 });
    const fileEntry = page.locator('.fb-entry').filter({ hasText: 'test-file.md' }).first();
    await fileEntry.waitFor({ state: 'visible', timeout: 10000 });
    await fileEntry.click();
    await sleep(800);

    await page.waitForSelector('.fb-split', { timeout: 10000 });
  }

  test('Scenario A: attach-first, split disabled; detach, split works', async () => {
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
      await setupFileView(page);

      // Open Files tab — verify split button is NOT disabled yet
      const splitBtn = page.locator('.fb-split');
      const isDisabledBefore = await splitBtn.evaluate(el => el.hasAttribute('disabled') || el.disabled);
      console.log(`  [T-7] Split disabled before attach: ${isDisabledBefore}`);
      expect(isDisabledBefore).toBe(false);

      // Attach the session by clicking the session card
      // First switch to Sessions tab
      await page.locator('button.tab-btn').filter({ hasText: 'Sessions' }).click();
      await sleep(500);

      await page.waitForSelector('.session-card', { timeout: 10000 });

      // Click the session name link to avoid hitting action buttons (which stop propagation)
      const sessionNameLink = page.locator('.session-card-name-link').first();
      await sessionNameLink.waitFor({ state: 'visible', timeout: 5000 });
      await sessionNameLink.click();
      await sleep(1000);

      // Wait for session overlay
      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      console.log('  [T-7] Session overlay visible');

      // The tab bar is still visible — switch to Files tab
      await page.waitForSelector('#files-tab-btn', { timeout: 10000 });
      await page.click('#files-tab-btn');
      await sleep(800);

      // Re-select the file (Files tab remounts)
      await page.waitForSelector('.fb-entry', { timeout: 10000 });
      const fileEntry = page.locator('.fb-entry').filter({ hasText: 'test-file.md' }).first();
      await fileEntry.waitFor({ state: 'visible', timeout: 10000 });
      await fileEntry.click();
      await sleep(800);

      // Assert split button is disabled
      await page.waitForSelector('.fb-split', { timeout: 10000 });
      const isDisabledAfterAttach = await page.locator('.fb-split').evaluate(el => el.hasAttribute('disabled') || el.disabled);
      console.log(`  [T-7] Split disabled after attach: ${isDisabledAfterAttach}`);
      expect(isDisabledAfterAttach).toBe(true);

      // Force-click the disabled button — assert split pane does NOT appear
      await page.locator('.fb-split').click({ force: true });
      await sleep(500);
      const splitPaneCount = await page.locator('.file-split-pane').count();
      console.log(`  [T-7] .file-split-pane count after force-click: ${splitPaneCount}`);
      expect(splitPaneCount).toBe(0);

      // At most one of #session-overlay / .file-split-pane in DOM
      const overlayCount = await page.locator('#session-overlay').count();
      const splitCount = await page.locator('.file-split-pane').count();
      console.log(`  [T-7] overlay: ${overlayCount}, split: ${splitCount}`);
      expect(overlayCount + splitCount).toBeLessThanOrEqual(1);

      // Detach the session — click close button
      await page.locator('#btn-detach').click();
      await sleep(800);

      // Session overlay should be gone
      const overlayAfterDetach = await page.locator('#session-overlay').count();
      console.log(`  [T-7] Overlay count after detach: ${overlayAfterDetach}`);
      expect(overlayAfterDetach).toBe(0);

      // Re-select the file and assert split button is now enabled
      await page.waitForSelector('.fb-entry', { timeout: 10000 });
      const fileEntry2 = page.locator('.fb-entry').filter({ hasText: 'test-file.md' }).first();
      await fileEntry2.click();
      await sleep(800);

      await page.waitForSelector('.fb-split', { timeout: 10000 });
      const isDisabledAfterDetach = await page.locator('.fb-split').evaluate(el => el.hasAttribute('disabled') || el.disabled);
      console.log(`  [T-7] Split disabled after detach: ${isDisabledAfterDetach}`);
      expect(isDisabledAfterDetach).toBe(false);

      // Click split — assert .file-split-pane appears
      await page.locator('.fb-split').click();
      await sleep(800);
      await page.waitForSelector('.file-split-pane', { timeout: 10000 });
      console.log('  [T-7] .file-split-pane opened after detach');

      // Assert exactly one pane at a time
      const overlayFinal = await page.locator('#session-overlay').count();
      const splitFinal = await page.locator('.file-split-pane').count();
      console.log(`  [T-7] Final: overlay=${overlayFinal}, split=${splitFinal}`);
      expect(overlayFinal).toBe(0);
      expect(splitFinal).toBe(1);

      console.log('  [T-7] Scenario A: PASS');
    } finally {
      await browser.close();
    }
  });

  test('Scenario B: split-first, then attach-session — split wins, overlay hidden; close split, overlay mounts', async () => {
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
      await setupFileView(page);

      // Open file split first
      const splitBtn = page.locator('.fb-split');
      await splitBtn.click();
      await sleep(800);
      await page.waitForSelector('.file-split-pane', { timeout: 10000 });
      console.log('  [T-7] Scenario B: .file-split-pane opened');

      // Now attach the session — switch to Sessions tab
      await page.locator('button.tab-btn').filter({ hasText: 'Sessions' }).click();
      await sleep(500);

      await page.waitForSelector('.session-card', { timeout: 10000 });
      // Click the session name link (not the card body, to avoid hitting action buttons)
      await page.locator('.session-card-name-link').first().click();
      await sleep(1000);

      // file-split wins: #session-overlay should NOT render
      const overlayCount = await page.locator('#session-overlay').count();
      const splitCount = await page.locator('.file-split-pane').count();
      console.log(`  [T-7] Scenario B after attach: overlay=${overlayCount}, split=${splitCount}`);
      expect(overlayCount).toBe(0);
      expect(splitCount).toBe(1);
      console.log('  [T-7] Split wins over session overlay: PASS');

      // Close the file split
      const closeBtn = page.locator('.file-split-pane button[title="Close file viewer"]');
      await closeBtn.click();
      await sleep(800);

      // Now session overlay should mount
      const splitAfterClose = await page.locator('.file-split-pane').count();
      console.log(`  [T-7] .file-split-pane after close: ${splitAfterClose}`);
      expect(splitAfterClose).toBe(0);

      // Session is still attached, so overlay should render now
      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      const overlayAfterClose = await page.locator('#session-overlay').count();
      console.log(`  [T-7] #session-overlay after split close: ${overlayAfterClose}`);
      expect(overlayAfterClose).toBe(1);

      console.log('  [T-7] Scenario B: PASS');
    } finally {
      await browser.close();
    }
  });
});
