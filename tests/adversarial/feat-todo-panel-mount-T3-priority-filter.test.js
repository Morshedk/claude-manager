/**
 * feat-todo-panel-mount T-3: Priority filter — High filter hides Medium items
 *
 * Pass condition:
 *   - Both high and medium items visible by default
 *   - After clicking "high" filter: only high item visible, medium hidden
 *   - After clicking "all": both visible again
 *
 * Port: 3222
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
const PORT = 3222;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('feat-todo-panel-mount T-3 — Priority filter', () => {
  let serverProc = null;
  let tmpDir = '';
  let browser = null;
  let page = null;

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-todo-T3-XXXXXX').toString().trim();
    console.log(`\n  [T-3] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-t3',
        name: 'Filter Project',
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
    console.log('  [T-3] Server ready');

    // Seed two TODOs via REST
    await fetch(`${BASE_URL}/api/todos/proj-t3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'High priority task', priority: 'high', estimate: '1h' }),
    });
    await fetch(`${BASE_URL}/api/todos/proj-t3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Medium priority task', priority: 'medium', estimate: '30m' }),
    });

    // Verify seeded
    const seedCheck = await fetch(`${BASE_URL}/api/todos/proj-t3`).then(r => r.json());
    console.log(`  [T-3] Seeded ${seedCheck.items?.length ?? 0} TODOs`);

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

  test('high priority filter hides medium items', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.waitForSelector('text=Filter Project', { timeout: 10000 });
    await page.click('text=Filter Project');
    await sleep(1000);

    await page.waitForSelector('#todos-tab-btn', { timeout: 10000 });
    await page.click('#todos-tab-btn');
    await sleep(1500);

    // Verify both items visible initially
    await page.waitForSelector('.todo-item', { timeout: 5000 });
    const allItems = await page.$$('.todo-item');
    expect(allItems.length).toBe(2);
    console.log(`  [T-3] Both items visible initially: ${allItems.length}`);

    // Click "high" filter button
    // Filter buttons are in .todo-filters — find the one with text "high"
    const filterBtns = await page.$$('.todo-filter-btn');
    let highBtn = null;
    for (const btn of filterBtns) {
      const txt = await btn.textContent();
      if (txt.trim() === 'high') { highBtn = btn; break; }
    }
    expect(highBtn).not.toBeNull();
    await highBtn.click();
    await sleep(500);

    // Verify only 1 item visible
    const filteredItems = await page.$$('.todo-item');
    expect(filteredItems.length).toBe(1);
    console.log(`  [T-3] After "high" filter: ${filteredItems.length} item(s) visible`);

    const visibleTitle = await page.textContent('.todo-title');
    expect(visibleTitle).toContain('High priority task');
    console.log(`  [T-3] PASS: visible item is "${visibleTitle}"`);

    // Verify medium is not visible
    const pageText = await page.textContent('.todo-list');
    expect(pageText).not.toContain('Medium priority task');
    console.log('  [T-3] PASS: medium item not in DOM');

    // Click "all" filter to reset
    let allBtn = null;
    const filterBtns2 = await page.$$('.todo-filter-btn');
    for (const btn of filterBtns2) {
      const txt = await btn.textContent();
      if (txt.trim() === 'all') { allBtn = btn; break; }
    }
    expect(allBtn).not.toBeNull();
    await allBtn.click();
    await sleep(500);

    // Verify both items visible again
    const resetItems = await page.$$('.todo-item');
    expect(resetItems.length).toBe(2);
    console.log(`  [T-3] PASS: both items visible after reset to "all": ${resetItems.length}`);

    console.log('  [T-3] ALL ASSERTIONS PASSED');
  }, 60000);
});
