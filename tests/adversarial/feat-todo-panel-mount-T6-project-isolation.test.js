/**
 * feat-todo-panel-mount T-6: Project switching — TODOs are isolated per project
 *
 * Pass condition:
 *   - Project Alpha's TODO visible on its TODOs tab
 *   - After switching to Project Beta, Alpha's TODO is NOT visible
 *   - Project Beta shows empty state (its own isolated data)
 *
 * Port: 3225
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
const PORT = 3225;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('feat-todo-panel-mount T-6 — Project isolation', () => {
  let serverProc = null;
  let tmpDir = '';
  let browser = null;
  let page = null;

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-todo-T6-XXXXXX').toString().trim();
    console.log(`\n  [T-6] tmpDir: ${tmpDir}`);

    // Use distinct paths to avoid ProjectStore's path-based dedup
    const alphaPath = path.join(tmpDir, 'alpha');
    const betaPath = path.join(tmpDir, 'beta');
    fs.mkdirSync(alphaPath, { recursive: true });
    fs.mkdirSync(betaPath, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [
        {
          id: 'proj-t6a',
          name: 'Project Alpha',
          path: alphaPath,
          createdAt: '2026-01-01T00:00:00.000Z',
          settings: {}
        },
        {
          id: 'proj-t6b',
          name: 'Project Beta',
          path: betaPath,
          createdAt: '2026-01-01T00:00:01.000Z',
          settings: {}
        }
      ],
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
    console.log('  [T-6] Server ready');

    // Seed TODO for Alpha only
    await fetch(`${BASE_URL}/api/todos/proj-t6a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alpha task', priority: 'high', estimate: '1h' }),
    });

    // Verify Beta has no TODOs
    const betaCheck = await fetch(`${BASE_URL}/api/todos/proj-t6b`).then(r => r.json());
    console.log(`  [T-6] Beta TODOs count: ${betaCheck.items?.length ?? 0}`);

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

  test('Alpha TODOs do not appear in Beta after project switch', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Click Project Alpha — use .project-item-name for precise matching
    await page.waitForSelector('.project-item-name', { timeout: 10000 });
    const projectItems = await page.$$('.project-item-name');
    let alphaItem = null, betaItem = null;
    for (const item of projectItems) {
      const txt = await item.textContent();
      if (txt.includes('Project Alpha')) alphaItem = item;
      if (txt.includes('Project Beta')) betaItem = item;
    }
    expect(alphaItem).not.toBeNull();
    expect(betaItem).not.toBeNull();
    await alphaItem.click();
    await sleep(1000);

    await page.waitForSelector('#todos-tab-btn', { timeout: 10000 });
    await page.click('#todos-tab-btn');
    await sleep(1500);

    // Verify Alpha task visible
    await page.waitForSelector('.todo-item', { timeout: 5000 });
    const alphaTitle = await page.textContent('.todo-title');
    expect(alphaTitle).toContain('Alpha task');
    console.log(`  [T-6] Alpha TODO confirmed: "${alphaTitle}"`);

    // Now switch to Project Beta (stay on TODOs tab — re-query since DOM may update)
    const projectItems2 = await page.$$('.project-item-name');
    let betaItemRefreshed = null;
    for (const item of projectItems2) {
      const txt = await item.textContent();
      if (txt.includes('Project Beta')) { betaItemRefreshed = item; break; }
    }
    expect(betaItemRefreshed).not.toBeNull();
    await betaItemRefreshed.click();
    await sleep(2000); // Give TodoPanel time to re-fetch

    // Verify Alpha task is NOT visible
    const pageContent = await page.textContent('.todo-list, #todo-panel-container');
    expect(pageContent).not.toContain('Alpha task');
    console.log('  [T-6] PASS: Alpha task NOT visible in Beta project');

    // Verify Beta shows empty state
    const emptyEl = await page.$('.todo-empty');
    expect(emptyEl).not.toBeNull();
    const emptyText = await emptyEl.textContent();
    expect(emptyText).toContain('No TODOs yet');
    console.log(`  [T-6] PASS: Beta shows empty state: "${emptyText.trim()}"`);

    console.log('  [T-6] ALL ASSERTIONS PASSED');
  }, 60000);
});
