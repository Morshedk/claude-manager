/**
 * T-32: Session list empty state message appears correctly
 *
 * Score: 10
 * Port: 3129
 * Type: Playwright browser test
 *
 * Flow: Create a new project (seeded). Select it. Observe main content pane.
 * Pass: Shows "No sessions — start one with the button above". No error, no spinner.
 * Fail: Empty state absent, blank, error shown, or spinner persists.
 *
 * Run: PORT=3129 npx playwright test tests/adversarial/T-32-empty-state.test.js --reporter=line --timeout=60000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3129;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-32-empty-state');

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

test.describe('T-32 — Session list empty state message', () => {
  let serverProc = null;
  let tmpDir = '';
  let projPath = '';
  const projectId = 'proj-t32';
  const projectName = 'T32-Project';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3129
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T32-XXXXXX').toString().trim();
    console.log(`\n  [T-32] tmpDir: ${tmpDir}`);

    projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    // Seed a project with zero sessions
    const projectsSeed = {
      projects: [{
        id: projectId,
        name: projectName,
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
      if (code !== null && code !== 0) console.log(`  [T-32] Server exited with code ${code}`);
    });

    await waitForServer(`${BASE_URL}/api/projects`);
    console.log(`  [T-32] Server ready on port ${PORT}`);
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

  test('Empty project shows correct empty state message', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // ── Step 1: Navigate to app ────────────────────────────────────────────
      console.log('\n  [T-32] Step 1: Navigate to app...');
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

      // Wait for WS connection
      await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
      console.log('  [T-32] WS connected');

      // ── Step 2: Wait for project to appear in sidebar ─────────────────────
      console.log('  [T-32] Step 2: Waiting for project in sidebar...');
      await page.waitForSelector('.project-item', { timeout: 10000 });

      const projectNameInSidebar = await page.$eval('.project-item-name', el => el.textContent.trim());
      console.log(`  [T-32] Found project in sidebar: "${projectNameInSidebar}"`);
      expect(projectNameInSidebar).toBe(projectName);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-sidebar-loaded.png') });

      // ── Step 3: Click the project ──────────────────────────────────────────
      console.log('  [T-32] Step 3: Clicking project...');
      await page.click('.project-item');

      // Wait for sessions area to appear
      await page.waitForSelector('#sessions-area', { timeout: 5000 });
      console.log('  [T-32] Sessions area visible');

      await sleep(500); // Let sessions list render

      // ── Step 4: Verify empty state message ────────────────────────────────
      console.log('  [T-32] Step 4: Checking for empty state message...');
      await page.waitForSelector('.sessions-empty', { timeout: 5000 });
      const emptyText = await page.$eval('.sessions-empty', el => el.textContent.trim());
      console.log(`  [T-32] Empty state text: "${emptyText}"`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-empty-state.png') });

      // Assert correct text
      expect(emptyText).toBe('No sessions — start one with the button above');
      console.log('  [T-32] Empty state text matches expected');

      // ── Step 5: Verify no error elements ──────────────────────────────────
      console.log('  [T-32] Step 5: Checking for absence of errors and spinners...');

      const errorToast = await page.$('.toast-error');
      expect(errorToast).toBeNull();

      const errorMessage = await page.$('.error-message');
      expect(errorMessage).toBeNull();

      const spinner = await page.$('.spinner');
      expect(spinner).toBeNull();

      console.log('  [T-32] No error elements or spinners found');

      // ── Step 6: Verify "New Claude Session" button is present ─────────────
      console.log('  [T-32] Step 6: Checking for "New Claude Session" button...');
      const newSessionBtn = await page.$('button:has-text("New Claude Session")');
      expect(newSessionBtn).not.toBeNull();
      console.log('  [T-32] "New Claude Session" button found');

      // ── Step 7: Verify sessions area title ───────────────────────────────
      const areaTitle = await page.$eval('.area-title', el => el.textContent.trim());
      console.log(`  [T-32] Area title: "${areaTitle}"`);
      expect(areaTitle).toContain('Sessions');
      expect(areaTitle).toContain(projectName);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-full-view.png') });

      console.log('  [T-32] PASS: Empty state renders correctly with expected message');

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
        console.log(`  [T-32] Crash log contents:\n${crashLog}`);
        expect(crashLog).toBe('');
      }
    }
  });
});
