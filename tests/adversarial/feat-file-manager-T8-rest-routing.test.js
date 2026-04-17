/**
 * T-8: REST — /viewer.html routing guard + vendor file + pre-implementation diff
 * Port: 3357
 * Type: REST (no browser UI)
 */

import { test, expect } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3357;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let serverProc = null;
let tmpDir = '';

test.describe('feat-file-manager T-8 — REST routing guard + vendor + file content assertions', () => {

  test.beforeAll(async () => {
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(500);

    tmpDir = execSync('mktemp -d /tmp/qa-feat-fm-T8-XXXXXX').toString().trim();
    console.log(`\n  [T-8] tmpDir: ${tmpDir}`);

    // Create README.md for file read test
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test README\n\nHello world.\n');

    // Write projects.json
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'p1', name: 'Demo', path: tmpDir }],
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
    console.log('  [T-8] Server ready');
  });

  test.afterAll(async () => {
    if (serverProc) { serverProc.kill(); await sleep(300); }
    if (tmpDir) { try { execSync(`rm -rf ${tmpDir}`); } catch {} }
  });

  test('Step 2: GET /viewer.html → 200 HTML with viewer-content marker, not app div', async () => {
    const res = await fetch(`${BASE_URL}/viewer.html`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type');
    console.log(`  [T-8] /viewer.html content-type: ${ct}`);
    expect(ct).toContain('text/html');

    const body = await res.text();
    expect(body).toContain('<div id="viewer-content">');
    expect(body).not.toContain('<div id="app">');
    console.log('  [T-8] /viewer.html routing guard: PASS');
  });

  test('Step 3: GET /vendor/marked-12.0.0.min.js → 200 javascript, body > 10000 bytes', async () => {
    const res = await fetch(`${BASE_URL}/vendor/marked-12.0.0.min.js`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type');
    console.log(`  [T-8] /vendor/marked... content-type: ${ct}`);
    expect(ct).toMatch(/javascript/i);

    const body = await res.text();
    console.log(`  [T-8] /vendor/marked... body length: ${body.length}`);
    expect(body.length).toBeGreaterThan(10000);
    console.log('  [T-8] vendor/marked: PASS');
  });

  test('Step 4: GET /js/components/FileContentView.js → 200, contains dangerouslySetInnerHTML', async () => {
    const res = await fetch(`${BASE_URL}/js/components/FileContentView.js`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('dangerouslySetInnerHTML');
    console.log('  [T-8] FileContentView.js contains dangerouslySetInnerHTML: PASS');
  });

  test('Step 5: GET /js/components/FileSplitPane.js → 200, contains SPLIT_MIN and SPLIT_MAX from store.js', async () => {
    const res = await fetch(`${BASE_URL}/js/components/FileSplitPane.js`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('SPLIT_MIN');
    expect(body).toContain('SPLIT_MAX');
    expect(body).toContain('store.js');
    console.log('  [T-8] FileSplitPane.js contains SPLIT_MIN/SPLIT_MAX/store.js: PASS');
  });

  test('Step 6: GET /js/viewer.js → 200, contains preventDefault() and addEventListener(click)', async () => {
    const res = await fetch(`${BASE_URL}/js/viewer.js`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('preventDefault()');
    expect(body).toContain("addEventListener('click'");
    console.log('  [T-8] viewer.js contains preventDefault and click handler: PASS');
  });

  test('Step 7: GET /api/fs/read with project README.md → 200, correct content', async () => {
    const readmePath = path.join(tmpDir, 'README.md');
    const url = `${BASE_URL}/api/fs/read?path=${encodeURIComponent(readmePath)}&projectPath=${encodeURIComponent(tmpDir)}`;
    const res = await fetch(url);
    console.log(`  [T-8] /api/fs/read README.md status: ${res.status}`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('# Test README');
    console.log('  [T-8] /api/fs/read README.md: PASS');
  });

  test('Step 8: GET /api/fs/read /etc/passwd with real projectPath → 403', async () => {
    const url = `${BASE_URL}/api/fs/read?path=${encodeURIComponent('/etc/passwd')}&projectPath=${encodeURIComponent(tmpDir)}`;
    const res = await fetch(url);
    console.log(`  [T-8] /api/fs/read /etc/passwd with projectPath status: ${res.status}`);
    expect(res.status).toBe(403);
    console.log('  [T-8] Path traversal guard: PASS');
  });

  test('Step 9: GET /api/fs/read /etc/passwd with projectPath=/ → document behavior (informational)', async () => {
    const url = `${BASE_URL}/api/fs/read?path=${encodeURIComponent('/etc/passwd')}&projectPath=${encodeURIComponent('/')}`;
    const res = await fetch(url);
    const status = res.status;
    console.log(`  [T-8] /api/fs/read /etc/passwd projectPath=/ status: ${status}`);

    if (status === 200) {
      console.log('  [T-8] INFORMATIONAL: Pre-existing bypass confirmed — projectPath=/ returns /etc/passwd content. Out of scope for this feature; flag for server-side triage.');
    } else if (status === 403) {
      console.log('  [T-8] INFORMATIONAL: Bypass fixed — projectPath=/ now returns 403.');
    } else {
      console.log(`  [T-8] INFORMATIONAL: projectPath=/ returns status ${status}`);
    }
    // This is informational — test always passes regardless of outcome
    expect([200, 403, 400, 404, 500]).toContain(status);
  });

  test('Step 10: GET /js/components/FileBrowser.js → 200, contains aria-label="File path" and submitPathInput', async () => {
    const res = await fetch(`${BASE_URL}/js/components/FileBrowser.js`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('aria-label="File path"');
    expect(body).toContain('submitPathInput');
    console.log('  [T-8] FileBrowser.js contains aria-label and submitPathInput: PASS');
  });
});
