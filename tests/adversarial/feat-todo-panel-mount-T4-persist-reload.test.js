/**
 * feat-todo-panel-mount T-4: TODO persists after browser reload
 *
 * Pass condition:
 *   - TODO seeded via REST appears in the UI
 *   - After full page reload, same TODO is still present with correct priority
 *
 * Port: 3223
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
const PORT = 3223;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('feat-todo-panel-mount T-4 — Persist after browser reload', () => {
  let serverProc = null;
  let tmpDir = '';
  let browser = null;
  let page = null;

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-todo-T4-XXXXXX').toString().trim();
    console.log(`\n  [T-4] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-t4',
        name: 'Reload Project',
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
    console.log('  [T-4] Server ready');

    // Seed TODO via REST
    const addResp = await fetch(`${BASE_URL}/api/todos/proj-t4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Persisted task', priority: 'low', estimate: '5m' }),
    });
    const added = await addResp.json();
    console.log(`  [T-4] Seeded TODO:`, added.id || 'unknown id');

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

  test('TODO seeded via REST appears and survives page reload', async () => {
    // First visit
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.waitForSelector('text=Reload Project', { timeout: 10000 });
    await page.click('text=Reload Project');
    await sleep(1000);

    await page.waitForSelector('#todos-tab-btn', { timeout: 10000 });
    await page.click('#todos-tab-btn');
    await sleep(1500);

    // Verify item on first visit
    await page.waitForSelector('.todo-item', { timeout: 5000 });
    const titleFirst = await page.textContent('.todo-title');
    expect(titleFirst).toContain('Persisted task');
    console.log(`  [T-4] First visit: "${titleFirst}"`);

    // Verify priority
    const priorityEl = await page.$('.todo-priority');
    const priorityText = await priorityEl.textContent();
    expect(priorityText.toLowerCase()).toContain('low');
    console.log(`  [T-4] Priority shown: "${priorityText}"`);

    // Full reload
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.waitForSelector('text=Reload Project', { timeout: 10000 });
    await page.click('text=Reload Project');
    await sleep(1000);

    await page.waitForSelector('#todos-tab-btn', { timeout: 10000 });
    await page.click('#todos-tab-btn');
    await sleep(1500);

    // Verify still there after reload
    await page.waitForSelector('.todo-item', { timeout: 5000 });
    const titleAfter = await page.textContent('.todo-title');
    expect(titleAfter).toContain('Persisted task');
    console.log(`  [T-4] PASS: after reload: "${titleAfter}"`);

    const priorityAfterEl = await page.$('.todo-priority');
    const priorityAfter = await priorityAfterEl.textContent();
    expect(priorityAfter.toLowerCase()).toContain('low');
    console.log(`  [T-4] PASS: priority preserved after reload: "${priorityAfter}"`);

    console.log('  [T-4] ALL ASSERTIONS PASSED');
  }, 60000);
});
