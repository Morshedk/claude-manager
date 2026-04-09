/**
 * T-42: Multi-Project Badge Counts Are Fully Independent
 *
 * Score: 11
 *
 * Flow:
 *   1. Create Project A with 3 running sessions (bash command).
 *   2. Create Project B with 0 sessions.
 *   3. Navigate browser to app.
 *   4. Assert: Project A badge = "3 sessions running", Project B badge = "idle".
 *   5. Stop one session in Project A via WS.
 *   6. Assert: Project A badge = "2 sessions running", Project B badge still = "idle".
 *
 * Pass: Badge counts are strictly per-project, independent of each other.
 * Fail: Project B shows non-zero (cross-project contamination), or Project A
 *       fails to decrement.
 *
 * Design doc: tests/adversarial/designs/T-42-design.md
 *
 * Run:
 *   fuser -k 3139/tcp 2>/dev/null; sleep 1
 *   PORT=3139 npx playwright test tests/adversarial/T-42-badge-independence.test.js --reporter=line --timeout=120000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3139;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-42-badge-independence');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 10000);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS message timeout after ${timeoutMs}ms`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

// ── Server startup ────────────────────────────────────────────────────────────

async function startServer(tmpDir, crashLogPath) {
  const proc = spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DATA_DIR: tmpDir,
      PORT: String(PORT),
      CRASH_LOG: crashLogPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/`);
      if (r.ok) break;
    } catch {}
    await sleep(400);
  }
  return proc;
}

// ── Main test ─────────────────────────────────────────────────────────────────

test.describe('T-42 — Multi-Project Badge Counts Are Fully Independent', () => {
  let serverProc = null;
  let tmpDir = '';
  let crashLogPath = '';
  let projectAId = '';
  let projectBId = '';
  let sessionIds = []; // 3 sessions in Project A
  let browser = null;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T42-XXXXXX').toString().trim();
    crashLogPath = path.join(tmpDir, 'crash.log');

    console.log(`\n  [T-42] tmpDir: ${tmpDir}`);

    // Create project directories
    projectAId = 'proj-t42-A-' + Date.now();
    projectBId = 'proj-t42-B-' + (Date.now() + 1);

    const projectAPath = path.join(tmpDir, 'project-a');
    const projectBPath = path.join(tmpDir, 'project-b');
    fs.mkdirSync(projectAPath, { recursive: true });
    fs.mkdirSync(projectBPath, { recursive: true });

    // Seed projects.json with both projects
    const projectsData = {
      projects: [
        {
          id: projectAId,
          name: 'Project Alpha',
          path: projectAPath,
          createdAt: new Date().toISOString(),
        },
        {
          id: projectBId,
          name: 'Project Beta',
          path: projectBPath,
          createdAt: new Date().toISOString(),
        },
      ],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(projectsData, null, 2));

    serverProc = await startServer(tmpDir, crashLogPath);
    console.log(`  [T-42] Server started on port ${PORT}`);

    // Connect via WS, create 3 sessions in Project A
    const ws = await openWs();
    await waitForMessage(ws, m => m.type === 'init', 5000);

    for (let i = 1; i <= 3; i++) {
      ws.send(JSON.stringify({
        type: 'session:create',
        projectId: projectAId,
        name: `alpha-session-${i}`,
        command: 'bash',
        mode: 'direct',
      }));
      const created = await waitForMessage(ws, m => m.type === 'session:created', 15000);
      sessionIds.push(created.session.id);
      console.log(`  [T-42] Created session ${i}: ${created.session.id.slice(0, 8)}`);
    }

    ws.close();

    // Allow sessions to reach RUNNING state
    await sleep(1500);
    console.log(`  [T-42] 3 sessions created in Project Alpha`);

    browser = await chromium.launch({ headless: true });
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
    if (serverProc) {
      serverProc.kill();
      await sleep(500);
    }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    try { execSync(`rm -rf ${tmpDir}`); } catch {}
  });

  test('T-42.01 — Initial badges: Project A = 3 running, Project B = idle', async () => {
    const page = await browser.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

      // Wait for project list to load
      await page.waitForSelector('.project-item', { timeout: 10000 });

      // Poll until Project Alpha shows "3 sessions running"
      let alphaText = '';
      let betaText = '';
      const deadline = Date.now() + 10000;

      while (Date.now() < deadline) {
        const badges = await page.evaluate(() => {
          const items = document.querySelectorAll('.project-item');
          const result = {};
          for (const item of items) {
            const name = item.querySelector('.project-item-name')?.textContent?.trim();
            const badge = item.querySelector('.project-item-badge')?.textContent?.trim();
            if (name) result[name] = badge;
          }
          return result;
        });

        alphaText = badges['Project Alpha'] || '';
        betaText = badges['Project Beta'] || '';

        console.log(`  [T-42.01] Alpha: "${alphaText}", Beta: "${betaText}"`);

        if (alphaText.includes('3 session')) break;
        await sleep(300);
      }

      // Take screenshot
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-initial-badges.png') });

      // Assert Project Alpha shows 3 running
      expect(alphaText).toContain('3 session');
      console.log(`  [T-42.01] PASS: Project Alpha shows: "${alphaText}"`);

      // Assert Project Beta shows idle
      expect(betaText.toLowerCase()).toContain('idle');
      console.log(`  [T-42.01] PASS: Project Beta shows: "${betaText}"`);

    } finally {
      await page.close();
    }
  });

  test('T-42.02 — Stop one session in Project A; badges update correctly', async () => {
    const page = await browser.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.project-item', { timeout: 10000 });

      // Wait for initial state to be visible
      const initialDeadline = Date.now() + 8000;
      while (Date.now() < initialDeadline) {
        const badges = await page.evaluate(() => {
          const items = document.querySelectorAll('.project-item');
          const result = {};
          for (const item of items) {
            const name = item.querySelector('.project-item-name')?.textContent?.trim();
            const badge = item.querySelector('.project-item-badge')?.textContent?.trim();
            if (name) result[name] = badge;
          }
          return result;
        });
        if ((badges['Project Alpha'] || '').includes('3 session')) break;
        await sleep(300);
      }

      // Stop session 1 via WS
      const ws = await openWs();
      await waitForMessage(ws, m => m.type === 'init', 5000);

      console.log(`  [T-42.02] Stopping session: ${sessionIds[0].slice(0, 8)}`);
      ws.send(JSON.stringify({ type: 'session:stop', id: sessionIds[0] }));

      // Wait for sessions:list broadcast confirming the stop
      await waitForMessage(ws, m => {
        if (m.type !== 'sessions:list') return false;
        const sess = m.sessions.find(s => s.id === sessionIds[0]);
        return sess && (sess.status === 'stopped' || sess.state === 'stopped');
      }, 10000);

      ws.close();
      console.log(`  [T-42.02] Session stopped — waiting for badge update...`);

      // Poll for Project Alpha to show 2 sessions
      let alphaText = '';
      let betaText = '';
      const deadline = Date.now() + 8000;

      while (Date.now() < deadline) {
        const badges = await page.evaluate(() => {
          const items = document.querySelectorAll('.project-item');
          const result = {};
          for (const item of items) {
            const name = item.querySelector('.project-item-name')?.textContent?.trim();
            const badge = item.querySelector('.project-item-badge')?.textContent?.trim();
            if (name) result[name] = badge;
          }
          return result;
        });

        alphaText = badges['Project Alpha'] || '';
        betaText = badges['Project Beta'] || '';

        console.log(`  [T-42.02] Alpha: "${alphaText}", Beta: "${betaText}"`);

        if (alphaText.includes('2 session')) break;
        await sleep(300);
      }

      // Take screenshot
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-after-stop.png') });

      // Assert Project Alpha shows 2 running (decremented)
      expect(alphaText).toContain('2 session');
      console.log(`  [T-42.02] PASS: Project Alpha decremented to: "${alphaText}"`);

      // Assert Project Beta still idle
      expect(betaText.toLowerCase()).toContain('idle');
      console.log(`  [T-42.02] PASS: Project Beta unchanged: "${betaText}"`);

    } finally {
      await page.close();
    }
  });

  test('T-42.03 — Project B badge never shows non-zero count', async () => {
    // Additional verification: check API directly that Project B has no sessions
    const sessionsRes = await fetch(`${BASE_URL}/api/sessions`);
    const sessionsBody = await sessionsRes.json();
    const allSessions = sessionsBody.managed || [];

    const projectBSessions = allSessions.filter(s => s.projectId === projectBId);
    const projectBRunning = projectBSessions.filter(s =>
      s.status === 'running' || s.state === 'running'
    );

    expect(projectBSessions.length).toBe(0);
    expect(projectBRunning.length).toBe(0);
    console.log(`  [T-42.03] PASS: Project Beta has 0 sessions in server state`);

    // Also verify the crash log is clean
    if (fs.existsSync(crashLogPath)) {
      const crashContent = fs.readFileSync(crashLogPath, 'utf-8').trim();
      expect(crashContent).toBe('');
    }
    console.log(`  [T-42.03] PASS: No server crashes`);
  });
});
