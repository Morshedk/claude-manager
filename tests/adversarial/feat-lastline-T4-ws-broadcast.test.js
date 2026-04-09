/**
 * T-4: sessions:list WS broadcast carries lastLine
 * Port: 3203
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3203;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';

function seedDataDir(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'proj-1', name: 'Test Project', path: '/tmp' }],
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

async function waitForServer(port, timeoutMs = 5000) {
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

test('T-4: sessions:list WS broadcast carries lastLine', async () => {
  const dataDir = `/tmp/feat-lastline-T4-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  try {
    await waitForServer(PORT);

    const sessionListsWithLastLine = [];
    let sessionId = null;
    let echoSent = false;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);

      const timeout = setTimeout(() => {
        resolve(); // Resolve after 6s to check collected data
        ws.close();
      }, 6000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'sessions:list' && sessionId && echoSent) {
          // Collect sessions:list messages after echo was sent
          const session = msg.sessions.find(s => s.id === sessionId);
          if (session?.lastLine) {
            sessionListsWithLastLine.push(session.lastLine);
          }
        }

        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-1',
            name: 'T4-ws-broadcast',
            command: 'bash',
            mode: 'direct'
          }));
        }

        if (msg.type === 'session:created') {
          sessionId = msg.session.id;
          // Send echo after brief delay
          setTimeout(() => {
            echoSent = true;
            ws.send(JSON.stringify({
              type: 'session:input',
              id: sessionId,
              data: 'echo ws_lastline_marker\n'
            }));
          }, 300);
        }
      });
      ws.on('error', reject);
    });

    // Verify we received at least one sessions:list with lastLine set
    expect(sessionListsWithLastLine.length).toBeGreaterThan(0);
    expect(sessionListsWithLastLine.some(v => v === 'ws_lastline_marker')).toBe(true);
  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
