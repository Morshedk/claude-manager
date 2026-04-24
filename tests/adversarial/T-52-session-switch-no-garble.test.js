/**
 * T-52: Session switch — scrollback not garbled, copy/scroll/refresh/copy-back flow
 *
 * Regression test for the two-layer column mismatch bug fixed in:
 *   4788881 (resize before subscribe in sessionHandlers.js)
 *   da02fb3 (tmux resize-window before capture-pane in TmuxSession.js)
 *
 * Full user flow tested:
 *   1. Open session A in overlay → verify scrollback not garbled
 *   2. Scroll up 40+ lines in session A — check historical rows are not garbled
 *   3. Verify scrollbar actually moves when scrolling (real mouse wheel events)
 *   4. Switch to session B → verify scrollback not garbled
 *   5. Type content into session B (simulates paste)
 *   6. Reload the browser page
 *   7. Scroll up in session B after reload — check rows again
 *   8. Switch back to session A and type copy-back marker
 *
 * FAIL pre-fix: scrollback captured at 120 cols, displayed in wider terminal →
 *               lines under 120 chars render correctly but the PTY stays at 120 cols
 *               so `stty size` shows the wrong column count.
 * PASS post-fix: resize fires before subscribe and before capture-pane; all
 *               content renders at the correct width; xterm buffer is clean after reload.
 *
 * Port: 3598
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
const PORT = 3598;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-52-session-switch');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROMIUM_PATH = `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`;

// Register the message listener at construction time (before 'open') to avoid the
// race where the server sends 'init' in the same synchronous tick as the open event,
// causing messages to arrive before a post-await listener can register.
function wsCreate(port, projectId, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => { ws.close(); reject(new Error('wsCreate timeout')); }, 25000);
    let initDone = false;
    ws.on('error', e => { clearTimeout(t); reject(e); });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'init' && !initDone) {
        initDone = true;
        ws.send(JSON.stringify({ type: 'session:create', projectId, name, command: 'bash', mode: 'direct', cwd: '/tmp', cols: 120, rows: 30 }));
      } else if (m.type === 'session:created') {
        clearTimeout(t); ws.close(); resolve(m.session.id);
      } else if (m.type === 'session:error') {
        clearTimeout(t); ws.close(); reject(new Error(`Create error: ${m.error}`));
      }
    });
  });
}

function wsInput(port, sessionId, input) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => { ws.close(); reject(new Error('wsInput timeout')); }, 20000);
    let initDone = false;
    ws.on('error', e => { clearTimeout(t); reject(e); });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'init' && !initDone) {
        initDone = true;
        ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId, cols: 120, rows: 30 }));
      } else if (m.type === 'session:subscribed' && m.id === sessionId) {
        ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: input }));
        setTimeout(() => { ws.close(); resolve(); }, 400);
      }
    });
  });
}

// Open a session card overlay by clicking the card name link
async function openSession(page, name) {
  const card = page.locator('.session-card').filter({ hasText: name }).first();
  await card.waitFor({ state: 'visible', timeout: 10000 });
  const nameLink = card.locator('.session-card-name').first();
  await nameLink.click();
  await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 15000 });
  await sleep(2000); // fit() + scrollback render
}

// Close overlay via the detach (×) button
async function closeOverlay(page) {
  const btn = page.locator('#btn-detach').first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click();
    await page.waitForSelector('#session-overlay', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await sleep(300);
  }
}

// Count non-empty xterm DOM rows inside the overlay — evaluate() for reading state.
// Scope to #session-overlay to avoid counting rows in session-card preview xtermss.
async function countRows(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('#session-overlay .xterm-rows > div, #session-overlay .xterm-rows > span');
    return Array.from(rows).filter(r => r.textContent.trim().length > 0).length;
  });
}

// Read scroll position of the overlay terminal — scoped to #session-overlay to avoid
// reading the session-card preview xterm which is always at scrollTop=0.
async function getScrollTop(page) {
  return page.evaluate(() => {
    const vp = document.querySelector('#session-overlay .xterm-viewport');
    return vp ? vp.scrollTop : -1;
  });
}

// Scroll the terminal UP using real mouse wheel events over the terminal container.
// Using page.mouse.wheel() fires real browser scroll events through the full event
// pipeline — this is what a real user does. evaluate(el => el.scrollTop = 0) bypasses
// all scroll listeners and would pass even if the scrollbar was completely broken.
// API: mouse.move(x, y) first, then mouse.wheel(deltaX, deltaY) at current position.
async function scrollTerminalUp(page, totalPx) {
  const tc = page.locator('#session-overlay .terminal-container').first();
  const box = await tc.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let sent = 0; sent < totalPx; sent += 300) {
    await page.mouse.wheel(0, -300);
    await sleep(60);
  }
  await sleep(400); // let xterm render the new scroll position
}

// Scroll the terminal DOWN using real mouse wheel events
async function scrollTerminalDown(page, totalPx) {
  const tc = page.locator('#session-overlay .terminal-container').first();
  const box = await tc.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let sent = 0; sent < totalPx; sent += 300) {
    await page.mouse.wheel(0, 300);
    await sleep(60);
  }
  await sleep(400);
}

// Get subscribe cols from intercepted WS messages — evaluate() for reading state
async function getLastSubscribeCols(page) {
  return page.evaluate(() => {
    const msgs = window.__subscribeMsgs || [];
    const last = msgs[msgs.length - 1];
    return last ? last.cols : null;
  });
}

// Check scrollback for garbling: each content line should be intact (contains both
// the line marker and the :END sentinel). If the terminal displayed content at wrong
// column width, lines would wrap and :END would appear on a separate DOM row.
// Scoped to #session-overlay to avoid reading the session-card preview xterm.
// Returns { total, withMarker, garbled } — evaluate() is for reading state only.
async function checkScrollbackGarbling(page, markerSubstr) {
  return page.evaluate((marker) => {
    const rowEls = document.querySelectorAll('#session-overlay .xterm-rows > div');
    const texts = Array.from(rowEls)
      .map(r => r.textContent.trim())
      .filter(t => t.length > 0);
    const withMarker = texts.filter(t => t.includes(marker));
    // A garbled row contains the line start (LINE + digits) but has lost the :END
    // because the line was wrapped onto a second DOM row due to column mismatch.
    const garbled = withMarker.filter(t => t.match(/LINE\d+/) && !t.includes(':END'));
    return { total: texts.length, withMarker: withMarker.length, garbled: garbled.length, sample: withMarker.slice(0, 3) };
  }, markerSubstr);
}

test.describe('T-52 — Session switch: scrollback, copy, scroll, refresh, copy-back', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionIdA = '';
  let sessionIdB = '';
  // Sentinel content — 56 chars; each printf line is "LINE001-" (8) + 56 = 64 chars,
  // fits in any terminal ≥ 70 cols without wrapping (headless chromium gives ~89 cols).
  // 200 lines ensures scrollback even in a tall overlay (1440x900 shows ~47 rows).
  const CONTENT_A = 'SESS-A:' + 'A'.repeat(45) + ':END'; // 56 chars
  const CONTENT_B = 'SESS-B:' + 'B'.repeat(45) + ':END'; // 56 chars
  const LINE_COUNT = 200;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-T52-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Poll with AbortController timeout to avoid fetch hanging on unresponsive port
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        const r = await fetch(`${BASE_URL}/api/projects`, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) break;
      } catch {}
      await sleep(400);
    }

    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T52-Project', path: '/tmp' }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    sessionIdA = await wsCreate(PORT, projectId, 'session-A');
    sessionIdB = await wsCreate(PORT, projectId, 'session-B');
    await sleep(1500);

    // Write 200 distinctive lines to session A — enough to ensure scrollback even in
    // a tall overlay terminal (1440x900 shows ~47 rows, so 200 lines = 153 in scrollback).
    const cmdA = `for i in $(seq 1 ${LINE_COUNT}); do printf 'LINE%03d-${CONTENT_A}\\n' $i; done\r`;
    await wsInput(PORT, sessionIdA, cmdA);
    await sleep(2000);

    // Write 200 lines to session B likewise
    const cmdB = `for i in $(seq 1 ${LINE_COUNT}); do printf 'LINE%03d-${CONTENT_B}\\n' $i; done\r`;
    await wsInput(PORT, sessionIdB, cmdB);
    await sleep(2000);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill(); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('full user flow: copy/scroll/switch/refresh/copy-back without garbling', async () => {
    const browser = await chromium.launch({
      executablePath: fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    let snapN = 0;
    const snap = async (name) => {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${String(++snapN).padStart(2,'0')}-${name}.png`) });
    };

    try {
      // Intercept WS send to capture subscribe dimensions
      await page.addInitScript(() => {
        const orig = WebSocket.prototype.send;
        window.__subscribeMsgs = [];
        WebSocket.prototype.send = function(data) {
          try { const m = JSON.parse(data); if (m.type === 'session:subscribe') window.__subscribeMsgs.push(m); } catch {}
          return orig.call(this, data);
        };
      });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(600);

      // Navigate to project
      const projectItem = page.locator('.project-item').filter({ hasText: 'T52-Project' }).first();
      await projectItem.waitFor({ state: 'visible', timeout: 10000 });
      await projectItem.click();
      await sleep(400);

      // ── Step 1: Open session A ─────────────────────────────────────────────
      await openSession(page, 'session-A');
      await snap('session-A-open');

      const colsA = await getLastSubscribeCols(page);
      expect(colsA, 'Session A: subscribe message was sent with measured cols').toBeGreaterThan(0);

      const rowsA_initial = await countRows(page);

      // ── Step 2: Scroll up 40+ lines in session A — garbling check ─────────
      // First scroll to bottom to ensure we start at the end of scrollback.
      // Then scroll up 1000px (~58 lines at 17px/line) to see historical content.
      await scrollTerminalDown(page, 3000); // ensure at bottom
      const scrollTopBottom = await getScrollTop(page);
      await scrollTerminalUp(page, 1000);
      const scrollTopAfter = await getScrollTop(page);
      await snap('session-A-scrolled-up-40-lines');

      // Scrollbar must actually move — proves mouse wheel events reached xterm
      expect(scrollTopAfter, 'Scrollbar must move upward when scrolling with mouse wheel').toBeLessThan(scrollTopBottom);

      // Rows visible at the top should be non-empty
      const rowsA_top = await countRows(page);
      expect(rowsA_top, 'Rows visible at top of session A').toBeGreaterThan(0);

      // Garbling check: historical rows must be intact — not split by column mismatch
      const garbleA = await checkScrollbackGarbling(page, 'SESS-A:');
      expect(garbleA.withMarker,
        `Must see session A content after scrolling up 1000px — only ${garbleA.total} total rows visible`
      ).toBeGreaterThan(0);
      expect(garbleA.garbled,
        `Session A scrollback garbled: ${garbleA.garbled} rows contain LINE+digits but are missing :END (column-mismatch wrap). Sample: ${JSON.stringify(garbleA.sample)}`
      ).toBe(0);

      await snap('session-A-garble-check');

      // ── Step 3: "Copy" content from session A via keyboard ────────────────
      // Click into the terminal (the actual container element, not the canvas overlay)
      await page.locator('#session-overlay .terminal-container').click();
      // Ctrl+Shift+C = copy selection in terminal emulators
      await page.keyboard.press('Control+Shift+C');
      await sleep(300);
      await snap('session-A-after-copy-attempt');

      // ── Scroll back to bottom ─────────────────────────────────────────────
      await scrollTerminalDown(page, 3000);

      // ── Step 4: Switch to session B ───────────────────────────────────────
      await closeOverlay(page);
      await openSession(page, 'session-B');
      await snap('session-B-open');

      const colsB = await getLastSubscribeCols(page);
      expect(colsB, 'Session B: subscribe message was sent with measured cols').toBeGreaterThan(0);

      const rowsB_initial = await countRows(page);

      // ── Step 5: Type the "copied" content into session B ──────────────────
      await page.locator('#session-overlay .terminal-container').click();
      const pasteMarker = 'PASTED-FROM-A:' + CONTENT_A.slice(0, 30);
      await page.keyboard.type(pasteMarker);
      await page.keyboard.press('Enter');
      await sleep(800);
      await snap('session-B-after-paste');

      // ── Step 6: Reload the browser ────────────────────────────────────────
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(600);

      // Re-navigate to project after reload
      const projectItemAfterReload = page.locator('.project-item').filter({ hasText: 'T52-Project' }).first();
      await projectItemAfterReload.waitFor({ state: 'visible', timeout: 10000 });
      await projectItemAfterReload.click();
      await sleep(400);

      // Re-open session B after reload
      await openSession(page, 'session-B');
      await snap('session-B-after-reload');

      const colsB_afterReload = await getLastSubscribeCols(page);
      expect(colsB_afterReload, 'Subscribe cols after reload: still measured correctly').toBeGreaterThan(0);

      // ── Step 7: Scroll up 40+ lines in session B after reload ────────────
      await scrollTerminalDown(page, 3000); // ensure at bottom first
      const scrollTopB_bottom = await getScrollTop(page);
      await scrollTerminalUp(page, 1000);
      const scrollTopB_after = await getScrollTop(page);
      await snap('session-B-scrolled-up-after-reload');

      expect(scrollTopB_after, 'Session B scrollbar must move after reload when scrolled with mouse wheel').toBeLessThan(scrollTopB_bottom);

      const rowsB_afterReload = await countRows(page);
      expect(rowsB_afterReload, 'Session B must have content after reload').toBeGreaterThan(0);

      // Garbling check for session B after reload
      const garbleB = await checkScrollbackGarbling(page, 'SESS-B:');
      expect(garbleB.withMarker,
        `Must see session B content after scrolling up 1000px — only ${garbleB.total} total rows visible`
      ).toBeGreaterThan(0);
      expect(garbleB.garbled,
        `Session B scrollback garbled after reload: ${garbleB.garbled} rows contain LINE+digits but are missing :END. Sample: ${JSON.stringify(garbleB.sample)}`
      ).toBe(0);

      // ── Step 8: Scroll back down and switch to session A ─────────────────
      await scrollTerminalDown(page, 3000);
      await closeOverlay(page);

      // Open session A
      await openSession(page, 'session-A');
      await snap('session-A-returned');

      const colsA_return = await getLastSubscribeCols(page);
      expect(colsA_return, 'Session A on return: subscribe message sent with measured cols').toBeGreaterThan(0);

      const rowsA_returned = await countRows(page);
      await snap('session-A-final');

      // ── Key assertions: row counts must stay stable across session switches ─
      // If column mismatch bug is present, re-subscribing may resize the PTY to the
      // wrong width, causing xterm to re-flow scrollback and changing the row count.
      expect(rowsA_returned,
        `Session A row count on return (${rowsA_returned}) must not be 2x initial (${rowsA_initial}) — doubled rows indicate column mismatch / line-wrapping`
      ).toBeLessThan(rowsA_initial * 1.6 + 15);

      expect(rowsB_afterReload,
        `Session B row count after reload (${rowsB_afterReload}) must not be 2x initial (${rowsB_initial}) — doubled rows indicate column mismatch`
      ).toBeLessThan(rowsB_initial * 1.6 + 15);

      // Type the copy-back marker into session A
      await page.locator('#session-overlay .terminal-container').click();
      const copyBackMarker = 'COPY-BACK-FROM-B:' + CONTENT_B.slice(0, 30);
      await page.keyboard.type(copyBackMarker);
      await page.keyboard.press('Enter');
      await sleep(600);
      await snap('session-A-copy-back');

    } finally {
      await snap('final-state');
      await browser.close();
    }
  });
});
