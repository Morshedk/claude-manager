/**
 * T-35: Concurrent Session Creates — 5 Sessions Start Without Cross-Bleed
 *
 * Score: 12 | Type: Server-level (REST/WS) | Port: 3132
 *
 * Flow:
 *   1. Start server, seed a project.
 *   2. Open 5 separate WebSocket connections.
 *   3. Send 5 simultaneous session:create messages (unique names, bash command).
 *   4. Collect session:created responses.
 *   5. Wait 10 seconds for sessions to settle.
 *   6. GET /api/sessions — verify exactly 5 sessions, all unique IDs, all running/error.
 *
 * Run:
 *   fuser -k 3132/tcp 2>/dev/null; sleep 1
 *   npx jest tests/adversarial/T-35-concurrent-sessions.test.js --testTimeout=60000 --forceExit
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
const PORT = 3132;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Opens a WS connection and attaches a message buffer so no messages are lost
 * before listeners are registered.
 */
function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const msgBuffer = []; // Buffer messages received before waitForMsg is called
    ws._msgBuffer = msgBuffer;
    ws.on('message', (raw) => {
      msgBuffer.push(raw);
    });
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMsg(ws, predicate, timeoutMs = 15000) {
  // First drain the message buffer
  const buf = ws._msgBuffer || [];
  for (const raw of buf) {
    try {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        buf.splice(buf.indexOf(raw), 1);
        return Promise.resolve(msg);
      }
    } catch {}
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS msg timeout after ${timeoutMs}ms`)), timeoutMs);
    function handler(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch {}
    }
    ws.on('message', handler);
  });
}

function collectMsgs(ws, predicate, timeoutMs = 15000) {
  const collected = [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(collected);
    }, timeoutMs);
    function handler(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) collected.push(msg);
      } catch {}
    }
    ws.on('message', handler);
    // Will auto-resolve on timeout
  });
}

describe('T-35 — Concurrent Session Creates', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = '';
  let wsConnections = [];
  let crashLogPath = '';

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-T35-XXXXXX').toString().trim();
    crashLogPath = path.join(tmpDir, 'crash.log');
    console.log(`\n  [T-35] tmpDir: ${tmpDir}`);

    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    // Poll until server ready
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/`);
        if (r.ok) break;
      } catch {}
      await sleep(400);
    }

    // Seed a project
    const pr = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T35-Project', path: '/tmp' }),
    });
    if (!pr.ok) throw new Error(`Failed to create project: ${pr.status}`);
    const proj = await pr.json();
    projectId = proj.id;
    console.log(`  [T-35] projectId: ${projectId}`);
  }, 40000);

  afterAll(async () => {
    // Close all WS connections
    for (const ws of wsConnections) {
      try { ws.close(); } catch {}
    }
    await sleep(300);

    if (serverProc) {
      serverProc.kill('SIGTERM');
      await sleep(500);
    }
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  });

  test('5 concurrent creates produce 5 unique running sessions', async () => {
    const N = 5;

    // Step 1: Open 5 WebSocket connections
    console.log(`  [T-35] Opening ${N} WebSocket connections...`);
    wsConnections = await Promise.all(
      Array.from({ length: N }, () => openWs())
    );
    console.log(`  [T-35] ${wsConnections.length} WS connections open`);

    // Step 2: Wait for 'connected' init message on each WS (confirms clientId assigned)
    const connectedMsgs = await Promise.all(
      wsConnections.map(ws => waitForMsg(ws, m => m.type === 'init', 8000))
    );
    const clientIds = connectedMsgs.map(m => m.clientId);
    console.log(`  [T-35] clientIds: ${clientIds.join(', ')}`);

    // Verify 5 distinct clientIds (server assigns unique ID per connection)
    const uniqueClientIds = new Set(clientIds);
    expect(uniqueClientIds.size).toBe(N);

    // Step 3: Set up listeners for session:created on each WS
    const createdPromises = wsConnections.map((ws, i) =>
      waitForMsg(ws, m => m.type === 'session:created', 15000)
    );

    // Step 4: Send 5 session:create messages simultaneously
    console.log(`  [T-35] Sending ${N} simultaneous session:create messages...`);
    const sendTime = Date.now();
    await Promise.all(
      wsConnections.map((ws, i) => {
        const msg = JSON.stringify({
          type: 'session:create',
          projectId,
          name: `sess-${i}`,
          command: 'bash',
          mode: 'direct',
          cols: 80,
          rows: 24,
        });
        ws.send(msg);
      })
    );
    console.log(`  [T-35] All ${N} creates sent in parallel (${Date.now() - sendTime}ms)`);

    // Step 5: Collect all session:created responses
    const createdMsgs = await Promise.all(createdPromises);
    console.log(`  [T-35] Received ${createdMsgs.length} session:created responses`);

    expect(createdMsgs.length).toBe(N);

    // Step 6: Extract session IDs and verify uniqueness
    const sessionIds = createdMsgs.map(m => m.session.id);
    console.log(`  [T-35] Session IDs: ${sessionIds.join(', ')}`);

    const uniqueIds = new Set(sessionIds);
    expect(uniqueIds.size).toBe(N);
    console.log(`  [T-35] PASS: All ${N} session IDs are unique`);

    // Verify session names
    const sessionNames = createdMsgs.map(m => m.session.name);
    console.log(`  [T-35] Session names: ${sessionNames.join(', ')}`);
    const uniqueNames = new Set(sessionNames);
    expect(uniqueNames.size).toBe(N);

    // Step 7: Wait 10 seconds for sessions to settle
    console.log(`  [T-35] Waiting 10s for sessions to settle...`);
    await sleep(10000);

    // Step 8: Fetch session list via REST API
    const sessionsRes = await fetch(`${BASE_URL}/api/sessions`);
    expect(sessionsRes.ok).toBe(true);
    const sessionsData = await sessionsRes.json();
    const allSessions = sessionsData.managed || sessionsData || [];
    console.log(`  [T-35] Total sessions from API: ${allSessions.length}`);

    // Filter to only our project's sessions
    const projectSessions = allSessions.filter(s => s.projectId === projectId);
    console.log(`  [T-35] Our project's sessions: ${projectSessions.length}`);
    console.log(`  [T-35] Session states: ${projectSessions.map(s => `${s.name}:${s.status || s.state}`).join(', ')}`);

    // Assert exactly 5 sessions
    expect(projectSessions.length).toBe(N);
    console.log(`  [T-35] PASS: Exactly ${N} sessions for project`);

    // Assert all IDs unique
    const apiIds = projectSessions.map(s => s.id);
    expect(new Set(apiIds).size).toBe(N);
    console.log(`  [T-35] PASS: All ${N} session IDs unique in API response`);

    // Assert no sessions stuck in 'starting' or 'created'
    const stuckSessions = projectSessions.filter(s => {
      const st = s.status || s.state;
      return st === 'starting' || st === 'created';
    });
    if (stuckSessions.length > 0) {
      console.error(`  [T-35] FAIL: Sessions stuck in non-terminal state: ${stuckSessions.map(s => `${s.name}:${s.status || s.state}`).join(', ')}`);
    }
    expect(stuckSessions.length).toBe(0);
    console.log(`  [T-35] PASS: No sessions stuck in 'starting' or 'created'`);

    // Assert all sessions are 'running' or 'error' (terminal state after bash starts)
    const validStates = ['running', 'stopped', 'error'];
    const invalidSessions = projectSessions.filter(s => {
      const st = s.status || s.state;
      return !validStates.includes(st);
    });
    expect(invalidSessions.length).toBe(0);
    console.log(`  [T-35] PASS: All sessions in terminal state (running/stopped/error)`);

    // Verify session IDs match what was returned in session:created messages
    for (const id of sessionIds) {
      const found = apiIds.includes(id);
      expect(found).toBe(true);
    }
    console.log(`  [T-35] PASS: All session:created IDs confirmed in API response`);

    // Step 9: Check crash log
    const crashLog = fs.existsSync(crashLogPath) ? fs.readFileSync(crashLogPath, 'utf8').trim() : '';
    if (crashLog) {
      console.error(`  [T-35] CRASH LOG: ${crashLog}`);
    }
    expect(crashLog).toBe('');
    console.log('  [T-35] PASS: No crash log entries');

  }, 30000);
});
