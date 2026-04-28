// lib/watchdog/auditor.js
// Pure functions for gathering and formatting audit context from the filesystem.
// No AI calls — just data collection and formatting.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { log } from '../logger/Logger.js';

const TAG = 'auditor';

// ── Audit prompt constants ─────────────────────────────────────────────────

/**
 * System prompt for the daily governance audit.
 * Instructs Claude to evaluate 13 dimensions and produce a structured markdown digest.
 */
export const AUDIT_DAILY_PROMPT = `You are the Governance Auditor for an autonomous AI development system.
Analyze the provided context and produce a daily audit digest covering ALL 13 dimensions below.

## Dimensions to Evaluate

For each dimension, assign a status: GREEN (healthy), AMBER (needs attention), or RED (action required).

1. **Change management** — Are changes being committed, reviewed, and deployed properly? Any force-pushes, skipped tests, or unreviewed merges?
2. **Strategy alignment** — Is the work aligned with the project backlog and stated goals? Are sessions working on priorities or drifting?
3. **Recurring failures** — Are the same errors, test failures, or crash loops happening repeatedly? Pattern detection across sessions.
4. **Cost efficiency** — Is credit utilization reasonable? Are there wasteful patterns (e.g., excessive AI calls, large context windows, redundant work)?
5. **Security & hygiene** — Any exposed secrets, missing .env guards, open ports, stale credentials, or permission issues?
6. **Documentation gaps** — Are new features documented? Are CLAUDE.md, README, and decision logs up to date?
7. **Process improvement** — Are there workflow bottlenecks, manual steps that should be automated, or repeated toil?
8. **Meaningful interactions** — Are AI sessions producing useful output? Quality of summaries, code changes, and decisions.
9. **User sentiment** — Any signs of user frustration, repeated requests, or ignored feedback in the activity logs?
10. **Work patterns** — Session timing, idle periods, burst patterns. Is work distributed well or concentrated in risky ways?
11. **Credit utilization** — Burn rate trends, cost per session, projected runway. Flag anomalies.
12. **Lost & repeated work** — Any evidence of work being done twice, reverted commits, or sessions redoing what another already completed?
13. **Blind spot detection** — What might we be missing? Areas with no monitoring, no tests, no activity logs, or no recent attention.

## Output Format

Produce a markdown document with this structure:

# Daily Governance Audit — {date}

## Status Summary

| # | Dimension | Status | Key Finding |
|---|-----------|--------|-------------|
| 1 | Change management | GREEN/AMBER/RED | one-line summary |
| ... | ... | ... | ... |
| 13 | Blind spot detection | GREEN/AMBER/RED | one-line summary |

## Detailed Findings

For each AMBER or RED dimension, provide:
- What was observed
- Why it matters
- Specific evidence from the context

## Recommendations

List actionable recommendations in this format:
- R-001: [priority: high/medium/low] Description of the recommendation
- R-002: [priority: high/medium/low] Description of the recommendation

## Blind Spots

List areas where monitoring or attention is lacking:
- BLIND-SPOT: [area] Description — [severity: high/medium/low]

## Top 3 Action Items

1. Most urgent action needed
2. Second priority
3. Third priority

Be specific and evidence-based. Reference session names, commit hashes, timestamps, and cost figures from the context.
Do not invent data — if a dimension cannot be assessed from the provided context, mark it AMBER with "insufficient data" as the finding.`;

/**
 * System prompt for the Friday weekly governance review.
 * Instructs Claude to score governance dimensions, analyze trends, and review recommendation effectiveness.
 */
export const AUDIT_WEEKLY_PROMPT = `You are the Governance Auditor performing a weekly review of an autonomous AI development system.
You will receive up to 14 days of daily audit digests plus current context.

## Weekly Review Structure

### 1. Governance Score Card

For each dimension, provide a score on a 1-5 scale with a trend arrow:
- ↑ improving, → stable, ↓ declining

| Dimension | Score (1-5) | Trend | Notes |
|-----------|-------------|-------|-------|
| Change management | X | ↑/→/↓ | brief note |
| Strategy alignment | X | ↑/→/↓ | brief note |
| Operational health | X | ↑/→/↓ | brief note |
| Cost governance | X | ↑/→/↓ | brief note |
| Security posture | X | ↑/→/↓ | brief note |

### 2. Pattern Analysis

Analyze patterns across the daily digests:
- Recurring themes (what keeps appearing?)
- Improving areas (what got better this week?)
- Deteriorating areas (what got worse?)
- Anomalies (any unusual spikes, gaps, or shifts?)

### 3. Recommendation Effectiveness Review

Review all R-XXX recommendations from the daily digests and mark each:
- ✅ Effective — evidence of positive change
- ❌ No effect — recommendation was ignored or did not help
- ⏳ Too early — not enough time to assess

### 4. Strategic Assessment

- Overall system health trajectory
- Biggest risk this week
- Biggest win this week
- Focus areas for next week

Be data-driven. Reference specific dates, digests, and evidence. If daily digests are sparse, note that as a gap.`;

