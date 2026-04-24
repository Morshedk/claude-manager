/**
 * T-1: Portrait card renders with all four structural sections
 * Port: 3500
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3500;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;
let projectId = null;

test.describe('feat-session-cards T-1 — Portrait card DOM structure', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-portrait-T1-XXXXXX').toString().trim();
    console.log(`\n  [T-1] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project', { recursive: true }); // ensure project path exists

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-test-1', name: 'Test Project', path: '/tmp/test-project' }],
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

    // Wait for server
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Server failed to start within 20s');
    console.log('  [T-1] Server ready');

    // Create session via WS
    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 10000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-test-1',
            name: 'test-portrait',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          clearTimeout(t);
          projectId = msg.session.projectId;
          ws.close();
          resolve(msg.session.id);
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`  [T-1] Session created: ${sessionId}`);
    await sleep(500);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('All four structural sections present in portrait card', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1500);

      // Click on the project in the sidebar
      await page.waitForSelector('text=Test Project', { timeout: 10000 });
      await page.click('text=Test Project');
      await sleep(1000);

      // Wait for session card
      await page.waitForSelector('.session-card', { timeout: 10000 });
      console.log('  [T-1] Session card visible');

      const card = page.locator('.session-card').first();

      // 1. Title bar with session name
      const titlebar = card.locator('.session-card-titlebar');
      await titlebar.waitFor({ state: 'visible', timeout: 5000 });
      const cardName = titlebar.locator('.session-card-name');
      await cardName.waitFor({ state: 'visible', timeout: 3000 });
      const nameText = await cardName.textContent();
      expect(nameText).toContain('test-portrait');
      console.log(`  [T-1] Card name text: "${nameText}"`);

      // 2. Title bar has summary (or placeholder)
      const summary = titlebar.locator('.session-card-summary');
      const summaryCount = await summary.count();
      expect(summaryCount).toBeGreaterThanOrEqual(1);
      const summaryText = await summary.first().textContent();
      console.log(`  [T-1] Summary text: "${summaryText}"`);
      // Accept either "No summary yet" placeholder or any non-empty summary
      expect(summaryText.trim().length).toBeGreaterThan(0);

      // 3. Tags section with at least one badge
      const tags = card.locator('.session-card-tags');
      await tags.waitFor({ state: 'visible', timeout: 5000 });
      const badges = tags.locator('.badge');
      const badgeCount = await badges.count();
      expect(badgeCount).toBeGreaterThanOrEqual(1);
      console.log(`  [T-1] Badge count: ${badgeCount}`);

      // 4. Preview pane as <pre>
      const preview = card.locator('pre.session-card-preview');
      await preview.waitFor({ state: 'visible', timeout: 5000 });
      const previewTag = await preview.evaluate(el => el.tagName.toLowerCase());
      expect(previewTag).toBe('pre');
      console.log('  [T-1] Preview is <pre> element');

      // 5. Action bar with .btn-icon button (wrench)
      const actionbar = card.locator('.session-card-actionbar');
      await actionbar.waitFor({ state: 'visible', timeout: 5000 });
      const btnIcon = actionbar.locator('.btn-icon');
      const btnIconCount = await btnIcon.count();
      expect(btnIconCount).toBeGreaterThanOrEqual(1);
      console.log(`  [T-1] .btn-icon count in actionbar: ${btnIconCount}`);

      // 6. NO legacy session-card-actions element
      const legacyActions = card.locator('.session-card-actions');
      const legacyCount = await legacyActions.count();
      expect(legacyCount).toBe(0);
      console.log('  [T-1] No legacy .session-card-actions element');

      // 7. Card's computed flex-direction is column
      const flexDirection = await card.evaluate(el =>
        window.getComputedStyle(el).flexDirection
      );
      expect(flexDirection).toBe('column');
      console.log(`  [T-1] flex-direction: ${flexDirection}`);

      console.log('  [T-1] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
