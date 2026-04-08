/**
 * T-03: Session Refresh Clears Terminal Buffer -- No Dot Artifacts
 *
 * Purpose: Verify that session:refresh triggers xterm.reset() correctly, clears
 * old scrollback, and does NOT produce dot/garbled artifacts in the terminal.
 *
 * Regression target: commit b2c1945 — \x1bc written to PTY mid-startup caused
 * stray dot characters in terminal after restart.
 *
 * Run: npx playwright test tests/adversarial/T-03-refresh-artifacts.test.js --reporter=line --timeout=120000
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
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T03-refresh-dots');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Server lifecycle ──────────────────────────────────────────────────────────

test.describe('T-03 — Session Refresh Clears Terminal Buffer (No Dot Artifacts)', () => {
  let serverProc = null;
  let tmpDir = '';
  let testProjectId = '';
  let testSessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on port 3100 first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(800);

    // Fresh isolated temp data directory
    tmpDir = execSync('mktemp -d /tmp/qa-T03-XXXXXX').toString().trim();
    console.log(`\n  [T-03] tmpDir: ${tmpDir}`);

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
      try { const r = await fetch(`${BASE_URL}/`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Test server failed to start within 25s');

    // Create test project via REST API
    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T03-refresh', path: projPath }),
    }).then(r => r.json());

    testProjectId = proj.id;
    if (!testProjectId) throw new Error(`Failed to create test project: ${JSON.stringify(proj)}`);
    console.log(`  [T-03] Project created: ${testProjectId}`);
    console.log(`  [T-03] Server ready on port ${PORT}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    // Print crash log if server died unexpectedly
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
      if (crashLog.trim()) {
        console.log('\n  [CRASH LOG]\n' + crashLog);
      }
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} tmpDir = ''; }
    // Safety net port cleanup
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  // ── WS helpers ────────────────────────────────────────────────────────────

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
        const chunk = typeof msg.data === 'string' ? msg.data : '';
        buffer += chunk;
        for (const fn of listeners) fn(buffer);
      }
    });

    ws.on('error', err => console.warn(`  [ws] error: ${err.message}`));

    return {
      ws,
      getBuffer: () => buffer,
      clearBuffer: () => { buffer = ''; },
      waitForContent(target, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
          if (buffer.includes(target)) { resolve(buffer); return; }
          const timer = setTimeout(() => {
            const idx = listeners.indexOf(check);
            if (idx !== -1) listeners.splice(idx, 1);
            reject(new Error(
              `Timeout waiting for "${target}" after ${timeoutMs}ms. ` +
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

  async function getSessionStatus(sessionId) {
    const data = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const all = Array.isArray(data.managed) ? data.managed : (Array.isArray(data) ? data : []);
    return all.find(s => s.id === sessionId);
  }

  async function waitForRunning(sessionId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await getSessionStatus(sessionId);
      const status = s?.status || s?.state;
      if (status === 'running') return s;
      await sleep(300);
    }
    const s = await getSessionStatus(sessionId);
    throw new Error(`Session ${sessionId} never reached running — last: ${s?.status || s?.state}`);
  }

  // ── DOM Artifact Detection Helpers ────────────────────────────────────────

  async function scanForArtifacts(page, label) {
    // Primary method (7a): blank rows below last content row
    const blankRowArtifacts = await page.evaluate(() => {
      const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
      let lastContentRow = -1;
      for (let i = 0; i < rows.length; i++) {
        const text = rows[i].textContent.replace(/[\u00A0\s]/g, '').trim();
        if (text.length > 0) lastContentRow = i;
      }

      const artifacts = [];
      const safeStart = Math.min(lastContentRow + 2, rows.length);
      for (let i = safeStart; i < rows.length; i++) {
        const text = rows[i].textContent.replace(/[\u00A0\s]/g, '');
        if (text.length > 0) {
          artifacts.push({ row: i, content: text, raw: rows[i].textContent });
        }
      }
      return { artifacts, lastContentRow };
    });

    // Secondary method (7b): suspicious patterns in all rows
    const suspiciousPatterns = await page.evaluate(() => {
      const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
      const suspicious = [];
      for (let i = 0; i < rows.length; i++) {
        const text = rows[i].textContent;
        if (/\?1;\d+c/.test(text)) suspicious.push({ row: i, type: 'DA-response', text });
        if (/^\s*\.\s*$/.test(text.replace(/\u00A0/g, ' '))) suspicious.push({ row: i, type: 'isolated-dot', text });
        if (/\[[\?]?\d+[;\d]*[a-zA-Z]/.test(text)) suspicious.push({ row: i, type: 'visible-escape', text });
      }
      return suspicious;
    });

    // False-pass risk mitigation (section 11): styled spans in blank rows
    const styledBlankRowArtifacts = await page.evaluate(() => {
      const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
      let lastContentRow = -1;
      for (let i = 0; i < rows.length; i++) {
        const text = rows[i].textContent.replace(/[\u00A0\s]/g, '').trim();
        if (text.length > 0) lastContentRow = i;
      }

      const flagged = [];
      const safeStart = Math.min(lastContentRow + 2, rows.length);
      for (let i = safeStart; i < rows.length; i++) {
        const spans = rows[i].querySelectorAll('span');
        for (const span of spans) {
          const style = span.getAttribute('style') || '';
          const text = span.textContent.replace(/[\u00A0\s]/g, '');
          if (text.length > 0) {
            flagged.push({ row: i, type: 'span-text-in-blank-row', text, style });
          }
        }
      }
      return flagged;
    });

    console.log(`\n  [T-03] Artifact scan at ${label}:`);
    console.log(`    lastContentRow: ${blankRowArtifacts.lastContentRow}`);
    console.log(`    blankRowArtifacts: ${JSON.stringify(blankRowArtifacts.artifacts)}`);
    console.log(`    suspiciousPatterns: ${JSON.stringify(suspiciousPatterns)}`);
    console.log(`    styledBlankRowArtifacts: ${JSON.stringify(styledBlankRowArtifacts)}`);

    return {
      blankRowArtifacts: blankRowArtifacts.artifacts,
      suspiciousPatterns,
      styledBlankRowArtifacts,
      lastContentRow: blankRowArtifacts.lastContentRow,
    };
  }

  async function dumpTerminalRows(page, label) {
    const rows = await page.evaluate(() => {
      const rowEls = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
      return Array.from(rowEls).map((r, i) => `[${String(i).padStart(2, '0')}] ${r.textContent}`);
    });
    console.log(`\n  [T-03] Terminal rows at ${label}:`);
    for (const r of rows) {
      if (r.replace(/\s/g, '').length > 3) console.log(`    ${r}`);
    }
    return rows;
  }

  async function getScrollState(page) {
    return await page.evaluate(() => {
      const vp = document.querySelector('#session-overlay-terminal .xterm-viewport');
      return vp?._scrollState?.() || null;
    });
  }

  // ── Full Verification Cycle ───────────────────────────────────────────────

  async function runVerificationCycle(page, wsCollector, label, oldContentMarker) {
    // Wait for DOM to not contain old content (with timeout)
    if (oldContentMarker) {
      try {
        await page.waitForFunction((marker) => {
          const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
          for (const r of rows) {
            if (r.textContent.includes(marker)) return false;
          }
          return true;
        }, oldContentMarker, { timeout: 5000 });
        console.log(`  [T-03] Old content marker "${oldContentMarker}" cleared from DOM`);
      } catch {
        console.warn(`  [T-03] WARN: old content marker "${oldContentMarker}" still present after 5s`);
      }
    }

    // t=0 checks
    const t0Screenshot = path.join(SCREENSHOTS_DIR, `${label}-t0.png`);
    await page.screenshot({ path: t0Screenshot, fullPage: true });
    const t0State = await getScrollState(page);
    const t0Artifacts = await scanForArtifacts(page, `${label} t=0`);
    await dumpTerminalRows(page, `${label} t=0`);
    console.log(`  [T-03] ${label} t=0 scrollState: ${JSON.stringify(t0State)}`);

    // t=2s checks
    await sleep(2000);
    const t2Screenshot = path.join(SCREENSHOTS_DIR, `${label}-t2.png`);
    await page.screenshot({ path: t2Screenshot, fullPage: true });
    const t2Artifacts = await scanForArtifacts(page, `${label} t=2`);
    await dumpTerminalRows(page, `${label} t=2`);

    // t=4s checks
    await sleep(2000);
    const t4Screenshot = path.join(SCREENSHOTS_DIR, `${label}-t4.png`);
    await page.screenshot({ path: t4Screenshot, fullPage: true });
    const t4Artifacts = await scanForArtifacts(page, `${label} t=4`);
    const t4Rows = await dumpTerminalRows(page, `${label} t=4`);

    // Check: blank region screenshots
    for (const [suffix, artResult] of [['t0', t0Artifacts], ['t2', t2Artifacts], ['t4', t4Artifacts]]) {
      try {
        const clipData = await page.evaluate(() => {
          const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
          let lastContentRow = -1;
          for (let i = 0; i < rows.length; i++) {
            const text = rows[i].textContent.replace(/[\u00A0\s]/g, '').trim();
            if (text.length > 0) lastContentRow = i;
          }
          const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
          if (!screen) return null;
          const screenRect = screen.getBoundingClientRect();
          const blankStartIdx = Math.min(lastContentRow + 2, rows.length - 1);
          const blankStartRow = rows[blankStartIdx];
          const blankStartY = blankStartRow ? blankStartRow.getBoundingClientRect().top : screenRect.bottom;
          const height = screenRect.bottom - blankStartY;
          if (height <= 0) return null;
          return { x: screenRect.left, y: blankStartY, width: screenRect.width, height };
        });
        if (clipData && clipData.height > 0) {
          await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, `${label}-blank-region-${suffix}.png`),
            clip: clipData,
          });
        }
      } catch (e) {
        console.warn(`  [T-03] Could not capture blank region screenshot at ${suffix}: ${e.message}`);
      }
    }

    // Verify old content absent
    if (oldContentMarker) {
      const hasOldContent = await page.evaluate((marker) => {
        const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
        for (const r of rows) {
          if (r.textContent.includes(marker)) return true;
        }
        return false;
      }, oldContentMarker);

      expect(hasOldContent, `Old content "${oldContentMarker}" must not appear after refresh`).toBe(false);
    }

    // Verify blank rows clean at all timestamps
    expect(t0Artifacts.blankRowArtifacts, `[${label} t=0] Blank rows must have no artifacts`).toHaveLength(0);
    expect(t2Artifacts.blankRowArtifacts, `[${label} t=2] Blank rows must have no artifacts`).toHaveLength(0);
    expect(t4Artifacts.blankRowArtifacts, `[${label} t=4] Blank rows must have no artifacts`).toHaveLength(0);

    // Verify no suspicious patterns
    expect(t0Artifacts.suspiciousPatterns, `[${label} t=0] No suspicious patterns`).toHaveLength(0);
    expect(t2Artifacts.suspiciousPatterns, `[${label} t=2] No suspicious patterns`).toHaveLength(0);
    expect(t4Artifacts.suspiciousPatterns, `[${label} t=4] No suspicious patterns`).toHaveLength(0);

    // Verify buffer reset (scrollMax should be 0 at t=0 if reset happened correctly)
    if (t0State) {
      expect(t0State.scrollMax, `[${label} t=0] scrollMax should be 0 after reset`).toBe(0);
    }

    // Verify prompt visible at t=4
    const promptVisible = t4Rows.some(r => /[\$#]/.test(r));
    expect(promptVisible, `[${label} t=4] Bash prompt must be visible`).toBe(true);

    console.log(`  [T-03] PASS — ${label} artifact checks all clear`);

    return { t0State, t0Artifacts, t2Artifacts, t4Artifacts };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // THE MAIN TEST
  // ─────────────────────────────────────────────────────────────────────────────

  test('T-03 — Refresh clears buffer, no dot artifacts (2 rounds)', async () => {
    test.setTimeout(120000);

    // ── Step 1: Create bash session via WS ──────────────────────────────────
    console.log('\n  [T-03.01] Creating bash session via WS...');
    const wsCreate = await wsConnect();
    await sleep(300);

    // Wait for init message
    await waitForMsg(wsCreate, m => m.type === 'init', 8000).catch(() => {
      console.log('  [T-03] No init message received (may be OK)');
    });

    wsCreate.send(JSON.stringify({
      type: 'session:create',
      projectId: testProjectId,
      name: 'T03-bash',
      command: 'bash',
      mode: 'direct',
      cols: 120,
      rows: 30,
    }));

    const created = await waitForMsg(wsCreate,
      m => m.type === 'session:created' || m.type === 'session:error', 15000);

    if (created.type === 'session:error') {
      throw new Error(`T-03.01 FAILED — session:create error: ${created.error}`);
    }

    testSessionId = created.session.id;
    console.log(`  [T-03.01] PASS — session created: ${testSessionId}`);

    // Attach output collector (server auto-subscribed the creating client)
    const wsCollector = buildCollector(wsCreate, testSessionId);

    // Wait for session to be running
    await waitForRunning(testSessionId, 10000);
    console.log('  [T-03.01] PASS — session is running');

    // ── Step 2: Open browser FIRST, then produce lines ──────────────────────
    // CRITICAL: browser must subscribe before lines are written so xterm.reset()
    // (triggered by session:subscribed on subscribe) happens to an empty terminal,
    // not to a terminal full of scrollback. If we wrote lines first then opened the
    // browser, xterm.reset() would clear the scrollback immediately on subscribe.
    console.log('\n  [T-03.02] Opening browser (before producing lines)...');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    let page;
    try {
      page = await browser.newPage();
      page.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
      });

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for "Connected" indicator
      await page.waitForFunction(
        () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
              document.body.textContent.includes('Connected'),
        { timeout: 30000 }
      );
      await sleep(1000);
      console.log('  [T-03.02] PASS — browser loaded, "Connected" visible');

      // ── Step 3: Click session card to open overlay ────────────────────────
      console.log('\n  [T-03.03] Clicking session card...');

      let sessionCardClicked = false;

      // First try to find any session card containing "T03-bash"
      const sessionCard = page.locator('[data-session-id], .session-card, button, [class*="session"]').filter({ hasText: 'T03-bash' }).first();
      const cardVisible = await sessionCard.isVisible().catch(() => false);

      if (cardVisible) {
        await sessionCard.click();
        sessionCardClicked = true;
        console.log('  [T-03.03] Clicked session card by text');
      } else {
        // Try clicking on a project card first to expand it
        const projectCard = page.locator('[class*="project"], .project-card, button').filter({ hasText: 'T03-refresh' }).first();
        const projVisible = await projectCard.isVisible().catch(() => false);
        if (projVisible) {
          await projectCard.click();
          await sleep(800);
        }

        const sessionCard2 = page.locator('*').filter({ hasText: 'T03-bash' }).last();
        const card2Visible = await sessionCard2.isVisible().catch(() => false);
        if (card2Visible) {
          await sessionCard2.click();
          sessionCardClicked = true;
          console.log('  [T-03.03] Clicked session card after project expand');
        }
      }

      if (!sessionCardClicked) {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T03-00-diagnose.png'), fullPage: true });
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
        throw new Error(`T-03.03 FAILED — Could not find session card. Body: ${bodyText}`);
      }

      // Wait for session overlay and terminal to appear
      try {
        await page.waitForSelector('#session-overlay .terminal-container .xterm-screen', { timeout: 15000 });
        console.log('  [T-03.03] PASS — terminal visible in overlay');
      } catch (e) {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T03-00-no-terminal.png'), fullPage: true });
        throw new Error(`T-03.03 FAILED — Terminal did not appear: ${e.message}`);
      }

      // Give xterm time to subscribe and settle (session:subscribed fires here — empty terminal)
      await sleep(1500);

      // ── Step 4: Now produce 50 lines into the live terminal ───────────────
      console.log('\n  [T-03.04] Producing 50 test lines into live terminal...');
      wsCreate.send(JSON.stringify({
        type: 'session:input',
        id: testSessionId,
        data: 'for i in $(seq 1 50); do echo "T03-LINE-$i ################################"; done\n',
      }));

      // Wait for T03-LINE-50 to appear in the DOM (not just WS buffer)
      await page.waitForFunction(
        () => {
          const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
          for (const r of rows) {
            if (r.textContent.includes('T03-LINE-50')) return true;
          }
          return false;
        },
        { timeout: 25000 }
      );
      console.log('  [T-03.04] PASS — T03-LINE-50 visible in browser DOM');

      // Wait for xterm to settle and render scrollback
      await sleep(1000);

      // ── Step 5: Pre-refresh state capture ────────────────────────────────
      console.log('\n  [T-03.05] Pre-refresh state capture...');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T03-01-pre-refresh.png'), fullPage: true });

      const preRefreshState = await getScrollState(page);
      console.log(`  [T-03.05] Pre-refresh scrollState: ${JSON.stringify(preRefreshState)}`);

      // Content verification — terminal must show T03-LINE- content (design section 3d hard gate)
      const { hasContent, lastContentRow } = await page.evaluate(() => {
        const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
        let lastRow = -1;
        for (let i = 0; i < rows.length; i++) {
          const text = rows[i].textContent.replace(/\u00A0/g, ' ').trim();
          if (text.length > 0) lastRow = i;
        }
        return { hasContent: lastRow >= 5, lastContentRow: lastRow };
      });

      if (!hasContent) {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'T03-00-content-missing.png'), fullPage: true });
        throw new Error(`T-03.05 ABORT — Terminal does not have expected content rows (lastContentRow=${lastContentRow} < 5). scrollState=${JSON.stringify(preRefreshState)}. Design section 3d: abort when pre-refresh content is not visible.`);
      }
      console.log(`  [T-03.05] PASS — Terminal has content (lastContentRow=${lastContentRow})`);

      // Assert scrollback actually exists (50 lines should exceed viewport)
      if (preRefreshState.scrollMax <= 0) {
        console.warn(`  [T-03.05] WARN — scrollMax=${preRefreshState.scrollMax} (expected > 0 with 50 lines). bufferLength=${preRefreshState.bufferLength}`);
      } else {
        console.log(`  [T-03.05] PASS — scrollback exists: scrollMax=${preRefreshState.scrollMax}`);
      }

      const hasT03Lines = await page.evaluate(() => {
        const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
        for (const r of rows) {
          if (r.textContent.includes('T03-LINE-')) return true;
        }
        return false;
      });
      console.log(`  [T-03.05] T03-LINE- content in terminal: ${hasT03Lines}`);

      // ── Step 6: First Refresh ─────────────────────────────────────────────
      console.log('\n  [T-03.06] Clicking Refresh button (Round 1)...');

      const refreshBtn = page.locator('button[title="Refresh session"]');
      const refreshBtnVisible = await refreshBtn.isVisible().catch(() => false);

      if (!refreshBtnVisible) {
        // Try alternative selector
        const altRefreshBtn = page.locator('.overlay-actions button', { hasText: 'Refresh' });
        const altVisible = await altRefreshBtn.isVisible().catch(() => false);
        if (!altVisible) {
          throw new Error('T-03.06 FAILED — Refresh button not found');
        }
        await altRefreshBtn.click();
      } else {
        await refreshBtn.click();
      }

      console.log('  [T-03.06] Refresh button clicked');

      // Wait for toast notification
      try {
        await page.waitForFunction(
          () => document.body.textContent.includes('Refreshing'),
          { timeout: 3000 }
        );
        console.log('  [T-03.06] Toast "Refreshing" appeared');
      } catch {
        console.log('  [T-03.06] No toast detected (may have disappeared quickly)');
      }

      // Wait for server to process refresh and broadcast session:subscribed
      await sleep(2000);

      // ── Step 7: Round 1 verification ─────────────────────────────────────
      console.log('\n  [T-03.07] Running Round 1 artifact checks...');
      await runVerificationCycle(page, wsCollector, 'T03-round1', 'T03-LINE-');

      // Verify session returns to running
      await waitForRunning(testSessionId, 15000);
      console.log('  [T-03.07] PASS — session is running after refresh');

      // ── Step 8: Produce content for Round 2 ──────────────────────────────
      console.log('\n  [T-03.08] Producing Round 2 content (T03-ROUND2-)...');

      // Wait for bash prompt to be ready
      await sleep(1000);

      wsCreate.send(JSON.stringify({
        type: 'session:input',
        id: testSessionId,
        data: 'for i in $(seq 1 5); do echo "T03-ROUND2-$i"; done\n',
      }));

      // Wait 2s for output to render
      await sleep(2000);

      const r2Screenshot = path.join(SCREENSHOTS_DIR, 'T03-07-round2-pre-refresh.png');
      await page.screenshot({ path: r2Screenshot, fullPage: true });
      console.log('  [T-03.08] Round 2 content sent');

      // ── Step 9: Second Refresh ────────────────────────────────────────────
      console.log('\n  [T-03.09] Clicking Refresh button (Round 2)...');

      const refreshBtn2 = page.locator('button[title="Refresh session"]');
      const r2BtnVisible = await refreshBtn2.isVisible().catch(() => false);

      if (!r2BtnVisible) {
        const altRefreshBtn2 = page.locator('.overlay-actions button', { hasText: 'Refresh' });
        await altRefreshBtn2.click();
      } else {
        await refreshBtn2.click();
      }

      console.log('  [T-03.09] Second Refresh clicked');

      // Wait for refresh to complete
      await sleep(2000);

      // ── Step 10: Round 2 verification ────────────────────────────────────
      console.log('\n  [T-03.10] Running Round 2 artifact checks...');
      await runVerificationCycle(page, wsCollector, 'T03-round2', 'T03-ROUND2-');

      // Verify session is running
      await waitForRunning(testSessionId, 15000);
      console.log('  [T-03.10] PASS — session is running after 2nd refresh');

      console.log('\n  ✓ T-03 ALL CHECKS PASSED');

    } finally {
      // ── Cleanup ──────────────────────────────────────────────────────────
      // Delete session via WS
      try {
        wsCreate.send(JSON.stringify({ type: 'session:delete', id: testSessionId }));
        await sleep(1000);
      } catch {}
      wsCreate.close ? wsCreate.close() : null;

      if (page) await browser.close().catch(() => {});
      else await browser.close().catch(() => {});
    }
  });
});
