/**
 * T-4: Terminal renders in headless/no-WebGL environment
 *
 * Launches with --disable-gpu to force WebGL unavailable. Verifies
 * that the terminal falls back to Canvas/DOM renderer and renders content.
 *
 * Port: 3403
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
const PORT = 3403;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'black-box-T4');
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

test.describe('T-4 — Terminal renders in no-GPU/no-WebGL environment', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-bb-T4-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [T4-srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [T4-srv:err] ${d}`));

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) break; } catch {}
      await sleep(500);
    }

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T4-Project', path: '/tmp' }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    const ws = await wsConnect(PORT);
    await waitForMsg(ws, m => m.type === 'init');
    ws.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 't4-bash',
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
    console.log(`  [T4] Setup: project=${projectId}, session=${sessionId}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} await sleep(1000); try { serverProc.kill('SIGKILL'); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('T-4: terminal renders content with --disable-gpu (no WebGL)', async () => {
    test.setTimeout(90000);

    // Launch with --disable-gpu to force WebGL unavailable
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error') {
        consoleErrors.push(text);
        console.log(`  [T4-browser:err] ${text}`);
      } else if (text.includes('[TerminalPane]') || text.includes('WebGL') || text.includes('webgl')) {
        console.log(`  [T4-browser:log] ${text}`);
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      await page.waitForSelector('text=T4-Project', { timeout: 15000 });
      await page.click('text=T4-Project');
      await page.waitForSelector('.session-card', { timeout: 10000 });
      await sleep(500);

      const sessionCard = page.locator('.session-card').first();
      await sessionCard.click();

      await page.waitForSelector('#session-overlay', { timeout: 10000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: 10000 });

      // Wait for rows to render
      await page.waitForFunction(() => {
        const rows = document.querySelector('#session-overlay-terminal .xterm-rows');
        return rows && rows.children.length > 2;
      }, { timeout: 15000 }).catch(() => {});

      await sleep(2000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-nogpu-terminal.png') });

      // Send test output
      const ws2 = await wsConnect(PORT);
      await waitForMsg(ws2, m => m.type === 'init');
      ws2.send(JSON.stringify({ type: 'session:subscribe', id: sessionId, cols: 120, rows: 30 }));
      await waitForMsg(ws2,
        m => (m.type === 'session:subscribed' && m.id === sessionId) || (m.type === 'session:output' && m.id === sessionId),
        10000
      );
      await sleep(500);
      ws2.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo NOGPU_TEST\n' }));

      const markerFound = await page.waitForFunction(() => {
        const rows = document.querySelector('#session-overlay-terminal .xterm-rows');
        return rows && rows.textContent.includes('NOGPU_TEST');
      }, { timeout: 8000 }).then(() => true).catch(() => false);

      ws2.close();
      console.log(`  [T4] NOGPU_TEST marker found: ${markerFound}`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-nogpu-with-output.png') });

      // Check xterm-screen has dimensions
      const screenDims = await page.evaluate(() => {
        const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
        const rect = screen ? screen.getBoundingClientRect() : null;
        return { width: rect ? rect.width : 0, height: rect ? rect.height : 0 };
      });
      console.log('  [T4] Screen dims:', JSON.stringify(screenDims));

      // Filter errors: only fail on unrecovered WebGL errors, not normal fallback messages
      const criticalErrors = consoleErrors.filter(e =>
        !e.includes('WebGL') && // WebGL errors are expected in --disable-gpu mode
        !e.includes('webgl') &&
        !e.includes('CONTEXT_LOST') &&
        !e.includes('WebglAddon') &&
        !e.includes('CanvasAddon') &&
        e.trim().length > 0
      );
      console.log(`  [T4] Console errors (non-WebGL): ${JSON.stringify(criticalErrors)}`);

      expect(screenDims.width, 'xterm-screen width must be > 0 in no-GPU mode').toBeGreaterThan(0);
      expect(screenDims.height, 'xterm-screen height must be > 0 in no-GPU mode').toBeGreaterThan(0);
      expect(markerFound, 'NOGPU_TEST must appear in terminal (Canvas/DOM fallback rendering works)').toBe(true);
      // No critical (non-WebGL) errors
      expect(criticalErrors.length, `No critical browser errors expected, got: ${JSON.stringify(criticalErrors)}`).toBe(0);

      console.log('  [T4] PASS');
    } finally {
      await browser.close();
    }
  });
});
