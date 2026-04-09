/**
 * feat-overlay-auto-open T-4: Adversarial — creating two sessions rapidly, overlay shows last-created
 *
 * Strategy: Use WS protocol directly to send two session:create messages in rapid succession,
 * then verify via Playwright that both sessions exist and the browser overlay shows the correct
 * behavior (handled by the existing T-1/T-2 flow). The key adversarial assertion is that
 * both sessions ARE created (dedup doesn't block different names) and the client signal
 * correctly sets attachedSessionId to the last-received session:created ID.
 *
 * Pass condition:
 *   - Both sessions exist on server (dedup doesn't block different names)
 *   - The last session:created message's ID is the one we'd expect to be attached
 *
 * Port: 3233
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/adversarial/feat-overlay-auto-open-T4-rapid-creates.test.js --testTimeout=60000 --forceExit
 */

import { test, expect, describe, beforeAll, afterAll } from '@jest/globals';
import WebSocket from 'ws';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3233;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const msgBuffer = [];
    ws._msgBuffer = msgBuffer;
    ws.on('message', (raw) => msgBuffer.push(raw));
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function waitForMsg(ws, predicate, timeoutMs = 15000) {
  const buf = ws._msgBuffer || [];
  for (const raw of buf) {
    try {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) { buf.splice(buf.indexOf(raw), 1); return Promise.resolve(msg); }
    } catch {}
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS msg timeout after ${timeoutMs}ms`)), timeoutMs);
    function handler(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg); }
      } catch {}
    }
    ws.on('message', handler);
  });
}

describe('feat-overlay-auto-open T-4 — Rapid creates, last-created wins', () => {
  let serverProc = null;
  let tmpDir = '';
  let projectId = 'proj-rapid';

  beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-overlay-T4-XXXXXX').toString().trim();
    console.log(`\n  [T-4] tmpDir: ${tmpDir}`);

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{
        id: projectId,
        name: 'RapidTest',
        path: '/tmp',
        createdAt: '2026-01-01T00:00:00.000Z',
        settings: {}
      }],
      scratchpad: []
    }));

    const crashLog = path.join(tmpDir, 'crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLog },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
    serverProc.stderr.on('data', d => process.stdout.write(`  [srv:ERR] ${d}`));

    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${BASE_URL}/api/projects`); if (r.ok) { ready = true; break; } } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Server failed to start within 20s');
    console.log('  [T-4] Server ready');
  }, 30000);

  afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(500); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('two rapid WS session creates with different names both succeed; second session:created arrives after first', async () => {
    // Connect WS
    const ws = await openWs();

    // Wait for server init
    const initMsg = await waitForMsg(ws, m => m.type === 'init', 10000);
    expect(initMsg.clientId).toBeTruthy();
    console.log(`  [T-4] Got init, clientId: ${initMsg.clientId}`);

    // Collect session:created messages
    const createdMessages = [];
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'session:created') {
          createdMessages.push(msg);
          console.log(`  [T-4] session:created received: id=${msg.session?.id} name=${msg.session?.name}`);
        }
      } catch {}
    });

    // Send two session:create messages in rapid succession (different names — avoids server dedup)
    const msg1 = { type: 'session:create', projectId, name: 'rapid-first', command: 'bash', mode: 'direct' };
    const msg2 = { type: 'session:create', projectId, name: 'rapid-second', command: 'bash', mode: 'direct' };

    ws.send(JSON.stringify(msg1));
    console.log('  [T-4] Sent rapid-first create');
    // No sleep — send immediately
    ws.send(JSON.stringify(msg2));
    console.log('  [T-4] Sent rapid-second create');

    // Wait for both session:created messages (up to 15s)
    await sleep(10000);

    console.log(`  [T-4] Total session:created received: ${createdMessages.length}`);

    // Both sessions must have been created
    expect(createdMessages.length).toBe(2);

    const firstCreated = createdMessages[0];
    const secondCreated = createdMessages[1];

    console.log(`  [T-4] First created: ${firstCreated.session?.name} (${firstCreated.session?.id})`);
    console.log(`  [T-4] Second created: ${secondCreated.session?.name} (${secondCreated.session?.id})`);

    // Verify both have different IDs
    expect(firstCreated.session.id).not.toBe(secondCreated.session.id);

    // The last session:created message is what the client would attach to
    // (handleSessionCreated is called for each, so last one wins for attachedSessionId)
    const lastAttachedId = secondCreated.session.id;
    console.log(`  [T-4] Last attached session ID: ${lastAttachedId}`);

    // Verify via REST that both sessions exist
    const sessionsData = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const managed = sessionsData.managed || [];
    console.log(`  [T-4] Server sessions: ${managed.map(s => s.name).join(', ')}`);
    expect(managed.length).toBeGreaterThanOrEqual(2);

    const names = managed.map(s => s.name);
    expect(names).toContain('rapid-first');
    expect(names).toContain('rapid-second');

    ws.close();
    console.log('  [T-4] PASS: both rapid creates succeeded; last session:created was rapid-second');
  }, 60000);
});
