/**
 * Unit tests for SessionLogManager.
 *
 * child_process.execSync is mocked to avoid real tmux calls.
 * fs operations use real temp directories (mkdtempSync).
 */

import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --------------------------------------------------------------------------
// Mock child_process — must be registered before importing the module
// --------------------------------------------------------------------------
const mockExecSync = jest.fn().mockReturnValue('');

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync,
}));

// --------------------------------------------------------------------------
// Import module under test (after mock is registered)
// --------------------------------------------------------------------------
const { SessionLogManager } = await import('../../lib/sessionlog/SessionLogManager.js');

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// A valid UUID-style sessionId that passes the /^[0-9a-f-]{36}$/ guard
const VALID_ID = 'a1b2c3d4-1234-5678-abcd-ef0123456789';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'slm-test-'));
}

function makeManager(dataDir) {
  return new SessionLogManager({ dataDir });
}

// --------------------------------------------------------------------------
// Test suites
// --------------------------------------------------------------------------

describe('SessionLogManager — startCapture()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('calls pipe-pane with -o flag containing rawPath and tmuxName', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    const tmuxName = 'cm-a1b2c3d4';

    mgr.startCapture(VALID_ID, tmuxName);

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const [cmd] = mockExecSync.mock.calls[0];
    expect(cmd).toContain('pipe-pane');
    expect(cmd).toContain('-o');
    expect(cmd).toContain(tmuxName);
    // raw path should contain the sessionId
    expect(cmd).toContain(VALID_ID);
    expect(cmd).toContain('.raw');
  });

  test('adds sessionId to capturing set on success', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    expect(mgr.capturing.has(VALID_ID)).toBe(true);
  });

  test('silently skips invalid sessionId without calling execSync', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.startCapture('not-a-valid-uuid!!', 'cm-whatever');

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mgr.capturing.size).toBe(0);
  });

  test('does not add sessionId when execSync throws', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('tmux not running'); });
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    expect(mgr.capturing.has(VALID_ID)).toBe(false);
  });

  test('initialises offset to 0 when not previously set', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    expect(mgr._offsets.get(VALID_ID)).toBe(0);
  });

  test('does not reset an existing offset on re-capture', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr._offsets.set(VALID_ID, 1024);

    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    expect(mgr._offsets.get(VALID_ID)).toBe(1024);
  });
});

// --------------------------------------------------------------------------

describe('SessionLogManager — startCapture() — scrollback catch-up on reconnect', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does NOT call capture-pane on first start (no raw file yet)', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    // raw file does not exist (fresh temp dir)

    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    const capturePaneCall = mockExecSync.mock.calls.find(c => c[0].includes('capture-pane'));
    expect(capturePaneCall).toBeUndefined();
  });

  test('calls capture-pane BEFORE pipe-pane when raw file already exists (reconnect)', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    // create the raw file to simulate a reconnect
    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, 'prior captured content\n');

    mockExecSync.mockReturnValue(Buffer.from('scrollback line\n'));
    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    const calls      = mockExecSync.mock.calls.map(c => c[0]);
    const captureIdx = calls.findIndex(c => c.includes('capture-pane'));
    const pipeIdx    = calls.findIndex(c => c.includes('pipe-pane'));
    expect(captureIdx).toBeGreaterThanOrEqual(0);
    expect(pipeIdx).toBeGreaterThanOrEqual(0);
    expect(captureIdx).toBeLessThan(pipeIdx);
  });

  test('capture-pane call uses -p and -S -2000 flags', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, 'existing content\n');

    mockExecSync.mockReturnValue(Buffer.from(''));
    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    const captureCall = mockExecSync.mock.calls.find(c => c[0].includes('capture-pane'))?.[0];
    expect(captureCall).toContain('capture-pane');
    expect(captureCall).toContain('-p');
    expect(captureCall).toContain('-S -2000');
    expect(captureCall).toContain('cm-a1b2c3d4');
  });

  test('pipe-pane still starts when capture-pane throws on reconnect', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, 'existing content\n');

    mockExecSync
      .mockImplementationOnce(() => { throw new Error('tmux: no pane'); }) // capture-pane fails
      .mockReturnValue(Buffer.from('')); // pipe-pane succeeds

    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    const pipePaneCall = mockExecSync.mock.calls.find(c => c[0].includes('pipe-pane'));
    expect(pipePaneCall).toBeDefined();
    expect(mgr.capturing.has(VALID_ID)).toBe(true);
  });

  test('capture-pane output is appended to existing raw file', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, 'prior content\n');

    const scrollback = Buffer.from('new scrollback line\n');
    mockExecSync.mockReturnValue(scrollback);
    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');

    const rawContent = readFileSync(rawPath, 'utf8');
    expect(rawContent).toContain('prior content');
    expect(rawContent).toContain('new scrollback line');
  });
});

// --------------------------------------------------------------------------

describe('SessionLogManager — stopCapture()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('removes sessionId from capturing set', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr.startCapture(VALID_ID, 'cm-a1b2c3d4');
    jest.clearAllMocks(); // reset call counts

    mgr.stopCapture(VALID_ID, 'cm-a1b2c3d4');

    expect(mgr.capturing.has(VALID_ID)).toBe(false);
  });

  test('pipe-pane command does NOT contain -o flag', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.stopCapture(VALID_ID, 'cm-a1b2c3d4');

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const [cmd] = mockExecSync.mock.calls[0];
    expect(cmd).toContain('pipe-pane');
    expect(cmd).not.toContain(' -o ');
  });

  test('silently skips invalid sessionId', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.stopCapture('BAD_ID', 'cm-whatever');

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  test('does not throw if sessionId was never in capturing set', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    expect(() => mgr.stopCapture(VALID_ID, 'cm-a1b2c3d4')).not.toThrow();
  });
});

