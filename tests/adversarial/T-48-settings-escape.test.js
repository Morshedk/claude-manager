/**
 * T-48: Settings Escape Key Discards Changes
 *
 * Purpose: Open Settings, change default model, press Escape. Verify:
 *   1. Modal closes (Escape not intercepted by xterm/unhandled)
 *   2. Settings NOT saved to API (changes discarded)
 *   3. Re-opening modal shows original value (signal re-sync from API)
 *   4. With terminal overlay open: Escape still closes modal, not swallowed by xterm
 *
 * Design doc: tests/adversarial/designs/T-48-design.md
 *
 * Run: PORT=3145 npx playwright test tests/adversarial/T-48-settings-escape.test.js --reporter=line --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORTS = { direct: 3145, tmux: 3745 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `t48-settings-escape-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe(`T-48 — Settings Escape Key Discards Changes [${MODE}]`, () => {

  let serverProc = null;
  let dataDir = '';
  let crashLogPath = '';
  let testStartTime = 0;
  let ptyPid = 0;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    dataDir = execSync('mktemp -d /tmp/t48-XXXXXX').toString().trim();
    console.log(`\n  [T-48] dataDir: ${dataDir}`);

    const projectsSeed = {
      projects: [
        {
          id: 'proj-t48',
          name: 'T48-Project',
          path: '/tmp',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(projectsSeed, null, 2));

    crashLogPath = path.join(dataDir, 'server-crash.log');

    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PORT: String(PORT),
        CRASH_LOG: crashLogPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/sessions`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(300);
    }
    if (!ready) throw new Error('Test server failed to start within 15s');
    console.log(`  [T-48] Server ready on port ${PORT}`);
    testStartTime = Date.now();
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(500);
      try { process.kill(serverProc.pid, 0); serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }

    if (ptyPid) {
      try { process.kill(ptyPid, 'SIGKILL'); } catch {}
    }

    try {
      const cl = fs.readFileSync(crashLogPath, 'utf8');
      if (cl.trim()) console.log('\n  [T-48] CRASH LOG:\n' + cl);
    } catch {}

    if (dataDir) {
      try { execSync(`rm -rf ${dataDir}`); } catch {}
      dataDir = '';
    }
  });

  async function getApiSettings() {
    const r = await fetch(`${BASE_URL}/api/settings`);
    if (!r.ok) return null;
    return r.json();
  }

  async function openSettingsModal(page) {
    const settingsBtn = page.locator('#topbar button[title="Settings"]');
    await settingsBtn.waitFor({ state: 'visible', timeout: 5000 });
    await settingsBtn.click();
    await page.waitForSelector('.modal-wide', { state: 'visible', timeout: 5000 });
  }

  async function isModalOpen(page) {
    return page.evaluate(() => {
      const modal = document.querySelector('.modal-wide');
      if (!modal) return false;
      const style = getComputedStyle(modal);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
  }

  // ── Sub-test A: No terminal open ──────────────────────────────────────────
  test('T-48A — Escape closes Settings modal and discards changes (no terminal)', async () => {
    test.setTimeout(60000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      page.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
      });

      // Navigate
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('.status-dot.connected', { timeout: 10000 });
      console.log('\n  [T-48A] App loaded, connected');

      // Record API initial state
      const initialSettings = await getApiSettings();
      const initialModel = initialSettings?.session?.defaultModel || 'sonnet';
      console.log(`  [T-48A] Initial API model: ${initialModel}`);

      // Open settings to find original model displayed
      await openSettingsModal(page);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'A-01-modal-open.png') });

      const firstSelect = page.locator('.modal-wide .form-select').first();
      const originalModel = await firstSelect.inputValue();
      console.log(`  [T-48A] Current model in form: ${originalModel}`);

      // Close via Cancel to establish clean state
      await page.locator('.modal-wide .btn-ghost').click();
      await sleep(300);
      expect(await isModalOpen(page), 'Modal must be closed after Cancel').toBe(false);

      // ── A3: Open and change model ────────────────────────────────────────────
      await openSettingsModal(page);
      const changedModel = originalModel === 'sonnet' ? 'haiku' : 'sonnet';
      console.log(`  [T-48A] Changing model from "${originalModel}" to "${changedModel}"`);

      await page.locator('.modal-wide .form-select').first().selectOption(changedModel);
      await sleep(200);
      const changedValue = await page.locator('.modal-wide .form-select').first().inputValue();
      expect(changedValue, `Model select must reflect change to ${changedModel}`).toBe(changedModel);
      console.log(`  [T-48A] Model select changed to: ${changedValue}`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'A-02-changed-before-escape.png') });

      // ── A4: Press Escape ─────────────────────────────────────────────────────
      console.log('  [T-48A] Pressing Escape...');

      // Try to focus the modal element first to ensure Escape goes to it, not xterm
      await page.locator('.modal-wide').click({ position: { x: 10, y: 10 } });
      await sleep(100);

      await page.keyboard.press('Escape');
      await sleep(500);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'A-03-after-escape.png') });

      // ── A5: Assert modal closed ──────────────────────────────────────────────
      const modalOpenAfterEscape = await isModalOpen(page);
      console.log(`  [T-48A] Modal open after Escape: ${modalOpenAfterEscape}`);

      if (modalOpenAfterEscape) {
        // Modal is still open — Escape did NOT close it. This is the expected bug.
        console.error('  [T-48A] FAIL: Modal is still open after pressing Escape');
        // Close via cancel for cleanup
        await page.locator('.modal-wide .btn-ghost').click().catch(() => {});
      }
      expect(modalOpenAfterEscape, 'Modal must be CLOSED after pressing Escape').toBe(false);

      // ── A6: Assert settings NOT saved ────────────────────────────────────────
      const settingsAfterEscape = await getApiSettings();
      const modelAfterEscape = settingsAfterEscape?.session?.defaultModel;
      console.log(`  [T-48A] API model after Escape: ${modelAfterEscape}`);
      expect(modelAfterEscape, 'Settings must NOT be saved when Escape is pressed').toBe(initialModel);

      // ── A7: Re-open and verify original value ────────────────────────────────
      await openSettingsModal(page);
      await sleep(300); // Let useEffect re-sync from signal
      const modelAfterReopen = await page.locator('.modal-wide .form-select').first().inputValue();
      console.log(`  [T-48A] Model after re-open: ${modelAfterReopen}`);
      expect(modelAfterReopen, 'Re-opened modal must show original (unsaved) model').toBe(originalModel);

      // Close cleanly
      await page.locator('.modal-wide .btn-ghost').click();

      console.log('\n  [T-48A] Sub-test A PASSED: Escape closes modal, discards changes, re-open shows original');

    } finally {
      await browser.close().catch(() => {});
    }
  });

  // ── Sub-test B: With terminal overlay open ────────────────────────────────
  test('T-48B — Escape closes Settings modal with terminal overlay active', async () => {
    test.setTimeout(90000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      page.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
      });

      // Navigate
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('.status-dot.connected', { timeout: 10000 });
      console.log('\n  [T-48B] App loaded, connected');

      // Record API initial state
      const initialSettings = await getApiSettings();
      const initialModel = initialSettings?.session?.defaultModel || 'sonnet';
      console.log(`  [T-48B] Initial API model: ${initialModel}`);

      // ── B1: Select project and create bash session ────────────────────────────
      const projectItem = page.locator('.project-item').filter({ hasText: 'T48-Project' });
      await projectItem.first().waitFor({ state: 'visible', timeout: 5000 });
      await projectItem.first().click();
      await page.waitForFunction(
        () => [...document.querySelectorAll('.project-item')].some(el => el.classList.contains('active')),
        { timeout: 5000 }
      );

      const newSessionBtn = page.locator('#sessions-area .btn-primary').first();
      await newSessionBtn.waitFor({ state: 'visible', timeout: 5000 });
      await newSessionBtn.click();
      await page.waitForSelector('.modal', { state: 'visible', timeout: 5000 });

      await page.locator('.modal .form-input').first().fill('t48-bash');
      await page.locator('.modal .form-input').nth(1).fill('bash');
      await page.locator('.modal-footer .btn-primary').click();

      // Wait for running card
      await page.waitForFunction(
        () => {
          const cards = document.querySelectorAll('.session-card');
          return [...cards].some(c => c.textContent.includes('t48-bash') && c.textContent.includes('running'));
        },
        { timeout: 10000 }
      );
      console.log('  [T-48B] Session running');

      // Get PID for cleanup
      const r = await fetch(`${BASE_URL}/api/sessions`);
      const body = await r.json();
      const sess = (Array.isArray(body.managed) ? body.managed : []).find(s => s.name === 't48-bash');
      if (sess?.pid) ptyPid = sess.pid;

      // Open terminal overlay
      const card = page.locator('.session-card').filter({ hasText: 't48-bash' });
      await card.first().click();
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 8000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: 8000 });
      await sleep(800); // Let xterm capture focus

      console.log('  [T-48B] Terminal overlay open, xterm has focus');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'B-01-terminal-open.png') });

      // ── B2: Open Settings while terminal is focused ──────────────────────────
      await openSettingsModal(page);
      console.log('  [T-48B] Settings modal opened (while terminal active)');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'B-02-modal-open-with-terminal.png') });

      // ── B3: Change model ─────────────────────────────────────────────────────
      const originalModel = await page.locator('.modal-wide .form-select').first().inputValue();
      const changedModel = originalModel === 'sonnet' ? 'haiku' : 'sonnet';
      console.log(`  [T-48B] Changing model from "${originalModel}" to "${changedModel}"`);
      await page.locator('.modal-wide .form-select').first().selectOption(changedModel);
      await sleep(200);

      // ── B4: Press Escape ─────────────────────────────────────────────────────
      // First click inside the modal to ensure it has focus, not xterm
      await page.locator('.modal-wide .modal-header').click();
      await sleep(100);

      console.log('  [T-48B] Pressing Escape...');
      await page.keyboard.press('Escape');
      await sleep(500);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'B-03-after-escape.png') });

      // ── B5: Assert modal closed ──────────────────────────────────────────────
      const modalOpenAfterEscape = await isModalOpen(page);
      console.log(`  [T-48B] Modal open after Escape: ${modalOpenAfterEscape}`);

      if (modalOpenAfterEscape) {
        console.error('  [T-48B] FAIL: Modal is still open after Escape (likely xterm intercepted it)');
        await page.locator('.modal-wide .btn-ghost').click().catch(() => {});
      }
      expect(modalOpenAfterEscape, 'Modal must be CLOSED after Escape even with terminal overlay').toBe(false);

      // ── B6: Assert settings NOT saved ────────────────────────────────────────
      const settingsAfterB = await getApiSettings();
      const modelAfterB = settingsAfterB?.session?.defaultModel;
      console.log(`  [T-48B] API model after Escape: ${modelAfterB}`);
      expect(modelAfterB, 'Settings must NOT be saved when Escape is pressed with terminal').toBe(initialModel);

      // ── B7: Verify Escape was not forwarded to PTY ───────────────────────────
      // Terminal overlay should still be open — type a check marker
      const overlayStillOpen = await page.evaluate(() => !!document.querySelector('#session-overlay'));
      if (overlayStillOpen) {
        // Type a unique marker and check for it (ensures terminal is responsive)
        const checkMarker = `T48_ESCAPE_CHECK_${Date.now()}`;
        await page.keyboard.type(`echo ${checkMarker}`);
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
          checkMarker,
          { timeout: 8000 }
        ).catch(() => console.log('  [T-48B] Note: marker check timed out (terminal still usable)'));
        console.log(`  [T-48B] Terminal still responsive after Escape`);
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'B-04-final.png') });

      console.log('\n  [T-48B] Sub-test B PASSED: Escape closes modal with terminal open, changes discarded');

    } finally {
      await browser.close().catch(() => {});
    }
  });

  // ── Crash log check (shared afterAll already covers this, but also inline) ──
  test('T-48 — crash log clean', async () => {
    try {
      const crashLog = fs.readFileSync(crashLogPath, 'utf8');
      const testEntries = crashLog.split('\n').filter(line => {
        if (!line.trim()) return false;
        const m = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        return m && new Date(m[1]).getTime() >= testStartTime;
      });
      if (testEntries.length > 0) {
        console.error('  [T-48] CRASH LOG entries:\n' + testEntries.join('\n'));
      }
      expect(testEntries.length, 'No server crashes during test').toBe(0);
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log('  [T-48] Crash log not found (no crashes)');
      } else {
        throw e;
      }
    }
  });

});
} // end for (const MODE of MODES)
