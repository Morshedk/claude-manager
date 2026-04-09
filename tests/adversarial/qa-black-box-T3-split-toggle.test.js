/**
 * T-3: Terminal survives split/full toggle without going black
 *
 * Verifies: Content written before the toggle remains visible after
 * switching between Split and Full views.
 *
 * Port: 3402
 */

import { test, expect, chromium } from 'playwright/test';
import WebSocket from 'ws';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3402;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'black-box-T3');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 10000);
  });
}

function waitForMsg(ws, pred, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('waitForMsg timeout')); }, timeoutMs);
    function h(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (pred(m)) { clearTimeout(t); ws.off('message', h); resolve(m); }
    }
    ws.on('message', h);
  });
}

test.describe('T-3 — Terminal survives split/full toggle without going black', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-bb-T3-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [T3-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T3-srv:err] ${d}`));

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) break; } catch {}
      await sleep(500);
    }

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T3-Project', path: '/tmp' }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    const ws = await wsConnect(PORT);
    await waitForMsg(ws, m => m.type === 'init');
    ws.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 't3-bash',
      command: 'bash',
      mode: 'direct',
      cwd: '/tmp',
      cols: 120,
      rows: 30,
    }));
    const created = await waitForMsg(ws, m => m.type === 'session:created' || m.type === 'session:error', 20000);
    ws.close();
    if (created.type === 'session:error') throw new Error(`Session create error: ${created.error}`);
    sessionId = created.session.id;

    const deadline2 = Date.now() + 15000;
    while (Date.now() < deadline2) {
      const sessions = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
      const all = [...(sessions.managed || []), ...(sessions.detected || [])];
      const s = all.find(s => s.id === sessionId);
      if (s && (s.status === 'running' || s.state === 'running')) break;
      await sleep(500);
    }
    console.log(`  [T3] Setup: project=${projectId}, session=${sessionId}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} await sleep(1000); try { serverProc.kill('SIGKILL'); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('T-3: text visible in both split and full modes after toggle', async () => {
    test.setTimeout(90000);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [T3-browser:err] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      await page.waitForSelector('text=T3-Project', { timeout: 15000 });
      await page.click('text=T3-Project');
      await page.waitForSelector('.session-card', { timeout: 10000 });
      await sleep(500);

      const sessionCard = page.locator('.session-card').first();
      await sessionCard.click();

      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen canvas', { timeout: 10000 });
      await page.waitForFunction(() => {
        const rows = document.querySelector('#session-overlay-terminal .xterm-rows');
        return rows && rows.children.length > 2;
      }, { timeout: 15000 }).catch(() => {});

      await sleep(2000); // let bash settle
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-terminal-ready.png') });

      // Send sentinel via WS
      const ws2 = await wsConnect(PORT);
      await waitForMsg(ws2, m => m.type === 'init');
      ws2.send(JSON.stringify({ type: 'session:subscribe', id: sessionId, cols: 120, rows: 30 }));
      await waitForMsg(ws2,
        m => (m.type === 'session:subscribed' && m.id === sessionId) || (m.type === 'session:output' && m.id === sessionId),
        10000
      );
      await sleep(500);
      ws2.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo SPLIT_TEST_123\n' }));

      const markerFoundBefore = await page.waitForFunction(() => {
        const rows = document.querySelector('#session-overlay-terminal .xterm-rows');
        return rows && rows.textContent.includes('SPLIT_TEST_123');
      }, { timeout: 8000 }).then(() => true).catch(() => false);

      ws2.close();
      console.log(`  [T3] Marker before toggle: ${markerFoundBefore}`);
      expect(markerFoundBefore, 'SPLIT_TEST_123 must appear in terminal before toggle').toBe(true);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-before-toggle.png') });

      // ── Detect initial split state and toggle accordingly ───────────────────
      // Default is split mode (button shows "Full" when split, "Split" when full).
      // The localStorage default is splitView=true (split mode). Test both transitions.

      // Check which toggle button is currently visible
      const initialState = await page.evaluate(() => {
        const fullBtn = document.querySelector('button:not([id])');
        // Find the split/full toggle button by its text content
        const allBtns = Array.from(document.querySelectorAll('button'));
        const toggleBtn = allBtns.find(b => b.textContent.trim() === 'Full' || b.textContent.trim() === 'Split');
        return toggleBtn ? toggleBtn.textContent.trim() : 'unknown';
      });
      console.log(`  [T3] Initial toggle button shows: "${initialState}"`);

      // ── First toggle: click whatever button is currently showing ────────────
      const firstToggleBtn = page.locator(`button:has-text("${initialState}")`).first();
      await expect(firstToggleBtn, `"${initialState}" button must be visible`).toBeVisible({ timeout: 5000 });
      await firstToggleBtn.click();
      await sleep(800);

      const afterFirstToggleLabel = initialState === 'Full' ? 'split→full' : 'full→split';
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-after-first-toggle.png') });

      // Check screen still has non-zero dimensions after first toggle
      const firstToggleScreen = await page.evaluate(() => {
        const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
        const rect = screen ? screen.getBoundingClientRect() : null;
        return { width: rect ? rect.width : 0, height: rect ? rect.height : 0 };
      });
      console.log(`  [T3] After first toggle (${afterFirstToggleLabel}) screen dims:`, JSON.stringify(firstToggleScreen));
      expect(firstToggleScreen.width, `xterm-screen width after first toggle must be > 0`).toBeGreaterThan(0);
      expect(firstToggleScreen.height, `xterm-screen height after first toggle must be > 0`).toBeGreaterThan(0);

      // Check text still present after first toggle
      const markerAfterFirst = await page.evaluate(() => {
        const rows = document.querySelector('#session-overlay-terminal .xterm-rows');
        return rows ? rows.textContent.includes('SPLIT_TEST_123') : false;
      });
      console.log(`  [T3] Marker after first toggle: ${markerAfterFirst}`);
      expect(markerAfterFirst, `SPLIT_TEST_123 must still be in terminal after first toggle`).toBe(true);

      // ── Second toggle: click the opposite button ────────────────────────────
      const secondToggleLabel = initialState === 'Full' ? 'Split' : 'Full';
      const secondToggleBtn = page.locator(`button:has-text("${secondToggleLabel}")`).first();
      await expect(secondToggleBtn, `"${secondToggleLabel}" button must be visible after first toggle`).toBeVisible({ timeout: 5000 });
      await secondToggleBtn.click();
      await sleep(800);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-after-second-toggle.png') });

      const secondToggleScreen = await page.evaluate(() => {
        const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
        const rect = screen ? screen.getBoundingClientRect() : null;
        return { width: rect ? rect.width : 0, height: rect ? rect.height : 0 };
      });
      console.log(`  [T3] After second toggle screen dims:`, JSON.stringify(secondToggleScreen));
      expect(secondToggleScreen.width, `xterm-screen width after second toggle must be > 0`).toBeGreaterThan(0);
      expect(secondToggleScreen.height, `xterm-screen height after second toggle must be > 0`).toBeGreaterThan(0);

      const markerAfterSecond = await page.evaluate(() => {
        const rows = document.querySelector('#session-overlay-terminal .xterm-rows');
        return rows ? rows.textContent.includes('SPLIT_TEST_123') : false;
      });
      console.log(`  [T3] Marker after second toggle: ${markerAfterSecond}`);
      expect(markerAfterSecond, `SPLIT_TEST_123 must still be in terminal after second toggle`).toBe(true);

      // Map back to canonical naming for log readability
      const splitScreen = initialState === 'Full' ? firstToggleScreen : secondToggleScreen;
      const fullScreen = initialState === 'Full' ? secondToggleScreen : firstToggleScreen;
      console.log('  [T3] Split mode screen dims:', JSON.stringify(splitScreen));
      console.log('  [T3] Full mode screen dims:', JSON.stringify(fullScreen));

      console.log('  [T3] PASS');
    } finally {
      await browser.close();
    }
  });
});
