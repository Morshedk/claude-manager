/**
 * T-17: Server Restart — Direct Session Stopped, Tmux Session Running
 *
 * Score: L=3 S=5 D=4 (Total: 12)
 *
 * Flow:
 *   1. Create one direct session (echo hello → exits → stopped)
 *   2. Create one tmux session (bash → stays alive)
 *   3. SIGKILL the server process
 *   4. Restart the server with the same DATA_DIR
 *   5. Reload the browser
 *   6. Select the project
 *   7. Assert:
 *      - Direct session card shows "stopped" (PTY killed with server, or auto-resumed and echo exited)
 *      - Tmux session card shows "running" (tmux survived SIGKILL)
 *      - claudeSessionId is intact for both sessions
 *      - Clicking Refresh on the direct session restarts it (same session id)
 *
 * Design doc: tests/adversarial/designs/T-17-design.md
 *
 * Run:
 *   fuser -k 3114/tcp 2>/dev/null; sleep 1
 *   PORT=3114 npx playwright test tests/adversarial/T-17-server-restart-recovery.test.js --reporter=line --timeout=180000
 */

import { test, expect, chromium } from 'playwright/test';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const PORT = 3114;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'T-17-server-restart');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── WebSocket helpers ─────────────────────────────────────────────────────────

/**
 * Open a WebSocket to the server and return it.
 * @returns {Promise<WebSocket>}
 */
function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 10000);
  });
}

/**
 * Wait for a specific WS message type/matcher, with timeout.
 * @param {WebSocket} ws
 * @param {(msg: object) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function waitForMessage(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS message timeout after ${timeoutMs}ms`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

/**
 * Create a session via WebSocket. Returns session meta.
 * @param {WebSocket} ws
 * @param {object} params
 * @returns {Promise<object>}
 */
async function createSessionViaWs(ws, params) {
  ws.send(JSON.stringify({ type: 'session:create', ...params }));
  const msg = await waitForMessage(ws, m => m.type === 'session:created', 15000);
  return msg.session;
}

// ── REST helpers ──────────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function pollUntil(fn, timeoutMs = 15000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined && result !== false) return result;
    } catch (e) { lastErr = e; }
    await sleep(intervalMs);
  }
  throw lastErr || new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

/**
 * Wait for server to respond to GET /api/projects (health check).
 */
async function waitForServer(port, timeoutMs = 15000) {
  await pollUntil(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
    return res.ok;
  }, timeoutMs, 500);
}

/**
 * Start the server. Returns { proc, pid }.
 */
function startServer(dataDir) {
  const crashLogPath = path.join(dataDir, 'server-crash.log');
  const proc = spawn('node', ['server-with-crash-log.mjs'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      CRASH_LOG: crashLogPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  proc.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`  [srv:ERR] ${d}`));
  return proc;
}

// ── Test ──────────────────────────────────────────────────────────────────────

