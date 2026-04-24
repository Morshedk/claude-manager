/**
 * T-2: Preview lines update after PTY output (25s wait)
 * Port: 3501
 * Type: WS protocol
 */

import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3501;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';

function seedDataDir(dir) {
  mkdirSync(dir, { recursive: true });
  mkdirSync('/tmp/test-project', { recursive: true }); // ensure project path exists
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'proj-test-1', name: 'Test Project', path: '/tmp/test-project' }],
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
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server did not start on port ${port} within ${timeoutMs}ms`);
}

test('T-2: previewLines contains marker after PTY output + 25s wait', async () => {
  const dataDir = `/tmp/feat-portrait-T2-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  try {
    await waitForServer(PORT);

    // Phase 1: Create session, subscribe, send input
    const sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout in setup')); }, 15000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-test-1',
            name: 'T2-preview',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          const id = msg.session.id;
          // Subscribe
          ws.send(JSON.stringify({ type: 'session:subscribe', id }));
        }
        if (msg.type === 'session:subscribed') {
          const id = msg.id;
          // Send distinctive marker
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'session:input',
              id,
              data: 'echo PREVIEW_MARKER_T2_UNIQUE_12345\n'
            }));
          }, 500);
          setTimeout(() => {
            clearTimeout(t);
            ws.close();
            resolve(id);
          }, 1000);
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`  [T-2] Session: ${sessionId}, sent marker, waiting 25s for preview interval...`);

    // Phase 2: Wait 25 seconds for preview sweep (interval=20s, +5s margin)
    await new Promise(r => setTimeout(r, 25000));

    // Phase 3: Poll REST API for previewLines
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/sessions`);
    expect(resp.ok).toBe(true);
    const { managed } = await resp.json();
    const session = managed.find(s => s.id === sessionId);

    console.log(`  [T-2] Session found: ${!!session}`);
    if (session) {
      console.log(`  [T-2] previewLines: ${JSON.stringify(session.previewLines?.slice(0, 5))}`);
    }

    expect(session).toBeDefined();
    expect(Array.isArray(session.previewLines)).toBe(true);
    expect(session.previewLines.length).toBeGreaterThan(0);

    const hasMarker = session.previewLines.some(line =>
      typeof line === 'string' && line.includes('PREVIEW_MARKER_T2_UNIQUE_12345')
    );
    expect(hasMarker).toBe(true);
    console.log('  [T-2] Marker found in previewLines — PASS');
  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 40000);
