/**
 * T-31: Settings Cancel discards changes
 *
 * Score: 10
 * Port: 3128
 * Type: Playwright browser test
 *
 * Flow: Open Settings. Change Default Model to "Opus". Click "Cancel".
 * Reopen Settings. Verify model has NOT changed. Verify no PUT was made.
 *
 * Pass: Default Model shows original value after Cancel + reopen. No PUT to /api/settings.
 * Fail: Default Model shows "opus" after Cancel (change persisted). Or PUT was made.
 *
 * Run: PORT=3128 npx playwright test tests/adversarial/T-31-settings-cancel.test.js --reporter=line --timeout=60000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORTS = { direct: 3128, tmux: 3728 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-31-settings-cancel-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server did not start at ${url} within ${timeoutMs}ms`);
}

test.describe(`T-31 — Settings Cancel discards changes [${MODE}]`, () => {
  let serverProc = null;
  let tmpDir = '';
  let projPath = '';
  const projectId = 'proj-t31';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3128
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T31-XXXXXX').toString().trim();
    console.log(`\n  [T-31] tmpDir: ${tmpDir}`);

    projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    const projectsSeed = {
      projects: [{
        id: projectId,
        name: 'T31-Project',
        path: projPath,
        createdAt: '2026-01-01T00:00:00Z',
      }],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(projectsSeed, null, 2));

    const crashLogPath = path.join(tmpDir, 'crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));
    serverProc.on('exit', (code) => {
      if (code !== null && code !== 0) console.log(`  [T-31] Server exited with code ${code}`);
    });

    await waitForServer(`${BASE_URL}/api/projects`);
    console.log(`  [T-31] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await sleep(2000);
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
    if (tmpDir) {
      try { execSync(`rm -rf "${tmpDir}"`); } catch {}
    }
  });

  test('Settings Cancel does not save changes', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Track PUT requests to /api/settings
    const putRequests = [];
    page.on('request', req => {
      if (req.method() === 'PUT' && req.url().includes('/api/settings')) {
        putRequests.push(req.url());
        console.log(`  [T-31] WARNING: PUT to /api/settings intercepted: ${req.url()}`);
      }
    });

    try {
      // ── Step 1: Navigate to app ────────────────────────────────────────────
      console.log('\n  [T-31] Step 1: Navigate to app...');
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
      console.log('  [T-31] App loaded, WS connected');

      // ── Step 2: Open Settings modal ────────────────────────────────────────
      console.log('  [T-31] Step 2: Opening Settings modal...');
      await page.click('button[title="Settings"]');
      await page.waitForSelector('.modal-wide', { timeout: 5000 });
      console.log('  [T-31] Settings modal opened');

      // Allow useEffect to sync from settings signal
      await sleep(300);

      // ── Step 3: Record initial model value ────────────────────────────────
      console.log('  [T-31] Step 3: Reading initial model value...');

      // Find the first select in Session Defaults section
      // The modal has multiple select.form-select elements; we want the first one (Default Model in Session Defaults)
      const modelBefore = await page.$eval('select.form-select', el => el.value);
      console.log(`  [T-31] Initial Default Model: "${modelBefore}"`);

      if (modelBefore === 'opus') {
        // If already opus, change to sonnet for the test to have meaning
        await page.selectOption('select.form-select', 'sonnet');
        await sleep(200);
        const newBefore = await page.$eval('select.form-select', el => el.value);
        console.log(`  [T-31] Changed to sonnet first (was opus). Now: "${newBefore}"`);
        // Cancel to save nothing
        await page.click('button:has-text("Cancel")');
        await page.waitForSelector('.modal-wide', { state: 'hidden', timeout: 5000 });
        // Reopen
        await page.click('button[title="Settings"]');
        await page.waitForSelector('.modal-wide', { timeout: 5000 });
        await sleep(300);
      }

      const finalModelBefore = await page.$eval('select.form-select', el => el.value);
      console.log(`  [T-31] Model before change: "${finalModelBefore}"`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-before-change.png') });

      // ── Step 4: Change the model to something different ───────────────────
      const targetModel = finalModelBefore === 'opus' ? 'haiku' : 'opus';
      console.log(`  [T-31] Step 4: Changing model from "${finalModelBefore}" to "${targetModel}"...`);
      await page.selectOption('select.form-select', targetModel);

      const modelAfterChange = await page.$eval('select.form-select', el => el.value);
      console.log(`  [T-31] Model after change (before cancel): "${modelAfterChange}"`);
      expect(modelAfterChange).toBe(targetModel);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-after-change-before-cancel.png') });

      // ── Step 5: Click Cancel ───────────────────────────────────────────────
      console.log('  [T-31] Step 5: Clicking Cancel...');
      await page.click('button:has-text("Cancel")');
      await page.waitForSelector('.modal-wide', { state: 'hidden', timeout: 5000 });
      console.log('  [T-31] Modal closed');

      await sleep(300);

      // ── Step 6: Verify no PUT request was made ────────────────────────────
      console.log(`  [T-31] Step 6: Verifying no PUT to /api/settings (found ${putRequests.length})...`);
      expect(putRequests.length).toBe(0);
      console.log('  [T-31] Confirmed: no PUT to /api/settings was made');

      // ── Step 7: Reopen Settings ───────────────────────────────────────────
      console.log('  [T-31] Step 7: Reopening Settings modal...');
      await page.click('button[title="Settings"]');
      await page.waitForSelector('.modal-wide', { timeout: 5000 });

      // Wait for useEffect to re-sync
      await sleep(300);

      const modelAfterReopen = await page.$eval('select.form-select', el => el.value);
      console.log(`  [T-31] Model after reopen: "${modelAfterReopen}"`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-after-reopen.png') });

      // ── Step 8: Assert model reverted to original value ───────────────────
      console.log(`  [T-31] Step 8: Asserting model = "${finalModelBefore}" (not "${targetModel}")...`);
      expect(modelAfterReopen).toBe(finalModelBefore);
      console.log('  [T-31] PASS: Settings Cancel correctly discards changes');

    } finally {
      await page.close();
      await context.close();
      await browser.close();
    }

    // ── Crash log check ───────────────────────────────────────────────────────
    const crashLogPath = path.join(tmpDir, 'crash.log');
    if (fs.existsSync(crashLogPath)) {
      const crashLog = fs.readFileSync(crashLogPath, 'utf8').trim();
      if (crashLog.length > 0) {
        console.log(`  [T-31] Crash log contents:\n${crashLog}`);
        expect(crashLog).toBe('');
      }
    }
  });
});
} // end for (const MODE of MODES)