// --------------------------------------------------------------------------

describe('SessionLogManager — injectEvent()', () => {
  test('writes === EVENT | ts | details === line to {sessionId}.log', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.injectEvent(VALID_ID, 'SESSION_START', 'some details');

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/=== SESSION_START \| .+ \| some details ===/);
  });

  test('replaces newlines in details with spaces', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.injectEvent(VALID_ID, 'EVENT', 'line1\nline2\nline3');

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    const content = readFileSync(logPath, 'utf8');
    // The written line must stay on a single logical line between the === markers
    expect(content).toMatch(/=== EVENT \| .+ \| line1 line2 line3 ===/);
  });

  test('appends multiple events to the same log file', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    mgr.injectEvent(VALID_ID, 'FIRST', 'a');
    mgr.injectEvent(VALID_ID, 'SECOND', 'b');

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/FIRST/);
    expect(content).toMatch(/SECOND/);
  });
});

// --------------------------------------------------------------------------

describe('SessionLogManager — tick() — no-op when .raw is empty', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates no .log file when .raw file is empty', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, ''); // empty file

    mgr._capturing.add(VALID_ID);
    mgr._offsets.set(VALID_ID, 0);

    mgr.tick();

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    expect(existsSync(logPath)).toBe(false);
  });

  test('no-op when sessionId is not in capturing set', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, 'some content');

    // NOT added to _capturing — tick should not process it
    mgr.tick();

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    expect(existsSync(logPath)).toBe(false);
  });
});

// --------------------------------------------------------------------------

describe('SessionLogManager — tick() — processes new content', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates .log file with ANSI-stripped content', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const rawContent = '\x1b[32mHello, world!\x1b[0m\nSecond line\n';
    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, rawContent);

    mgr._capturing.add(VALID_ID);
    mgr._offsets.set(VALID_ID, 0);

    mgr.tick();

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('Hello, world!');
    expect(content).toContain('Second line');
    // ANSI escape codes must have been stripped
    expect(content).not.toContain('\x1b[32m');
    expect(content).not.toContain('\x1b[0m');
  });

  test('writes a timestamp marker (--- ISO_TS ---) into the log', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, 'some output\n');

    mgr._capturing.add(VALID_ID);
    mgr._offsets.set(VALID_ID, 0);

    mgr.tick();

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    const content = readFileSync(logPath, 'utf8');
    // Should contain a --- timestamp --- marker
    expect(content).toMatch(/--- \d{4}-\d{2}-\d{2}T/);
  });

  test('advances offset to fileSize (does NOT truncate .raw)', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const rawContent = 'line one\nline two\n';
    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, rawContent);

    mgr._capturing.add(VALID_ID);
    mgr._offsets.set(VALID_ID, 0);

    mgr.tick();

    // Offset should equal the original file size
    const expectedSize = Buffer.byteLength(rawContent, 'utf8');
    expect(mgr._offsets.get(VALID_ID)).toBe(expectedSize);

    // .raw file still has its original content (not truncated)
    const rawAfter = readFileSync(rawPath, 'utf8');
    expect(rawAfter).toBe(rawContent);
  });

  test('second tick is a no-op (offset == fileSize, no new content)', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const rawContent = 'initial content\n';
    const rawPath = join(dir, 'sessionlog', `${VALID_ID}.raw`);
    writeFileSync(rawPath, rawContent);

    mgr._capturing.add(VALID_ID);
    mgr._offsets.set(VALID_ID, 0);

    mgr.tick(); // first tick — processes content

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    const contentAfterFirst = readFileSync(logPath, 'utf8');

    mgr.tick(); // second tick — offset == fileSize, should be a no-op

    const contentAfterSecond = readFileSync(logPath, 'utf8');
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });
});

// --------------------------------------------------------------------------

describe('SessionLogManager — tailLog()', () => {
  test('returns null for a missing log file', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const result = mgr.tailLog(VALID_ID);

    expect(result).toBeNull();
  });

  test('returns last N lines as an array', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    writeFileSync(logPath, 'line1\nline2\nline3\nline4\nline5\n');

    const result = mgr.tailLog(VALID_ID, 3);

    // slice(-3) of 6 entries (5 lines + empty string after trailing \n)
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(3);
    // last meaningful content lines
    expect(result.join('\n')).toContain('line');
  });

  test('returns all lines when lines param exceeds file line count', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    writeFileSync(logPath, 'a\nb\nc\n');

    const result = mgr.tailLog(VALID_ID, 1000);

    expect(result).not.toBeNull();
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

// --------------------------------------------------------------------------

describe('SessionLogManager — status()', () => {
  test('returns capturing: false for a session not in capturing set', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const s = mgr.status(VALID_ID);

    expect(s.capturing).toBe(false);
  });

  test('returns capturing: true for an active session', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr._capturing.add(VALID_ID);

    const s = mgr.status(VALID_ID);

    expect(s.capturing).toBe(true);
  });

  test('returns logSizeBytes: 0 and lastActivity: null when no log exists', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const s = mgr.status(VALID_ID);

    expect(s.logSizeBytes).toBe(0);
    expect(s.lastActivity).toBeNull();
  });

  test('returns correct logSizeBytes when log file exists', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const logContent = 'hello session log\n';
    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    writeFileSync(logPath, logContent);

    const s = mgr.status(VALID_ID);

    expect(s.logSizeBytes).toBe(Buffer.byteLength(logContent, 'utf8'));
  });

  test('returns an ISO string for lastActivity when log file exists', () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const logPath = join(dir, 'sessionlog', `${VALID_ID}.log`);
    writeFileSync(logPath, 'content');

    const s = mgr.status(VALID_ID);

    expect(typeof s.lastActivity).toBe('string');
    expect(s.lastActivity).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
