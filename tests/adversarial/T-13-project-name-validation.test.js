/**
 * T-13: Submitting New Project With Empty Name Shows Validation Error
 *
 * Score: L=4 S=2 D=3 (Total: 9)
 * Test type: Playwright browser test
 *
 * Flow: Open "New Project" modal. Leave name blank. Fill valid path. Click "Create Project."
 * Pass: Toast "Project name is required" appears. Modal stays open. No project created.
 * Fail: Modal closes silently, or API called with empty name.
 *
 * Run: PORT=3110 npx playwright test tests/adversarial/T-13-project-name-validation.test.js --reporter=line --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORTS = { direct: 3110, tmux: 3710 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-13-validation-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Server did not start at ${url} within ${timeoutMs}ms`);
}

async function getProjects() {
  const resp = await fetch(`${BASE_URL}/api/projects`);
  const data = await resp.json();
  return Array.isArray(data) ? data : (data.projects || []);
}

test.describe(`T-13 — New Project Empty Name Validation [${MODE}]`, () => {

  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3110 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // 1a — Fresh isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-T13-XXXXXX').toString().trim();
    console.log(`\n  [T-13] tmpDir: ${tmpDir}`);

    // Seed with empty projects store
    fs.writeFileSync(
      path.join(tmpDir, 'projects.json'),
      JSON.stringify({ projects: [], scratchpad: [] }, null, 2)
    );

    // 1b — Start server
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    serverProc.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.log(`  [T-13] Server exited with code ${code}`);
      }
    });

    await waitForServer(`${BASE_URL}/api/projects`);
    console.log(`  [T-13] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await sleep(3000);
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
    if (tmpDir) {
      try { execSync(`rm -rf "${tmpDir}"`); } catch {}
    }
  });

  // ── Helper: open modal ────────────────────────────────────────────────────

  async function openNewProjectModal(page) {
    // Click "New Project" button in sidebar
    await page.click('button.sidebar-new-btn');
    await page.waitForSelector('div.dialog-overlay', { timeout: 5000 });
    // Confirm modal header
    await expect(page.locator('div.dialog-overlay h2')).toContainText('New Project');
  }

  async function closeModalWithCancel(page) {
    await page.click('div.dialog-overlay button.btn-ghost');
    await page.waitForSelector('div.dialog-overlay', { state: 'hidden', timeout: 3000 });
  }

  // ── Scenario A: Empty name, valid path (3 iterations) ─────────────────────

  test('Scenario A — empty name with valid path shows toast and keeps modal open (3 iterations)', async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const page = await browser.newPage();

    // Track API calls
    const apiPostCalls = [];
    page.on('request', req => {
      if (req.url().includes('/api/projects') && req.method() === 'POST') {
        apiPostCalls.push({ url: req.url(), postData: req.postData(), time: Date.now() });
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('#project-sidebar', { timeout: 10000 });

      for (let i = 1; i <= 3; i++) {
        console.log(`\n  [T-13][A] Iteration ${i}/3`);
        const prevApiCount = apiPostCalls.length;

        await openNewProjectModal(page);
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `A-iter-${i}-01-modal-opened.png`) });

        // Confirm name field is empty
        const nameVal = await page.inputValue('#new-project-name');
        expect(nameVal).toBe('');

        // Fill only the path field
        await page.fill('#new-project-path', '/tmp/test-project-path');

        // Click "Create Project" with empty name
        await page.click('div.dialog-overlay .dlg-footer .btn-primary');

        // A1: Toast must appear with correct message
        const toastLocator = page.locator(`div:has-text("Project name is required")`).last();
        await expect(toastLocator).toBeVisible({ timeout: 3000 });
        console.log(`  [T-13][A] Iteration ${i}: Toast appeared ✓`);

        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `A-iter-${i}-02-after-submit.png`) });

        // A2: Modal must still be open
        await expect(page.locator('div.dialog-overlay')).toBeVisible({ timeout: 1000 });
        console.log(`  [T-13][A] Iteration ${i}: Modal still open ✓`);

        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `A-iter-${i}-03-modal-still-open.png`) });

        // A3: No API call made
        const newApiCalls = apiPostCalls.slice(prevApiCount);
        if (newApiCalls.length > 0) {
          console.error(`  [T-13][A] FAIL: POST /api/projects was called: ${JSON.stringify(newApiCalls)}`);
        }
        expect(newApiCalls.length).toBe(0);
        console.log(`  [T-13][A] Iteration ${i}: No API call ✓`);

        // A4: No project created server-side
        const projects = await getProjects();
        expect(projects.length).toBe(0);
        console.log(`  [T-13][A] Iteration ${i}: No project on server ✓`);

        await closeModalWithCancel(page);
        await sleep(500);
      }

      console.log(`\n  [T-13][A] ALL 3 ITERATIONS PASSED`);
    } finally {
      await browser.close();
    }
  });

  // ── Scenario B: Valid name, empty path (2 iterations) ────────────────────

  test('Scenario B — valid name with empty path shows "path required" toast (2 iterations)', async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const page = await browser.newPage();

    const apiPostCalls = [];
    page.on('request', req => {
      if (req.url().includes('/api/projects') && req.method() === 'POST') {
        apiPostCalls.push({ url: req.url(), postData: req.postData() });
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('#project-sidebar', { timeout: 10000 });

      for (let i = 1; i <= 2; i++) {
        console.log(`\n  [T-13][B] Iteration ${i}/2`);
        const prevApiCount = apiPostCalls.length;

        await openNewProjectModal(page);

        // Fill only the name field
        await page.fill('#new-project-name', `Test Project B${i}`);
        // Leave path blank

        await page.click('div.dialog-overlay .dlg-footer .btn-primary');

        // B1: Toast with path-required message
        const toastLocator = page.locator(`div:has-text("Project path is required")`).last();
        await expect(toastLocator).toBeVisible({ timeout: 3000 });
        console.log(`  [T-13][B] Iteration ${i}: "path required" toast appeared ✓`);

        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `B-iter-${i}-01-path-validation.png`) });

        // B2: Modal still open
        await expect(page.locator('div.dialog-overlay')).toBeVisible({ timeout: 1000 });
        console.log(`  [T-13][B] Iteration ${i}: Modal still open ✓`);

        // B3: No API call
        expect(apiPostCalls.slice(prevApiCount).length).toBe(0);
        console.log(`  [T-13][B] Iteration ${i}: No API call ✓`);

        // B4: No project created
        const projects = await getProjects();
        expect(projects.length).toBe(0);
        console.log(`  [T-13][B] Iteration ${i}: No project on server ✓`);

        await closeModalWithCancel(page);
        await sleep(500);
      }

      console.log(`\n  [T-13][B] BOTH ITERATIONS PASSED`);
    } finally {
      await browser.close();
    }
  });

  // ── Scenario C: Both fields empty ────────────────────────────────────────

  test('Scenario C — both fields empty shows name-required toast first', async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const page = await browser.newPage();

    const apiPostCalls = [];
    page.on('request', req => {
      if (req.url().includes('/api/projects') && req.method() === 'POST') {
        apiPostCalls.push({ url: req.url(), postData: req.postData() });
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('#project-sidebar', { timeout: 10000 });

      await openNewProjectModal(page);
      // Leave BOTH fields blank
      await page.click('div.dialog-overlay .dlg-footer .btn-primary');

      // C1: Name is checked first
      const toastLocator = page.locator(`div:has-text("Project name is required")`).last();
      await expect(toastLocator).toBeVisible({ timeout: 3000 });
      console.log(`  [T-13][C] Both-empty: "name required" shown first ✓`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `C-01-both-empty.png`) });

      // C2: Modal still open
      await expect(page.locator('div.dialog-overlay')).toBeVisible({ timeout: 1000 });

      // C3: No API call
      expect(apiPostCalls.length).toBe(0);

      // C4: No project created
      const projects = await getProjects();
      expect(projects.length).toBe(0);
      console.log(`  [T-13][C] PASSED`);

      await closeModalWithCancel(page);
    } finally {
      await browser.close();
    }
  });

  // ── Scenario D: Whitespace-only name (trim test) ──────────────────────────

  test('Scenario D — whitespace-only name treated as empty (trim test)', async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const page = await browser.newPage();

    const apiPostCalls = [];
    page.on('request', req => {
      if (req.url().includes('/api/projects') && req.method() === 'POST') {
        apiPostCalls.push({ url: req.url(), postData: req.postData() });
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('#project-sidebar', { timeout: 10000 });

      await openNewProjectModal(page);

      // Type 3 spaces as name
      await page.fill('#new-project-name', '   ');
      await page.fill('#new-project-path', '/tmp/valid-path');

      await page.click('div.dialog-overlay .dlg-footer .btn-primary');

      // D1: Whitespace trimmed → name required toast
      const toastLocator = page.locator(`div:has-text("Project name is required")`).last();
      await expect(toastLocator).toBeVisible({ timeout: 3000 });
      console.log(`  [T-13][D] Whitespace name: "name required" toast ✓`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `D-01-whitespace-name.png`) });

      // D2: Modal still open
      await expect(page.locator('div.dialog-overlay')).toBeVisible({ timeout: 1000 });

      // D3: No API call
      expect(apiPostCalls.length).toBe(0);

      // D4: No project created
      const projects = await getProjects();
      expect(projects.length).toBe(0);
      console.log(`  [T-13][D] PASSED`);

      await closeModalWithCancel(page);
    } finally {
      await browser.close();
    }
  });

});
} // end for (const MODE of MODES)
