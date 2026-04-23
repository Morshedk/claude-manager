/**
 * T-4: Move to non-existent project (adversarial)
 *
 * Pass condition:
 *   - session:update with invalid projectId returns session:error with "Project not found"
 *   - session:update with invalid sessionId returns session:error with "Session not found"
 *   - Session data remains unchanged after failed update
 *   - A silent no-op (no response) is also a FAIL
 *
 * Port: 3403
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3403;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';

function seedDataDir(dir) {
  mkdirSync(dir, { recursive: true });
  mkdirSync('/tmp/project-a', { recursive: true });
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

function waitForOneOf(ws, types, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for one of: ${types.join(', ')}`));
    }, timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (types.includes(msg.type)) {
        clearTimeout(t);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

test('T-4: Invalid projectId and sessionId both return session:error', async () => {
  const dataDir = `/tmp/feat-move-T4-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  let ws = null;

  try {
    await waitForServer(PORT);

    ws = new WebSocket(`ws://localhost:${PORT}`);

    // Wait for init
    await waitForOneOf(ws, ['init']);

    // Create a session
    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: 'proj-a',
      name: 'target-session',
      mode: 'direct'
    }));

    const createdMsg = await waitForOneOf(ws, ['session:created']);
    const sessionId = createdMsg.session.id;

    // Test 1: Move to non-existent project
    ws.send(JSON.stringify({
      type: 'session:update',
      id: sessionId,
      projectId: 'proj-nonexistent'
    }));

    const errorMsg1 = await waitForOneOf(ws, ['session:error', 'session:updated'], 8000);
    // Must be an error, not success
    expect(errorMsg1.type).toBe('session:error');
    expect(errorMsg1.error).toMatch(/Project not found/i);

    // Test 2: Session should be unchanged (still under proj-a)
    const resp = await fetch(`http://localhost:${PORT}/api/sessions`);
    expect(resp.ok).toBe(true);
    const { managed } = await resp.json();
    const session = managed.find(s => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session.projectId).toBe('proj-a');

    // Test 3: Update non-existent session
    ws.send(JSON.stringify({
      type: 'session:update',
      id: 'session-nonexistent',
      name: 'hacked'
    }));

    const errorMsg2 = await waitForOneOf(ws, ['session:error', 'session:updated'], 8000);
    // Must be an error
    expect(errorMsg2.type).toBe('session:error');
    expect(errorMsg2.error).toMatch(/Session not found/i);

  } finally {
    if (ws) ws.close();
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 30000);
