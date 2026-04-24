/**
 * T-5: Log-write failure does NOT break the delete (AC10, G2)
 * Port: 3364
 * Type: WS + filesystem
 *
 * Pass condition:
 *   - Session is removed from sessions:list (delete succeeded client-visibly)
 *   - No session:error reply
 *   - Server remains alive (GET /api/sessions returns 200)
 *
 * Method: Replace session-lifecycle.json with a directory of the same name
 * so fs.writeFileSync throws EISDIR.
 *
 * G1/G2 fix already applied: _doLifecycleAppend now uses console.error
 * instead of this.emit('error', err) to avoid killing the test harness.
 */

import { test, expect } from '@jest/globals';
import { spawn, execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3364;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer(dataDir) {
  const crashLog = join(dataDir, 'crash.log');
  return spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CRASH_LOG: crashLog },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/sessions`);
      if (res.ok) return true;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Server did not start on port ${port} within ${timeoutMs}ms`);
}

async function pollFileForCount(filePath, count, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) {
      try {
        const arr = JSON.parse(readFileSync(filePath, 'utf8'));
        if (Array.isArray(arr) && arr.length >= count) return arr;
      } catch {}
    }
    await sleep(100);
  }
  return null;
}

test('T-5: Log-write failure does not break session delete (AC10)', async () => {
  const dataDir = `/tmp/qa-T5-log-fail-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });

  const projPath = join(dataDir, 'proj-dir');
  mkdirSync(projPath, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'proj-t5', name: 'T5-Project', path: projPath }],
    scratchpad: []
  }));

  const server = startServer(dataDir);
  server.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  server.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

  try {
    await waitForServer(PORT);
    console.log(`  [T-5] Server ready`);

    // Create session
    const sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('Timeout creating session')); }, 15000);
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-t5',
            name: 'log-fail-sess',
            mode: 'direct',
            command: 'bash',
          }));
        }
        if (msg.type === 'session:created') {
          clearTimeout(timer);
          ws.close();
          resolve(msg.session.id);
        }
      });
      ws.on('error', err => { clearTimeout(timer); reject(err); });
    });

    console.log(`  [T-5] Session created: ${sessionId}`);

    // Wait for created entry in lifecycle file
    const lifecycleFile = join(dataDir, 'session-lifecycle.json');
    const logInitial = await pollFileForCount(lifecycleFile, 1, 3000);
    expect(logInitial).not.toBeNull(); // 'Must have initial created entry before sabotaging'
    console.log(`  [T-5] Created entry confirmed`);

    // Sabotage: replace session-lifecycle.json with a DIRECTORY of the same name
    // so any fs.writeFileSync will throw EISDIR
    try { rmSync(lifecycleFile); } catch {}
    try { mkdirSync(lifecycleFile); } catch {}
    console.log(`  [T-5] session-lifecycle.json replaced with directory (write will fail with EISDIR)`);

    // Send session:delete and collect responses
    const sessionErrors = [];
    const deleteSucceeded = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for session deletion broadcast'));
      }, 12000);

      ws.on('open', () => {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'session:delete', id: sessionId }));
          console.log(`  [T-5] Sent session:delete`);
        }, 200);
      });

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'session:error') {
            sessionErrors.push(msg);
            console.log(`  [T-5] session:error: ${JSON.stringify(msg)}`);
          }
          if (msg.type === 'sessions:list') {
            const found = (msg.sessions || []).find(s => s.id === sessionId);
            if (!found) {
              clearTimeout(timer);
              ws.close();
              resolve(true);
            }
          }
        } catch {}
      });

      ws.on('error', err => { clearTimeout(timer); reject(err); });
    });

    console.log(`  [T-5] Delete succeeded in sessions:list: ${deleteSucceeded}`);
    console.log(`  [T-5] session:error count: ${sessionErrors.length}`);

    // AC10: delete succeeded (session gone from broadcast)
    expect(deleteSucceeded).toBe(true); // 'Delete must succeed client-visibly even when log write fails'

    // No session:error propagated to client
    expect(sessionErrors.length).toBe(0); // 'Log I/O failure must not send session:error to client'

    // Server is alive
    const pingResp = await fetch(`http://localhost:${PORT}/api/sessions`);
    expect(pingResp.ok).toBe(true); // 'Server must remain alive after log I/O failure'
    console.log(`  [T-5] Server still alive (GET /api/sessions → ${pingResp.status})`);

    console.log('\n  [T-5] PASSED — log-write failure does not break user-visible delete');

  } finally {
    // Restore permissions for cleanup
    try {
      const lifecycleFile = join(dataDir, 'session-lifecycle.json');
      execSync(`rm -rf "${lifecycleFile}" 2>/dev/null || true`);
    } catch {}

    server.kill('SIGTERM');
    await sleep(500);
    server.kill('SIGKILL');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  }
}, 60000);
