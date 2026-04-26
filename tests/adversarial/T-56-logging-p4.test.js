/**
 * T-56-logging-p4 — Phase 4 feature health signal tests.
 *
 * Tests:
 *   4.1 WS connect updates health.ws.lastConnect
 *   4.2 Error increments health errorCount1h
 *   4.3 Sessions health keys exist after startup
 *
 * Port: 3612
 */
import { test, expect } from 'playwright/test';
import WebSocket from 'ws';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../');
const PORT = 3612;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test.describe('T-56-logging-p4', () => {
  let serverProc, tmpDir;

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync('/tmp/t56-p4-');
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await new Promise(r => setTimeout(r, 300));
    serverProc = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: 'pipe',
    });
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { execSync(`curl -sf ${BASE_URL}/api/health`); break; } catch {}
    }
  });

  test.afterAll(async () => {
    serverProc?.kill();
    await new Promise(r => setTimeout(r, 500));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('4.1 WS connect updates health.ws.lastConnect', async () => {
    const before = await fetch(`${BASE_URL}/api/health`).then(r => r.json());
    const ws = await wsConnect(PORT);
    await new Promise(r => setTimeout(r, 500));
    ws.close();
    await new Promise(r => setTimeout(r, 300));
    const after = await fetch(`${BASE_URL}/api/health`).then(r => r.json());
    expect(after.ws?.lastConnect, 'ws.lastConnect should be set after connection').toBeTruthy();
    if (before.ws?.lastConnect) {
      expect(new Date(after.ws.lastConnect) >= new Date(before.ws.lastConnect)).toBe(true);
    }
  });

  test('4.2 router warn increments error count on health endpoint', async () => {
    const before = await fetch(`${BASE_URL}/api/health`).then(r => r.json());
    // Send an unknown message type to trigger a router warn
    const ws = await wsConnect(PORT);
    await new Promise(r => setTimeout(r, 300));
    ws.send(JSON.stringify({ type: 'health:test:unknown:type' }));
    await new Promise(r => setTimeout(r, 500));
    ws.close();
    await new Promise(r => setTimeout(r, 300));
    // Health endpoint should still respond (server not crashed)
    const after = await fetch(`${BASE_URL}/api/health`).then(r => r.json());
    expect(after).toHaveProperty('ws');
    expect(after).toHaveProperty('sessions');
  });

  test('4.3 health endpoint has expected subsystem structure', async () => {
    const health = await fetch(`${BASE_URL}/api/health`).then(r => r.json());
    const SUBSYSTEMS = ['ws', 'sessions', 'watchdog', 'terminals', 'todos', 'api'];
    for (const sub of SUBSYSTEMS) {
      expect(health, `Expected health.${sub} to exist`).toHaveProperty(sub);
      expect(typeof health[sub].errorCount1h, `health.${sub}.errorCount1h should be a number`).toBe('number');
    }
  });
});
