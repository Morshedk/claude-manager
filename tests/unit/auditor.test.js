import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  AUDIT_DAILY_PROMPT,
  AUDIT_WEEKLY_PROMPT,
  buildAuditContext,
  buildClosedSessionReport,
  buildProjectContext,
  formatContextForPrompt,
  getBetaProdGap,
  writeDigest,
  writeWeeklyReview,
  loadPreviousDigests,
  pruneOldDigests,
  updateRecommendations,
  updateBlindSpots,
} from '../../lib/watchdog/auditor.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-test-'));
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
    expect(ctx).toHaveProperty('lookbackHours');
    expect(ctx).toHaveProperty('gitLogs');
    expect(ctx).toHaveProperty('betaProdGap');
  });

  test('defaults lookbackHours to 24', () => {
    const ctx = buildAuditContext({ dataDir: tmpDir });
    expect(ctx.lookbackHours).toBe(24);
  });

  test('reads credit history (last 48 entries)', () => {
    const entries = [];
    for (let i = 0; i < 60; i++) {
      entries.push({ timestamp: new Date().toISOString(), blockCostUSD: i });
    }
    fs.writeFileSync(path.join(tmpDir, 'credit-history.json'), JSON.stringify(entries));
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    expect(ctx.creditHistory).toHaveLength(48);
    expect(ctx.creditHistory[0].blockCostUSD).toBe(12); // entries 12-59
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

  test('filters session lifecycle to lookback window', () => {
    const now = new Date();
    const old = new Date(now.getTime() - 48 * 3600 * 1000);
    const recent = new Date(now.getTime() - 2 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'session-lifecycle.json'), JSON.stringify([
      { ts: old.toISOString(), event: 'created', sessionId: 's1' },
      { ts: recent.toISOString(), event: 'deleted', sessionId: 's2' },
    ]));
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    expect(ctx.sessionLifecycle).toHaveLength(1);
    expect(ctx.sessionLifecycle[0].sessionId).toBe('s2');
  });

  test('handles missing data files gracefully', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-empty-'));
    const ctx = buildAuditContext({ dataDir: emptyDir, lookbackHours: 24 });
    expect(ctx.creditHistory).toEqual([]);
    expect(ctx.healthSignals).toEqual({});
    expect(ctx.sessionLifecycle).toEqual([]);
    expect(ctx.activityLogs).toEqual([]);
    expect(ctx.closedSessions).toEqual([]);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  test('reads health signals', () => {
    fs.writeFileSync(path.join(tmpDir, 'health.json'), JSON.stringify({
      watchdog: { lastReview: '2026-04-27T10:00:00Z' },
    }));
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    expect(ctx.healthSignals.watchdog).toBeDefined();
    expect(ctx.healthSignals.watchdog.lastReview).toBe('2026-04-27T10:00:00Z');
  });

  test('includes _sourceFile in activity log entries', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'activity-logs', 'factory.json'), JSON.stringify([
      { timestamp: recent.toISOString(), summary: 'test entry' },
    ]));
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    expect(ctx.activityLogs[0]._sourceFile).toBe('factory.json');
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

  test('excludes running sessions', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      sessions: {
        's1': { id: 's1', name: 'running-test', status: 'running', startedAt: recent.toISOString() },
      },
    }));
    const report = buildClosedSessionReport({ dataDir: tmpDir, lookbackHours: 24 });
    expect(report).toHaveLength(0);
  });

  test('excludes sessions outside lookback window', () => {
    const now = new Date();
    const old = new Date(now.getTime() - 48 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      sessions: {
        's1': { id: 's1', name: 'old-test', status: 'stopped', exitedAt: old.toISOString() },
      },
    }));
    const report = buildClosedSessionReport({ dataDir: tmpDir, lookbackHours: 24 });
    expect(report).toHaveLength(0);
  });

  test('handles array format sessions.json', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([
      { id: 's1', name: 'arr-test', status: 'stopped', exitedAt: recent.toISOString() },
    ]));
    const report = buildClosedSessionReport({ dataDir: tmpDir, lookbackHours: 24 });
    expect(report).toHaveLength(1);
    expect(report[0].name).toBe('arr-test');
  });

  test('cross-references activity logs', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      sessions: {
        's1': { id: 's1', name: 'test', status: 'stopped', tmuxName: 'cm-s1', exitedAt: recent.toISOString() },
      },
    }));
    fs.writeFileSync(path.join(tmpDir, 'activity-logs', 'cm-s1.json'), JSON.stringify([
      { timestamp: recent.toISOString(), summary: 'did something' },
      { timestamp: recent.toISOString(), summary: 'did more' },
    ]));
    const report = buildClosedSessionReport({ dataDir: tmpDir, lookbackHours: 24 });
    expect(report[0].activityLogEntries).toBe(2);
    expect(report[0].lastSummary).toBe('did more');
    expect(report[0].hasActivityLog).toBe(true);
  });

  test('detects archived sessions', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 3600 * 1000);
    fs.mkdirSync(path.join(tmpDir, 'session-archive'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'session-archive', 's1.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      sessions: {
        's1': { id: 's1', name: 'archived', status: 'stopped', exitedAt: recent.toISOString() },
      },
    }));
    const report = buildClosedSessionReport({ dataDir: tmpDir, lookbackHours: 24 });
    expect(report[0].archived).toBe(true);
  });
});

