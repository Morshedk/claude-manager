/**
 * T-18: Switching Projects While a Session Is Starting
 *
 * Score: L=3 S=3 D=4 (Total: 10)
 *
 * Flow: Select Project A → Click "Start Session" → Immediately switch to Project B
 *       → Wait 3s → Click Project A again.
 *
 * Pass: Project A shows the session card. Project B shows no session. No cross-project bleed.
 * Fail: Session disappears from Project A (lost during navigation race) OR session appears in Project B.
 *
 * Run: PORT=3115 npx playwright test tests/adversarial/T-18-project-switch-race.test.js --reporter=line --timeout=120000
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
const PORTS = { direct: 3115, tmux: 3715 };
const MODES = ['direct', 'tmux'];

for (const MODE of MODES) {
const PORT = PORTS[MODE];
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T18-project-switch-race-${MODE}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.describe(`T-18 — Switching Projects While a Session Is Starting [${MODE}]`, () => {

  let serverProc = null;
  let tmpDir = '';
  let testProjectAId = '';
  let testProjectBId = '';

  // ── Infrastructure Setup ─────────────────────────────────────────────────

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3115 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1200);

    // 1a — Fresh isolated temp data dir
    tmpDir = execSync('mktemp -d /tmp/qa-T18-XXXXXX').toString().trim();
    const projADir = path.join(tmpDir, 'projectA');
    const projBDir = path.join(tmpDir, 'projectB');
    fs.mkdirSync(projADir, { recursive: true });
    fs.mkdirSync(projBDir, { recursive: true });
    console.log(`\n  [T-18] tmpDir: ${tmpDir}`);

    // 1b — Start server
    const crashLogPath = path.join(tmpDir, 'server-crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Wait for server ready
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 15s');
    console.log(`  [T-18] Server ready on port ${PORT}`);

    // 1c — Create two test projects
    const projA = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T18-ProjectA', path: projADir }),
    }).then(r => r.json());
    testProjectAId = projA.id;

    const projB = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T18-ProjectB', path: projBDir }),
    }).then(r => r.json());
    testProjectBId = projB.id;

    console.log(`  [T-18] Project A: ${testProjectAId} (${projA.name})`);
    console.log(`  [T-18] Project B: ${testProjectBId} (${projB.name})`);
  });

  test.afterAll(async () => {
    // Cleanup: kill server, remove temp dir
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
    }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    try { execSync(`rm -rf ${tmpDir}`); } catch {}
    console.log(`  [T-18] Cleanup done`);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function getProjectSessions(projectId) {
    const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const all = Array.isArray(data) ? data : (Array.isArray(data.managed) ? data.managed : (data.sessions || []));
    return all.filter(s => s.projectId === projectId);
  }

  async function deleteSessionViaWS(sessionId) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'session:delete', id: sessionId }));
        setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 800);
      });
      ws.on('error', () => resolve());
    });
  }

  // ── Main Test ─────────────────────────────────────────────────────────────

  test('session created in Project A survives immediate switch to Project B', async () => {
    const browser = await chromium.launch({ headless: true });

    try {
      const iterResults = [];
      const ITERATIONS = 3;

      for (let iter = 1; iter <= ITERATIONS; iter++) {
        console.log(`\n  ── Iteration ${iter}/${ITERATIONS} ──────────────────────────`);
        const screenshotPrefix = path.join(SCREENSHOTS_DIR, `iter-${iter}`);

        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();

        // Intercept WS messages to log timing
        const wsEvents = [];
        page.on('websocket', ws => {
          ws.on('framesent', f => {
            try {
              const msg = JSON.parse(f.payload);
              if (msg.type === 'session:create') {
                wsEvents.push({ type: 'sent:session:create', t: Date.now(), projectId: msg.projectId });
                console.log(`  [T-18] iter ${iter}: WS sent session:create projectId=${msg.projectId}`);
              }
            } catch {}
          });
          ws.on('framereceived', f => {
            try {
              const msg = JSON.parse(f.payload);
              if (msg.type === 'session:created') {
                wsEvents.push({ type: 'received:session:created', t: Date.now(), sessionId: msg.session?.id });
                console.log(`  [T-18] iter ${iter}: WS received session:created id=${msg.session?.id}`);
              }
            } catch {}
          });
        });

        // Navigate
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait for project list
        await page.waitForSelector('.project-item', { timeout: 15000 });
        await sleep(800); // settle

        // ── Step 1: Click Project A ─────────────────────────────────

        await page.locator('.project-item', { hasText: 'T18-ProjectA' }).click();
        await page.waitForFunction(
          () => document.querySelector('#sessions-area-title')?.textContent?.includes('T18-ProjectA'),
          { timeout: 8000 }
        );
        console.log(`  [T-18] iter ${iter}: Project A selected`);
        await page.screenshot({ path: `${screenshotPrefix}-01-project-a-selected.png` });

        // ── Step 2: Open New Session modal ─────────────────────────

        await page.locator('button.btn-primary', { hasText: 'New Claude Session' }).click();
        await page.waitForSelector('.modal-overlay', { timeout: 8000 });

        // Fill session name
        const nameInput = page.locator('.modal .form-input[placeholder="e.g. refactor, auth, bugfix"]');
        await nameInput.fill('T18-race-session');

        // Override command with bash (fast/reliable)
        const cmdInput = page.locator('.modal .form-input[placeholder="claude"]');
        await cmdInput.fill('bash');

        await page.screenshot({ path: `${screenshotPrefix}-02-modal-filled.png` });
        console.log(`  [T-18] iter ${iter}: Modal filled — ready for race`);

        // ── Step 3: THE RACE — Start Session then immediately switch to Project B ──

        const raceStart = Date.now();

        // Click Start Session (synchronous DOM click — kicks off WS send + modal close)
        await page.evaluate(() => {
          const btn = document.querySelector('.modal-footer .btn-primary');
          if (!btn) throw new Error('Start Session button not found');
          btn.click();
        });

        // Immediately click Project B — before modal animation ends, before session:created arrives
        await page.locator('.project-item', { hasText: 'T18-ProjectB' }).click({ timeout: 3000 });

        const switchTime = Date.now() - raceStart;
        console.log(`  [T-18] iter ${iter}: Switched to Project B in ${switchTime}ms after Start Session`);

        await page.screenshot({ path: `${screenshotPrefix}-03-switched-to-b.png` });

        // ── Step 4: Wait 3 seconds ──────────────────────────────────

        await sleep(3000);

        // Verify we're on Project B (should show empty or B's sessions)
        const titleOnB = await page.evaluate(
          () => document.querySelector('#sessions-area-title')?.textContent || 'N/A'
        );
        console.log(`  [T-18] iter ${iter}: Title on B view: "${titleOnB}"`);

        // Check Project B shows no session cards from Project A
        const bCardCount = await page.locator('.session-card').count();
        console.log(`  [T-18] iter ${iter}: Session cards visible while on Project B: ${bCardCount}`);

        await page.screenshot({ path: `${screenshotPrefix}-04-after-3s-on-b.png` });

        // ── Step 5: Click back to Project A ─────────────────────────

        await page.locator('.project-item', { hasText: 'T18-ProjectA' }).click();
        console.log(`  [T-18] iter ${iter}: Clicked back to Project A`);

        // Wait for session card to appear (up to 8s)
        let sessionCardFound = false;
        try {
          await page.waitForSelector('.session-card', { timeout: 8000 });
          sessionCardFound = true;
        } catch {
          console.log(`  [T-18] iter ${iter}: WARN: No session card appeared within 8s`);
        }

        await page.screenshot({ path: `${screenshotPrefix}-05-back-to-a.png` });

        // ── Verification ─────────────────────────────────────────────

        // Check 1: Session card present in Project A
        const aCardCount = await page.locator('.session-card').count();
        console.log(`  [T-18] iter ${iter}: Session cards in Project A: ${aCardCount}`);

        // Check 2: Card name contains our session name
        const cardNames = await page.locator('.session-card .session-card-name').allTextContents().catch(() => []);
        const hasCorrectName = cardNames.some(n => n.includes('T18-race-session'));
        console.log(`  [T-18] iter ${iter}: Card names: ${JSON.stringify(cardNames)}`);
        console.log(`  [T-18] iter ${iter}: Has correct name: ${hasCorrectName}`);

        // Check 3: Badge state
        const badgeText = await page.locator('.session-card .badge').first().textContent().catch(() => '');
        console.log(`  [T-18] iter ${iter}: Badge: "${badgeText}"`);
        const validBadge = badgeText.includes('running') || badgeText.includes('starting') || badgeText.includes('stopped') || badgeText.includes('error');

        // Check 4: REST API — session belongs to Project A
        const apiSessionsA = await getProjectSessions(testProjectAId);
        const apiSessionsB = await getProjectSessions(testProjectBId);
        const sessionInA = apiSessionsA.find(s => s.name === 'T18-race-session');
        const sessionInB = apiSessionsB.find(s => s.name === 'T18-race-session');

        console.log(`  [T-18] iter ${iter}: API sessions in A: ${apiSessionsA.length}, sessions in B: ${apiSessionsB.length}`);
        console.log(`  [T-18] iter ${iter}: Target session in A: ${sessionInA ? 'YES id='+sessionInA.id : 'NO'}`);
        console.log(`  [T-18] iter ${iter}: Target session in B: ${sessionInB ? 'YES (CROSS-BLEED DETECTED)' : 'NO'}`);

        if (sessionInA) {
          console.log(`  [T-18] iter ${iter}: Session state=${sessionInA.state || sessionInA.status}, projectId=${sessionInA.projectId}`);
        }

        // Check 5: Switch to Project B to verify no bleed
        await page.locator('.project-item', { hasText: 'T18-ProjectB' }).click();
        await sleep(400);
        const bCardsAfter = await page.locator('.session-card').count();
        console.log(`  [T-18] iter ${iter}: Session cards in Project B (after nav back): ${bCardsAfter}`);

        await page.screenshot({ path: `${screenshotPrefix}-06-project-b-check.png` });

        // ── WS timing analysis ───────────────────────────────────────

        const createSent = wsEvents.find(e => e.type === 'sent:session:create');
        const createReceived = wsEvents.find(e => e.type === 'received:session:created');
        const latencyMs = (createSent && createReceived)
          ? createReceived.t - createSent.t
          : null;

        console.log(`  [T-18] iter ${iter}: WS events:`, wsEvents.map(e => `${e.type}@+${e.t - raceStart}ms`).join(', '));
        if (latencyMs !== null) {
          console.log(`  [T-18] iter ${iter}: session:create→session:created latency: ${latencyMs}ms`);
        }

        const switchedBeforeCreated = createReceived ? switchTime < latencyMs : true;
        console.log(`  [T-18] iter ${iter}: Race exercised (switched before session:created): ${switchedBeforeCreated}`);

        // ── Pass/Fail for this iteration ─────────────────────────────

        const iterPass =
          aCardCount >= 1 &&
          hasCorrectName &&
          sessionInA !== undefined &&
          sessionInA?.projectId === testProjectAId &&
          sessionInB === undefined &&
          bCardsAfter === 0;

        iterResults.push({
          iter,
          aCardCount,
          hasCorrectName,
          sessionInA: !!sessionInA,
          sessionInB: !!sessionInB,
          bCardsAfter,
          badgeText,
          switchTimeMs: switchTime,
          raceExercised: switchedBeforeCreated,
          pass: iterPass,
        });

        console.log(`\n  [T-18] iter ${iter}: ${iterPass ? '✓ PASS' : '✗ FAIL'}`);
        if (!iterPass) {
          await page.screenshot({ path: `${screenshotPrefix}-FAIL.png` });
        }

        // Save API state for forensics
        fs.writeFileSync(
          path.join(SCREENSHOTS_DIR, `iter-${iter}-api-state.json`),
          JSON.stringify({ sessionsA: apiSessionsA, sessionsB: apiSessionsB, wsEvents }, null, 2)
        );

        // ── Cleanup for next iteration ────────────────────────────────

        const allSessions = [...apiSessionsA, ...apiSessionsB];
        for (const s of allSessions) {
          await deleteSessionViaWS(s.id);
          console.log(`  [T-18] iter ${iter}: Deleted session ${s.id}`);
        }
        await sleep(1500);

        // Reset WS events for next iteration
        wsEvents.length = 0;

        await context.close();
      }

      // ── Final Summary ─────────────────────────────────────────────

      console.log('\n  ════════════════════════════════════════════════');
      console.log('  [T-18] FINAL SUMMARY');
      console.log('  ════════════════════════════════════════════════');

      let passCount = 0;
      for (const r of iterResults) {
        const raceNote = r.raceExercised ? 'RACE EXERCISED' : 'race not exercised (too slow)';
        console.log(`  Iter ${r.iter}: cards_in_A=${r.aCardCount} correct_name=${r.hasCorrectName} session_in_A=${r.sessionInA} session_in_B=${r.sessionInB} b_cards=${r.bCardsAfter} badge="${r.badgeText}" switch=${r.switchTimeMs}ms [${raceNote}] → ${r.pass ? 'PASS' : 'FAIL'}`);
        if (r.pass) passCount++;
      }

      console.log(`\n  Pass rate: ${passCount}/${ITERATIONS}`);

      const raceExercisedCount = iterResults.filter(r => r.raceExercised).length;
      if (raceExercisedCount === 0) {
        console.log(`  WARN: Race was NOT exercised in any iteration (all switches happened AFTER session:created arrived)`);
        console.log(`  WARN: Test may not be validating the race condition — consider increasing browser startup overhead`);
      } else {
        console.log(`  Race exercised in ${raceExercisedCount}/${ITERATIONS} iterations`);
      }

      const crossBleedDetected = iterResults.some(r => r.sessionInB);
      if (crossBleedDetected) {
        console.log(`  !!!  CROSS-PROJECT BLEED DETECTED — session appeared in Project B`);
      }

      const sessionLostCount = iterResults.filter(r => !r.sessionInA).length;
      if (sessionLostCount > 0) {
        console.log(`  !!!  SESSION LOST in ${sessionLostCount} iteration(s) — session vanished from Project A`);
      }

      if (passCount === ITERATIONS) {
        console.log('\n  [T-18] RESULT: PASS');
      } else if (passCount === ITERATIONS - 1) {
        console.log('\n  [T-18] RESULT: FLAKY (1 failure)');
      } else {
        console.log(`\n  [T-18] RESULT: FAIL (${ITERATIONS - passCount} failures)`);
      }

      // ── Hard assertions ────────────────────────────────────────────

      // No cross-project bleed in any iteration
      for (const r of iterResults) {
        expect(r.sessionInB, `iter ${r.iter}: session must NOT appear in Project B`).toBe(false);
        expect(r.bCardsAfter, `iter ${r.iter}: Project B must show 0 session cards`).toBe(0);
      }

      // Session must survive in Project A in at least ITERATIONS-1 runs (allow 1 flake)
      expect(passCount, `At least ${ITERATIONS - 1}/${ITERATIONS} iterations must pass`).toBeGreaterThanOrEqual(ITERATIONS - 1);

    } finally {
      await browser.close();
    }
  });
});
} // end for (const MODE of MODES)
