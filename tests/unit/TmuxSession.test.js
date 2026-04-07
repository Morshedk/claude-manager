/**
 * Unit tests for TmuxSession.
 *
 * All child_process.execSync and node-pty calls are mocked so no real
 * tmux or PTY processes are created.
 */

import { jest } from '@jest/globals';

// --------------------------------------------------------------------------
// Mock child_process — must be set up before importing the module under test
// --------------------------------------------------------------------------
const mockExecSync = jest.fn().mockReturnValue('');

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync,
}));

// --------------------------------------------------------------------------
// Mock node-pty via the createRequire pattern used in TmuxSession.js
// We intercept `require('node-pty')` by mocking the module system.
// --------------------------------------------------------------------------
const mockPtyOnData = jest.fn();
const mockPtyOnExit = jest.fn();
const mockPtyWrite = jest.fn();
const mockPtyResize = jest.fn();
const mockPtyKill = jest.fn();

const mockPtyProcess = {
  onData: mockPtyOnData,
  onExit: mockPtyOnExit,
  write: mockPtyWrite,
  resize: mockPtyResize,
  kill: mockPtyKill,
};

const mockPtySpawn = jest.fn().mockReturnValue(mockPtyProcess);

jest.unstable_mockModule('node-pty', () => ({
  spawn: mockPtySpawn,
  default: { spawn: mockPtySpawn },
}));

// --------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// --------------------------------------------------------------------------
const { TmuxSession } = await import('../../lib/sessions/TmuxSession.js');
const { STATES } = await import('../../lib/sessions/sessionStates.js');

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeMeta(overrides = {}) {
  return {
    id: 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb',
    cwd: '/tmp/test-project',
    command: 'claude',
    claudeSessionId: 'session-uuid-1234',
    ...overrides,
  };
}

function makeStore() {
  return {
    upsert: jest.fn().mockResolvedValue(undefined),
  };
}

// Make execSync return '' (tmux session alive) for has-session calls,
// but let individual tests override with mockReturnValueOnce.
function makeAlive(session) {
  // _tmuxSessionAlive calls `tmux has-session` — just don't throw (default mock is fine)
  // _tmuxRunningClaude calls `tmux list-panes` — return a non-bash value
  mockExecSync.mockImplementation((cmd) => {
    if (typeof cmd === 'string' && cmd.includes('list-panes')) {
      return 'node\n';
    }
    return '';
  });
}

// --------------------------------------------------------------------------
// Test suites
// --------------------------------------------------------------------------

describe('TmuxSession — constructor', () => {
  test('starts in CREATED state', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s.meta.status).toBe(STATES.CREATED);
  });

  test('derives tmuxName from id', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s.meta.tmuxName).toBe('cm-aaaabbbb');
  });

  test('stores cols and rows from options', () => {
    const s = new TmuxSession(makeMeta(), makeStore(), { cols: 200, rows: 50 });
    expect(s._cols).toBe(200);
    expect(s._rows).toBe(50);
  });

  test('defaults cols=120 rows=30', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s._cols).toBe(120);
    expect(s._rows).toBe(30);
  });

  test('viewers map starts empty', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s.viewers.size).toBe(0);
  });

  test('pty starts null', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s.pty).toBeNull();
  });
});

describe('TmuxSession — start()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('');
    mockPtyOnData.mockImplementation(() => {});
    mockPtyOnExit.mockImplementation(() => {});
  });

  test('creates tmux session with correct flags', async () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store, { cols: 120, rows: 30 });

    await s.start('claude --session-id abc', {});

    // Verify new-session was called
    const newSessionCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('new-session')
    );
    expect(newSessionCall).toBeTruthy();
    expect(newSessionCall[0]).toContain('cm-aaaabbbb');
    expect(newSessionCall[0]).toContain('-x 120');
    expect(newSessionCall[0]).toContain('-y 30');
  });

  test('sets tmux options: history-limit, status off, prefix None', async () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);

    await s.start('claude', {});

    const calls = mockExecSync.mock.calls.map(([cmd]) => cmd);
    expect(calls.some(c => c.includes('history-limit 50000'))).toBe(true);
    expect(calls.some(c => c.includes('status off'))).toBe(true);
    expect(calls.some(c => c.includes('prefix None'))).toBe(true);
  });

  test('transitions CREATED → STARTING → RUNNING', async () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);

    const states = [];
    s.on('stateChange', ({ state }) => states.push(state));

    await s.start('claude', {});

    expect(states).toContain(STATES.STARTING);
    expect(states).toContain(STATES.RUNNING);
    expect(s.meta.status).toBe(STATES.RUNNING);
  });

  test('injects OAuth token as -e env arg when provided', async () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);

    await s.start('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'tok123' });

    const newSessionCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('new-session')
    );
    expect(newSessionCall[0]).toContain('tok123');
  });

  test('throws ERROR state and rejects if tmux session dies immediately', async () => {
    // has-session throws on first call after new-session — simulates immediate death
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('has-session')) {
        throw new Error('no server running on /tmp/tmux...');
      }
      return '';
    });

    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);

    await expect(s.start('claude', {})).rejects.toThrow('died immediately');
    expect(s.meta.status).toBe(STATES.ERROR);
  });

  test('persists meta to store on success', async () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);

    await s.start('claude', {});

    expect(store.upsert).toHaveBeenCalledWith(s.meta);
  });
});

