/**
 * T-39: Corrupted sessions.json — Server Recovers Without Crash
 *
 * Purpose: Write invalid JSON to sessions.json before starting the server.
 * Verify the server starts, the app loads with an empty session list,
 * and server logs indicate the corruption was detected.
 *
 * Based on source analysis, SessionStore.load() silently returns [] on parse error
 * without logging. This test will detect that gap.
 *
 * Run: PORT=3136 npx playwright test tests/adversarial/T-39-corrupted-sessions.test.js --reporter=line --timeout=60000
 */

import { test, expect } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3136;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T39-corrupted-sessions');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CORRUPT_CONTENT = '{broken json{{';

test.describe('T-39 — Corrupted sessions.json Recovery', () => {
  let serverProc = null;
  let tmpDir = '';
  let serverOutput = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    tmpDir = execSync('mktemp -d /tmp/qa-T39-XXXXXX').toString().trim();
    console.log(`\n  [T-39] tmpDir: ${tmpDir}`);

    const projPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projPath, { recursive: true });

    // Write valid projects.json
    const projectsSeed = {
      projects: [{
        id: 'proj-t39',
        name: 'T39-Project',
        path: projPath,
        createdAt: '2026-01-01T00:00:00Z',
      }],
      scratchpad: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify(projectsSeed, null, 2));

    // Write CORRUPT sessions.json — invalid JSON
    const sessionsPath = path.join(tmpDir, 'sessions.json');
    fs.writeFileSync(sessionsPath, CORRUPT_CONTENT, 'utf8');

    // Verify corruption is in place
    const readBack = fs.readFileSync(sessionsPath, 'utf8');
    if (readBack !== CORRUPT_CONTENT) {
      throw new Error('Failed to write corrupt sessions.json');
    }
    console.log(`  [T-39] Corrupted sessions.json written: "${readBack}"`);

    // Start server and collect output
    const crashLogPath = path.join(tmpDir, 'crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const outputLines = [];
    serverProc.stdout.on('data', d => {
      const s = d.toString();
      outputLines.push(s);
      serverOutput += s;
      process.stdout.write(`  [srv] ${s}`);
    });
    serverProc.stderr.on('data', d => {
      const s = d.toString();
      outputLines.push(s);
      serverOutput += s;
      process.stdout.write(`  [srv:ERR] ${s}`);
    });

    // Wait for HTTP readiness (or crash)
    const deadline = Date.now() + 15000;
    let ready = false;
    let crashed = false;

    serverProc.on('exit', (code) => {
      if (code !== null) {
        crashed = true;
        console.log(`  [T-39] Server exited with code: ${code}`);
      }
    });

    while (Date.now() < deadline) {
      if (crashed) break;
      try {
        const r = await fetch(`${BASE_URL}/`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }

    console.log(`  [T-39] Server ready: ${ready}, crashed: ${crashed}`);
  });

  test.afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
      serverProc = null;
    }
    try {
      const crashLog = fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf8');
      if (crashLog.trim()) console.log('\n  [CRASH LOG]\n' + crashLog);
    } catch {}
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Server starts and serves empty session list after corrupted sessions.json', async () => {
    // ── CHECK 1: Server started without crashing ───────────────────────────────
    let serverStarted = false;
    try {
      const r = await fetch(`${BASE_URL}/`);
      serverStarted = r.ok;
    } catch {}

    console.log(`\n  === T-39 RESULTS ===`);
    console.log(`  Server started: ${serverStarted}`);

    expect(serverStarted).toBe(true);
    console.log(`  CHECK 1 PASS: Server started without crashing`);

    // ── CHECK 2: REST API returns empty session list ────────────────────────────
    const sessionsResp = await fetch(`${BASE_URL}/api/sessions`);
    expect(sessionsResp.ok).toBe(true);
    const sessionsData = await sessionsResp.json();
    console.log(`  Sessions API response type: ${typeof sessionsData}, isArray: ${Array.isArray(sessionsData)}`);

    // Handle both [] and { sessions: [] } response shapes
    let sessionList = [];
    if (Array.isArray(sessionsData)) {
      sessionList = sessionsData;
    } else if (sessionsData && Array.isArray(sessionsData.managed)) {
      sessionList = sessionsData.managed;
    } else if (sessionsData && Array.isArray(sessionsData.sessions)) {
      sessionList = sessionsData.sessions;
    }

    console.log(`  Sessions in list: ${sessionList.length}`);
    expect(sessionList.length).toBe(0);
    console.log(`  CHECK 2 PASS: API returns empty session list`);

    // ── CHECK 3: Browser loads with empty session list ──────────────────────────
    const { chromium } = await import('playwright/test');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Click on project to see sessions
    const projectVisible = await page.evaluate(() =>
      document.querySelectorAll('.project-item').length > 0
    );
    console.log(`  Project visible in sidebar: ${projectVisible}`);

    if (projectVisible) {
      await page.click('.project-item');
      await sleep(500);
    }

    const sessionCards = await page.evaluate(() =>
      document.querySelectorAll('.session-card').length
    );
    console.log(`  Session cards in browser: ${sessionCards}`);
    expect(sessionCards).toBe(0);
    console.log(`  CHECK 3 PASS: Browser shows no session cards`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'after-corrupt-sessions.png'), fullPage: true });
    await browser.close();

    // ── CHECK 4: Server logged the corruption ───────────────────────────────────
    // Search server output for any corruption-related logging
    const outputLower = serverOutput.toLowerCase();
    const corruptionKeywords = ['corrupt', 'invalid', 'parse', 'error', 'json', 'sessions'];
    const matchedKeywords = corruptionKeywords.filter(kw => outputLower.includes(kw));

    // Also check crash log
    let crashLogContent = '';
    try { crashLogContent = fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf8'); } catch {}
    const crashLogLower = crashLogContent.toLowerCase();
    const crashLogMatches = corruptionKeywords.filter(kw => crashLogLower.includes(kw));

    const corruptionLogged = matchedKeywords.length > 0 || crashLogMatches.length > 0;

    console.log(`  Server output length: ${serverOutput.length} chars`);
    console.log(`  Keywords matched in output: ${matchedKeywords.join(', ') || '(none)'}`);
    console.log(`  Keywords matched in crash log: ${crashLogMatches.join(', ') || '(none)'}`);
    console.log(`  Corruption logged: ${corruptionLogged}`);

    // Based on SessionStore.load() source analysis, corruption is handled silently (no logging).
    // This assertion documents the actual behavior.
    if (!corruptionLogged) {
      console.log(`  CHECK 4 FINDING: Corruption NOT logged (SessionStore.load() is silent on parse errors)`);
      console.log(`  This is a REAL BUG per the test spec: "Server logs indicate corruption was detected and handled"`);
    } else {
      console.log(`  CHECK 4 PASS: Corruption was logged`);
    }

    // Assert corruption IS logged (spec requirement — this may fail revealing the bug)
    expect(corruptionLogged).toBe(true);

    console.log(`\n  T-39: ALL CHECKS COMPLETE`);
  });
});
