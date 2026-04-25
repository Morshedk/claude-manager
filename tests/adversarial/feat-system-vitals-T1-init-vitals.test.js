/**
 * T-1: Init message delivers vitals on connection
 * T-5: REST endpoint /api/watchdog/state includes vitals
 * T-2: Watchdog tick broadcasts vitals
 *
 * Combined WS protocol + REST tests for system vitals feature.
 * Run: npx playwright test tests/adversarial/feat-system-vitals-T1-init-vitals.test.js
 */

import { test, expect } from 'playwright/test';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.join(__dirname, '../..');

const VITALS_FIELDS = ['cpuPct', 'memUsedMb', 'memTotalMb', 'memPct', 'diskPct', 'uptimeS', 'timestamp'];

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-feat-'));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects: [], scratchpad: [] }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({}));
  return dir;
}

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const server = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        CRASH_LOG: path.join(dataDir, 'crash.log'),
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) { server.kill(); reject(new Error('Server start timeout')); }
    }, 15000);

    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on') && !started) {
        started = true;
        clearTimeout(timeout);
        resolve(server);
      }
    });

    server.stderr.on('data', () => {});
    server.on('error', (err) => {
      if (!started) { clearTimeout(timeout); reject(err); }
    });
  });
}

function killServer(server) {
  if (!server) return;
  server.kill('SIGTERM');
  setTimeout(() => { try { server.kill('SIGKILL'); } catch {} }, 1000);
}

function waitForWsMessage(port, typePredicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for WS message`));
    }, timeoutMs);

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (typePredicate(parsed)) {
        clearTimeout(timeout);
        ws.close();
        resolve(parsed);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── T-1: Init message delivers vitals on connection ─────────────────────────

test.describe('T-1: Init message delivers vitals on connection', () => {
  let server;
  let dataDir;
  const PORT = 3200;

  test.beforeAll(async () => {
    dataDir = makeDataDir();
    server = await startServer(PORT, dataDir);
  });

  test.afterAll(async () => {
    killServer(server);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  test('init message contains vitals with all 7 required fields', async () => {
    const msg = await waitForWsMessage(PORT, m => m.type === 'init');

    expect(msg.type).toBe('init');
    expect(msg.clientId).toBeTruthy();

    // Vitals must be a non-null object
    expect(msg.vitals).toBeTruthy();
    expect(typeof msg.vitals).toBe('object');

    // All 7 fields present with correct types
    for (const field of VITALS_FIELDS) {
      expect(msg.vitals[field]).toBeDefined();
    }

    expect(typeof msg.vitals.cpuPct).toBe('number');
    expect(typeof msg.vitals.memUsedMb).toBe('number');
    expect(typeof msg.vitals.memTotalMb).toBe('number');
    expect(typeof msg.vitals.memPct).toBe('number');
    expect(typeof msg.vitals.diskPct).toBe('number');
    expect(typeof msg.vitals.uptimeS).toBe('number');
    expect(typeof msg.vitals.timestamp).toBe('string');

    // Memory must be positive and consistent
    expect(msg.vitals.memUsedMb).toBeGreaterThan(0);
    expect(msg.vitals.memTotalMb).toBeGreaterThan(0);
    expect(msg.vitals.memUsedMb).toBeLessThanOrEqual(msg.vitals.memTotalMb);
    expect(msg.vitals.memPct).toBeGreaterThanOrEqual(0);
    expect(msg.vitals.memPct).toBeLessThanOrEqual(100);

    // Timestamp is valid ISO
    expect(new Date(msg.vitals.timestamp).toISOString()).toBe(msg.vitals.timestamp);
  });
});

// ── T-5: REST endpoint /api/watchdog/state includes vitals ──────────────────

test.describe('T-5: REST endpoint includes vitals', () => {
  let server;
  let dataDir;
  const PORT = 3204;

  test.beforeAll(async () => {
    dataDir = makeDataDir();
    server = await startServer(PORT, dataDir);
  });

  test.afterAll(async () => {
    killServer(server);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  test('GET /api/watchdog/state returns vitals object', async ({ request }) => {
    const res = await request.get(`http://127.0.0.1:${PORT}/api/watchdog/state`);
    expect(res.ok()).toBeTruthy();

    const data = await res.json();
    expect(data.vitals).toBeTruthy();
    expect(typeof data.vitals).toBe('object');

    for (const field of VITALS_FIELDS) {
      expect(data.vitals[field]).toBeDefined();
    }

    expect(typeof data.vitals.cpuPct).toBe('number');
    expect(data.vitals.memTotalMb).toBeGreaterThan(0);
    expect(data.vitals.memUsedMb).toBeGreaterThan(0);
  });
});

// ── T-2: Watchdog tick broadcasts vitals ─────────────────────────────────────

test.describe('T-2: Watchdog tick broadcasts vitals', () => {
  let server;
  let dataDir;
  const PORT = 3201;

  test.beforeAll(async () => {
    dataDir = makeDataDir();
    server = await startServer(PORT, dataDir);
  });

  test.afterAll(async () => {
    killServer(server);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  test('watchdog:tick message contains vitals', async () => {
    // Default tick is 30s, and the tick itself can take 30-60s (ccusage, summaries, etc.)
    // Wait up to 120s
    const msg = await waitForWsMessage(PORT, m => m.type === 'watchdog:tick', 120000);

    expect(msg.type).toBe('watchdog:tick');
    expect(typeof msg.count).toBe('number');
    expect(msg.count).toBeGreaterThanOrEqual(1);

    // Vitals must be present
    expect(msg.vitals).toBeTruthy();
    expect(typeof msg.vitals).toBe('object');

    for (const field of VITALS_FIELDS) {
      expect(msg.vitals[field]).toBeDefined();
    }

    // Timestamp must be recent
    const ageMs = Date.now() - new Date(msg.vitals.timestamp).getTime();
    expect(ageMs).toBeLessThan(60000);
    expect(ageMs).toBeGreaterThanOrEqual(0);
  });
});
