/**
 * T-1: Move session to a different project (Story 1 — correcting misplaced session)
 *
 * Pass condition:
 *   - session:updated payload has projectId=proj-b, projectName="Project Beta", cwd="/tmp/project-b"
 *   - sessions:list broadcast reflects the move
 *   - GET /api/sessions shows session under proj-b
 *   - sessions.json on disk has updated projectId, projectName, cwd
 *
 * Port: 3400
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3400;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';

function seedDataDir(dir) {
  mkdirSync(dir, { recursive: true });
  mkdirSync('/tmp/project-a', { recursive: true });
  mkdirSync('/tmp/project-b', { recursive: true });
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({
    projects: [
      { id: 'proj-a', name: 'Project Alpha', path: '/tmp/project-a', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'proj-b', name: 'Project Beta', path: '/tmp/project-b', createdAt: '2026-01-01T00:00:00.000Z' }
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

test('T-1: Move session to a different project', async () => {
  const dataDir = `/tmp/feat-move-T1-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  try {
    await waitForServer(PORT);

    const { sessionId, updatedMsg, broadcastAfterMove } = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      let sessionId = null;
      let updatedMsg = null;
      let broadcastAfterMove = null;
      let moveRequested = false;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WS timeout in T-1'));
      }, 20000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-a',
            name: 'misplaced',
            mode: 'direct'
          }));
        }

        if (msg.type === 'session:created') {
          sessionId = msg.session.id;
          // Send the move
          moveRequested = true;
          ws.send(JSON.stringify({
            type: 'session:update',
            id: sessionId,
            projectId: 'proj-b'
          }));
        }

        if (msg.type === 'session:updated' && moveRequested) {
          updatedMsg = msg;
        }

        if (msg.type === 'sessions:list' && moveRequested && updatedMsg) {
          broadcastAfterMove = msg;
          clearTimeout(timeout);
          ws.close();
          resolve({ sessionId, updatedMsg, broadcastAfterMove });
        }
      });

      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    // Assert 1: session:updated has correct fields
    expect(updatedMsg).toBeDefined();
    expect(updatedMsg.session.projectId).toBe('proj-b');
    expect(updatedMsg.session.projectName).toBe('Project Beta');
    expect(updatedMsg.session.cwd).toBe('/tmp/project-b');

    // Assert 2: broadcast shows session under proj-b
    expect(broadcastAfterMove).toBeDefined();
    const sessionInBroadcast = broadcastAfterMove.sessions.find(s => s.id === sessionId);
    expect(sessionInBroadcast).toBeDefined();
    expect(sessionInBroadcast.projectId).toBe('proj-b');

    // Assert 3: REST API reflects the move
    const resp = await fetch(`http://localhost:${PORT}/api/sessions`);
    expect(resp.ok).toBe(true);
    const { managed } = await resp.json();
    const sessionInRest = managed.find(s => s.id === sessionId);
    expect(sessionInRest).toBeDefined();
    expect(sessionInRest.projectId).toBe('proj-b');

    // Assert 4: sessions.json on disk is updated
    await new Promise(r => setTimeout(r, 300)); // brief flush
    const diskData = JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8'));
    const sessionOnDisk = diskData.find(s => s.id === sessionId);
    expect(sessionOnDisk).toBeDefined();
    expect(sessionOnDisk.projectId).toBe('proj-b');
    expect(sessionOnDisk.projectName).toBe('Project Beta');
    expect(sessionOnDisk.cwd).toBe('/tmp/project-b');

  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 30000);
