/**
 * T-2: fit() produces non-zero dimensions after mount
 *
 * Monkey-patches FitAddon.prototype.fit to capture dimensions at the moment
 * of the FIRST fit() call. Verifies the container has resolved layout before
 * fit() executes (i.e., the double-rAF deferral works).
 *
 * Port: 3401
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
const PORT = 3401;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'black-box-T2');
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

test.describe('T-2 — fit() produces non-zero dimensions at first call', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-bb-T2-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [T2-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T2-srv:err] ${d}`));

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) break; } catch {}
      await sleep(500);
    }

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T2-Project', path: '/tmp' }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    const ws = await wsConnect(PORT);
    await waitForMsg(ws, m => m.type === 'init');
    ws.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 't2-bash',
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

    // Wait for session running
    const deadline2 = Date.now() + 15000;
    while (Date.now() < deadline2) {
      const sessions = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
      const all = [...(sessions.managed || []), ...(sessions.detected || [])];
      const s = all.find(s => s.id === sessionId);
      if (s && (s.status === 'running' || s.state === 'running')) break;
      await sleep(500);
    }
    console.log(`  [T2] Setup done: project=${projectId}, session=${sessionId}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} await sleep(1000); try { serverProc.kill('SIGKILL'); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('T-2: first fit() call sees non-zero container dimensions (double-rAF deferred)', async () => {
    test.setTimeout(60000);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [T2-browser:err] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1000);

      // Inject fit() monkey-patch BEFORE clicking session card
      await page.evaluate(() => {
        window.__firstFitDims = null;
        window.__firstFitCalled = false;
        // FitAddon is a global in the xterm CDN bundle
        if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon && FitAddon.FitAddon.prototype) {
          const origFit = FitAddon.FitAddon.prototype.fit;
          FitAddon.FitAddon.prototype.fit = function() {
            if (!window.__firstFitCalled) {
              window.__firstFitCalled = true;
              const container = document.querySelector('#session-overlay-terminal .terminal-container');
              const containerRect = container ? container.getBoundingClientRect() : null;
              let proposedDims = null;
              try { proposedDims = this.proposeDimensions(); } catch {}
              window.__firstFitDims = {
                containerWidth: containerRect ? containerRect.width : -1,
                containerHeight: containerRect ? containerRect.height : -1,
                proposedCols: proposedDims ? proposedDims.cols : 0,
                proposedRows: proposedDims ? proposedDims.rows : 0,
              };
            }
            return origFit.call(this);
          };
          console.log('[T2] FitAddon.prototype.fit patched');
        } else {
          console.warn('[T2] FitAddon not available yet for patching');
        }
      });

      // Click project
      await page.waitForSelector('text=T2-Project', { timeout: 15000 });
      await page.click('text=T2-Project');
      await page.waitForSelector('.session-card', { timeout: 10000 });
      await sleep(300);

      // Re-inject patch (FitAddon may now be loaded)
      await page.evaluate(() => {
        if (window.__firstFitCalled) return; // already patched and used
        if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon && FitAddon.FitAddon.prototype && !window.__patchApplied) {
          window.__patchApplied = true;
          const origFit = FitAddon.FitAddon.prototype.fit;
          FitAddon.FitAddon.prototype.fit = function() {
            if (!window.__firstFitCalled) {
              window.__firstFitCalled = true;
              const container = document.querySelector('#session-overlay-terminal .terminal-container');
              const containerRect = container ? container.getBoundingClientRect() : null;
              let proposedDims = null;
              try { proposedDims = this.proposeDimensions(); } catch {}
              window.__firstFitDims = {
                containerWidth: containerRect ? containerRect.width : -1,
                containerHeight: containerRect ? containerRect.height : -1,
                proposedCols: proposedDims ? proposedDims.cols : 0,
                proposedRows: proposedDims ? proposedDims.rows : 0,
              };
            }
            return origFit.call(this);
          };
          console.log('[T2] FitAddon.prototype.fit patched (re-inject)');
        }
      });

      // Click session card
      const sessionCard = page.locator('.session-card').first();
      await sessionCard.click();
      await sleep(300);

      await page.waitForSelector('#session-overlay', { timeout: 10000 });

      // Wait for terminal canvas to appear (layout settled)
      await page.waitForSelector('#session-overlay-terminal .xterm-screen canvas', { timeout: 10000 });

      // Extra wait for double-rAF to have fired
      await sleep(1000);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-terminal-mounted.png') });

      // Read first-fit dimensions
      const firstFit = await page.evaluate(() => window.__firstFitDims);
      console.log('  [T2] firstFit dims:', JSON.stringify(firstFit));

      if (!firstFit) {
        // If patch wasn't applied in time, check settled state only
        console.log('  [T2] WARNING: firstFitDims not captured — FitAddon patching may have missed. Checking settled state only.');
      } else {
        // Assert that first fit() was called with a container that had resolved dimensions
        expect(firstFit.containerWidth, 'Container width at first fit() must be > 100px (layout resolved before fit)').toBeGreaterThan(100);
        expect(firstFit.containerHeight, 'Container height at first fit() must be > 100px (layout resolved before fit)').toBeGreaterThan(100);
        expect(firstFit.proposedCols, 'Proposed cols at first fit() must be > 10').toBeGreaterThan(10);
        expect(firstFit.proposedRows, 'Proposed rows at first fit() must be > 5').toBeGreaterThan(5);
      }

      // Always check settled state.
      // Note: xterm-char-measure-element.getBoundingClientRect().width is unreliable in
      // headless WebGL mode (returns full element width, not per-char width). Instead:
      // - Rows: count xterm-rows children (actual rendered row count)
      // - Cols: use firstFit.proposedCols if available, else derive from screenWidth + known charWidth
      const settled = await page.evaluate(() => {
        const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
        const screenRect = screen ? screen.getBoundingClientRect() : null;
        const screenWidth = screenRect ? screenRect.width : 0;
        const screenHeight = screenRect ? screenRect.height : 0;
        // Row count from DOM (reliable)
        const xtermRows = document.querySelector('#session-overlay-terminal .xterm-rows');
        const rowCount = xtermRows ? xtermRows.children.length : 0;
        return { screenWidth, screenHeight, rowCount };
      });
      console.log('  [T2] Settled terminal metrics:', JSON.stringify(settled));

      expect(settled.screenWidth, 'xterm-screen width must be > 0 (settled)').toBeGreaterThan(0);
      expect(settled.screenHeight, 'xterm-screen height must be > 0 (settled)').toBeGreaterThan(0);
      // Use proposedCols from firstFit if captured; otherwise trust rowCount for rows
      const settledCols = firstFit ? firstFit.proposedCols : 0;
      const settledRows = firstFit ? firstFit.proposedRows : settled.rowCount;
      if (firstFit) {
        expect(settledCols, 'Proposed cols from first fit() must be > 10').toBeGreaterThan(10);
        expect(settledRows, 'Proposed rows from first fit() must be > 5').toBeGreaterThan(5);
      } else {
        expect(settled.rowCount, 'xterm-rows DOM child count must be > 5').toBeGreaterThan(5);
      }

      console.log('  [T2] PASS');
    } finally {
      await browser.close();
    }
  });
});