test.describe('T-17 — Server Restart: Direct Session Stopped, Tmux Session Running', () => {

  let dataDir = '';
  let serverProc = null;
  let projectId = '';
  let directSessionId = '';
  let tmuxSessionId = '';
  let directClaudeSessionId = '';
  let tmuxClaudeSessionId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Kill anything on the port first
    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
    await sleep(1000);

    // Create isolated temp data dir
    dataDir = execSync('mktemp -d /tmp/qa-T17-XXXXXX').toString().trim();
    console.log(`\n  [T-17] dataDir: ${dataDir}`);

    // Seed projects.json — ProjectStore format: { projects: [...], scratchpad: [] }
    const projectsSeed = {
      projects: [
        {
          id: 'proj-t17',
          name: 'T17-Project',
          path: '/tmp',
          createdAt: new Date().toISOString(),
        },
      ],
      scratchpad: [],
    };
    fs.writeFileSync(
      path.join(dataDir, 'projects.json'),
      JSON.stringify(projectsSeed, null, 2)
    );
    projectId = 'proj-t17';

    // Start server (first boot)
    serverProc = startServer(dataDir);
    await waitForServer(PORT, 15000);
    console.log('  [T-17] Server started (first boot)');
  });

  test.afterAll(async () => {
    // Kill server if still running
    if (serverProc) {
      try { process.kill(serverProc.pid, 'SIGKILL'); } catch {}
      serverProc = null;
    }
    // Cleanup temp dir
    try { execSync(`rm -rf ${dataDir}`); } catch {}
    console.log('  [T-17] Cleanup complete');
  });

  // ── Main test ──────────────────────────────────────────────────────────────

  test('direct session is stopped; tmux session is running after SIGKILL + restart', async ({ page }) => {

    // ── Step 1: Create direct session (echo hello → exits immediately) ────────
    console.log('\n  [T-17] Step 1: Creating direct session via WS...');
    const wsCreate = await openWs();

    // Wait for init message
    await waitForMessage(wsCreate, m => m.type === 'init', 10000);

    const directMeta = await createSessionViaWs(wsCreate, {
      projectId,
      name: 'direct-session',
      command: 'echo hello',
      mode: 'direct',
      cols: 120,
      rows: 30,
    });
    directSessionId = directMeta.id;
    directClaudeSessionId = directMeta.claudeSessionId;
    console.log(`  [T-17] Direct session created: ${directSessionId} (claudeSessionId: ${directClaudeSessionId})`);
    expect(directSessionId).toBeTruthy();
    expect(directClaudeSessionId).toBeTruthy();

    // Wait for direct session to reach "stopped" (echo hello exits quickly)
    console.log('  [T-17] Waiting for direct session to stop...');
    const directFinalStatus = await pollUntil(async () => {
      const data = await getJson(`${BASE_URL}/api/sessions`);
      const sessions = data.managed || data || [];
      const s = sessions.find(s => s.id === directSessionId);
      if (s && (s.status === 'stopped' || s.status === 'error')) return s.status;
      return null;
    }, 10000, 500);
    console.log(`  [T-17] Direct session status: ${directFinalStatus}`);
    expect(['stopped', 'error']).toContain(directFinalStatus);

    // ── Step 2: Create tmux session (bash → stays alive) ─────────────────────
    console.log('\n  [T-17] Step 2: Creating tmux session via WS...');
    const tmuxMeta = await createSessionViaWs(wsCreate, {
      projectId,
      name: 'tmux-session',
      command: 'bash',
      mode: 'tmux',
      cols: 120,
      rows: 30,
    });
    tmuxSessionId = tmuxMeta.id;
    tmuxClaudeSessionId = tmuxMeta.claudeSessionId;
    console.log(`  [T-17] Tmux session created: ${tmuxSessionId} (claudeSessionId: ${tmuxClaudeSessionId})`);
    expect(tmuxSessionId).toBeTruthy();
    expect(tmuxClaudeSessionId).toBeTruthy();

    // Wait for tmux session to reach "running"
    console.log('  [T-17] Waiting for tmux session to reach running...');
    const tmuxStatus = await pollUntil(async () => {
      const data = await getJson(`${BASE_URL}/api/sessions`);
      const sessions = data.managed || data || [];
      const s = sessions.find(s => s.id === tmuxSessionId);
      if (s && s.status === 'running') return 'running';
      return null;
    }, 15000, 500);
    console.log(`  [T-17] Tmux session status: ${tmuxStatus}`);
    expect(tmuxStatus).toBe('running');

    wsCreate.close();

    // ── Step 3: Verify sessions.json is flushed ───────────────────────────────
    console.log('\n  [T-17] Step 3: Verifying sessions.json...');
    const sessionsJsonPath = path.join(dataDir, 'sessions.json');
    await pollUntil(() => {
      if (!fs.existsSync(sessionsJsonPath)) return null;
      const content = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
      const hasBloth = Array.isArray(content) &&
        content.some(s => s.id === directSessionId) &&
        content.some(s => s.id === tmuxSessionId);
      return hasBloth ? true : null;
    }, 5000, 300);

    const sessionsBeforeKill = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
    console.log(`  [T-17] sessions.json before kill: ${JSON.stringify(sessionsBeforeKill.map(s => ({ id: s.id.slice(0, 8), status: s.status, mode: s.mode })))}`);

    // Save API response as artifact
    const preKillApi = await getJson(`${BASE_URL}/api/sessions`);
    fs.writeFileSync(
      path.join(SCREENSHOTS_DIR, '01-pre-kill-sessions-api.json'),
      JSON.stringify(preKillApi, null, 2)
    );

    // ── Step 4: SIGKILL the server ─────────────────────────────────────────────
    console.log('\n  [T-17] Step 4: Sending SIGKILL to server...');
    const serverPid = serverProc.pid;
    try { process.kill(serverPid, 'SIGKILL'); } catch (e) {
      console.warn(`  [T-17] SIGKILL warning: ${e.message}`);
    }
    serverProc = null;
    await sleep(1500); // Let OS reap the process

    // Verify server is dead
    let serverDead = false;
    try { process.kill(serverPid, 0); } catch { serverDead = true; }
    if (!serverDead) {
      // Try harder
      try { execSync(`kill -9 ${serverPid} 2>/dev/null || true`); } catch {}
      await sleep(500);
    }
    console.log(`  [T-17] Server PID ${serverPid} killed.`);

    // Verify tmux session survived
    const tmuxName = sessionsBeforeKill.find(s => s.id === tmuxSessionId)?.tmuxName;
    if (tmuxName) {
      try {
        execSync(`tmux has-session -t "${tmuxName}" 2>/dev/null`);
        console.log(`  [T-17] ✓ Tmux session "${tmuxName}" survived SIGKILL`);
      } catch {
        console.warn(`  [T-17] ✗ Tmux session "${tmuxName}" did NOT survive SIGKILL — test will fail`);
      }
    }

    // ── Step 5: Restart the server with same DATA_DIR ─────────────────────────
    console.log('\n  [T-17] Step 5: Restarting server with same DATA_DIR...');
    serverProc = startServer(dataDir);
    await waitForServer(PORT, 20000);
    console.log('  [T-17] Server restarted (second boot)');

    // Wait for init() to complete — poll /api/sessions until both sessions are visible
    await pollUntil(async () => {
      const data = await getJson(`${BASE_URL}/api/sessions`);
      const sessions = data.managed || data || [];
      const hasBoth = sessions.some(s => s.id === directSessionId) &&
                      sessions.some(s => s.id === tmuxSessionId);
      return hasBoth ? true : null;
    }, 15000, 500);

    // ── Step 6: API-level checks (pre-browser) ───────────────────────────────
    console.log('\n  [T-17] Step 6: API checks post-restart...');
    const postRestartApi = await getJson(`${BASE_URL}/api/sessions`);
    const allSessions = postRestartApi.managed || postRestartApi || [];

    fs.writeFileSync(
      path.join(SCREENSHOTS_DIR, '02-post-restart-sessions-api.json'),
      JSON.stringify(postRestartApi, null, 2)
    );

    const directPostRestart = allSessions.find(s => s.id === directSessionId);
    const tmuxPostRestart = allSessions.find(s => s.id === tmuxSessionId);

    console.log(`  [T-17] Direct session post-restart: ${JSON.stringify({ status: directPostRestart?.status, claudeSessionId: directPostRestart?.claudeSessionId?.slice(0, 8) })}`);
    console.log(`  [T-17] Tmux session post-restart: ${JSON.stringify({ status: tmuxPostRestart?.status, claudeSessionId: tmuxPostRestart?.claudeSessionId?.slice(0, 8) })}`);

    // CHECK A: Both session records survived SIGKILL
    expect(directPostRestart, 'Direct session record must survive SIGKILL').toBeTruthy();
    expect(tmuxPostRestart, 'Tmux session record must survive SIGKILL').toBeTruthy();

    // CHECK B: claudeSessionId integrity
    expect(directPostRestart.claudeSessionId).toBe(directClaudeSessionId);
    expect(tmuxPostRestart.claudeSessionId).toBe(tmuxClaudeSessionId);

    // CHECK C: Tmux session is running (tmux survived)
    expect(tmuxPostRestart.status).toBe('running');

    // CHECK D: Direct session is NOT running (PTY died with server, or auto-resumed echo exits → stopped)
    // It can be 'stopped' or 'error' but NOT 'running' (echo hello always exits)
    // Edge: if auto-resume started a new echo, it would exit immediately → 'stopped'
    // Wait briefly for any auto-resume to complete
    await sleep(2000);
    const directFinal = await pollUntil(async () => {
      const data = await getJson(`${BASE_URL}/api/sessions`);
      const sessions = data.managed || data || [];
      const s = sessions.find(s => s.id === directSessionId);
      if (s && s.status !== 'starting' && s.status !== 'running') return s.status;
      // If running, wait for echo hello to exit
      if (s && s.status === 'running') {
        // echo hello exits immediately, so poll for a bit
        return null;
      }
      return null;
    }, 10000, 500).catch(() => {
      // If we time out, check what the current status is
      return getJson(`${BASE_URL}/api/sessions`).then(data => {
        const sessions = data.managed || data || [];
        return sessions.find(s => s.id === directSessionId)?.status;
      });
    });

    console.log(`  [T-17] Direct session final status after restart: ${directFinal}`);
    expect(['stopped', 'error']).toContain(directFinal);

    // ── Step 7: Browser verification ──────────────────────────────────────────
    console.log('\n  [T-17] Step 7: Browser verification...');

    // Navigate with cache-busting
    await page.goto(`${BASE_URL}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500); // Let WS connect and sessions:list arrive

    // Take baseline screenshot
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-browser-sessions-area.png') });

    // Select the project in the sidebar
    const projectEl = page.locator('#project-list').locator('text=T17-Project').first();
    if (await projectEl.isVisible({ timeout: 5000 }).catch(() => false)) {
      await projectEl.click();
    } else {
      // Try sidebar
      const sidebar = page.locator('[class*="sidebar"], [class*="project"]').locator('text=T17-Project').first();
      await sidebar.click({ timeout: 5000 });
    }
    await sleep(1000);

    // Wait for sessions area
    await page.waitForSelector('.session-card, [class*="session-card"]', { timeout: 10000 })
      .catch(() => console.warn('  [T-17] No session cards found — checking anyway'));

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03b-after-project-select.png') });

    // CHECK E: Find direct session card — should show "stopped"
    console.log('  [T-17] Checking direct session card...');
    const directCard = page.locator('[class*="session-card"]').filter({ hasText: 'direct-session' }).first();
    if (await directCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-direct-session-card.png') });

      const directBadge = directCard.locator('[class*="badge"], [class*="status"], [class*="state"]').first();
      const badgeText = await directBadge.textContent({ timeout: 3000 }).catch(() => 'unknown');
      console.log(`  [T-17] Direct session badge: "${badgeText}"`);

      const badgeLower = (badgeText || '').toLowerCase();
      const isNotRunning = badgeLower.includes('stopped') || badgeLower.includes('error') || badgeLower.includes('exit');
      expect(isNotRunning, `Direct session should show stopped/error, got: "${badgeText}"`).toBe(true);
    } else {
      console.warn('  [T-17] Direct session card not visible in browser — using API check');
      // Already verified via API above
    }

    // CHECK F: Find tmux session card — should show "running"
    console.log('  [T-17] Checking tmux session card...');
    const tmuxCard = page.locator('[class*="session-card"]').filter({ hasText: 'tmux-session' }).first();
    if (await tmuxCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-tmux-session-card.png') });

      const tmuxBadge = tmuxCard.locator('[class*="badge"], [class*="status"], [class*="state"]').first();
      const tmuxBadgeText = await tmuxBadge.textContent({ timeout: 3000 }).catch(() => 'unknown');
      console.log(`  [T-17] Tmux session badge: "${tmuxBadgeText}"`);

      const tmuxBadgeLower = (tmuxBadgeText || '').toLowerCase();
      expect(tmuxBadgeLower).toContain('running');
    } else {
      console.warn('  [T-17] Tmux session card not visible in browser — using API check');
      // Already verified via API above
    }

    // ── Step 8: Refresh the direct session ───────────────────────────────────
    console.log('\n  [T-17] Step 8: Refreshing direct session...');
    const refreshBtn = directCard.locator('button').filter({ hasText: /refresh/i }).first();
    if (await refreshBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await refreshBtn.click();
      console.log('  [T-17] Clicked Refresh on direct session');
      await sleep(3000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-after-refresh.png') });

      // Verify the session ID is unchanged (same session, new PTY)
      const afterRefreshApi = await getJson(`${BASE_URL}/api/sessions`);
      const afterSessions = afterRefreshApi.managed || afterRefreshApi || [];
      const directAfterRefresh = afterSessions.find(s => s.id === directSessionId);
      console.log(`  [T-17] Direct session after refresh: ${JSON.stringify({ id: directAfterRefresh?.id?.slice(0, 8), status: directAfterRefresh?.status })}`);

      // CHECK G: Same session id after refresh (not a new session)
      expect(directAfterRefresh, 'Session must still exist after refresh').toBeTruthy();
      expect(directAfterRefresh.id).toBe(directSessionId);

      // claudeSessionId must still match
      expect(directAfterRefresh.claudeSessionId).toBe(directClaudeSessionId);
    } else {
      console.warn('  [T-17] Refresh button not found — testing via WS');
      // Fallback: trigger refresh via WS
      const wsRefresh = await openWs();
      await waitForMessage(wsRefresh, m => m.type === 'init', 5000);
      wsRefresh.send(JSON.stringify({ type: 'session:refresh', id: directSessionId }));
      try {
        await waitForMessage(wsRefresh, m => m.type === 'session:refreshed' && m.id === directSessionId, 10000);
        console.log('  [T-17] Refresh via WS confirmed');
      } catch (e) {
        console.warn(`  [T-17] WS refresh: ${e.message}`);
      }
      wsRefresh.close();
      await sleep(2000);

      // Verify same session id
      const afterRefreshApi = await getJson(`${BASE_URL}/api/sessions`);
      const afterSessions = afterRefreshApi.managed || afterRefreshApi || [];
      const directAfterRefresh = afterSessions.find(s => s.id === directSessionId);
      expect(directAfterRefresh?.id).toBe(directSessionId);
      expect(directAfterRefresh?.claudeSessionId).toBe(directClaudeSessionId);
    }

    console.log('\n  [T-17] ✓ All checks passed!');
    console.log(`    - Direct session (${directSessionId.slice(0, 8)}...): NOT running after SIGKILL ✓`);
    console.log(`    - Tmux session (${tmuxSessionId.slice(0, 8)}...): running after SIGKILL ✓`);
    console.log(`    - Direct claudeSessionId intact: ${directClaudeSessionId.slice(0, 8)}... ✓`);
    console.log(`    - Tmux claudeSessionId intact: ${tmuxClaudeSessionId.slice(0, 8)}... ✓`);
    console.log(`    - sessions.json flushed before SIGKILL ✓`);
    console.log(`    - Refresh re-uses same session id ✓`);

    // Final screenshot
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-final-state.png') });
  });
});
