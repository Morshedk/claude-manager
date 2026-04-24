/**
 * T-4: Settings change (previewLines count) takes effect on next sweep
 * Port: 3503
 * Type: WS protocol + REST
 */

import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3503;
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

async function getSessionPreviewLines(port, sessionId) {
  const resp = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  const { managed } = await resp.json();
  const session = managed.find(s => s.id === sessionId);
  return session?.previewLines ?? null;
}

test('T-4: previewLines count changes when settings updated mid-run', async () => {
  const dataDir = `/tmp/feat-portrait-T4-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  try {
    await waitForServer(PORT);

    // Phase 1: Create session and send 40+ lines of output
    const sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 15000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-test-1',
            name: 'T4-settings',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          const id = msg.session.id;
          ws.send(JSON.stringify({ type: 'session:subscribe', id }));
        }
        if (msg.type === 'session:subscribed') {
          const id = msg.id;
          // Send a for loop producing 40 lines
          const cmd = 'for i in $(seq 1 40); do echo "LINE_$i"; done\n';
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'session:input', id, data: cmd }));
          }, 500);
          setTimeout(() => {
            clearTimeout(t);
            ws.close();
            resolve(id);
          }, 1500);
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`  [T-4] Session: ${sessionId}, waiting 25s for first preview sweep...`);

    // Phase 2: Wait 25s for first sweep (default 20s interval)
    await new Promise(r => setTimeout(r, 25000));

    const previewBefore = await getSessionPreviewLines(PORT, sessionId);
    console.log(`  [T-4] previewLines count before setting change: ${previewBefore?.length ?? 'null'}`);

    expect(Array.isArray(previewBefore)).toBe(true);
    expect(previewBefore.length).toBeGreaterThan(0);
    // Default previewLines is 20, so count should be <= 20
    expect(previewBefore.length).toBeLessThanOrEqual(20);

    // Phase 3: Change previewLines setting to 10
    const settingsResp = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewLines: 10 })
    });
    expect(settingsResp.ok).toBe(true);
    const newSettings = await settingsResp.json();
    console.log(`  [T-4] Settings response previewLines: ${newSettings.previewLines}`);
    expect(newSettings.previewLines).toBe(10);

    console.log('  [T-4] Settings changed to previewLines=10, waiting 25s for next sweep...');

    // Phase 4: Wait another 25s for next sweep
    await new Promise(r => setTimeout(r, 25000));

    const previewAfter = await getSessionPreviewLines(PORT, sessionId);
    console.log(`  [T-4] previewLines count after setting change: ${previewAfter?.length ?? 'null'}`);

    expect(Array.isArray(previewAfter)).toBe(true);
    expect(previewAfter.length).toBeGreaterThan(0);
    // After setting to 10, count should be <= 10
    expect(previewAfter.length).toBeLessThanOrEqual(10);

    console.log('  [T-4] PASS: previewLines count reduced after settings change');
  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 80000);
