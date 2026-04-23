/**
 * T-9: telegram=false → channelId === null in lifecycle log (H2)
 * Port: 3369
 * Type: WS + filesystem (real server)
 *
 * Pass condition:
 *   - Session created with no telegramChatId in settings (telegram disabled)
 *   - lifecycle log entry has channelId === null (not a string, not a Promise)
 *
 * Defect this catches:
 *   A bug that hard-coded channelId = 'tg-chat-test-42' for all sessions, or
 *   returned Promise.resolve(null) instead of null, would fail this assertion.
 *   Closes H2: Risk 4 demanded two cases (ON and OFF); T-2 covers ON, this covers OFF.
 */

import { test, expect } from '@jest/globals';
import { spawn, execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3369;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer(dataDir) {
  const crashLog = join(dataDir, 'crash.log');
  return spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CRASH_LOG: crashLog },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/sessions`);
      if (res.ok) return true;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Server did not start on port ${port} within ${timeoutMs}ms`);
}

async function pollFile(filePath, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf8');
        const arr = JSON.parse(content);
        if (Array.isArray(arr) && arr.length > 0) return arr;
      } catch {}
    }
    await sleep(100);
  }
  return null;
}

test('T-9: telegram=false → channelId is null in lifecycle log (H2)', async () => {
  const dataDir = `/tmp/qa-T9-channelid-null-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });

  // Settings WITHOUT telegramChatId — telegram is not configured
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({}));

  // Seed project
  const projPath = join(dataDir, 'proj-dir');
  mkdirSync(projPath, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'proj-t9', name: 'T9-Project', path: projPath }],
    scratchpad: []
  }));

  const server = startServer(dataDir);
  server.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  server.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

  try {
    await waitForServer(PORT);
    console.log(`  [T-9] Server ready`);

    // Create session with telegram NOT enabled (no telegram:true in message)
    const { sessionId } = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for session:created'));
      }, 15000);

      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-t9',
            name: 'no-telegram-session',
            mode: 'direct',
            command: 'bash',
            // telegram field intentionally omitted — defaults to false in sessionHandlers
          }));
        }
        if (msg.type === 'session:created') {
          clearTimeout(timer);
          ws.close();
          resolve({ sessionId: msg.session.id });
        }
      });
      ws.on('error', err => { clearTimeout(timer); reject(err); });
    });

    console.log(`  [T-9] Session created: ${sessionId}`);

    // Wait for lifecycle file to be written
    const lifecycleFile = join(dataDir, 'session-lifecycle.json');
    const log = await pollFile(lifecycleFile, 3000);

    expect(log).not.toBeNull(); // 'session-lifecycle.json must exist after session:create'
    expect(log.length).toBe(1);

    const entry = log[0];
    console.log(`  [T-9] Entry: ${JSON.stringify(entry)}`);

    // Primary assertion: channelId must be null when telegram is not enabled
    expect(entry.channelId).toBeNull(); // 'channelId must be null when telegram=false'

    // Guard against Promise leak: null is not an object
    expect(typeof entry.channelId === 'object' && entry.channelId !== null).toBe(false);

    // Confirm it is specifically null (not undefined, not '', not 0)
    expect(entry.channelId).toBe(null);

    // Other fields sanity-check
    expect(entry.event).toBe('created');
    expect(entry.sessionId).toBe(sessionId);
    expect(entry.summary).toBe('no-telegram-session'); // name fallback (no cardSummary)

    console.log('\n  [T-9] PASSED — channelId is null when telegram is not enabled');

  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    server.kill('SIGKILL');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  }
}, 45000);
