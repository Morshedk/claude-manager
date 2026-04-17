/**
 * T-5: XSS-in-path-query adversarial (AC #13, F10) — viewer does not execute injected script
 * Port: 3354
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3354;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-file-manager T-5 — XSS in viewer query params does not execute', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-fm-T5-XXXXXX').toString().trim();
    console.log(`\n  [T-5] tmpDir: ${tmpDir}`);

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
    console.log('  [T-5] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('XSS script payload in path param does not execute', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();

    try {
      // Test 1: script tag payload
      const xssPayload = '<script>window.__pwned=true</script>';
      const xssUrl = `${BASE_URL}/viewer.html?path=${encodeURIComponent(xssPayload)}&projectPath=${encodeURIComponent(tmpDir)}`;
      console.log(`  [T-5] XSS URL: ${xssUrl}`);

      const page1 = await ctx.newPage();
      await page1.goto(xssUrl, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Assert __pwned is NOT set
      const pwned = await page1.evaluate(() => window.__pwned);
      console.log(`  [T-5] window.__pwned: ${pwned}`);
      expect(pwned).toBeUndefined();

      // Assert document.title reflects the filename (set via textContent/document.title, not innerHTML)
      // Note: browsers may display or return document.title differently for payloads containing HTML chars;
      // the key assertion is that it contains some part of the basename (not empty) AND no script executed.
      const title = await page1.title();
      console.log(`  [T-5] document.title: "${title}"`);
      // Title must be non-empty (filename was set) and must not have caused script execution
      expect(title.length).toBeGreaterThan(0);
      // The title may be the full payload or a browser-sanitized version; it must NOT be "File Viewer" (default)
      // since that only appears when filePath is missing/empty
      expect(title).not.toBe('File Viewer');

      // Assert viewer-filename uses textContent (innerHTML === textContent)
      const filenameEl = page1.locator('#viewer-filename');
      const innerHTML = await filenameEl.evaluate(el => el.innerHTML);
      const textContent = await filenameEl.evaluate(el => el.textContent);
      console.log(`  [T-5] #viewer-filename innerHTML: "${innerHTML}"`);
      console.log(`  [T-5] #viewer-filename textContent: "${textContent}"`);
      // The key check: no <script> child elements in the DOM
      const hasScriptChild = await filenameEl.evaluate(el => el.querySelector('script') !== null);
      expect(hasScriptChild).toBe(false);
      console.log('  [T-5] No <script> child in filename element');
      // innerHTML must NOT contain a literal unencoded <script> tag (would mean innerHTML injection)
      // Note: if textContent was set correctly, innerHTML will have HTML-encoded entities (e.g. &gt;)
      // not raw < > chars, which is the correct safe behavior
      expect(innerHTML).not.toContain('<script');
      console.log('  [T-5] innerHTML does not contain raw <script> tag: XSS safe');

      // Test 2: SVG onload payload
      const svgPayload = '<svg onload=window.__pwned2=true>';
      const svgUrl = `${BASE_URL}/viewer.html?path=${encodeURIComponent(svgPayload)}&projectPath=${encodeURIComponent(tmpDir)}`;
      console.log(`  [T-5] SVG URL: ${svgUrl}`);

      const page2 = await ctx.newPage();
      await page2.goto(svgUrl, { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      const pwned2 = await page2.evaluate(() => window.__pwned2);
      console.log(`  [T-5] window.__pwned2: ${pwned2}`);
      expect(pwned2).toBeUndefined();
      console.log('  [T-5] SVG onload payload did not execute');

      // Test 3: negative control — empty path shows "Missing file path"
      const emptyUrl = `${BASE_URL}/viewer.html?path=&projectPath=`;
      const page3 = await ctx.newPage();
      await page3.goto(emptyUrl, { waitUntil: 'domcontentloaded' });
      await sleep(1500);

      // Wait for viewer-error to show
      const errorEl = page3.locator('#viewer-error');
      await errorEl.waitFor({ state: 'visible', timeout: 5000 });
      const errorText = await errorEl.textContent();
      console.log(`  [T-5] Error text: "${errorText}"`);
      expect(errorText).toContain('Missing file path');
      console.log('  [T-5] Empty path shows "Missing file path"');

      console.log('  [T-5] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
