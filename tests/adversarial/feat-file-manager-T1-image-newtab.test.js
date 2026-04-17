/**
 * T-1: Screenshot reviewer (Story 1) — path input loads image, Open-in-new-tab renders it on dark bg
 * Port: 3350
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3350;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

// Minimal 1×1 red PNG (valid PNG binary)
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000' +
  '9001 2e00000000c4944415408d76360f8cf0000000200017ede427b0000000049454e44ae426082',
  'hex'
);

// Actually use a well-known 1x1 transparent PNG
function make1x1PNG() {
  // 1x1 PNG, RGBA, transparent — hand-crafted minimal valid PNG
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth=8, color=RGB, ...CRC
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // compressed pixel
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // CRC
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND
    0x44, 0xae, 0x42, 0x60, 0x82,                   // IEND CRC
  ]);
}

test.describe('feat-file-manager T-1 — path input loads image, Open-in-new-tab renders on dark bg', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-fm-T1-XXXXXX').toString().trim();
    console.log(`\n  [T-1] tmpDir: ${tmpDir}`);

    // Create project directory structure
    const screenshotDir = path.join(tmpDir, 'qa-screenshots', 'dashboard');
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, 'A-01.png'), make1x1PNG());

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
    console.log('  [T-1] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Image loads in right pane, new tab opens viewer with dark bg', async () => {
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

      // Select project Demo
      await page.waitForSelector('text=Demo', { timeout: 10000 });
      await page.click('text=Demo');
      await sleep(800);

      // Click Files tab
      await page.waitForSelector('#files-tab-btn', { timeout: 10000 });
      await page.click('#files-tab-btn');
      await sleep(800);

      // Type path in path input and press Enter
      const pathInput = page.locator('.fb-path-input');
      await pathInput.waitFor({ state: 'visible', timeout: 10000 });
      await pathInput.fill('qa-screenshots/dashboard/A-01.png');
      await pathInput.press('Enter');
      await sleep(1500);

      // Wait for image preview
      await page.waitForSelector('.fb-image-preview img', { timeout: 15000 });
      console.log('  [T-1] Image preview visible');

      // Assert image src returns 200
      const imgSrc = await page.locator('.fb-image-preview img').getAttribute('src');
      console.log(`  [T-1] Image src: ${imgSrc}`);
      expect(imgSrc).toContain('/api/fs/image');
      const imgRes = await fetch(BASE_URL + imgSrc);
      expect(imgRes.status).toBe(200);
      console.log('  [T-1] Image endpoint returns 200');

      // Click Open in new tab button — capture new page
      const newTabPromise = ctx.waitForEvent('page');
      await page.locator('.fb-open-newtab').click();
      const newTab = await newTabPromise;
      await newTab.waitForLoadState('domcontentloaded');
      await sleep(1500);
      console.log(`  [T-1] New tab URL: ${newTab.url()}`);

      // Assert URL starts with /viewer.html and contains A-01.png
      expect(newTab.url()).toMatch(/^http:\/\/127\.0\.0\.1:3350\/viewer\.html\?path=/);
      expect(newTab.url()).toContain('A-01.png');

      // Assert body contains viewer-content, not app div
      const body = await newTab.content();
      expect(body).toContain('<div id="viewer-content">');
      expect(body).not.toContain('<div id="app">');
      console.log('  [T-1] viewer.html served (not index.html)');

      // Assert image loaded in new tab
      await newTab.waitForSelector('img', { timeout: 15000 });
      const naturalWidth = await newTab.evaluate(() => {
        const img = document.querySelector('img');
        return img ? img.naturalWidth : 0;
      });
      console.log(`  [T-1] naturalWidth: ${naturalWidth}`);
      expect(naturalWidth).toBeGreaterThan(0);

      // Assert title
      const title = await newTab.title();
      console.log(`  [T-1] Tab title: "${title}"`);
      expect(title).toBe('A-01.png');

      // Assert dark background
      const bgColor = await newTab.evaluate(() => {
        return window.getComputedStyle(document.body).backgroundColor;
      });
      console.log(`  [T-1] Background color: ${bgColor}`);
      expect(bgColor).toBe('rgb(12, 17, 23)');

      console.log('  [T-1] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
