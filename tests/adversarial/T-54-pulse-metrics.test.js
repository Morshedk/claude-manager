/**
 * T-54: Pulse (System Vitals) Metrics Display in TopBar
 *
 * Verify that the VitalsIndicator component renders correctly in the TopBar
 * after the WebSocket init message delivers vitals data from the server watchdog.
 *
 * Pass conditions:
 *   1. `.vitals-indicator` exists in the DOM
 *   2. Contains the "Pulse" label text
 *   3. Shows "CPU" label with a percentage value
 *   4. Shows "RAM" label with memory values (MB or GB)
 *   5. Shows "Disk" label with a percentage value
 *   6. Contains at least 3 micro progress bar elements (48px-wide divs)
 *   7. CPU percentage is in range 0-300 (multi-core systems can exceed 100%)
 *   8. Disk percentage is in range 0-100
 *   9. No "waiting..." text after vitals data arrives
 *
 * Ports: 3602 (direct), 3603 (tmux)
 *
 * Run (direct only):
 *   PORT=3602 npx playwright test tests/adversarial/T-54-pulse-metrics.test.js --reporter=line --timeout=180000 --grep direct
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = path.resolve(__dirname, '../../');
const PORTS = { direct: 3602, tmux: 3603 };
const MODES = ['direct', 'tmux'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROMIUM_PATH = `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`;

for (const MODE of MODES) {
test.describe(`T-54 [${MODE}] — Pulse metrics display in TopBar`, () => {
  const PORT = PORTS[MODE];
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `T-54-pulse-metrics-${MODE}`);

  let serverProc = null;
  let tmpDir = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-T54-XXXXXX').toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '[]');

    serverProc = spawn('node', ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Poll until server is ready
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        const r = await fetch(`${BASE_URL}/api/projects`, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) break;
      } catch {}
      await sleep(400);
    }

    // Create a project via API (matching T-52 pattern)
    const proj = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T54-Project', path: '/tmp' }),
    }).then(r => r.json());
    if (!proj.id) throw new Error(`Failed to create project: ${JSON.stringify(proj)}`);
  });

  test.afterAll(async () => {
    if (serverProc) { try { serverProc.kill(); } catch {} }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('vitals indicator shows CPU, RAM, Disk with micro bars', async () => {
    const browser = await chromium.launch({
      executablePath: fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    let snapN = 0;
    const snap = async (name) => {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${String(++snapN).padStart(2,'0')}-${name}.png`) });
    };

    try {
      // ── Navigate to the app ─────────────────────────────────────────────
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(600);
      await snap('app-loaded');

      // Wait for WS connection (status dot turns connected)
      await page.waitForSelector('.status-dot.connected', { timeout: 15000 });
      await snap('ws-connected');

      // ── 1. Assert .vitals-indicator exists ──────────────────────────────
      const vitalsEl = page.locator('.vitals-indicator');
      await vitalsEl.waitFor({ state: 'visible', timeout: 10000 });

      // ── 2. Wait for vitals data (no more "waiting...") ─────────────────
      // The WS init message includes vitals, and watchdog:tick broadcasts
      // periodically. Wait until "waiting..." disappears.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.vitals-indicator');
          if (!el) return false;
          return !el.textContent.includes('waiting...');
        },
        { timeout: 20000 }
      );
      await snap('vitals-loaded');

      // Grab the full text content once for assertions
      const vitalsText = await vitalsEl.textContent();

      // ── 3. Assert "Pulse" label ─────────────────────────────────────────
      expect(vitalsText, 'Must contain "Pulse" label').toContain('Pulse');

      // ── 4. Assert CPU label with percentage ─────────────────────────────
      expect(vitalsText, 'Must contain "CPU" label').toContain('CPU');
      const cpuMatch = vitalsText.match(/CPU[^%]*?(\d+)%/);
      expect(cpuMatch, 'CPU must show a percentage value').toBeTruthy();
      const cpuPct = parseInt(cpuMatch[1], 10);

      // ── 5. Assert RAM label with memory values ──────────────────────────
      expect(vitalsText, 'Must contain "RAM" label').toContain('RAM');
      // RAM format: "X.X GB/Y.Y GB" or "XXX MB/YYYY MB"
      const ramMatch = vitalsText.match(/RAM.*?(\d+(?:\.\d+)?)\s*(MB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(MB|GB)/);
      expect(ramMatch, 'RAM must show used/total memory values').toBeTruthy();

      // ── 6. Assert Disk label with percentage ────────────────────────────
      expect(vitalsText, 'Must contain "Disk" label').toContain('Disk');
      const diskMatch = vitalsText.match(/Disk[^%]*?(\d+)%/);
      expect(diskMatch, 'Disk must show a percentage value').toBeTruthy();
      const diskPct = parseInt(diskMatch[1], 10);

      // ── 7. Assert micro progress bar elements (48px wide) ───────────────
      const microBars = await page.evaluate(() => {
        const indicator = document.querySelector('.vitals-indicator');
        if (!indicator) return [];
        const allDivs = indicator.querySelectorAll('div');
        const bars = [];
        allDivs.forEach(div => {
          const style = div.style;
          if (style.width === '48px' && style.height === '6px') {
            const inner = div.querySelector('div');
            bars.push({
              outerWidth: style.width,
              outerHeight: style.height,
              innerWidth: inner ? inner.style.width : null,
              innerBackground: inner ? inner.style.background : null,
            });
          }
        });
        return bars;
      });

      expect(microBars.length,
        'Must have at least 3 MicroBar elements (CPU, RAM, Disk)'
      ).toBeGreaterThanOrEqual(3);

      // Each MicroBar must have an inner div with width and background
      for (let i = 0; i < microBars.length; i++) {
        expect(microBars[i].innerWidth, `MicroBar ${i} must have inner width`).toBeTruthy();
        expect(microBars[i].innerBackground, `MicroBar ${i} must have background color`).toBeTruthy();
      }

      // ── 8. Assert percentage values are reasonable ──────────────────────
      // CPU can exceed 100% on multi-core systems (e.g. 4 cores = up to 400%)
      expect(cpuPct, 'CPU % must be >= 0').toBeGreaterThanOrEqual(0);
      expect(cpuPct, 'CPU % must be <= 300 (multi-core ceiling)').toBeLessThanOrEqual(300);

      // Disk is always 0-100%
      expect(diskPct, 'Disk % must be >= 0').toBeGreaterThanOrEqual(0);
      expect(diskPct, 'Disk % must be <= 100').toBeLessThanOrEqual(100);

      // ── 9. Final confirmation: no "waiting..." text ─────────────────────
      const finalText = await vitalsEl.textContent();
      expect(finalText, 'No "waiting..." text after data arrives').not.toContain('waiting...');

      await snap('assertions-passed');

      console.log(`  [T-54] ALL CHECKS PASSED (${MODE})`);
      console.log(`    CPU: ${cpuPct}% | RAM: ${ramMatch[1]} ${ramMatch[2]} / ${ramMatch[3]} ${ramMatch[4]} | Disk: ${diskPct}%`);
      console.log(`    MicroBars: ${microBars.length}`);

    } finally {
      await snap('final-state');
      await browser.close();
    }
  });
});
} // end for (const MODE of MODES)
