/**
 * T-09: Settings Persist Across Browser Reload
 *
 * Purpose: Verify that settings saved via SettingsModal (default model + extended
 * thinking toggle) survive a hard browser reload. Tests both client-side display
 * (modal shows correct values post-reload) and server-side persistence
 * (GET /api/settings returns saved values, values survive server restart).
 *
 * Fail signal: Settings revert to defaults after reload (client shows Sonnet when
 * Haiku was saved), or only some settings persist (model saves but thinking resets).
 *
 * Port: 3106
 * Run: PORT=3106 npx playwright test tests/adversarial/T-09-settings-persist.test.js --reporter=line --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3106;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T09-settings-persist');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForServer(baseUrl, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.ok) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

function startServer(tmpDir) {
  const crashLogPath = path.join(tmpDir, 'server-crash.log');
  const proc = spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  proc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));
  return proc;
}

async function killServer(proc, timeoutMs = 3000) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return;
    await sleep(200);
  }
  try { proc.kill('SIGKILL'); } catch {}
}

async function getSettings(baseUrl) {
  const r = await fetch(`${baseUrl}/api/settings`);
  return r.json();
}

async function hardReload(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/**
 * Open SettingsModal via the TopBar settings button.
 * Returns after verifying modal is visible.
 */
async function openSettingsModal(page) {
  // TopBar settings button: btn.btn-ghost with title="Settings"
  await page.locator('#topbar button[title="Settings"]').click();
  // Wait for modal body containing "Session Defaults"
  await page.waitForFunction(
    () => document.querySelector('.modal-wide') &&
          document.querySelector('.modal-wide').textContent.includes('Session Defaults'),
    { timeout: 8000 }
  );
}

/**
 * Close settings modal via Cancel button or backdrop click.
 */
async function closeSettingsModal(page) {
  await page.locator('.modal-footer .btn-ghost').click();
  await page.waitForFunction(
    () => !document.querySelector('.modal-wide'),
    { timeout: 5000 }
  );
}

/**
 * In the Settings modal: set session model and extended thinking, then save.
 */
async function saveSettings(page, { model, thinking }) {
  // Session Defaults is the first .settings-section in .modal-body
  const sessSection = page.locator('.modal-body .settings-section').first();

  // Change model — first select.form-select in session section
  await sessSection.locator('select.form-select').first().selectOption(model);
  await sleep(200); // let Preact re-render settle

  // Extended Thinking toggle — click the visible toggle-slider span in session section
  // The toggle-slider span's onClick fires onChange(!checked) in Preact
  // Use JS evaluation to read checkbox checked property (hidden with display:none)
  const isCurrentlyChecked = await page.evaluate(() => {
    const section = document.querySelector('.modal-body .settings-section');
    if (!section) return false;
    const cb = section.querySelector('input[type="checkbox"]');
    return cb ? cb.checked : false;
  });

  if (isCurrentlyChecked !== thinking) {
    // Click the visible toggle-slider span using page.evaluate to dispatch a real click
    // The span's onClick: () => onChange(!checked) in Preact
    await page.evaluate(() => {
      const section = document.querySelector('.modal-body .settings-section');
      if (!section) return;
      // Find the first toggle-slider span in session section (Extended Thinking)
      const slider = section.querySelector('.toggle-slider');
      if (slider) slider.click();
    });
    await sleep(300); // let Preact state update settle and re-render
    // Verify the toggle changed
    const nowChecked = await page.evaluate(() => {
      const section = document.querySelector('.modal-body .settings-section');
      const cb = section ? section.querySelector('input[type="checkbox"]') : null;
      return cb ? cb.checked : false;
    });
    if (nowChecked !== thinking) {
      throw new Error(`Toggle click failed: expected ${thinking}, got ${nowChecked}`);
    }
  }

  // Save
  await page.locator('.modal-footer .btn-primary').click();

  // Wait for modal to close
  await page.waitForFunction(
    () => !document.querySelector('.modal-wide'),
    { timeout: 8000 }
  );

  // Wait for success toast
  await page.waitForFunction(
    () => {
      const divs = Array.from(document.querySelectorAll('div'));
      return divs.some(d => d.textContent.includes('Settings saved'));
    },
    { timeout: 5000 }
  );
}

