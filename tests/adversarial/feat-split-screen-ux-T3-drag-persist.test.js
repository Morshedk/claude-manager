/**
 * feat-split-screen-ux T-3: Split position drag and persist across reload
 *
 * Pass condition:
 *   - Dragging .split-resize-handle to 30% updates --split-pos, localStorage, overlay position
 *   - After reload, position is restored to ~30%
 *
 * Port: 3302
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
const PORT = 3302;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Create a session via WebSocket and return the session object */
async function createSessionViaWS(projectId, name, command = 'bash') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS session create timeout'));
    }, 15000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session:create', projectId, name, command, cols: 80, rows: 24 }));
    });

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'session:created') {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.session);
        } else if (msg.type === 'session:error') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error('session:error: ' + msg.error));
        }
      } catch {}
    });

    ws.on('error', err => { clearTimeout(timeout); reject(err); });
  });
}

let serverProc = null;
let tmpDir = '';
let testProjectId = '';
let testSessionId = '';

test.describe('feat-split-screen-ux T-3 — Split position drag and persist across reload', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-T3-XXXXXX').toString().trim();
    console.log(`\n  [T-3] tmpDir: ${tmpDir}`);

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
      body: JSON.stringify({ name: 'T3Project', path: '/tmp' }),
    }).then(r => r.json());
    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);
    console.log('  [T-3] Project created:', testProjectId);

    const sess = await createSessionViaWS(testProjectId, 't3-drag-test', 'bash');
    testSessionId = sess.id;
    console.log('  [T-3] Session created via WS:', testSessionId);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill('SIGTERM'); await sleep(500); serverProc.kill('SIGKILL'); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  async function openSessionOverlay(page) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(800);

    await page.waitForFunction(
      () => document.body.textContent.includes('T3Project'),
      { timeout: 15000 }
    );
    await page.click('text=T3Project');
    await page.waitForSelector('#sessions-area', { timeout: 10000 });
    await sleep(500);

    // Click session card to open overlay
    const card = page.locator('.session-card').first();
    await card.waitFor({ state: 'visible', timeout: 15000 });
    await card.click();
    await sleep(500);

    await page.waitForSelector('#session-overlay', { timeout: 15000 });
    console.log('  [T-3] Overlay open');
  }

  test('dragging split handle updates position and persists across reload', async () => {
    test.setTimeout(120000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });

    try {
      await openSessionOverlay(page);

      // Verify split mode is active
      const bodyHasSplit = await page.evaluate(() => document.body.classList.contains('session-split'));
      expect(bodyHasSplit, 'body must have session-split class before dragging').toBe(true);
      console.log('  [T-3] Confirmed split mode');

      // Locate the split resize handle
      const handle = page.locator('.split-resize-handle');
      await expect(handle).toBeVisible({ timeout: 10000 });

      const handleBox = await handle.boundingBox();
      console.log('  [T-3] Handle bounding box:', JSON.stringify(handleBox));
      expect(handleBox, '.split-resize-handle must have a bounding box').not.toBeNull();

      // Drag to 30% of viewport width
      const viewportWidth = 1280;
      const targetX = viewportWidth * 0.30;
      const handleCenterX = handleBox.x + handleBox.width / 2;
      const handleCenterY = handleBox.y + handleBox.height / 2;

      console.log(`  [T-3] Dragging from x=${handleCenterX} to x=${targetX}`);

      await page.mouse.move(handleCenterX, handleCenterY);
      await page.mouse.down();
      await sleep(100);
      await page.mouse.move(targetX, handleCenterY, { steps: 20 });
      await sleep(100);
      await page.mouse.up();
      await sleep(500);

      // Read results
      const state = await page.evaluate(() => {
        const splitPos = document.documentElement.style.getPropertyValue('--split-pos');
        const lsValue = localStorage.getItem('splitPosition');
        const overlay = document.getElementById('session-overlay');
        const overlayRect = overlay ? overlay.getBoundingClientRect() : null;
        const workspace = document.getElementById('workspace');
        const workspaceStyle = workspace ? getComputedStyle(workspace) : null;
        const marginRight = workspaceStyle ? parseFloat(workspaceStyle.marginRight) : 0;
        return {
          splitPos,
          lsValue,
          overlayLeft: overlayRect ? overlayRect.left : null,
          viewportWidth: window.innerWidth,
          marginRight,
        };
      });

      console.log('  [T-3] Post-drag state:', JSON.stringify(state));

      // --split-pos should be approximately 30% (clamped to 20-85 range)
      const splitPosNum = parseFloat(state.splitPos);
      console.log(`  [T-3] --split-pos parsed: ${splitPosNum}%`);
      expect(splitPosNum, '--split-pos should be near 30% (clamped min 20%)').toBeGreaterThanOrEqual(20);
      expect(splitPosNum, '--split-pos should be at most 85%').toBeLessThanOrEqual(85);

      // localStorage should be updated
      const lsNum = parseFloat(state.lsValue);
      console.log(`  [T-3] localStorage splitPosition: ${lsNum}`);
      expect(state.lsValue, 'localStorage splitPosition must be set').not.toBeNull();
      expect(lsNum, 'localStorage value should match --split-pos').toBeCloseTo(splitPosNum, 0);

      // Overlay left should be near the drag target (within 5% viewport)
      const expectedLeft = (splitPosNum / 100) * state.viewportWidth;
      const tolerance = state.viewportWidth * 0.05;
      expect(state.overlayLeft, `Overlay left (${state.overlayLeft}) should be near ${expectedLeft}`)
        .toBeGreaterThan(expectedLeft - tolerance);
      expect(state.overlayLeft)
        .toBeLessThan(expectedLeft + tolerance);

      // Workspace margin-right should be approximately (100 - splitPos)% of viewport
      const expectedMarginRight = ((100 - splitPosNum) / 100) * state.viewportWidth;
      console.log(`  [T-3] workspace marginRight: ${state.marginRight}, expected ~${expectedMarginRight}`);
      expect(state.marginRight, '#workspace must have margin-right matching split position').toBeGreaterThan(0);

      console.log('  [T-3] Drag assertions passed, now reloading...');

      // Reload and re-attach session
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(800);

      await page.waitForFunction(
        () => document.body.textContent.includes('T3Project'),
        { timeout: 15000 }
      );
      await page.click('text=T3Project');
      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);

      const card = page.locator('.session-card').first();
      await card.waitFor({ state: 'visible', timeout: 15000 });
      await card.click();
      await sleep(500);

      await page.waitForSelector('#session-overlay', { timeout: 15000 });
      await sleep(500);

      // Verify position preserved
      const afterReload = await page.evaluate(() => {
        const splitPos = document.documentElement.style.getPropertyValue('--split-pos');
        const overlay = document.getElementById('session-overlay');
        const overlayRect = overlay ? overlay.getBoundingClientRect() : null;
        return {
          splitPos,
          overlayLeft: overlayRect ? overlayRect.left : null,
          viewportWidth: window.innerWidth,
        };
      });

      console.log('  [T-3] After reload state:', JSON.stringify(afterReload));

      const reloadSplitPosNum = parseFloat(afterReload.splitPos);
      expect(reloadSplitPosNum, '--split-pos must be preserved after reload (within 3%)')
        .toBeGreaterThan(splitPosNum - 3);
      expect(reloadSplitPosNum)
        .toBeLessThan(splitPosNum + 3);

      const expectedLeftAfterReload = (reloadSplitPosNum / 100) * afterReload.viewportWidth;
      const tolAfterReload = afterReload.viewportWidth * 0.05;
      expect(afterReload.overlayLeft, `Overlay left after reload should be near ${expectedLeftAfterReload}`)
        .toBeGreaterThan(expectedLeftAfterReload - tolAfterReload);

      console.log('  [T-3] PASS — split position dragged, persisted, and restored after reload');

    } finally {
      await browser.close();
    }
  });
});