// ── File I/O helpers (defensive reads) ──────────────────────────────────────

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readFileSafe(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function runGitSafe(cmd, cwd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000, cwd }).trim();
  } catch {
    return '';
  }
}

// ── Core context gathering ──────────────────────────────────────────────────

/**
 * Gathers all data sources into a structured audit context object.
 * @param {{ dataDir: string, lookbackHours?: number, projectPaths?: string[] }} opts
 * @returns {object} structured context
 */
export function buildAuditContext({ dataDir, lookbackHours = 24, projectPaths = [] }) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - lookbackHours * 3600 * 1000);

  // Credit history — last 48 entries
  const allCredits = readJsonSafe(path.join(dataDir, 'credit-history.json'), []);
  const creditHistory = Array.isArray(allCredits) ? allCredits.slice(-48) : [];

  // Health signals
  const healthSignals = readJsonSafe(path.join(dataDir, 'health.json'), {});

  // Session lifecycle — filtered to lookback window
  const allLifecycle = readJsonSafe(path.join(dataDir, 'session-lifecycle.json'), []);
  const sessionLifecycle = Array.isArray(allLifecycle)
    ? allLifecycle.filter(e => e.ts && new Date(e.ts) >= cutoff)
    : [];

  // Activity logs — all files in activity-logs/, entries within lookback window
  const activityLogs = readActivityLogs(dataDir, cutoff);

  // Closed session report
  const closedSessions = buildClosedSessionReport({ dataDir, lookbackHours });

  // Git logs per project path
  const gitLogs = {};
  for (const pp of projectPaths) {
    gitLogs[pp] = getGitLog(pp, lookbackHours);
  }

  // Beta/prod gap for v2 project
  let betaProdGap = null;
  const v2Path = projectPaths.find(p => p.includes('claude-web-app-v2'));
  if (v2Path) {
    betaProdGap = getBetaProdGap(v2Path);
  }

  log.info(TAG, 'audit context built', {
    creditEntries: creditHistory.length,
    lifecycleEntries: sessionLifecycle.length,
    activityLogEntries: activityLogs.length,
    closedSessionCount: closedSessions.length,
  });

  return {
    timestamp: now.toISOString(),
    lookbackHours,
    creditHistory,
    healthSignals,
    sessionLifecycle,
    activityLogs,
    closedSessions,
    gitLogs,
    betaProdGap,
  };
}

/**
 * Read all activity log files and return entries within the cutoff window.
 */
function readActivityLogs(dataDir, cutoff) {
  const logsDir = path.join(dataDir, 'activity-logs');
  const entries = [];
  try {
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = readJsonSafe(path.join(logsDir, file), []);
        if (!Array.isArray(data)) continue;
        for (const entry of data) {
          if (entry.timestamp && new Date(entry.timestamp) >= cutoff) {
            entries.push({ ...entry, _sourceFile: file });
          }
        }
      } catch {
        log.debug(TAG, 'suppressed error reading activity log', { file });
      }
    }
  } catch {
    log.debug(TAG, 'suppressed error reading activity-logs dir');
  }
  return entries;
}

function getGitLog(projectPath, lookbackHours) {
  const since = `${lookbackHours} hours ago`;
  return runGitSafe(
    `git log --oneline --since="${since}" -30`,
    projectPath
  );
}

// ── Closed session report ───────────────────────────────────────────────────

/**
 * Finds sessions that were active in the lookback window but are now stopped.
 * @param {{ dataDir: string, lookbackHours?: number }} opts
 * @returns {Array<object>}
 */
