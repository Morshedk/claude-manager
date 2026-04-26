/**
 * T-55: CommandBuffer component — textarea below the terminal for composing
 * commands, Send button, Escape-to-clear, and bounding-box overlap check.
 *
 * Port: 3604 (direct), 3605 (tmux)
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
const PORTS = { direct: 3604, tmux: 3605 };
const MODES = ['direct', 'tmux'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROMIUM_PATH = `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`;

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

// Open a session card overlay by clicking the card name link
async function openSession(page, name) {
  const card = page.locator('.session-card').filter({ hasText: name }).first();
  await card.waitFor({ state: 'visible', timeout: 10000 });
  const nameLink = card.locator('.session-card-name').first();
  await nameLink.click();
  await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 15000 });
  await sleep(2000); // fit() + scrollback render
}

for (const MODE of MODES) {
test.describe(`T-55 [${MODE}] — CommandBuffer component`, () => {
  const PORT = PORTS[MODE];
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-55-command-buffer-${MODE}`);

  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-T55-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Poll until server is ready
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
      body: JSON.stringify({ name: 'T55-Project', path: '/tmp' }),
    }).then(r => r.json());
    projectId = proj.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);

    sessionId = await wsCreate(PORT, projectId, 'buf-session', MODE);
    await sleep(1500);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill(); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('command buffer: visible, send, clear on escape, no overlap', async () => {
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
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${String(++snapN).padStart(2,'0')}-${name}.png`) });
    };

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(600);

      // Navigate to project
      const projectItem = page.locator('.project-item').filter({ hasText: 'T55-Project' }).first();
      await projectItem.waitFor({ state: 'visible', timeout: 10000 });
      await projectItem.click();
      await sleep(400);

      // Open the session overlay
      await openSession(page, 'buf-session');
      await snap('session-overlay-open');

      // ── Step 5: Verify .command-buffer div is visible ─────────────────────
      const commandBuffer = page.locator('#session-overlay .command-buffer').first();
      await commandBuffer.waitFor({ state: 'visible', timeout: 10000 });
      expect(await commandBuffer.isVisible()).toBe(true);
      await snap('command-buffer-visible');

      // ── Step 6: Verify textarea with correct placeholder ──────────────────
      const textarea = page.locator('#session-overlay .command-buffer textarea').first();
      await textarea.waitFor({ state: 'visible', timeout: 5000 });
      expect(await textarea.isVisible()).toBe(true);
      const placeholder = await textarea.getAttribute('placeholder');
      expect(placeholder).toBe('Type command here... (Ctrl+Enter to send)');

      // ── Step 7: Verify Send button exists ─────────────────────────────────
      const sendBtn = page.locator('#session-overlay .command-buffer button').filter({ hasText: 'Send' }).first();
      await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
      expect(await sendBtn.isVisible()).toBe(true);
      await snap('send-button-visible');

      // ── Step 8: Type "echo BUFFER_T55_MARKER" into the textarea ───────────
      await textarea.click();
      await textarea.fill('echo BUFFER_T55_MARKER');
      await sleep(300);
      await snap('typed-command');

      // ── Step 9: Click the Send button ─────────────────────────────────────
      await sendBtn.click();
      await sleep(2000);
      await snap('after-send');

      // ── Step 10: Check xterm terminal rows for BUFFER_T55_MARKER ──────────
      const terminalText = await page.evaluate(() => {
        const rows = document.querySelectorAll('#session-overlay .xterm-rows > div');
        return Array.from(rows).map(r => r.textContent).join('\n');
      });
      expect(terminalText).toContain('BUFFER_T55_MARKER');
      await snap('marker-in-terminal');

      // ── Step 11: Verify textarea was cleared after send ───────────────────
      const textAfterSend = await textarea.inputValue();
      expect(textAfterSend).toBe('');

      // ── Step 12: Type "second text" and press Escape ──────────────────────
      await textarea.click();
      await textarea.fill('second text');
      await sleep(200);
      const textBeforeEsc = await textarea.inputValue();
      expect(textBeforeEsc).toBe('second text');
      await snap('before-escape');

      // ── Step 13: Press Escape, verify textarea is cleared ─────────────────
      await textarea.press('Escape');
      await sleep(300);
      const textAfterEsc = await textarea.inputValue();
      expect(textAfterEsc).toBe('');
      await snap('after-escape-clear');

      // ── Step 14: Verify CommandBuffer doesn't overlap the terminal ────────
      const terminalBox = await page.locator('#session-overlay #session-overlay-terminal').first().boundingBox();
      const bufferBox = await commandBuffer.boundingBox();
      expect(terminalBox).toBeTruthy();
      expect(bufferBox).toBeTruthy();

      // The command buffer should start at or after the terminal ends (no vertical overlap)
      // Allow 1px tolerance for border rendering
      expect(bufferBox.y).toBeGreaterThanOrEqual(terminalBox.y + terminalBox.height - 1);
      await snap('bounding-box-check');

    } finally {
      await snap('final-state');
      await browser.close();
    }
  });
});
} // end for (const MODE of MODES)