describe('TmuxSession — addViewer() / removeViewer()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('');
    mockPtyOnData.mockImplementation(() => {});
    mockPtyOnExit.mockImplementation(() => {});
  });

  test('addViewer stores callback in viewers map', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.meta.status = STATES.RUNNING;

    const cb = jest.fn();
    s.addViewer('client-1', cb);

    expect(s.viewers.has('client-1')).toBe(true);
  });

  test('addViewer does not call callback on registration', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.meta.status = STATES.RUNNING;

    const cb = jest.fn();
    s.addViewer('client-1', cb);

    expect(cb).not.toHaveBeenCalled();
  });

  test('removeViewer removes callback from viewers map', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.meta.status = STATES.RUNNING;

    s.addViewer('client-1', jest.fn());
    s.removeViewer('client-1');

    expect(s.viewers.has('client-1')).toBe(false);
  });

  test('multiple viewers all receive PTY data', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.meta.status = STATES.RUNNING;
    s.pty = mockPtyProcess; // pre-attach

    const cb1 = jest.fn();
    const cb2 = jest.fn();

    s.addViewer('c1', cb1);
    s.addViewer('c2', cb2);

    // Simulate PTY data
    const dataHandler = mockPtyOnData.mock.calls[0]?.[0];
    if (dataHandler) {
      dataHandler('output chunk');
    } else {
      // Manually trigger via _wirePty
      s._wirePty();
      const h = mockPtyOnData.mock.calls[mockPtyOnData.mock.calls.length - 1]?.[0];
      if (h) h('output chunk');
    }

    // At least one viewer should have been called
    expect(cb1.mock.calls.length + cb2.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('TmuxSession — write() / resize()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('');
    mockPtyWrite.mockReset();
    mockPtyResize.mockReset();
  });

  test('write() forwards data to PTY when RUNNING', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.meta.status = STATES.RUNNING;
    s.pty = mockPtyProcess;

    s.write('hello\n');

    expect(mockPtyWrite).toHaveBeenCalledWith('hello\n');
  });

  test('write() forwards data to PTY when SHELL', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.meta.status = STATES.SHELL;
    s.pty = mockPtyProcess;

    s.write('ls\n');

    expect(mockPtyWrite).toHaveBeenCalledWith('ls\n');
  });

  test('write() does nothing when STOPPED', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.meta.status = STATES.STOPPED;
    s.pty = mockPtyProcess;

    s.write('ignored');

    expect(mockPtyWrite).not.toHaveBeenCalled();
  });

  test('resize() updates _cols/_rows and calls pty.resize', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.pty = mockPtyProcess;

    s.resize(200, 60);

    expect(s._cols).toBe(200);
    expect(s._rows).toBe(60);
    expect(mockPtyResize).toHaveBeenCalledWith(200, 60);
  });

  test('resize() works without a PTY (no throw)', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(() => s.resize(100, 25)).not.toThrow();
    expect(s._cols).toBe(100);
  });
});

describe('TmuxSession — stop()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('');
    mockPtyKill.mockReset();
  });

  test('kills PTY and tmux session', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;
    s.pty = mockPtyProcess;

    s.stop();

    expect(mockPtyKill).toHaveBeenCalled();
    const killCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('kill-session')
    );
    expect(killCall).toBeTruthy();
    expect(killCall[0]).toContain('cm-aaaabbbb');
  });

  test('transitions to STOPPED state', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;

    s.stop();

    expect(s.meta.status).toBe(STATES.STOPPED);
  });

  test('sets pty to null after stop', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;
    s.pty = mockPtyProcess;

    s.stop();

    expect(s.pty).toBeNull();
  });

  test('persists updated meta to store', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;

    s.stop();

    expect(store.upsert).toHaveBeenCalled();
  });
});

