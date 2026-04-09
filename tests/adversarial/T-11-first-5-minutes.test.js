/**
 * T-11: New User First 5 Minutes — Create Project and First Session
 *
 * Source: Story 1 + Story 3
 * Score: L=3 S=4 D=5 (Total: 12)
 *
 * Flow: Fresh server (no data). Open app. Verify empty state. Create project.
 * Verify sidebar updates. Create session with Haiku. Verify session card appears.
 *
 * Pass condition:
 *   - Empty state visible on fresh load
 *   - Project created and appears in sidebar without reload
 *   - Session card appears with "starting" or "running" badge
 *   - No console errors during creation flows
 *
 * Run: PORT=3108 npx playwright test tests/adversarial/T-11-first-5-minutes.test.js --reporter=list --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3108;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T11-first-5-minutes');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('T-11 — New User First 5 Minutes', () => {

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3108
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Fresh isolated temp data dir — NO pre-seeding
    tmpDir = execSync('mktemp -d /tmp/qa-T11-XXXXXX').toString().trim();
    console.log(`\n  [T-11] tmpDir: ${tmpDir}`);

    // Start server
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Poll until server is ready
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 20s');
    console.log(`  [T-11] Server ready on port ${PORT}`);

    // PRE-CONDITION GATE: must have zero projects
    const projectsRes = await fetch(`${BASE_URL}/api/projects`).then(r => r.json());
    const existingProjects = projectsRes.projects || (Array.isArray(projectsRes) ? projectsRes : []);
    if (existingProjects.length > 0) {
      throw new Error(`PRE-CONDITION FAILED: server already has ${existingProjects.length} projects — not a fresh install`);
    }
    console.log(`  [T-11] PRE-CONDITION: Server has 0 projects — clean state confirmed`);
  });

  test.afterAll(async () => {
    if (serverProc) serverProc.kill('SIGTERM');
    await sleep(500);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('T-11 — full new user flow: empty state → project → session card', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();

    // Console error monitoring
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(`UNCAUGHT: ${err.message}`));

    try {
      // ─── Step 1: Navigate and verify empty state ───────────────────────────
      console.log('\n  [T-11] Step 1: Navigate and verify empty state');
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

      const emptyState = page.locator('.sidebar-empty');
      await emptyState.waitFor({ timeout: 8000 });
      const emptyText = await emptyState.textContent();
      expect(emptyText).toContain('No projects yet');
      console.log(`  [T-11] Empty state: "${emptyText.trim()}" ✓`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T11-01-empty-state.png') });

      // ─── Step 2: Open "New Project" modal ──────────────────────────────────
      console.log('  [T-11] Step 2: Open New Project modal');
      await page.click('.sidebar-new-btn');

      // Wait for dialog to appear
      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor({ timeout: 5000 });
      const dialogText = await dialog.textContent();
      expect(dialogText).toContain('New Project');
      console.log('  [T-11] New Project modal opened ✓');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T11-02-new-project-modal.png') });

      // ─── Step 3: Fill in project name and path ─────────────────────────────
      console.log('  [T-11] Step 3: Fill project form');
      await page.fill('#new-project-name', 'My First Project');
      await page.fill('#new-project-path', tmpDir);

      // Verify values were entered
      expect(await page.inputValue('#new-project-name')).toBe('My First Project');
      expect(await page.inputValue('#new-project-path')).toBe(tmpDir);
      console.log('  [T-11] Form filled ✓');

      // ─── Step 4: Submit and wait for project in sidebar ───────────────────
      console.log('  [T-11] Step 4: Submit project form');
      await page.click('button:has-text("Create Project")');

      // Wait for modal to close
      await dialog.waitFor({ state: 'detached', timeout: 8000 });
      console.log('  [T-11] Modal closed ✓');

      // Wait for project to appear in sidebar
      await page.waitForFunction(
        () => {
          const items = document.querySelectorAll('.project-item');
          for (const item of items) {
            if (item.textContent.includes('My First Project')) return true;
          }
          return false;
        },
        { timeout: 8000 }
      );
      console.log('  [T-11] "My First Project" appears in sidebar ✓');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T11-03-project-created.png') });

      // ─── Step 5: Verify project is auto-selected ───────────────────────────
      console.log('  [T-11] Step 5: Verify auto-selection');
      await page.waitForFunction(
        () => {
          const title = document.querySelector('#sessions-area-title');
          return title && title.textContent.includes('My First Project');
        },
        { timeout: 5000 }
      );
      console.log('  [T-11] Main pane shows "Sessions — My First Project" ✓');

      // Also verify empty sessions message
      const sessionsEmpty = page.locator('.sessions-empty');
      await sessionsEmpty.waitFor({ timeout: 3000 });
      const sessionsEmptyText = await sessionsEmpty.textContent();
      console.log(`  [T-11] Sessions empty state: "${sessionsEmptyText.trim()}" ✓`);

      // ─── Step 6: Open "New Claude Session" modal ───────────────────────────
      console.log('  [T-11] Step 6: Open New Claude Session modal');
      await page.click('button:has-text("New Claude Session")');

      const sessionModal = page.locator('.modal');
      await sessionModal.waitFor({ timeout: 5000 });
      const sessionModalText = await sessionModal.textContent();
      expect(sessionModalText).toContain('New Session');
      console.log('  [T-11] New Session modal opened ✓');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T11-04-new-session-modal.png') });

      // ─── Step 7: Fill session name and select Haiku ────────────────────────
      console.log('  [T-11] Step 7: Fill session form');
      // Fill session name — find by placeholder
      const sessionNameInput = page.locator('.modal input[placeholder*="refactor"]').first();
      await sessionNameInput.fill('my-first-session');

      // Click Haiku quick button
      const haikuBtn = page.locator('.modal .quick-cmd:has-text("Haiku")').first();
      await haikuBtn.click();

      // Verify command field contains 'haiku'
      const cmdInput = page.locator('.modal .form-input[placeholder="claude"]').first();
      const cmdValue = await cmdInput.inputValue();
      expect(cmdValue.toLowerCase()).toContain('haiku');
      console.log(`  [T-11] Haiku selected — command: "${cmdValue}" ✓`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T11-05-session-modal-filled.png') });

      // ─── Step 8: Start session and verify card appears ─────────────────────
      console.log('  [T-11] Step 8: Start session');
      await page.click('button:has-text("Start Session")');

      // Wait for modal to close
      await sessionModal.waitFor({ state: 'detached', timeout: 5000 });
      console.log('  [T-11] Session modal closed ✓');

      // Wait for session card to appear
      await page.waitForFunction(
        () => {
          const cards = document.querySelectorAll('.session-card');
          for (const card of cards) {
            if (card.textContent.includes('my-first-session')) return true;
          }
          return false;
        },
        { timeout: 10000 }
      );
      console.log('  [T-11] Session card "my-first-session" appears ✓');

      // Verify badge shows valid state
      const sessionCard = page.locator('.session-card', { hasText: 'my-first-session' });
      const badge = sessionCard.locator('.badge-activity');
      await badge.waitFor({ timeout: 5000 });
      const badgeText = await badge.textContent();
      console.log(`  [T-11] Session badge text: "${badgeText}"`);
      const isValidState = badgeText.includes('starting') || badgeText.includes('running');
      expect(isValidState, `Badge should show "starting" or "running", got: "${badgeText}"`).toBe(true);
      console.log(`  [T-11] Badge shows valid state: "${badgeText.trim()}" ✓`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T11-06-session-card.png') });

      // ─── Step 9: Bonus — check overlay auto-opens ──────────────────────────
      console.log('  [T-11] Step 9 (bonus): Check if overlay auto-opens');
      try {
        await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 5000 });
        console.log('  [T-11] Session overlay auto-opened ✓');
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T11-07-overlay.png') });
      } catch {
        console.log('  [T-11] Session overlay did not auto-open (non-critical)');
      }

      // ─── Final: Console error check ────────────────────────────────────────
      const criticalErrors = consoleErrors.filter(e =>
        /TypeError|uncaught|unhandledRejection|ReferenceError/i.test(e)
      );
      if (criticalErrors.length > 0) {
        console.log(`  [T-11] Console errors: ${JSON.stringify(criticalErrors)}`);
        expect(criticalErrors, 'No critical JS errors should appear').toHaveLength(0);
      } else {
        console.log('  [T-11] No critical console errors ✓');
      }

      console.log('\n  [T-11] ✅ ALL STEPS PASSED');

    } finally {
      await browser.close();
    }
  });

  // ─── Bonus validation: validate empty-name shows error toast ──────────────

  test('T-11b — empty project name shows validation error', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);

      // At this point we may or may not have a project (depending on test order)
      // Just open the new project modal directly
      const newProjBtn = page.locator('.sidebar-new-btn');
      await newProjBtn.waitFor({ timeout: 5000 });
      await newProjBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor({ timeout: 5000 });

      // Submit with empty name
      await page.click('button:has-text("Create Project")');

      // Expect error toast about "name required"
      await page.waitForFunction(
        () => document.body.textContent.includes('required') || document.body.textContent.includes('error'),
        { timeout: 5000 }
      );
      console.log('  [T-11b] Empty name validation works ✓');

      // Modal should still be open
      await expect(dialog).toBeVisible();
      console.log('  [T-11b] Modal stays open after validation error ✓');

    } finally {
      await browser.close();
    }
  });

});
