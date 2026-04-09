/**
 * T-2: ANSI codes are stripped — raw escape sequences don't appear in lastLine
 * Port: 3201
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3201;
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

test('T-2: ANSI codes stripped from lastLine', async () => {
  const dataDir = `/tmp/feat-lastline-T2-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  try {
    await waitForServer(PORT);

    const sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
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
            name: 'T2-ansi-test',
            command: 'bash',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          resolved = true;
          clearTimeout(timeout);
          const id = msg.session.id;
          // Send printf with ANSI color codes after short delay
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'session:input',
              id,
              // printf produces: ESC[32mgreen_text_marker ESC[0m
              data: "printf '\\033[32mgreen_text_marker\\033[0m\\n'\n"
            }));
          }, 300);
          setTimeout(() => { ws.close(); resolve(id); }, 400);
        }
      });
      ws.on('error', reject);
    });

    // Wait for debounce + margin
    await new Promise(r => setTimeout(r, 1200));

    const resp = await fetch(`http://localhost:${PORT}/api/sessions`);
    expect(resp.ok).toBe(true);
    const { managed } = await resp.json();
    const session = managed.find(s => s.id === sessionId);

    expect(session).toBeDefined();
    expect(session.lastLine).toBeTruthy();

    // Must not contain raw ANSI escape sequences
    expect(session.lastLine).not.toMatch(/\x1b/);
    expect(session.lastLine).not.toMatch(/\\x1b/);
    expect(session.lastLine).not.toMatch(/\\u001b/);

    // Should contain the visible text content
    expect(session.lastLine).toContain('green_text_marker');
  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