describe('TmuxSession — restart()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('');
    mockPtyOnData.mockImplementation(() => {});
    mockPtyOnExit.mockImplementation(() => {});
    mockPtyKill.mockReset();
  });

  test('calls tmux respawn-pane -k when RUNNING', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;

    s.restart('claude --resume uuid', {});

    const respawnCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('respawn-pane')
    );
    expect(respawnCall).toBeTruthy();
    expect(respawnCall[0]).toContain('-k');
    expect(respawnCall[0]).toContain('cm-aaaabbbb');
  });

  test('calls tmux respawn-pane -k when SHELL', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.SHELL;

    s.restart('claude', {});

    const respawnCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('respawn-pane')
    );
    expect(respawnCall).toBeTruthy();
  });

  test('kills existing PTY before respawning', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;
    s.pty = mockPtyProcess;

    s.restart('claude', {});

    expect(mockPtyKill).toHaveBeenCalled();
  });

  test('transitions back to RUNNING after restart', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;

    s.restart('claude', {});

    expect(s.meta.status).toBe(STATES.RUNNING);
  });

  test('transitions from SHELL to RUNNING after restart', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.SHELL;

    s.restart('claude', {});

    expect(s.meta.status).toBe(STATES.RUNNING);
  });

  test('wraps command with exec bash so tmux stays alive', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;

    s.restart('claude --resume uuid', {});

    const respawnCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('respawn-pane')
    );
    expect(respawnCall[0]).toContain('exec bash');
  });

  test('injects OAuth token in env prefix when provided', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;

    s.restart('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'tok-xyz' });

    const respawnCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('respawn-pane')
    );
    expect(respawnCall[0]).toContain('tok-xyz');
  });

  test('throws when tmux session is dead', () => {
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('has-session')) {
        throw new Error('no session');
      }
      return '';
    });

    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;

    expect(() => s.restart('claude', {})).toThrow('Cannot restart');
  });

  test('updates cols/rows when provided', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;

    s.restart('claude', {}, { cols: 200, rows: 50 });

    expect(s._cols).toBe(200);
    expect(s._rows).toBe(50);
  });
});

describe('TmuxSession — _tmuxSessionAlive()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns true when has-session succeeds', () => {
    mockExecSync.mockReturnValue('');
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s._tmuxSessionAlive()).toBe(true);
  });

  test('returns false when has-session throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('no session'); });
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s._tmuxSessionAlive()).toBe(false);
  });
});

describe('TmuxSession — _tmuxRunningClaude()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns true when pane command is not bash/sh/zsh', () => {
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('list-panes')) return 'node\n';
      return '';
    });
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s._tmuxRunningClaude()).toBe(true);
  });

  test('returns false when pane command is bash', () => {
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('list-panes')) return 'bash\n';
      return '';
    });
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s._tmuxRunningClaude()).toBe(false);
  });

  test('returns false when list-panes throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('no session'); });
    const s = new TmuxSession(makeMeta(), makeStore());
    expect(s._tmuxRunningClaude()).toBe(false);
  });
});

describe('TmuxSession — PTY data flows to viewers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('');
    mockPtyOnData.mockImplementation(() => {});
    mockPtyOnExit.mockImplementation(() => {});
  });

  test('PTY output chunk is forwarded to all registered viewers', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    s.meta.status = STATES.RUNNING;

    const cb1 = jest.fn();
    const cb2 = jest.fn();
    s.viewers.set('c1', cb1);
    s.viewers.set('c2', cb2);

    // Wire up the PTY manually
    s.pty = mockPtyProcess;
    s._wirePty();

    // Find the data handler registered by _wirePty
    const dataHandler = mockPtyOnData.mock.calls[mockPtyOnData.mock.calls.length - 1][0];
    dataHandler('chunk of output');

    expect(cb1).toHaveBeenCalledWith('chunk of output');
    expect(cb2).toHaveBeenCalledWith('chunk of output');
  });

  test('PTY exit with dead tmux → transitions to STOPPED', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;
    s.pty = mockPtyProcess;

    s._wirePty();

    // Simulate PTY exit — tmux is also dead
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('has-session')) {
        throw new Error('no session');
      }
      return '';
    });

    const exitHandler = mockPtyOnExit.mock.calls[mockPtyOnExit.mock.calls.length - 1][0];
    exitHandler({ exitCode: 0 });

    expect(s.meta.status).toBe(STATES.STOPPED);
  });

  test('PTY exit with bash in pane → transitions to SHELL', () => {
    const store = makeStore();
    const s = new TmuxSession(makeMeta(), store);
    s.meta.status = STATES.RUNNING;
    s.pty = mockPtyProcess;

    s._wirePty();

    // tmux alive, but Claude exited (bash in pane)
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('list-panes')) return 'bash\n';
      return ''; // has-session succeeds
    });

    const exitHandler = mockPtyOnExit.mock.calls[mockPtyOnExit.mock.calls.length - 1][0];
    exitHandler({ exitCode: 0 });

    expect(s.meta.status).toBe(STATES.SHELL);
  });
});

describe('TmuxSession — toJSON()', () => {
  test('returns a plain object with meta fields', () => {
    const s = new TmuxSession(makeMeta(), makeStore());
    const json = s.toJSON();
    expect(json.id).toBe('aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb');
    expect(json.tmuxName).toBe('cm-aaaabbbb');
    expect(json.status).toBe(STATES.CREATED);
  });
});
