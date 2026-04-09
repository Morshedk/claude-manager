/**
 * feat-split-screen-ux T-5: Sidebar and sessions area resize handles are functional
 *
 * Pass condition:
 *   - #sidebar-resize exists with cursor: col-resize
 *   - Dragging sidebar handle right by 80px increases #project-sidebar width by ~80px
 *   - #resize-sessions exists
 *   - Dragging sessions handle down by 60px increases #sessions-area height by ~60px
 *   - #terminals-area remains visible with height >= 100px
 *
 * Port: 3304
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3304;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let testProjectId = '';

test.describe('feat-split-screen-ux T-5 — Sidebar and sessions area resize handles', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-T5-XXXXXX').toString().trim();
    console.log(`\n  [T-5] tmpDir: ${tmpDir}`);

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
      body: JSON.stringify({ name: 'T5Project', path: '/tmp' }),
    }).then(r => r.json());
    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);
    console.log('  [T-5] Project:', testProjectId);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill('SIGTERM'); await sleep(500); serverProc.kill('SIGKILL'); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('sidebar handle and sessions area handle are draggable and functional', async () => {
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

      // Navigate to project to get sessions-area
      await page.waitForFunction(() => document.body.textContent.includes('T5Project'), { timeout: 15000 });
      await page.click('text=T5Project');
      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);
      console.log('  [T-5] Project detail loaded');

      // ── SIDEBAR HANDLE ──────────────────────────────────────────────────────

      // Verify #sidebar-resize exists
      const sidebarHandle = page.locator('#sidebar-resize');
      await expect(sidebarHandle).toBeAttached({ timeout: 10000 });
      console.log('  [T-5] #sidebar-resize found');

      // Check cursor style
      const sidebarCursor = await page.evaluate(() => {
        const el = document.getElementById('sidebar-resize');
        return el ? getComputedStyle(el).cursor : null;
      });
      console.log('  [T-5] #sidebar-resize cursor:', sidebarCursor);
      expect(sidebarCursor, '#sidebar-resize must have cursor: col-resize').toBe('col-resize');

      // Read initial sidebar width
      const initialSidebarWidth = await page.evaluate(() => {
        const sidebar = document.getElementById('project-sidebar');
        return sidebar ? sidebar.offsetWidth : 0;
      });
      console.log('  [T-5] Initial sidebar width:', initialSidebarWidth);
      expect(initialSidebarWidth, 'Sidebar must have positive width').toBeGreaterThan(0);

      // Get handle bounding box
      const handleBox = await sidebarHandle.boundingBox();
      expect(handleBox, '#sidebar-resize must have a bounding box').not.toBeNull();

      const handleCX = handleBox.x + handleBox.width / 2;
      const handleCY = handleBox.y + handleBox.height / 2;

      // Drag right by 80px
      await page.mouse.move(handleCX, handleCY);
      await page.mouse.down();
      await sleep(100);
      await page.mouse.move(handleCX + 80, handleCY, { steps: 20 });
      await sleep(100);
      await page.mouse.up();
      await sleep(500);

      const newSidebarWidth = await page.evaluate(() => {
        const sidebar = document.getElementById('project-sidebar');
        return sidebar ? sidebar.offsetWidth : 0;
      });
      console.log('  [T-5] New sidebar width after drag:', newSidebarWidth, '(was:', initialSidebarWidth + ')');

      const sidebarDelta = newSidebarWidth - initialSidebarWidth;
      console.log('  [T-5] Sidebar width delta:', sidebarDelta, '(expected ~80, tolerance ±10)');
      expect(sidebarDelta, 'Sidebar width must increase by approximately 80px (within ±10px)').toBeGreaterThan(80 - 10);
      expect(sidebarDelta, 'Sidebar width delta must not exceed 90px').toBeLessThan(80 + 10);

      console.log('  [T-5] Sidebar resize: PASS');

      // ── SESSIONS HANDLE ─────────────────────────────────────────────────────

      // Verify #resize-sessions exists
      const sessionsHandle = page.locator('#resize-sessions');
      await expect(sessionsHandle).toBeAttached({ timeout: 10000 });
      console.log('  [T-5] #resize-sessions found');

      // Read initial sessions area height
      const initialSessionsHeight = await page.evaluate(() => {
        const sa = document.getElementById('sessions-area');
        return sa ? sa.offsetHeight : 0;
      });
      console.log('  [T-5] Initial sessions-area height:', initialSessionsHeight);
      expect(initialSessionsHeight, '#sessions-area must have positive height').toBeGreaterThan(0);

      // Get sessions handle bounding box
      const sessHandleBox = await sessionsHandle.boundingBox();
      expect(sessHandleBox, '#resize-sessions must have a bounding box').not.toBeNull();

      const sessCX = sessHandleBox.x + sessHandleBox.width / 2;
      const sessCY = sessHandleBox.y + sessHandleBox.height / 2;

      // Drag down by 60px
      await page.mouse.move(sessCX, sessCY);
      await page.mouse.down();
      await sleep(100);
      await page.mouse.move(sessCX, sessCY + 60, { steps: 20 });
      await sleep(100);
      await page.mouse.up();
      await sleep(500);

      const newSessionsHeight = await page.evaluate(() => {
        const sa = document.getElementById('sessions-area');
        return sa ? sa.offsetHeight : 0;
      });
      console.log('  [T-5] New sessions-area height after drag:', newSessionsHeight, '(was:', initialSessionsHeight + ')');

      const sessionsDelta = newSessionsHeight - initialSessionsHeight;
      console.log('  [T-5] Sessions height delta:', sessionsDelta, '(expected ~60, tolerance ±10)');
      expect(sessionsDelta, 'Sessions area height must increase by approximately 60px (within ±10px)').toBeGreaterThan(60 - 10);
      expect(sessionsDelta, 'Sessions height delta must not exceed 70px').toBeLessThan(60 + 10);

      // Verify terminals-area still visible with height >= 100px
      const terminalsHeight = await page.evaluate(() => {
        const ta = document.getElementById('terminals-area');
        return ta ? ta.offsetHeight : 0;
      });
      console.log('  [T-5] #terminals-area height:', terminalsHeight);
      expect(terminalsHeight, '#terminals-area must remain visible with height >= 100px').toBeGreaterThanOrEqual(100);

      console.log('  [T-5] Sessions resize: PASS');
      console.log('  [T-5] PASS — both resize handles functional');

    } finally {
      await browser.close();
    }
  });
});
