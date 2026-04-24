/**
 * T-6: Rapid double-submit and running session move (adversarial)
 *
 * Pass condition:
 *   - Both rapid session:update messages succeed without error
 *   - Exactly 2 session:updated messages received
 *   - At least 2 sessions:list broadcasts received
 *   - Final state shows session under proj-a with name "moved-back" (last writer wins)
 *   - Session status is still "running" (PTY not interrupted)
 *   - Session still accepts input (PTY alive)
 *
 * Port: 3405
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3405;
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

test('T-6: Rapid double-submit and running session move', async () => {
  const dataDir = `/tmp/feat-move-T6-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);
  let ws = null;

  try {
    await waitForServer(PORT);

    // Phase 1: Create session and verify it's running
    const { sessionId, initialStatus } = await new Promise((resolve, reject) => {
      ws = new WebSocket(`ws://localhost:${PORT}`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WS timeout creating session'));
      }, 15000);

      let sessionId = null;
      let resolved = false;

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-a',
            name: 'original',
            mode: 'direct'
          }));
        }

        if (msg.type === 'session:created' && !resolved) {
          sessionId = msg.session.id;
          const status = msg.session.status || msg.session.state;
          // Wait a moment for the session to be fully running
          setTimeout(() => {
            resolved = true;
            clearTimeout(timeout);
            resolve({ sessionId, initialStatus: status });
          }, 1000);
        }
      });

      ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });

    console.log(`  [T-6] Session created: ${sessionId}, initial status: ${initialStatus}`);
    // Direct mode sessions should auto-start
    expect(['running', 'starting']).toContain(initialStatus);

    // Phase 2: Rapid double-submit — two updates in rapid succession
    const collectedMessages = [];
    ws.on('message', (data) => {
      collectedMessages.push(JSON.parse(data.toString()));
    });

    // Clear any buffered messages
    collectedMessages.length = 0;

    // Send both updates without awaiting
    ws.send(JSON.stringify({
      type: 'session:update',
      id: sessionId,
      projectId: 'proj-b',
      name: 'moved'
    }));
    ws.send(JSON.stringify({
      type: 'session:update',
      id: sessionId,
      projectId: 'proj-a',
      name: 'moved-back'
    }));

    console.log('  [T-6] Sent both rapid updates');

    // Collect messages for 2 seconds
    await new Promise(r => setTimeout(r, 2000));

    const updatedMessages = collectedMessages.filter(m => m.type === 'session:updated');
    const listMessages = collectedMessages.filter(m => m.type === 'sessions:list');
    const errorMessages = collectedMessages.filter(m => m.type === 'session:error');

    console.log(`  [T-6] Collected: ${updatedMessages.length} session:updated, ${listMessages.length} sessions:list, ${errorMessages.length} session:error`);

    // Assert 1: Received exactly 2 session:updated messages
    expect(errorMessages).toHaveLength(0);
    expect(updatedMessages).toHaveLength(2);

    // Assert 2: At least 2 sessions:list broadcasts
    expect(listMessages.length).toBeGreaterThanOrEqual(2);

    // Assert 3: Final state from last sessions:list is proj-a with name "moved-back" (last writer wins)
    const lastList = listMessages[listMessages.length - 1];
    const finalSession = lastList.sessions.find(s => s.id === sessionId);
    expect(finalSession).toBeDefined();
    expect(finalSession.projectId).toBe('proj-a');
    expect(finalSession.name).toBe('moved-back');
    console.log(`  [T-6] Final state: projectId=${finalSession.projectId}, name=${finalSession.name}`);

    // Assert 4: Session status is still running (PTY not interrupted)
    const finalStatus = finalSession.status || finalSession.state;
    expect(['running', 'starting']).toContain(finalStatus);
    console.log(`  [T-6] Session status after moves: ${finalStatus}`);

    // Assert 5: PTY is still alive — send input and wait for output
    const outputReceived = await new Promise((resolve) => {
      let got = false;
      const t = setTimeout(() => resolve(got), 5000);

      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session:output' && msg.id === sessionId) {
          got = true;
          clearTimeout(t);
          ws.off('message', handler);
          resolve(true);
        }
      };
      ws.on('message', handler);

      // Send input to the running session
      ws.send(JSON.stringify({
        type: 'session:input',
        id: sessionId,
        data: 'echo pty_still_alive\n'
      }));
    });

    expect(outputReceived).toBe(true);
    console.log('  [T-6] PTY still alive — received output after move');

  } finally {
    if (ws) ws.close();
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 40000);
