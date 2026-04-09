/**
 * T-6: PTY subscribe dimensions match rendered canvas (no 120x30 fallback on 0x0 canvas)
 *
 * Intercepts the session:subscribe WebSocket message sent by the client and
 * checks that cols/rows are non-zero and match the actual rendered terminal
 * grid size. If fit() computed against a 0x0 container, proposeDimensions()
 * would return null and the hardcoded fallback (120x30) would be used.
 *
 * Port: 3405
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
const PORT = 3405;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'black-box-T6');
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

test.describe('T-6 — PTY subscribe dimensions match rendered canvas', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-bb-T6-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [T6-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T6-srv:err] ${d}`));

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) break; } catch {}
      await sleep(500);
    }

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T6-Project', path: '/tmp' }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    const ws = await wsConnect(PORT);
    await waitForMsg(ws, m => m.type === 'init');
    ws.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 't6-bash',
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
    console.log(`  [T6] Setup: project=${projectId}, session=${sessionId}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} await sleep(1000); try { serverProc.kill('SIGKILL'); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('T-6: session:subscribe sends real dimensions (not 120x30 fallback from 0x0 fit)', async () => {
    test.setTimeout(60000);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [T6-browser:err] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1000);

      // Inject WebSocket send interceptor BEFORE clicking the session card.
      // This captures the session:subscribe message the client sends.
      await page.evaluate(() => {
        window.__subscribeDims = null;
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'session:subscribe' && !window.__subscribeDims) {
              window.__subscribeDims = { cols: msg.cols, rows: msg.rows };
              console.log('[T6] Captured session:subscribe dims:', JSON.stringify(window.__subscribeDims));
            }
          } catch {}
          return origSend.call(this, data);
        };
        console.log('[T6] WebSocket.prototype.send interceptor installed');
      });

      // Click the project in sidebar
      await page.waitForSelector('text=T6-Project', { timeout: 15000 });
      await page.click('text=T6-Project');
      await page.waitForSelector('.session-card', { timeout: 10000 });
      await sleep(300);

      // Click session card to open overlay (triggers the double-rAF -> fit() -> subscribe)
      const sessionCard = page.locator('.session-card').first();
      await sessionCard.click();
      await sleep(300);

      await page.waitForSelector('#session-overlay', { timeout: 10000 });

      // Wait for terminal canvas to appear and settle
      await page.waitForSelector('#session-overlay-terminal .xterm-screen canvas', { timeout: 10000 });

      // Wait for the double-rAF to have fired (subscribe happens inside it)
      await sleep(1500);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-terminal-mounted.png') });

      // Read captured subscribe dimensions
      const subDims = await page.evaluate(() => window.__subscribeDims);
      console.log('  [T6] Captured subscribe dims:', JSON.stringify(subDims));

      // Read the actual rendered terminal dimensions.
      // Note: xterm-char-measure-element.getBoundingClientRect().width is unreliable in
      // headless WebGL mode. Instead use xterm-screen dimensions and xterm-rows child count.
      const rendered = await page.evaluate(() => {
        const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
        const screenRect = screen ? screen.getBoundingClientRect() : null;
        const screenWidth = screenRect ? screenRect.width : 0;
        const screenHeight = screenRect ? screenRect.height : 0;
        // Row count from DOM (reliable — xterm always renders one div per row)
        const xtermRows = document.querySelector('#session-overlay-terminal .xterm-rows');
        const rowCount = xtermRows ? xtermRows.children.length : 0;
        return { screenWidth, screenHeight, rowCount };
      });
      console.log('  [T6] Rendered terminal metrics:', JSON.stringify(rendered));

      // Assert subscribe dims were captured
      expect(subDims, 'session:subscribe message must have been intercepted').not.toBeNull();
      expect(subDims.cols, 'session:subscribe cols must be > 0 (not 0 from failed fit)').toBeGreaterThan(0);
      expect(subDims.rows, 'session:subscribe rows must be > 0 (not 0 from failed fit)').toBeGreaterThan(0);

      // Assert rendered screen has valid dimensions
      expect(rendered.screenWidth, 'xterm-screen width must be > 0').toBeGreaterThan(0);
      expect(rendered.screenHeight, 'xterm-screen height must be > 0').toBeGreaterThan(0);
      expect(rendered.rowCount, 'xterm-rows must have > 5 rendered rows').toBeGreaterThan(5);

      // Key assertion: subscribe dimensions are plausible for the actual screen size.
      // When fit() computed against a 0x0 container, proposeDimensions() returns null and
      // the hardcoded fallback cols:120 rows:30 is sent to the PTY regardless of screen size.
      // On a 1280x800 viewport at 13px font, the terminal area is ~618px wide → ~79 cols.
      // Derived cell width from subscribe dims: screenWidth / cols. For a valid fit,
      // this should be a realistic character width (5–15px for 13px monospace font).
      const derivedCellWidth = rendered.screenWidth > 0 && subDims.cols > 0
        ? rendered.screenWidth / subDims.cols
        : 0;
      const derivedCellHeight = rendered.screenHeight > 0 && subDims.rows > 0
        ? rendered.screenHeight / subDims.rows
        : 0;
      console.log(`  [T6] Derived cell: width=${derivedCellWidth.toFixed(1)}px height=${derivedCellHeight.toFixed(1)}px`);
      console.log(`  [T6] subscribe: cols=${subDims.cols} rows=${subDims.rows} | screen: ${rendered.screenWidth}x${rendered.screenHeight} rowCount=${rendered.rowCount}`);

      // Cell width must be plausible for a 13px monospace font (5–18px range).
      // If cols=120 was the fallback for a 618px screen, derivedCellWidth = 618/120 ≈ 5.15px — right at edge.
      // If cols=79 (correct fit), derivedCellWidth = 618/79 ≈ 7.8px — solidly in range.
      // We use > 6px as the threshold because 120x30 fallback on a ~618px screen gives ~5.1px (below threshold).
      expect(derivedCellWidth,
        `Cell width (screenWidth/cols = ${rendered.screenWidth}/${subDims.cols} = ${derivedCellWidth.toFixed(1)}px) must be ≥ 6px for a 13px font — a value < 6px means the 120x30 fallback was used on a narrow screen`
      ).toBeGreaterThanOrEqual(6);

      // Subscribe rows must match rendered row count (within tolerance of 2)
      const rowsMatch = Math.abs(subDims.rows - rendered.rowCount) <= 2;
      console.log(`  [T6] rows match: subscribe=${subDims.rows} rendered=${rendered.rowCount} match=${rowsMatch}`);
      expect(rowsMatch,
        `subscribe rows (${subDims.rows}) must match rendered row count (${rendered.rowCount}) within ±2`
      ).toBe(true);

      console.log('  [T6] PASS');
    } finally {
      await browser.close();
    }
  });
});