/**
 * Read modal state: { model, thinking, preview }
 */
async function readModalState(page) {
  const sessSection = page.locator('.modal-body .settings-section').first();

  const model = await sessSection.locator('select.form-select').first().inputValue();

  // Use JS evaluation to read checkbox checked property (it's hidden with display:none)
  const thinking = await page.evaluate(() => {
    const section = document.querySelector('.modal-body .settings-section');
    const cb = section ? section.querySelector('input[type="checkbox"]') : null;
    return cb ? cb.checked : false;
  });

  // Command preview is the last .form-input in .modal-body (the mono div)
  const preview = await page.locator('.modal-body .form-input').last().textContent();

  return { model, thinking, preview: preview.trim() };
}

// ── Test suite — single test to avoid cross-test state dependency ─────────────

test.describe('T-09 — Settings Persist Across Browser Reload', () => {
  let serverProc = null;
  let tmpDir = '';
  let browser = null;

  test.setTimeout(120000);

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3106
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    // Fresh isolated temp data directory
    tmpDir = execSync('mktemp -d /tmp/qa-T09-XXXXXX').toString().trim();
    console.log(`\n  [T-09] tmpDir: ${tmpDir}`);

    serverProc = startServer(tmpDir);
    await waitForServer(BASE_URL);
    console.log(`  [T-09] Server ready on port ${PORT}`);

    // Launch browser
    browser = await chromium.launch({ headless: true });
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
    await killServer(serverProc);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('All rounds: settings persist across reload and server restart', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:error] ${msg.text()}`);
    });

    // Navigate to app
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
    console.log('  [T-09] App loaded and connected');

    // ── Round 1: Haiku + Extended Thinking ON ──────────────────────────────────

    // Open settings modal
    await openSettingsModal(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-settings-before-change.png') });
    console.log('  [T-09] Settings modal opened');

    // Save Haiku + extended thinking ON
    await saveSettings(page, { model: 'haiku', thinking: true });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-settings-saved-round1.png') });
    console.log('  [T-09] Settings saved: haiku + thinking=true');

    // Verify server received the settings
    let serverSettings = await getSettings(BASE_URL);
    console.log('  [T-09] Server settings:', JSON.stringify(serverSettings.session));

    expect(serverSettings.session.defaultModel,
      'Server should have haiku as defaultModel after save'
    ).toBe('haiku');
    expect(serverSettings.session.extendedThinking,
      'Server should have extendedThinking=true after save'
    ).toBe(true);

    // Hard reload
    await hardReload(page);
    await page.waitForSelector('#topbar', { timeout: 10000 });
    await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
    console.log('  [T-09] Hard reload complete, WS reconnected');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-after-reload-round1.png') });

    // Open settings modal
    await openSettingsModal(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-settings-after-reload-round1.png') });

    // Read and verify modal state
    let state = await readModalState(page);
    console.log('  [T-09] Modal state after reload (round 1):', JSON.stringify(state));

    expect(state.model,
      'Model should still be haiku after reload (not reverted to sonnet)'
    ).toBe('haiku');
    expect(state.thinking,
      'Extended Thinking should still be ON after reload'
    ).toBe(true);
    expect(state.preview,
      'Command preview should include haiku model ID'
    ).toContain('claude-haiku-4-5-20251001');
    expect(state.preview,
      'Command preview should include --effort max for extended thinking'
    ).toContain('--effort max');

    // Close modal for next round
    await closeSettingsModal(page);
    console.log('  [T-09] Round 1 PASSED');

    // ── Round 2: Opus + Extended Thinking OFF ──────────────────────────────────

    await openSettingsModal(page);
    await saveSettings(page, { model: 'opus', thinking: false });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-settings-saved-round2.png') });
    console.log('  [T-09] Settings saved: opus + thinking=false');

    serverSettings = await getSettings(BASE_URL);
    console.log('  [T-09] Server settings (round 2):', JSON.stringify(serverSettings.session));
    expect(serverSettings.session.defaultModel).toBe('opus');
    expect(serverSettings.session.extendedThinking).toBe(false);

    await hardReload(page);
    await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
    console.log('  [T-09] Hard reload complete (round 2)');

    await openSettingsModal(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-settings-after-reload-round2.png') });

    state = await readModalState(page);
    console.log('  [T-09] Modal state after reload (round 2):', JSON.stringify(state));

    expect(state.model, 'Model should be opus after reload (round 2)').toBe('opus');
    expect(state.thinking, 'Extended Thinking should be OFF after reload (round 2)').toBe(false);
    expect(state.preview, 'Command preview should include opus model ID').toContain('claude-opus-4-6');
    expect(state.preview, 'Command preview should NOT include --effort max').not.toContain('--effort max');

    await closeSettingsModal(page);
    console.log('  [T-09] Round 2 PASSED');

    // ── Round 3: Haiku + Extended Thinking ON (repeat for confidence) ──────────

    await openSettingsModal(page);
    await saveSettings(page, { model: 'haiku', thinking: true });
    console.log('  [T-09] Settings saved: haiku + thinking=true (round 3)');

    serverSettings = await getSettings(BASE_URL);
    expect(serverSettings.session.defaultModel).toBe('haiku');
    expect(serverSettings.session.extendedThinking).toBe(true);

    await hardReload(page);
    await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
    console.log('  [T-09] Hard reload complete (round 3)');

    await openSettingsModal(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-settings-after-reload-round3.png') });

    state = await readModalState(page);
    console.log('  [T-09] Modal state after reload (round 3):', JSON.stringify(state));

    expect(state.model).toBe('haiku');
    expect(state.thinking).toBe(true);
    expect(state.preview).toContain('claude-haiku-4-5-20251001');
    expect(state.preview).toContain('--effort max');

    await closeSettingsModal(page);
    console.log('  [T-09] Round 3 PASSED');

    // ── Server restart persistence test ────────────────────────────────────────

    console.log('  [T-09] Stopping server to test disk persistence...');
    await killServer(serverProc);
    await sleep(500);

    // Read the settings.json file directly from disk
    const settingsFilePath = path.join(tmpDir, 'settings.json');
    let diskSettings;
    try {
      const raw = fs.readFileSync(settingsFilePath, 'utf8');
      diskSettings = JSON.parse(raw);
    } catch (e) {
      throw new Error(`settings.json not found or invalid at ${settingsFilePath}: ${e.message}`);
    }

    console.log('  [T-09] Disk settings.session:', JSON.stringify(diskSettings.session));

    expect(diskSettings.session.defaultModel,
      'settings.json on disk should have haiku as defaultModel'
    ).toBe('haiku');
    expect(diskSettings.session.extendedThinking,
      'settings.json on disk should have extendedThinking=true'
    ).toBe(true);

    // Restart server and verify settings come back from disk
    serverProc = startServer(tmpDir);
    await waitForServer(BASE_URL);
    console.log('  [T-09] Server restarted');

    serverSettings = await getSettings(BASE_URL);
    console.log('  [T-09] Server settings after restart:', JSON.stringify(serverSettings.session));

    expect(serverSettings.session.defaultModel,
      'Server should load haiku from disk after restart'
    ).toBe('haiku');
    expect(serverSettings.session.extendedThinking,
      'Server should load extendedThinking=true from disk after restart'
    ).toBe(true);

    // Reconnect browser and verify modal still shows correct values
    await hardReload(page);
    await page.waitForSelector('.status-dot.connected', { timeout: 15000 });

    await openSettingsModal(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08-settings-after-server-restart.png') });

    state = await readModalState(page);
    console.log('  [T-09] Modal state after server restart:', JSON.stringify(state));

    expect(state.model).toBe('haiku');
    expect(state.thinking).toBe(true);

    await closeSettingsModal(page);
    console.log('  [T-09] All checks passed including server restart disk persistence');

    await context.close();
  });
});
