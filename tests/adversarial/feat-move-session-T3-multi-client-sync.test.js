/**
 * T-3: Multi-client synchronization (Story 5)
 *
 * Pass condition:
 *   - Client B receives sessions:list broadcast showing session under proj-b
 *   - Client B does NOT receive session:updated message
 *
 * Port: 3402
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3402;
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

function connectWS(port) {
  return new WebSocket(`ws://localhost:${port}`);
}

function waitForMessage(ws, type, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(t);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

test('T-3: Multi-client sync — client B sees broadcast, does not receive session:updated', async () => {
  const dataDir = `/tmp/feat-move-T3-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  let wsA = null;
  let wsB = null;

  try {
    await waitForServer(PORT);

    // Connect both clients
    wsA = connectWS(PORT);
    wsB = connectWS(PORT);

    // Wait for both inits
    await waitForMessage(wsA, 'init');
    await waitForMessage(wsB, 'init');

    // Collect all messages received by client B
    const bMessages = [];
    wsB.on('message', (data) => {
      bMessages.push(JSON.parse(data.toString()));
    });

    // Client A creates a session
    wsA.send(JSON.stringify({
      type: 'session:create',
      projectId: 'proj-a',
      name: 'multi-client-test',
      mode: 'direct'
    }));

    // Wait for session:created on A
    const createdMsg = await waitForMessage(wsA, 'session:created');
    const sessionId = createdMsg.session.id;

    // Wait a moment for client B to receive the sessions:list broadcast from create
    await new Promise(r => setTimeout(r, 500));

    // Client A sends the move update
    wsA.send(JSON.stringify({
      type: 'session:update',
      id: sessionId,
      projectId: 'proj-b'
    }));

    // Wait for session:updated on A
    const updatedMsg = await waitForMessage(wsA, 'session:updated');
    expect(updatedMsg.session.projectId).toBe('proj-b');

    // Wait for broadcast to arrive at B (2s budget)
    await new Promise(r => setTimeout(r, 2000));

    // Assert 1: Client B received a sessions:list with the moved session
    const bListMessages = bMessages.filter(m => m.type === 'sessions:list');
    const bListAfterMove = bListMessages.find(m => {
      const s = m.sessions.find(s => s.id === sessionId);
      return s && s.projectId === 'proj-b';
    });
    expect(bListAfterMove).toBeDefined();

    // Assert 2: Client B did NOT receive session:updated
    const bUpdatedMessages = bMessages.filter(m => m.type === 'session:updated');
    expect(bUpdatedMessages).toHaveLength(0);

  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 30000);
