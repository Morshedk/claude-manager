/**
 * Category F: Bug Reproduction Tests
 *
 * Purpose: FAIL when bugs are present, PASS when fixed.
 * Write the test first — confirm it fails — then fix the bug — confirm it passes.
 *
 * Bug 1 — New Project button is a dead stub
 *   onClick: "/* new project modal — phase 5D *\/"
 *   Expected: clicking the button opens a modal for entering project details
 *
 * Bug 2 — session:subscribed not re-sent after Refresh
 *   Expected: Refresh broadcasts session:subscribed so xterm.reset() fires in the browser;
 *             session remains responsive to input after refresh
 *
 * Bug 3 — Refresh throws "no recovery path" when session is not RUNNING
 *   Expected: Refresh from STOPPED/ERROR state restarts session fresh
 *   Currently: DirectSession.refresh() throws if status !== RUNNING
 *
 * Run: npx playwright test tests/adversarial/F-bug-reproductions.test.js --reporter=line
 * Run slow: SLOW=1 npx playwright test ...
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
const PORT = 3098;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'F-bug-reproductions');

const SLOW = !!process.env.SLOW;
const humanDelay = SLOW ? (ms = 800) => new Promise(r => setTimeout(r, ms)) : () => Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Server lifecycle — wrapped in describe so beforeAll/afterAll run ONCE ────
test.describe('F — Bug Reproduction Tests', () => {

  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-F-bugs-XXXXXX').toString().trim();

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stderr.write(`  [srv:err] ${d}`));

    // Wait for server ready (up to 25s)
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');

    // Create test project via REST API (New Project button is one of the bugs we're testing)
    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'F-bug-repro', path: projPath }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`\n  [setup] Server ready on port ${PORT}, projectId=${testProjectId}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch {} serverProc = null; }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
  });

  // ── Browser helper ──────────────────────────────────────────────────────────

  /**
   * Open a fresh browser page, navigate to the app, and wait for the UI to settle.
   *
   * The app loads Preact from https://esm.sh CDN (slow) then:
   *   1. WS connects → server sends init
   *   2. init handler calls loadProjects() and loadSessions() (async REST fetches)
   *   3. After fetches complete → sidebar re-renders with data
   *
   * We wait for 'domcontentloaded' then explicitly wait for the WS "Connected"
   * indicator, which proves init was received and loadProjects() was at least called.
   * Then we wait an extra settle period for the async fetches to complete.
   */
  async function openApp(browser) {
    const page = await browser.newPage();

    // Capture console errors for debugging
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the "Connected" status indicator — proves WS init was received
    // and loadProjects() was called
    await page.waitForFunction(
      () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
            document.body.textContent.includes('Connected'),
      { timeout: 30000 }
    );

    // Extra settle for the async loadProjects/loadSessions fetches to resolve
    // and Preact to re-render with the data
    await sleep(SLOW ? 2000 : 1200);

    return page;
  }

  /**
   * Select the test project in the sidebar and wait for session cards to appear.
   * Returns true if the project panel loaded, false if no project items found.
   */
  async function selectTestProject(page) {
    const projectItem = page.locator('#project-sidebar .project-item').first();
    if (await projectItem.count() === 0) {
      console.log('  [nav] No project items in sidebar');
      return false;
    }
    await projectItem.click();
    await humanDelay(600);
    return true;
  }

  // ── WS helpers ─────────────────────────────────────────────────────────────

  function wsConnect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
      setTimeout(() => reject(new Error('WS connect timeout')), 8000);
    });
  }

  function waitForMsg(ws, predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', handler);
        reject(new Error(`waitForMsg timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      function handler(raw) {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (predicate(msg)) { clearTimeout(timer); ws.off('message', handler); resolve(msg); }
      }
      ws.on('message', handler);
    });
  }

  async function createSession(command, name) {
    const ws = await wsConnect();
    await sleep(300);
    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: testProjectId,
      name,
      command,
      mode: 'direct',
      cwd: tmpDir,
      cols: 120,
      rows: 30,
    }));
    const created = await waitForMsg(ws,
      m => m.type === 'session:created' || m.type === 'session:error', 15000);
    ws.close();
    if (created.type === 'session:error') throw new Error(`create error: ${created.error}`);
    return created.session;
  }

  async function waitForStatus(sessionId, status, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
      const all = Array.isArray(data.managed) ? data.managed : [];
      const s = all.find(s => s.id === sessionId);
      if (s && (s.status === status || s.state === status)) return s;
      await sleep(300);
    }
    throw new Error(`Session ${sessionId} never reached status "${status}" in ${timeoutMs}ms`);
  }

  // ── Bug 1: New Project button is a dead stub ──────────────────────────────

  test('Bug 1: New Project button opens a project creation modal', async () => {
    // Diagnostic: verify project exists in API BEFORE opening browser
    const apiCheck = await fetch(`${BASE_URL}/api/projects`).then(r => r.json());
    console.log(`  [bug1] API projects before browser: ${JSON.stringify(apiCheck)}`);
    if (!Array.isArray(apiCheck) || apiCheck.length === 0) {
      throw new Error(`Test setup failure: no projects in API. beforeAll may not have run correctly.`);
    }

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await openApp(browser);

      // Take a screenshot to confirm the app rendered
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'bug1-01-app-loaded.png') });

      const sidebar = page.locator('#project-sidebar');
      await expect(sidebar).toBeVisible({ timeout: 15000 });
      console.log('  [bug1] Sidebar is visible');

      // The "New Project" button is in the sidebar footer
      const btn = page.locator('#project-sidebar button:has-text("New Project")');
      await expect(btn).toBeVisible({ timeout: 5000 });
      console.log('  [bug1] New Project button found, clicking...');
      await humanDelay(500);
      await btn.click();
      await humanDelay(800);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'bug1-02-after-click.png') });

      // Expected: a modal appears for entering project name and path.
      // Currently fails: onClick is a no-op comment "/* new project modal — phase 5D */"
      const modal = page.locator('dialog, [role="dialog"], .modal, [class*="modal"]');
      await expect(modal).toBeVisible({ timeout: 2000 });

      const input = modal.locator('input');
      await expect(input.first()).toBeVisible({ timeout: 1000 });
      console.log('  [bug1] PASS — modal appeared with input field');
    } finally {
      await browser.close();
    }
  });

  // ── Bug 2: session:subscribed not re-sent after Refresh ──────────────────

  test('Bug 2: Refresh re-sends session:subscribed and session stays responsive', async () => {
    // Create a bash session first, then test the Refresh button in the browser UI.
    // After clicking Refresh, verify:
    //   a) session:subscribed is re-broadcast to connected subscribers (via WS sniffer)
    //   b) the session is still responsive to input
    //
    // FAILS: session:subscribed is not re-sent, terminal shows stale/garbled buffer

    const session = await createSession('bash', 'F-bug2-bash');
    await waitForStatus(session.id, 'running', 8000);
    console.log(`  [bug2] Session created: ${session.id}`);

    // Set up a WS sniffer that records session:subscribed messages BEFORE the browser opens
    // (the browser's own WS connection will also send/receive these)
    const sniffer = await wsConnect();
    await sleep(300);

    // Subscribe our sniffer to the session so it receives any session:subscribed re-broadcasts
    sniffer.send(JSON.stringify({ type: 'session:subscribe', id: session.id, cols: 120, rows: 30 }));
    await waitForMsg(sniffer, m => m.type === 'session:subscribed' && m.id === session.id, 8000);
    console.log('  [bug2] WS sniffer subscribed');

    const sniffedSubscribed = [];
    sniffer.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'session:subscribed' && m.id === session.id) {
        sniffedSubscribed.push(Date.now());
        console.log(`  [bug2] Sniffer received session:subscribed at T+${sniffedSubscribed[sniffedSubscribed.length - 1]}`);
      }
    });

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await openApp(browser);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'bug2-01-app-loaded.png') });

      // Select the project to show session cards
      const sidebarVisible = await page.locator('#project-sidebar').isVisible();
      if (!sidebarVisible) throw new Error('Sidebar not visible — app did not render');

      await selectTestProject(page);

      // Wait for the session card to appear
      await page.waitForSelector('.session-card', { timeout: 10000 });
      await humanDelay(600);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'bug2-02-session-list.png') });

      // Click session card to open the overlay
      const card = page.locator('.session-card').first();
      await card.click();
      await humanDelay(800);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'bug2-03-session-overlay.png') });

      // Find and click the Refresh button
      const refreshBtn = page.locator('button:has-text("Refresh")').first();
      await expect(refreshBtn).toBeVisible({ timeout: 5000 });
      console.log('  [bug2] Clicking Refresh button in browser UI...');
      await refreshBtn.click();
      await humanDelay(SLOW ? 2000 : 1500);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'bug2-04-after-refresh.png') });

      sniffer.close();

      // Bug 2 check: session:subscribed must have been re-broadcast to our sniffer
      // The sniffer was already subscribed before Refresh. After Refresh, it should receive
      // another session:subscribed (which triggers xterm.reset() in real browser clients).
      console.log(`  [bug2] session:subscribed received by sniffer after Refresh: ${sniffedSubscribed.length}`);
      expect(
        sniffedSubscribed.length,
        'session:subscribed must be re-broadcast to existing subscribers after Refresh'
      ).toBeGreaterThan(0);

      // Responsiveness check: session still accepts input after Refresh
      const ws2 = await wsConnect();
      await sleep(300);
      ws2.send(JSON.stringify({ type: 'session:subscribe', id: session.id, cols: 120, rows: 30 }));
      await waitForMsg(ws2, m => m.type === 'session:subscribed' && m.id === session.id, 5000);

      ws2.send(JSON.stringify({ type: 'session:input', id: session.id, data: 'echo AFTER_REFRESH_OK\n' }));

      let responsive = false;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No response after Refresh')), 8000);
          ws2.on('message', raw => {
            let m; try { m = JSON.parse(raw); } catch { return; }
            if (m.type === 'session:output' && m.id === session.id &&
                typeof m.data === 'string' && m.data.includes('AFTER_REFRESH_OK')) {
              clearTimeout(timer); responsive = true; resolve();
            }
          });
        });
      } catch (e) {
        ws2.close();
        throw new Error(`Session unresponsive after Refresh: ${e.message}`);
      }
      ws2.close();
      console.log(`  [bug2] PASS — session responsive after Refresh: ${responsive}`);
    } finally {
      sniffer.close();
      await browser.close();
    }
  });

  // ── Bug 3: Refresh from non-RUNNING state throws "no recovery path" ──────

  test('Bug 3: Refresh succeeds even when session has exited (non-RUNNING state)', async () => {
    // Reproduction:
    //   1. Create /bin/true session → exits immediately → STOPPED
    //   2. Send session:refresh
    //   3. Currently: session:error "status=stopped, no recovery path"
    //   4. Expected: session:refreshed (session restarts fresh)

    const session = await createSession('/bin/true', 'F-bug3-short-lived');
    await waitForStatus(session.id, 'stopped', 8000);
    console.log(`  [bug3] Session is STOPPED (PTY exited with code 0)`);
    await humanDelay(300);

    const ws = await wsConnect();
    await sleep(300);

    // Set up response listener BEFORE sending the refresh to avoid race
    const responsePromise = waitForMsg(ws,
      m => (m.type === 'session:refreshed' || m.type === 'session:error') && m.id === session.id,
      8000
    );

    ws.send(JSON.stringify({ type: 'session:refresh', id: session.id, cols: 120, rows: 30 }));

    const response = await responsePromise;
    ws.close();

    if (response.type === 'session:error') {
      console.log(`  [bug3] REPRODUCED — server error: "${response.error}"`);
    } else {
      console.log(`  [bug3] session:refreshed received — bug may already be fixed`);
    }

    // FAILs when bug present (session:error), PASSes when fixed (session:refreshed)
    expect(response.type, `Expected session:refreshed but got: ${response.error}`).toBe('session:refreshed');
  });

}); // end describe
