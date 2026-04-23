/**
 * T-3: Delete flow produces a 'deleted' entry with meta captured BEFORE delete (Risk 5 / G4)
 * Port: 3362
 * Type: WS + filesystem
 *
 * Pass condition:
 *   - Two log entries: created then deleted for same sessionId
 *   - deleted entry.claudeSessionId equals created entry.claudeSessionId
 *   - deleted entry.summary is non-empty string equal to session name
 *   - deleted entry.channelId === 'tg-chat-del-99'
 */

import { test, expect } from '@jest/globals';
import { spawn, execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3362;
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

async function pollFileForCount(filePath, count, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) {
      try {
        const arr = JSON.parse(readFileSync(filePath, 'utf8'));
        if (Array.isArray(arr) && arr.length >= count) return arr;
      } catch {}
    }
    await sleep(100);
  }
  // Return whatever is there
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
}

test('T-3: Deleted entry has meta captured BEFORE delete (Risk 5)', async () => {
  const dataDir = `/tmp/qa-T3-deleted-meta-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });

  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ telegramChatId: 'tg-chat-del-99' }));

  const projPath = join(dataDir, 'proj-dir');
  mkdirSync(projPath, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'proj-t3', name: 'T3-Project', path: projPath }],
    scratchpad: []
  }));

  const server = startServer(dataDir);
  server.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  server.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

  try {
    await waitForServer(PORT);
    console.log(`  [T-3] Server ready`);

    // Create session with telegram: true
    const sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('Timeout creating session')); }, 15000);
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-t3',
            name: 'to-delete',
            mode: 'direct',
            command: 'bash',
            telegram: true,
          }));
        }
        if (msg.type === 'session:created') {
          clearTimeout(timer);
          ws.close();
          resolve(msg.session.id);
        }
      });
      ws.on('error', err => { clearTimeout(timer); reject(err); });
    });

    console.log(`  [T-3] Session created: ${sessionId}`);

    // Wait for 'created' log entry
    const lifecycleFile = join(dataDir, 'session-lifecycle.json');
    const logAfterCreate = await pollFileForCount(lifecycleFile, 1, 3000);
    expect(logAfterCreate).not.toBeNull(); // 'Created entry must appear in lifecycle log'
    expect(logAfterCreate.length).toBe(1); // 'Should have exactly 1 entry after create'
    const createdEntry = logAfterCreate[0];
    console.log(`  [T-3] Created entry: ${JSON.stringify(createdEntry)}`);

    // Now send session:delete
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('Timeout waiting for sessions:list after delete')); }, 15000);
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        // Wait for sessions:list that no longer contains our session
        if (msg.type === 'sessions:list') {
          const found = (msg.sessions || []).find(s => s.id === sessionId);
          if (!found) {
            clearTimeout(timer);
            ws.close();
            resolve(true);
          }
        }
      });
      ws.on('open', () => {
        // Brief delay then send delete
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'session:delete', id: sessionId }));
        }, 200);
      });
      ws.on('error', err => { clearTimeout(timer); reject(err); });
    });

    console.log(`  [T-3] Delete acknowledged`);

    // Wait for deleted log entry
    const logAfterDelete = await pollFileForCount(lifecycleFile, 2, 4000);
    console.log(`  [T-3] Log after delete: ${JSON.stringify(logAfterDelete, null, 2)}`);

    expect(logAfterDelete).not.toBeNull(); // 'Lifecycle log must exist after delete'
    expect(logAfterDelete.length).toBe(2); // 'Should have exactly 2 entries (created + deleted)'

    const deletedEntry = logAfterDelete[1];

    // event === 'deleted'
    expect(deletedEntry.event).toBe('deleted');

    // sessionId matches
    expect(deletedEntry.sessionId).toBe(sessionId);

    // claudeSessionId identity preserved (proves meta was captured before deletion)
    // Both may be null (bash mode, no real claude), but they must MATCH
    expect(deletedEntry.claudeSessionId).toBe(createdEntry.claudeSessionId);

    // summary = name fallback (no cardSummary from watchdog in fast delete)
    expect(typeof deletedEntry.summary).toBe('string');
    expect(deletedEntry.summary.length).toBeGreaterThan(0); // 'summary must be non-empty'
    expect(deletedEntry.summary).toBe('to-delete');

    // channelId = tg-chat-del-99
    expect(deletedEntry.channelId).toBe('tg-chat-del-99');

    console.log('\n  [T-3] PASSED — deleted entry has correct meta (captured before delete)');

  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    server.kill('SIGKILL');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  }
}, 60000);
