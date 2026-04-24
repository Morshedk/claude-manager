/**
 * T-14: Delete Confirmation Dialog — Cancel Leaves Session Intact
 *
 * Score: L=4 S=4 D=3 (Total: 11)
 *
 * Flow: Create and stop a session. Click "Delete" on the session card. When the
 * browser confirmation dialog appears, click "Cancel." Observe the session list.
 *
 * Pass condition: The session card remains in the list. No delete API call was made.
 * The session record is intact on the server.
 *
 * Fail signal: The session is deleted even when cancel is clicked. Or the dialog
 * doesn't appear at all (delete happens immediately without confirmation). Or clicking
 * cancel causes the card to show a broken state.
 *
 * Run: PORT=3111 npx playwright test tests/adversarial/T-14-delete-cancel.test.js --reporter=line --timeout=120000
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
const PORTS = { direct: 3111, tmux: 3711 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T14-delete-cancel-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── WebSocket helpers ─────────────────────────────────────────────────────────

/**
 * Open a raw WS, wait for ready, send one message, collect messages until
 * `predicate` returns truthy or timeout expires. Returns the matched message.
 */
function wsTransaction(port, sendMsg, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WS transaction timeout (${timeoutMs}ms) waiting for ${JSON.stringify(sendMsg?.type)}`));
    }, timeoutMs);

    ws.once('open', () => {
      ws.send(JSON.stringify(sendMsg));
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });

    ws.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Create a session via WS. Returns the created session object.
 */
async function createSession(port, projectId, name) {
  return wsTransaction(
    port,
    { type: 'session:create', projectId, name, command: 'bash', mode: MODE, cols: 120, rows: 30 },
    msg => msg.type === 'session:created',
    12000
  ).then(msg => msg.session);
}

/**
 * Stop a session via WS. Waits for stopped/exited state.
 */
async function stopSession(port, sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`stopSession timeout for ${sessionId}`));
    }, 15000);

    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'session:stop', id: sessionId }));
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'session:state' && msg.id === sessionId &&
          (msg.state === 'stopped' || msg.state === 'error' || msg.state === 'exited')) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
      // Also accept sessions:list broadcast showing stopped session
      if (msg.type === 'sessions:list') {
        const s = (msg.sessions || []).find(x => x.id === sessionId);
        if (s && s.status !== 'running' && s.status !== 'starting') {
          clearTimeout(timer);
          ws.close();
          resolve({ type: 'sessions:list', status: s.status });
        }
      }
    });

    ws.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Fetch sessions list from REST API.
 */
async function getSessionsRest() {
  const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
  return Array.isArray(data.managed) ? data.managed : (Array.isArray(data) ? data : []);
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe(`T-14 — Delete Confirmation Dialog: Cancel Leaves Session Intact [${MODE}]`, () => {

  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on the port first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Fresh isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-T14-XXXXXX').toString().trim();
    console.log(`\n  [T-14] tmpDir: ${tmpDir}`);

    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');
    console.log(`  [T-14] Server ready on port ${PORT}`);

    // Create test project
    const projDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projDir, { recursive: true });
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T14-project', path: projDir }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T-14] Project created: ${testProjectId} (${proj.name})`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(2000);
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }

    // Check crash log
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      const meaningfulCrash = crashLog.split('\n').some(line =>
        line.includes('Error') || line.includes('Exception') ||
        line.includes('uncaught') || line.includes('unhandledRejection')
      );
      if (meaningfulCrash) {
        console.log('\n  [T-14 CRASH LOG]\n' + crashLog);
      }
    } catch {}

    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  // ── Helper: open browser, navigate to project ─────────────────────────────

  async function openAppAndNavigate(browser) {
    const page = await browser.newPage();

    // Intercept WS messages to capture any session:delete sends
    const wsSendLog = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          const msg = JSON.parse(frame.payload);
          wsSendLog.push(msg);
        } catch {}
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for connected
    await page.waitForFunction(
      () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
            document.body.textContent.includes('Connected'),
      { timeout: 30000 }
    ).catch(() => {});
    await sleep(1500);

    // Navigate to the test project
    await page.waitForSelector('text=T14-project', { timeout: 15000 });
    await page.click('text=T14-project');
    await sleep(1000);

    return { page, wsSendLog };
  }

  // ── Helper: wait for session card with Delete button ──────────────────────

  async function waitForSessionCard(page, sessionName) {
    // Wait for the session card to appear
    await page.waitForSelector(`.session-card`, { timeout: 10000 });
    await sleep(500);

    // Find Delete button on the matching card
    const deleteBtn = page.locator(`.session-card:has-text("${sessionName}") button:has-text("Delete")`);

    // Try waiting for it (Delete only shows for stopped sessions)
    await deleteBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(async () => {
      // If still not visible, take a diagnostic screenshot
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'diag-no-delete-btn.png'), fullPage: true });
      throw new Error(`Delete button not visible for session "${sessionName}" — session may still be running`);
    });

    return deleteBtn;
  }

  // ── MAIN TEST ─────────────────────────────────────────────────────────────

  test('T-14.A — Cancel on delete dialog leaves session intact (3 iterations)', async () => {
    test.setTimeout(180000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
      const { page, wsSendLog } = await openAppAndNavigate(browser);

      // Run 3 cancel iterations
      for (let i = 1; i <= 3; i++) {
        console.log(`\n  [T-14] === Cancel iteration ${i}/3 ===`);

        const sessionName = `T14-repeat-${i}`;

        // Create a new bash session
        console.log(`  [T-14] Creating session: ${sessionName}`);
        const session = await createSession(PORT, testProjectId, sessionName);
        if (!session?.id) throw new Error(`Failed to create session for iteration ${i}`);
        const sessionId = session.id;
        console.log(`  [T-14] Session created: ${sessionId}`);

        // Stop the session
        console.log(`  [T-14] Stopping session ${sessionId}...`);
        await stopSession(PORT, sessionId).catch(async () => {
          // Fallback: poll REST
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const sessions = await getSessionsRest();
            const s = sessions.find(x => x.id === sessionId);
            if (s && s.status !== 'running' && s.status !== 'starting') break;
            await sleep(500);
          }
        });

        // Verify stopped via REST
        const sessionsBefore = await getSessionsRest();
        const sessionRecord = sessionsBefore.find(s => s.id === sessionId);
        expect(sessionRecord, `Session ${sessionId} not found in REST before delete attempt`).toBeTruthy();
        expect(sessionRecord.status, `Session should be stopped, got: ${sessionRecord?.status}`)
          .not.toMatch(/running|starting/);
        console.log(`  [T-14] Session state: ${sessionRecord.status} ✓`);

        // Reload page to get fresh session list rendering
        if (i > 1) {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForFunction(
            () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
                  document.body.textContent.includes('Connected'),
            { timeout: 15000 }
          ).catch(() => {});
          await sleep(1500);
          await page.waitForSelector('text=T14-project', { timeout: 10000 });
          await page.click('text=T14-project');
          await sleep(1000);
        }

        // Capture baseline WS send log length before this click
        const wsSendLenBefore = wsSendLog.length;

        // Register dialog dismiss handler BEFORE clicking Delete
        let dialogFired = false;
        let dialogMessage = '';
        let dialogType = '';
        page.once('dialog', async dialog => {
          dialogFired = true;
          dialogMessage = dialog.message();
          dialogType = dialog.type();
          console.log(`  [T-14] Dialog fired: type="${dialogType}" msg="${dialogMessage}"`);
          await dialog.dismiss(); // Cancel
        });

        // Find and click the Delete button
        const deleteBtn = await waitForSessionCard(page, sessionName);
        console.log(`  [T-14] Clicking Delete button for "${sessionName}"...`);
        await deleteBtn.click();

        // Wait for any async effects
        await sleep(2000);

        // Take screenshot
        await page.screenshot({
          path: path.join(SCREENSHOTS_DIR, `T14-0${i}-cancel-iter${i}.png`),
          fullPage: true,
        });

        // ── Assertions ──────────────────────────────────────────────────────

        // 1. Dialog must have fired
        expect(dialogFired, `Iteration ${i}: Delete button did NOT show a confirmation dialog`).toBe(true);
        console.log(`  [T-14] ✓ Dialog appeared`);

        // 2. Dialog was of type "confirm"
        expect(dialogType, `Iteration ${i}: Expected confirm dialog, got "${dialogType}"`).toBe('confirm');
        console.log(`  [T-14] ✓ Dialog type is 'confirm'`);

        // 3. Dialog message contains session name
        expect(dialogMessage, `Iteration ${i}: Dialog message should contain session name`).toContain(sessionName);
        console.log(`  [T-14] ✓ Dialog message contains session name`);

        // 4. No session:delete WS message was sent
        const newWsMessages = wsSendLog.slice(wsSendLenBefore);
        const deleteMessages = newWsMessages.filter(m => m.type === 'session:delete');
        expect(deleteMessages.length, `Iteration ${i}: session:delete was sent after Cancel! Messages: ${JSON.stringify(deleteMessages)}`)
          .toBe(0);
        console.log(`  [T-14] ✓ No session:delete WS message sent`);

        // 5. Session card still visible in DOM
        const cardVisible = await page.locator(`.session-card:has-text("${sessionName}")`).isVisible();
        expect(cardVisible, `Iteration ${i}: Session card for "${sessionName}" disappeared after Cancel`).toBe(true);
        console.log(`  [T-14] ✓ Session card still visible in DOM`);

        // 6. Session still exists on server via REST
        const sessionsAfter = await getSessionsRest();
        const stillExists = sessionsAfter.find(s => s.id === sessionId);
        expect(stillExists, `Iteration ${i}: Session ${sessionId} is gone from REST after Cancel!`).toBeTruthy();
        console.log(`  [T-14] ✓ Session still exists on server (REST)`);

        // 7. Session card shows no broken/error state
        const cardHtml = await page.locator(`.session-card:has-text("${sessionName}")`).innerHTML();
        expect(cardHtml, `Iteration ${i}: Session card shows error state after Cancel`).not.toContain('badge-activity-error');
        console.log(`  [T-14] ✓ Session card shows no error state`);

        console.log(`  [T-14] ✓ Iteration ${i} PASSED`);
      }

      console.log('\n  [T-14] All 3 cancel iterations PASSED');

    } finally {
      await browser.close();
    }
  });

  test('T-14.B — Accept on delete dialog actually deletes the session', async () => {
    test.setTimeout(60000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
      const { page, wsSendLog } = await openAppAndNavigate(browser);

      const sessionName = 'T14-accept-delete';

      // Create a session
      console.log(`\n  [T-14.B] Creating session: ${sessionName}`);
      const session = await createSession(PORT, testProjectId, sessionName);
      if (!session?.id) throw new Error('Failed to create T14-accept-delete session');
      const sessionId = session.id;
      console.log(`  [T-14.B] Session created: ${sessionId}`);

      // Stop it
      console.log(`  [T-14.B] Stopping session...`);
      await stopSession(PORT, sessionId).catch(async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const sessions = await getSessionsRest();
          const s = sessions.find(x => x.id === sessionId);
          if (s && s.status !== 'running' && s.status !== 'starting') break;
          await sleep(500);
        }
      });

      // Verify stopped
      const sessionsBefore = await getSessionsRest();
      const rec = sessionsBefore.find(s => s.id === sessionId);
      expect(rec).toBeTruthy();
      expect(rec.status).not.toMatch(/running|starting/);
      console.log(`  [T-14.B] Session state: ${rec.status} ✓`);

      const wsSendLenBefore = wsSendLog.length;

      // Register dialog ACCEPT handler
      let dialogFired = false;
      page.once('dialog', async dialog => {
        dialogFired = true;
        console.log(`  [T-14.B] Dialog fired: dismissing with ACCEPT`);
        await dialog.accept(); // Confirm deletion
      });

      // Click Delete
      const deleteBtn = await waitForSessionCard(page, sessionName);
      console.log(`  [T-14.B] Clicking Delete (will accept)...`);
      await deleteBtn.click();

      // Wait for server to process deletion and broadcast sessions:list
      await sleep(3000);

      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'T14-accept-after-delete.png'),
        fullPage: true,
      });

      // 1. Dialog fired
      expect(dialogFired, 'Dialog did not appear for Accept path').toBe(true);
      console.log(`  [T-14.B] ✓ Dialog appeared`);

      // 2. session:delete WS message was sent
      const newWsMessages = wsSendLog.slice(wsSendLenBefore);
      const deleteMessages = newWsMessages.filter(m => m.type === 'session:delete');
      expect(deleteMessages.length, `Expected 1 session:delete message, got ${deleteMessages.length}`).toBe(1);
      expect(deleteMessages[0].id).toBe(sessionId);
      console.log(`  [T-14.B] ✓ session:delete WS message sent`);

      // 3. Session card gone from DOM
      const cardCount = await page.locator(`.session-card:has-text("${sessionName}")`).count();
      expect(cardCount, `Session card still visible after Accept+delete`).toBe(0);
      console.log(`  [T-14.B] ✓ Session card removed from DOM`);

      // 4. Session gone from REST
      const sessionsAfter = await getSessionsRest();
      const gone = sessionsAfter.find(s => s.id === sessionId);
      expect(gone, `Session ${sessionId} still exists in REST after delete!`).toBeFalsy();
      console.log(`  [T-14.B] ✓ Session removed from server (REST)`);

      console.log('\n  [T-14.B] Accept-delete path PASSED');

    } finally {
      await browser.close();
    }
  });

  test('T-14.C — Active session has no Delete button', async () => {
    test.setTimeout(60000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    try {
      const { page } = await openAppAndNavigate(browser);

      const sessionName = 'T14-active-no-delete';

      // Create a session (but do NOT stop it — leave it running)
      console.log(`\n  [T-14.C] Creating session: ${sessionName}`);
      const session = await createSession(PORT, testProjectId, sessionName);
      if (!session?.id) throw new Error('Failed to create T14-active-no-delete session');
      const sessionId = session.id;
      console.log(`  [T-14.C] Session created: ${sessionId} (should be running)`);

      // Wait for the session card to appear
      await page.waitForSelector(`.session-card:has-text("${sessionName}")`, { timeout: 10000 });
      await sleep(1000);

      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'T14-active-session-card.png'),
        fullPage: true,
      });

      // Assert Delete button is NOT present for the running session
      const deleteBtnCount = await page.locator(
        `.session-card:has-text("${sessionName}") button:has-text("Delete")`
      ).count();

      expect(deleteBtnCount, `Running session should NOT have a Delete button`).toBe(0);
      console.log(`  [T-14.C] ✓ Running session has no Delete button`);

      // Cleanup: stop the session
      try {
        await stopSession(PORT, sessionId);
      } catch {}

      console.log('\n  [T-14.C] Active-session guard PASSED');

    } finally {
      await browser.close();
    }
  });

});
} // end for (const MODE of MODES)
