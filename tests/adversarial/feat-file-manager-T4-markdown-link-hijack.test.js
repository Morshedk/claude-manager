/**
 * T-4: In-app markdown link hijack — Risk #7 realized (HIGH finding)
 * Port: 3353
 * Type: Playwright browser
 *
 * NOTE: This test expects the HIGH finding to be FIXED before it can pass.
 * The fix required: add a delegated click handler to FileContentView.js that
 * calls e.preventDefault() on any <a> click inside rendered markdown.
 * Pattern mirrors viewer.js lines 58-61.
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3353;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-file-manager T-4 — in-app markdown link does NOT navigate SPA', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-fm-T4-XXXXXX').toString().trim();
    console.log(`\n  [T-4] tmpDir: ${tmpDir}`);

    // Create target.md with a link to ./other.md
    fs.writeFileSync(path.join(tmpDir, 'target.md'), '# Target\n\n[other](./other.md)\n');
    fs.writeFileSync(path.join(tmpDir, 'other.md'), '# Other\n\nOther content.\n');

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
    console.log('  [T-4] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('In-app markdown link click does NOT navigate the page', async () => {
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

      // Click target.md in the listing
      await page.waitForSelector('.fb-entry', { timeout: 10000 });
      const targetEntry = page.locator('.fb-entry').filter({ hasText: 'target.md' }).first();
      await targetEntry.waitFor({ state: 'visible', timeout: 10000 });
      await targetEntry.click();
      await sleep(1500);

      // Wait for .fb-markdown with an <a> element
      await page.waitForSelector('.fb-markdown a', { timeout: 15000 });
      console.log('  [T-4] .fb-markdown with link visible');

      // Verify the <a> exists and has href ending in ./other.md
      const anchor = page.locator('.fb-markdown a').first();
      const href = await anchor.getAttribute('href');
      console.log(`  [T-4] Anchor href: ${href}`);
      expect(href).toContain('other.md');

      // Record href before click
      const hrefBefore = page.url();
      console.log(`  [T-4] URL before click: ${hrefBefore}`);

      // Click the <a> element inside .fb-markdown
      await anchor.click();
      await sleep(600);

      // Assert location.href is unchanged
      const hrefAfter = page.url();
      console.log(`  [T-4] URL after click: ${hrefAfter}`);
      expect(hrefAfter).toBe(hrefBefore);

      // Assert .fb-markdown is still visible (we did NOT navigate away)
      const fbMarkdownCount = await page.locator('.fb-markdown').count();
      console.log(`  [T-4] .fb-markdown count after click: ${fbMarkdownCount}`);
      expect(fbMarkdownCount).toBeGreaterThan(0);

      // Assert body does NOT contain app-only elements that would indicate navigation
      const hasFileSplit = await page.evaluate(() => {
        return document.body.classList.contains('file-split');
      });
      console.log(`  [T-4] body.file-split: ${hasFileSplit}`);

      // Key check: URL path should still be /
      const urlPath = new URL(hrefAfter).pathname;
      console.log(`  [T-4] URL pathname after click: "${urlPath}"`);
      expect(urlPath).toBe('/');

      console.log('  [T-4] In-app link interception: PASS');

      // Also test against the viewer page
      const targetMdPath = path.join(tmpDir, 'target.md');
      const viewerUrl = `${BASE_URL}/viewer.html?path=${encodeURIComponent(targetMdPath)}&projectPath=${encodeURIComponent(tmpDir)}`;
      console.log(`  [T-4] Testing viewer at: ${viewerUrl}`);

      const viewerPage = await ctx.newPage();
      await viewerPage.goto(viewerUrl, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Wait for .fb-markdown with link
      await viewerPage.waitForSelector('.fb-markdown a', { timeout: 15000 });
      const viewerAnchor = viewerPage.locator('.fb-markdown a').first();
      const viewerHrefBefore = viewerPage.url();

      // Click the link in viewer
      await viewerAnchor.click();
      await sleep(500);

      const viewerHrefAfter = viewerPage.url();
      console.log(`  [T-4] Viewer URL before: ${viewerHrefBefore}, after: ${viewerHrefAfter}`);

      // viewer.html pathname should remain /viewer.html
      const viewerPathAfter = new URL(viewerHrefAfter).pathname;
      expect(viewerPathAfter).toBe('/viewer.html');
      console.log('  [T-4] Viewer link interception: PASS');

      console.log('  [T-4] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
