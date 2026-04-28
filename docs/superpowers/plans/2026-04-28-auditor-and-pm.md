# Auditor & Program Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nightly Auditor (daily governance digest + Friday weekly review) and Program Manager (backlog + sprint management) to WatchdogManager, both running as automated timed jobs that communicate through markdown files.

**Architecture:** Two new async methods (`auditDaily()`/`auditWeeklyReview()` and `pmCycle()`) on WatchdogManager, triggered by clock-based scheduling in `tick()`. A new `_callClaudeThinking()` method handles extended-thinking AI calls. Each writes markdown files per project; the PM reads the Auditor's output. A `/pm` skill provides manual interaction.

**Tech Stack:** Node.js (ESM), Claude CLI with `--thinking` flag, Jest for tests, markdown file I/O, existing SettingsStore for configuration.

**Spec:** `docs/superpowers/specs/2026-04-28-auditor-and-pm-design.md`

---

## File Structure

### New files:
| File | Responsibility |
|------|---------------|
| `lib/watchdog/auditor.js` | Auditor logic: context gathering, prompt construction, digest/review writing, recommendation tracking |
| `lib/watchdog/pm.js` | PM logic: backlog parsing/writing, sprint updates, CLAUDE.md section management, seeding |
| `lib/watchdog/scheduling.js` | Clock-based daily scheduling helper (shared by both) |
| `tests/unit/auditor.test.js` | Unit tests for Auditor |
| `tests/unit/pm.test.js` | Unit tests for PM |
| `tests/unit/scheduling.test.js` | Unit tests for scheduler |
| `~/.claude/skills/pm/SKILL.md` | `/pm` skill definition |

### Modified files:
| File | Changes |
|------|---------|
| `lib/watchdog/WatchdogManager.js` | Add `_callClaudeThinking()`, scheduling state, wire auditor/pm into `tick()` and `start()`/`stop()` |
| `lib/settings/SettingsStore.js` | Add `auditor` and `pm` keys to DEFAULTS |
| `lib/api/routes.js` | Add GET `/api/audit/*` and `/api/pm/*` routes |

---

## Task 1: Clock-Based Daily Scheduler

**Files:**
- Create: `lib/watchdog/scheduling.js`
- Test: `tests/unit/scheduling.test.js`

The scheduler checks if a named job should run based on UTC hour and a "last run date" tracker. No setInterval — it piggybacks on the existing 30-second tick.

- [ ] **Step 1: Write the failing test for shouldRun()**

