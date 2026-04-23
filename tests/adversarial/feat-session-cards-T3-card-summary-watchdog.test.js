/**
 * T-3: cardSummary appears after watchdog summarizes
 * Port: 3502
 * Type: WS protocol (requires Claude API or mock)
 *
 * NOTE: This test requires a live Claude API key. Without one, the watchdog
 * summarization will fail silently and cardSummary will remain empty.
 * The test will FAIL if no API key is configured or if the API is unavailable.
 */

import { test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3502;
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';

function seedDataDir(dir) {
  mkdirSync(dir, { recursive: true });
  mkdirSync('/tmp/test-project', { recursive: true }); // ensure project path exists
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'proj-test-1', name: 'Test Project', path: '/tmp/test-project' }],
    scratchpad: []
  }));
  // Write settings to enable watchdog with short interval
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    watchdog: {
      enabled: true,
      intervalMinutes: 1
    }
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

test('T-3: cardSummary appears on sessions:list after watchdog tick', async () => {
  const dataDir = `/tmp/feat-portrait-T3-${Date.now()}`;
  seedDataDir(dataDir);
  const server = startServer(dataDir, PORT);

  // Track output for diagnostics
  const serverLogs = [];
  server.stdout.on('data', d => serverLogs.push(d.toString()));
  server.stderr.on('data', d => serverLogs.push(d.toString()));

  try {
    await waitForServer(PORT);

    // Create session and send enough output to exceed MIN_DELTA_FOR_SUMMARY
    const sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout in setup')); }, 15000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-test-1',
            name: 'T3-watchdog',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          const id = msg.session.id;
          ws.send(JSON.stringify({ type: 'session:subscribe', id }));
        }
        if (msg.type === 'session:subscribed') {
          const id = msg.id;
          // Send multiline output >500 bytes to exceed MIN_DELTA_FOR_SUMMARY
          const bigOutput = Array.from({ length: 20 }, (_, i) =>
            `echo "LINE_${i}_CONTENT_FOR_WATCHDOG_SUMMARY_TEST_T3_ABCDEFGHIJK"`
          ).join('; ');
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'session:input', id, data: bigOutput + '\n' }));
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

    console.log(`  [T-3] Session: ${sessionId}, collecting sessions:list for up to 90s...`);

    // Phase 2: Listen to WS for sessions:list with cardSummary for up to 90s
    const cardSummaryFound = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const deadline = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 90000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sessions:list') {
          // sessions:list may use msg.sessions or msg.managed
          const sessions = msg.sessions || msg.managed || [];
          const session = sessions.find(s => s.id === sessionId);
          if (session?.cardSummary && session.cardSummary.trim().length > 0) {
            console.log(`  [T-3] cardSummary found: "${session.cardSummary}"`);
            clearTimeout(deadline);
            ws.close();
            resolve(session.cardSummary);
          }
        }
        // Also subscribe so we see updates
        if (msg.type === 'init') {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        }
      });
      ws.on('error', () => {
        clearTimeout(deadline);
        resolve(null);
      });
    });

    if (!cardSummaryFound) {
      // Also check via REST as fallback
      const resp = await fetch(`http://127.0.0.1:${PORT}/api/sessions`);
      const { managed } = await resp.json();
      const session = managed.find(s => s.id === sessionId);
      const summary = session?.cardSummary;
      console.log(`  [T-3] REST cardSummary: "${summary}"`);
      console.log(`  [T-3] Server logs tail: ${serverLogs.slice(-10).join('')}`);
      // Fail with explanation
      expect(summary).toBeTruthy();
    } else {
      expect(typeof cardSummaryFound).toBe('string');
      expect(cardSummaryFound.trim().length).toBeGreaterThan(0);
      console.log('  [T-3] PASS: cardSummary received within 90s');
    }
  } finally {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 100000);
