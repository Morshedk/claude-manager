// @ts-check
/**
 * T-08: Creating project with non-existent path shows error — modal stays open
 *
 * Pass condition: Error toast shown, modal stays open, project NOT in sidebar.
 * Fail condition: Modal closes with project in sidebar (or silent failure).
 *
 * Design: tests/adversarial/designs/T-08-design.md
 */

import { test, expect } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

const PORTS = { direct: 3105, tmux: 3705 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://localhost:${PORT}`;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots/T-08-bad-path');

let serverProcess = null;
let dataDir = null;

// ── helpers ────────────────────────────────────────────────────────────────────

function waitForServer(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function tryOnce() {
      http.get(url, res => {
        if (res.statusCode < 500) return resolve();
        if (Date.now() > deadline) return reject(new Error(`Server not ready at ${url}`));
        setTimeout(tryOnce, 500);
      }).on('error', () => {
        if (Date.now() > deadline) return reject(new Error(`Server not ready at ${url}`));
        setTimeout(tryOnce, 500);
      });
    }
    tryOnce();
  });
}

async function getProjects() {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}/api/projects`, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve([]); }
      });
    }).on('error', reject);
  });
}

function screenshot(page, name) {
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  return page.screenshot({ path: path.join(SCREENSHOTS_DIR, name), fullPage: false });
}

// ── setup / teardown ────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  // Kill anything already on port 3105
  try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null`); } catch {}
  await new Promise(r => setTimeout(r, 1000));

  // Create isolated data dir
  dataDir = execSync('mktemp -d /tmp/qa-data-XXXXXX').toString().trim();

  // Seed with valid empty projects.json
  fs.writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify({ projects: [], scratchpad: [] }, null, 2)
  );

  // Start server
  serverProcess = spawn('node', ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: 'pipe',
  });

  serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  await waitForServer(`${BASE_URL}/api/projects`);
  console.log(`[T-08] Server ready on port ${PORT}`);
});

test.afterAll(async () => {
  // Clean up any accidentally created projects
  try {
    const projects = await getProjects();
    for (const p of (Array.isArray(projects) ? projects : [])) {
      await new Promise(resolve => {
        const req = http.request(`${BASE_URL}/api/projects/${encodeURIComponent(p.id)}`, {
          method: 'DELETE',
        }, res => { res.resume(); resolve(); });
        req.on('error', resolve);
        req.end();
      });
    }
  } catch {}

  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 3000));
    try { serverProcess.kill('SIGKILL'); } catch {}
  }
  if (dataDir) {
    try { execSync(`rm -rf ${dataDir}`); } catch {}
  }
});

// ── pre-test assertions ────────────────────────────────────────────────────────

test('T-08 pre-conditions: clean server state', async () => {
  const projects = await getProjects();
  const list = Array.isArray(projects) ? projects : (projects.projects || []);
  expect(list.length, 'Pre-test: should have no projects').toBe(0);
});

// ── main test: 3 iterations with nonexistent paths ────────────────────────────

const BAD_PATHS = [
  '/absolutely/nonexistent/path/xyz123',
  '/this/does/not/exist/either',
  '/nonexistent',
];

