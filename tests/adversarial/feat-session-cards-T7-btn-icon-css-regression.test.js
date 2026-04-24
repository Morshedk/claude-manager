/**
 * T-7: Duplicate .btn-icon CSS rule causes style regression
 * Port: 3506
 * Type: Playwright browser
 *
 * EXPECTED TO FAIL: The duplicate .btn-icon at line 587 overrides padding to 6px.
 * This test documents the bug by asserting the correct values (padding: 0px, 24x24)
 * and records what is actually found in the computed style.
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3506;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-session-cards T-7 — Duplicate .btn-icon CSS regression', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-portrait-T7-XXXXXX').toString().trim();
    console.log(`\n  [T-7] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project', { recursive: true }); // ensure project path exists

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-test-1', name: 'Test Project', path: '/tmp/test-project' }],
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
    console.log('  [T-7] Server ready');

    // Create session via WS
    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 10000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-test-1',
            name: 'css-regression-test',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          clearTimeout(t);
          ws.close();
          resolve(msg.session.id);
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`  [T-7] Session created: ${sessionId}`);
    await sleep(500);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('.btn-icon has correct padding 0px, width 24px, height 24px (will FAIL due to CSS bug)', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1500);

      // Navigate to project
      await page.waitForSelector('text=Test Project', { timeout: 10000 });
      await page.click('text=Test Project');
      await sleep(1000);

      // Wait for session card
      await page.waitForSelector('.session-card', { timeout: 10000 });

      // Find .btn-icon in .session-card-actionbar
      const card = page.locator('.session-card').first();
      const actionbar = card.locator('.session-card-actionbar');
      const btnIcon = actionbar.locator('.btn-icon').first();

      await btnIcon.waitFor({ state: 'visible', timeout: 5000 });

      // Get computed style
      const computedStyle = await btnIcon.evaluate(el => {
        const style = window.getComputedStyle(el);
        return {
          padding: style.padding,
          paddingTop: style.paddingTop,
          paddingRight: style.paddingRight,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
          width: style.width,
          height: style.height,
        };
      });

      console.log(`  [T-7] Computed style of .btn-icon:`);
      console.log(`    padding:    ${computedStyle.padding}`);
      console.log(`    paddingTop: ${computedStyle.paddingTop}`);
      console.log(`    width:      ${computedStyle.width}`);
      console.log(`    height:     ${computedStyle.height}`);

      // CORRECT values from portrait card CSS (lines 379-393):
      //   padding: 0px (all sides)
      //   width: 24px
      //   height: 24px
      //
      // BUG: Later rule at line 587 overrides padding to 6px.
      // This test ASSERTS the correct values — it will FAIL if the bug is present.

      // Assert padding is 0px (not 6px from the duplicate rule)
      expect(computedStyle.paddingTop).toBe('0px');
      expect(computedStyle.paddingRight).toBe('0px');
      expect(computedStyle.paddingBottom).toBe('0px');
      expect(computedStyle.paddingLeft).toBe('0px');

      // Assert width and height are 24px
      expect(computedStyle.width).toBe('24px');
      expect(computedStyle.height).toBe('24px');

      console.log('  [T-7] PASS: .btn-icon has correct padding:0 and 24x24 dimensions');
    } finally {
      await browser.close();
    }
  });
});
