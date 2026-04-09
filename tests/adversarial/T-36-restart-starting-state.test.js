/**
 * T-36: Server Restart While Session Is In "Starting" State
 *
 * Score: 12 | Type: Server-level | Port: 3133
 *
 * Flow:
 *   1. Start server, seed a project.
 *   2. Create a session (bash) and let it reach RUNNING.
 *   3. SIGKILL the server.
 *   4. Manually edit sessions.json to set status='starting' (simulates crash during startup).
 *   5. Restart server with same DATA_DIR.
 *   6. Verify: server starts without crash, session NOT stuck in 'starting'.
 *   7. Verify: server is fully responsive after restart.
 *
 * Run:
 *   fuser -k 3133/tcp 2>/dev/null; sleep 1
 *   npx jest tests/adversarial/T-36-restart-starting-state.test.js --testTimeout=90000 --forceExit
 */

import { test, expect, describe, beforeAll, afterAll } from '@jest/globals';
import WebSocket from 'ws';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3133;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForMsg(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS msg timeout after ${timeoutMs}ms`)), timeoutMs);
    function handler(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg); }
      } catch {}
    }
    ws.on('message', handler);
  });
}

async function startServer(tmpDir, crashLogPath) {
  const proc = spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  proc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));
  return proc;
}

async function waitForServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/`);
      if (r.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

describe('T-36 — Server Restart With Starting Session State', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let sessionId = '';
  let crashLogPath = '';
  let sessionsFile = '';

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-T36-XXXXXX').toString().trim();
    crashLogPath = path.join(tmpDir, 'crash.log');
    sessionsFile = path.join(tmpDir, 'sessions.json');
    console.log(`\n  [T-36] tmpDir: ${tmpDir}`);

    serverProc = await startServer(tmpDir, crashLogPath);
    const ready = await waitForServer();
    if (!ready) throw new Error('Server failed to start');
    console.log('  [T-36] Server ready (first instance)');

    // Seed a project
    const pr = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T36-Project', path: '/tmp' }),
    });
    if (!pr.ok) throw new Error(`Failed to create project: ${pr.status}`);
    const proj = await pr.json();
    projectId = proj.id;
    console.log(`  [T-36] projectId: ${projectId}`);
  }, 40000);

  afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch {}
      await sleep(300);
    }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  test('session stuck in starting is recovered after server restart', async () => {
    // ── Step 1: Create a session and wait for it to reach RUNNING ───────────
    console.log('  [T-36] Creating session and waiting for RUNNING...');

    const ws1 = await openWs();
    await waitForMsg(ws1, m => m.type === 'init', 5000);

    ws1.send(JSON.stringify({
      type: 'session:create',
      projectId,
      name: 'starting-test',
      command: 'bash',
      mode: 'direct',
      cols: 80,
      rows: 24,
    }));

    const created = await waitForMsg(ws1, m => m.type === 'session:created', 10000);
    sessionId = created.session.id;
    console.log(`  [T-36] Session created: id=${sessionId}`);

    // Wait for session to reach RUNNING (via state change or timeout)
    let sessionState = created.session.status || created.session.state;
    if (sessionState !== 'running') {
      try {
        const stateMsg = await waitForMsg(
          ws1,
          m => m.type === 'session:state' && m.id === sessionId && m.state === 'running',
          8000
        );
        sessionState = stateMsg.state;
      } catch {
        // May already be running — check via API
      }
    }

    // Confirm via API
    await sleep(1000);
    const sessionsRes = await fetch(`${BASE_URL}/api/sessions`);
    const sessionsData = await sessionsRes.json();
    const allSessions = sessionsData.managed || sessionsData || [];
    const ourSession = allSessions.find(s => s.id === sessionId);
    console.log(`  [T-36] Session state before kill: ${ourSession?.status || ourSession?.state || 'not found'}`);

    ws1.close();
    await sleep(200);

    // ── Step 2: SIGKILL the server ──────────────────────────────────────────
    console.log('  [T-36] Sending SIGKILL to server...');
    serverProc.kill('SIGKILL');
    serverProc = null;
    await sleep(800);

    // Verify server is down
    let serverDown = false;
    try { await fetch(`${BASE_URL}/`); } catch { serverDown = true; }
    expect(serverDown).toBe(true);
    console.log('  [T-36] Server confirmed down');

    // ── Step 3: Read crash log entries before corruption ────────────────────
    const preRestartCrashLog = fs.existsSync(crashLogPath)
      ? fs.readFileSync(crashLogPath, 'utf8').trim()
      : '';
    console.log(`  [T-36] Crash log before corruption: "${preRestartCrashLog}"`);

    // ── Step 4: Edit sessions.json to set status='starting' ─────────────────
    if (!fs.existsSync(sessionsFile)) {
      throw new Error(`PRECONDITION FAILED: sessions.json not found at ${sessionsFile}. Server may not have persisted sessions.`);
    }

    const rawSessions = fs.readFileSync(sessionsFile, 'utf8');
    const sessions = JSON.parse(rawSessions);
    const targetSession = sessions.find(s => s.id === sessionId);

    if (!targetSession) {
      throw new Error(`PRECONDITION FAILED: Session ${sessionId} not found in sessions.json. File contents: ${rawSessions}`);
    }

    const originalStatus = targetSession.status;
    targetSession.status = 'starting';
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');

    // Verify the edit took effect
    const verifyRaw = fs.readFileSync(sessionsFile, 'utf8');
    const verifySessions = JSON.parse(verifyRaw);
    const verifySession = verifySessions.find(s => s.id === sessionId);
    expect(verifySession.status).toBe('starting');
    console.log(`  [T-36] sessions.json corrupted: ${sessionId} status changed from '${originalStatus}' to 'starting'`);

    // ── Step 5: Restart server with same DATA_DIR ────────────────────────────
    console.log('  [T-36] Restarting server...');
    serverProc = await startServer(tmpDir, crashLogPath);
    const ready = await waitForServer(25000);

    if (!ready) {
      // Check crash log for startup crash
      const crashLog = fs.existsSync(crashLogPath)
        ? fs.readFileSync(crashLogPath, 'utf8').trim()
        : '(no crash log)';
      throw new Error(`Server failed to start after restart. Crash log: ${crashLog}`);
    }
    console.log('  [T-36] Server restarted and ready');

    // ── Step 6: Check crash log for startup crash ────────────────────────────
    // Only check for NEW crash log entries after restart (compare with pre-restart state)
    const postRestartCrashLog = fs.existsSync(crashLogPath)
      ? fs.readFileSync(crashLogPath, 'utf8').trim()
      : '';

    const newCrashEntries = postRestartCrashLog.slice(preRestartCrashLog.length).trim();
    if (newCrashEntries) {
      console.error(`  [T-36] CRASH LOG entries after restart: ${newCrashEntries}`);
    }
    expect(newCrashEntries).toBe('');
    console.log('  [T-36] PASS: No crash log entries after restart');

    // ── Step 7: Fetch session list and check session status ─────────────────
    await sleep(500); // Give server a moment to finish init
    const postRestartRes = await fetch(`${BASE_URL}/api/sessions`);
    expect(postRestartRes.ok).toBe(true);
    const postRestartData = await postRestartRes.json();
    const postRestartSessions = postRestartData.managed || postRestartData || [];
    console.log(`  [T-36] Post-restart sessions: ${JSON.stringify(postRestartSessions.map(s => ({ id: s.id.slice(0,8), status: s.status || s.state })))}`);

    const recoveredSession = postRestartSessions.find(s => s.id === sessionId);
    if (!recoveredSession) {
      throw new Error(`FAIL: Session ${sessionId} not found after restart`);
    }

    const postStatus = recoveredSession.status || recoveredSession.state;
    console.log(`  [T-36] Session status after restart: '${postStatus}'`);

    // The session must NOT be stuck in 'starting'
    expect(postStatus).not.toBe('starting');
    console.log(`  [T-36] PASS: Session is not stuck in 'starting' (status='${postStatus}')`);

    // The session must be in a recoverable/terminal state
    const validStates = ['running', 'stopped', 'error', 'created'];
    expect(validStates).toContain(postStatus);
    console.log(`  [T-36] PASS: Session in valid state after restart: '${postStatus}'`);

    // ── Step 8: Verify server is fully functional ───────────────────────────
    const projectsRes = await fetch(`${BASE_URL}/api/projects`);
    expect(projectsRes.ok).toBe(true);
    const projects = await projectsRes.json();
    const ourProject = projects.find(p => p.id === projectId);
    expect(ourProject).toBeTruthy();
    console.log(`  [T-36] PASS: Server fully functional after restart, project found`);

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log('\n  [T-36] SUMMARY:');
    console.log(`    Session ${sessionId.slice(0,8)}... was stuck in 'starting'`);
    console.log(`    After restart: status='${postStatus}'`);
    console.log('    Server started without crash ✓');
    console.log('    Session not stuck in starting ✓');
    console.log('    Server fully responsive ✓');

  }, 60000);
});
