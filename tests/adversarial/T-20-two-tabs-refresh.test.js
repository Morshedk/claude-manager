/**
 * T-20: Two Browser Tabs Watching Same Session — One Refreshes, Other Updates
 *
 * Score: L=2 S=4 D=5 (Total: 11)
 * Port: 3117
 *
 * Flow:
 *   - Two browser contexts both open the same bash session in the terminal overlay.
 *   - Tab 1 clicks Refresh.
 *   - Verify Tab 2 receives session:subscribed (xterm.reset fires, old content gone).
 *   - Verify no cross-PTY bleed in Tab 2.
 *   - Verify Tab 2's session card badge updates to running.
 *   - Verify Tab 2 receives new PTY output after refresh.
 *
 * Design: tests/adversarial/designs/T-20-design.md (pre-existing)
 *
 * Run: npx playwright test tests/adversarial/T-20-two-tabs-refresh.test.js --reporter=list --timeout=120000
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
const PORT = 3117;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T20-two-tabs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── WS helpers ────────────────────────────────────────────────────────────────

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

function waitForWsMessage(ws, predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS waitForMessage timeout after ${timeout}ms`)), timeout);
    function onMsg(d) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    }
    ws.on('message', onMsg);
  });
}

function sendWs(ws, msg) {
  ws.send(JSON.stringify(msg));
}

// ── Shared state ──────────────────────────────────────────────────────────────

let serverProc = null;
let tmpDir = '';
let projectId = 'proj-t20';
let testSessionId = null;
let ctrlWs = null;

test.describe('T-20 — Two Tabs, One Refresh', () => {

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3117
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T20-XXXXXX').toString().trim();
    console.log(`\n  [T-20] tmpDir: ${tmpDir}`);

    // Pre-seed projects.json
    const projectsData = {
      projects: [{
        id: projectId,
        name: 'T20-Project',
        path: tmpDir,
        createdAt: '2026-01-01T00:00:00Z',
      }],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(projectsData, null, 2));

    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Poll until ready
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 20s');
    console.log(`  [T-20] Server ready on port ${PORT}`);

    // Connect control WS
    ctrlWs = await connectWs();
    await waitForWsMessage(ctrlWs, m => m.type === 'init' || m.type === 'server:init', 5000)
      .catch(() => console.log('  [T-20] No init message'));

    // Create bash session
    sendWs(ctrlWs, {
      type: 'session:create',
      projectId,
      name: 't20-shared-session',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    });
    const created = await waitForWsMessage(ctrlWs, m => m.type === 'session:created', 10000);
    testSessionId = created.session.id;
    console.log(`  [T-20] Created session: ${testSessionId}`);

    // Wait for session running
    const deadline2 = Date.now() + 10000;
    while (Date.now() < deadline2) {
      const sessionsData = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
      const allSessions = sessionsData.managed || sessionsData.sessions || (Array.isArray(sessionsData) ? sessionsData : []);
      const s = allSessions.find(s => s.id === testSessionId);
      if (s && (s.state === 'running' || s.status === 'running')) break;
      await sleep(300);
    }
    console.log(`  [T-20] Session running`);

    // NOTE: Do NOT write PRE_REFRESH_MARKER here — it will be wiped by xterm.reset()
    // when the browser subscribes. Marker will be written AFTER both tabs subscribe.
    console.log(`  [T-20] Session ready — markers will be written after browser subscribes`);
  });

  test.afterAll(async () => {
    try { sendWs(ctrlWs, { type: 'session:stop', id: testSessionId }); await sleep(200); } catch {}
    if (ctrlWs) try { ctrlWs.close(); } catch {}
    if (serverProc) serverProc.kill('SIGTERM');
    await sleep(500);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('T-20 — two tabs: Tab 1 refresh, Tab 2 auto-reconnects', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      // ─── Navigate both tabs ───────────────────────────────────────────────
      console.log('\n  [T-20] Navigating both tabs');
      await Promise.all([
        page1.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }),
        page2.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }),
      ]);
      await sleep(1000);

      // ─── Open overlay in both tabs ────────────────────────────────────────
      async function openOverlay(page, label) {
        const projectItem = page.locator('.project-item', { hasText: 'T20-Project' });
        await projectItem.waitFor({ timeout: 8000 });
        await projectItem.click();
        await sleep(300);

        // Click session card to open overlay
        const sessionCard = page.locator('.session-card', { hasText: 't20-shared-session' });
        await sessionCard.waitFor({ timeout: 5000 });
        await sessionCard.click();

        // Wait for overlay
        await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 8000 });
        console.log(`  [T-20] ${label}: overlay opened`);
        await sleep(1000); // settle
      }

      await openOverlay(page1, 'Tab1');
      await openOverlay(page2, 'Tab2');

      console.log('  [T-20] Both tabs have overlay open');
      await sleep(1500); // wait for xterm.reset on subscribe + initial output

      // Write PRE_REFRESH_MARKER AFTER both tabs have subscribed
      // (so xterm.reset() on subscribe doesn't wipe it)
      sendWs(ctrlWs, { type: 'session:input', id: testSessionId, data: 'echo T20_PRE_REFRESH_MARKER\r' });
      console.log('  [T-20] PRE_REFRESH_MARKER written (after subscribe)');
      await sleep(800); // wait for PTY to echo it

      // ─── Verify PRE_REFRESH_MARKER visible in both tabs ──────────────────
      async function checkMarker(page, marker, label, shouldFind, timeout = 8000) {
        try {
          await page.waitForFunction(
            (m) => {
              const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
              return screen ? screen.textContent.includes(m) : false;
            },
            marker,
            { timeout }
          );
          if (shouldFind) {
            console.log(`  [T-20] ${label}: "${marker}" FOUND ✓`);
            return true;
          } else {
            console.log(`  [T-20] ${label}: "${marker}" unexpectedly FOUND (FAIL)`);
            return false;
          }
        } catch {
          if (!shouldFind) {
            console.log(`  [T-20] ${label}: "${marker}" absent ✓`);
            return true;
          } else {
            console.log(`  [T-20] ${label}: "${marker}" NOT found (may be in scrollback; checking DOM)`);
            // Extended check: look at all xterm rows
            const found = await page.evaluate((m) => {
              const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
              for (const r of rows) if (r.textContent.includes(m)) return true;
              return false;
            }, marker);
            console.log(`  [T-20] ${label}: DOM row scan for "${marker}": ${found}`);
            return found;
          }
        }
      }

      // Both tabs should show PRE_REFRESH_MARKER

      const preMarker1 = await checkMarker(page1, 'T20_PRE_REFRESH_MARKER', 'Tab1', true, 8000);
      const preMarker2 = await checkMarker(page2, 'T20_PRE_REFRESH_MARKER', 'Tab2', true, 8000);

      if (!preMarker1 || !preMarker2) {
        // Take diagnostic screenshots
        await page1.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T20-DIAG-tab1-no-premarker.png') });
        await page2.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T20-DIAG-tab2-no-premarker.png') });
        throw new Error(`PRE-CONDITION FAILED: PRE_REFRESH_MARKER not visible. Tab1: ${preMarker1}, Tab2: ${preMarker2}`);
      }

      await page1.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T20-01-tab1-pre-refresh.png') });
      await page2.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T20-02-tab2-pre-refresh.png') });

      // ─── Write OLD_PTY_SENTINEL before refresh ────────────────────────────
      sendWs(ctrlWs, { type: 'session:input', id: testSessionId, data: 'echo T20_OLD_PTY_SENTINEL\r' });
      await sleep(500);
      console.log('  [T-20] T20_OLD_PTY_SENTINEL written to old PTY');

      // ─── Tab 1 clicks Refresh ─────────────────────────────────────────────
      console.log('  [T-20] Tab1 clicking Refresh');
      const refreshBtn = page1.locator('button[title="Refresh session"]');
      await refreshBtn.waitFor({ timeout: 5000 });
      await refreshBtn.click();
      const refreshTs = Date.now();

      // Wait for Tab1 toast
      await page1.waitForFunction(
        () => document.body.textContent.includes('Refreshing'),
        { timeout: 3000 }
      ).catch(() => {});
      console.log(`  [T-20] Refresh clicked at +${Date.now() - refreshTs}ms`);

      await page2.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T20-03-tab2-during-refresh.png') });

      // ─── Core assertion 1: Tab2's PRE_REFRESH_MARKER disappears ──────────
      console.log('  [T-20] Waiting for Tab2 xterm.reset (PRE_REFRESH_MARKER to disappear)');
      await page2.waitForFunction(
        () => {
          const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
          for (const r of rows) {
            if (r.textContent.includes('T20_PRE_REFRESH_MARKER')) return false;
          }
          return true;
        },
        { timeout: 8000 }
      );
      console.log(`  [T-20] Tab2: PRE_REFRESH_MARKER disappeared (xterm.reset fired) ✓ (+${Date.now() - refreshTs}ms)`);

      // ─── Core assertion 2: OLD_PTY_SENTINEL absent from Tab2 ─────────────
      const hasOldSentinel = await page2.evaluate(() => {
        const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
        for (const r of rows) {
          if (r.textContent.includes('T20_OLD_PTY_SENTINEL')) return true;
        }
        return false;
      });
      expect(hasOldSentinel, 'Tab2: T20_OLD_PTY_SENTINEL must NOT appear (no cross-PTY bleed)').toBe(false);
      console.log('  [T-20] Tab2: T20_OLD_PTY_SENTINEL absent (no cross-PTY bleed) ✓');

      // ─── Core assertion 3: Tab2 badge updates to running ─────────────────
      console.log('  [T-20] Waiting for Tab2 session badge to show running');
      await page2.waitForFunction(
        (name) => {
          const cards = document.querySelectorAll('.session-card');
          for (const card of cards) {
            if (card.textContent.includes(name)) {
              return card.textContent.toLowerCase().includes('running');
            }
          }
          return false;
        },
        't20-shared-session',
        { timeout: 12000 }
      );
      console.log(`  [T-20] Tab2: session badge shows "running" ✓ (+${Date.now() - refreshTs}ms)`);

      // ─── Core assertion 4: Tab2 receives POST_REFRESH output ─────────────
      // Wait for session running on API first
      const apiDeadline = Date.now() + 10000;
      while (Date.now() < apiDeadline) {
        const sessionsData = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
        const allSessions = sessionsData.managed || sessionsData.sessions || (Array.isArray(sessionsData) ? sessionsData : []);
        const s = allSessions.find(s => s.id === testSessionId);
        if (s && (s.state === 'running' || s.status === 'running')) break;
        await sleep(300);
      }

      sendWs(ctrlWs, { type: 'session:input', id: testSessionId, data: 'echo T20_POST_REFRESH_MARKER\r' });
      console.log('  [T-20] T20_POST_REFRESH_MARKER written to new PTY');

      await page2.waitForFunction(
        () => {
          const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
          return screen ? screen.textContent.includes('T20_POST_REFRESH_MARKER') : false;
        },
        { timeout: 12000 }
      );
      console.log(`  [T-20] Tab2: T20_POST_REFRESH_MARKER received ✓ (+${Date.now() - refreshTs}ms)`);

      // ─── Core assertion 5: Tab1 also receives post-refresh output ─────────
      await page1.waitForFunction(
        () => {
          const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
          return screen ? screen.textContent.includes('T20_POST_REFRESH_MARKER') : false;
        },
        { timeout: 10000 }
      );
      console.log(`  [T-20] Tab1: T20_POST_REFRESH_MARKER received ✓`);

      await page1.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T20-04-tab1-post-refresh.png') });
      await page2.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T20-05-tab2-post-refresh.png') });

      // ─── Cross-PTY bleed check after new output ───────────────────────────
      sendWs(ctrlWs, { type: 'session:input', id: testSessionId, data: 'echo T20_NEW_PTY_ONLY_MARKER\r' });
      await sleep(1000);

      const stillHasOldSentinel = await page2.evaluate(() => {
        const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
        for (const r of rows) {
          if (r.textContent.includes('T20_OLD_PTY_SENTINEL')) return true;
        }
        return false;
      });
      expect(stillHasOldSentinel, 'Tab2: old PTY bleed must NOT occur even after new output arrives').toBe(false);
      console.log('  [T-20] Tab2: No cross-PTY bleed after new output ✓');

      // ─── API confirmation: session is running ─────────────────────────────
      const finalSessionsData = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
      const finalAllSessions = finalSessionsData.managed || finalSessionsData.sessions || (Array.isArray(finalSessionsData) ? finalSessionsData : []);
      const finalSession = finalAllSessions.find(s => s.id === testSessionId);
      const finalState = finalSession?.state || finalSession?.status;
      expect(['running', 'starting'].includes(finalState), `API state should be running/starting, got: ${finalState}`).toBe(true);
      console.log(`  [T-20] API: session state="${finalState}" ✓`);

      console.log('\n  [T-20] ✅ ALL ASSERTIONS PASSED');

    } finally {
      await browser.close();
    }
  });

});

// Workaround: page2.screenshot → need page var in scope (was shadowed by page1 locator)
// Correction: page1.screenshot is called directly as page1 is in scope
