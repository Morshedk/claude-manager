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
    expect(items[0].shipped).toBe('2026-04-10');
    expect(items[1].id).toBe('TST-002');
    expect(items[1].priority).toBe('P1');
    expect(items[1].done).toBe(false);
    expect(items[1].estimate).toBe('4h');
    expect(items[1].acceptance).toBe('feature A works correctly');
    expect(items[2].id).toBe('TST-003');
    expect(items[2].blockedBy).toContain('TST-002');
    expect(items[2].priority).toBe('P2');
    expect(items[2].estimate).toBe('6h');
    expect(items[3].id).toBe('BUG-001');
    expect(items[3].source).toBe('qa 2026-04-20');
    expect(items[3].section).toBe('Bugs');
  });

  test('returns empty array when no BACKLOG.md exists', () => {
    expect(parseBacklog(tmpDir)).toEqual([]);
  });

  test('handles empty BACKLOG.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'BACKLOG.md'), '');
    expect(parseBacklog(tmpDir)).toEqual([]);
  });

  test('handles items without metadata', () => {
    fs.writeFileSync(path.join(tmpDir, 'BACKLOG.md'), `# Backlog — Minimal

## Core
- [ ] MIN-001: Just a title
`);
    const items = parseBacklog(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('MIN-001');
    expect(items[0].title).toBe('Just a title');
    expect(items[0].priority).toBeNull();
    expect(items[0].estimate).toBeNull();
    expect(items[0].blockedBy).toBeNull();
    expect(items[0].source).toBeNull();
    expect(items[0].acceptance).toBeNull();
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
    expect(content).toContain('est: 4h');
    expect(content).toContain('Acceptance: A works');
    expect(content).toContain('shipped 2026-04-10');
  });

  test('groups items by section with status indicators', () => {
    const items = [
      { id: 'A-001', title: 'Done thing', done: true, shipped: null, section: 'Phase 1: Core', priority: null, estimate: null, acceptance: null, blockedBy: null, source: null },
      { id: 'A-002', title: 'Undone thing', done: false, shipped: null, section: 'Phase 1: Core', priority: null, estimate: null, acceptance: null, blockedBy: null, source: null },
      { id: 'B-001', title: 'All done', done: true, shipped: null, section: 'Phase 2: Extra', priority: null, estimate: null, acceptance: null, blockedBy: null, source: null },
    ];
    writeBacklog(tmpDir, 'Test', items);
    const content = fs.readFileSync(path.join(tmpDir, 'BACKLOG.md'), 'utf8');
    expect(content).toContain('## Phase 1: Core (in progress)');
    expect(content).toContain('## Phase 2: Extra (complete)');
  });

  test('writes blocked-by metadata', () => {
    const items = [
      { id: 'X-001', title: 'Blocked task', done: false, shipped: null, section: 'Core', priority: 'P2', estimate: null, acceptance: null, blockedBy: ['X-002', 'X-003'], source: null },
    ];
    writeBacklog(tmpDir, 'Test', items);
    const content = fs.readFileSync(path.join(tmpDir, 'BACKLOG.md'), 'utf8');
    expect(content).toContain('blocked-by: X-002, X-003');
  });

  test('atomic write creates valid file', () => {
    const items = [
      { id: 'AW-001', title: 'Atomic', done: false, shipped: null, section: 'Core', priority: null, estimate: null, acceptance: null, blockedBy: null, source: null },
    ];
    writeBacklog(tmpDir, 'Test', items);
    // Verify no .tmp file left behind
    const files = fs.readdirSync(tmpDir);
    expect(files).not.toContain('BACKLOG.md.tmp');
    expect(files).toContain('BACKLOG.md');
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

  test('handles CLAUDE.md with sprint at end of file', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# Project

## Current Sprint (updated 2026-04-26 04:00 UTC)

1. **OLD-001: Old task**
`);
    const sprintItems = [
      { id: 'NEW-001', title: 'New task', acceptance: 'works', description: 'Do new thing.' },
    ];
    updateCurrentSprint(tmpDir, sprintItems);
    const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('NEW-001');
    expect(content).not.toContain('OLD-001');
  });

  test('creates CLAUDE.md if it does not exist', () => {
    const sprintItems = [
      { id: 'X-001', title: 'First task', acceptance: 'works', description: 'Do it.' },
    ];
    updateCurrentSprint(tmpDir, sprintItems);
    const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('## Current Sprint');
    expect(content).toContain('X-001');
  });

  test('formats numbered list with description and acceptance', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Proj\n');
    const sprintItems = [
      { id: 'A-001', title: 'Task one', acceptance: 'criterion 1', description: 'Do task one.' },
      { id: 'A-002', title: 'Task two', acceptance: 'criterion 2', description: 'Do task two.' },
    ];
    updateCurrentSprint(tmpDir, sprintItems);
    const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('1. **A-001: Task one**');
    expect(content).toContain('2. **A-002: Task two**');
    expect(content).toContain('Do task one.');
    expect(content).toContain('- Acceptance: criterion 1');
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
    expect(items[0].id).toBe('NPH-001');
    expect(items[0].section).toContain('Phase 1');
    expect(items[0].priority).toBe('P1');
    expect(items[4].section).toContain('Phase 2');
    expect(items[4].priority).toBe('P2');
    expect(fs.existsSync(path.join(tmpDir, 'BACKLOG.md'))).toBe(true);

    // Verify the written file can be parsed back
    const parsed = parseBacklog(tmpDir);
    expect(parsed.length).toBe(items.length);
    expect(parsed[0].id).toBe('NPH-001');
  });

  test('returns empty array when no CLAUDE.md exists', () => {
    const items = seedBacklogFromRoadmap(tmpDir, 'Test', 'TST');
    expect(items).toEqual([]);
  });

  test('returns empty array when no phases found', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# Project

## Notes
Just some notes, no phases here.
`);
    const items = seedBacklogFromRoadmap(tmpDir, 'Test', 'TST');
    expect(items).toEqual([]);
  });

  test('assigns P3 to phases beyond phase 3', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# Project

## Build Phases

### Phase 4 (Week 7-8): Polish
- Final polish task
- Another polish task
`);
    const items = seedBacklogFromRoadmap(tmpDir, 'Test', 'TST');
    expect(items.length).toBe(2);
    expect(items[0].priority).toBe('P3');
    expect(items[0].section).toContain('Phase 4');
  });
});

describe('PM_CYCLE_PROMPT', () => {
  test('exports a non-empty prompt string', async () => {
    const { PM_CYCLE_PROMPT } = await import('../../lib/watchdog/pm.js');
    expect(typeof PM_CYCLE_PROMPT).toBe('string');
    expect(PM_CYCLE_PROMPT.length).toBeGreaterThan(100);
    expect(PM_CYCLE_PROMPT).toContain('completedIds');
    expect(PM_CYCLE_PROMPT).toContain('newItems');
    expect(PM_CYCLE_PROMPT).toContain('scopeCreep');
    expect(PM_CYCLE_PROMPT).toContain('sprint');
    expect(PM_CYCLE_PROMPT).toContain('report');
  });
});
