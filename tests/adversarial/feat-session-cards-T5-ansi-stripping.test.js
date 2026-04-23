/**
 * T-5: Adversarial — previewLines with ANSI escape sequences are stripped
 * Port: 3504
 * Type: WS protocol + Playwright (DOM XSS check)
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3504;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';
let sessionId = null;

test.describe('feat-session-cards T-5 — ANSI stripping adversarial', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-portrait-T5-XXXXXX').toString().trim();

    fs.mkdirSync('/tmp/test-project', { recursive: true }); // ensure project path exists

    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'proj-test-1', name: 'Test Project', path: '/tmp/test-project' }],
      scratchpad: []
    }));

    const crashLog = path.join(tmpDir, 'crash.log');
    serverProc = spawn('node', ['server-with-crash-log.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLog },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE_URL}/api/sessions`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(400);
    }
    if (!ready) throw new Error('Server failed to start within 20s');
    console.log('  [T-5] Server ready');

    // Create session via WS and send ANSI-heavy input
    sessionId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 15000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.send(JSON.stringify({
            type: 'session:create',
            projectId: 'proj-test-1',
            name: 'T5-ansi',
            command: 'bash',
            mode: 'direct'
          }));
        }
        if (msg.type === 'session:created') {
          const id = msg.session.id;
          ws.send(JSON.stringify({ type: 'session:subscribe', id }));
        }
        if (msg.type === 'session:subscribed') {
          const id = msg.id;
          // Send ANSI-heavy input exercising multiple escape families.
          // Use $'...' ANSI-C quoting so bash interprets \x1b as actual ESC bytes (char 27).
          // This produces real ESC sequences in PTY output that stripAnsi must remove.
          const commands = [
            "printf $'\\x1b[31mRED_TEXT\\x1b[0m \\x1b[1;4mBOLD_UNDERLINE\\x1b[0m\\n'",
            "printf $'\\x1b]0;WINDOW_TITLE\\x07\\n'",
            "printf $'\\x1b[3CCURSOR_FORWARD\\n'",
            "printf $'CLEAN_SENTINEL_LINE\\n'",
            "printf $'\\x1b[?25lHIDDEN_CURSOR\\n'",
            "printf $'\\x1b(B\\x1b)0GSET_SWITCH\\n'",
          ];
          const combined = commands.join('; ');
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'session:input', id, data: combined + '\n' }));
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

    console.log(`  [T-5] Session: ${sessionId}, sent ANSI commands, waiting 25s...`);
    await sleep(25000);
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('ANSI escapes stripped from previewLines, readable text preserved', async () => {
    // Phase 1: Check via REST that previewLines are clean
    const resp = await fetch(`${BASE_URL}/api/sessions`);
    expect(resp.ok).toBe(true);
    const { managed } = await resp.json();
    const session = managed.find(s => s.id === sessionId);

    expect(session).toBeDefined();
    console.log(`  [T-5] previewLines: ${JSON.stringify(session?.previewLines?.slice(0, 10))}`);

    expect(Array.isArray(session.previewLines)).toBe(true);

    // Check CLEAN_SENTINEL_LINE is present (control — if absent, echo commands failed)
    const hasSentinel = session.previewLines.some(l => l.includes('CLEAN_SENTINEL_LINE'));
    if (!hasSentinel) {
      console.warn('  [T-5] WARNING: CLEAN_SENTINEL_LINE not found — echo commands may have failed');
    }
    expect(hasSentinel).toBe(true);

    // Check every line is clean of ANSI escape sequences
    const ansiPatterns = [
      '\x1b', '\u001b',
      '[31m', '[0m', '[1;4m', ']0;', '[3C', '[?25l', '(B', ')0'
    ];

    for (const line of session.previewLines) {
      expect(typeof line).toBe('string');

      // Check for ESC byte (char code 27)
      for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        if (code < 32 && code !== 10) { // allow newline but nothing else < 32
          throw new Error(`Line contains control char code ${code}: "${line}"`);
        }
      }

      // Check for literal ANSI pattern remnants
      for (const pattern of ansiPatterns) {
        if (line.includes(pattern)) {
          throw new Error(`Line contains ANSI pattern "${pattern}": "${line}"`);
        }
      }
    }
    console.log('  [T-5] All lines clean of ANSI escapes');

    // Check readable text is present
    const allText = session.previewLines.join('\n');
    expect(allText).toContain('RED_TEXT');
    expect(allText).toContain('BOLD_UNDERLINE');
    console.log('  [T-5] Readable text preserved in previewLines');

    // Phase 2: Browser DOM XSS check — render previewLines into <pre> and assert no injected elements
    const browser = await chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('text=Test Project', { timeout: 10000 });
      await page.click('text=Test Project');
      await sleep(1000);

      await page.waitForSelector('.session-card-preview', { timeout: 10000 });

      // Get the preview element and check it has no child elements (no injected HTML tags)
      const childElementCount = await page.locator('.session-card-preview').first().evaluate(el => {
        // Count child element nodes (not text nodes)
        return el.children.length;
      });

      console.log(`  [T-5] Preview child element count: ${childElementCount}`);
      // The <pre> should contain only text nodes (or a single span for empty state)
      // If ANSI was not stripped and rendered as HTML, we'd see script/style/span injection
      // A clean pre may have 0 children (pure text) or 1 (the "No output" span)
      // But it should NEVER have injected script/img/etc from ANSI content
      const childTagNames = await page.locator('.session-card-preview').first().evaluate(el => {
        return Array.from(el.children).map(c => c.tagName.toLowerCase());
      });
      console.log(`  [T-5] Preview child tags: ${JSON.stringify(childTagNames)}`);

      // No script, img, or other dangerous elements
      const dangerousTags = ['script', 'img', 'iframe', 'object', 'embed'];
      for (const tag of dangerousTags) {
        expect(childTagNames).not.toContain(tag);
      }
      console.log('  [T-5] No dangerous injected elements in DOM — PASS');
    } finally {
      await browser.close();
    }
  });
});
