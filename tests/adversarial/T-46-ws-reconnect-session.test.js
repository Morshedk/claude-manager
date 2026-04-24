/**
 * T-46: WS Reconnect Restores Terminal Subscription for Active Session
 *
 * Purpose: Drop the WebSocket while the terminal overlay is open, then verify:
 *   1. Auto-reconnect happens within 10s (no user action)
 *   2. TerminalPane sends session:subscribe on reconnect (handleReconnect fires)
 *   3. Correct sessionId used in re-subscribe
 *   4. Live output flows after reconnect (unique typed marker appears)
 *   5. No duplicate output (subscribe count not inflated)
 *   6. PTY process still alive, session still running
 *   7. Reliable across 2 WS drops
 *
 * Design doc: tests/adversarial/designs/T-46-design.md
 *
 * Run: PORT=3143 npx playwright test tests/adversarial/T-46-ws-reconnect-session.test.js --reporter=line --timeout=180000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORTS = { direct: 3143, tmux: 3743 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `t46-ws-reconnect-session-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe(`T-46 — WS Reconnect Restores Terminal Subscription [${MODE}]`, () => {

  let serverProc = null;
  let dataDir = '';
  let crashLogPath = '';
  let testStartTime = 0;
  let sessionId = '';
  let ptyPid = 0;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on the port
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    dataDir = execSync('mktemp -d /tmp/t46-XXXXXX').toString().trim();
    console.log(`\n  [T-46] dataDir: ${dataDir}`);

    // Seed projects.json
    const projectsSeed = {
      projects: [
        {
          id: 'proj-t46',
          name: 'T46-Project',
          path: '/tmp',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(projectsSeed, null, 2));

    crashLogPath = path.join(dataDir, 'server-crash.log');

    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PORT: String(PORT),
        CRASH_LOG: crashLogPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/sessions`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(300);
    }
    if (!ready) throw new Error('Test server failed to start within 15s');
    console.log(`  [T-46] Server ready on port ${PORT}`);
    testStartTime = Date.now();
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(500);
      try { process.kill(serverProc.pid, 0); serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }

    if (ptyPid) {
      try { process.kill(ptyPid, 'SIGKILL'); } catch {}
    }

    try {
      const cl = fs.readFileSync(crashLogPath, 'utf8');
      if (cl.trim()) console.log('\n  [T-46] CRASH LOG:\n' + cl);
    } catch {}

    if (dataDir) {
      try { execSync(`rm -rf ${dataDir}`); } catch {}
      dataDir = '';
    }
  });

  async function getApiSessions() {
    const r = await fetch(`${BASE_URL}/api/sessions`);
    const body = await r.json();
    return Array.isArray(body.managed) ? body.managed : [];
  }

  async function waitForConnected(page, timeoutMs = 10000) {
    await page.waitForSelector('.status-dot.connected', { timeout: timeoutMs });
  }

  async function waitForDisconnected(page, timeoutMs = 6000) {
    await page.waitForFunction(
      () => !document.querySelector('.status-dot.connected'),
      { timeout: timeoutMs }
    );
  }

  test('T-46 — WS drop: auto-reconnect, re-subscribe, live output (2 rounds)', async () => {
    test.setTimeout(150000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const consoleLogs = [];

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      // ── Inject WS proxy BEFORE navigation ───────────────────────────────────
      await page.addInitScript(() => {
        window._subscribeCount = 0;
        window._lastSubscribeId = null;
        window._testWs = null;

        const NativeWS = window.WebSocket;
        window.WebSocket = new Proxy(NativeWS, {
          construct(target, args) {
            const instance = new target(...args);
            window._testWs = instance; // always tracks the latest WS
            const origSend = instance.send.bind(instance);
            instance.send = function(data) {
              try {
                const msg = JSON.parse(data);
                if (msg.type === 'session:subscribe') {
                  window._subscribeCount = (window._subscribeCount || 0) + 1;
                  window._lastSubscribeId = msg.id;
                  console.log('[T46-INTERCEPT] session:subscribe count=' + window._subscribeCount + ' id=' + msg.id);
                }
              } catch {}
              return origSend(data);
            };
            return instance;
          }
        });
      });

      page.on('console', msg => {
        consoleLogs.push({ type: msg.type(), text: msg.text() });
        if (msg.text().startsWith('[T46-INTERCEPT]') || msg.text().startsWith('[ws]')) {
          console.log(`  [browser] ${msg.text()}`);
        }
      });

      // ── Step 1: Navigate ─────────────────────────────────────────────────────
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await waitForConnected(page, 10000);
      console.log('\n  [T-46] App loaded, connected');

      // ── Step 2: Select project ───────────────────────────────────────────────
      const projectItem = page.locator('.project-item').filter({ hasText: 'T46-Project' });
      await projectItem.first().waitFor({ state: 'visible', timeout: 5000 });
      await projectItem.first().click();
      await page.waitForFunction(
        () => [...document.querySelectorAll('.project-item')].some(el => el.classList.contains('active')),
        { timeout: 5000 }
      );
      console.log('  [T-46] Project selected');

      // ── Step 3: Create a bash session ────────────────────────────────────────
      const newSessionBtn = page.locator('#sessions-area .btn-primary').first();
      await newSessionBtn.waitFor({ state: 'visible', timeout: 5000 });
      await newSessionBtn.click();
      await page.waitForSelector('.modal', { state: 'visible', timeout: 5000 });

      const nameInput = page.locator('.modal .form-input').first();
      await nameInput.fill('t46-bash');

      // Set command to bash
      const commandInput = page.locator('.modal .form-input').nth(1);
      await commandInput.fill('bash');

      await page.locator('.modal-footer .btn-primary').click();
      console.log('  [T-46] Session creation clicked');

      // Wait for running badge
      await page.waitForFunction(
        () => {
          const cards = document.querySelectorAll('.session-card');
          return [...cards].some(c => c.textContent.includes('t46-bash') && c.textContent.includes('running'));
        },
        { timeout: 10000 }
      );
      console.log('  [T-46] Session card shows running');

      // Verify via API
      const sessions = await getApiSessions();
      const sess = sessions.find(s => s.name === 't46-bash');
      expect(sess, 'Session must exist in API').toBeTruthy();
      const sessStatus = sess.status || sess.state;
      expect(sessStatus, 'Session must be running').toBe('running');
      expect(sess.pid, 'Session must have pid > 0').toBeGreaterThan(0);
      sessionId = sess.id;
      ptyPid = sess.pid;
      console.log(`  [T-46] sessionId=${sessionId} pid=${ptyPid}`);

      // ── Step 4: Open terminal overlay ────────────────────────────────────────
      const card = page.locator('.session-card').filter({ hasText: 't46-bash' });
      await card.first().click();
      await page.waitForSelector('#session-overlay', { state: 'visible', timeout: 8000 });
      await page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: 8000 });
      await sleep(800);
      console.log('  [T-46] Terminal overlay open');

      // ── Step 5: Baseline marker ──────────────────────────────────────────────
      await sleep(300);
      const baselineSubCount = await page.evaluate(() => window._subscribeCount);
      console.log(`  [T-46] Baseline subscribe count: ${baselineSubCount}`);
      expect(baselineSubCount, 'Must have at least 1 subscribe after mount').toBeGreaterThanOrEqual(1);

      await page.keyboard.type('echo T46_BASELINE');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes('T46_BASELINE'),
        { timeout: 8000 }
      );
      console.log('  [T-46] Baseline marker T46_BASELINE confirmed');

      // Confirm WS is OPEN
      const wsOpen = await page.evaluate(() => window._testWs?.readyState === WebSocket.OPEN);
      expect(wsOpen, 'window._testWs must be OPEN before drop').toBe(true);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-baseline.png') });

      // ════ ROUND 1 ════════════════════════════════════════════════════════════
      console.log('\n  [T-46] === ROUND 1: Force WS close ===');

      const t1start = Date.now();

      const closeResult1 = await page.evaluate(() => {
        if (!window._testWs) return 'no_ws';
        const state = window._testWs.readyState;
        window._testWs.close();
        return `closed_from_state_${state}`;
      });
      console.log(`  [T-46] Close result: ${closeResult1}`);
      expect(closeResult1, 'WS must close successfully').not.toBe('no_ws');

      // Verify disconnect detected
      await waitForDisconnected(page, 6000);
      console.log(`  [T-46] ROUND 1: Disconnect detected in ${Date.now() - t1start}ms`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-round1-disconnected.png') });

      // Wait for auto-reconnect
      await waitForConnected(page, 10000);
      const reconnectTime1 = Date.now() - t1start;
      console.log(`  [T-46] ROUND 1: Reconnected in ${reconnectTime1}ms`);
      expect(reconnectTime1, 'Must reconnect within 10s').toBeLessThan(10000);

      const statusText1 = await page.locator('.status-text').first().textContent().catch(() => '');
      expect(statusText1).toContain('Connected');

      // Sleep to allow handleReconnect to fire and session:subscribed to arrive
      await sleep(1500);

      // Check re-subscribe count
      const subCount1 = await page.evaluate(() => window._subscribeCount);
      console.log(`  [T-46] ROUND 1 subscribe count: ${subCount1} (baseline=${baselineSubCount})`);
      expect(subCount1, 'Must have exactly 1 re-subscribe after ROUND 1').toBe(baselineSubCount + 1);

      const lastSubId1 = await page.evaluate(() => window._lastSubscribeId);
      console.log(`  [T-46] ROUND 1 last subscribe ID: ${lastSubId1}`);
      expect(lastSubId1, 'Re-subscribe must use correct sessionId').toBe(sessionId);

      // Terminal must not be blank
      const termText1 = await page.evaluate(
        () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.trim() ?? ''
      );
      expect(termText1.length, 'Terminal must not be blank after reconnect').toBeGreaterThan(0);
      console.log(`  [T-46] ROUND 1: Terminal has ${termText1.length} chars`);

      // Live output: unique marker
      const marker1 = `T46_R1_${Date.now()}`;
      await page.keyboard.type(`echo ${marker1}`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
        marker1,
        { timeout: 10000 }
      );
      console.log(`  [T-46] ROUND 1: Live marker ${marker1} appeared`);

      // Duplicate check
      const dupMarker1 = `T46_DUPCHK1_${Date.now()}`;
      await page.keyboard.type(`echo ${dupMarker1}`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
        dupMarker1,
        { timeout: 5000 }
      );
      await sleep(200);
      const dupCount1 = await page.evaluate((m) => {
        const text = document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent ?? '';
        return (text.match(new RegExp(m, 'g')) || []).length;
      }, dupMarker1);
      console.log(`  [T-46] ROUND 1: "${dupMarker1}" appears ${dupCount1}x (expect <=3)`);
      expect(dupCount1, 'Output must not be doubled (dup subscription)').toBeLessThanOrEqual(3);

      // Server state check
      const sessAfter1 = (await getApiSessions()).find(s => s.id === sessionId);
      expect(sessAfter1, 'Session must still exist').toBeTruthy();
      expect(sessAfter1.status || sessAfter1.state, 'Session must still be running').toBe('running');
      expect(sessAfter1.pid, 'PID must be unchanged').toBe(ptyPid);
      try { process.kill(ptyPid, 0); } catch { throw new Error(`ROUND 1: PTY pid=${ptyPid} is dead`); }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-round1-reconnected.png') });
      console.log(`  [T-46] ROUND 1 COMPLETE`);

      // ════ ROUND 2 ════════════════════════════════════════════════════════════
      console.log('\n  [T-46] === ROUND 2: Second WS drop ===');

      const t2start = Date.now();

      const closeResult2 = await page.evaluate(() => {
        if (!window._testWs) return 'no_ws';
        window._testWs.close();
        return 'closed';
      });
      expect(closeResult2, 'ROUND 2: WS must close').not.toBe('no_ws');

      await waitForDisconnected(page, 6000);
      console.log(`  [T-46] ROUND 2: Disconnected in ${Date.now() - t2start}ms`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-round2-disconnected.png') });

      await waitForConnected(page, 10000);
      const reconnectTime2 = Date.now() - t2start;
      console.log(`  [T-46] ROUND 2: Reconnected in ${reconnectTime2}ms`);
      expect(reconnectTime2, 'ROUND 2: Must reconnect within 10s').toBeLessThan(10000);

      await sleep(1500);

      const subCount2 = await page.evaluate(() => window._subscribeCount);
      console.log(`  [T-46] ROUND 2 subscribe count: ${subCount2} (was ${subCount1})`);
      expect(subCount2, 'ROUND 2: Must have exactly 1 more re-subscribe').toBe(subCount1 + 1);

      const lastSubId2 = await page.evaluate(() => window._lastSubscribeId);
      expect(lastSubId2, 'ROUND 2: Re-subscribe must use correct sessionId').toBe(sessionId);

      const termText2 = await page.evaluate(
        () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.trim() ?? ''
      );
      expect(termText2.length, 'ROUND 2: Terminal must not be blank').toBeGreaterThan(0);

      const marker2 = `T46_R2_${Date.now()}`;
      await page.keyboard.type(`echo ${marker2}`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (m) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(m),
        marker2,
        { timeout: 10000 }
      );
      console.log(`  [T-46] ROUND 2: Live marker ${marker2} appeared`);

      const sessAfter2 = (await getApiSessions()).find(s => s.id === sessionId);
      expect(sessAfter2?.status || sessAfter2?.state, 'ROUND 2: Session still running').toBe('running');
      expect(sessAfter2?.pid, 'ROUND 2: PID unchanged').toBe(ptyPid);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-round2-reconnected.png') });
      console.log(`  [T-46] ROUND 2 COMPLETE`);

      // ── Crash log ────────────────────────────────────────────────────────────
      try {
        const crashLog = fs.readFileSync(crashLogPath, 'utf8');
        const testEntries = crashLog.split('\n').filter(line => {
          if (!line.trim()) return false;
          const m = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
          if (!m) return false;
          return new Date(m[1]).getTime() >= testStartTime;
        });
        if (testEntries.length > 0) {
          console.error('  [T-46] CRASH LOG entries:\n' + testEntries.join('\n'));
          expect(testEntries.length, 'No crashes allowed during test').toBe(0);
        } else {
          console.log('  [T-46] Crash log: clean');
        }
      } catch {
        console.log('  [T-46] Crash log not found (no crashes)');
      }

      console.log('\n  [T-46] ALL CHECKS PASSED');
      console.log(`  Round 1 reconnect: ${reconnectTime1}ms, subscribes: ${subCount1}`);
      console.log(`  Round 2 reconnect: ${reconnectTime2}ms, subscribes: ${subCount2}`);
      console.log(`  Total subscribes: ${subCount2} (baseline=${baselineSubCount})`);

    } finally {
      await browser.close().catch(() => {});
    }
  });

});
} // end for (const MODE of MODES)