```javascript
// tests/unit/scheduling.test.js
import { DailyScheduler } from '../../lib/watchdog/scheduling.js';

describe('DailyScheduler', () => {
  test('shouldRun returns true when hour matches and not yet run today', () => {
    const sched = new DailyScheduler();
    // Simulate: it's 2am UTC, job configured for hour 2, never run
    const now = new Date('2026-04-28T02:15:00Z');
    expect(sched.shouldRun('audit', 2, now)).toBe(true);
  });

  test('shouldRun returns false when already run today', () => {
    const sched = new DailyScheduler();
    const now = new Date('2026-04-28T02:15:00Z');
    sched.markRun('audit', now);
    expect(sched.shouldRun('audit', 2, now)).toBe(false);
  });

  test('shouldRun returns false when hour has not arrived', () => {
    const sched = new DailyScheduler();
    const now = new Date('2026-04-28T01:30:00Z');
    expect(sched.shouldRun('audit', 2, now)).toBe(false);
  });

  test('shouldRun returns true on a new day', () => {
    const sched = new DailyScheduler();
    const yesterday = new Date('2026-04-27T02:15:00Z');
    sched.markRun('audit', yesterday);
    const today = new Date('2026-04-28T02:15:00Z');
    expect(sched.shouldRun('audit', 2, today)).toBe(true);
  });

  test('isWeeklyDay returns true on matching day', () => {
    const sched = new DailyScheduler();
    const friday = new Date('2026-05-01T02:00:00Z'); // Friday
    expect(sched.isWeeklyDay('friday', friday)).toBe(true);
    expect(sched.isWeeklyDay('monday', friday)).toBe(false);
  });

  test('getState/loadState round-trips', () => {
    const sched = new DailyScheduler();
    sched.markRun('audit', new Date('2026-04-28T02:00:00Z'));
    sched.markRun('pm', new Date('2026-04-28T04:00:00Z'));
    const state = sched.getState();

    const sched2 = new DailyScheduler();
    sched2.loadState(state);
    expect(sched2.shouldRun('audit', 2, new Date('2026-04-28T02:30:00Z'))).toBe(false);
    expect(sched2.shouldRun('pm', 4, new Date('2026-04-28T04:30:00Z'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/scheduling.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement scheduling.js**

```javascript
// lib/watchdog/scheduling.js

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export class DailyScheduler {
  constructor() {
    this._lastRunDates = {}; // jobName → 'YYYY-MM-DD'
  }

  shouldRun(jobName, hourUTC, now = new Date()) {
    const currentHour = now.getUTCHours();
    if (currentHour < hourUTC) return false;

    const todayStr = now.toISOString().slice(0, 10);
    return this._lastRunDates[jobName] !== todayStr;
  }

  markRun(jobName, now = new Date()) {
    this._lastRunDates[jobName] = now.toISOString().slice(0, 10);
  }

  isWeeklyDay(dayName, now = new Date()) {
    return DAY_NAMES[now.getUTCDay()] === dayName.toLowerCase();
  }

  getState() {
    return { ...this._lastRunDates };
  }

  loadState(state) {
    if (state && typeof state === 'object') {
      this._lastRunDates = { ...state };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/scheduling.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog/scheduling.js tests/unit/scheduling.test.js
git commit -m "feat: add DailyScheduler for clock-based nightly job triggering"
```

---

## Task 2: Settings Schema — Add Auditor and PM Defaults

**Files:**
- Modify: `lib/settings/SettingsStore.js:19-73` (DEFAULTS object)
- Test: `tests/unit/SettingsStore.test.js` (add new test cases)

The SettingsStore `deepMerge` only merges keys that exist in DEFAULTS. New settings MUST be added to DEFAULTS or `set()` will silently ignore them.

- [ ] **Step 1: Write the failing test**

Add to the existing `tests/unit/SettingsStore.test.js`:

```javascript
test('auditor defaults exist with correct shape', async () => {
  const settings = new SettingsStore({ filePath: path.join(tmpDir, 'settings.json') });
  const auditor = await settings.get('auditor');
  expect(auditor).toEqual({
    enabled: true,
    dailyHourUTC: 2,
    weeklyDay: 'friday',
    lookbackDays: 14,
    projects: [],
  });
});

test('pm defaults exist with correct shape', async () => {
  const settings = new SettingsStore({ filePath: path.join(tmpDir, 'settings.json') });
  const pm = await settings.get('pm');
  expect(pm).toEqual({
    enabled: true,
    dailyHourUTC: 4,
    sprintSize: 5,
    projects: [],
  });
});

test('auditor settings can be updated via set()', async () => {
  const settings = new SettingsStore({ filePath: path.join(tmpDir, 'settings.json') });
  await settings.set({ auditor: { dailyHourUTC: 3 } });
  const auditor = await settings.get('auditor');
  expect(auditor.dailyHourUTC).toBe(3);
  expect(auditor.enabled).toBe(true); // other keys preserved
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/SettingsStore.test.js`
Expected: FAIL — `auditor` is undefined

- [ ] **Step 3: Add DEFAULTS entries**

In `lib/settings/SettingsStore.js`, add after the `lowCredit` block (around line 51):

```javascript
  // Auditor settings (nightly governance review)
  auditor: {
    enabled: true,
    dailyHourUTC: 2,
    weeklyDay: 'friday',
    lookbackDays: 14,
    projects: [],
  },
  // Program Manager settings (nightly backlog/sprint management)
  pm: {
    enabled: true,
    dailyHourUTC: 4,
    sprintSize: 5,
    projects: [],
  },
```

Note: `projects` defaults to `[]` (empty). On first audit run, if empty, the Auditor auto-detects active projects from the existing `data/projects.json` via ProjectStore.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/SettingsStore.test.js`
Expected: All tests PASS (including new ones)

- [ ] **Step 5: Commit**

```bash
git add lib/settings/SettingsStore.js tests/unit/SettingsStore.test.js
git commit -m "feat: add auditor and pm settings to SettingsStore defaults"
```

---

## Task 3: Extended Thinking Claude Call

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js:658-691` (add new method after `_callClaude`)
- Test: `tests/unit/WatchdogManager.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/WatchdogManager.test.js`:

```javascript
describe('_callClaudeThinking', () => {
  test('method exists and returns a promise', () => {
    expect(typeof watchdog._callClaudeThinking).toBe('function');
    // Don't actually call it — just verify the interface
    const promise = watchdog._callClaudeThinking('test');
    expect(promise).toBeInstanceOf(Promise);
    // Will reject because claude binary isn't available in test
    promise.catch(() => {});
  });

  test('rejects in low-power mode by default', async () => {
    watchdog._lowPower = true;
    await expect(watchdog._callClaudeThinking('test'))
      .rejects.toThrow('Low-power mode');
  });

  test('bypasses low-power mode with force option', () => {
    watchdog._lowPower = true;
    const promise = watchdog._callClaudeThinking('test', { force: true });
    expect(promise).toBeInstanceOf(Promise);
    // Will reject because claude binary isn't available, but it shouldn't
    // reject with "Low-power mode"
    promise.catch((err) => {
      expect(err.message).not.toMatch(/Low-power mode/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/WatchdogManager.test.js`
Expected: FAIL — `_callClaudeThinking` is not a function

- [ ] **Step 3: Implement _callClaudeThinking()**

Add after `_callClaude()` (after line 691) in `WatchdogManager.js`:

```javascript
  _callClaudeThinking(prompt, { force = false, timeoutMs = 300000 } = {}) {
    if (this._lowPower && !force) {
      return Promise.reject(new Error('Low-power mode — AI calls skipped'));
    }
    return new Promise((resolve, reject) => {
      const child = execFile(CLAUDE, ['-p', '-', '--output-format', 'json', '--thinking'], {
        env: { ...process.env, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        cwd: '/tmp',
      }, (err, stdout) => {
        if (err) { this._recordAiFailure(); return reject(err); }
        try {
          const parsed = JSON.parse(stdout);
          const text = parsed.result || parsed.content || stdout;
          if (typeof text === 'string') {
            this._recordAiSuccess();
            return resolve(text);
          }
          this._recordAiSuccess();
          resolve(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
        } catch {
          this._recordAiSuccess();
          resolve(stdout);
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
```

Key differences from `_callClaude()`:
- Adds `--thinking` flag to Claude CLI args
- `force` option bypasses low-power mode (for nightly jobs that should retry)
- Higher timeout (5 min vs 90s) for deep reasoning
- Larger maxBuffer (4MB vs 1MB) for thinking output
- Returns raw text (markdown), not parsed JSON — audit/PM outputs are markdown documents

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/WatchdogManager.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog/WatchdogManager.js tests/unit/WatchdogManager.test.js
git commit -m "feat: add _callClaudeThinking() for extended-thinking AI calls"
```

---

## Task 4: Auditor — Context Gathering

**Files:**
- Create: `lib/watchdog/auditor.js`
- Test: `tests/unit/auditor.test.js`

This module exports pure functions that gather and format audit context from the filesystem. No AI calls — just data collection.

- [ ] **Step 1: Write the failing test for buildAuditContext()**

```javascript
// tests/unit/auditor.test.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildAuditContext, buildClosedSessionReport, formatContextForPrompt } from '../../lib/watchdog/auditor.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-test-'));
  // Create minimal data structure
  fs.mkdirSync(path.join(tmpDir, 'activity-logs'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'audit', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'credit-history.json'), '[]');
  fs.writeFileSync(path.join(tmpDir, 'health.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'session-lifecycle.json'), '[]');
  fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '{"sessions":{}}');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildAuditContext', () => {
  test('returns structured context with all sections', () => {
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    expect(ctx).toHaveProperty('creditHistory');
    expect(ctx).toHaveProperty('healthSignals');
    expect(ctx).toHaveProperty('sessionLifecycle');
    expect(ctx).toHaveProperty('activityLogs');
    expect(ctx).toHaveProperty('closedSessions');
    expect(ctx).toHaveProperty('timestamp');
  });

  test('filters activity logs to lookback window', () => {
    const now = new Date();
    const old = new Date(now.getTime() - 48 * 3600 * 1000);
    const recent = new Date(now.getTime() - 2 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'activity-logs', 'factory.json'), JSON.stringify([
      { timestamp: old.toISOString(), summary: 'old entry' },
      { timestamp: recent.toISOString(), summary: 'recent entry' },
    ]));
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    expect(ctx.activityLogs).toHaveLength(1);
    expect(ctx.activityLogs[0].summary).toBe('recent entry');
  });
});

describe('buildClosedSessionReport', () => {
  test('identifies sessions active in window but now stopped', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      sessions: {
        's1': { id: 's1', name: 'test', status: 'stopped', exitedAt: recent.toISOString() },
      },
    }));
    const report = buildClosedSessionReport({ dataDir: tmpDir, lookbackHours: 24 });
    expect(report).toHaveLength(1);
    expect(report[0].id).toBe('s1');
    expect(report[0].status).toBe('stopped');
  });
});

describe('formatContextForPrompt', () => {
  test('produces a non-empty string', () => {
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    const text = formatContextForPrompt(ctx);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/auditor.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement auditor.js — data gathering functions**

```javascript
// lib/watchdog/auditor.js
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export function buildAuditContext({ dataDir, lookbackHours = 24, projectPaths = [] }) {
  const cutoff = new Date(Date.now() - lookbackHours * 3600 * 1000);

  const creditHistory = _loadJson(path.join(dataDir, 'credit-history.json'), []);
  const healthSignals = _loadJson(path.join(dataDir, 'health.json'), {});
  const sessionLifecycle = _loadJson(path.join(dataDir, 'session-lifecycle.json'), [])
    .filter(e => new Date(e.ts) >= cutoff);

  const activityLogs = _loadActivityLogs(path.join(dataDir, 'activity-logs'), cutoff);
  const closedSessions = buildClosedSessionReport({ dataDir, lookbackHours });

  const gitLogs = {};
  for (const p of projectPaths) {
    gitLogs[p] = _getGitLog(p, lookbackHours);
  }

  // Beta/prod gap for v2 project
  const v2Path = projectPaths.find(p => p.includes('claude-web-app-v2'));
  const betaProdGap = v2Path ? getBetaProdGap(v2Path) : null;

  return {
    timestamp: new Date().toISOString(),
    lookbackHours,
    creditHistory: creditHistory.slice(-48),
    healthSignals,
    sessionLifecycle,
    activityLogs,
    closedSessions,
    gitLogs,
    betaProdGap,
  };
}

export function buildClosedSessionReport({ dataDir, lookbackHours = 24 }) {
  const cutoff = new Date(Date.now() - lookbackHours * 3600 * 1000);
  const sessionsData = _loadJson(path.join(dataDir, 'sessions.json'), { sessions: {} });
  const sessions = sessionsData.sessions || {};
  const result = [];

  for (const [id, meta] of Object.entries(sessions)) {
    if (meta.status === 'running' || meta.status === 'starting') continue;
    const timestamps = [meta.exitedAt, meta.lastActiveAt, meta.startedAt]
      .filter(Boolean).map(t => new Date(t));
    const mostRecent = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
    if (!mostRecent || mostRecent < cutoff) continue;

    const logFile = path.join(dataDir, 'activity-logs', `${meta.tmuxName || meta.name || id}.json`);
    const logs = _loadJson(logFile, []);
    const recentLogs = logs.filter(e => e.timestamp && new Date(e.timestamp) >= cutoff);

    let archiveData = null;
    const archivePath = path.join(dataDir, 'session-archive', `${id}.json`);
    if (fs.existsSync(archivePath)) {
      archiveData = _loadJson(archivePath, null);
    }

    result.push({
      id,
      name: meta.name,
      status: meta.status,
      startedAt: meta.startedAt,
      exitedAt: meta.exitedAt,
      activityLogEntries: recentLogs.length,
      lastSummary: recentLogs.length > 0 ? recentLogs[recentLogs.length - 1].summary : null,
      archived: !!archiveData,
      hasActivityLog: logs.length > 0,
    });
  }
  return result;
}

export function buildProjectContext(projectPath) {
  const claudeMd = _readFileOr(path.join(projectPath, 'CLAUDE.md'), '');
  const backlog = _readFileOr(path.join(projectPath, 'BACKLOG.md'), '');
  const recommendations = _readFileOr(path.join(projectPath, 'AUDIT-DIGESTS', 'recommendations.md'), '');
  const blindSpots = _readFileOr(path.join(projectPath, 'AUDIT-DIGESTS', 'blind-spots.md'), '');
  const gitLog = _getGitLog(projectPath, 24);
  return { claudeMd, backlog, recommendations, blindSpots, gitLog };
}

export function formatContextForPrompt(ctx, projectCtx = null) {
  const parts = [];
  parts.push(`## Audit Window\nTimestamp: ${ctx.timestamp}\nLookback: ${ctx.lookbackHours} hours\n`);

  if (ctx.activityLogs.length > 0) {
    parts.push(`## Session Activity (${ctx.activityLogs.length} entries)`);
    for (const e of ctx.activityLogs.slice(-30)) {
      parts.push(`[${e.timestamp}] [${e.session || '?'}] [${e.state || '?'}] ${e.summary || ''}`);
    }
  }

  if (ctx.closedSessions.length > 0) {
    parts.push(`\n## Closed Sessions (${ctx.closedSessions.length})`);
    for (const s of ctx.closedSessions) {
      const logNote = s.hasActivityLog ? `${s.activityLogEntries} log entries` : 'NO ACTIVITY LOG (blind spot)';
      parts.push(`- ${s.name || s.id}: ${s.status}, ${logNote}, last: ${s.lastSummary || 'none'}`);
    }
  }

  if (ctx.sessionLifecycle.length > 0) {
    parts.push(`\n## Session Lifecycle Events (${ctx.sessionLifecycle.length})`);
    for (const e of ctx.sessionLifecycle.slice(-20)) {
      parts.push(`[${e.ts}] ${e.event}: ${e.name || e.sessionId}`);
    }
  }

  if (ctx.creditHistory.length > 0) {
    const latest = ctx.creditHistory[ctx.creditHistory.length - 1];
    parts.push(`\n## Credit Snapshot`);
    parts.push(`Block cost: $${latest.blockCostUSD?.toFixed(2) || '?'}`);
    parts.push(`Today: $${latest.todayCostUSD?.toFixed(2) || '?'}`);
    parts.push(`Burn rate: $${latest.burnRateCostPerHour?.toFixed(4) || '?'}/hr`);
    if (latest.breakdown) {
      parts.push(`Breakdown: factory=$${latest.breakdown.factory?.toFixed(0)}, watchdog=$${latest.breakdown.watchdog?.toFixed(0)}, devV2=$${latest.breakdown.devV2?.toFixed(0)}, devV1=$${latest.breakdown.devV1?.toFixed(0)}`);
    }
  }

  for (const [projPath, log] of Object.entries(ctx.gitLogs || {})) {
    if (log) {
      parts.push(`\n## Git Log: ${projPath}`);
      parts.push(log.slice(0, 3000));
    }
  }

  if (ctx.betaProdGap) {
    parts.push(`\n## Beta/Prod Gap`);
    parts.push(`Commits on beta not yet on prod: ${ctx.betaProdGap.commitCount}`);
    parts.push(ctx.betaProdGap.commits.slice(0, 1000));
  }

  if (projectCtx) {
    if (projectCtx.claudeMd) {
      parts.push(`\n## Project CLAUDE.md (truncated)`);
      parts.push(projectCtx.claudeMd.slice(0, 4000));
    }
    if (projectCtx.backlog) {
      parts.push(`\n## Current BACKLOG.md`);
      parts.push(projectCtx.backlog.slice(0, 3000));
    }
    if (projectCtx.recommendations) {
      parts.push(`\n## Recommendations Tracker`);
      parts.push(projectCtx.recommendations.slice(0, 2000));
    }
    if (projectCtx.blindSpots) {
      parts.push(`\n## Blind Spots`);
      parts.push(projectCtx.blindSpots.slice(0, 1000));
    }
  }

  return parts.join('\n');
}

export function loadPreviousDigests(projectPath, count = 14) {
  const dir = path.join(projectPath, 'AUDIT-DIGESTS', 'daily');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .slice(-count);
  return files.map(f => ({
    date: f.replace('.md', ''),
    content: fs.readFileSync(path.join(dir, f), 'utf8'),
  }));
}

export function writeDigest(projectPath, date, content) {
  const dir = path.join(projectPath, 'AUDIT-DIGESTS', 'daily');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${date}.md`);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

export function writeWeeklyReview(projectPath, date, content) {
  const dir = path.join(projectPath, 'AUDIT-DIGESTS', 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${date}-weekly.md`);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

export function updateRecommendations(projectPath, newEntries) {
  const file = path.join(projectPath, 'AUDIT-DIGESTS', 'recommendations.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = _readFileOr(file, '# Recommendations Tracker\n\n| ID | Date | Recommendation | Source | Status | Outcome |\n|----|------|---------------|--------|--------|---------|\n');
  let content = existing;
  for (const entry of newEntries) {
    content += `| ${entry.id} | ${entry.date} | ${entry.recommendation} | ${entry.source} | open | — |\n`;
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function updateBlindSpots(projectPath, spots) {
  const file = path.join(projectPath, 'AUDIT-DIGESTS', 'blind-spots.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = '# Blind Spots\n\n';
  for (const spot of spots) {
    content += `## ${spot.gap}\n- **Reason:** ${spot.reason}\n- **Requirement:** ${spot.requirement}\n- **Priority:** ${spot.priority}\n\n`;
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Prune daily digests older than 90 days
export function pruneOldDigests(projectPath, keepDays = 90) {
  const dir = path.join(projectPath, 'AUDIT-DIGESTS', 'daily');
  if (!fs.existsSync(dir)) return 0;
  const cutoff = new Date(Date.now() - keepDays * 86400 * 1000).toISOString().slice(0, 10);
  const archiveDir = path.join(projectPath, 'AUDIT-DIGESTS', 'archive');
  let moved = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const date = f.replace('.md', '');
    if (date < cutoff) {
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.renameSync(path.join(dir, f), path.join(archiveDir, f));
      moved++;
    }
  }
  return moved;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function _loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function _readFileOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

function _loadActivityLogs(logsDir, cutoff) {
  if (!fs.existsSync(logsDir)) return [];
  const result = [];
  for (const f of fs.readdirSync(logsDir).filter(f => f.endsWith('.json'))) {
    const entries = _loadJson(path.join(logsDir, f), []);
    for (const e of entries) {
      if (e.timestamp && new Date(e.timestamp) >= cutoff && e.summary) {
        result.push({ ...e, session: f.replace('.json', '') });
      }
    }
  }
  return result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function _getGitLog(projectPath, hours) {
  try {
    return execSync(`git log --since="${hours} hours ago" --oneline --no-decorate`, {
      cwd: projectPath, encoding: 'utf8', timeout: 5000,
    }).trim();
  } catch { return ''; }
}

export function getBetaProdGap(v2Path) {
  const betaPath = v2Path + '-beta';
  try {
    const diff = execSync('git log main..HEAD --oneline --no-decorate 2>/dev/null', {
      cwd: betaPath, encoding: 'utf8', timeout: 5000,
    }).trim();
    const commitCount = diff ? diff.split('\n').length : 0;
    return { betaPath, commitCount, commits: diff || 'beta is up to date with main' };
  } catch { return { betaPath, commitCount: 0, commits: 'could not determine beta/prod gap' }; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/auditor.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog/auditor.js tests/unit/auditor.test.js
git commit -m "feat: add Auditor context gathering and file management"
```

---

## Task 5: Auditor — Prompt and Daily Digest

**Files:**
- Modify: `lib/watchdog/auditor.js` (add prompt constants and digest generation)
- Modify: `lib/watchdog/WatchdogManager.js` (add `auditDaily()` method)

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/auditor.test.js`:

```javascript
import { AUDIT_DAILY_PROMPT, AUDIT_WEEKLY_PROMPT } from '../../lib/watchdog/auditor.js';

describe('audit prompts', () => {
  test('daily prompt includes all 13 dimensions', () => {
    expect(AUDIT_DAILY_PROMPT).toContain('Change management');
    expect(AUDIT_DAILY_PROMPT).toContain('Strategy alignment');
    expect(AUDIT_DAILY_PROMPT).toContain('Recurring failures');
    expect(AUDIT_DAILY_PROMPT).toContain('Cost efficiency');
    expect(AUDIT_DAILY_PROMPT).toContain('Security');
    expect(AUDIT_DAILY_PROMPT).toContain('Documentation gaps');
    expect(AUDIT_DAILY_PROMPT).toContain('Process improvement');
    expect(AUDIT_DAILY_PROMPT).toContain('Meaningful interactions');
    expect(AUDIT_DAILY_PROMPT).toContain('User sentiment');
    expect(AUDIT_DAILY_PROMPT).toContain('Work patterns');
    expect(AUDIT_DAILY_PROMPT).toContain('Credit utilization');
    expect(AUDIT_DAILY_PROMPT).toContain('Lost');
    expect(AUDIT_DAILY_PROMPT).toContain('Blind spot');
  });

  test('weekly prompt includes scoring and recommendation review', () => {
    expect(AUDIT_WEEKLY_PROMPT).toContain('score');
    expect(AUDIT_WEEKLY_PROMPT).toContain('recommendation');
    expect(AUDIT_WEEKLY_PROMPT).toContain('trend');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/auditor.test.js`
Expected: FAIL — AUDIT_DAILY_PROMPT not exported

- [ ] **Step 3: Add prompt constants to auditor.js**

Add at the top of `lib/watchdog/auditor.js`, after imports:

```javascript
export const AUDIT_DAILY_PROMPT = `You are a senior engineering consultant performing a daily governance audit of an autonomous multi-agent software operation. You think like a CISA-qualified auditor: thorough, honest, and focused on actionable findings.

Review the data below and produce a daily digest covering all 13 audit dimensions. For each dimension, report:
- **Status:** GREEN (no issues), AMBER (minor issues/watch items), RED (action required)
- **Findings:** Specific observations with evidence
- **Recommendations:** Actionable improvements (if any)

## The 13 Audit Dimensions

1. **Change management** — Did commits have tests? Were features documented? Did anything ship without going through dev/qa skills? Are there commits with no context?
2. **Strategy alignment** — Is the work matching the project roadmap phases? Are factory sessions doing what the Current Sprint says? Is unplanned work creeping in?
3. **Recurring failures** — Same errors repeating, sessions stuck in loops, watchdog restarting the same thing, identical error fingerprints across days
4. **Cost efficiency** — Burn rate trends, idle sessions wasting credits, subagent costs, periods where credits go unused (could have been doing background work)
5. **Security & hygiene** — Leaked tokens in logs, stale sessions with open tmux, orphan processes, disk usage creep, sensitive files in commits
6. **Documentation gaps** — Features that shipped without decision docs, CLAUDE.md out of date, missing test coverage, undocumented API endpoints
7. **Process improvement** — Are skills/prompts/gates effective? Could the dev skill's design phase be sharper? Is the QA skill catching real issues? Missing gates? Should factory sessions have better system prompts? Think like a principal engineer advising on how to run a better AI-driven development operation.
8. **Meaningful interactions** — Significant decisions made in conversations, requirements clarified, design choices confirmed, breakthroughs. Institutional knowledge that should be preserved.
9. **User sentiment** — Frustration signals: repeated corrections, terse responses, sessions killed mid-task, "I already told you" patterns. Is the system getting more helpful or more annoying over time?
10. **Work patterns** — Times of day the user is active, productivity patterns, weekend vs. weekday. When should intensive autonomous work be scheduled?
11. **Credit utilization** — Not just spend but efficiency. Are credits approaching limits with no alert? Idle periods where factory sessions could do background work? Waste detection.
12. **Lost & repeated work** — Sessions that did the same task twice, abandoned branches with significant work, features implemented then reverted, merge conflicts that destroyed changes.
13. **Blind spot detection** — What can you NOT assess from the data provided? What instrumentation is missing? What would you need for a more complete picture? Format each blind spot as: gap, reason, requirement, priority.

## Output Format

Write your response as a markdown document with this structure:

# Daily Audit Digest — {date}

## Summary
(3-5 sentence executive summary with top findings)

## Dimension Findings

### 1. Change Management — {GREEN/AMBER/RED}
(findings and recommendations)

### 2. Strategy Alignment — {GREEN/AMBER/RED}
(findings and recommendations)

... (all 13 dimensions)

## New Recommendations
(numbered list: R-XXX: recommendation text | source: dimension N)

## New Blind Spots
(structured list if any gaps found)

## Top 3 Action Items
(prioritized list of what to fix first)

---

DATA:
`;

export const AUDIT_WEEKLY_PROMPT = `You are a senior engineering consultant performing a weekly governance review. You have 14 days of daily audit digests. Your job is to find patterns, assess trend direction, score governance dimensions, and critically evaluate whether previous recommendations actually helped.

## Tasks

1. **Score each governance dimension** (1-5 scale):
   - 1 = Critical issues, no controls
   - 2 = Significant gaps
   - 3 = Adequate but room for improvement
   - 4 = Good with minor issues
   - 5 = Excellent
   
   Compare to the previous week's scores and mark trend: ⬆️ improving, ➡️ stable, ⬇️ declining.

2. **Pattern analysis** across the 14 days:
   - What problems keep recurring?
   - What improved over the period?
   - What got worse?

3. **Recommendation effectiveness review:**
   For each recommendation that was marked "implemented":
   - Did the problem it addressed improve? Look at the SAME signals that triggered the recommendation.
   - Be honest: if it didn't help, say so and suggest why.
   - Mark as: ✅ effective, ❌ no effect (revise), ⏳ too early to measure

4. **Strategic assessment:**
   - Is the overall operation moving toward its goals?
   - Are resources being allocated to the right work?
   - What's the biggest risk right now?

## Output Format

# Weekly Governance Review — {date}
## Covering: {start_date} to {end_date}

## Executive Summary
(5-7 sentences: overall health, top concern, biggest win)

## Dimension Scores

| Dimension | Score | Trend | Notes |
|-----------|-------|-------|-------|
| Change management | X/5 | ⬆️/➡️/⬇️ | ... |
... (all 5 scored dimensions)

## Pattern Analysis
### Recurring Issues
### Improvements
### Deterioration

## Recommendation Effectiveness
| ID | Recommendation | Status | Verdict | Evidence |
... 

## Strategic Assessment
### Goal Alignment
### Resource Allocation
### Top Risk

## Action Items for Next Week
(top 5 prioritized)

---

DAILY DIGESTS:
`;
```

- [ ] **Step 4: Add auditDaily() to WatchdogManager**

Add after the `watchdogReview()` method (after line 1409) in `WatchdogManager.js`:

```javascript
  // ── Nightly Auditor ────────────────────────────────────────────────────────

  async auditDaily() {
    if (this._auditing) return;
    this._auditing = true;
    log.info('watchdog', 'audit daily started');
    const _start = Date.now();

    try {
      const auditorSettings = this.settingsStore
        ? await Promise.resolve(this.settingsStore.get('auditor')).catch(() => null)
        : null;
      if (auditorSettings?.enabled === false) return;

      const projectPaths = auditorSettings?.projects?.length > 0
        ? auditorSettings.projects
        : ['/projects/niyyah', '/home/claude-runner/apps/claude-web-app-v2'];

      const {
        buildAuditContext, buildProjectContext, formatContextForPrompt,
        writeDigest, updateRecommendations, updateBlindSpots, pruneOldDigests,
        AUDIT_DAILY_PROMPT,
      } = await import('./auditor.js');

      const today = new Date().toISOString().slice(0, 10);
      const ctx = buildAuditContext({ dataDir: this.dataDir, lookbackHours: 24, projectPaths });

      for (const projPath of projectPaths) {
        const projCtx = buildProjectContext(projPath);
        const fullContext = formatContextForPrompt(ctx, projCtx);
        const prompt = AUDIT_DAILY_PROMPT + fullContext;

        let digest;
        try {
          digest = await this._callClaudeThinking(prompt, { force: true });
        } catch (err) {
          // Retry once after 5 minutes
          log.warn('watchdog', 'audit first attempt failed, retrying in 5m', { error: err.message });
          await new Promise(r => setTimeout(r, 300000));
          try {
            digest = await this._callClaudeThinking(prompt, { force: true });
          } catch (err2) {
            log.error('watchdog', 'audit failed after retry', { error: err2.message });
            writeDigest(projPath, today, `# Daily Audit Digest — ${today}\n\n**FAILED:** AI call failed after retry. Error: ${err2.message}\n`);
            continue;
          }
        }

        writeDigest(projPath, today, digest);

        // Parse recommendations and blind spots from the digest (best-effort)
        const newRecs = _parseRecommendations(digest, today);
        if (newRecs.length > 0) updateRecommendations(projPath, newRecs);

        const newSpots = _parseBlindSpots(digest);
        if (newSpots.length > 0) updateBlindSpots(projPath, newSpots);

        pruneOldDigests(projPath, 90);
      }

      // Cross-project infrastructure digest
      const infraCtx = formatContextForPrompt(ctx);
      const infraPrompt = AUDIT_DAILY_PROMPT + infraCtx;
      try {
        const infraDigest = await this._callClaudeThinking(infraPrompt, { force: true });
        const { writeDigest: wd } = await import('./auditor.js');
        const infraDir = path.join(this.dataDir, 'audit');
        fs.mkdirSync(path.join(infraDir, 'daily'), { recursive: true });
        const infraTarget = path.join(infraDir, 'daily', `${today}.md`);
        const tmp = infraTarget + '.tmp';
        fs.writeFileSync(tmp, infraDigest);
        fs.renameSync(tmp, infraTarget);
      } catch (err) {
        log.error('watchdog', 'infra audit digest failed', { error: err.message });
      }

      // Telegram summary
      for (const sess of SESSIONS) {
        await this._notify(sess, `📋 Daily audit complete for ${today}. Check AUDIT-DIGESTS/daily/${today}.md`);
      }

      this.emit('auditComplete', { date: today, type: 'daily' });
    } catch (err) {
      log.error('watchdog', 'audit daily failed', { error: err.message });
      this.emit('error', err);
    } finally {
      log.info('watchdog', 'audit daily complete', { durationMs: Date.now() - _start });
      health.signal('watchdog', 'lastAudit');
      this._auditing = false;
    }
  }
```

Also add the helper parsers at module level (after the class, or as static methods):

```javascript
function _parseRecommendations(digest, date) {
  const recs = [];
  const recSection = digest.match(/## New Recommendations\n([\s\S]*?)(?=\n##|$)/);
  if (!recSection) return recs;
  const lines = recSection[1].split('\n').filter(l => l.trim().startsWith('R-') || l.trim().match(/^\d+\./));
  for (const line of lines) {
    const match = line.match(/(R-\d+):\s*(.+?)(?:\|\s*source:\s*(.+))?$/);
    if (match) {
      recs.push({ id: match[1], date, recommendation: match[2].trim(), source: (match[3] || '').trim() });
    }
  }
  return recs;
}

function _parseBlindSpots(digest) {
  const spots = [];
  const spotSection = digest.match(/## New Blind Spots\n([\s\S]*?)(?=\n##|$)/);
  if (!spotSection) return spots;
  const blocks = spotSection[1].split(/\n-\s+/).filter(Boolean);
  for (const block of blocks) {
    const gapMatch = block.match(/gap:\s*"([^"]+)"/i);
    const reasonMatch = block.match(/reason:\s*"([^"]+)"/i);
    const reqMatch = block.match(/requirement:\s*"([^"]+)"/i);
    const prioMatch = block.match(/priority:\s*"([^"]+)"/i);
    if (gapMatch) {
      spots.push({
        gap: gapMatch[1],
        reason: reasonMatch?.[1] || '',
        requirement: reqMatch?.[1] || '',
        priority: prioMatch?.[1] || 'medium',
      });
    }
  }
  return spots;
}
```

- [ ] **Step 5: Add `this._auditing = false;` to constructor**

In WatchdogManager constructor (around line 117), add:

```javascript
    this._auditing = false;
```

- [ ] **Step 6: Run tests to verify nothing broke**

Run: `npm test -- tests/unit/auditor.test.js tests/unit/WatchdogManager.test.js`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add lib/watchdog/auditor.js lib/watchdog/WatchdogManager.js tests/unit/auditor.test.js
git commit -m "feat: add Auditor daily digest with 13-dimension governance review"
```

---

## Task 6: Auditor — Weekly Review

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js` (add `auditWeeklyReview()`)
- Modify: `lib/watchdog/auditor.js` (already has AUDIT_WEEKLY_PROMPT from Task 5)

- [ ] **Step 1: Add auditWeeklyReview() to WatchdogManager**

Add after `auditDaily()`:

```javascript
  async auditWeeklyReview() {
    if (this._auditing) return;
    this._auditing = true;
    log.info('watchdog', 'audit weekly review started');
    const _start = Date.now();

    try {
      const auditorSettings = this.settingsStore
        ? await Promise.resolve(this.settingsStore.get('auditor')).catch(() => null)
        : null;
      if (auditorSettings?.enabled === false) return;

      const lookbackDays = auditorSettings?.lookbackDays || 14;
      const projectPaths = auditorSettings?.projects?.length > 0
        ? auditorSettings.projects
        : ['/projects/niyyah', '/home/claude-runner/apps/claude-web-app-v2'];

      const {
        loadPreviousDigests, buildAuditContext, buildProjectContext,
        formatContextForPrompt, writeWeeklyReview, AUDIT_WEEKLY_PROMPT,
      } = await import('./auditor.js');

      const today = new Date().toISOString().slice(0, 10);

      for (const projPath of projectPaths) {
        const digests = loadPreviousDigests(projPath, lookbackDays);
        if (digests.length === 0) {
          log.info('watchdog', 'no digests for weekly review', { project: projPath });
          continue;
        }

        const digestsText = digests.map(d => `### ${d.date}\n${d.content}`).join('\n\n---\n\n');
        const projCtx = buildProjectContext(projPath);
        const recsText = projCtx.recommendations || '';

        const prompt = AUDIT_WEEKLY_PROMPT + digestsText + '\n\nRECOMMENDATIONS TRACKER:\n' + recsText;

        let review;
        try {
          review = await this._callClaudeThinking(prompt, { force: true, timeoutMs: 600000 });
        } catch (err) {
          await new Promise(r => setTimeout(r, 300000));
          try {
            review = await this._callClaudeThinking(prompt, { force: true, timeoutMs: 600000 });
          } catch (err2) {
            log.error('watchdog', 'weekly review failed after retry', { error: err2.message });
            continue;
          }
        }

        writeWeeklyReview(projPath, today, review);
      }

      for (const sess of SESSIONS) {
        await this._notify(sess, `📊 Weekly governance review complete for ${today}. Check AUDIT-DIGESTS/reviews/${today}-weekly.md`);
      }

      this.emit('auditComplete', { date: today, type: 'weekly' });
    } catch (err) {
      log.error('watchdog', 'audit weekly review failed', { error: err.message });
      this.emit('error', err);
    } finally {
      log.info('watchdog', 'audit weekly review complete', { durationMs: Date.now() - _start });
      health.signal('watchdog', 'lastWeeklyReview');
      this._auditing = false;
    }
  }
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/unit/WatchdogManager.test.js`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add lib/watchdog/WatchdogManager.js
git commit -m "feat: add Auditor weekly governance review with scoring and recommendation tracking"
```

---

## Task 7: Program Manager — Backlog Parsing and Writing

**Files:**
- Create: `lib/watchdog/pm.js`
- Test: `tests/unit/pm.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/pm.test.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseBacklog, writeBacklog, updateCurrentSprint, seedBacklogFromRoadmap } from '../../lib/watchdog/pm.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseBacklog', () => {
  test('parses markdown backlog into structured items', () => {
    fs.writeFileSync(path.join(tmpDir, 'BACKLOG.md'), `# Backlog — Test

## Phase 1: Core (in progress)
- [x] TST-001: Setup project | shipped 2026-04-10
- [ ] TST-002: Build feature A | P1 | est: 4h
  - Acceptance: feature A works correctly
- [ ] TST-003: Build feature B | P2 | est: 6h | blocked-by: TST-002
  - Acceptance: feature B works correctly

## Bugs
- [ ] BUG-001: Fix crash on startup | P1 | source: qa 2026-04-20
  - Acceptance: app starts without crashing
`);
    const items = parseBacklog(tmpDir);
    expect(items).toHaveLength(4);
    expect(items[0].id).toBe('TST-001');
    expect(items[0].done).toBe(true);
    expect(items[1].id).toBe('TST-002');
    expect(items[1].priority).toBe('P1');
    expect(items[1].done).toBe(false);
    expect(items[2].id).toBe('TST-003');
    expect(items[2].blockedBy).toContain('TST-002');
    expect(items[3].id).toBe('BUG-001');
  });

  test('returns empty array when no BACKLOG.md exists', () => {
    const items = parseBacklog(tmpDir);
    expect(items).toEqual([]);
  });
});

describe('writeBacklog', () => {
  test('writes items back to BACKLOG.md', () => {
    const items = [
      { id: 'TST-001', title: 'Setup', done: true, shipped: '2026-04-10', section: 'Phase 1: Core', priority: null, estimate: null, acceptance: null, blockedBy: null, source: null },
      { id: 'TST-002', title: 'Build A', done: false, shipped: null, section: 'Phase 1: Core', priority: 'P1', estimate: '4h', acceptance: 'A works', blockedBy: null, source: null },
    ];
    writeBacklog(tmpDir, 'Test', items);
    const content = fs.readFileSync(path.join(tmpDir, 'BACKLOG.md'), 'utf8');
    expect(content).toContain('TST-001');
    expect(content).toContain('[x]');
    expect(content).toContain('TST-002');
    expect(content).toContain('P1');
  });
});

describe('updateCurrentSprint', () => {
  test('inserts Current Sprint section into CLAUDE.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# Project

## Build Phases
Phase 1 stuff here.

## Notes
Some notes.
`);
    const sprintItems = [
      { id: 'TST-002', title: 'Build A', acceptance: 'A works', description: 'Build feature A with proper tests.' },
    ];
    updateCurrentSprint(tmpDir, sprintItems);
    const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('## Current Sprint');
    expect(content).toContain('TST-002');
    expect(content).toContain('Build A');
    // Other sections preserved
    expect(content).toContain('## Build Phases');
    expect(content).toContain('## Notes');
  });

  test('replaces existing Current Sprint section', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# Project

## Current Sprint (updated 2026-04-27 04:00 UTC)

1. **OLD-001: Old task**

## Notes
Some notes.
`);
    const sprintItems = [
      { id: 'NEW-001', title: 'New task', acceptance: 'works', description: 'Do the new thing.' },
    ];
    updateCurrentSprint(tmpDir, sprintItems);
    const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('NEW-001');
    expect(content).not.toContain('OLD-001');
    expect(content).toContain('## Notes');
  });
});

describe('seedBacklogFromRoadmap', () => {
  test('creates BACKLOG.md from CLAUDE.md roadmap', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# Niyyah

## Build Phases

### Phase 1 (Week 1-2): Core
- Expo init and project scaffold
- Aladhan prayer times integration
- Prayer home screen with next-prayer countdown
- Basic habit tracker (3 habits)

### Phase 2 (Week 3-4): Premium
- Supabase auth integration
- RevenueCat paywall
`);
    const items = seedBacklogFromRoadmap(tmpDir, 'Niyyah', 'NPH');
    expect(items.length).toBeGreaterThanOrEqual(6);
    expect(items[0].id).toMatch(/^NPH-\d+/);
    expect(items[0].section).toContain('Phase 1');
    // Should have written BACKLOG.md
    expect(fs.existsSync(path.join(tmpDir, 'BACKLOG.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/pm.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement pm.js**

```javascript
// lib/watchdog/pm.js
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export function parseBacklog(projectPath) {
  const file = path.join(projectPath, 'BACKLOG.md');
  if (!fs.existsSync(file)) return [];

  const content = fs.readFileSync(file, 'utf8');
  const items = [];
  let currentSection = '';

  for (const line of content.split('\n')) {
    const sectionMatch = line.match(/^## (.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].replace(/\s*\(.+\)/, '').trim();
      continue;
    }

    const itemMatch = line.match(/^- \[([ x])\] ([A-Z]+-\d+):\s*(.+)/);
    if (!itemMatch) continue;

    const done = itemMatch[1] === 'x';
    const id = itemMatch[2];
    const rest = itemMatch[3];

    const priority = rest.match(/\bP([1-4])\b/)?.[0] || null;
    const estimate = rest.match(/est:\s*(\S+)/)?.[1] || null;
    const blockedByMatch = rest.match(/blocked-by:\s*([\w-]+(?:,\s*[\w-]+)*)/);
    const blockedBy = blockedByMatch ? blockedByMatch[1].split(',').map(s => s.trim()) : null;
    const sourceMatch = rest.match(/source:\s*(.+?)(?:\s*\||$)/);
    const source = sourceMatch ? sourceMatch[1].trim() : null;
    const shippedMatch = rest.match(/shipped\s+([\d-]+)/);
    const shipped = shippedMatch ? shippedMatch[1] : null;

    const title = rest
      .replace(/\s*\|.*/, '')
      .replace(/shipped\s+[\d-]+/, '')
      .trim();

    items.push({ id, title, done, shipped, section: currentSection, priority, estimate, acceptance: null, blockedBy, source });
  }

  // Second pass: pick up acceptance criteria (indented lines after items)
  const lines = content.split('\n');
  let currentItem = null;
  for (const line of lines) {
    const itemMatch = line.match(/^- \[[ x]\] ([A-Z]+-\d+):/);
    if (itemMatch) {
      currentItem = items.find(i => i.id === itemMatch[1]);
      continue;
    }
    const accMatch = line.match(/^\s+- Acceptance:\s*(.+)/);
    if (accMatch && currentItem) {
      currentItem.acceptance = accMatch[1].trim();
      currentItem = null;
    }
  }

  return items;
}

export function writeBacklog(projectPath, projectName, items) {
  const sections = new Map();
  for (const item of items) {
    const sec = item.section || 'Uncategorized';
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(item);
  }

  let content = `# Backlog — ${projectName}\n\n`;

  for (const [section, sectionItems] of sections) {
    const inProgress = sectionItems.some(i => !i.done) && sectionItems.some(i => i.done);
    const allDone = sectionItems.every(i => i.done);
    const status = allDone ? 'complete' : inProgress ? 'in progress' : '';
    content += `## ${section}${status ? ` (${status})` : ''}\n`;

    for (const item of sectionItems) {
      const check = item.done ? 'x' : ' ';
      let line = `- [${check}] ${item.id}: ${item.title}`;
      if (item.done && item.shipped) line += ` | shipped ${item.shipped}`;
      if (!item.done) {
        const parts = [];
        if (item.priority) parts.push(item.priority);
        if (item.estimate) parts.push(`est: ${item.estimate}`);
        if (item.blockedBy) parts.push(`blocked-by: ${item.blockedBy.join(', ')}`);
        if (item.source) parts.push(`source: ${item.source}`);
        if (parts.length > 0) line += ` | ${parts.join(' | ')}`;
      }
      content += line + '\n';
      if (item.acceptance) {
        content += `  - Acceptance: ${item.acceptance}\n`;
      }
    }
    content += '\n';
  }

  const target = path.join(projectPath, 'BACKLOG.md');
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

export function updateCurrentSprint(projectPath, sprintItems) {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return;

  let content = fs.readFileSync(claudeMdPath, 'utf8');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  let sprintSection = `## Current Sprint (updated ${now})\n\n`;
  sprintItems.forEach((item, i) => {
    sprintSection += `${i + 1}. **${item.id}: ${item.title}** — ${item.description || ''}\n`;
    if (item.acceptance) {
      sprintSection += `   Acceptance: ${item.acceptance}\n`;
    }
    sprintSection += '\n';
  });

  const sprintRegex = /## Current Sprint[^\n]*\n[\s\S]*?(?=\n## |\n# |$)/;
  if (sprintRegex.test(content)) {
    content = content.replace(sprintRegex, sprintSection.trimEnd());
  } else {
    content = content.trimEnd() + '\n\n' + sprintSection;
  }

  const tmp = claudeMdPath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, claudeMdPath);
}

export function seedBacklogFromRoadmap(projectPath, projectName, prefix) {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return [];

  const content = fs.readFileSync(claudeMdPath, 'utf8');
  const items = [];
  let counter = 1;
  let currentPhase = '';
  let currentPriority = 'P1';

  const phaseRegex = /###\s*Phase\s*(\d+)[^:\n]*:\s*(.+)/g;
  const phases = [];
  let match;
  while ((match = phaseRegex.exec(content)) !== null) {
    phases.push({ index: match.index, num: parseInt(match[1]), name: match[2].trim(), endIndex: content.length });
  }
  for (let i = 0; i < phases.length - 1; i++) {
    phases[i].endIndex = phases[i + 1].index;
  }

  for (const phase of phases) {
    currentPhase = `Phase ${phase.num}: ${phase.name}`;
    currentPriority = phase.num === 1 ? 'P1' : phase.num === 2 ? 'P2' : 'P3';
    const block = content.slice(phase.index, phase.endIndex);
    const bulletLines = block.split('\n').filter(l => l.match(/^- .+/) && !l.match(/^- \[/));

    for (const line of bulletLines) {
      const title = line.replace(/^-\s*/, '').trim();
      if (!title || title.length < 3) continue;
      const id = `${prefix}-${String(counter).padStart(3, '0')}`;
      items.push({
        id,
        title,
        done: false,
        shipped: null,
        section: currentPhase,
        priority: currentPriority,
        estimate: null,
        acceptance: null,
        blockedBy: null,
        source: 'roadmap',
      });
      counter++;
    }
  }

  if (items.length > 0) {
    writeBacklog(projectPath, projectName, items);
  }

  return items;
}

export const PM_CYCLE_PROMPT = `You are a technical program manager reviewing the current state of a software project. Your job is to:

1. **Mark completions** — based on the git log and activity summaries, identify which backlog items have been completed. Return their IDs.

2. **Identify new work** — from the Auditor's daily digest (if provided), extract actionable items that should become backlog entries. Each needs: title, priority (P1-P4), estimated effort, acceptance criteria.

3. **Flag scope creep** — identify any commits or work that doesn't match an existing backlog item or sprint task.

4. **Select sprint items** — pick the top items (up to the sprint size) that are: unblocked, not done, highest priority. For each, write a 1-2 sentence description that a Claude Code factory session can act on immediately.

5. **Write a brief PM report** — what completed, what's new, what changed in the sprint, any blockers.

Respond with JSON:
{
  "completedIds": ["ID-001"],
  "newItems": [{"title": "...", "priority": "P2", "estimate": "4h", "acceptance": "...", "source": "audit digest 2026-04-28"}],
  "scopeCreep": ["commit abc123: did X which isn't in backlog"],
  "sprint": [{"id": "ID-002", "title": "...", "description": "...", "acceptance": "..."}],
  "report": "..."
}

PROJECT DATA:
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/pm.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog/pm.js tests/unit/pm.test.js
git commit -m "feat: add PM backlog parsing, writing, sprint management, and roadmap seeding"
```

---

## Task 8: Program Manager — Nightly Cycle

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js` (add `pmCycle()`)

- [ ] **Step 1: Add pmCycle() to WatchdogManager**

Add after `auditWeeklyReview()`:

```javascript
  // ── Nightly Program Manager ────────────────────────────────────────────────

  async pmCycle() {
    if (this._pmRunning) return;
    this._pmRunning = true;
    log.info('watchdog', 'PM cycle started');
    const _start = Date.now();

    try {
      const pmSettings = this.settingsStore
        ? await Promise.resolve(this.settingsStore.get('pm')).catch(() => null)
        : null;
      if (pmSettings?.enabled === false) return;

      const sprintSize = pmSettings?.sprintSize || 5;
      const projectPaths = pmSettings?.projects?.length > 0
        ? pmSettings.projects
        : ['/projects/niyyah', '/home/claude-runner/apps/claude-web-app-v2'];

      const {
        parseBacklog, writeBacklog, updateCurrentSprint,
        seedBacklogFromRoadmap, PM_CYCLE_PROMPT,
      } = await import('./pm.js');

      const { buildAuditContext, formatContextForPrompt, buildProjectContext } = await import('./auditor.js');

      const today = new Date().toISOString().slice(0, 10);
      const ctx = buildAuditContext({ dataDir: this.dataDir, lookbackHours: 24, projectPaths });

      for (const projPath of projectPaths) {
        let items = parseBacklog(projPath);

        // Seed on first run if no backlog exists
        if (items.length === 0) {
          const projName = path.basename(projPath);
          const prefix = projName.slice(0, 3).toUpperCase();
          items = seedBacklogFromRoadmap(projPath, projName, prefix);
          if (items.length === 0) continue;
        }

        // Build context for AI
        const projCtx = buildProjectContext(projPath);
        const auditDigest = _readLatestDigest(projPath, today);
        const gitLog = _getRecentGitLog(projPath);

        const backlogText = fs.readFileSync(path.join(projPath, 'BACKLOG.md'), 'utf8');

        const prompt = PM_CYCLE_PROMPT +
          `\n## Current Backlog\n${backlogText}` +
          `\n\n## Git Log (last 24h)\n${gitLog}` +
          `\n\n## Activity Summary\n${formatContextForPrompt(ctx)}` +
          (auditDigest ? `\n\n## Auditor Digest\n${auditDigest}` : '') +
          `\n\nSprint size: ${sprintSize}`;

        let result;
        try {
          result = await this._callClaude(prompt);
        } catch (err) {
          log.error('watchdog', 'PM AI call failed', { project: projPath, error: err.message });
          continue;
        }

        // Apply completions
        if (result.completedIds) {
          for (const id of result.completedIds) {
            const item = items.find(i => i.id === id);
            if (item) { item.done = true; item.shipped = today; }
          }
        }

        // Add new items from Auditor
        if (result.newItems) {
          const maxId = _maxIdNum(items);
          let counter = maxId + 1;
          for (const ni of result.newItems) {
            const prefix = ni.source?.includes('audit') ? 'AUD' : 'NEW';
            items.push({
              id: `${prefix}-${String(counter).padStart(3, '0')}`,
              title: ni.title,
              done: false,
              shipped: null,
              section: ni.source?.includes('audit') ? 'Improvements (from Auditor)' : 'New',
              priority: ni.priority || 'P3',
              estimate: ni.estimate || null,
              acceptance: ni.acceptance || null,
              blockedBy: null,
              source: ni.source || `pm ${today}`,
            });
            counter++;
          }
        }

        // Write updated backlog
        const projName = path.basename(projPath);
        writeBacklog(projPath, projName, items);

        // Update Current Sprint in CLAUDE.md
        if (result.sprint) {
          updateCurrentSprint(projPath, result.sprint.slice(0, sprintSize));
        }

        // Write PM daily report
        const reportDir = path.join(this.dataDir, 'pm', 'daily');
        fs.mkdirSync(reportDir, { recursive: true });
        const reportPath = path.join(reportDir, `${today}.md`);
        const reportContent = `# PM Report — ${today}\n\n## Project: ${projPath}\n\n${result.report || 'No report generated.'}\n\n` +
          `## Completed: ${(result.completedIds || []).join(', ') || 'none'}\n` +
          `## New Items: ${(result.newItems || []).length}\n` +
          `## Scope Creep: ${(result.scopeCreep || []).join('; ') || 'none'}\n`;
        fs.writeFileSync(reportPath, reportContent);
      }

      // Telegram notification
      for (const sess of SESSIONS) {
        await this._notify(sess, `📋 Sprint updated for ${today}. Check each project's CLAUDE.md for current sprint.`);
      }

      this.emit('pmComplete', { date: today });
    } catch (err) {
      log.error('watchdog', 'PM cycle failed', { error: err.message });
      this.emit('error', err);
    } finally {
      log.info('watchdog', 'PM cycle complete', { durationMs: Date.now() - _start });
      health.signal('watchdog', 'lastPmCycle');
      this._pmRunning = false;
    }
  }
```

Also add module-level helpers:

```javascript
function _readLatestDigest(projectPath, today) {
  const file = path.join(projectPath, 'AUDIT-DIGESTS', 'daily', `${today}.md`);
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function _getRecentGitLog(projectPath) {
  try {
    return execSync('git log --since="24 hours ago" --oneline --no-decorate', {
      cwd: projectPath, encoding: 'utf8', timeout: 5000,
    }).trim();
  } catch { return ''; }
}

function _maxIdNum(items) {
  let max = 0;
  for (const item of items) {
    const num = parseInt(item.id.replace(/[A-Z]+-/, ''), 10);
    if (num > max) max = num;
  }
  return max;
}
```

- [ ] **Step 2: Add `this._pmRunning = false;` to constructor**

In WatchdogManager constructor, add:

```javascript
    this._pmRunning = false;
```

- [ ] **Step 3: Add missing import for path at top of WatchdogManager.js**

`path` is already imported (line 5). No change needed — verify.

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/unit/WatchdogManager.test.js tests/unit/pm.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog/WatchdogManager.js
git commit -m "feat: add PM nightly cycle with backlog updates and sprint management"
```

---

## Task 9: Wire Scheduling Into tick()

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js` (constructor, start, stop, tick)

- [ ] **Step 1: Import DailyScheduler and add to constructor**

At the top of `WatchdogManager.js`, add import:

```javascript
import { DailyScheduler } from './scheduling.js';
```

In the constructor, after `this._lastCleanupCheck = 0;` (line 165), add:

```javascript
    // Nightly job scheduler
    this._scheduler = new DailyScheduler();
```

- [ ] **Step 2: Add scheduling to _loadState and _saveState**

In `_loadState()`, after `if (typeof data._lastCleanupCheck === 'number')` block, add:

```javascript
      if (data._schedulerState) this._scheduler.loadState(data._schedulerState);
```

In `_saveState()`, add `_schedulerState: this._scheduler.getState()` to the persisted object:

```javascript
      fs.writeFileSync(tmp, JSON.stringify({
        _state: this._state,
        _managedRegistry: this._managedRegistry,
        _lastCleanupCheck: this._lastCleanupCheck,
        _schedulerState: this._scheduler.getState(),
        updatedAt: new Date().toISOString(),
      }, null, 2));
```

- [ ] **Step 3: Add scheduling checks at the end of tick()**

In `tick()`, before `this._saveState()` (around line 1284), add:

```javascript
      // ── Nightly job scheduling ──────────────────────────────────────────────
      const utcNow = new Date();
      const auditorSettings = this.settingsStore
        ? await Promise.resolve(this.settingsStore.get('auditor')).catch(() => null)
        : null;
      const pmSettings = this.settingsStore
        ? await Promise.resolve(this.settingsStore.get('pm')).catch(() => null)
        : null;

      const auditHour = auditorSettings?.dailyHourUTC ?? 2;
      const pmHour = pmSettings?.dailyHourUTC ?? 4;

      if (this._scheduler.shouldRun('audit', auditHour, utcNow)) {
        this._scheduler.markRun('audit', utcNow);
        const weeklyDay = auditorSettings?.weeklyDay || 'friday';
        if (this._scheduler.isWeeklyDay(weeklyDay, utcNow)) {
          this.auditWeeklyReview().catch(err => {
            log.error('watchdog', 'scheduled weekly review failed', { error: err.message });
          });
        } else {
          this.auditDaily().catch(err => {
            log.error('watchdog', 'scheduled audit daily failed', { error: err.message });
          });
        }
      }

      if (this._scheduler.shouldRun('pm', pmHour, utcNow)) {
        this._scheduler.markRun('pm', utcNow);
        this.pmCycle().catch(err => {
          log.error('watchdog', 'scheduled PM cycle failed', { error: err.message });
        });
      }
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog/WatchdogManager.js
git commit -m "feat: wire Auditor and PM into watchdog tick() via DailyScheduler"
```

---

## Task 10: API Routes

**Files:**
- Modify: `lib/api/routes.js` (add audit and PM endpoints)

- [ ] **Step 1: Add audit routes after existing watchdog routes**

After the `GET /api/watchdog/credit-history` route (around line 417), add:

```javascript
  /** GET /api/audit/digests — list available audit digests */
  router.get('/api/audit/digests', (req, res) => {
    if (!watchdog) return res.json([]);
    try {
      const { projectPath } = req.query;
      const dir = projectPath
        ? path.join(projectPath, 'AUDIT-DIGESTS', 'daily')
        : path.join(dataDir, 'audit', 'daily');
      if (!fs.existsSync(dir)) return res.json([]);
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 30)
        .map(f => ({ date: f.replace('.md', ''), file: f }));
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/audit/digest/:date — get specific digest */
  router.get('/api/audit/digest/:date', (req, res) => {
    if (!watchdog) return res.status(404).json({});
    try {
      const { projectPath } = req.query;
      const dir = projectPath
        ? path.join(projectPath, 'AUDIT-DIGESTS', 'daily')
        : path.join(dataDir, 'audit', 'daily');
      const file = path.join(dir, `${req.params.date}.md`);
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
      res.type('text/markdown').send(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/audit/reviews — list weekly reviews */
  router.get('/api/audit/reviews', (req, res) => {
    if (!watchdog) return res.json([]);
    try {
      const { projectPath } = req.query;
      const dir = projectPath
        ? path.join(projectPath, 'AUDIT-DIGESTS', 'reviews')
        : path.join(dataDir, 'audit', 'reviews');
      if (!fs.existsSync(dir)) return res.json([]);
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .map(f => ({ date: f.replace('-weekly.md', '').replace('.md', ''), file: f }));
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/pm/backlog — get backlog for a project */
  router.get('/api/pm/backlog', (req, res) => {
    if (!watchdog) return res.json({});
    try {
      const { projectPath } = req.query;
      if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
      const file = path.join(projectPath, 'BACKLOG.md');
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'no backlog' });
      res.type('text/markdown').send(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/pm/reports — list PM daily reports */
  router.get('/api/pm/reports', (req, res) => {
    if (!watchdog) return res.json([]);
    try {
      const dir = path.join(dataDir, 'pm', 'daily');
      if (!fs.existsSync(dir)) return res.json([]);
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 30)
        .map(f => ({ date: f.replace('.md', ''), file: f }));
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Add fs and path imports if not already present**

Check top of `routes.js` — add if missing:

```javascript
import fs from 'fs';
import path from 'path';
```

- [ ] **Step 3: Run server smoke test**

Run: `npm test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add lib/api/routes.js
git commit -m "feat: add API routes for audit digests, reviews, PM backlog, and reports"
```

---

## Task 11: /pm Skill File

**Files:**
- Create: `~/.claude/skills/pm/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
---
name: pm
description: Project program manager — view and manage the backlog, add requirements, update sprint priorities. Use when the user wants to see project status, add work items, or reprioritize.
---

# Program Manager

You are acting as a technical program manager. Read the project's BACKLOG.md and CLAUDE.md to understand current state.

## Commands

### `/pm` (no args) — Show current status
1. Read `BACKLOG.md` in the current working directory (or the project's root)
2. Read the `## Current Sprint` section from `CLAUDE.md`
3. Summarize: items completed, items in sprint, top blockers, total backlog size

### `/pm add <requirement>` — Add a new backlog item
1. Parse the requirement from the user's message
2. Read current `BACKLOG.md` to find the highest ID number
3. Assign: new ID (use project prefix + next number), priority (ask if unclear), acceptance criteria (derive from requirement or ask)
4. Append the item to the appropriate section in `BACKLOG.md`
5. If this is higher priority than current sprint items, offer to update the sprint

### `/pm reprioritize` — Force sprint re-sort
1. Read `BACKLOG.md` and sort: P1 bugs first, then by phase order, then P2-P4
2. Pick top N unblocked items (N = sprint size from settings, default 5)
3. Rewrite the `## Current Sprint` section in `CLAUDE.md`
4. Report what changed

### `/pm status` — Detailed status report
1. Read `BACKLOG.md`, `CLAUDE.md`, and recent PM reports from `data/pm/daily/`
2. Report: completed items (last 7 days), in-progress (in sprint), blocked, total remaining
3. Show burn-down: items completed per week trend

## Rules
- Never modify any code or run tests — you only manage the backlog and sprint
- Always use atomic writes (write to .tmp, then rename)
- Preserve all existing CLAUDE.md sections when updating Current Sprint
- Use the existing backlog format exactly (see BACKLOG.md for reference)
```

- [ ] **Step 2: Verify skill directory exists**

Run: `mkdir -p ~/.claude/skills/pm`

- [ ] **Step 3: Commit (skill files are outside the repo, so just verify it's in place)**

Run: `ls -la ~/.claude/skills/pm/SKILL.md`
Expected: File exists with correct content

---

## Task 12: Integration Test — Full Nightly Pipeline

**Files:**
- Create: `tests/unit/audit-pm-integration.test.js`

- [ ] **Step 1: Write integration test**

```javascript
// tests/unit/audit-pm-integration.test.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DailyScheduler } from '../../lib/watchdog/scheduling.js';
import { buildAuditContext, writeDigest, formatContextForPrompt } from '../../lib/watchdog/auditor.js';
import { parseBacklog, writeBacklog, updateCurrentSprint, seedBacklogFromRoadmap } from '../../lib/watchdog/pm.js';

let tmpDataDir;
let tmpProjectDir;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-data-'));
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-proj-'));

  // Minimal data structure
  fs.mkdirSync(path.join(tmpDataDir, 'activity-logs'), { recursive: true });
  fs.writeFileSync(path.join(tmpDataDir, 'credit-history.json'), '[]');
  fs.writeFileSync(path.join(tmpDataDir, 'health.json'), '{}');
  fs.writeFileSync(path.join(tmpDataDir, 'session-lifecycle.json'), '[]');
  fs.writeFileSync(path.join(tmpDataDir, 'sessions.json'), '{"sessions":{}}');
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(tmpProjectDir, { recursive: true, force: true });
});

describe('Scheduler → Auditor → PM pipeline', () => {
  test('scheduler triggers at correct hour', () => {
    const sched = new DailyScheduler();
    const at2am = new Date('2026-04-28T02:05:00Z');
    expect(sched.shouldRun('audit', 2, at2am)).toBe(true);
    sched.markRun('audit', at2am);
    expect(sched.shouldRun('audit', 2, at2am)).toBe(false);
  });

  test('auditor writes digest that PM can read', () => {
    const today = '2026-04-28';
    writeDigest(tmpProjectDir, today, '# Daily Audit Digest — 2026-04-28\n\n## Summary\nAll clear.\n');

    const digestFile = path.join(tmpProjectDir, 'AUDIT-DIGESTS', 'daily', `${today}.md`);
    expect(fs.existsSync(digestFile)).toBe(true);
    const content = fs.readFileSync(digestFile, 'utf8');
    expect(content).toContain('All clear');
  });

  test('PM seeds backlog from CLAUDE.md and writes sprint', () => {
    fs.writeFileSync(path.join(tmpProjectDir, 'CLAUDE.md'), `# TestProject

## Build Phases

### Phase 1 (Week 1): Core
- Setup project scaffold
- Build main feature
- Add tests

### Phase 2 (Week 2): Polish
- Add documentation
- Performance optimization
`);

    const items = seedBacklogFromRoadmap(tmpProjectDir, 'TestProject', 'TST');
    expect(items.length).toBe(5);

    const backlog = parseBacklog(tmpProjectDir);
    expect(backlog.length).toBe(5);

    const sprint = items.filter(i => !i.done).slice(0, 3).map(i => ({
      id: i.id,
      title: i.title,
      description: `Work on: ${i.title}`,
      acceptance: i.acceptance,
    }));
    updateCurrentSprint(tmpProjectDir, sprint);

    const claudeMd = fs.readFileSync(path.join(tmpProjectDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('## Current Sprint');
    expect(claudeMd).toContain('TST-001');
    expect(claudeMd).toContain('## Build Phases');
  });

  test('buildAuditContext gathers data without crashing', () => {
    const ctx = buildAuditContext({
      dataDir: tmpDataDir,
      lookbackHours: 24,
      projectPaths: [tmpProjectDir],
    });
    expect(ctx.timestamp).toBeDefined();
    expect(ctx.activityLogs).toEqual([]);
    const formatted = formatContextForPrompt(ctx);
    expect(formatted.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npm test -- tests/unit/audit-pm-integration.test.js`
Expected: All PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS across all test files

- [ ] **Step 4: Commit**

```bash
git add tests/unit/audit-pm-integration.test.js
git commit -m "test: add Auditor + PM integration tests for nightly pipeline"
```

---

## Task 13: Final Wiring and Smoke Test

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js` (add new events to JSDoc)

- [ ] **Step 1: Update EventEmitter JSDoc**

In the class-level JSDoc (around line 82), add the new events:

```javascript
 *   - 'auditComplete' { date, type }
 *   - 'pmComplete'    { date }
```

- [ ] **Step 2: Run full test suite one final time**

Run: `npm test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add lib/watchdog/WatchdogManager.js
git commit -m "docs: add auditComplete and pmComplete events to WatchdogManager JSDoc"
```

- [ ] **Step 4: Restart beta server to verify no startup crash**

```bash
pm2 info claude-v2-beta
pm2 restart claude-v2-beta
pm2 logs claude-v2-beta --lines 20 --nostream
```

Expected: Server starts cleanly, no import errors, watchdog tick runs.

- [ ] **Step 5: Verify new API endpoints respond**

```bash
curl -s http://localhost:3002/api/audit/digests | head
curl -s http://localhost:3002/api/pm/reports | head
```

Expected: Empty JSON arrays (no digests yet — they'll appear after the first 2am run).

- [ ] **Step 6: Final commit if any adjustments needed**

---

## Execution Summary

| Task | What | Estimated Time |
|------|------|---------------|
| 1 | DailyScheduler | 10 min |
| 2 | Settings schema | 5 min |
| 3 | _callClaudeThinking | 10 min |
| 4 | Auditor context gathering | 15 min |
| 5 | Auditor daily digest + prompt | 15 min |
| 6 | Auditor weekly review | 10 min |
| 7 | PM backlog parsing/writing | 15 min |
| 8 | PM nightly cycle | 15 min |
| 9 | Wire scheduling into tick() | 10 min |
| 10 | API routes | 10 min |
| 11 | /pm skill file | 5 min |
| 12 | Integration test | 10 min |
| 13 | Final wiring + smoke test | 10 min |
| **Total** | | **~2.5 hours** |