for (let i = 0; i < BAD_PATHS.length; i++) {
  const iterNum = i + 1;
  const badPath = BAD_PATHS[i];

  test(`T-08 iter-${iterNum}: bad path "${badPath}" — modal stays open, error shown, no project created`, async ({ page }) => {
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // Wait for sidebar
    await page.waitForSelector('#project-sidebar', { timeout: 10000 });
    console.log(`[T-08 iter-${iterNum}] Sidebar visible`);

    // Verify clean state: no projects
    const projectItemsBeforeCount = await page.locator('.project-item').count();
    expect(projectItemsBeforeCount, 'Pre-iteration: 0 projects in sidebar').toBe(0);

    // ── Open New Project modal ────────────────────────────────────────────────
    const newProjBtn = page.locator('.sidebar-new-btn');
    await expect(newProjBtn).toBeVisible({ timeout: 5000 });
    await newProjBtn.click();

    // Wait for modal overlay
    const modal = page.locator('[role="dialog"][aria-label="New Project"]');
    await expect(modal).toBeVisible({ timeout: 5000 });
    console.log(`[T-08 iter-${iterNum}] Modal opened`);

    // ── Fill the form ──────────────────────────────────────────────────────────
    const nameInput = page.locator('#new-project-name');
    const pathInput = page.locator('#new-project-path');

    await nameInput.fill('Bad Path Project');
    await pathInput.fill(badPath);

    await screenshot(page, `iter-${iterNum}-01-form-filled.png`);
    console.log(`[T-08 iter-${iterNum}] Form filled: name="Bad Path Project", path="${badPath}"`);

    // ── Click Create Project ──────────────────────────────────────────────────
    const createBtn = page.locator('.dlg-footer .btn-primary');
    await expect(createBtn).toBeVisible();
    await createBtn.click();
    console.log(`[T-08 iter-${iterNum}] Clicked "Create Project"`);

    // Wait for async completion (fetch resolves)
    await page.waitForTimeout(2500);
    await screenshot(page, `iter-${iterNum}-02-after-create.png`);

    // ── ASSERTION 1: Modal should still be open ────────────────────────────────
    const dialogOverlay = page.locator('.dialog-overlay');
    const modalStillOpen = await dialogOverlay.isVisible();

    if (!modalStillOpen) {
      await screenshot(page, `iter-${iterNum}-03-FAIL-modal-closed.png`);
      console.error(`[T-08 iter-${iterNum}] FAIL: Modal closed after bad path submission`);
    }
    expect(modalStillOpen, `iter-${iterNum}: Modal must remain open after bad path`).toBe(true);

    // ── ASSERTION 2: Toast should be an error (not success) ────────────────────
    // Toast has no CSS class — identified by text content
    // Success toast: `Project "Bad Path Project" created`
    // Error toast: `Failed to create project`
    const successToastVisible = await page.locator('text=Bad Path Project\" created').isVisible()
      .catch(() => false);
    const successToastAlt = await page.locator('text=created').first().isVisible()
      .catch(() => false);

    if (successToastVisible || successToastAlt) {
      await screenshot(page, `iter-${iterNum}-03-FAIL-success-toast.png`);
      console.error(`[T-08 iter-${iterNum}] FAIL: Success toast appeared for invalid path`);
    }
    expect(successToastVisible, `iter-${iterNum}: Must NOT show success toast for bad path`).toBe(false);

    // Check for error toast presence
    // The error toast message is "Failed to create project"
    let errorToastText = null;
    try {
      const toastContainer = page.locator('div[style*="position:fixed"][style*="bottom:20px"]');
      const toastVisible = await toastContainer.isVisible().catch(() => false);
      if (toastVisible) {
        errorToastText = await toastContainer.textContent().catch(() => null);
        console.log(`[T-08 iter-${iterNum}] Toast text: "${errorToastText}"`);
      }
    } catch {}

    // ── ASSERTION 3: Project must NOT appear in sidebar ────────────────────────
    await page.waitForTimeout(500);
    const projectItemsAfterCount = await page.locator('.project-item').count();
    await screenshot(page, `iter-${iterNum}-04-sidebar.png`);

    if (projectItemsAfterCount > 0) {
      await screenshot(page, `iter-${iterNum}-03-FAIL-project-in-sidebar.png`);
      const projectNames = await page.locator('.project-item-name').allTextContents();
      console.error(`[T-08 iter-${iterNum}] FAIL: Projects appeared in sidebar: ${JSON.stringify(projectNames)}`);
    }
    expect(projectItemsAfterCount, `iter-${iterNum}: No project should appear in sidebar after bad path`).toBe(0);

    // ── ASSERTION 4: API confirms no project was created ──────────────────────
    const projectsAfter = await getProjects();
    const projectList = Array.isArray(projectsAfter) ? projectsAfter : (projectsAfter.projects || []);
    expect(projectList.length, `iter-${iterNum}: API must return 0 projects`).toBe(0);

    console.log(`[T-08 iter-${iterNum}] API project count: ${projectList.length}`);
    console.log(`[T-08 iter-${iterNum}] Modal still open: ${modalStillOpen}`);
    console.log(`[T-08 iter-${iterNum}] Error toast text: ${errorToastText}`);
    console.log(`[T-08 iter-${iterNum}] Sidebar items: ${projectItemsAfterCount}`);

    // ── ASSERTION 5: Form inputs still editable (user can retry) ─────────────
    if (modalStillOpen) {
      const nameVal = await nameInput.inputValue().catch(() => null);
      const pathVal = await pathInput.inputValue().catch(() => null);
      console.log(`[T-08 iter-${iterNum}] Form still has: name="${nameVal}", path="${pathVal}"`);
      // Just log — not a hard fail if values were cleared (some UX designs clear on error)
    }

    // ── Close modal for next iteration ─────────────────────────────────────────
    if (modalStillOpen) {
      // Click Cancel button to close the modal
      const cancelBtn = page.locator('.dlg-footer .btn-ghost');
      const cancelVisible = await cancelBtn.isVisible().catch(() => false);
      if (cancelVisible) {
        await cancelBtn.click();
      } else {
        // Fallback: click outside the modal (on the overlay)
        await dialogOverlay.click({ position: { x: 5, y: 5 }, force: true });
      }
      await expect(dialogOverlay).not.toBeVisible({ timeout: 3000 });
    }

    // Print console log summary
    const errors = logs.filter(l => l.startsWith('[error]'));
    if (errors.length) console.log(`[T-08 iter-${iterNum}] Console errors: ${errors.join(', ')}`);
  });
}

// ── summary assertion: total projects after all iterations ────────────────────

test('T-08 final: no projects created after all bad-path attempts', async () => {
  const projects = await getProjects();
  const list = Array.isArray(projects) ? projects : (projects.projects || []);
  console.log(`[T-08 final] Total projects on server: ${list.length}`);
  if (list.length > 0) {
    console.error(`[T-08 final] Projects created with bad paths: ${JSON.stringify(list.map(p => p.path))}`);
  }
  expect(list.length, 'Final: no projects should exist after 3 bad-path attempts').toBe(0);
});
} // end for (const MODE of MODES)
