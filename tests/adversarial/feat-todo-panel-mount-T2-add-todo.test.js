/**
 * feat-todo-panel-mount T-2: Add a TODO and see it appear + persist after reload
 *
 * Pass condition:
 *   - After adding a TODO via the form, .todo-item appears with correct title
 *   - After page reload, the TODO is still present (server-persisted)
 *
 * Port: 3221
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
const PORT = 3221;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('feat-todo-panel-mount T-2 — Add TODO and persist', () => {
  let serverProc = null;
  let tmpDir = '';
  let browser = null;
  let page = null;

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-todo-T2-XXXXXX').toString().trim();
    console.log(`\n  [T-2] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-t2',
        name: 'Persist Project',
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
    console.log('  [T-2] Server ready');

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

  test('add TODO via form and verify it persists after reload', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Select project
    await page.waitForSelector('text=Persist Project', { timeout: 10000 });
    await page.click('text=Persist Project');
    await sleep(1000);

    // Navigate to TODOs tab
    await page.waitForSelector('#todos-tab-btn', { timeout: 10000 });
    await page.click('#todos-tab-btn');
    await sleep(1500);

    // Verify empty state first
    await page.waitForSelector('.todo-empty', { timeout: 5000 });
    console.log('  [T-2] Empty state confirmed before adding');

    // Click + Add button
    await page.click('button:has-text("+ Add")');
    await sleep(500);

    // Wait for add form
    const titleInput = await page.waitForSelector('input[placeholder*="What needs to be done"]', { timeout: 5000 });
    expect(titleInput).not.toBeNull();
    console.log('  [T-2] Add form appeared');

    // Type title
    await titleInput.fill('Fix the login bug');
    await sleep(200);

    // Click Add button in form
    await page.click('button:has-text("Add"):not(:has-text("+ Add"))');
    await sleep(2000);

    // Verify item appears
    const items = await page.$$('.todo-item');
    expect(items.length).toBeGreaterThan(0);
    console.log(`  [T-2] ${items.length} todo item(s) found after add`);

    const titleEl = await page.$('.todo-title');
    const titleText = await titleEl.textContent();
    expect(titleText).toContain('Fix the login bug');
    console.log(`  [T-2] PASS: todo title = "${titleText}"`);

    // Verify empty state is gone
    const emptyState = await page.$('.todo-empty');
    expect(emptyState).toBeNull();
    console.log('  [T-2] PASS: empty state gone after adding');

    // Also verify via REST that the item was actually stored
    const todosResp = await fetch(`${BASE_URL}/api/todos/proj-t2`);
    const todosData = await todosResp.json();
    expect(todosData.items).toBeDefined();
    expect(todosData.items.length).toBeGreaterThan(0);
    expect(todosData.items[0].title).toContain('Fix the login bug');
    console.log('  [T-2] PASS: REST confirms item persisted on server');

    // Reload page and verify persistence
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.waitForSelector('text=Persist Project', { timeout: 10000 });
    await page.click('text=Persist Project');
    await sleep(1000);

    await page.waitForSelector('#todos-tab-btn', { timeout: 10000 });
    await page.click('#todos-tab-btn');
    await sleep(1500);

    // Verify item still there
    await page.waitForSelector('.todo-item', { timeout: 5000 });
    const titleAfterReload = await page.textContent('.todo-title');
    expect(titleAfterReload).toContain('Fix the login bug');
    console.log(`  [T-2] PASS: item persists after reload: "${titleAfterReload}"`);

    console.log('  [T-2] ALL ASSERTIONS PASSED');
  }, 90000);
});
