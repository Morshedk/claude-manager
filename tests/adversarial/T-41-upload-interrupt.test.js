/**
 * T-41: Reload Browser During Active File Operation (Upload in Progress)
 *
 * Score: 9
 *
 * Flow:
 *   1. Start server on port 3138, create a project + session.
 *   2. In browser, initiate a large (~15MB) upload to /api/upload/image.
 *   3. Within 50ms, trigger hard reload (aborting the in-flight request).
 *   4. Reload again.
 *   5. Verify server is alive, session intact, crash log clean.
 *   6. Verify a fresh upload succeeds after the interrupted one.
 *
 * Note: If the upload completes before the reload (rare on slow hosts), we still
 * verify server stability — the scenario then becomes "upload completed, reload."
 *
 * Design doc: tests/adversarial/designs/T-41-design.md
 *
 * Run:
 *   fuser -k 3138/tcp 2>/dev/null; sleep 1
 *   PORT=3138 npx playwright test tests/adversarial/T-41-upload-interrupt.test.js --reporter=line --timeout=120000
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
const PORTS = { direct: 3138, tmux: 3738 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-41-upload-interrupt-${MODE}`);

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

  // Wait for server ready
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

test.describe(`T-41 — Reload Browser During Active File Upload [${MODE}]`, () => {
  let serverProc = null;
  let tmpDir = '';
  let crashLogPath = '';
  let testProjectId = '';
  let testProjectPath = '';
  let testSessionId = '';
  let browser = null;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on our port first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T41-XXXXXX').toString().trim();
    testProjectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(testProjectPath, { recursive: true });
    crashLogPath = path.join(tmpDir, 'crash.log');

    console.log(`\n  [T-41] tmpDir: ${tmpDir}`);

    // Seed projects.json
    const projectId = 'proj-t41-' + Date.now();
    testProjectId = projectId;
    const projectsData = {
      projects: [{
        id: projectId,
        name: 'T-41 Project',
        path: testProjectPath,
        createdAt: new Date().toISOString(),
      }],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(projectsData, null, 2));

    serverProc = await startServer(tmpDir, crashLogPath);
    console.log(`  [T-41] Server started on port ${PORT}`);

    // Connect via WS and create a session
    const ws = await openWs();

    // Wait for init message with clientId
    await waitForMessage(ws, m => m.type === 'init', 5000);

    // Create a session (bash command so it stays alive)
    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: testProjectId,
      name: 'T-41-session',
      command: 'bash',
      mode: MODE,
    }));

    const createdMsg = await waitForMessage(ws, m => m.type === 'session:created', 15000);
    testSessionId = createdMsg.session.id;
    console.log(`  [T-41] Session created: ${testSessionId}`);

    ws.close();

    // Allow session to reach running state
    await sleep(1000);

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

  test('T-41.01 — Upload interrupted by page reload; server survives', async () => {
    const page = await browser.newPage();

    try {
      // Step 1: Navigate to app
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(500);

      // Step 2: Record upload start time, initiate large upload in browser
      // Generate ~5MB of base64 data client-side — enough to take >200ms over localhost
      // We use page.evaluate with no await to let it run in background
      console.log('  [T-41.01] Starting large upload in browser...');

      const uploadStartMs = Date.now();

      // Start the upload in the browser but don't wait for completion
      // We use a Promise that we intentionally don't await from Playwright side
      await page.evaluate(() => {
        // Generate ~5MB of base64 data
        const chunk = 'AAAA'.repeat(1024 * 1024); // ~4MB base64
        window.__uploadController = new AbortController();
        window.__uploadStarted = Date.now();
        window.__uploadDone = false;
        window.__uploadError = null;

        fetch('/api/upload/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: chunk, ext: 'png' }),
          signal: window.__uploadController.signal,
        }).then(r => {
          window.__uploadDone = true;
          window.__uploadStatus = r.status;
        }).catch(e => {
          window.__uploadError = e.message;
        });
      });

      // Step 3: Hard reload almost immediately (within 100ms)
      await sleep(50);
      console.log(`  [T-41.01] Reloading browser ${Date.now() - uploadStartMs}ms after upload started...`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log('  [T-41.01] First reload complete');

      // Step 4: Wait briefly then reload again
      await sleep(500);
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log('  [T-41.01] Second reload complete');

      // Step 5: Wait for server to settle
      await sleep(2000);

      // Take screenshot
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-after-reload.png') });

      // Step 6: Verify server still responds
      const sessionsRes = await fetch(`${BASE_URL}/api/sessions`);
      expect(sessionsRes.status).toBe(200);
      const sessionsBody = await sessionsRes.json();
      const sessionsList = sessionsBody.managed || [];
      console.log(`  [T-41.01] Sessions after reload: ${JSON.stringify(sessionsList.map(s => ({ id: s.id.slice(0, 8), status: s.status || s.state })))}`);

      // Step 7: Session record must still be present
      const sessionFound = sessionsList.some(s => s.id === testSessionId);
      expect(sessionFound).toBe(true);
      console.log(`  [T-41.01] PASS: Session ${testSessionId.slice(0, 8)} still present`);

      // Step 8: Check crash log
      if (fs.existsSync(crashLogPath)) {
        const crashContent = fs.readFileSync(crashLogPath, 'utf-8').trim();
        if (crashContent.length > 0) {
          console.error(`  [T-41.01] FAIL: Crash log has content:\n${crashContent}`);
        }
        expect(crashContent).toBe('');
      } else {
        console.log('  [T-41.01] Crash log does not exist (no crashes) — PASS');
      }

      // Step 9: Verify app loaded cleanly — look for the project in DOM
      // After reload, need to select the project. The page should show UI elements.
      await page.waitForSelector('body', { timeout: 5000 });
      const bodyText = await page.evaluate(() => document.body.innerText);
      // App should show something (not blank)
      expect(bodyText.length).toBeGreaterThan(0);
      console.log(`  [T-41.01] App body text length: ${bodyText.length} chars`);

    } finally {
      await page.close();
    }
  });

  test('T-41.02 — Fresh upload succeeds after interrupted upload', async () => {
    // Verify the upload endpoint still works after the interrupted upload
    console.log('  [T-41.02] Testing fresh upload after interrupted upload...');

    // Small payload (~1KB)
    const smallData = Buffer.from('fake-png-data-'.repeat(100)).toString('base64');
    const res = await fetch(`${BASE_URL}/api/upload/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: smallData, ext: 'png' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBeTruthy();
    expect(typeof body.path).toBe('string');
    console.log(`  [T-41.02] PASS: Fresh upload returned path: ${body.path}`);

    // Verify the file actually exists
    const fileExists = fs.existsSync(body.path);
    expect(fileExists).toBe(true);
    console.log(`  [T-41.02] PASS: Uploaded file exists at ${body.path}`);
  });

  test('T-41.03 — Three rapid uploads all succeed (no handle leak)', async () => {
    console.log('  [T-41.03] Testing 3 rapid uploads...');

    const smallData = Buffer.from('rapid-test-data-'.repeat(50)).toString('base64');

    const results = await Promise.all([1, 2, 3].map(async (i) => {
      const res = await fetch(`${BASE_URL}/api/upload/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: smallData, ext: 'png' }),
      });
      return { i, status: res.status };
    }));

    for (const r of results) {
      expect(r.status).toBe(200);
    }
    console.log(`  [T-41.03] PASS: All 3 rapid uploads returned 200`);
  });

  test('T-41.04 — Session record survives upload interruption', async () => {
    console.log('  [T-41.04] Verifying session record integrity...');

    const sessionsRes = await fetch(`${BASE_URL}/api/sessions`);
    expect(sessionsRes.status).toBe(200);
    const sessionsBody = await sessionsRes.json();
    const sessionsList = sessionsBody.managed || [];

    const session = sessionsList.find(s => s.id === testSessionId);
    expect(session).toBeTruthy();
    expect(session.projectId).toBe(testProjectId);

    const status = session.status || session.state;
    // Session should be in a known state (running or stopped — bash may have been killed by reload side effect)
    const validStatuses = ['running', 'stopped', 'starting', 'error'];
    expect(validStatuses).toContain(status);

    console.log(`  [T-41.04] PASS: Session ${testSessionId.slice(0, 8)} has status: ${status}, projectId intact`);
  });
});
} // end for (const MODE of MODES)
