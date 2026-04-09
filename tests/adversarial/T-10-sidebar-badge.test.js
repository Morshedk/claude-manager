/**
 * T-10: Session Count Badge in Sidebar Matches Live Running Sessions
 *
 * Source: Story 13
 * Score: L=5 S=3 D=4 (Total: 12)
 *
 * Flow: Create 3 sessions in one project (bash, not Claude). Start 2 of them.
 * Stop 1. Check sidebar badge. Then restart the stopped one and verify badge updates.
 *
 * Pass condition:
 *   - Badge shows "N sessions running" matching exactly the running sessions.
 *   - Badge updates within 3 seconds — without page reload.
 *
 * Run: PORT=3107 npx playwright test tests/adversarial/T-10-sidebar-badge.test.js --reporter=line --timeout=180000
 */

import { test, expect, chromium } from 'playwright/test';
import WebSocket from 'ws';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3107;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T10-sidebar-badge');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── WS helpers ────────────────────────────────────────────────────────────────

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

function waitForWsMessage(ws, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS waitForMessage timeout after ${timeout}ms`)), timeout);
    function onMsg(d) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    }
    ws.on('message', onMsg);
  });
}

function sendWs(ws, msg) {
  ws.send(JSON.stringify(msg));
}

// ── Shared state ──────────────────────────────────────────────────────────────

let serverProc = null;
let tmpDir = '';
let projectId = '';
let sessionIds = [];    // [s1, s2, s3]
let ctrlWs = null;      // control WebSocket

test.describe('T-10 — Sidebar Badge Real-Time Session Count', () => {

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3107
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Fresh isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-T10-XXXXXX').toString().trim();
    console.log(`\n  [T-10] tmpDir: ${tmpDir}`);
    fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });

    // Start server
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready — poll /api/projects up to 15s
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(500);
    }
    if (!ready) throw new Error('Test server failed to start within 15s');
    console.log(`  [T-10] Server ready on port ${PORT}`);

    // Create test project via REST
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T10-BadgeProject', path: path.join(tmpDir, 'project') }),
    }).then(r => r.json());
    projectId = proj.id || proj.project?.id;
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);
    console.log(`  [T-10] projectId: ${projectId}`);

    // Connect control WS
    ctrlWs = await connectWs();

    // Wait for init
    await waitForWsMessage(ctrlWs, m => m.type === 'init' || m.type === 'server:init', 5000)
      .catch(() => console.log('  [T-10] No init message received (ok if already past it)'));

    // Create 3 bash sessions
    for (let i = 1; i <= 3; i++) {
      sendWs(ctrlWs, {
        type: 'session:create',
        projectId,
        name: `T10-sess-${i}`,
        command: 'bash',
        mode: 'direct',
        cols: 80,
        rows: 24,
      });
      const created = await waitForWsMessage(ctrlWs, m => m.type === 'session:created', 8000);
      sessionIds.push(created.session.id);
      console.log(`  [T-10] Created session ${i}: ${created.session.id}`);
      await sleep(300); // small gap between creates to avoid dedup window
    }

    console.log(`  [T-10] All 3 sessions created: ${sessionIds.join(', ')}`);
  });

  test.afterAll(async () => {
    // Stop all sessions
    for (const id of sessionIds) {
      try {
        sendWs(ctrlWs, { type: 'session:stop', id });
        await sleep(200);
      } catch {}
    }
    if (ctrlWs) try { ctrlWs.close(); } catch {}
    if (serverProc) serverProc.kill('SIGTERM');
    await sleep(500);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── Scenario A: Stop one of 3 running sessions, badge drops from 3 to 2 ──

  test('Scenario A — stopping 1 session updates badge from 3 to 2 in real time', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      // Navigate to app
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500); // wait for initial sessions:list to arrive and render

      // Select the test project
      const projectItem = page.locator('.project-item', { hasText: 'T10-BadgeProject' });
      await projectItem.waitFor({ timeout: 5000 });
      await projectItem.click();
      await page.waitForTimeout(500);

      // Check badge shows 3 sessions running before any stops
      const badge = projectItem.locator('.project-item-badge');
      await expect(badge).toHaveText('3 sessions running', { timeout: 5000 });
      await expect(badge).toHaveClass(/has-sessions/, { timeout: 3000 });
      console.log('  [T-10 A] PRE-STOP: badge shows "3 sessions running" ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'A-01-before-stop.png') });

      // Set up listener for sessions:list update before sending stop
      const sessionsListPromise = waitForWsMessage(ctrlWs, m => m.type === 'sessions:list', 5000);

      // Stop session 1 via WS
      sendWs(ctrlWs, { type: 'session:stop', id: sessionIds[0] });
      console.log(`  [T-10 A] Sent stop for session ${sessionIds[0]}`);

      // Wait for broadcast
      await sessionsListPromise;
      console.log('  [T-10 A] sessions:list broadcast received');

      // Assert badge updates to 2 within 3 seconds — no page reload
      await expect(badge).toHaveText('2 sessions running', { timeout: 3000 });
      await expect(badge).toHaveClass(/has-sessions/, { timeout: 3000 });
      console.log('  [T-10 A] POST-STOP: badge shows "2 sessions running" ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'A-02-after-stop.png') });

      // Confirm no page reload: navigation type should be 0 (navigate, not reload)
      const navType = await page.evaluate(() => performance.navigation?.type ?? -1);
      expect(navType).not.toBe(1); // type 1 = reload
      console.log(`  [T-10 A] Page was not reloaded (navigation.type=${navType}) ✓`);

    } finally {
      await browser.close();
    }
  });

  // ── Scenario B: Stop another, then refresh/restart it, badge goes 1 → 2 ──

  test('Scenario B — refreshing stopped session updates badge from 1 to 2 in real time', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      // Navigate and select project
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);

      const projectItem = page.locator('.project-item', { hasText: 'T10-BadgeProject' });
      await projectItem.waitFor({ timeout: 5000 });
      await projectItem.click();
      await page.waitForTimeout(500);

      const badge = projectItem.locator('.project-item-badge');

      // At this point s1 is stopped (from Scenario A), s2 and s3 are running → badge = 2
      await expect(badge).toHaveText('2 sessions running', { timeout: 5000 });
      console.log('  [T-10 B] PRE-STOP: badge shows "2 sessions running" ✓');

      // Stop session 2 via WS
      const stopPromise = waitForWsMessage(ctrlWs, m => m.type === 'sessions:list', 5000);
      sendWs(ctrlWs, { type: 'session:stop', id: sessionIds[1] });
      await stopPromise;

      // Badge should drop to 1 within 3 seconds
      await expect(badge).toHaveText('1 session running', { timeout: 3000 });
      await expect(badge).toHaveClass(/has-sessions/, { timeout: 3000 });
      console.log('  [T-10 B] AFTER STOP: badge shows "1 session running" ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'B-01-after-s2-stop.png') });

      // Refresh (restart) session 2 via WS
      const refreshPromise = waitForWsMessage(ctrlWs, m => m.type === 'session:refreshed' && m.id === sessionIds[1], 8000);
      const listAfterRefreshPromise = waitForWsMessage(ctrlWs, m => m.type === 'sessions:list', 8000);
      sendWs(ctrlWs, { type: 'session:refresh', id: sessionIds[1], cols: 80, rows: 24 });
      await refreshPromise;
      console.log('  [T-10 B] session:refreshed received for s2');
      await listAfterRefreshPromise;
      console.log('  [T-10 B] sessions:list broadcast received after refresh');

      // Badge should update to 2 within 3 seconds — no page reload
      await expect(badge).toHaveText('2 sessions running', { timeout: 3000 });
      await expect(badge).toHaveClass(/has-sessions/, { timeout: 3000 });
      console.log('  [T-10 B] AFTER REFRESH: badge shows "2 sessions running" ✓');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'B-02-after-s2-restart.png') });

      // Confirm no page reload
      const navType = await page.evaluate(() => performance.navigation?.type ?? -1);
      expect(navType).not.toBe(1);
      console.log(`  [T-10 B] Page was not reloaded (navigation.type=${navType}) ✓`);

    } finally {
      await browser.close();
    }
  });

});
