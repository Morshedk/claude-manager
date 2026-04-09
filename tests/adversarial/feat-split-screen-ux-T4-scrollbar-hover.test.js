/**
 * feat-split-screen-ux T-4: Terminal scrollbar appears on hover
 *
 * Pass condition:
 *   - .xterm-viewport has scrollbar-width: thin CSS rule
 *   - CSS rules for .xterm-viewport scrollbar exist in document stylesheets
 *   - .xterm:hover .xterm-viewport rule is present
 *
 * Port: 3303
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3303;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createSessionViaWS(projectId, name, command = 'bash') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS session create timeout')); }, 15000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session:create', projectId, name, command, cols: 80, rows: 24 }));
    });
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'session:created') { clearTimeout(timeout); ws.close(); resolve(msg.session); }
        else if (msg.type === 'session:error') { clearTimeout(timeout); ws.close(); reject(new Error(msg.error)); }
      } catch {}
    });
    ws.on('error', err => { clearTimeout(timeout); reject(err); });
  });
}

let serverProc = null;
let tmpDir = '';
let testProjectId = '';

test.describe('feat-split-screen-ux T-4 — Terminal scrollbar appears on hover', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-T4-XXXXXX').toString().trim();
    console.log(`\n  [T-4] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({ projects: [], scratchpad: [] }));
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([]));

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
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Server failed to start within 20s');

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T4Project', path: '/tmp' }),
    }).then(r => r.json());
    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    const sess = await createSessionViaWS(testProjectId, 't4-scroll-test', 'bash');
    console.log('  [T-4] Project:', testProjectId, 'Session:', sess.id);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill('SIGTERM'); await sleep(500); serverProc.kill('SIGKILL'); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('xterm-viewport has scrollbar-width: thin and hover CSS rules exist', async () => {
    test.setTimeout(90000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.setViewportSize({ width: 1280, height: 800 });
      await sleep(800);

      // Navigate to project
      await page.waitForFunction(() => document.body.textContent.includes('T4Project'), { timeout: 15000 });
      await page.click('text=T4Project');
      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);

      // Click session card to open overlay
      const card = page.locator('.session-card').first();
      await card.waitFor({ state: 'visible', timeout: 15000 });
      await card.click();
      await sleep(500);

      await page.waitForSelector('#session-overlay', { timeout: 15000 });
      console.log('  [T-4] Overlay opened');

      // Wait for xterm to render
      await page.waitForSelector('.xterm', { timeout: 20000 });
      await sleep(1000);
      console.log('  [T-4] xterm element visible');

      // Check 1: scrollbar-width: thin on .xterm-viewport (computed style)
      const scrollbarWidth = await page.evaluate(() => {
        const vp = document.querySelector('.xterm-viewport');
        if (!vp) return null;
        return getComputedStyle(vp).scrollbarWidth;
      });
      console.log('  [T-4] scrollbar-width computed:', scrollbarWidth);
      expect(scrollbarWidth, '.xterm-viewport must have scrollbar-width: thin').toBe('thin');

      // Check 2: CSS rule existence for .xterm-viewport scrollbar
      const hasScrollbarRule = await page.evaluate(() => {
        return [...document.styleSheets].some(ss => {
          try {
            return [...ss.cssRules].some(r =>
              r.selectorText && r.selectorText.includes('xterm-viewport') &&
              r.cssText.includes('scrollbar')
            );
          } catch { return false; }
        });
      });
      console.log('  [T-4] Has xterm-viewport scrollbar CSS rule:', hasScrollbarRule);
      expect(hasScrollbarRule, 'CSS rule for .xterm-viewport scrollbar must exist in stylesheets').toBe(true);

      // Check 3: .xterm:hover .xterm-viewport rule exists
      const hasHoverRule = await page.evaluate(() => {
        return [...document.styleSheets].some(ss => {
          try {
            return [...ss.cssRules].some(r =>
              r.selectorText && r.selectorText.includes('xterm') &&
              r.selectorText.includes('hover') &&
              r.selectorText.includes('xterm-viewport')
            );
          } catch { return false; }
        });
      });
      console.log('  [T-4] Has .xterm:hover .xterm-viewport rule:', hasHoverRule);
      expect(hasHoverRule, '.xterm:hover .xterm-viewport CSS rule must exist').toBe(true);

      // Hover over xterm element
      await page.hover('.xterm');
      await sleep(500);

      // Re-verify scrollbar-width after hover
      const scrollbarWidthAfterHover = await page.evaluate(() => {
        const vp = document.querySelector('.xterm-viewport');
        if (!vp) return null;
        return getComputedStyle(vp).scrollbarWidth;
      });
      expect(scrollbarWidthAfterHover, 'scrollbar-width must still be thin after hover').toBe('thin');

      console.log('  [T-4] PASS — scrollbar-width: thin set, hover CSS rules present');

    } finally {
      await browser.close();
    }
  });
});
