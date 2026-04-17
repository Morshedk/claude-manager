/**
 * T-3: Path-is-in-my-head developer (Story 3) — markdown renders with real headings, not <pre> fallback
 * Port: 3352
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3352;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

const MD_CONTENT = `# Alpha Heading

Some paragraph text.

- item one
- item two
`;

test.describe('feat-file-manager T-3 — markdown renders headings, not pre fallback', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-fm-T3-XXXXXX').toString().trim();
    console.log(`\n  [T-3] tmpDir: ${tmpDir}`);

    // Create project structure
    const docDir = path.join(tmpDir, 'docs', 'features', 'X');
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(path.join(docDir, '01-design.md'), MD_CONTENT);

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
    console.log('  [T-3] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('In-app: markdown has h1 heading (not pre), viewer also has h1', async () => {
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

      // Type path in path input — do NOT navigate via clicking
      const pathInput = page.locator('.fb-path-input');
      await pathInput.waitFor({ state: 'visible', timeout: 10000 });
      await pathInput.fill('docs/features/X/01-design.md');
      await pathInput.press('Enter');
      await sleep(2000);

      // Wait for .fb-markdown to appear
      await page.waitForSelector('.fb-markdown', { timeout: 15000 });
      console.log('  [T-3] .fb-markdown visible');

      // Assert h1 child with text "Alpha Heading"
      const h1 = page.locator('.fb-markdown h1').first();
      await h1.waitFor({ state: 'visible', timeout: 5000 });
      const h1Text = await h1.textContent();
      console.log(`  [T-3] h1 text: "${h1Text}"`);
      expect(h1Text.trim()).toBe('Alpha Heading');

      // Assert NOT a single <pre> fallback
      const childCount = await page.locator('.fb-markdown').evaluate(el => el.children.length);
      console.log(`  [T-3] .fb-markdown children count: ${childCount}`);
      expect(childCount).toBeGreaterThan(1);

      // Verify no single-pre fallback
      const preCount = await page.locator('.fb-markdown > pre').count();
      const isOnlyPre = (preCount === 1 && childCount === 1);
      expect(isOnlyPre).toBe(false);
      console.log('  [T-3] Not a single <pre> fallback');

      // Now navigate to viewer.html directly
      const mdFilePath = path.join(tmpDir, 'docs', 'features', 'X', '01-design.md');
      const viewerUrl = `${BASE_URL}/viewer.html?path=${encodeURIComponent(mdFilePath)}&projectPath=${encodeURIComponent(tmpDir)}`;
      console.log(`  [T-3] Navigating to viewer: ${viewerUrl}`);

      const viewerPage = await ctx.newPage();
      await viewerPage.goto(viewerUrl, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Assert viewer body has h1 Alpha Heading
      await viewerPage.waitForSelector('.fb-markdown', { timeout: 15000 });
      const viewerH1 = viewerPage.locator('.fb-markdown h1').first();
      await viewerH1.waitFor({ state: 'visible', timeout: 5000 });
      const viewerH1Text = await viewerH1.textContent();
      console.log(`  [T-3] Viewer h1 text: "${viewerH1Text}"`);
      expect(viewerH1Text.trim()).toBe('Alpha Heading');

      // Assert viewer served viewer.html (not index.html)
      const viewerBodyContent = await viewerPage.content();
      expect(viewerBodyContent).toContain('<div id="viewer-content">');
      expect(viewerBodyContent).not.toContain('<div id="app">');
      console.log('  [T-3] Viewer page correctly served viewer.html');

      console.log('  [T-3] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
