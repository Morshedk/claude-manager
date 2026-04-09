/**
 * feat-split-screen-ux T-1: Path dropdown shows existing project paths
 *
 * Pass condition:
 *   - #project-paths-datalist contains options for both project paths AND parent dir
 *   - At least 3 unique options present
 *
 * Port: 3300
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3300;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-split-screen-ux T-1 — Path dropdown shows existing project paths', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-T1-XXXXXX').toString().trim();
    console.log(`\n  [T-1] tmpDir: ${tmpDir}`);

    // Seed with empty projects (we'll create via REST)
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({ projects: [], scratchpad: [] }));
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([]));

    // Create real directories for path validation
    const alphaPath = path.join(tmpDir, 'services', 'alpha');
    const betaPath = path.join(tmpDir, 'services', 'beta');
    fs.mkdirSync(alphaPath, { recursive: true });
    fs.mkdirSync(betaPath, { recursive: true });

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

    // Create two projects via REST (paths must exist on disk)
    const alpha = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha', path: alphaPath }),
    }).then(r => r.json());
    console.log('  [T-1] Alpha project:', alpha.id, 'path:', alphaPath);

    const beta = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beta', path: betaPath }),
    }).then(r => r.json());
    console.log('  [T-1] Beta project:', beta.id, 'path:', betaPath);

    // Store paths for assertions (in test scope)
    process.env._T1_ALPHA_PATH = alphaPath;
    process.env._T1_BETA_PATH = betaPath;
    process.env._T1_PARENT_PATH = path.dirname(alphaPath);

    console.log('  [T-1] Server ready, projects created');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill('SIGTERM'); await sleep(500); serverProc.kill('SIGKILL'); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('datalist contains paths for both projects and parent directory', async () => {
    test.setTimeout(60000);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [browser:err] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.setViewportSize({ width: 1280, height: 800 });

      // Wait for projects to appear in sidebar (WS init received) — both Alpha and Beta should show
      await page.waitForFunction(
        () => document.body.textContent.includes('Alpha') && document.body.textContent.includes('Beta'),
        { timeout: 20000 }
      );
      console.log('  [T-1] Projects loaded in sidebar');

      // Click the New Project button (button with text "New Project" or "+" in sidebar)
      const newProjBtn = page.locator('button', { hasText: 'New Project' }).first();
      await expect(newProjBtn).toBeVisible({ timeout: 15000 });
      await newProjBtn.click();
      console.log('  [T-1] Clicked New Project button');

      // Wait for modal to appear
      await page.waitForSelector('#new-project-path', { timeout: 10000 });
      console.log('  [T-1] New project modal open, path input found');

      // Focus the path input
      await page.focus('#new-project-path');
      await sleep(500);

      // Check datalist options
      const datalistOptions = await page.evaluate(() => {
        const datalist = document.getElementById('project-paths-datalist');
        if (!datalist) return { found: false, options: [] };
        const options = Array.from(datalist.querySelectorAll('option')).map(o => o.value || o.getAttribute('value'));
        return { found: true, options };
      });

      console.log('  [T-1] Datalist found:', datalistOptions.found);
      console.log('  [T-1] Datalist options:', JSON.stringify(datalistOptions.options));

      const alphaPath = process.env._T1_ALPHA_PATH;
      const betaPath = process.env._T1_BETA_PATH;
      const parentPath = process.env._T1_PARENT_PATH;

      expect(datalistOptions.found, '#project-paths-datalist element must exist').toBe(true);
      expect(datalistOptions.options.length, 'Datalist must have at least 3 options').toBeGreaterThanOrEqual(3);
      expect(datalistOptions.options, `Must contain ${alphaPath}`).toContain(alphaPath);
      expect(datalistOptions.options, `Must contain ${betaPath}`).toContain(betaPath);
      expect(datalistOptions.options, `Must contain parent dir ${parentPath}`).toContain(parentPath);

      // Type into path input and verify datalist still populated
      await page.fill('#new-project-path', parentPath + '/');
      await sleep(300);

      const afterTypeOptions = await page.evaluate(() => {
        const datalist = document.getElementById('project-paths-datalist');
        if (!datalist) return [];
        return Array.from(datalist.querySelectorAll('option')).map(o => o.value || o.getAttribute('value'));
      });
      console.log('  [T-1] Options after typing:', JSON.stringify(afterTypeOptions));
      expect(afterTypeOptions, 'Datalist options must remain after typing').toContain(alphaPath);
      expect(afterTypeOptions, 'Datalist options must remain after typing').toContain(betaPath);

      console.log('  [T-1] PASS — datalist contains correct paths and parent directory');

    } finally {
      await browser.close();
    }
  });
});
