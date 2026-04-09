/**
 * T-3: lastLine updates as new output arrives
 * Port: 3202
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3202;
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

test('T-3: lastLine updates as new PTY output arrives', async () => {
  const dataDir = `/tmp/feat-lastline-T3-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  try {
    await waitForServer(PORT);

    let ws;
    const sessionId = await new Promise((resolve, reject) => {
      ws = new WebSocket(`ws://localhost:${PORT}`);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) reject(new Error('WS timeout'));
        ws.close();
      }, 10000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-1',
            name: 'T3-update-test',
            command: 'bash',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          resolved = true;
          clearTimeout(timeout);
          resolve(msg.session.id);
        }
      });
      ws.on('error', reject);
    });

    // Send first echo
    ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo first_marker\n' }));

    // Wait for debounce
    await new Promise(r => setTimeout(r, 1000));

    // Check first value
    let resp = await fetch(`http://localhost:${PORT}/api/sessions`);
    let { managed } = await resp.json();
    let session = managed.find(s => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session.lastLine).toBe('first_marker');

    // Send second echo
    ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo second_marker\n' }));

    // Wait for debounce
    await new Promise(r => setTimeout(r, 1000));

    // Check second value — must have changed
    resp = await fetch(`http://localhost:${PORT}/api/sessions`);
    ({ managed } = await resp.json());
    session = managed.find(s => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session.lastLine).toBe('second_marker');

    ws.close();
  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
