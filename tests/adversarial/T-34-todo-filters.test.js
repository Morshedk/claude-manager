/**
 * T-34: TODO Filters — High Priority Filter Hides Medium Items
 *
 * Score: 8 | Type: Playwright browser | Port: 3131
 *
 * Flow:
 *   1. Start server, seed a project, seed 3 TODOs (High, Medium, Low).
 *   2. Mount TodoPanel via test harness HTML page.
 *   3. Verify all 3 items visible under "all" filter.
 *   4. Click "high" filter → only High item visible.
 *   5. Click "medium" filter → only Medium item visible.
 *   6. Click "all" filter → all 3 restored.
 *
 * Run:
 *   fuser -k 3131/tcp 2>/dev/null; sleep 1
 *   PORT=3131 npx playwright test tests/adversarial/T-34-todo-filters.test.js --reporter=line --timeout=60000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORTS = { direct: 3131, tmux: 3731 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-34-todo-filters-${MODE}`);
const HARNESS_FILE = path.join(APP_DIR, 'public', 'test-harness-T34.html');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe(`T-34 — TODO Priority Filters Hide/Show Items [${MODE}]`, () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let crashLogPath = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-T34-XXXXXX').toString().trim();
    crashLogPath = path.join(tmpDir, 'crash.log');
    console.log(`\n  [T-34] tmpDir: ${tmpDir}`);

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
      body: JSON.stringify({ name: 'T34-Project', path: '/tmp' }),
    });
    if (!pr.ok) throw new Error(`Failed to create project: ${pr.status}`);
    const proj = await pr.json();
    projectId = proj.id;
    console.log(`  [T-34] projectId: ${projectId}`);

    // Seed 3 TODOs: High, Medium, Low
    for (const [title, priority] of [['Task H', 'high'], ['Task M', 'medium'], ['Task L', 'low']]) {
      const r = await fetch(`${BASE_URL}/api/todos/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, priority, estimate: '5m' }),
      });
      if (!r.ok) throw new Error(`Failed to seed TODO ${title}: ${r.status}`);
      const item = await r.json();
      console.log(`  [T-34] Seeded: ${title} (${priority}) id=${item.id}`);
    }

    // Write test harness HTML
    const harness = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>T-34 Test Harness</title>
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
    window.__T34_READY__ = true;
  </script>
</body>
</html>`;

    fs.writeFileSync(HARNESS_FILE, harness, 'utf8');
    console.log(`  [T-34] Harness written: ${HARNESS_FILE}`);
  });

  test.afterAll(async () => {
    try { fs.unlinkSync(HARNESS_FILE); } catch {}

    if (serverProc) {
      serverProc.kill('SIGTERM');
      await sleep(500);
    }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  test('priority filters correctly show/hide todo items', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      // Navigate to harness
      await page.goto(`${BASE_URL}/test-harness-T34.html`, { waitUntil: 'domcontentloaded' });

      // Wait for TodoPanel to mount
      await page.waitForSelector('.todo-header', { timeout: 15000 });
      console.log('  [T-34] TodoPanel mounted');

      // Wait for items to load (all 3 should appear under default 'all' priority + 'pending' status filter)
      await page.waitForFunction(() => document.querySelectorAll('.todo-item').length >= 3, { timeout: 10000 });

      // ── Initial State: all 3 items visible ────────────────────────────────

      const initialCount = await page.locator('.todo-item').count();
      if (initialCount < 3) {
        throw new Error(`Pre-condition FAILED: Expected 3 items in initial state, got ${initialCount}. Check API seed or filter defaults.`);
      }
      console.log(`  [T-34] Initial state: ${initialCount} items visible (expected 3)`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-all-items.png') });

      // Verify all three tasks present
      const allText = await page.locator('.todo-list').textContent();
      expect(allText).toContain('Task H');
      expect(allText).toContain('Task M');
      expect(allText).toContain('Task L');
      console.log('  [T-34] All 3 tasks confirmed visible in initial state');

      // ── Click "high" filter ───────────────────────────────────────────────

      // Filter buttons: text is lowercase — 'high', 'medium', 'low', 'all'
      const filterButtons = page.locator('button.todo-filter-btn');
      const filterTexts = await filterButtons.allTextContents();
      console.log(`  [T-34] Filter buttons found: ${JSON.stringify(filterTexts)}`);

      await page.locator('button.todo-filter-btn', { hasText: 'high' }).click();
      await sleep(300);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-high-filter.png') });

      const highCount = await page.locator('.todo-item').count();
      console.log(`  [T-34] After "high" filter: ${highCount} items visible`);
      expect(highCount).toBe(1);

      const highListText = await page.locator('.todo-list').textContent();
      expect(highListText).toContain('Task H');
      expect(highListText).not.toContain('Task M');
      expect(highListText).not.toContain('Task L');
      console.log('  [T-34] PASS: "high" filter shows only Task H, hides Task M and Task L');

      // ── Click "medium" filter ─────────────────────────────────────────────

      await page.locator('button.todo-filter-btn', { hasText: 'medium' }).click();
      await sleep(300);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-medium-filter.png') });

      const mediumCount = await page.locator('.todo-item').count();
      console.log(`  [T-34] After "medium" filter: ${mediumCount} items visible`);
      expect(mediumCount).toBe(1);

      const mediumListText = await page.locator('.todo-list').textContent();
      expect(mediumListText).toContain('Task M');
      expect(mediumListText).not.toContain('Task H');
      expect(mediumListText).not.toContain('Task L');
      console.log('  [T-34] PASS: "medium" filter shows only Task M');

      // ── Click "low" filter ────────────────────────────────────────────────

      await page.locator('button.todo-filter-btn', { hasText: 'low' }).click();
      await sleep(300);

      const lowCount = await page.locator('.todo-item').count();
      console.log(`  [T-34] After "low" filter: ${lowCount} items visible`);
      expect(lowCount).toBe(1);

      const lowListText = await page.locator('.todo-list').textContent();
      expect(lowListText).toContain('Task L');
      expect(lowListText).not.toContain('Task H');
      expect(lowListText).not.toContain('Task M');
      console.log('  [T-34] PASS: "low" filter shows only Task L');

      // ── Click "all" filter — restore all 3 ────────────────────────────────

      await page.locator('button.todo-filter-btn', { hasText: 'all' }).first().click();
      await sleep(300);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-all-restored.png') });

      const allCount = await page.locator('.todo-item').count();
      console.log(`  [T-34] After "all" filter restored: ${allCount} items visible`);
      expect(allCount).toBe(3);

      const restoredText = await page.locator('.todo-list').textContent();
      expect(restoredText).toContain('Task H');
      expect(restoredText).toContain('Task M');
      expect(restoredText).toContain('Task L');
      console.log('  [T-34] PASS: All 3 items restored after clicking "all" filter');

      // ── Verify the "active" class on filter buttons ───────────────────────
      const allBtn = page.locator('button.todo-filter-btn', { hasText: 'all' }).first();
      const allBtnClass = await allBtn.getAttribute('class');
      expect(allBtnClass).toContain('active');
      console.log(`  [T-34] PASS: "all" filter button has "active" class: "${allBtnClass}"`);

    } finally {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '99-final.png') });
      await browser.close();
    }
  });
});
} // end for (const MODE of MODES)