describe('buildProjectContext', () => {
  test('reads project files', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Project\nSome info');
    fs.writeFileSync(path.join(projDir, 'BACKLOG.md'), '# Backlog\n- item 1');
    const ctx = buildProjectContext(projDir);
    expect(ctx.claudeMd).toContain('# Project');
    expect(ctx.backlog).toContain('item 1');
    expect(ctx.recommendations).toBe('');
    expect(ctx.blindSpots).toBe('');
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test('returns empty strings for missing files', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    const ctx = buildProjectContext(projDir);
    expect(ctx.claudeMd).toBe('');
    expect(ctx.backlog).toBe('');
    expect(ctx.recommendations).toBe('');
    expect(ctx.blindSpots).toBe('');
    fs.rmSync(projDir, { recursive: true, force: true });
  });
});

describe('formatContextForPrompt', () => {
  test('produces a non-empty string', () => {
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    const text = formatContextForPrompt(ctx);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  test('includes audit context header', () => {
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    const text = formatContextForPrompt(ctx);
    expect(text).toContain('Audit Context (24h lookback)');
  });

  test('includes credit history section when present', () => {
    fs.writeFileSync(path.join(tmpDir, 'credit-history.json'), JSON.stringify([
      { timestamp: new Date().toISOString(), todayCostUSD: 5.50, burnRateCostPerHour: 1.25 },
    ]));
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    const text = formatContextForPrompt(ctx);
    expect(text).toContain('Credit History');
    expect(text).toContain('$5.50');
    expect(text).toContain('$1.25/hr');
  });

  test('includes activity logs section when present', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1 * 3600 * 1000);
    fs.writeFileSync(path.join(tmpDir, 'activity-logs', 'factory.json'), JSON.stringify([
      { timestamp: recent.toISOString(), summary: 'Built auth module', state: 'productive', session: 'factory' },
    ]));
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    const text = formatContextForPrompt(ctx);
    expect(text).toContain('Activity Logs');
    expect(text).toContain('Built auth module');
  });

  test('includes project context when provided', () => {
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    const projCtx = {
      claudeMd: '# My Project\nImportant info',
      backlog: '# Backlog\n- Fix bug',
      recommendations: '',
      blindSpots: '',
      gitLog: 'abc123 Initial commit',
    };
    const text = formatContextForPrompt(ctx, projCtx);
    expect(text).toContain('Project CLAUDE.md');
    expect(text).toContain('Important info');
    expect(text).toContain('BACKLOG.md');
    expect(text).toContain('Fix bug');
    expect(text).toContain('Project Git Log');
  });

  test('truncates large sections', () => {
    const largeClaude = 'x'.repeat(10000);
    const ctx = buildAuditContext({ dataDir: tmpDir, lookbackHours: 24 });
    const projCtx = {
      claudeMd: largeClaude,
      backlog: '',
      recommendations: '',
      blindSpots: '',
      gitLog: '',
    };
    const text = formatContextForPrompt(ctx, projCtx);
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(largeClaude.length);
  });
});

describe('getBetaProdGap', () => {
  test('returns null for non-existent beta path', () => {
    const result = getBetaProdGap('/tmp/nonexistent-path-abc123');
    expect(result).toBeNull();
  });
});