export function buildClosedSessionReport({ dataDir, lookbackHours = 24 }) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - lookbackHours * 3600 * 1000);

  // Load sessions — handle both object-keyed and array formats
  const raw = readJsonSafe(path.join(dataDir, 'sessions.json'), {});
  let sessions = [];
  if (Array.isArray(raw)) {
    sessions = raw;
  } else if (raw && typeof raw === 'object' && raw.sessions) {
    if (Array.isArray(raw.sessions)) {
      sessions = raw.sessions;
    } else if (typeof raw.sessions === 'object') {
      sessions = Object.values(raw.sessions);
    }
  }

  // Load session archive directory
  const archiveDir = path.join(dataDir, 'session-archive');
  const archivedIds = new Set();
  try {
    const archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
    for (const f of archiveFiles) {
      archivedIds.add(f.replace('.json', ''));
    }
  } catch {
    // No archive directory — that's fine
  }

  const report = [];

  for (const sess of sessions) {
    if (!sess || !sess.id) continue;

    // Only stopped sessions
    if (sess.status !== 'stopped') continue;

    // Must have a timestamp within the lookback window
    const timestamps = [sess.exitedAt, sess.startedAt, sess.lastActiveAt]
      .filter(Boolean)
      .map(t => new Date(t))
      .filter(d => !isNaN(d.getTime()));

    if (timestamps.length === 0) continue;

    const mostRecent = new Date(Math.max(...timestamps.map(d => d.getTime())));
    if (mostRecent < cutoff) continue;

    // Cross-reference with activity logs
    const logKey = sess.tmuxName || sess.name || sess.id;
    const logFile = path.join(dataDir, 'activity-logs', `${logKey}.json`);
    const activityLog = readJsonSafe(logFile, []);
    const activityLogEntries = Array.isArray(activityLog) ? activityLog.length : 0;

    // Get last summary from activity log
    let lastSummary = null;
    if (Array.isArray(activityLog) && activityLog.length > 0) {
      const last = activityLog[activityLog.length - 1];
      lastSummary = last.summary || null;
    }

    report.push({
      id: sess.id,
      name: sess.name || null,
      status: sess.status,
      startedAt: sess.startedAt || null,
      exitedAt: sess.exitedAt || null,
      activityLogEntries,
      lastSummary,
      archived: archivedIds.has(sess.id),
      hasActivityLog: activityLogEntries > 0,
    });
  }

  return report;
}

// ── Project context ─────────────────────────────────────────────────────────

/**
 * Reads project-level files for audit context.
 * @param {string} projectPath
 * @returns {object}
 */
export function buildProjectContext(projectPath) {
  const claudeMd = readFileSafe(path.join(projectPath, 'CLAUDE.md'));
  const backlog = readFileSafe(path.join(projectPath, 'BACKLOG.md'));
  const recommendations = readFileSafe(path.join(projectPath, 'recommendations.md'));
  const blindSpots = readFileSafe(path.join(projectPath, 'blind-spots.md'));
  const gitLog = runGitSafe('git log --oneline -20', projectPath);

  return {
    claudeMd,
    backlog,
    recommendations,
    blindSpots,
    gitLog,
  };
}

// ── Format for AI prompt ────────────────────────────────────────────────────

const MAX_SECTION_CHARS = 4000;

function truncate(text, maxChars = MAX_SECTION_CHARS) {
  if (!text || text.length <= maxChars) return text || '';
  return text.slice(0, maxChars) + `\n... [truncated, ${text.length - maxChars} chars omitted]`;
}

/**
 * Formats the context objects into a text string for the AI prompt.
 * @param {object} ctx — from buildAuditContext
 * @param {object} [projectCtx] — from buildProjectContext
 * @returns {string}
 */
