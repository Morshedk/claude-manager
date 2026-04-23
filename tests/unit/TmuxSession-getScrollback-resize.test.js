/**
 * Regression test: TmuxSession.getScrollback() must call `tmux resize-window`
 * before `tmux capture-pane`.
 *
 * Bug: TmuxSession.resize() sends SIGWINCH via node-pty, but tmux processes it
 * asynchronously. When getScrollback() calls capture-pane immediately after,
 * the tmux window may still be at the old column width, producing scrollback
 * that wraps at the wrong column count and garbles the terminal display.
 *
 * Fix: getScrollback() must issue `tmux resize-window -t <name> -x <cols> -y <rows>`
 * synchronously (via tmux socket) before capture-pane, ensuring the window is
 * at the correct dimensions regardless of async SIGWINCH processing.
 */

import { jest } from '@jest/globals';

// ── Mock child_process ─────────────────────────────────────────────────────
const mockExecSync = jest.fn().mockReturnValue('');

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync,
}));

// ── Mock node-pty ──────────────────────────────────────────────────────────
const mockPtyProcess = {
  onData: jest.fn(),
  onExit: jest.fn(),
  write: jest.fn(),
  resize: jest.fn(),
  kill: jest.fn(),
};
const mockPtySpawn = jest.fn().mockReturnValue(mockPtyProcess);
jest.unstable_mockModule('node-pty', () => ({
  spawn: mockPtySpawn,
  default: { spawn: mockPtySpawn },
}));

// ── Import after mocks ─────────────────────────────────────────────────────
const { TmuxSession } = await import('../../lib/sessions/TmuxSession.js');
const { STATES } = await import('../../lib/sessions/sessionStates.js');

function makeMeta() {
  return {
    id: 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb',
    cwd: '/tmp/test',
    command: 'claude',
  };
}
function makeStore() {
  return { upsert: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  mockExecSync.mockReset();
  mockExecSync.mockReturnValue(''); // tmux has-session succeeds; capture-pane returns empty
});

// Helper: extract the ordered list of tmux subcommands from execSync calls
function tmuxCmds() {
  return mockExecSync.mock.calls
    .map(([cmd]) => cmd)
    .filter(cmd => typeof cmd === 'string' && cmd.includes('tmux '));
}

describe('TmuxSession.getScrollback — resize-before-capture ordering', () => {
  test('calls tmux resize-window BEFORE capture-pane when dimensions are set', () => {
    const session = new TmuxSession(makeMeta(), makeStore(), { cols: 133, rows: 55 });
    session.meta.status = STATES.RUNNING;
    session.resize(79, 41);

    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('scrollback content');

    session.getScrollback();

    const calls = tmuxCmds();
    const resizeIdx = calls.findIndex(c => c.includes('resize-window'));
    const captureIdx = calls.findIndex(c => c.includes('capture-pane'));

    expect(resizeIdx).toBeGreaterThanOrEqual(0);  // resize-window must be called
    expect(captureIdx).toBeGreaterThanOrEqual(0);  // capture-pane must be called
    expect(resizeIdx).toBeLessThan(captureIdx);     // resize-window must come FIRST
  });

  test('resize-window uses the dimensions from the most recent resize() call', () => {
    const session = new TmuxSession(makeMeta(), makeStore(), { cols: 133, rows: 55 });
    session.meta.status = STATES.RUNNING;
    session.resize(79, 41);

    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('');

    session.getScrollback();

    const resizeCmd = tmuxCmds().find(c => c.includes('resize-window'));
    expect(resizeCmd).toBeDefined();
    expect(resizeCmd).toContain('-x 79');
    expect(resizeCmd).toContain('-y 41');
  });

  test('resize-window targets the correct tmux session name', () => {
    const session = new TmuxSession(makeMeta(), makeStore(), { cols: 79, rows: 41 });
    session.meta.status = STATES.RUNNING;

    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('');

    session.getScrollback();

    const resizeCmd = tmuxCmds().find(c => c.includes('resize-window'));
    expect(resizeCmd).toContain('cm-aaaabbbb');
  });
});
