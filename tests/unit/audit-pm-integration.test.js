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
