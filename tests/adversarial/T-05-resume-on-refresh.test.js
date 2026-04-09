/**
 * T-05: Refresh direct session preserves conversation — uses --resume
 *
 * Source story: Story 8
 * Score: L=4 S=5 D=4 (Total: 13)
 *
 * Flow:
 *   1. Create a direct Claude session (haiku model)
 *   2. Establish sentinel protocol: send setup → verify ACK_N
 *   3. Send NEXT → verify ACK_(N+1)  [confirms protocol working]
 *   4. Stop session (conversation file flushes to disk)
 *   5. Click the Refresh button in the browser UI
 *   6. Wait for RUNNING
 *   7. Send NEXT → expect ACK_(N+2) — proves --resume loaded prior conversation
 *
 * 3 iterations with escalating ACK numbers:
 *   Iter 1: ACK_1, ACK_2 → refresh → ACK_3
 *   Iter 2: ACK_10, ACK_11 → refresh → ACK_12
 *   Iter 3: ACK_20, ACK_21 → refresh → ACK_22
 *
 * Port: 3102
 *
 * Run: PORT=3102 npx playwright test tests/adversarial/T-05-resume-on-refresh.test.js --reporter=line --timeout=300000
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
const PORT = 3102;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T05-resume-on-refresh');
const PROJECT_PATH = '/tmp/qa-T05-project';
const PROJECT_ID = 'proj-t05';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function ts() {
  return `+${((Date.now() - (ts._t0 || (ts._t0 = Date.now()))) / 1000).toFixed(1)}s`;
}

test.describe('T-05 — Refresh preserves conversation (--resume)', () => {
  let serverProc = null;
  let tmpDir = '';
  let browser = null;

  test.beforeAll(async () => {
    ts._t0 = Date.now();
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    fs.mkdirSync(PROJECT_PATH, { recursive: true });

    // Kill anything on port 3102 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    // Poll until port is actually free (up to 10s) instead of fixed sleep
    {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${PORT}/`);
          // If fetch succeeded, port is still occupied — wait and retry
          await sleep(500);
        } catch (e) {
          // ECONNREFUSED means port is free
          if (e.cause?.code === 'ECONNREFUSED' || e.message?.includes('ECONNREFUSED') || e.code === 'ECONNREFUSED') break;
          // Other errors (e.g. ECONNRESET) — port still in transition
          await sleep(500);
        }
      }
    }

    // Create isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-T05-XXXXXX').toString().trim();
    console.log(`\n  [setup] tmpDir: ${tmpDir}`);

    // Seed projects.json BEFORE starting server
    const projectsJson = {
      projects: [{
        id: PROJECT_ID,
        name: 'T05-Project',
        path: PROJECT_PATH,
        createdAt: '2026-01-01T00:00:00Z',
      }],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(projectsJson, null, 2));

    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready (up to 25s)
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');
    console.log(`  [setup] ${ts()} Server ready on port ${PORT}`);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  test.afterAll(async () => {
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch {} serverProc = null; }
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      if (crashLog.trim()) console.log('\n  [CRASH LOG]\n' + crashLog);
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
    try { execSync(`rm -rf ${PROJECT_PATH}`); } catch {}
  });

  // ── WS helpers ──────────────────────────────────────────────────────────────

  function wsConnect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
      setTimeout(() => reject(new Error('WS connect timeout')), 8000);
    });
  }

  function waitForMsg(ws, predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', handler);
        reject(new Error(`waitForMsg timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      function handler(raw) {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (predicate(msg)) { clearTimeout(timer); ws.off('message', handler); resolve(msg); }
      }
      ws.on('message', handler);
    });
  }

  function buildCollector(ws, sessionId) {
    let buffer = '';
    const listeners = [];

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'session:output' && msg.id === sessionId) {
        buffer += (typeof msg.data === 'string' ? msg.data : '');
        for (const fn of listeners) fn(buffer);
      }
      if (msg.type === 'session:subscribed' && msg.id === sessionId) {
        console.log(`  [ws] session:subscribed received (xterm reset signal)`);
      }
    });
    ws.on('error', err => console.warn(`  [ws] error: ${err.message}`));
    ws.on('close', (code) => console.log(`  [ws] closed: code=${code}`));

    return {
      ws,
      getBuffer: () => buffer,
      clearBuffer: () => { buffer = ''; },
      waitForAck(n, timeoutMs = 45000) {
        const target = `ACK_${n}`;
        return new Promise((resolve, reject) => {
          if (buffer.includes(target)) { resolve(buffer); return; }
          const timer = setTimeout(() => {
            const idx = listeners.indexOf(check);
            if (idx !== -1) listeners.splice(idx, 1);
            reject(new Error(
              `Timeout waiting for ${target} after ${timeoutMs}ms. ` +
              `Buffer tail: ${buffer.slice(-300).replace(/[^\x20-\x7e\n]/g, '?')}`
            ));
          }, timeoutMs);
          function check(buf) {
            if (buf.includes(target)) {
              clearTimeout(timer);
              const idx = listeners.indexOf(check);
              if (idx !== -1) listeners.splice(idx, 1);
              resolve(buf);
            }
          }
          listeners.push(check);
        });
      },
      send(type, extra = {}) {
        ws.send(JSON.stringify({ type, id: sessionId, ...extra }));
      },
      close() { try { ws.close(); } catch {} },
    };
  }

  async function attachAndCollect(ws, sessionId) {
    return buildCollector(ws, sessionId);
  }

  async function subscribeAndCollect(sessionId) {
    const ws = await wsConnect();
    await sleep(200);
    ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId, cols: 120, rows: 30 }));
    await waitForMsg(ws, m => m.type === 'session:subscribed' && m.id === sessionId, 10000);
    return buildCollector(ws, sessionId);
  }

  async function getSessionStatus(sessionId) {
    const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const all = Array.isArray(data.managed) ? data.managed : (Array.isArray(data) ? data : []);
    return all.find(s => s.id === sessionId);
  }

  async function waitForStatus(sessionId, targetStatus, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await getSessionStatus(sessionId);
      const status = s?.status || s?.state;
      if (status === targetStatus) return s;
      await sleep(300);
    }
    const s = await getSessionStatus(sessionId);
    throw new Error(`Session ${sessionId} never reached "${targetStatus}" — last: ${s?.status || s?.state}`);
  }

  function getConversationFilePath(claudeSessionId) {
    const encodedPath = PROJECT_PATH.replace(/\//g, '-');
    return path.join(
      process.env.HOME || '/home/claude-runner',
      '.claude', 'projects', encodedPath, claudeSessionId + '.jsonl'
    );
  }

  async function waitForTuiReady(collector, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = collector.getBuffer();
      if (raw.includes('bypass') || raw.length > 2000) break;
      await sleep(300);
    }
    console.log(`  [tui] TUI ready signal received (buffer length: ${collector.getBuffer().length})`);
  }

  // ── Main test ───────────────────────────────────────────────────────────────

  test('T-05 — Refresh preserves conversation via --resume (3 iterations)', async () => {
    test.setTimeout(300000); // 5 minutes

    // Iteration config: [startAck, midAck, expectedAfterRefresh]
    const iterations = [
      { start: 1, mid: 2, expected: 3, label: 'Iter-1 (ACK_1→2, expect ACK_3)' },
      { start: 10, mid: 11, expected: 12, label: 'Iter-2 (ACK_10→11, expect ACK_12)' },
      { start: 20, mid: 21, expected: 22, label: 'Iter-3 (ACK_20→21, expect ACK_22)' },
    ];

    const iterResults = [];

    for (let i = 0; i < iterations.length; i++) {
      const iter = iterations[i];
      const label = iter.label;
      console.log(`\n  ════════════════════════════════════════`);
      console.log(`  [T-05] ${ts()} ${label} — START`);
      console.log(`  ════════════════════════════════════════`);

      let wsCreate = null;
      let collector = null;
      let testSessionId = null;
      let claudeSessionId = null;
      let iterResult = { label, pass: false, notes: [] };

      try {
        // ── Step 1: Create session ─────────────────────────────────────────────
        console.log(`  [${label}] Step 1: Creating Claude session...`);
        wsCreate = await wsConnect();
        await sleep(300);

        wsCreate.send(JSON.stringify({
          type: 'session:create',
          projectId: PROJECT_ID,
          name: `T05-haiku-iter${i + 1}`,
          command: 'claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions --strict-mcp-config',
          mode: 'direct',
          cols: 120,
          rows: 30,
        }));

        let created;
        try {
          created = await waitForMsg(wsCreate,
            m => m.type === 'session:created' || m.type === 'session:error', 15000);
        } catch (err) {
          throw new Error(`session:create timed out: ${err.message}`);
        }

        if (created.type === 'session:error') {
          throw new Error(`session:create returned error: ${created.error}`);
        }

        testSessionId = created.session?.id || created.id;
        claudeSessionId = created.session?.claudeSessionId || created.claudeSessionId;
        if (!testSessionId) throw new Error(`No session ID in: ${JSON.stringify(created)}`);

        console.log(`  [${label}] Session created: ${testSessionId}`);
        console.log(`  [${label}] Claude session ID: ${claudeSessionId}`);
        iterResult.notes.push(`sessionId=${testSessionId}`);
        iterResult.notes.push(`claudeSessionId=${claudeSessionId}`);

        // Attach collector to auto-subscribed WS
        collector = await attachAndCollect(wsCreate, testSessionId);

        // ── Step 2: Wait for RUNNING ───────────────────────────────────────────
        console.log(`  [${label}] Step 2: Waiting for RUNNING...`);
        await waitForStatus(testSessionId, 'running', 30000);
        console.log(`  [${label}] ${ts()} Session RUNNING`);

        // ── Step 3: Wait for TUI ready ─────────────────────────────────────────
        console.log(`  [${label}] Step 3: Waiting for Claude TUI ready...`);
        await waitForTuiReady(collector, 30000);

        // ── Step 4: Send sentinel setup, wait for first ACK ───────────────────
        console.log(`  [${label}] Step 4: Sending sentinel setup, waiting for ACK_${iter.start}...`);
        collector.clearBuffer();
        // IMPORTANT: Do NOT include "ACK_N" literals in the prompt text — PTY echoes input
        const startN = iter.start;
        collector.send('session:input', {
          data: `For this conversation reply to each message with ONLY the text ACK_N where N increments from ${startN}. Nothing else. Begin now.\r`,
        });

        await collector.waitForAck(iter.start, 45000);
        console.log(`  [${label}] ${ts()} ACK_${iter.start} received`);

        // ── Step 5: Send NEXT, wait for second ACK ────────────────────────────
        console.log(`  [${label}] Step 5: Waiting for TUI to return to prompt, then sending NEXT...`);
        await sleep(3000); // wait for Claude TUI to finish rendering response
        collector.clearBuffer();
        collector.send('session:input', { data: 'NEXT\r' });

        await collector.waitForAck(iter.mid, 30000);
        console.log(`  [${label}] ${ts()} ACK_${iter.mid} received`);
        iterResult.notes.push(`pre-refresh: ACK_${iter.start} and ACK_${iter.mid} received`);

        // ── Step 6: Check conversation file exists ────────────────────────────
        // Must stop the session first so Claude flushes conversation to disk
        console.log(`  [${label}] Step 6: Stopping session to flush conversation file...`);
        collector.send('session:stop', {});
        try {
          await waitForStatus(testSessionId, 'stopped', 15000);
        } catch (err) {
          console.warn(`  [${label}] WARN: Session didn't reach stopped — continuing anyway: ${err.message}`);
        }

        await sleep(2000); // Let Claude flush conversation file to disk

        let convFilePath = null;
        let convFileExists = false;
        if (claudeSessionId) {
          convFilePath = getConversationFilePath(claudeSessionId);
          convFileExists = fs.existsSync(convFilePath);
          console.log(`  [${label}] Conversation file: ${convFilePath}`);
          console.log(`  [${label}] Conversation file exists: ${convFileExists}`);
          iterResult.notes.push(`convFile=${convFilePath}`);
          iterResult.notes.push(`convFileExists=${convFileExists}`);
        } else {
          // Fallback: check directory
          const encodedPath = PROJECT_PATH.replace(/\//g, '-');
          const dir = path.join(process.env.HOME || '/home/claude-runner', '.claude', 'projects', encodedPath);
          console.log(`  [${label}] No claudeSessionId. Checking dir: ${dir}`);
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
            console.log(`  [${label}] Found .jsonl files: ${files.join(', ')}`);
            convFileExists = files.length > 0;
          }
          iterResult.notes.push(`claudeSessionId=null — fallback dir check, convFileExists=${convFileExists}`);
        }

        if (!convFileExists) {
          iterResult.notes.push('WARNING: conversation file not found — --resume cannot fire; marking INCONCLUSIVE');
          console.warn(`  [${label}] WARN: Conversation file not found — --resume will not be triggered`);
        }

        // ── Step 7: Open browser and click Refresh ────────────────────────────
        console.log(`  [${label}] Step 7: Opening browser to click Refresh...`);
        const page = await browser.newPage();
        page.on('console', msg => {
          if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
        });

        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(
          () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
                document.body.textContent.includes('Connected'),
          { timeout: 30000 }
        );
        await sleep(1500); // let Preact re-render project/session list

        // Take screenshot of app loaded state
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-01-app-loaded.png`) });

        // Select the T05-Project in sidebar — click on the project-item-name span
        const projectItem = page.locator('.project-item-name', { hasText: 'T05-Project' }).first();
        await projectItem.waitFor({ state: 'visible', timeout: 10000 });
        await projectItem.click({ timeout: 10000 });
        await sleep(1200); // let sessions list render

        // Take screenshot after project selected
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-01b-project-selected.png`) });

        // The session card has a "Refresh" button directly when session is stopped.
        // Strategy: find the session card by name, then find the Refresh button within it.
        // Fallback: find any visible Refresh button on the page.
        let refreshClicked = false;

        // Wait for at least one session card to appear
        await page.locator('.session-card').first().waitFor({ state: 'visible', timeout: 10000 });

        // Log all session card names for debugging
        const cardNames = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.session-card-name')).map(e => e.textContent?.trim())
        );
        console.log(`  [${label}] Session cards found: ${JSON.stringify(cardNames)}`);

        // Try clicking Refresh in the specific session card first
        const expectedName = `T05-haiku-iter${i + 1}`;
        const cardRefreshBtn = page.locator(`.session-card:has-text("${expectedName}") button:has-text("Refresh")`).first();
        let cardRefreshVisible = await cardRefreshBtn.isVisible({ timeout: 3000 }).catch(() => false);

        if (!cardRefreshVisible) {
          // Fallback: try any session card's Refresh button
          console.log(`  [${label}] Specific card Refresh not found; trying any card Refresh`);
          const anyCardRefresh = page.locator('.session-card button:has-text("Refresh")').first();
          cardRefreshVisible = await anyCardRefresh.isVisible({ timeout: 3000 }).catch(() => false);
          if (cardRefreshVisible) {
            await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-02-before-refresh.png`) });
            await anyCardRefresh.click();
            refreshClicked = true;
            console.log(`  [${label}] ${ts()} Refresh clicked (any card fallback)`);
          }
        } else {
          await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-02-before-refresh.png`) });
          await cardRefreshBtn.click();
          refreshClicked = true;
          console.log(`  [${label}] ${ts()} Refresh clicked on session card`);
        }

        // Fallback: open the session overlay and find Refresh there
        if (!refreshClicked) {
          console.log(`  [${label}] Card Refresh not found — trying session overlay approach`);
          const sessionCard = page.locator(`.session-card:has-text("${expectedName}")`).first();
          const cardFallback = page.locator('.session-card').first();
          const targetCard = await sessionCard.isVisible({ timeout: 2000 }).catch(() => false)
            ? sessionCard : cardFallback;
          await targetCard.click();
          await page.waitForSelector('#session-overlay', { timeout: 10000 });
          await sleep(500);
          await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-02-before-refresh.png`) });

          const overlayRefreshSelectors = [
            '#session-overlay button:has-text("Refresh")',
            '.session-toolbar button:has-text("Refresh")',
            'button:has-text("Refresh")',
          ];
          for (const sel of overlayRefreshSelectors) {
            const btn = page.locator(sel).first();
            const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
            if (visible) {
              console.log(`  [${label}] Found Refresh in overlay: ${sel}`);
              await btn.click();
              refreshClicked = true;
              console.log(`  [${label}] ${ts()} Refresh clicked via overlay`);
              break;
            }
          }
        }

        if (!refreshClicked) {
          const buttons = await page.evaluate(() =>
            Array.from(document.querySelectorAll('button')).map(b => ({
              text: b.textContent?.trim(),
              title: b.title,
              className: b.className,
            }))
          );
          console.log(`  [${label}] All buttons: ${JSON.stringify(buttons.slice(0, 30))}`);
          throw new Error('Could not find Refresh button in any expected location');
        }

        // ── Step 8: Wait for session to return to RUNNING ─────────────────────
        console.log(`  [${label}] Step 8: Waiting for session RUNNING after refresh...`);
        await waitForStatus(testSessionId, 'running', 30000);
        console.log(`  [${label}] ${ts()} Session RUNNING after refresh`);
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-03-after-refresh-running.png`) });

        await page.close();

        // ── Step 9: Subscribe fresh WS and wait for TUI ───────────────────────
        console.log(`  [${label}] Step 9: Fresh WS subscribe, waiting for TUI ready...`);
        collector.close();
        collector = await subscribeAndCollect(testSessionId);
        await waitForTuiReady(collector, 30000);

        // ── Step 10: Send NEXT, expect ACK_(N+2) — the continuity assertion ───
        console.log(`  [${label}] Step 10: Sending NEXT, expecting ACK_${iter.expected} (continuity proof)...`);
        collector.clearBuffer();
        collector.send('session:input', { data: 'NEXT\r' });

        try {
          await collector.waitForAck(iter.expected, 45000);
          console.log(`  [${label}] ${ts()} ACK_${iter.expected} received — CONVERSATION CONTINUITY CONFIRMED`);
          iterResult.pass = true;
          iterResult.notes.push(`post-refresh: ACK_${iter.expected} received`);
          iterResult.notes.push('PASS: conversation memory preserved via --resume');

          // Take success screenshot
          const successPage = await browser.newPage();
          await successPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(800);
          await successPage.screenshot({ path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-04-ACK${iter.expected}-received.png`) });
          await successPage.close();
        } catch (err) {
          // Check what Claude actually responded with
          const bufSnap = collector.getBuffer().slice(-500).replace(/[^\x20-\x7e\n]/g, '?');
          console.error(`  [${label}] FAIL: ACK_${iter.expected} not received`);
          console.error(`  [${label}] Buffer tail: ${bufSnap}`);
          iterResult.notes.push(`FAIL: ACK_${iter.expected} not received after refresh`);
          iterResult.notes.push(`Buffer tail: ${bufSnap}`);

          // Check if Claude is responding with ACK_1 (fresh start without memory)
          if (collector.getBuffer().includes('ACK_1') && iter.expected !== 1) {
            iterResult.notes.push('DIAGNOSIS: Claude responded with ACK_1 — fresh start (no --resume or file missing)');
          }

          // Fail screenshot
          const failPage = await browser.newPage();
          await failPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await sleep(500);
          await failPage.screenshot({ path: path.join(SCREENSHOTS_DIR, `iter-${i+1}-FAIL.png`) }).catch(() => {});
          await failPage.close();
        }

      } catch (err) {
        console.error(`  [${label}] ERROR: ${err.message}`);
        iterResult.notes.push(`ERROR: ${err.message}`);
      } finally {
        // Cleanup: delete session and close WS
        if (collector) { try { collector.close(); } catch {} }
        if (!collector && wsCreate) { try { wsCreate.close(); } catch {} }
        if (testSessionId) {
          try {
            const delWs = await wsConnect();
            await sleep(200);
            delWs.send(JSON.stringify({ type: 'session:delete', id: testSessionId }));
            await sleep(1000);
            delWs.close();
          } catch {}
        }
        // Clean up conversation file for next iteration
        if (claudeSessionId) {
          const fp = getConversationFilePath(claudeSessionId);
          try { fs.unlinkSync(fp); } catch {}
        }
        await sleep(2000);
      }

      iterResults.push(iterResult);
      console.log(`  [T-05] ${label} — ${iterResult.pass ? 'PASS' : 'FAIL'}`);
      console.log(`  Notes: ${iterResult.notes.join(' | ')}`);
    }

    // ── Final scoring ──────────────────────────────────────────────────────────
    console.log('\n  ════════════════════════════════════════');
    console.log('  [T-05] FINAL RESULTS');
    console.log('  ════════════════════════════════════════');
    const passCount = iterResults.filter(r => r.pass).length;
    for (const r of iterResults) {
      console.log(`  ${r.label}: ${r.pass ? 'PASS' : 'FAIL'}`);
    }
    console.log(`  Score: ${passCount}/${iterations.length}`);

    // Assert at least 3/3 pass
    expect(
      passCount,
      `Only ${passCount}/${iterations.length} iterations passed. ` +
      `Details: ${iterResults.map(r => r.label + ':' + (r.pass ? 'PASS' : 'FAIL')).join(', ')}`
    ).toBe(iterations.length);
  });
});
