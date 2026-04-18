import { EventEmitter } from 'events';
import { execSync, execFile } from 'child_process';
import { createReadStream } from 'fs';
import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const TMUX = '/usr/bin/tmux';
const CLAUDE = '/home/claude-runner/.local/bin/claude';
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';

// Sessions to monitor (hardcoded factory sessions)
export const SESSIONS = [
  {
    name: 'factory',
    botToken: process.env.WATCHDOG_BOT_TOKEN_1 || '8563389078:AAFsCIHXrL9DNPSc4KZ-2jeuUTJS6EUFLSA',
    chatId: process.env.WATCHDOG_CHAT_ID || '6653417306',
    workdir: '/projects/niyyah',
    envExtras: {},
    channels: true,
  },
  {
    name: 'factory2',
    botToken: process.env.WATCHDOG_BOT_TOKEN_2 || '8780329252:AAFIsb-chU6cvyWJV9t98IKZIcJELC0m_W8',
    chatId: process.env.WATCHDOG_CHAT_ID || '6653417306',
    workdir: '/projects/niyyah',
    envExtras: { TELEGRAM_STATE_DIR: '/home/claude-runner/.claude/channels/telegram2' },
    channels: true,
  },
];

// Thresholds
export const RESTART_PAUSE_AFTER = 4;
export const RESTART_PAUSE_MINS = 30;
export const CONTEXT_COMPACT_THRESHOLD = 50000;
export const CONTEXT_RESTART_THRESHOLD = 100000;
const CONTEXT_RESTART_COOLDOWN_S = 7200;
export const MCP_GRACE_PERIOD_S = 1200;
const RESOURCE_CHECK_INTERVAL_S = 300;
const CREDIT_CHECK_INTERVAL_S = 300;
const MAX_LOG_ENTRIES = 200;
const MIN_DELTA_FOR_SUMMARY = 500;
const ERROR_LOOP_THRESHOLD = 2;
const SUGGESTION_COOLDOWN_S = 1800;
const LEARNINGS_MAX_ENTRIES = 150;
const LOW_POWER_AI_FAIL_THRESHOLD = 2;
const DEEP_REVIEW_COOLDOWN_S = 3600;

const SUMMARIZE_PROMPT = `You are summarizing a Claude CLI session's recent terminal activity.

Respond ONLY with JSON, no markdown fences:
{"summary": "1-2 sentence summary of what happened", "keyActions": ["action1", "action2"], "state": "productive|error_loop|idle|slow_progress", "cardLabel": "5-7 word description of current activity"}

The cardLabel must be exactly 5-7 words describing what the session is doing right now (e.g. "Building REST API authentication middleware", "Running test suite for payment module").

Terminal output:
`;

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[\[>?=]/g, '')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '');
}

/**
 * WatchdogManager — monitors all sessions, detects hangs/crashes,
 * persists watchdog state, broadcasts ticks to connected clients.
 *
 * Extends EventEmitter and emits:
 *   - 'tick'         { count, creditState, lowPower }
 *   - 'sessionEvent' { session, event }
 *   - 'summary'      { session, sessionId, projectId, summary, keyActions, state, ... }
 *   - 'errorLoop'    { session, fingerprint, consecutive, review }
 *   - 'suggestion'   { session, nextStep, why }
 *   - 'notification' { session, message }
 *   - 'resumeInjected' { session }
 *   - 'resourceAlert' res
 *   - 'creditSnapshot' snapshot
 *   - 'lowPowerChanged' { active, failCount? }
 *   - 'error'        Error
 */
