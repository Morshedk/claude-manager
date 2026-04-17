/**
 * T-6: Path-input resolution table — 200 / 400 / 403 / 404 / 413 / 415 (adversarial)
 * Port: 3355
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3355;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

// Minimal valid PNG bytes
function make1x1PNG() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

test.describe('feat-file-manager T-6 — path resolution table', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-fm-T6-XXXXXX').toString().trim();
    console.log(`\n  [T-6] tmpDir: ${tmpDir}`);

    // Create fixtures
    // small.txt — 50 bytes of ASCII
    fs.writeFileSync(path.join(tmpDir, 'small.txt'), 'A'.repeat(50));

    // mydir/ — empty directory
    fs.mkdirSync(path.join(tmpDir, 'mydir'), { recursive: true });

    // big.txt — 1.5 MB
    fs.writeFileSync(path.join(tmpDir, 'big.txt'), 'a'.repeat(1.5 * 1024 * 1024));

    // bin.bin — binary starting with nulls
    const binData = Buffer.alloc(1024);
    binData[0] = 0x00; binData[1] = 0x00; binData[2] = 0x00; binData[3] = 0x00;
    fs.writeFileSync(path.join(tmpDir, 'bin.bin'), binData);

    // pic.png — valid PNG
    fs.writeFileSync(path.join(tmpDir, 'pic.png'), make1x1PNG());

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
    console.log('  [T-6] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  /**
   * Helper: navigate to app, select project, open Files tab.
   * Returns the page and path input locator.
   */
  async function setupPage(ctx) {
    const page = await ctx.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await page.waitForSelector('text=Demo', { timeout: 10000 });
    await page.click('text=Demo');
    await sleep(600);
    await page.waitForSelector('#files-tab-btn', { timeout: 10000 });
    await page.click('#files-tab-btn');
    await sleep(600);
    const pathInput = page.locator('.fb-path-input');
    await pathInput.waitFor({ state: 'visible', timeout: 10000 });
    return { page, pathInput };
  }

  async function waitForToast(page, expectedText, timeoutMs = 8000) {
    // Use waitForFunction for reliable detection of fast-appearing/disappearing toasts
    const needle = expectedText.toLowerCase();
    try {
      await page.waitForFunction(
        (needle) => {
          const body = document.body.innerText || '';
          return body.toLowerCase().includes(needle);
        },
        needle,
        { timeout: timeoutMs, polling: 100 }
      );
      return true;
    } catch {
      return false;
    }
  }

  test('small.txt → content header shows filename', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);
      await pathInput.fill('small.txt');
      await pathInput.press('Enter');
      await sleep(1500);

      // Assert content header filename is small.txt
      await page.waitForSelector('.fb-content-header', { timeout: 10000 });
      const headerText = await page.locator('.fb-content-header').textContent();
      console.log(`  [T-6] small.txt header: "${headerText}"`);
      expect(headerText).toContain('small.txt');
      console.log('  [T-6] small.txt: PASS');
    } finally {
      await browser.close();
    }
  });

  test('mydir/ (trailing slash) → directory listing, no /api/fs/read call for mydir', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);

      const readRequests = [];
      page.on('request', req => {
        if (req.url().includes('/api/fs/read')) readRequests.push(req.url());
      });

      await pathInput.fill('mydir/');
      await pathInput.press('Enter');
      await sleep(1500);

      // Assert file list panel updated (shows empty directory)
      const emptyMsg = await page.locator('.fb-list-panel').textContent();
      console.log(`  [T-6] mydir/ listing: "${emptyMsg}"`);
      expect(emptyMsg.toLowerCase()).toContain('empty');

      // Assert no /api/fs/read was called for mydir
      const readsForMydir = readRequests.filter(url => url.includes('mydir'));
      console.log(`  [T-6] /api/fs/read calls for mydir: ${JSON.stringify(readsForMydir)}`);
      expect(readsForMydir.length).toBe(0);
      console.log('  [T-6] mydir/ trailing-slash shortcut: PASS');
    } finally {
      await browser.close();
    }
  });

  test('big.txt → toast "File too large to preview"', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);
      await pathInput.fill('big.txt');
      await pathInput.press('Enter');
      await sleep(2000);

      const toastFound = await waitForToast(page, 'too large');
      console.log(`  [T-6] big.txt toast "too large": ${toastFound}`);
      expect(toastFound).toBe(true);
      console.log('  [T-6] big.txt: PASS');
    } finally {
      await browser.close();
    }
  });

  test('bin.bin → toast "Binary file"', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);
      await pathInput.fill('bin.bin');
      await pathInput.press('Enter');
      await sleep(2000);

      const toastFound = await waitForToast(page, 'Binary');
      console.log(`  [T-6] bin.bin toast "Binary": ${toastFound}`);
      expect(toastFound).toBe(true);
      console.log('  [T-6] bin.bin: PASS');
    } finally {
      await browser.close();
    }
  });

  test('pic.png → image preview in right pane', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);
      await pathInput.fill('pic.png');
      await pathInput.press('Enter');
      await sleep(2000);

      await page.waitForSelector('.fb-image-preview img', { timeout: 15000 });
      const imgSrc = await page.locator('.fb-image-preview img').getAttribute('src');
      console.log(`  [T-6] pic.png img.src: ${imgSrc}`);
      expect(imgSrc).toContain('/api/fs/image');
      expect(imgSrc).toContain('pic.png');
      console.log('  [T-6] pic.png: PASS');
    } finally {
      await browser.close();
    }
  });

  test('/etc/passwd → toast "Path is outside the project"', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);
      await pathInput.fill('/etc/passwd');
      await pathInput.press('Enter');
      await sleep(2000);

      const toastFound = await waitForToast(page, 'outside');
      console.log(`  [T-6] /etc/passwd toast "outside": ${toastFound}`);
      expect(toastFound).toBe(true);
      console.log('  [T-6] /etc/passwd: PASS');
    } finally {
      await browser.close();
    }
  });

  test('nonexistent/path.js → toast "Path not found"', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);
      await pathInput.fill('nonexistent/path.js');
      await pathInput.press('Enter');
      await sleep(2000);

      const toastFound = await waitForToast(page, 'not found');
      console.log(`  [T-6] nonexistent/path.js toast "not found": ${toastFound}`);
      expect(toastFound).toBe(true);
      console.log('  [T-6] nonexistent/path.js: PASS');
    } finally {
      await browser.close();
    }
  });

  test('~/stuff → toast "Use an absolute path or a path relative to the project"', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);
      await pathInput.fill('~/stuff');
      await pathInput.press('Enter');
      await sleep(1500);

      const toastFound = await waitForToast(page, 'absolute path');
      console.log(`  [T-6] ~/stuff toast "absolute path": ${toastFound}`);
      expect(toastFound).toBe(true);
      console.log('  [T-6] ~/stuff: PASS');
    } finally {
      await browser.close();
    }
  });

  test('$HOME/x → toast "Use an absolute path or a path relative to the project"', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext();
    try {
      const { page, pathInput } = await setupPage(ctx);
      await pathInput.fill('$HOME/x');
      await pathInput.press('Enter');
      await sleep(1500);

      const toastFound = await waitForToast(page, 'absolute path');
      console.log(`  [T-6] $HOME/x toast "absolute path": ${toastFound}`);
      expect(toastFound).toBe(true);
      console.log('  [T-6] $HOME/x: PASS');
    } finally {
      await browser.close();
    }
  });
});
