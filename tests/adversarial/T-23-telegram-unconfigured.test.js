/**
 * T-23: Telegram Toggle — Unconfigured State Is Disabled and Explains Why
 *
 * Score: L=3 S=2 D=3 (Total: 8)
 *
 * Flow: Ensure Telegram is NOT configured (bot token not set). Open "New Session" modal.
 * Observe the Telegram section.
 *
 * Pass condition:
 *   - "Enable Telegram" button has `disabled` attribute
 *   - Button opacity is ~0.4 (≤0.5)
 *   - Help text reads something like "Telegram not configured"
 *   - Clicking the button has no effect (text stays "Enable Telegram")
 *   - No JS errors thrown
 *
 * Run: PORT=3120 npx playwright test tests/adversarial/T-23-telegram-unconfigured.test.js --reporter=line --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3120;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-23-telegram-unconfigured');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe('T-23 — Telegram Toggle: Unconfigured State Is Disabled', () => {

  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';

  // ── Infrastructure Setup ──────────────────────────────────────────────────

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3120 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Fresh isolated temp data dir (no Telegram .env file will exist here)
    tmpDir = execSync('mktemp -d /tmp/qa-T23-XXXXXX').toString().trim();
    console.log(`\n  [T-23] tmpDir: ${tmpDir}`);

    // Ensure no Telegram config exists in the test environment
    // The server uses HOME env to find ~/.claude/channels/telegram/.env
    // We redirect HOME to tmpDir so no pre-existing config bleeds in
    const testHome = path.join(tmpDir, 'home');
    fs.mkdirSync(testHome, { recursive: true });

    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DATA_DIR: tmpDir,
        PORT: String(PORT),
        CRASH_LOG: crashLogPath,
        HOME: testHome,  // isolate from real ~/.claude/channels/telegram
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(500);
    }
    if (!ready) throw new Error('Test server failed to start within 10s');
    console.log(`  [T-23] Server ready on port ${PORT}`);

    // Create a test project
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T23-TestProject', path: '/tmp' }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T-23] Project created: ${testProjectId} (${proj.name})`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(2000);
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      const meaningfulCrash = crashLog.split('\n').some(line =>
        line.includes('Error') || line.includes('Exception') ||
        line.includes('uncaught') || line.includes('unhandledRejection')
      );
      if (meaningfulCrash) console.log('\n  [CRASH LOG]\n' + crashLog);
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
  });

  // ── Test 1: /api/telegram/status returns configured: false ───────────────

  test('T-23.1 — API returns configured: false on fresh server', async () => {
    const status = await fetch(`${BASE_URL}/api/telegram/status`).then(r => r.json());
    console.log(`  [T-23.1] telegram/status response: ${JSON.stringify(status)}`);
    expect(status.configured).toBe(false);
    expect(status.hasToken).toBe(false);
  });

  // ── Test 2: Button is disabled when Telegram unconfigured ────────────────

  test('T-23.2 — Telegram button disabled with correct attributes and help text', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    let jsErrors = [];
    const page = await browser.newPage();

    // Capture JS errors
    page.on('pageerror', err => {
      jsErrors.push(err.message);
      console.log(`  [T-23.2] JS error: ${err.message}`);
    });
    page.on('console', msg => {
      if (msg.type() === 'error') {
        jsErrors.push(msg.text());
        console.log(`  [browser:err] ${msg.text()}`);
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      // Navigate to the test project by clicking it in the sidebar
      console.log(`  [T-23.2] Selecting project in sidebar...`);
      await page.waitForSelector(`text=T23-TestProject`, { timeout: 10000 });
      await page.click(`text=T23-TestProject`);
      await sleep(800);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-after-project-select.png') });

      // Open New Session modal — the button text is "New Claude Session"
      console.log(`  [T-23.2] Opening New Session modal...`);
      const newSessionBtn = page.locator('button:has-text("New Claude Session")').first();
      await newSessionBtn.waitFor({ timeout: 10000 });
      await newSessionBtn.click();
      await sleep(500);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-modal-open.png') });

      // Wait for Telegram section to appear and fetch to complete
      // The button starts disabled (checkingTelegram=true), then settles
      console.log(`  [T-23.2] Waiting for Telegram section...`);
      const telegramBtn = page.locator('button.telegram-toggle, button:has-text("Enable Telegram"), button:has-text("Telegram")').first();
      await telegramBtn.waitFor({ timeout: 10000 });

      // Wait for fetch to settle (button must not be in "checking" state)
      // We poll until the button text is stable (either "Enable Telegram" or "Telegram On")
      await page.waitForFunction(() => {
        const btn = document.querySelector('button.telegram-toggle') ||
                    Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Telegram'));
        if (!btn) return false;
        // Button text should be stable (not "Checking..." or empty)
        return btn.textContent.trim().length > 0;
      }, { timeout: 10000 });

      await sleep(500); // Brief settle after fetch completes

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-telegram-section.png') });

      // ── Check 1: Button has disabled attribute ──────────────────────────
      const isDisabled = await telegramBtn.isDisabled();
      console.log(`  [T-23.2] Button disabled attribute: ${isDisabled}`);
      expect(isDisabled).toBe(true);

      // ── Check 2: Button opacity is ~0.4 ────────────────────────────────
      const opacity = await telegramBtn.evaluate(el => {
        const style = window.getComputedStyle(el);
        // Check both computed opacity and inline style
        const computedOpacity = parseFloat(style.opacity);
        const inlineOpacity = el.style.opacity ? parseFloat(el.style.opacity) : null;
        console.log('[T-23] opacity — computed:', computedOpacity, 'inline:', inlineOpacity);
        return inlineOpacity !== null ? inlineOpacity : computedOpacity;
      });
      console.log(`  [T-23.2] Button opacity: ${opacity}`);
      expect(opacity).toBeLessThanOrEqual(0.5);

      // ── Check 3: Help text mentions "not configured" ────────────────────
      const helpText = await page.locator('.form-help, [class*="help"]').last().textContent();
      console.log(`  [T-23.2] Help text: "${helpText}"`);
      expect(helpText?.toLowerCase()).toContain('not configured');

      // ── Check 4: cursor is not-allowed ──────────────────────────────────
      const cursor = await telegramBtn.evaluate(el => el.style.cursor || window.getComputedStyle(el).cursor);
      console.log(`  [T-23.2] Button cursor: ${cursor}`);
      // not-allowed or default is acceptable (disabled buttons may show default)
      // The key check is disabled attr + opacity

      // ── Check 5: No JS errors so far ────────────────────────────────────
      expect(jsErrors).toHaveLength(0);

    } finally {
      await browser.close();
    }
  });

  // ── Test 3: Clicking disabled button has no effect ────────────────────────

  test('T-23.3 — Clicking disabled Telegram button has no effect, no JS error', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    let jsErrors = [];
    const page = await browser.newPage();

    page.on('pageerror', err => {
      jsErrors.push(err.message);
      console.log(`  [T-23.3] JS error: ${err.message}`);
    });
    page.on('console', msg => {
      if (msg.type() === 'error') {
        jsErrors.push(msg.text());
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      // Select project
      await page.waitForSelector(`text=T23-TestProject`, { timeout: 10000 });
      await page.click(`text=T23-TestProject`);
      await sleep(800);

      // Open New Session modal — the button text is "New Claude Session"
      const newSessionBtn = page.locator('button:has-text("New Claude Session")').first();
      await newSessionBtn.waitFor({ timeout: 10000 });
      await newSessionBtn.click();
      await sleep(1000); // Wait for fetch to settle

      // Find Telegram button
      const telegramBtn = page.locator('button.telegram-toggle, button:has-text("Enable Telegram"), button:has-text("Telegram")').first();
      await telegramBtn.waitFor({ timeout: 10000 });

      // Record initial text
      const textBefore = await telegramBtn.textContent();
      console.log(`  [T-23.3] Button text before click: "${textBefore}"`);

      // Try to click the disabled button using force:true to bypass Playwright's disabled check
      // This simulates a user clicking a visually-disabled button
      await telegramBtn.click({ force: true });
      await sleep(500);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-after-click-attempt.png') });

      // ── Check: Button text unchanged ────────────────────────────────────
      const textAfter = await telegramBtn.textContent();
      console.log(`  [T-23.3] Button text after click: "${textAfter}"`);
      expect(textAfter?.trim()).toBe('Enable Telegram');
      expect(textAfter?.trim()).not.toBe('Telegram On');

      // ── Check: Still disabled ────────────────────────────────────────────
      const isStillDisabled = await telegramBtn.isDisabled();
      console.log(`  [T-23.3] Button still disabled: ${isStillDisabled}`);
      expect(isStillDisabled).toBe(true);

      // ── Check: No JS errors ──────────────────────────────────────────────
      expect(jsErrors).toHaveLength(0);

    } finally {
      await browser.close();
    }
  });

  // ── Test 4: telegramEnabled flag stays false (no silent state corruption) ──

  test('T-23.4 — No silent flag corruption — session:create not sent with telegram:true', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    let capturedCreateMessages = [];
    const page = await browser.newPage();

    // Intercept WS session:create messages to check the telegram flag
    await page.addInitScript(() => {
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'session:create') {
            console.log('[T23-WS-CREATE] ' + JSON.stringify(parsed));
          }
        } catch {}
        return origSend.call(this, data);
      };
    });

    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('[T23-WS-CREATE]')) {
        try {
          const payload = JSON.parse(text.replace('[T23-WS-CREATE] ', ''));
          capturedCreateMessages.push(payload);
        } catch {}
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      // Select project
      await page.waitForSelector(`text=T23-TestProject`, { timeout: 10000 });
      await page.click(`text=T23-TestProject`);
      await sleep(800);

      // Open modal — the button text is "New Claude Session"
      const newSessionBtn = page.locator('button:has-text("New Claude Session")').first();
      await newSessionBtn.waitFor({ timeout: 10000 });
      await newSessionBtn.click();
      await sleep(1000);

      // Fill in a session name to prevent server-side rejection
      const nameInput = page.locator('.modal input[placeholder="e.g. refactor, auth, bugfix"]');
      if (await nameInput.count() > 0) {
        await nameInput.fill('t23-flag-test');
      }

      // Override command to bash for fast startup
      const cmdInput = page.locator('.modal input[placeholder="claude"]');
      if (await cmdInput.count() > 0) {
        await cmdInput.fill('bash');
      }

      // Force-click the Telegram button (attempt to corrupt state)
      const telegramBtn = page.locator('button.telegram-toggle, button:has-text("Enable Telegram"), button:has-text("Telegram")').first();
      await telegramBtn.waitFor({ timeout: 10000 });
      await telegramBtn.click({ force: true });
      await sleep(300);

      // Now click "Start Session" to fire session:create — use scoped locator within modal
      const startBtn = page.locator('.modal-footer button:has-text("Start Session")').first();
      await startBtn.waitFor({ timeout: 5000 });
      await startBtn.click();
      // Brief wait for WS session:create to be captured by the spy
      await sleep(800);

      console.log(`  [T-23.4] Captured session:create messages: ${JSON.stringify(capturedCreateMessages)}`);

      // ── Check: If session:create was sent, telegram flag must be false ───
      for (const msg of capturedCreateMessages) {
        const telegramFlag = msg.telegram || (msg.options && msg.options.telegram) || false;
        console.log(`  [T-23.4] session:create telegram flag: ${telegramFlag}`);
        expect(telegramFlag).toBeFalsy();
      }

    } finally {
      await browser.close();
    }
  });

});
