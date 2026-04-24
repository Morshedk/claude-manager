/**
 * T-4: Double-delete in rapid succession — idempotent delete + single log entry (AC12, Risk 4)
 * Port: 3363
 * Type: WS + filesystem
 *
 * Pass condition:
 *   - Server does NOT crash (WS stays open, subsequent request succeeds)
 *   - Log has exactly 2 entries total (created + deleted). NOT three.
 *   - No session:error reply received
 */

import { test, expect } from '@jest/globals';
import { spawn, execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3363;
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

async function pollFileForCount(filePath, count, timeoutMs = 5000) {
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
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
}

test('T-4: Double-delete in rapid succession — single deleted log entry + server survives', async () => {
  const dataDir = `/tmp/qa-T4-double-delete-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });

  const projPath = join(dataDir, 'proj-dir');
  mkdirSync(projPath, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'proj-t4', name: 'T4-Project', path: projPath }],
    scratchpad: []
  }));

  const server = startServer(dataDir);
  server.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  server.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

  try {
    await waitForServer(PORT);
    console.log(`  [T-4] Server ready`);

    // Create session
    const sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('Timeout creating session')); }, 15000);
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-t4',
            name: 'double-del',
            mode: 'direct',
            command: 'bash',
            telegram: false,
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

    console.log(`  [T-4] Session created: ${sessionId}`);

    // Wait for created entry to appear on disk
    const lifecycleFile = join(dataDir, 'session-lifecycle.json');
    await pollFileForCount(lifecycleFile, 1, 3000);
    console.log(`  [T-4] Created entry confirmed`);

    // Send TWO session:delete messages in rapid succession (no await between sends)
    const sessionErrors = [];

    const deleteResult = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const timer = setTimeout(() => { ws.close(); resolve({ wsAlive: true, errors: sessionErrors }); }, 5000);

      ws.on('open', () => {
        // Burst both deletes without awaiting
        ws.send(JSON.stringify({ type: 'session:delete', id: sessionId }));
        ws.send(JSON.stringify({ type: 'session:delete', id: sessionId }));
        console.log(`  [T-4] Both delete messages sent in burst`);
      });

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'session:error') {
            sessionErrors.push(msg);
            console.log(`  [T-4] session:error received: ${JSON.stringify(msg)}`);
          }
          // Once we see the session gone from sessions:list, wait a bit more for any second responses
          if (msg.type === 'sessions:list') {
            const found = (msg.sessions || []).find(s => s.id === sessionId);
            if (!found) {
              setTimeout(() => {
                clearTimeout(timer);
                ws.close();
                resolve({ wsAlive: true, errors: sessionErrors });
              }, 1500);
            }
          }
        } catch {}
      });

      ws.on('error', err => {
        clearTimeout(timer);
        reject(new Error(`WS error: ${err.message}`));
      });
    });

    console.log(`  [T-4] WS alive: ${deleteResult.wsAlive}, errors: ${JSON.stringify(deleteResult.errors)}`);

    // Wait for lifecycle chain to settle
    await sleep(2000);

    // Assert: server is alive
    const pingResp = await fetch(`http://localhost:${PORT}/api/sessions`);
    expect(pingResp.ok).toBe(true); // 'Server must remain alive after double-delete'
    console.log(`  [T-4] Server still alive (GET /api/sessions → ${pingResp.status})`);

    // Assert: exactly 2 entries in log (1 created + 1 deleted)
    const logFinal = await pollFileForCount(lifecycleFile, 2, 3000);
    console.log(`  [T-4] Final log: ${JSON.stringify(logFinal, null, 2)}`);

    expect(logFinal).not.toBeNull(); // 'Lifecycle log must exist'
    expect(logFinal.length).toBe(2); // 'Must have exactly 2 entries — not 3 from double-delete'

    expect(logFinal[0].event).toBe('created');
    expect(logFinal[1].event).toBe('deleted');
    expect(logFinal[1].sessionId).toBe(sessionId);

    // Assert: no session:error replies
    expect(deleteResult.errors.length).toBe(0); // 'No session:error should be sent for double-delete'

    console.log('\n  [T-4] PASSED — idempotent delete, single log entry, server alive');

  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    server.kill('SIGKILL');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  }
}, 60000);