export function formatContextForPrompt(ctx, projectCtx) {
  const parts = [];

  parts.push(`## Audit Context (${ctx.lookbackHours}h lookback)`);
  parts.push(`Generated: ${ctx.timestamp}`);
  parts.push('');

  // Credit history
  if (ctx.creditHistory && ctx.creditHistory.length > 0) {
    const latest = ctx.creditHistory[ctx.creditHistory.length - 1];
    parts.push('### Credit History');
    parts.push(`Entries: ${ctx.creditHistory.length}`);
    if (latest.todayCostUSD != null) {
      parts.push(`Today cost: $${latest.todayCostUSD.toFixed(2)}`);
    }
    if (latest.burnRateCostPerHour != null) {
      parts.push(`Burn rate: $${latest.burnRateCostPerHour.toFixed(2)}/hr`);
    }
    if (latest.breakdown) {
      const bd = latest.breakdown;
      parts.push(`Breakdown — factory: $${(bd.factory || 0).toFixed(2)}, watchdog: $${(bd.watchdog || 0).toFixed(2)}, devV2: $${(bd.devV2 || 0).toFixed(2)}, devV1: $${(bd.devV1 || 0).toFixed(2)}, other: $${(bd.other || 0).toFixed(2)}, total: $${(bd.total || 0).toFixed(2)}`);
    }
    parts.push('');
  }

  // Health signals
  if (ctx.healthSignals && Object.keys(ctx.healthSignals).length > 0) {
    parts.push('### Health Signals');
    parts.push(truncate(JSON.stringify(ctx.healthSignals, null, 2)));
    parts.push('');
  }

  // Session lifecycle
  if (ctx.sessionLifecycle && ctx.sessionLifecycle.length > 0) {
    parts.push('### Session Lifecycle Events');
    parts.push(`Events in window: ${ctx.sessionLifecycle.length}`);
    const recent = ctx.sessionLifecycle.slice(-20);
    for (const e of recent) {
      parts.push(`  [${e.ts}] ${e.event} — ${e.name || e.sessionId} (project: ${e.projectName || e.projectId || 'unknown'})`);
    }
    parts.push('');
  }

  // Activity logs
  if (ctx.activityLogs && ctx.activityLogs.length > 0) {
    parts.push('### Activity Logs');
    parts.push(`Entries in window: ${ctx.activityLogs.length}`);
    const recent = ctx.activityLogs.slice(-30);
    for (const e of recent) {
      const state = e.state ? ` [${e.state}]` : '';
      parts.push(`  [${e.timestamp}]${state} ${e.session || e._sourceFile || ''}: ${e.summary || ''}`);
    }
    parts.push('');
  }

  // Closed sessions
  if (ctx.closedSessions && ctx.closedSessions.length > 0) {
    parts.push('### Closed Sessions');
    for (const s of ctx.closedSessions) {
      parts.push(`  ${s.id} (${s.name || 'unnamed'}) — ${s.status}, exited: ${s.exitedAt || 'unknown'}, logs: ${s.activityLogEntries}, archived: ${s.archived}`);
      if (s.lastSummary) {
        parts.push(`    Last: ${truncate(s.lastSummary, 200)}`);
      }
    }
    parts.push('');
  }

  // Git logs
  if (ctx.gitLogs) {
    for (const [pp, gitLog] of Object.entries(ctx.gitLogs)) {
      if (gitLog) {
        parts.push(`### Git Log: ${pp}`);
        parts.push(truncate(gitLog, 2000));
        parts.push('');
      }
    }
  }

  // Beta/prod gap
  if (ctx.betaProdGap) {
    parts.push('### Beta/Prod Gap');
    parts.push(truncate(ctx.betaProdGap, 1000));
    parts.push('');
  }

  // Project context (if provided)
  if (projectCtx) {
    if (projectCtx.claudeMd) {
      parts.push('### Project CLAUDE.md');
      parts.push(truncate(projectCtx.claudeMd, 3000));
      parts.push('');
    }
    if (projectCtx.backlog) {
      parts.push('### BACKLOG.md');
      parts.push(truncate(projectCtx.backlog, 3000));
      parts.push('');
    }
    if (projectCtx.recommendations) {
      parts.push('### recommendations.md');
      parts.push(truncate(projectCtx.recommendations, 2000));
      parts.push('');
    }
    if (projectCtx.blindSpots) {
      parts.push('### blind-spots.md');
      parts.push(truncate(projectCtx.blindSpots, 2000));
      parts.push('');
    }
    if (projectCtx.gitLog) {
      parts.push('### Project Git Log');
      parts.push(truncate(projectCtx.gitLog, 2000));
      parts.push('');
    }
  }

  return parts.join('\n');
}

// ── Beta/prod gap ───────────────────────────────────────────────────────────

/**
 * Checks git log of beta worktree to find commits not on main.
 * @param {string} v2Path — path to the main v2 repo
 * @returns {string|null}
 */
export function getBetaProdGap(v2Path) {
  // Beta worktree is conventionally at v2Path + '-beta'
  const betaPath = v2Path.replace(/\/?$/, '') + '-beta';
  try {
    if (!fs.existsSync(betaPath)) return null;
  } catch {
    return null;
  }

  const gap = runGitSafe('git log main..HEAD --oneline -20', betaPath);
  if (!gap) return null;
  return gap;
}

