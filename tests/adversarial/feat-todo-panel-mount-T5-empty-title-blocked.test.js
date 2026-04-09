/**
 * feat-todo-panel-mount T-5: Adversarial — Empty title is blocked
 *
 * Pass condition:
 *   - Clicking "Add" with empty title creates no item
 *   - Add form stays open
 *   - Pressing Enter with empty title also creates no item
 *   - REST confirms no item stored
 *
 * Port: 3224
 */

import { test, expect, describe, beforeAll, afterAll } from '@jest/globals';
import { chromium } from 'playwright';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3224;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('feat-todo-panel-mount T-5 — Empty title blocked', () => {
  let serverProc = null;
  let tmpDir = '';
  let browser = null;
  let page = null;

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-todo-T5-XXXXXX').toString().trim();
    console.log(`\n  [T-5] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-t5',
        name: 'Adversarial Project',
        path: '/tmp',
        createdAt: '2026-01-01T00:00:00.000Z',
        settings: {}
      }],
      scratchpad: []
    }));

    const crashLog = path.join(tmpDir, 'crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLog },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) break; } catch {}
      await sleep(400);
    }
    console.log('  [T-5] Server ready');

    const CHROMIUM_EXEC = '/home/claude-runner/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
    browser = await chromium.launch({ executablePath: CHROMIUM_EXEC, headless: true });
    const ctx = await browser.newContext();
    page = await ctx.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });
    page.on('pageerror', err => console.log(`  [pageerror] ${err.message}`));
  }, 30000);

  afterAll(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (serverProc) { serverProc.kill(); await sleep(500); }
    if (tmpDir) try { execSync(`rm -rf ${tmpDir}`); } catch {}
  });

  test('empty title submission is a no-op — no item created', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.waitForSelector('text=Adversarial Project', { timeout: 10000 });
    await page.click('text=Adversarial Project');
    await sleep(1000);

    await page.waitForSelector('#todos-tab-btn', { timeout: 10000 });
    await page.click('#todos-tab-btn');
    await sleep(1500);

    // Verify empty state
    await page.waitForSelector('.todo-empty', { timeout: 5000 });
    console.log('  [T-5] Pre-condition: empty state confirmed');

    // Open add form
    await page.click('button:has-text("+ Add")');
    await sleep(500);

    const titleInput = await page.waitForSelector('input[placeholder*="What needs to be done"]', { timeout: 5000 });
    expect(titleInput).not.toBeNull();
    console.log('  [T-5] Add form opened');

    // Leave title empty — click Add button
    await page.click('button:has-text("Add"):not(:has-text("+ Add"))');
    await sleep(700);

    // Assert no item created
    const itemsAfterClick = await page.$$('.todo-item');
    expect(itemsAfterClick.length).toBe(0);
    console.log('  [T-5] PASS: no item created after click with empty title');

    // Assert form is still open
    const formStillOpen = await page.$('input[placeholder*="What needs to be done"]');
    expect(formStillOpen).not.toBeNull();
    console.log('  [T-5] PASS: add form still open');

    // Test Enter key with empty title
    await titleInput.press('Enter');
    await sleep(700);

    const itemsAfterEnter = await page.$$('.todo-item');
    expect(itemsAfterEnter.length).toBe(0);
    console.log('  [T-5] PASS: no item created after Enter with empty title');

    // Verify via REST that nothing was stored
    const todosResp = await fetch(`${BASE_URL}/api/todos/proj-t5`);
    const todosData = await todosResp.json();
    const itemCount = todosData.items ? todosData.items.length : 0;
    expect(itemCount).toBe(0);
    console.log(`  [T-5] PASS: REST confirms 0 items stored`);

    console.log('  [T-5] ALL ASSERTIONS PASSED');
  }, 60000);
});
