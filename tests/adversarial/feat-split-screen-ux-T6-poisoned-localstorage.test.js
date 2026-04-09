/**
 * feat-split-screen-ux T-6: Adversarial — splitPosition localStorage poisoned with out-of-range value
 *
 * Pass condition:
 *   - Poisoned value of 5% IS applied on load (or clamped to min 20%)
 *   - After one drag to 50%, value self-corrects via drag handler clamp (20-85%)
 *   - Corrected value persists after reload
 *
 * Port: 3305
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
const PORT = 3305;
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
let testSessionId = '';

test.describe('feat-split-screen-ux T-6 — Adversarial: poisoned localStorage splitPosition', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-T6-XXXXXX').toString().trim();
    console.log(`\n  [T-6] tmpDir: ${tmpDir}`);

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
      body: JSON.stringify({ name: 'T6Project', path: '/tmp' }),
    }).then(r => r.json());
    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    const sess = await createSessionViaWS(testProjectId, 't6-poison-test', 'bash');
    testSessionId = sess.id;
    console.log('  [T-6] Project:', testProjectId, 'Session:', testSessionId);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill('SIGTERM'); await sleep(500); serverProc.kill('SIGKILL'); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('poisoned 5% splitPosition — overlay in split mode, self-corrects after drag, persists after reload', async () => {
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
      // Step 1: Load page and set poisoned localStorage
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.setViewportSize({ width: 1280, height: 800 });

      await page.evaluate(() => {
        localStorage.setItem('splitView', 'true');
        localStorage.setItem('splitPosition', '5');
      });
      console.log('  [T-6] Poisoned localStorage set: splitView=true, splitPosition=5');

      // Reload to apply poisoned values
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1000);

      // Navigate to project and open session
      await page.waitForFunction(() => document.body.textContent.includes('T6Project'), { timeout: 15000 });
      await page.click('text=T6Project');
      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);

      const card = page.locator('.session-card').first();
      await card.waitFor({ state: 'visible', timeout: 15000 });
      await card.click();
      await sleep(500);

      await page.waitForSelector('#session-overlay', { timeout: 15000 });
      await sleep(500);
      console.log('  [T-6] Overlay opened with poisoned localStorage');

      // Step 2: Read overlay position — should reflect poisoned value (5% or clamped 20%)
      const poisonedState = await page.evaluate(() => {
        const overlay = document.getElementById('session-overlay');
        if (!overlay) return { overlayFound: false };
        const rect = overlay.getBoundingClientRect();
        const splitPos = document.documentElement.style.getPropertyValue('--split-pos');
        return {
          overlayFound: true,
          overlayLeft: rect.left,
          viewportWidth: window.innerWidth,
          splitPos,
          overlayLeftPct: (rect.left / window.innerWidth) * 100,
        };
      });

      console.log('  [T-6] Poisoned state:', JSON.stringify(poisonedState));

      expect(poisonedState.overlayFound, '#session-overlay must be found').toBe(true);

      const initialPosPct = poisonedState.overlayLeftPct;
      console.log(`  [T-6] Initial overlay position: ${initialPosPct.toFixed(1)}% of viewport`);
      console.log(`  [T-6] If ~5% → no clamping on read (gap documented in review). If ~20%+ → clamped on read.`);

      // Key assertion: overlay must be in split mode (not full-screen at left=0)
      // Both 5% and 20% confirm splitView=true was applied
      expect(poisonedState.overlayLeft, 'Overlay must not be at full-screen left=0').toBeGreaterThan(0);

      // Step 3: Drag the handle to 50% — drag handler should clamp to 20-85%
      const handle = page.locator('.split-resize-handle');
      await expect(handle).toBeVisible({ timeout: 10000 });

      const handleBox = await handle.boundingBox();
      expect(handleBox, '.split-resize-handle must have a bounding box').not.toBeNull();

      const targetX = 1280 * 0.50; // 50% of viewport
      const handleCX = handleBox.x + handleBox.width / 2;
      const handleCY = handleBox.y + handleBox.height / 2;

      console.log(`  [T-6] Dragging handle from x=${handleCX} to x=${targetX} (50%)`);
      await page.mouse.move(handleCX, handleCY);
      await page.mouse.down();
      await sleep(100);
      await page.mouse.move(targetX, handleCY, { steps: 20 });
      await sleep(100);
      await page.mouse.up();
      await sleep(500);

      // Step 4: Verify self-correction — drag handler clamps to 20-85%
      const selfCorrectedState = await page.evaluate(() => {
        const overlay = document.getElementById('session-overlay');
        if (!overlay) return null;
        const rect = overlay.getBoundingClientRect();
        const lsValue = localStorage.getItem('splitPosition');
        const splitPos = document.documentElement.style.getPropertyValue('--split-pos');
        return {
          overlayLeft: rect.left,
          overlayLeftPct: (rect.left / window.innerWidth) * 100,
          splitPos,
          lsValue: parseFloat(lsValue),
          viewportWidth: window.innerWidth,
        };
      });

      console.log('  [T-6] Self-corrected state:', JSON.stringify(selfCorrectedState));

      // After dragging to 50%, drag handler clamps 20-85, result should be ~50%
      expect(selfCorrectedState.lsValue, 'After drag to 50%, localStorage must be between 20 and 85').toBeGreaterThanOrEqual(20);
      expect(selfCorrectedState.lsValue, 'After drag to 50%, localStorage must be <= 85').toBeLessThanOrEqual(85);

      // Overlay should now be at approximately 50%
      expect(selfCorrectedState.overlayLeftPct, 'Overlay left must be ~50% after drag to center').toBeGreaterThan(44);
      expect(selfCorrectedState.overlayLeftPct, 'Overlay left must be ~50% after drag to center').toBeLessThan(56);

      console.log('  [T-6] Self-correction confirmed, reloading...');

      // Step 5: Reload and verify corrected value persists
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(800);

      await page.waitForFunction(() => document.body.textContent.includes('T6Project'), { timeout: 15000 });
      await page.click('text=T6Project');
      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);

      const card2 = page.locator('.session-card').first();
      await card2.waitFor({ state: 'visible', timeout: 15000 });
      await card2.click();
      await sleep(500);

      await page.waitForSelector('#session-overlay', { timeout: 15000 });
      await sleep(500);

      const afterReloadState = await page.evaluate(() => {
        const overlay = document.getElementById('session-overlay');
        if (!overlay) return null;
        const rect = overlay.getBoundingClientRect();
        const lsValue = localStorage.getItem('splitPosition');
        return {
          overlayLeftPct: (rect.left / window.innerWidth) * 100,
          lsValue: parseFloat(lsValue),
        };
      });

      console.log('  [T-6] After reload state:', JSON.stringify(afterReloadState));

      // Must still be ~50% (not reverted to poisoned 5%)
      expect(afterReloadState.lsValue, 'Corrected value must persist after reload (not revert to 5%)').toBeGreaterThanOrEqual(20);
      expect(afterReloadState.overlayLeftPct, 'Overlay position must remain corrected (not return to 5%) after reload').toBeGreaterThan(40);

      console.log('  [T-6] PASS — poisoned value applied, self-corrected by drag, persisted after reload');

    } finally {
      await browser.close();
    }
  });
});
