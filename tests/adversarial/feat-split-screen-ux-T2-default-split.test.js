/**
 * feat-split-screen-ux T-2: New session opens in split view by default
 *
 * Pass condition:
 *   - After clearing localStorage and creating a session, overlay opens in split mode
 *   - #session-overlay has left near 50% of viewport
 *   - body.session-split class is present
 *   - #workspace has margin-right > 0
 *
 * Port: 3301
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3301;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let testProjectId = '';

test.describe('feat-split-screen-ux T-2 — New session opens in split view by default', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-T2-XXXXXX').toString().trim();
    console.log(`\n  [T-2] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({ projects: [], scratchpad: [] }));
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([]));

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

    // Create path on disk first (server validates path exists)
    const projPath = path.join(tmpDir, 'test-split');
    fs.mkdirSync(projPath, { recursive: true });

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TestProj', path: projPath }),
    }).then(r => r.json());
    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);
    console.log('  [T-2] Project created:', testProjectId);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill('SIGTERM'); await sleep(500); serverProc.kill('SIGKILL'); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('overlay opens in split mode by default (no localStorage)', async () => {
    test.setTimeout(90000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.setViewportSize({ width: 1280, height: 800 });

      // Clear localStorage
      await page.evaluate(() => localStorage.clear());
      await sleep(200);

      // Reload to apply cleared localStorage
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1000);

      // Select the project
      await page.waitForSelector('text=TestProj', { timeout: 15000 });
      await page.click('text=TestProj');
      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);
      console.log('  [T-2] Project selected');

      // Click New Claude Session button
      const newBtn = page.locator('button', { hasText: 'New Claude Session' }).first();
      await expect(newBtn).toBeVisible({ timeout: 15000 });
      await newBtn.click();

      // Modal opens
      await page.waitForSelector('.modal-overlay, .dlg-overlay, [class*="modal"]', { timeout: 10000 });
      console.log('  [T-2] Session modal opened');

      // Fill session name
      const nameInput = page.locator('input[placeholder*="e.g. refactor"], input[placeholder*="session"]').first();
      if (await nameInput.count() > 0) {
        await nameInput.fill('t2-split-test');
      }

      // Override command with bash for fast startup
      const cmdInput = page.locator('input[placeholder="claude"], input[placeholder*="claude"]').first();
      if (await cmdInput.count() > 0) {
        await cmdInput.fill('bash');
      }

      // Submit
      const submitBtn = page.locator('.btn-primary, button[type="submit"]').filter({ hasText: /start|create/i }).first();
      await submitBtn.click();
      console.log('  [T-2] Session creation submitted');

      // Wait for session card to appear
      await page.waitForSelector('.session-card', { timeout: 15000 });
      await sleep(1000);
      console.log('  [T-2] Session card appeared');

      // Wait for overlay — it should auto-open
      await page.waitForSelector('#session-overlay', { timeout: 20000 });
      console.log('  [T-2] Session overlay appeared');

      await sleep(1000);

      // Read overlay position and body class
      const splitState = await page.evaluate(() => {
        const overlay = document.getElementById('session-overlay');
        const workspace = document.getElementById('workspace');
        const bodyHasSplitClass = document.body.classList.contains('session-split');
        if (!overlay) return { overlayFound: false };
        const overlayRect = overlay.getBoundingClientRect();
        const workspaceStyle = workspace ? getComputedStyle(workspace) : null;
        const marginRight = workspaceStyle ? parseFloat(workspaceStyle.marginRight) : 0;
        return {
          overlayFound: true,
          overlayLeft: overlayRect.left,
          viewportWidth: window.innerWidth,
          bodyHasSplitClass,
          marginRight,
        };
      });

      console.log('  [T-2] Split state:', JSON.stringify(splitState));

      expect(splitState.overlayFound, '#session-overlay must be in DOM').toBe(true);
      expect(splitState.bodyHasSplitClass, 'body must have session-split class').toBe(true);

      // Overlay left should be approximately 50% of viewport (not 0)
      const expectedLeft = splitState.viewportWidth * 0.5;
      const tolerance = splitState.viewportWidth * 0.15; // 15% tolerance
      expect(splitState.overlayLeft, `Overlay left (${splitState.overlayLeft}) should be near 50% of viewport (${expectedLeft})`)
        .toBeGreaterThan(expectedLeft - tolerance);
      expect(splitState.overlayLeft, 'Overlay left should not be full-screen (0)')
        .toBeGreaterThan(10);

      expect(splitState.marginRight, '#workspace must have margin-right > 0 in split mode').toBeGreaterThan(0);

      console.log('  [T-2] PASS — overlay opened in split mode by default');

    } finally {
      await browser.close();
    }
  });
});
