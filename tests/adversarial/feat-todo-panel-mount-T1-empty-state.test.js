/**
 * feat-todo-panel-mount T-1: TodoPanel reachable via UI — empty state for fresh project
 *
 * Pass condition:
 *   - #todos-tab-btn exists in DOM after selecting a project
 *   - Clicking it mounts #todo-panel-container
 *   - .todo-header-title shows "TODO List"
 *   - .todo-empty shows "No TODOs yet"
 *   - #project-sessions-list is NOT present while on TODOs tab
 *
 * Port: 3220
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
const PORT = 3220;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('feat-todo-panel-mount T-1 — TodoPanel empty state reachable', () => {
  let serverProc = null;
  let tmpDir = '';
  let browser = null;
  let page = null;

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-todo-T1-XXXXXX').toString().trim();
    console.log(`\n  [T-1] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: 'proj-t1',
        name: 'Test Project',
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
    console.log('  [T-1] Server ready');

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

  test('TODOs tab button exists and mounts TodoPanel with empty state', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Select project
    await page.waitForSelector('text=Test Project', { timeout: 10000 });
    await page.click('text=Test Project');
    await sleep(1000);

    // Wait for detail pane
    await page.waitForSelector('#project-detail.visible', { timeout: 10000 });

    // Assert TODOs tab button exists
    const todosTabBtn = await page.$('#todos-tab-btn');
    expect(todosTabBtn).not.toBeNull();
    console.log('  [T-1] PASS: #todos-tab-btn found in DOM');

    // Click TODOs tab
    await page.click('#todos-tab-btn');
    await sleep(1500);

    // Assert todo-panel-container mounted
    const container = await page.$('#todo-panel-container');
    expect(container).not.toBeNull();
    console.log('  [T-1] PASS: #todo-panel-container mounted');

    // Assert TodoPanel header title
    const headerTitle = await page.textContent('.todo-header-title');
    expect(headerTitle).toContain('TODO List');
    console.log(`  [T-1] PASS: .todo-header-title = "${headerTitle}"`);

    // Assert empty state
    const emptyEl = await page.$('.todo-empty');
    expect(emptyEl).not.toBeNull();
    const emptyText = await emptyEl.textContent();
    expect(emptyText).toContain('No TODOs yet');
    console.log(`  [T-1] PASS: empty state visible: "${emptyText.trim()}"`);

    // Assert sessions list is hidden
    const sessionsList = await page.$('#project-sessions-list');
    expect(sessionsList).toBeNull();
    console.log('  [T-1] PASS: #project-sessions-list not in DOM while on TODOs tab');

    console.log('  [T-1] ALL ASSERTIONS PASSED');
  }, 60000);
});
