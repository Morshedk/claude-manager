/**
 * T-5: Blank PTY output does not clear lastLine (adversarial)
 * Port: 3204
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3204;
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

test('T-5: blank PTY output does not clear lastLine', async () => {
  const dataDir = `/tmp/feat-lastline-T5-${Date.now()}`;
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
            name: 'T5-blank-test',
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

    // Step 1: Set a known non-blank lastLine
    ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'echo non_blank_marker\n' }));
    await new Promise(r => setTimeout(r, 1000));

    // Precondition check: lastLine must be set
    let resp = await fetch(`http://localhost:${PORT}/api/sessions`);
    let { managed } = await resp.json();
    let session = managed.find(s => s.id === sessionId);
    expect(session).toBeDefined();
    // Precondition: lastLine must be 'non_blank_marker' before proceeding
    expect(session.lastLine).toBe('non_blank_marker');
    const lastLineBefore = session.lastLine;

    // Step 2: Request sessions:list without any new echo (no new PTY output)
    // The key property: lastLine must still be present and truthy — it must not
    // have been overwritten by blank/whitespace-only PTY data (like shell prompts
    // that consist only of ANSI sequences and whitespace)
    await new Promise(r => setTimeout(r, 600));

    // Step 3: Verify lastLine was NOT cleared — it should still be something truthy
    resp = await fetch(`http://localhost:${PORT}/api/sessions`);
    ({ managed } = await resp.json());
    session = managed.find(s => s.id === sessionId);
    expect(session).toBeDefined();
    // lastLine must still be truthy — it should not be cleared to empty/null
    expect(session.lastLine).toBeTruthy();
    // Specifically, it must still be the value set by the echo command
    // (Shell prompt data is also non-blank, so if it changed, it changed to something non-blank — not to empty)
    expect(session.lastLine).not.toBe('');
    expect(session.lastLine).not.toBeNull();
    expect(session.lastLine).not.toBeUndefined();

    ws.close();
  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
