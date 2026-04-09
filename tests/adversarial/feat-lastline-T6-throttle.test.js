/**
 * T-6: Throttle — rapid output triggers bounded broadcasts
 * Port: 3205
 */
import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3205;
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

test('T-6: rapid output triggers bounded (debounced) sessions:list broadcasts', async () => {
  const dataDir = `/tmp/feat-lastline-T6-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  try {
    await waitForServer(PORT);

    let sessionId = null;
    let echoPhaseStart = null;
    const sessionListTimestamps = [];

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      let echoSent = false;
      let echosSent = 0;

      const outerTimeout = setTimeout(() => {
        resolve();
        ws.close();
      }, 7000);

      ws.on('message', async (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'sessions:list' && echoSent && sessionId) {
          const session = msg.sessions.find(s => s.id === sessionId);
          // Only count broadcasts that have a lastLine (i.e. triggered by lastLine changes)
          if (session?.lastLine) {
            sessionListTimestamps.push(Date.now());
          }
        }

        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-1',
            name: 'T6-throttle-test',
            command: 'bash',
            mode: 'direct'
          }));
        }

        if (msg.type === 'session:created') {
          sessionId = msg.session.id;
          // Wait for bash to settle
          await new Promise(r => setTimeout(r, 400));

          echoSent = true;
          echoPhaseStart = Date.now();

          // Send 20 echo commands with 50ms gaps (total ~1s of rapid output)
          for (let i = 1; i <= 20; i++) {
            ws.send(JSON.stringify({
              type: 'session:input',
              id: sessionId,
              data: `echo rapid_line_${i}\n`
            }));
            await new Promise(r => setTimeout(r, 50));
          }

          // Wait for debounce to settle
          setTimeout(() => {
            resolve();
            ws.close();
            clearTimeout(outerTimeout);
          }, 1500);
        }
      });
      ws.on('error', reject);
    });

    const totalWindow = Date.now() - (echoPhaseStart || Date.now());
    console.log(`[T-6] sessions:list broadcasts with lastLine during echo phase: ${sessionListTimestamps.length}`);
    console.log(`[T-6] Window: ~${totalWindow}ms`);

    // With 500ms debounce, 1s of rapid output should produce at most 4-5 broadcasts
    // (not 20 — one per line)
    expect(sessionListTimestamps.length).toBeGreaterThan(0); // At least some fired
    expect(sessionListTimestamps.length).toBeLessThan(8);    // Definitely fewer than 20 (throttled)
  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
