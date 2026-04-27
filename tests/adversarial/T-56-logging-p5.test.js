/**
 * T-56-logging-p5 — TopBar health dots tests.
 *
 * Tests:
 *   5.1 Health dots render in TopBar after page load
 *   5.2 All four subsystem dots visible (WS, Sessions, Watchdog, Terminals)
 *   5.3 Dots have tooltips with subsystem names
 *
 * Port: 3614
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
const PORT = 3614;
const BASE_URL = `http://127.0.0.1:${PORT}`;

test.describe('T-56-logging-p5', () => {
  let serverProc, tmpDir, browser, page;

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync('/tmp/t56-p5-');
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
    await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'T56P5', path: tmpDir }),
    });
    browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.goto(BASE_URL);
    // Wait for health state to load (first fetch happens on WS init)
    await page.waitForTimeout(3000);
    // Click into a project if needed
    const projectItem = page.locator('.project-item, [data-project-id]').first();
    if (await projectItem.isVisible()) {
      await projectItem.click();
      await page.waitForTimeout(1500);
    }
  });

  test.afterAll(async () => {
    await browser?.close();
    serverProc?.kill();
    await new Promise(r => setTimeout(r, 500));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('5.1 health dots render in TopBar', async () => {
    // Dots have title attributes with subsystem names
    const dots = await page.locator('[title*="WS"], [title*="Sessions"], [title*="Watchdog"], [title*="Terminals"]').count();
    expect(dots, 'Expected at least 3 health dots with subsystem titles').toBeGreaterThanOrEqual(3);
  });

  test('5.2 all four subsystem dots visible', async () => {
    const subsystems = ['WS', 'Sessions', 'Watchdog', 'Terminals'];
    for (const sub of subsystems) {
      const dot = page.locator(`[title*="${sub}"]`).first();
      await expect(dot, `${sub} dot should be visible`).toBeVisible();
    }
  });

  test('5.3 dots are small circular elements in TopBar', async () => {
    // Verify at least one dot exists with the right style (7px circle)
    const wsDot = page.locator('[title*="WS"]').first();
    await expect(wsDot).toBeVisible();
    // Check bounding box is approximately 7px
    const box = await wsDot.boundingBox();
    expect(box, 'WS dot should have a bounding box').toBeTruthy();
    expect(box.width).toBeLessThanOrEqual(20);
    expect(box.height).toBeLessThanOrEqual(20);
  });
});
