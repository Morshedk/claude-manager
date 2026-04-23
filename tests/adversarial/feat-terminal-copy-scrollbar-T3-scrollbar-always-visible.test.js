/**
 * T-3: Scrollbar always visible without hover
 * Port: 3202
 * Type: Playwright browser
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3202;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-terminal-copy-scrollbar T-3 — Scrollbar always visible without hover', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-tcs-T3-XXXXXX').toString().trim();
    console.log(`\n  [T-3] tmpDir: ${tmpDir}`);

    fs.mkdirSync('/tmp/test-project-tcs3', { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-tcs-3', name: 'TCS T3 Project', path: '/tmp/test-project-tcs3' }],
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
      try {
        const r = await fetch(`${BASE_URL}/api/projects`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Server failed to start within 20s');
    console.log('  [T-3] Server ready');

    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 15000);
      let capturedId = null; let resolved = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session:create',
          projectId: 'proj-tcs-3',
          name: 'tcs-t3-session',
          command: 'bash',
          mode: 'direct',
          cols: 120, rows: 30,
        }));
      });
      ws.on('message', (data) => {
        if (resolved) return;
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session:created') {
          resolved = true; clearTimeout(t); ws.close(); resolve(msg.session.id);
        } else if (msg.type === 'session:state') {
          capturedId = msg.id;
          if (msg.state === 'running') { resolved = true; clearTimeout(t); ws.close(); resolve(capturedId); }
        }
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`  [T-3] Session created: ${sessionId}`);
    await sleep(1000);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Scrollbar is visible at rest (non-zero opacity), width 6px, brighter on hover', async () => {
    test.setTimeout(90000);

    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
    });

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1000);

      await page.waitForFunction(() => document.body.textContent.includes('TCS T3 Project'), { timeout: 15000 });
      await page.click('text=TCS T3 Project');
      await sleep(500);

      await page.waitForSelector('#sessions-area', { timeout: 10000 });
      await sleep(500);

      const card = page.locator('.session-card').first();
      await card.waitFor({ state: 'visible', timeout: 15000 });
      // Click titlebar to open overlay (preview area has stopPropagation)
      const titlebar = card.locator('.session-card-titlebar');
      await titlebar.click();
      await sleep(500);

      await page.waitForSelector('#session-overlay', { timeout: 15000 });
      console.log('  [T-3] Overlay opened');

      await page.waitForSelector('.xterm', { timeout: 20000 });
      await sleep(1500);
      console.log('  [T-3] xterm visible');

      // Send seq 1 500 to create scrollback
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { ws.close(); reject(new Error('WS send timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session:subscribed' && msg.id === sessionId) {
            ws.send(JSON.stringify({ type: 'session:input', id: sessionId, data: 'seq 1 500\n' }));
            setTimeout(() => { ws.close(); clearTimeout(t); resolve(); }, 2000);
          }
        });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
      });

      await sleep(2500);

      // Move mouse away from terminal (no hover)
      await page.mouse.move(0, 0);
      await sleep(300);

      // Check CSS rules for .xterm-viewport scrollbar
      const scrollbarInfo = await page.evaluate(() => {
        const vp = document.querySelector('.xterm-viewport');
        if (!vp) return { error: 'no .xterm-viewport' };

        // Check CSS stylesheet rules for webkit scrollbar
        let thumbBgAtRest = null;
        let thumbBgHover = null;
        let scrollbarWidthRule = null;
        let thumbBorderRadius = null;
        let firefoxScrollbarColor = null;
        let firefoxScrollbarColorHover = null;

        const sheets = Array.from(document.styleSheets);
        for (const sheet of sheets) {
          let rules;
          try { rules = Array.from(sheet.cssRules || []); } catch { continue; }
          for (const rule of rules) {
            if (!rule.selectorText) continue;
            const sel = rule.selectorText;

            // webkit scrollbar thumb at rest
            if (sel.includes('xterm-viewport') && sel.includes('webkit-scrollbar-thumb') && !sel.includes('hover')) {
              thumbBgAtRest = rule.style.background || rule.style.backgroundColor;
              thumbBorderRadius = rule.style.borderRadius;
            }
            // webkit scrollbar thumb hover
            if (sel.includes('xterm-viewport') && sel.includes('webkit-scrollbar-thumb') && sel.includes('hover')) {
              thumbBgHover = rule.style.background || rule.style.backgroundColor;
            }
            // webkit scrollbar width
            if (sel.includes('xterm-viewport') && sel.includes('webkit-scrollbar') && !sel.includes('track') && !sel.includes('thumb')) {
              scrollbarWidthRule = rule.style.width;
            }
            // Firefox scrollbar-color at rest
            if (sel === '.xterm-viewport' && !sel.includes('hover')) {
              if (rule.style.scrollbarColor) firefoxScrollbarColor = rule.style.scrollbarColor;
            }
            // Firefox scrollbar-color hover
            if (sel.includes('xterm-viewport') && sel.includes('hover') && !sel.includes('webkit')) {
              if (rule.style.scrollbarColor) firefoxScrollbarColorHover = rule.style.scrollbarColor;
            }
          }
        }

        return {
          thumbBgAtRest,
          thumbBgHover,
          scrollbarWidthRule,
          thumbBorderRadius,
          firefoxScrollbarColor,
          firefoxScrollbarColorHover,
          vpScrollHeight: vp.scrollHeight,
          vpClientHeight: vp.clientHeight,
        };
      });

      console.log(`  [T-3] Scrollbar info: ${JSON.stringify(scrollbarInfo)}`);

      // 1. Verify scrollbar width is 6px
      expect(scrollbarInfo.scrollbarWidthRule).toBe('6px');
      console.log('  [T-3] Scrollbar width 6px: PASS');

      // 2. Verify at-rest thumb is not transparent (contains > 0 alpha)
      expect(scrollbarInfo.thumbBgAtRest).toBeTruthy();
      // Must not be rgba(255,255,255,0) or transparent — but rgba(255,255,255,0.2) is VALID
      // Pattern: alpha=0 followed by ) or space, NOT 0.x
      expect(scrollbarInfo.thumbBgAtRest).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\s*\)/);
      expect(scrollbarInfo.thumbBgAtRest).not.toBe('transparent');
      // Should be rgba(255,255,255,0.2) — extract opacity
      const atRestMatch = scrollbarInfo.thumbBgAtRest.match(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/);
      const atRestOpacity = atRestMatch ? parseFloat(atRestMatch[1]) : 0;
      console.log(`  [T-3] At-rest opacity extracted: ${atRestOpacity}`);
      expect(atRestOpacity).toBeGreaterThan(0);
      console.log('  [T-3] At-rest opacity non-zero: PASS');

      // 3. Verify hover thumb has higher opacity (0.4)
      expect(scrollbarInfo.thumbBgHover).toBeTruthy();
      const hoverMatch = scrollbarInfo.thumbBgHover.match(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/);
      const hoverOpacity = hoverMatch ? parseFloat(hoverMatch[1]) : 0;
      console.log(`  [T-3] Hover opacity extracted: ${hoverOpacity}`);
      expect(hoverOpacity).toBeGreaterThan(atRestOpacity);
      console.log('  [T-3] Hover opacity greater than at-rest: PASS');

      // 4. Verify scrollback was created (scrollHeight > clientHeight)
      console.log(`  [T-3] scrollHeight: ${scrollbarInfo.vpScrollHeight}, clientHeight: ${scrollbarInfo.vpClientHeight}`);
      expect(scrollbarInfo.vpScrollHeight).toBeGreaterThan(scrollbarInfo.vpClientHeight);
      console.log('  [T-3] Scrollback present: PASS');

      // 5. Verify border-radius is 3px
      if (scrollbarInfo.thumbBorderRadius) {
        console.log(`  [T-3] Thumb border-radius: ${scrollbarInfo.thumbBorderRadius}`);
        expect(scrollbarInfo.thumbBorderRadius).toBe('3px');
        console.log('  [T-3] Border-radius 3px: PASS');
      }

      // 6. Firefox: verify scrollbar-color at rest is non-transparent
      if (scrollbarInfo.firefoxScrollbarColor) {
        console.log(`  [T-3] Firefox scrollbar-color at rest: "${scrollbarInfo.firefoxScrollbarColor}"`);
        expect(scrollbarInfo.firefoxScrollbarColor).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\s*\)/);
      }

      console.log('  [T-3] ALL ASSERTIONS PASSED');
    } finally {
      await browser.close();
    }
  });
});