// ── Digest file I/O ─────────────────────────────────────────────────────────

/**
 * Load previous daily digest files.
 * @param {string} projectPath
 * @param {number} count — max digests to return
 * @returns {Array<{ date: string, content: string }>}
 */
export function loadPreviousDigests(projectPath, count = 14) {
  const digestDir = path.join(projectPath, 'AUDIT-DIGESTS', 'daily');
  try {
    const files = fs.readdirSync(digestDir)
      .filter(f => f.endsWith('.md'))
      .sort(); // chronological by date in filename
    const selected = files.slice(-count);
    return selected.map(f => ({
      date: f.replace('.md', ''),
      content: readFileSafe(path.join(digestDir, f)),
    }));
  } catch {
    return [];
  }
}

/**
 * Atomic write of a daily digest.
 * @param {string} projectPath
 * @param {string} date — YYYY-MM-DD
 * @param {string} content
 */
export function writeDigest(projectPath, date, content) {
  const filePath = path.join(projectPath, 'AUDIT-DIGESTS', 'daily', `${date}.md`);
  atomicWrite(filePath, content);
  log.info(TAG, 'digest written', { date, path: filePath });
}

/**
 * Atomic write of a weekly review.
 * @param {string} projectPath
 * @param {string} date — YYYY-MM-DD
 * @param {string} content
 */
export function writeWeeklyReview(projectPath, date, content) {
  const filePath = path.join(projectPath, 'AUDIT-DIGESTS', 'reviews', `${date}.md`);
  atomicWrite(filePath, content);
  log.info(TAG, 'weekly review written', { date, path: filePath });
}

/**
 * Append new recommendation entries to recommendations.md table.
 * @param {string} projectPath
 * @param {Array<{ date: string, priority: string, recommendation: string, status: string }>} newEntries
 */
export function updateRecommendations(projectPath, newEntries) {
  const filePath = path.join(projectPath, 'recommendations.md');
  let existing = readFileSafe(filePath);

  if (!existing) {
    existing = '# Recommendations\n\n| Date | Priority | Recommendation | Status |\n|------|----------|----------------|--------|\n';
  }

  const lines = [];
  for (const entry of newEntries) {
    lines.push(`| ${entry.date || ''} | ${entry.priority || ''} | ${entry.recommendation || ''} | ${entry.status || 'open'} |`);
  }

  const updated = existing.trimEnd() + '\n' + lines.join('\n') + '\n';
  atomicWrite(filePath, updated);
  log.info(TAG, 'recommendations updated', { newEntries: newEntries.length });
}

/**
 * Overwrite blind-spots.md with new content.
 * @param {string} projectPath
 * @param {Array<{ area: string, description: string, severity: string }>} spots
 */
export function updateBlindSpots(projectPath, spots) {
  const lines = ['# Blind Spots', '', '| Area | Description | Severity |', '|------|-------------|----------|'];
  for (const spot of spots) {
    lines.push(`| ${spot.area || ''} | ${spot.description || ''} | ${spot.severity || ''} |`);
  }

  const filePath = path.join(projectPath, 'blind-spots.md');
  atomicWrite(filePath, lines.join('\n') + '\n');
  log.info(TAG, 'blind spots updated', { count: spots.length });
}

/**
 * Move digests older than keepDays to archive/.
 * @param {string} projectPath
 * @param {number} keepDays
 * @returns {number} count of moved files
 */
export function pruneOldDigests(projectPath, keepDays = 90) {
  const dailyDir = path.join(projectPath, 'AUDIT-DIGESTS', 'daily');
  const archiveDir = path.join(projectPath, 'AUDIT-DIGESTS', 'archive');

  let moved = 0;
  try {
    const files = fs.readdirSync(dailyDir).filter(f => f.endsWith('.md'));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);

    for (const file of files) {
      const dateStr = file.replace('.md', '');
      const fileDate = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(fileDate.getTime())) continue;

      if (fileDate < cutoff) {
        fs.mkdirSync(archiveDir, { recursive: true });
        const src = path.join(dailyDir, file);
        const dest = path.join(archiveDir, file);
        fs.renameSync(src, dest);
        moved++;
      }
    }
  } catch (err) {
    log.debug(TAG, 'suppressed error pruning digests', { error: err.message });
  }

  if (moved > 0) {
    log.info(TAG, 'digests pruned', { moved, keepDays });
  }
  return moved;
}
