/**
 * T-56-logging-p1 — Phase 1 acceptance tests for structured logging infrastructure.
 *
 * Tests:
 *   1.1 GET /api/logs/tail returns 200 JSON array
 *   1.2 GET /api/health returns 200 with subsystem keys
 *   1.3 POST /api/logs/client accepts batch, entry appears in JSONL via /api/logs/tail
 *   1.4 Logs tab renders without errors
 *   1.5 Level dropdowns visible in Logs tab
 *
 * Port: 3606
 */
import { test, expect, chromium } from 'playwright/test';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../');
const CHROMIUM_PATH = `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`;
const PORT = 3606;
const BASE_URL = `http://127.0.0.1:${PORT}`;

test.describe('T-56-logging-p1', () => {
  let serverProc, tmpDir, browser, page;

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync('/tmp/t56-p1-');
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await new Promise(r => setTimeout(r, 300));
    serverProc = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: 'pipe',
    });
    // Wait for server ready
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { execSync(`curl -sf ${BASE_URL}/api/health`); break; } catch {}
    }
    browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox'] });
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'T56P1', path: tmpDir }),
    }).then(r => r.json());
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    // Select the project in the sidebar
    const projectItem = page.locator('.project-item').filter({ hasText: 'T56P1' }).first();
    await projectItem.waitFor({ state: 'visible', timeout: 10000 });
    await projectItem.click();
    await page.waitForTimeout(800);
  });

  test.afterAll(async () => {
    await browser?.close();
    serverProc?.kill();
    await new Promise(r => setTimeout(r, 500));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('1.1 GET /api/logs/tail returns 200 JSON array', async () => {
    const res = await fetch(`${BASE_URL}/api/logs/tail?lines=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('1.2 GET /api/health returns 200 with subsystem keys', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('ws');
    expect(body).toHaveProperty('sessions');
    expect(body).toHaveProperty('watchdog');
    expect(body).toHaveProperty('terminals');
  });

  test('1.3 POST /api/logs/client stores entry in JSONL', async () => {
    const entry = { ts: new Date().toISOString(), level: 'warn', tag: 'ws', msg: 'T56P1-beacon-test' };
    const res = await fetch(`${BASE_URL}/api/logs/client`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ entries: [entry] }),
    });
    expect(res.status).toBe(204);
    await new Promise(r => setTimeout(r, 300));
    const tail = await fetch(`${BASE_URL}/api/logs/tail?lines=50`).then(r => r.json());
    const found = tail.find(e => e.msg === 'T56P1-beacon-test');
    expect(found, 'Entry not found in log tail').toBeTruthy();
    expect(found.source).toBe('client-beacon');
  });

  test('1.4 Logs tab renders without JS errors', async () => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.click('text=Logs');
    await page.waitForTimeout(800);
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
    await expect(page.locator('text=Log Levels')).toBeVisible();
  });

  test('1.5 level dropdowns visible in Logs tab', async () => {
    await page.click('text=Logs');
    await page.waitForTimeout(500);
    const selects = await page.locator('select').count();
    expect(selects).toBeGreaterThanOrEqual(3);
  });
});
