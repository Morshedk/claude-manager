/**
 * T-2: Rename session without moving (Story 3)
 *
 * Pass condition:
 *   - Name updates to "auth refactor", projectId stays proj-a
 *   - sessions:list broadcast shows updated name
 *   - Empty string name becomes null in response
 *
 * Port: 3401
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3401;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';

function seedDataDir(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({
    projects: [
      { id: 'proj-a', name: 'Project Alpha', path: '/tmp/project-a', createdAt: '2026-01-01T00:00:00.000Z' }
    ],
    scratchpad: []
  }));
}

function startServer(dataDir, port) {
  const crashLog = join(dataDir, 'crash.log');
  return spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, CRASH_LOG: crashLog },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForServer(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/sessions`);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start on port ${port} within ${timeoutMs}ms`);
}

test('T-2: Rename session without moving — name updates, projectId unchanged', async () => {
  const dataDir = `/tmp/feat-move-T2-${Date.now()}`;
  mkdirSync('/tmp/project-a', { recursive: true });
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  try {
    await waitForServer(PORT);

    const results = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      let sessionId = null;
      let renameUpdated = null;
      let broadcastAfterRename = null;
      let emptyNameUpdated = null;
      let phase = 'create'; // create -> rename -> empty

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WS timeout in T-2'));
      }, 20000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-a',
            name: 'vague',
            mode: 'direct'
          }));
        }

        if (msg.type === 'session:created' && phase === 'create') {
          sessionId = msg.session.id;
          phase = 'rename';
          ws.send(JSON.stringify({
            type: 'session:update',
            id: sessionId,
            name: 'auth refactor'
          }));
        }

        if (msg.type === 'session:updated' && phase === 'rename') {
          renameUpdated = msg;
          // wait for broadcast
        }

        if (msg.type === 'sessions:list' && phase === 'rename' && renameUpdated) {
          broadcastAfterRename = msg;
          phase = 'empty';
          ws.send(JSON.stringify({
            type: 'session:update',
            id: sessionId,
            name: ''
          }));
        }

        if (msg.type === 'session:updated' && phase === 'empty') {
          emptyNameUpdated = msg;
          clearTimeout(timeout);
          ws.close();
          resolve({ renameUpdated, broadcastAfterRename, emptyNameUpdated });
        }
      });

      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    // Assert 1: rename to "auth refactor"
    expect(results.renameUpdated).toBeDefined();
    expect(results.renameUpdated.session.name).toBe('auth refactor');
    expect(results.renameUpdated.session.projectId).toBe('proj-a');

    // Assert 2: broadcast shows updated name
    expect(results.broadcastAfterRename).toBeDefined();
    const sessionInBroadcast = results.broadcastAfterRename.sessions.find(
      s => s.id === results.renameUpdated.id
    );
    expect(sessionInBroadcast).toBeDefined();
    expect(sessionInBroadcast.name).toBe('auth refactor');

    // Assert 3: empty name becomes null
    expect(results.emptyNameUpdated).toBeDefined();
    expect(results.emptyNameUpdated.session.name).toBeNull();

  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 30000);
