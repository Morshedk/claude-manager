/**
 * T-53: Events panel opens BELOW terminal (horizontal layout), not beside it
 *
 * Verifies:
 *   1. The Events button in the bottom tab bar toggles the SessionLogPane
 *   2. The events panel appears BELOW the terminal (flex-direction: column), not beside it
 *   3. Toggling Events does NOT change the terminal container width
 *   4. Closing Events hides the panel and terminal width remains unchanged
 *
 * Port: 3600 (direct), 3601 (tmux)
 */

import { test, expect, chromium } from 'playwright/test';
import WebSocket from 'ws';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = path.resolve(__dirname, '../../');
const PORTS = { direct: 3600, tmux: 3601 };
const MODES = ['direct', 'tmux'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROMIUM_PATH = `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`;

/**
 * Create a session via WebSocket.
 * Registers the message listener at construction time (before 'open') to avoid
 * the race where the server sends 'init' in the same synchronous tick.
 */
function wsCreate(port, projectId, name, mode = 'direct') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => { ws.close(); reject(new Error('wsCreate timeout')); }, 25000);
    let initDone = false;
    ws.on('error', e => { clearTimeout(t); reject(e); });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'init' && !initDone) {
        initDone = true;
        ws.send(JSON.stringify({ type: 'session:create', projectId, name, command: 'bash', mode, cwd: '/tmp', cols: 120, rows: 30 }));
      } else if (m.type === 'session:created') {
        clearTimeout(t); ws.close(); resolve(m.session.id);
      } else if (m.type === 'session:error') {
        clearTimeout(t); ws.close(); reject(new Error(`Create error: ${m.error}`));
      }
    });
  });
}

/**
 * Open a session card overlay by clicking the card name link.
 */
async function openSession(page, name) {
  const card = page.locator('.session-card').filter({ hasText: name }).first();
  await card.waitFor({ state: 'visible', timeout: 10000 });
  const nameLink = card.locator('.session-card-name').first();
  await nameLink.click();
  await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 15000 });
  await sleep(2000); // fit() + scrollback render
}

