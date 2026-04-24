/**
 * T-2: Lifecycle log created with all required fields on session create (telegram ON path)
 * Port: 3361
 * Type: WS + filesystem
 *
 * Pass condition: All 8 field assertions match on the created entry.
 * Fail signal: File missing; channelId null when telegram=true; Promise leaked; summary null.
 */

import { test, expect } from '@jest/globals';
import { spawn, execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3361;
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

test('T-2: Lifecycle log created with all required fields (telegram ON)', async () => {
  const dataDir = `/tmp/qa-T2-lifecycle-created-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });

  // Seed settings with telegramChatId
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ telegramChatId: 'tg-chat-test-42' }));

  // Seed project
  const projPath = join(dataDir, 'proj-dir');
  mkdirSync(projPath, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'proj-t2', name: 'T2-Project', path: projPath }],
    scratchpad: []
  }));

  const server = startServer(dataDir);
  server.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  server.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

  try {
    await waitForServer(PORT);
    console.log(`  [T-2] Server ready`);

    // Open WS and create session with telegram: true
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
            projectId: 'proj-t2',
            name: 'lifecycle-test',
            mode: 'direct',
            command: 'bash',
            telegram: true,
          }));
        }
        if (msg.type === 'session:created') {
          clearTimeout(timer);
          ws.close();
          resolve({ sessionId: msg.session.id, session: msg.session });
        }
      });
      ws.on('error', err => { clearTimeout(timer); reject(err); });
    });

    console.log(`  [T-2] Session created: ${sessionId}`);

    // Wait for lifecycle file to be written
    const lifecycleFile = join(dataDir, 'session-lifecycle.json');
    const log = await pollFile(lifecycleFile, 3000);

    // AC9: file exists
    expect(log).not.toBeNull(); // 'session-lifecycle.json must exist after session:create'
    console.log(`  [T-2] Lifecycle log found with ${log.length} entries`);

    // Exactly one entry
    expect(log.length).toBe(1); // 'Lifecycle log must contain exactly one entry after create'

    const entry = log[0];
    console.log(`  [T-2] Entry: ${JSON.stringify(entry, null, 2)}`);

    // event === 'created'
    expect(entry.event).toBe('created');

    // sessionId matches
    expect(entry.sessionId).toBe(sessionId);

    // summary === 'lifecycle-test' (name fallback — cardSummary not set yet)
    expect(typeof entry.summary).toBe('string');
    expect(entry.summary).toBe('lifecycle-test');

    // channelId === 'tg-chat-test-42' (telegram=true path, Risk 4)
    expect(entry.channelId).toBe('tg-chat-test-42'); // 'must be tg-chat-test-42 when telegram=true'
    // Guard against Promise leaking as object
    expect(typeof entry.channelId).toBe('string'); // 'channelId must be string, not a Promise leak'

    // projectId
    expect(entry.projectId).toBe('proj-t2');

    // projectName
    expect(entry.projectName).toBe('T2-Project');

    // tmuxName field must exist (may be null)
    expect('tmuxName' in entry).toBe(true);

    // claudeSessionId field must exist (may be null in bash mode)
    expect('claudeSessionId' in entry).toBe(true);

    console.log('\n  [T-2] PASSED — all 8 field assertions matched');

  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    server.kill('SIGKILL');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  }
}, 45000);