export class WatchdogManager extends EventEmitter {
  /**
   * @param {{ sessionManager?: object, detector?: object, settingsStore?: object, todoManager?: object, dataDir?: string, clientRegistry?: object }} [opts]
   */
  constructor({ sessionManager = null, detector = null, settingsStore = null, todoManager = null, dataDir = null, clientRegistry = null } = {}) {
    super();
    this.sessionManager = sessionManager;
    this.detector = detector;
    this.settingsStore = settingsStore;
    this.todoManager = todoManager;
    this.clientRegistry = clientRegistry;
    this.dataDir = dataDir || path.join(__dirname, '../../data');

    this._timer = null;
    this._tickInterval = 30_000; // 30 seconds
    this._ticking = false;
    this._tickCount = 0;

    // Per-session state keyed by session name
    this._state = {};
    for (const sess of SESSIONS) {
      this._state[sess.name] = {
        restartCount: 0,
        restartPausedUntil: 0,
        lastMcpRestart: 0,
        lastContextRestart: 0,
        contextState: 'normal',
      };
    }

    // Summarization: track last-seen scrollback offset per session
    this._scrollbackOffsets = {};

    // Global state
    this._creditState = 'ok';
    this._lastResourceCheck = 0;
    this._lastCreditCheck = 0;

    // Error loop tracking: per-session array of { timestamp, fingerprint, state }
    this._inflightHistory = {};

    // Low-power mode
    this._aiFailCount = 0;
    this._lowPower = false;

    // Suggestion cooldowns: per-session last suggestion timestamp
    this._lastSuggestion = {};

    // ccusage credit snapshots
    this._lastCcusageCheck = 0;
    this._lastCreditSnapshot = null;

    // Deep review cooldown: per-session
    this._lastDeepReview = {};

    // Activity logs dir
    this._logsDir = path.join(this.dataDir, 'activity-logs');
    fs.mkdirSync(this._logsDir, { recursive: true });

    // Learnings file
    this._learningsFile = path.join(this.dataDir, 'learnings.json');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the watchdog tick loop.
   */
  start(intervalMs) {
    if (this._timer) {
      clearInterval(this._timer);
    }
    if (intervalMs) this._tickInterval = intervalMs;
    this._timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[watchdog] tick failed:', err.message);
        this.emit('error', err);
      });
    }, this._tickInterval);
  }

  /**
   * Stop the watchdog tick loop.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ── State persistence ──────────────────────────────────────────────────────

  _stateFile() {
    return path.join(this.dataDir, 'watchdog-state.json');
  }

  _loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(this._stateFile(), 'utf8'));
      if (data._state) Object.assign(this._state, data._state);
      if (data._creditState) this._creditState = data._creditState;
    } catch { /* fresh start */ }
  }

  _saveState() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const target = this._stateFile();
      const tmp = target + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        _state: this._state,
        _creditState: this._creditState,
        updatedAt: new Date().toISOString(),
      }, null, 2));
      fs.renameSync(tmp, target);
    } catch { /* ignore */ }
  }

  // ── tmux helpers ───────────────────────────────────────────────────────────

  tmuxSessionExists(name) {
    try {
      const sessions = execSync(`${TMUX} list-sessions -F "#{session_name}" 2>/dev/null`, {
        encoding: 'utf8', timeout: 3000,
      }).trim().split('\n');
      return sessions.includes(name);
    } catch {
      return false;
    }
  }

  tmuxCapture(name, lines = 200) {
    try {
      // Use JSON.stringify to safely escape the session name (avoids shell injection)
      return execSync(`${TMUX} capture-pane -t ${JSON.stringify(name)} -p -S -${lines} 2>/dev/null`, {
        encoding: 'utf8', timeout: 5000,
      });
    } catch {
      return '';
    }
  }

  tmuxPanePid(name) {
    try {
      const pid = execSync(`${TMUX} list-panes -t ${JSON.stringify(name)} -F "#{pane_pid}" 2>/dev/null`, {
        encoding: 'utf8', timeout: 3000,
      }).trim().split('\n')[0];
      const num = parseInt(pid, 10);
      if (!num || num <= 2) return null;
      return num;
    } catch {
      return null;
    }
  }

  tmuxSendKeys(name, text) {
    try {
      execSync(`${TMUX} send-keys -t ${JSON.stringify(name)} ${JSON.stringify(text)} Enter`, {
        timeout: 3000,
      });
    } catch { /* ignore */ }
  }

  // ── Process helpers ────────────────────────────────────────────────────────

  _getDescendants(pid) {
    try {
      const kids = execSync(`pgrep -P ${pid} 2>/dev/null`, {
        encoding: 'utf8', timeout: 3000,
      }).trim().split('\n').filter(Boolean).map(Number);
      let all = [...kids];
      for (const k of kids) {
        all = all.concat(this._getDescendants(k));
      }
      return all;
    } catch {
      return [];
    }
  }

  _processAlive(pid) {
    try {
      return fs.existsSync(`/proc/${pid}/status`);
    } catch {
      return false;
    }
  }

  // ── Telegram ───────────────────────────────────────────────────────────────

  sendTelegram(botToken, chatId, text) {
    return new Promise((resolve) => {
      const data = `chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(text)}`;
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.write(data);
      req.end();
    });
  }

  async _notify(sess, msg) {
    await this.sendTelegram(sess.botToken, sess.chatId, msg);
    this.emit('notification', { session: sess.name, message: msg });
  }

  // ── Session start ──────────────────────────────────────────────────────────

  async _startSession(sess) {
    const envParts = [`ANTHROPIC_API_KEY=`, `CLAUDE_CODE_OAUTH_TOKEN=${OAUTH_TOKEN}`];
    for (const [k, v] of Object.entries(sess.envExtras || {})) {
      // Only allow safe env key names (alphanumeric + underscore)
      if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) {
        // Shell-escape the value to prevent injection via env values
        const safeVal = String(v).replace(/'/g, "'\\''");
        envParts.push(`${k}='${safeVal}'`);
      }
    }

    let extraFlags = '';
    if (this.settingsStore) {
      try {
        const builtCmd = await this.settingsStore.buildWatchdogCommand();
        // buildWatchdogCommand returns "claude [--model X] [--effort max] [flags]"
        // Strip the leading "claude" to get only the extra flags
        extraFlags = builtCmd.replace(/^claude\s*/, '').trim();
      } catch {}
    }

    const channelsFlag = sess.channels ? ' --channels plugin:telegram@claude-plugins-official' : '';
    const cmd = `env ${envParts.join(' ')} ${CLAUDE}${extraFlags ? ' ' + extraFlags : ''} --dangerously-skip-permissions --verbose${channelsFlag}`;

    try {
      execSync(`${TMUX} new-session -d -s ${JSON.stringify(sess.name)} -c ${JSON.stringify(sess.workdir)} ${JSON.stringify(cmd)}`, {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async _waitForReady(name, timeoutMs = 40000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.tmuxSessionExists(name)) {
        const pane = this.tmuxCapture(name, 20);
        if (/Listening for channel messages|bypass.*permissions/i.test(pane)) {
          return true;
        }
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  // ── Restart logic ──────────────────────────────────────────────────────────

  _isRestartPaused(sessName) {
    const st = this._state[sessName];
    if (!st || !st.restartPausedUntil) return false;
    return Date.now() < st.restartPausedUntil;
  }

  _incrementRestart(sessName) {
    const st = this._state[sessName];
    st.restartCount++;
    if (st.restartCount >= RESTART_PAUSE_AFTER) {
      st.restartPausedUntil = Date.now() + RESTART_PAUSE_MINS * 60 * 1000;
    }
    return st.restartCount;
  }

  _resetRestart(sessName) {
    const st = this._state[sessName];
    st.restartCount = 0;
    st.restartPausedUntil = 0;
  }

  // ── Credit check ───────────────────────────────────────────────────────────

  async checkCredits() {
    return new Promise((resolve) => {
      execFile(CLAUDE, ['--print', 'ping'], {
        env: { ...process.env, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
        timeout: 30000,
        cwd: '/tmp',
      }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        if (/credit|quota|billing|402|insufficient|out of/i.test(output)) {
          resolve(false);
        } else if (!stdout || !stdout.trim()) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  // ── Rate limit detection ───────────────────────────────────────────────────

  checkRateLimit(sessName) {
    const pane = this.tmuxCapture(sessName, 30);
    if (!/Stop and wait for limit|rate-limit-options/.test(pane)) {
      return { limited: false };
    }

    const resetMatch = pane.match(/resets (\d+)(am|pm) \(UTC\)|resets (\d+:\d+) \(UTC\)/);
    if (!resetMatch) {
      this.tmuxSendKeys(sessName, '');
      return { limited: true, dismissed: true, reason: 'no reset time' };
    }

    let hour;
    if (resetMatch[2]) {
      hour = parseInt(resetMatch[1], 10);
      if (resetMatch[2] === 'pm' && hour < 12) hour += 12;
      if (resetMatch[2] === 'am' && hour === 12) hour = 0;
    } else {
      hour = parseInt(resetMatch[3], 10);
    }

    const now = new Date();
    const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
    if (resetDate.getTime() <= now.getTime()) {
      resetDate.setUTCDate(resetDate.getUTCDate() + 1);
    }

    const minsLeft = Math.floor((resetDate.getTime() - now.getTime()) / 60000);

    if (now.getTime() >= resetDate.getTime() || minsLeft > 720) {
      this.tmuxSendKeys(sessName, '');
      return { limited: true, dismissed: true, minsLeft };
    }

    return { limited: true, dismissed: false, minsLeft };
  }

  // ── MCP (bun) health check ─────────────────────────────────────────────────

  checkMcpAlive(sessName) {
    const pid = this.tmuxPanePid(sessName);
    if (!pid) return { alive: true, reason: 'no pid' };

    const st = this._state[sessName];
    const elapsed = (Date.now() / 1000) - (st.lastMcpRestart || 0);
    if (elapsed < MCP_GRACE_PERIOD_S) {
      return { alive: true, reason: 'grace period' };
    }

    const descendants = this._getDescendants(pid);
    try {
      const bunPids = execSync('pgrep -f "bun.*server\\.ts" 2>/dev/null', {
        encoding: 'utf8', timeout: 3000,
      }).trim().split('\n').filter(Boolean).map(Number);

      for (const bunPid of bunPids) {
        if (descendants.includes(bunPid)) {
          return { alive: true };
        }
      }
    } catch {
      // No bun processes at all
    }

    return { alive: false, claudePid: pid };
  }

  // ── Context size ───────────────────────────────────────────────────────────

  getContextTokens(sessName) {
    const pane = this.tmuxCapture(sessName, 30);
    const match = pane.match(/(\d+) tokens/);
    return match ? parseInt(match[1], 10) : 0;
  }

  async handleContext(sess) {
    const tokens = this.getContextTokens(sess.name);
    const st = this._state[sess.name];

    if (tokens > CONTEXT_RESTART_THRESHOLD) {
      const elapsed = (Date.now() / 1000) - (st.lastContextRestart || 0);
      if (elapsed < CONTEXT_RESTART_COOLDOWN_S) return tokens;

      await this._notify(sess, `🔄 Context restart — ${tokens} tokens`);
      const pid = this.tmuxPanePid(sess.name);
      if (pid) { try { process.kill(pid); } catch {} }
      await new Promise(r => setTimeout(r, 2000));
      try { execSync(`${TMUX} kill-session -t ${JSON.stringify(sess.name)} 2>/dev/null`); } catch {}
      await new Promise(r => setTimeout(r, 1000));
      await this._startSession(sess);
      st.lastContextRestart = Date.now() / 1000;
      st.contextState = 'normal';

      if (await this._waitForReady(sess.name)) {
        await this._notify(sess, '✅ Context restart complete');
      } else {
        await this._notify(sess, '❌ Context restart failed — not ready');
      }
      return tokens;
    }

    if (tokens > CONTEXT_COMPACT_THRESHOLD) {
      if (st.contextState !== 'compacted') {
        this.tmuxSendKeys(sess.name, '/compact');
        st.contextState = 'compacted';
        await this._notify(sess, `🗜️ /compact triggered — ${tokens} tokens`);
      }
    } else {
      st.contextState = 'normal';
    }

    return tokens;
  }

  // ── System resources ───────────────────────────────────────────────────────

  checkResources() {
    const cpus = os.cpus().length;
    const loadAvg = os.loadavg()[0];
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memAvailMb = Math.floor(memFree / (1024 * 1024));

    let diskPct = 0;
    let diskAvailGb = 0;
    try {
      const df = execSync("df / | awk 'NR==2{gsub(/%/,\"\",$5); print $5, $4}'", {
        encoding: 'utf8', timeout: 3000,
      }).trim().split(/\s+/);
      diskPct = parseInt(df[0], 10) || 0;
      diskAvailGb = Math.floor((parseInt(df[1], 10) || 0) / (1024 * 1024));
    } catch {}

    const loadPct = Math.floor((loadAvg / cpus) * 100);

    const alerts = [];
    if (diskPct >= 90) alerts.push(`🚨 DISK CRITICAL: ${diskPct}% used (${diskAvailGb}GB free)`);
    else if (diskPct >= 80) alerts.push(`⚠️ DISK WARNING: ${diskPct}% used (${diskAvailGb}GB free)`);
    if (memAvailMb < 200) alerts.push(`🚨 MEMORY CRITICAL: ${memAvailMb}MB free`);
    else if (memAvailMb < 400) alerts.push(`⚠️ MEMORY WARNING: ${memAvailMb}MB free`);
    if (loadPct >= 200) alerts.push(`⚠️ CPU HIGH: load ${loadAvg.toFixed(1)} on ${cpus} vCPU`);

    return { diskPct, diskAvailGb, memAvailMb, loadPct, cpus, alerts };
  }

  // ── ccusage credit snapshot ────────────────────────────────────────────────

  _runCcusage(args) {
    return new Promise((resolve) => {
      execFile('npx', ['--yes', 'ccusage', ...args, '--json', '--offline'], {
        env: { ...process.env },
        timeout: 30000,
        cwd: '/tmp',
      }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
    });
  }

  async checkCcusage() {
    const CCUSAGE_MIN_INTERVAL_S = 300;
    const now = Date.now() / 1000;
    if (now - this._lastCcusageCheck < CCUSAGE_MIN_INTERVAL_S) return null;

    try {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const [blocksData, dailyData] = await Promise.all([
        this._runCcusage(['blocks']),
        this._runCcusage(['daily', '--since', today]),
      ]);

      if (!blocksData) return null;

      const activeBlock = (blocksData.blocks || []).find(b => b.isActive) ||
        (blocksData.blocks || []).slice(-1)[0] || null;

      const todayCostUSD = dailyData?.totals?.totalCost ?? null;

      const snapshot = {
        timestamp: new Date().toISOString(),
        type: 'creditSnapshot',
        block: activeBlock ? {
          costUSD: activeBlock.costUSD,
          totalTokens: activeBlock.totalTokens,
          isActive: activeBlock.isActive,
          burnRate: activeBlock.burnRate || null,
          projection: activeBlock.projection || null,
        } : null,
        todayCostUSD,
      };

      this._lastCcusageCheck = now;
      this._lastCreditSnapshot = snapshot;
      return snapshot;
    } catch {
      return null;
    }
  }

  // ── Kill orphan bun processes ──────────────────────────────────────────────

  killOrphanBuns() {
    const protectedPids = new Set();
    for (const sess of SESSIONS) {
      const pid = this.tmuxPanePid(sess.name);
      if (pid) {
        protectedPids.add(pid);
        for (const d of this._getDescendants(pid)) protectedPids.add(d);
      }
    }

    let killed = 0;
    try {
      const bunPids = execSync('pgrep -f "bun.*server\\.ts" 2>/dev/null', {
        encoding: 'utf8', timeout: 3000,
      }).trim().split('\n').filter(Boolean).map(Number);

      for (const bunPid of bunPids) {
        if (!protectedPids.has(bunPid)) {
          try { process.kill(bunPid); killed++; } catch {}
        }
      }
    } catch {}
    return killed;
  }

  // ── AI Summarization ────────────────────────────────────────────────────────

  _callClaude(prompt) {
    if (this._lowPower) {
      return Promise.reject(new Error('Low-power mode — AI calls skipped'));
    }
    return new Promise((resolve, reject) => {
      const child = execFile(CLAUDE, ['-p', '-', '--output-format', 'json'], {
        env: { ...process.env, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        cwd: '/tmp',
      }, (err, stdout) => {
        if (err) { this._recordAiFailure(); return reject(err); }
        try {
          const parsed = JSON.parse(stdout);
          const text = parsed.result || parsed.content || stdout;
          if (typeof text === 'string') {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) { this._recordAiSuccess(); return resolve(JSON.parse(jsonMatch[0])); }
          }
          this._recordAiSuccess();
          resolve(parsed);
        } catch {
          try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) { this._recordAiSuccess(); return resolve(JSON.parse(jsonMatch[0])); }
          } catch {}
          this._recordAiFailure();
          reject(new Error('Failed to parse Claude response'));
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  async summarizeSession(sessName) {
    // Get scrollback — try managed sessions first, fall back to tmux capture
    let scrollback = '';
    const managed = this.sessionManager ? this.sessionManager.list() : [];
    const match = managed.find(s => s.name === sessName || s.tmuxName === sessName);
    if (match && typeof this.sessionManager.getScrollback === 'function') {
      // Optional legacy scrollback accessor (not present in v2 SessionManager;
      // provided by test mocks or watchdog-only session managers).
      const sb = this.sessionManager.getScrollback(match.id);
      scrollback = (sb instanceof Promise ? await sb : sb) || '';
    }
    if (!scrollback) {
      scrollback = this.tmuxCapture(sessName, 3000);
    }
    if (!scrollback) return null;

    const stripped = stripAnsi(scrollback);
    const offset = this._scrollbackOffsets[sessName] || 0;
    const delta = stripped.slice(offset);

    if (delta.length < MIN_DELTA_FOR_SUMMARY) return null;

    const text = delta.length > 8000 ? delta.slice(-8000) : delta;

    try {
      const result = await this._callClaude(SUMMARIZE_PROMPT + text);
      this._scrollbackOffsets[sessName] = stripped.length;

      const cardLabel = (result.cardLabel || '').trim();

      const entry = {
        timestamp: new Date().toISOString(),
        session: sessName,
        sessionId: match?.id || null,
        projectName: match?.projectName || null,
        summary: result.summary || '',
        keyActions: result.keyActions || [],
        state: result.state || 'productive',
        cardLabel,
      };

      // Store cardSummary on session meta so it's included in sessions:list
      if (match && this.sessionManager && this.sessionManager.sessions instanceof Map) {
        const liveSession = this.sessionManager.sessions.get(match.id);
        if (liveSession) {
          liveSession.meta.cardSummary = cardLabel;
        }
      }

      // Append to activity log
      this._appendLog(sessName, entry);

      // Feed into todoManager if it has a project
      if (this.todoManager && match && match.projectId) {
        const summaries = this.todoManager._loadSummaries(match.projectId);
        if (!summaries.sessions[match.id]) {
          summaries.sessions[match.id] = { lastSummarizedOffset: 0, entries: [] };
        }
        summaries.sessions[match.id].entries.push({
          id: crypto.randomUUID(),
          timestamp: entry.timestamp,
          sessionName: sessName,
          summary: entry.summary,
          keyActions: entry.keyActions,
        });
        if (summaries.sessions[match.id].entries.length > 20) {
          summaries.sessions[match.id].entries = summaries.sessions[match.id].entries.slice(-20);
        }
        summaries.sessions[match.id].lastSummarizedOffset = stripped.length;
        this.todoManager._saveSummaries(match.projectId, summaries);
      }

      // Record inflight state for error loop detection
      const fingerprint = (entry.keyActions[0] || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30);
      this._recordInflight(sessName, fingerprint, entry.state);

      // Emit for UI updates (includes cardLabel in entry spread)
      this.emit('summary', { session: sessName, ...entry, sessionId: match?.id, projectId: match?.projectId });

      return entry;
    } catch (err) {
      this.emit('error', err);
      return null;
    }
  }

  // ── Activity logs ──────────────────────────────────────────────────────────

  _logFile(sessName) {
    return path.join(this._logsDir, `${sessName}.json`);
  }

  _loadLog(sessName) {
    try {
      return JSON.parse(fs.readFileSync(this._logFile(sessName), 'utf8'));
    } catch {
      return [];
    }
  }

  _appendLog(sessName, entry) {
    const log = this._loadLog(sessName);
    log.push(entry);
    const trimmed = log.length > MAX_LOG_ENTRIES ? log.slice(-MAX_LOG_ENTRIES) : log;
    const target = this._logFile(sessName);
    const tmp = target + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
      fs.renameSync(tmp, target);
    } catch {
      // Best-effort fallback: write directly
      try { fs.writeFileSync(target, JSON.stringify(trimmed, null, 2)); } catch {}
    }
  }

  getLogFiles() {
    try {
      const managed = this.sessionManager ? this.sessionManager.list() : [];
      return fs.readdirSync(this._logsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const sessName = f.replace('.json', '');
          const stat = fs.statSync(path.join(this._logsDir, f));
          const match = managed.find(s => s.tmuxName === sessName || s.name === sessName);
          return {
            name: sessName,
            file: f,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            sessionId: match?.id || null,
            sessionName: match?.name || null,
            projectId: match?.projectId || null,
            projectName: match?.projectName || null,
          };
        });
    } catch {
      return [];
    }
  }

  getLog(sessName) {
    return this._loadLog(sessName);
  }

  getLogFormatted(sessName) {
    const entries = this._loadLog(sessName);
    return entries.map(e => {
      const time = new Date(e.timestamp).toLocaleString();
      const actions = (e.keyActions || []).map(a => `  - ${a}`).join('\n');
      return `[${time}] [${e.state || 'unknown'}]\n${e.summary}\n${actions}`;
    }).join('\n\n---\n\n');
  }

  // ── Learnings accumulation ─────────────────────────────────────────────────

  _loadLearnings() {
    try {
      return JSON.parse(fs.readFileSync(this._learningsFile, 'utf8'));
    } catch {
      return [];
    }
  }

  _saveLearnings(entries) {
    const trimmed = entries.length > LEARNINGS_MAX_ENTRIES ? entries.slice(-LEARNINGS_MAX_ENTRIES) : entries;
    const tmp = this._learningsFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
      fs.renameSync(tmp, this._learningsFile);
    } catch {
      try { fs.writeFileSync(this._learningsFile, JSON.stringify(trimmed, null, 2)); } catch {}
    }
  }

  addLearning(text, source = 'watchdog') {
    if (!text || text === 'NONE') return;
    const learnings = this._loadLearnings();
    learnings.push({
      timestamp: new Date().toISOString(),
      text,
      source,
    });
    this._saveLearnings(learnings);
  }

  getLearnings(limit = 50) {
    const all = this._loadLearnings();
    return limit ? all.slice(-limit) : all;
  }

  // ── Error loop detection ──────────────────────────────────────────────────

  _recordInflight(sessName, fingerprint, state) {
    if (!this._inflightHistory[sessName]) this._inflightHistory[sessName] = [];
    this._inflightHistory[sessName].push({
      timestamp: new Date().toISOString(),
      fingerprint,
      state,
    });
    if (this._inflightHistory[sessName].length > 20) {
      this._inflightHistory[sessName] = this._inflightHistory[sessName].slice(-20);
    }
  }

  _detectErrorLoop(sessName) {
    const history = this._inflightHistory[sessName];
    if (!history || history.length < ERROR_LOOP_THRESHOLD) return null;

    const recent = history.slice(-ERROR_LOOP_THRESHOLD);
    const allErrorLoop = recent.every(h => h.state === 'error_loop');
    if (!allErrorLoop) return null;

    const fp = recent[0].fingerprint;
    const allSameFp = recent.every(h => h.fingerprint === fp);
    if (!allSameFp) return null;

    return { fingerprint: fp, consecutive: ERROR_LOOP_THRESHOLD };
  }

  async _deepReview(sess, activity, tokenCount) {
    const now = Date.now() / 1000;
    const last = this._lastDeepReview[sess.name] || 0;
    if (now - last < DEEP_REVIEW_COOLDOWN_S) return null;

    this._lastDeepReview[sess.name] = now;

    const learnings = this.getLearnings(30);
    const learningsText = learnings.map(l => `- ${l.text}`).join('\n') || 'None yet.';

    const prompt = `You are a watchdog reviewing a Claude Code session that may be stuck.

Session: ${sess.name}
Tokens: ${tokenCount || 'unknown'}

## Recent Activity
${activity || 'No activity captured'}

## Accumulated Learnings
${learningsText}

Respond ONLY with JSON:
{"assessment": "brief assessment", "learnings": "new learnings or NONE", "intervention": "specific instruction to unstick the session or NONE", "handover": "handover plan if context restart needed or NONE"}`;

    try {
      const result = await this._callClaude(prompt);
      if (result.learnings && result.learnings !== 'NONE') {
        this.addLearning(result.learnings, 'deep_review');
      }
      return result;
    } catch {
      return null;
    }
  }

  // ── Resume context injection ──────────────────────────────────────────────

  async injectResumeContext(sess) {
    if (!this.safeToInject(sess.name)) return false;

    const parts = [];

    const log = this.getLog(sess.name);
    if (log.length > 0) {
      const last = log[log.length - 1];
      parts.push(`## Last Activity\n${last.summary}`);
      if (last.keyActions && last.keyActions.length) {
        parts.push(`Key actions: ${last.keyActions.join(', ')}`);
      }
    }

    const learnings = this.getLearnings(20);
    if (learnings.length > 0) {
      const text = learnings.map(l => `- ${l.text}`).join('\n');
      parts.push(`## Accumulated Learnings\n${text}`);
    }

    if (parts.length === 0) return false;

    const message = `Session restarted by watchdog. Context below — resume in-flight work:\n\n${parts.join('\n\n')}`;
    this.tmuxSendKeys(sess.name, message);
    this.emit('resumeInjected', { session: sess.name });
    await this._notify(sess, `📋 Resume context injected (${learnings.length} learnings)`);
    return true;
  }

  // ── Next-step suggestions ─────────────────────────────────────────────────

  async suggestNextStep(sess) {
    const now = Date.now() / 1000;
    const last = this._lastSuggestion[sess.name] || 0;
    if (now - last < SUGGESTION_COOLDOWN_S) return null;

    const log = this.getLog(sess.name);
    if (log.length < 2) return null;

    let projectContext = '';
    try {
      const claudeMd = path.join(sess.workdir, 'CLAUDE.md');
      if (fs.existsSync(claudeMd)) {
        projectContext = fs.readFileSync(claudeMd, 'utf8').slice(0, 3000);
      }
    } catch {}

    const recentLog = log.slice(-5).map(e => `[${e.state}] ${e.summary}`).join('\n');

    const prompt = `You are suggesting the next step for an idle Claude Code session.

Session: ${sess.name}
Working directory: ${sess.workdir}

## Project Context
${projectContext || 'No CLAUDE.md found'}

## Recent Activity
${recentLog}

Respond ONLY with JSON:
{"nextStep": "one specific actionable task", "why": "one sentence reason"}`;

    try {
      const result = await this._callClaude(prompt);
      this._lastSuggestion[sess.name] = now;

      if (result.nextStep) {
        await this._notify(sess, `💤 Session idle\n\n💡 Next: ${result.nextStep}\n\nWhy: ${result.why || ''}`);

        if (this.safeToInject(sess.name)) {
          this.tmuxSendKeys(sess.name, `Session idle. Suggested next step: ${result.nextStep}`);
        }

        this.emit('suggestion', { session: sess.name, ...result });
      }
      return result;
    } catch {
      return null;
    }
  }

  // ── Low-power mode ────────────────────────────────────────────────────────

  _recordAiSuccess() {
    this._aiFailCount = 0;
    if (this._lowPower) {
      this._lowPower = false;
      this.emit('lowPowerChanged', { active: false });
    }
  }

  _recordAiFailure() {
    this._aiFailCount++;
    if (this._aiFailCount >= LOW_POWER_AI_FAIL_THRESHOLD && !this._lowPower) {
      this._lowPower = true;
      this.emit('lowPowerChanged', { active: true, failCount: this._aiFailCount });
      for (const sess of SESSIONS) {
        this._notify(sess, '⚡ Low-power mode enabled — AI calls failing. Health checks continue.').catch(() => {});
      }
    }
  }

  isLowPower() {
    return this._lowPower;
  }

  // ── Safe to inject ─────────────────────────────────────────────────────────

  safeToInject(sessName) {
    if (!this.tmuxSessionExists(sessName)) return false;
    const pane = this.tmuxCapture(sessName, 8);
    if (!/Listening for channel|bypass permissions/.test(pane)) return false;
    if (/\(\d+m \d+s\)/.test(pane)) {
      return /Listening for channel|bypass permissions/.test(pane);
    }
    return true;
  }

  // ── Core tick ──────────────────────────────────────────────────────────────

  async tick() {
    // Respect the enabled setting — skip silently if watchdog is disabled
    if (this.settingsStore) {
      const watchdogSettings = await Promise.resolve(this.settingsStore.get('watchdog')).catch(() => null);
      if (watchdogSettings && watchdogSettings.enabled === false) return;

      // Apply intervalMinutes setting — reschedule timer if changed
      if (watchdogSettings?.intervalMinutes) {
        const newIntervalMs = Math.max(30_000, watchdogSettings.intervalMinutes * 60_000);
        if (newIntervalMs !== this._tickInterval) {
          this.start(newIntervalMs);
        }
      }
    }

    if (this._ticking) return;
    this._ticking = true;
    this._tickCount++;

    try {
      this._loadState();

      const now = Date.now() / 1000;

      // Credit check (every ~5 min)
      if (this._creditState === 'exhausted') {
        if (now - this._lastCreditCheck > CREDIT_CHECK_INTERVAL_S) {
          this._lastCreditCheck = now;
          if (await this.checkCredits()) {
            this._creditState = 'ok';
            for (const sess of SESSIONS) {
              await this._notify(sess, '✅ Credits restored — resuming');
            }
          } else {
            this._saveState();
            this.emit('tick', { count: this._tickCount, creditState: 'exhausted' });
            return;
          }
        } else {
          this._saveState();
          this.emit('tick', { count: this._tickCount, creditState: 'exhausted' });
          return;
        }
      }

      // Resource check (every ~5 min)
      if (now - this._lastResourceCheck > RESOURCE_CHECK_INTERVAL_S) {
        this._lastResourceCheck = now;
        const res = this.checkResources();
        if (res.alerts.length > 0) {
          const msg = `🖥️ Resource alert\n\n${res.alerts.join('\n')}`;
          for (const sess of SESSIONS) {
            await this._notify(sess, msg);
          }
          this.emit('resourceAlert', res);
        }
      }

      // ccusage credit snapshot (rate-limited internally to 5 min)
      const creditSnap = await this.checkCcusage();
      if (creditSnap) {
        for (const sess of SESSIONS) {
          this._appendLog(sess.name, { ...creditSnap, session: sess.name });
        }
        this.emit('creditSnapshot', creditSnap);
      }

      // Per-session health checks
      for (const sess of SESSIONS) {
        await this._checkSession(sess);
      }

      // Kill orphan bun processes
      this.killOrphanBuns();

      // Summarize sessions + derive TODOs
      const updatedProjects = new Set();

      // Summarize watchdog-monitored sessions (factory, factory2)
      for (const sess of SESSIONS) {
        if (!this.tmuxSessionExists(sess.name)) continue;
        try {
          const result = await this.summarizeSession(sess.name);
          if (result && this.sessionManager) {
            const managed = this.sessionManager.list();
            const match = managed.find(s => s.name === sess.name || s.tmuxName === sess.name);
            if (match && match.projectId) updatedProjects.add(match.projectId);
          }
        } catch (err) {
          this.emit('error', err);
        }
      }

      // Summarize all alive managed sessions (cm-* sessions from the web app)
      if (this.sessionManager) {
        const managedSessions = this.sessionManager.list();
        const watchdogNames = new Set(SESSIONS.map(s => s.name));
        for (const ms of managedSessions) {
          const tmuxName = ms.tmuxName || ms.name;
          if (watchdogNames.has(tmuxName)) continue;
          if (!this.tmuxSessionExists(tmuxName)) continue;
          try {
            const result = await this.summarizeSession(tmuxName);
            if (result && ms.projectId) updatedProjects.add(ms.projectId);
          } catch (err) {
            this.emit('error', err);
          }
        }
      }

      // Error loop detection + idle suggestions for watchdog sessions
      if (!this._lowPower) {
        for (const sess of SESSIONS) {
          if (!this.tmuxSessionExists(sess.name)) continue;
          try {
            const loop = this._detectErrorLoop(sess.name);
            if (loop) {
              const log = this.getLog(sess.name);
              const activity = log.slice(-3).map(e => e.summary).join('\n');
              const tokens = this.getContextTokens(sess.name);
              const review = await this._deepReview(sess, activity, tokens);
              if (review && review.intervention && review.intervention !== 'NONE') {
                if (this.safeToInject(sess.name)) {
                  this.tmuxSendKeys(sess.name, review.intervention);
                  await this._notify(sess, `🚨 Intervention sent: ${review.intervention.slice(0, 200)}`);
                } else {
                  await this._notify(sess, `🚨 Intervention needed but session busy: ${review.intervention.slice(0, 200)}`);
                }
              }
              this.emit('errorLoop', { session: sess.name, ...loop, review });
            }

            const lastLog = this.getLog(sess.name);
            const lastEntry = lastLog[lastLog.length - 1];
            if (lastEntry && lastEntry.state === 'idle') {
              await this.suggestNextStep(sess);
            }
          } catch (err) {
            this.emit('error', err);
          }
        }
      }

      // Derive TODOs for projects that got new summaries
      if (this.todoManager) {
        for (const projectId of updatedProjects) {
          try {
            await this.todoManager.deriveTodos(projectId);
          } catch (err) {
            this.emit('error', err);
          }
        }
      }

      this._saveState();

      // Broadcast watchdog:tick to all connected clients
      if (this.clientRegistry) {
        this.clientRegistry.broadcast({
          type: 'watchdog:tick',
          count: this._tickCount,
          creditState: this._creditState,
          lowPower: this._lowPower,
        });
      }

      this.emit('tick', { count: this._tickCount, creditState: this._creditState, lowPower: this._lowPower });
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._ticking = false;
    }
  }

  async _checkSession(sess) {
    const st = this._state[sess.name];

    // Capture pane BEFORE checking existence — if the session just died,
    // the tmux pane may still have the last output (scrollback buffer).
    const lastPane = this.tmuxCapture(sess.name, 50);

    // Dead session?
    if (!this.tmuxSessionExists(sess.name)) {
      if (this._isRestartPaused(sess.name)) {
        this.emit('sessionEvent', { session: sess.name, event: 'restart_paused' });
        return;
      }

      // Check for credit exhaustion in last capture
      if (/credit|quota|billing|402|payment required|insufficient_quota/i.test(lastPane)) {
        this._creditState = 'exhausted';
        await this._notify(sess, '⛔ Credits exhausted — session paused');
        return;
      }

      await this._notify(sess, `⚠️ ${sess.name} crashed — restarting now`);
      await this._startSession(sess);
      const count = this._incrementRestart(sess.name);
      await new Promise(r => setTimeout(r, 4000));

      if (await this._waitForReady(sess.name)) {
        await this._notify(sess, `✅ ${sess.name} restarted (attempt ${count})`);
        try { await this.injectResumeContext(sess); } catch {}
        if (count >= RESTART_PAUSE_AFTER) {
          await this._notify(sess, `⚠️ ${sess.name} restarted ${count} times — pausing restarts for ${RESTART_PAUSE_MINS} min`);
        }
      } else {
        await this._notify(sess, `❌ ${sess.name} restart failed — not ready after 40s`);
      }
      return;
    }

    // Session exists — reset restart counter
    this._resetRestart(sess.name);

    // MCP health
    const mcp = this.checkMcpAlive(sess.name);
    if (!mcp.alive) {
      await this._notify(sess, `⚠️ Telegram MCP crashed for ${sess.name} — restarting`);
      if (mcp.claudePid) { try { process.kill(mcp.claudePid); } catch {} }
      await new Promise(r => setTimeout(r, 2000));
      try { execSync(`${TMUX} kill-session -t ${JSON.stringify(sess.name)} 2>/dev/null`); } catch {}
      await new Promise(r => setTimeout(r, 1000));
      await this._startSession(sess);
      st.lastMcpRestart = Date.now() / 1000;
      this._incrementRestart(sess.name);

      if (await this._waitForReady(sess.name)) {
        await this._notify(sess, `✅ ${sess.name} MCP restarted`);
      } else {
        await this._notify(sess, `⚠️ ${sess.name} MCP restart — readiness check failed`);
      }
      return;
    }

    // Rate limit
    const rl = this.checkRateLimit(sess.name);
    if (rl.limited) {
      if (rl.dismissed) {
        await this._notify(sess, '✅ Rate limit reset — session resumed');
      } else {
        await this._notify(sess, `⏳ Rate limit active — resets in ${rl.minsLeft} min`);
      }
      return;
    }

    // Context size
    await this.handleContext(sess);
  }

  /**
   * Get a summary of current watchdog state (for REST API).
   * @returns {object}
   */
  getSummary() {
    return {
      lastTick: this._tickCount > 0 ? new Date().toISOString() : null,
      sessionCount: SESSIONS.length,
      creditState: this._creditState,
      lowPower: this._lowPower,
      tickCount: this._tickCount,
      lastCreditSnapshot: this._lastCreditSnapshot,
      sessions: Object.fromEntries(
        Object.entries(this._state).map(([name, st]) => [name, { ...st }])
      ),
    };
  }

  // ── Session lifecycle logging ───────────────────────────────────────────────

  _lifecycleFile() {
    return path.join(this.dataDir, 'session-lifecycle.json');
  }

  _loadLifecycle() {
    try {
      const raw = fs.readFileSync(this._lifecycleFile(), 'utf8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  /**
   * Append one lifecycle event (create/delete) to session-lifecycle.json.
   * Fire-and-forget safe — never throws.
   * @param {{ event: string, session: object, channelId: string|null }} opts
   */
  async logSessionLifecycle({ event, session, channelId }) {
    try {
      const entries = this._loadLifecycle();
      entries.push({
        event,
        sessionId: session.id,
        name: session.name,
        projectId: session.projectId,
        channelId: channelId || null,
        ts: new Date().toISOString(),
      });
      const capped = entries.slice(-500);
      fs.mkdirSync(this.dataDir, { recursive: true });
      const target = this._lifecycleFile();
      const tmp = target + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(capped, null, 2));
      fs.renameSync(tmp, target);
    } catch { /* lifecycle logging is observational — never block callers */ }
  }
}