describe('writeDigest and loadPreviousDigests', () => {
  test('writes and reads back digest files', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    writeDigest(projDir, '2026-04-27', '# Digest 1\nContent here.');
    writeDigest(projDir, '2026-04-28', '# Digest 2\nMore content.');
    const digests = loadPreviousDigests(projDir, 14);
    expect(digests).toHaveLength(2);
    expect(digests[0].date).toBe('2026-04-27');
    expect(digests[1].date).toBe('2026-04-28');
    expect(digests[0].content).toContain('Digest 1');
    expect(digests[1].content).toContain('Digest 2');
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test('respects count limit', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    writeDigest(projDir, '2026-04-25', 'day 1');
    writeDigest(projDir, '2026-04-26', 'day 2');
    writeDigest(projDir, '2026-04-27', 'day 3');
    const digests = loadPreviousDigests(projDir, 2);
    expect(digests).toHaveLength(2);
    expect(digests[0].date).toBe('2026-04-26');
    expect(digests[1].date).toBe('2026-04-27');
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test('returns empty array when no digests exist', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    const digests = loadPreviousDigests(projDir, 14);
    expect(digests).toEqual([]);
    fs.rmSync(projDir, { recursive: true, force: true });
  });
});

describe('writeWeeklyReview', () => {
  test('writes to reviews directory', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    writeWeeklyReview(projDir, '2026-04-27', '# Weekly Review\nContent.');
    const filePath = path.join(projDir, 'AUDIT-DIGESTS', 'reviews', '2026-04-27.md');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('Weekly Review');
    fs.rmSync(projDir, { recursive: true, force: true });
  });
});

describe('pruneOldDigests', () => {
  test('moves old digests to archive', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    writeDigest(projDir, '2020-01-01', 'ancient');
    writeDigest(projDir, '2026-04-28', 'recent');
    const moved = pruneOldDigests(projDir, 90);
    expect(moved).toBe(1);
    expect(fs.existsSync(path.join(projDir, 'AUDIT-DIGESTS', 'archive', '2020-01-01.md'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, 'AUDIT-DIGESTS', 'daily', '2026-04-28.md'))).toBe(true);
    // Verify the old one is removed from daily
    expect(fs.existsSync(path.join(projDir, 'AUDIT-DIGESTS', 'daily', '2020-01-01.md'))).toBe(false);
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test('does nothing when all digests are recent', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    writeDigest(projDir, '2026-04-27', 'recent 1');
    writeDigest(projDir, '2026-04-28', 'recent 2');
    const moved = pruneOldDigests(projDir, 90);
    expect(moved).toBe(0);
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test('handles empty digest directory', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    const moved = pruneOldDigests(projDir, 90);
    expect(moved).toBe(0);
  });
});

describe('updateRecommendations', () => {
  test('creates recommendations.md if missing', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    updateRecommendations(projDir, [
      { date: '2026-04-27', priority: 'high', recommendation: 'Fix the bug', status: 'open' },
    ]);
    const content = fs.readFileSync(path.join(projDir, 'recommendations.md'), 'utf8');
    expect(content).toContain('# Recommendations');
    expect(content).toContain('Fix the bug');
    expect(content).toContain('high');
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test('appends to existing recommendations.md', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    const existing = '# Recommendations\n\n| Date | Priority | Recommendation | Status |\n|------|----------|----------------|--------|\n| 2026-04-26 | low | Old item | done |\n';
    fs.writeFileSync(path.join(projDir, 'recommendations.md'), existing);
    updateRecommendations(projDir, [
      { date: '2026-04-27', priority: 'high', recommendation: 'New item', status: 'open' },
    ]);
    const content = fs.readFileSync(path.join(projDir, 'recommendations.md'), 'utf8');
    expect(content).toContain('Old item');
    expect(content).toContain('New item');
    fs.rmSync(projDir, { recursive: true, force: true });
  });
});

describe('updateBlindSpots', () => {
  test('overwrites blind-spots.md', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    updateBlindSpots(projDir, [
      { area: 'Testing', description: 'No e2e tests', severity: 'high' },
      { area: 'Docs', description: 'Missing API docs', severity: 'medium' },
    ]);
    const content = fs.readFileSync(path.join(projDir, 'blind-spots.md'), 'utf8');
    expect(content).toContain('# Blind Spots');
    expect(content).toContain('No e2e tests');
    expect(content).toContain('Missing API docs');
    fs.rmSync(projDir, { recursive: true, force: true });
  });
});

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
