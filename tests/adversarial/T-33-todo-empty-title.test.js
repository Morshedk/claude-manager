/**
 * T-33: TODO — Add Item With Empty Title Is Blocked
 *
 * Score: 8 | Type: Playwright browser | Port: 3130
 *
 * Flow:
 *   1. Start server, seed a project, seed 0 TODOs.
 *   2. Write a test harness HTML page that mounts TodoPanel for the project.
 *   3. Navigate to harness page.
 *   4. Click "+ Add" to open the add form.
 *   5. Leave title empty. Click "Add."
 *   6. Assert: form still open, no .todo-item created, no POST to /api/todos/
 *   7. API-level: POST with empty title directly → expect 400.
 *   8. Positive path: type a real title, click "Add" → assert 1 .todo-item appears.
 *
 * Run:
 *   fuser -k 3130/tcp 2>/dev/null; sleep 1
 *   PORT=3130 npx playwright test tests/adversarial/T-33-todo-empty-title.test.js --reporter=line --timeout=60000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3130;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-33-todo-empty-title');
const HARNESS_FILE = path.join(APP_DIR, 'public', 'test-harness-T33.html');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('T-33 — TODO Empty Title Blocked', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let crashLogPath = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-T33-XXXXXX').toString().trim();
    crashLogPath = path.join(tmpDir, 'crash.log');
    console.log(`\n  [T-33] tmpDir: ${tmpDir}`);

    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Poll until server ready
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/`);
        if (r.ok) break;
      } catch {}
      await sleep(400);
    }

    // Seed a project
    const pr = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T33-Project', path: '/tmp' }),
    });
    if (!pr.ok) throw new Error(`Failed to create project: ${pr.status}`);
    const proj = await pr.json();
    projectId = proj.id;
    console.log(`  [T-33] projectId: ${projectId}`);

    // Write test harness HTML
    const harness = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>T-33 Test Harness</title>
  <style>
    body { margin: 0; background: #0c1117; color: #ccc; font-family: sans-serif; }
    #root { display: flex; flex-direction: column; height: 100vh; }
    .btn { cursor: pointer; }
    :root {
      --bg-surface: #1a2332;
      --bg-raised: #1e2a3a;
      --border: #2a3a50;
      --text-primary: #d4e0ef;
      --text-secondary: #8899aa;
      --text-muted: #556677;
      --text-bright: #e8f0f8;
      --accent: #4ea8de;
      --accent-bg: rgba(78,168,222,0.1);
      --accent-border: rgba(78,168,222,0.3);
      --accent-dim: #4ea8de;
      --danger: #f04848;
      --danger-bg: rgba(240,72,72,0.1);
      --warning: #e8a020;
      --warning-bg: rgba(232,160,32,0.1);
      --success: #4caf50;
      --success-bg: rgba(76,175,80,0.1);
      --radius: 6px;
      --radius-sm: 4px;
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.4);
      --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
    }
  </style>
  <script type="importmap">
  {
    "imports": {
      "preact":                  "https://esm.sh/preact@10",
      "preact/hooks":            "https://esm.sh/preact@10/hooks",
      "@preact/signals":         "https://esm.sh/@preact/signals@1?external=preact",
      "preact/signals":          "https://esm.sh/@preact/signals@1?external=preact",
      "htm":                     "https://esm.sh/htm@3",
      "htm/preact":              "https://esm.sh/htm@3/preact?external=preact,preact/hooks"
    }
  }
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import { render, h } from 'preact';
    import { TodoPanel } from '/js/components/TodoPanel.js';
    const projectId = '${projectId}';
    render(h(TodoPanel, { projectId }), document.getElementById('root'));
    window.__T33_READY__ = true;
  </script>
</body>
</html>`;

    fs.writeFileSync(HARNESS_FILE, harness, 'utf8');
    console.log(`  [T-33] Harness written: ${HARNESS_FILE}`);
  });

  test.afterAll(async () => {
    // Clean up harness file
    try { fs.unlinkSync(HARNESS_FILE); } catch {}

    if (serverProc) {
      serverProc.kill('SIGTERM');
      await sleep(500);
    }
    // Also kill by port
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  test('empty title is blocked client-side and server-side', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      // Track POST requests to /api/todos/
      const interceptedPosts = [];
      await page.route(`**/api/todos/${projectId}`, (route) => {
        const req = route.request();
        if (req.method() === 'POST') {
          interceptedPosts.push({ url: req.url(), body: req.postData() });
        }
        route.continue();
      });

      // Navigate to harness
      await page.goto(`${BASE_URL}/test-harness-T33.html`, { waitUntil: 'domcontentloaded' });

      // Wait for TodoPanel to mount (wait for .todo-header)
      await page.waitForSelector('.todo-header', { timeout: 15000 });
      console.log('  [T-33] TodoPanel mounted successfully');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-mounted.png') });

      // ── PART A: Server-side API rejection ──────────────────────────────────

      console.log('  [T-33] Testing API-level rejection of empty title...');
      const apiRes = await fetch(`${BASE_URL}/api/todos/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '', priority: 'medium', estimate: '5m' }),
      });
      expect(apiRes.status).toBe(400);
      const apiBody = await apiRes.json();
      expect(apiBody.error).toBeTruthy();
      console.log(`  [T-33] API rejected empty title with 400: ${JSON.stringify(apiBody)}`);

      // ── PART B: Client-side guard via browser interaction ──────────────────

      // Click "+ Add" to open the form
      await page.click('button:text("+ Add")');
      await page.waitForSelector('.todo-add-form', { timeout: 5000 });
      console.log('  [T-33] Add form opened');

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-add-form-open.png') });

      // Verify title input is empty
      const titleInput = page.locator('.todo-add-form input[placeholder*="What needs to be done"]');
      const titleValue = await titleInput.inputValue();
      expect(titleValue).toBe('');
      console.log('  [T-33] Title input confirmed empty');

      // Intercepts are active — click "Add" with empty title
      await page.click('.todo-add-form button:text("Add")');
      await sleep(600); // Wait for any async operations

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-after-empty-submit.png') });

      // Assert: form is still visible (not dismissed)
      const formVisible = await page.locator('.todo-add-form').isVisible();
      expect(formVisible).toBe(true);
      console.log('  [T-33] PASS: Add form still visible after empty submit (not dismissed)');

      // Assert: no .todo-item created
      const todoItems = await page.locator('.todo-item').count();
      expect(todoItems).toBe(0);
      console.log(`  [T-33] PASS: No todo items created (count=${todoItems})`);

      // Assert: no POST was intercepted from the browser
      expect(interceptedPosts.length).toBe(0);
      console.log('  [T-33] PASS: No POST to /api/todos/ was intercepted from browser');

      // ── PART C: Positive path — valid title creates a TODO ─────────────────

      // Type a valid title
      await titleInput.fill('Test task from T-33');
      await page.click('.todo-add-form button:text("Add")');
      await sleep(800);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-valid-todo-created.png') });

      // Assert: form is closed
      const formStillOpen = await page.locator('.todo-add-form').isVisible();
      expect(formStillOpen).toBe(false);
      console.log('  [T-33] PASS: Form closed after valid submit');

      // Assert: exactly 1 .todo-item
      const todoCount = await page.locator('.todo-item').count();
      expect(todoCount).toBe(1);
      console.log(`  [T-33] PASS: 1 todo item created (count=${todoCount})`);

      // Assert: the item has the correct title
      const itemText = await page.locator('.todo-title').first().textContent();
      expect(itemText).toContain('Test task from T-33');
      console.log(`  [T-33] PASS: Todo item has correct title: "${itemText}"`);

      // Assert: network interception DID fire this time (positive path)
      expect(interceptedPosts.length).toBe(1);
      const postedBody = JSON.parse(interceptedPosts[0].body);
      expect(postedBody.title).toBe('Test task from T-33');
      console.log('  [T-33] PASS: POST was intercepted for valid title (positive path confirmed)');

    } finally {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '99-final.png') });
      await browser.close();
    }
  });
});