for (const MODE of MODES) {
test.describe(`T-53 [${MODE}] — Events panel opens below terminal (horizontal layout)`, () => {
  const PORT = PORTS[MODE];
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-53-events-bottom-tab-${MODE}`);

  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-T53-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Poll until the server is ready
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

    // Create a project
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T53-Project', path: '/tmp' }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    // Create a session via WebSocket
    sessionId = await wsCreate(PORT, projectId, 'test-session', MODE);
    await sleep(1500);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill(); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('events panel layout: below terminal, no terminal width change on toggle', async () => {
    const browser = await chromium.launch({
      executablePath: fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    let snapN = 0;
    const snap = async (name) => {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${String(++snapN).padStart(2, '0')}-${name}.png`) });
    };

    try {
      // Navigate to the app
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(600);

      // Navigate to the project
      const projectItem = page.locator('.project-item').filter({ hasText: 'T53-Project' }).first();
      await projectItem.waitFor({ state: 'visible', timeout: 10000 });
      await projectItem.click();
      await sleep(400);

      // ── Step 1: Open the session overlay ──────────────────────────────────
      await openSession(page, 'test-session');
      await snap('01-session-open');

      // ── Step 2: Measure terminal width BEFORE toggling Events ─────────────
      const terminalBefore = await page.locator('#session-overlay-terminal').boundingBox();
      expect(terminalBefore, 'Terminal container must be visible').toBeTruthy();
      const termWidthBefore = terminalBefore.width;
      await snap('02-terminal-before-events');

      // ── Step 3: Find and click the Events button in the bottom tab bar ────
      // The Events button is inside the bottom tab bar (NOT in .overlay-actions)
      const eventsBtn = page.locator('#session-overlay button').filter({ hasText: 'Events' }).first();
      await eventsBtn.waitFor({ state: 'visible', timeout: 5000 });

      // Verify Events button is NOT inside the header overlay-actions
      const eventsInHeader = page.locator('.overlay-actions button').filter({ hasText: 'Events' });
      const headerCount = await eventsInHeader.count();
      expect(headerCount, 'Events button must NOT be in the header .overlay-actions').toBe(0);

      await eventsBtn.click();
      await sleep(800);
      await snap('03-events-panel-open');

      // ── Step 4: Verify the events panel (SessionLogPane) is visible ───────
      // SessionLogPane's parent div has border-top: 1px solid var(--border) and height: 260px
      const eventsPanel = page.locator('#session-overlay div').filter({
        has: page.locator('div[style*="overflow"]'),
      }).last();

      // More reliable: look for the container that wraps SessionLogPane — it has
      // height: 260px and is only rendered when showLog is true.
      const eventsPanelContainer = page.locator('#session-overlay div[style*="height: 260px"]').first();
      const panelVisible = await eventsPanelContainer.isVisible({ timeout: 5000 }).catch(() => false);
      expect(panelVisible, 'Events panel (260px container) must be visible after clicking Events').toBe(true);

      // ── Step 5: Verify flex-direction: column layout ──────────────────────
      // The parent of the terminal and events panel is the "Terminal body" div
      // which has style="flex: 1; ... display: flex; flex-direction: column;"
      const terminalBodyFlexDir = await page.evaluate(() => {
        const terminalEl = document.getElementById('session-overlay-terminal');
        if (!terminalEl) return null;
        // The parent div is the "Terminal body" container
        const parent = terminalEl.parentElement;
        if (!parent) return null;
        const cs = window.getComputedStyle(parent);
        return cs.flexDirection;
      });
      expect(terminalBodyFlexDir, 'Terminal body container must use flex-direction: column').toBe('column');

      // Also verify the top-level overlay uses flex-direction: column
      const overlayFlexDir = await page.evaluate(() => {
        const overlay = document.getElementById('session-overlay');
        if (!overlay) return null;
        return window.getComputedStyle(overlay).flexDirection;
      });
      expect(overlayFlexDir, 'Session overlay must use flex-direction: column').toBe('column');

      // ── Step 6: Verify events panel Y > terminal bottom (panel is below) ──
      const terminalAfterOpen = await page.locator('#session-overlay-terminal').boundingBox();
      const panelBox = await eventsPanelContainer.boundingBox();
      expect(terminalAfterOpen, 'Terminal container must have bounding box').toBeTruthy();
      expect(panelBox, 'Events panel must have bounding box').toBeTruthy();

      const terminalBottom = terminalAfterOpen.y + terminalAfterOpen.height;
      // Events panel Y should be at or below the terminal bottom (accounting for
      // the tab bar height between them, ~28px, plus possible borders).
      // The key assertion: events panel is BELOW, not beside.
      expect(panelBox.y, `Events panel top (${panelBox.y}) must be >= terminal bottom (${terminalBottom}) — panel is below, not beside`).toBeGreaterThanOrEqual(terminalBottom - 2);

      // ── Step 7: Measure terminal width AFTER toggling — assert unchanged ──
      const termWidthAfter = terminalAfterOpen.width;
      expect(
        Math.abs(termWidthAfter - termWidthBefore),
        `Terminal width must not change when Events is toggled (before: ${termWidthBefore}, after: ${termWidthAfter})`
      ).toBeLessThanOrEqual(2);

      await snap('04-layout-verified');

      // ── Step 8: Click Events again to close the panel ─────────────────────
      await eventsBtn.click();
      await sleep(600);
      await snap('05-events-closed');

      // Verify events panel is no longer visible
      const panelAfterClose = await page.locator('#session-overlay div[style*="height: 260px"]').count();
      expect(panelAfterClose, 'Events panel must be hidden after toggling off').toBe(0);

      // ── Step 9: Verify terminal width unchanged after closing Events ──────
      const terminalAfterClose = await page.locator('#session-overlay-terminal').boundingBox();
      expect(terminalAfterClose, 'Terminal container must still be visible after closing Events').toBeTruthy();

      const termWidthFinal = terminalAfterClose.width;
      expect(
        Math.abs(termWidthFinal - termWidthBefore),
        `Terminal width must remain unchanged after closing Events (before: ${termWidthBefore}, final: ${termWidthFinal})`
      ).toBeLessThanOrEqual(2);

      await snap('06-final-state');

    } finally {
      await snap('final');
      await browser.close();
    }
  });
});
} // end for (const MODE of MODES)
