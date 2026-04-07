/**
 * DirectSession unit tests
 *
 * node-pty is mocked so these run without a PTY.
 */
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock PTY factory
// ---------------------------------------------------------------------------

function makeMockPty() {
  const listeners = { data: [], exit: [] };
  return {
    onData: (cb) => listeners.data.push(cb),
    onExit: (cb) => listeners.exit.push(cb),
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    pid: 12345,
    // Test helper: emit a PTY event
    _emit: (event, payload) => {
      for (const cb of listeners[event]) cb(payload);
    },
  };
}

// Mock node-pty via createRequire — we intercept the CJS require inside DirectSession
// by mocking the 'module' createRequire so it returns a controlled factory.
let _mockPty = null;

jest.unstable_mockModule('node-pty', () => ({
  spawn: jest.fn((...args) => {
    _mockPty = makeMockPty();
    return _mockPty;
  }),
}));

// ---------------------------------------------------------------------------
// Mock SessionStore
// ---------------------------------------------------------------------------

function makeMockStore() {
  return {};
}

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { DirectSession } = await import('../../lib/sessions/DirectSession.js');
const { STATES } = await import('../../lib/sessions/sessionStates.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(metaOverrides = {}, storeOverrides = {}) {
  const meta = {
    id: 'test-session-id',
    projectId: 'proj-1',
    name: 'Test Session',
    command: 'claude',
    cwd: '/tmp/test-project',
    claudeSessionId: 'claude-sess-1',
    ...metaOverrides,
  };
  const store = makeMockStore(storeOverrides);
  const session = new DirectSession(meta, store, { cols: 80, rows: 24 });
  return { session, meta, store };
}

/**
 * Start a session using the internal seam so we control the mock PTY.
 * Returns the mock PTY for test manipulation.
 */
async function startSession(session, authEnv = {}) {
  const origStart = session.start.bind(session);

  let capturedPty = null;

  // Intercept start() to inject a mock pty before _wirePty runs
  const patchedStart = async (env) => {
    session._setState(STATES.STARTING);

    capturedPty = makeMockPty();
    _mockPty = capturedPty;
    session.pty = capturedPty;
    session.meta.pid = capturedPty.pid;
    session.meta.startedAt = new Date().toISOString();

    session._wirePty();
  };

  session.start = patchedStart;
  await session.start(authEnv);
  session.start = origStart; // restore

  return capturedPty;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  // Clean up any dangling timers
  jest.clearAllTimers();
});

// --- Constructor ---

test('starts in CREATED state', () => {
  const { session } = makeSession();
  expect(session.meta.status).toBe(STATES.CREATED);
});

test('stores meta, store, cols, rows correctly', () => {
  const { session, store } = makeSession();
  expect(session.meta.id).toBe('test-session-id');
  expect(session.store).toBe(store);
  expect(session._cols).toBe(80);
  expect(session._rows).toBe(24);
  expect(session.viewers).toBeInstanceOf(Map);
  expect(session.pty).toBeNull();
});

// --- State transitions ---

test('start() transitions CREATED → STARTING → RUNNING', async () => {
  const { session } = makeSession();
  const states = [];
  session.on('stateChange', ({ state }) => states.push(state));

  const pty = await startSession(session);

  // After _wirePty the microtask fires RUNNING if still STARTING
  await Promise.resolve(); // flush microtask

  expect(states).toContain(STATES.STARTING);
  expect(states).toContain(STATES.RUNNING);
  expect(session.meta.status).toBe(STATES.RUNNING);

  session.stop();
});

test('invalid state transition throws', () => {
  const { session } = makeSession();
  // Cannot go directly CREATED → RUNNING
  expect(() => session._setState(STATES.RUNNING)).toThrow();
});

// --- PTY data flow ---

test('PTY data flows to viewers', async () => {
  const { session } = makeSession();
  const received = [];

  await startSession(session);
  await Promise.resolve();

  session.addViewer('client-1', (data) => received.push(data));

  // Emit PTY data
  _mockPty._emit('data', 'hello world');

  expect(received).toEqual(['hello world']);

  session.stop();
});

test('PTY data goes to multiple viewers', async () => {
  const { session } = makeSession();
  const v1 = [], v2 = [];

  await startSession(session);
  await Promise.resolve();

  session.addViewer('c1', (d) => v1.push(d));
  session.addViewer('c2', (d) => v2.push(d));

  _mockPty._emit('data', 'chunk');

  expect(v1).toEqual(['chunk']);
  expect(v2).toEqual(['chunk']);

  session.stop();
});

// --- resize ---

test('resize() updates cols/rows and resizes PTY', async () => {
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  session.resize(200, 50);

  expect(session._cols).toBe(200);
  expect(session._rows).toBe(50);
  expect(_mockPty.resize).toHaveBeenCalledWith(200, 50);

  session.stop();
});

test('resize() does not throw when pty is null', () => {
  const { session } = makeSession();
  // No PTY
  expect(() => session.resize(100, 30)).not.toThrow();
});

// --- addViewer / removeViewer ---

test('addViewer and removeViewer work correctly', async () => {
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  const received = [];
  session.addViewer('c1', (d) => received.push(d));

  _mockPty._emit('data', 'before-remove');
  session.removeViewer('c1');
  _mockPty._emit('data', 'after-remove');

  expect(received).toEqual(['before-remove']);
  expect(session.viewers.size).toBe(0);

  session.stop();
});

test('addViewer replaces existing viewer for same clientId', async () => {
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  const v1 = [], v2 = [];
  session.addViewer('c1', (d) => v1.push(d));
  session.addViewer('c1', (d) => v2.push(d)); // replace

  _mockPty._emit('data', 'x');

  expect(v1).toEqual([]);  // old callback no longer called
  expect(v2).toEqual(['x']);

  session.stop();
});

// --- PTY exit ---

test('PTY exit with code 0 transitions to STOPPED', async () => {
  const { session, store } = makeSession();
  const states = [];
  session.on('stateChange', ({ state }) => states.push(state));

  await startSession(session);
  await Promise.resolve();

  _mockPty._emit('exit', { exitCode: 0 });

  expect(session.meta.status).toBe(STATES.STOPPED);
  expect(session.meta.exitCode).toBe(0);
});

test('PTY exit with non-zero code transitions to ERROR', async () => {
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  _mockPty._emit('exit', { exitCode: 1 });

  expect(session.meta.status).toBe(STATES.ERROR);
  expect(session.meta.exitCode).toBe(1);
});

test('PTY exit emits exit event', async () => {
  const { session } = makeSession();
  const exitEvents = [];
  session.on('exit', (e) => exitEvents.push(e));

  await startSession(session);
  await Promise.resolve();

  _mockPty._emit('exit', { exitCode: 0 });

  expect(exitEvents).toEqual([{ id: 'test-session-id', exitCode: 0 }]);
});

// --- stop() ---

test('stop() kills PTY and transitions to STOPPED', async () => {
  const { session, store } = makeSession();
  await startSession(session);
  await Promise.resolve();

  const pty = _mockPty;
  session.stop();

  expect(pty.kill).toHaveBeenCalled();
  expect(session.meta.status).toBe(STATES.STOPPED);
  expect(session.pty).toBeNull();
});

// --- write() ---

test('write() forwards data to PTY when RUNNING', async () => {
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  session.write('ls -la\n');
  expect(_mockPty.write).toHaveBeenCalledWith('ls -la\n');

  session.stop();
});

test('write() is a no-op when not RUNNING', () => {
  const { session } = makeSession();
  // Still in CREATED state
  expect(() => session.write('data')).not.toThrow();
});

// --- toJSON ---

test('toJSON() returns plain meta object', () => {
  const { session } = makeSession();
  const json = session.toJSON();
  expect(json.id).toBe('test-session-id');
  expect(json.status).toBe(STATES.CREATED);
});

// --- STOPPED → STARTING (restart) ---

test('can transition from STOPPED back to STARTING', async () => {
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  _mockPty._emit('exit', { exitCode: 0 });
  expect(session.meta.status).toBe(STATES.STOPPED);

  // Should be allowed: STOPPED → STARTING
  expect(() => session._setState(STATES.STARTING)).not.toThrow();
  expect(session.meta.status).toBe(STATES.STARTING);
});

// ---------------------------------------------------------------------------
// Tests: refresh()
// ---------------------------------------------------------------------------

describe('DirectSession — refresh()', () => {
  test('refresh() kills PTY and re-starts when RUNNING', async () => {
    const { session } = makeSession();

    // Start the session
    await startSession(session);
    await Promise.resolve();
    expect(session.meta.status).toBe(STATES.RUNNING);

    // Mock conversation file exists so refresh doesn't throw
    session._claudeSessionFileExists = jest.fn().mockReturnValue(true);

    const originalPty = _mockPty;

    // Now call refresh() — it should kill the PTY and spawn a new one
    await session.refresh({});

    // Original PTY was killed
    expect(originalPty.kill).toHaveBeenCalled();

    // Session ended up running again
    expect(session.meta.status).toBe(STATES.RUNNING);
  });

  test('refresh() throws when not RUNNING (STOPPED state)', async () => {
    const { session } = makeSession();

    // Manually put session in STOPPED state
    await startSession(session);
    await Promise.resolve();
    _mockPty._emit('exit', { exitCode: 0 });
    expect(session.meta.status).toBe(STATES.STOPPED);

    await expect(session.refresh({})).rejects.toThrow(/no recovery path/i);
  });

  test('refresh() throws when not RUNNING (CREATED state)', async () => {
    const { session } = makeSession();
    expect(session.meta.status).toBe(STATES.CREATED);

    await expect(session.refresh({})).rejects.toThrow(/no recovery path/i);
  });

  test('refresh() throws when no conversation file exists', async () => {
    const { session } = makeSession();

    // Start the session
    await startSession(session);
    await Promise.resolve();
    expect(session.meta.status).toBe(STATES.RUNNING);

    // Mock _claudeSessionFileExists to return false
    session._claudeSessionFileExists = jest.fn().mockReturnValue(false);

    await expect(session.refresh({})).rejects.toThrow(/no conversation file/i);
  });

  test('refresh() does not throw when conversation file exists', async () => {
    const { session } = makeSession();

    await startSession(session);
    await Promise.resolve();

    // Mock _claudeSessionFileExists to return true
    session._claudeSessionFileExists = jest.fn().mockReturnValue(true);

    // Should not throw
    await expect(session.refresh({})).resolves.toBeUndefined();
  });

  test('refresh() sets pty to null before re-spawning', async () => {
    const { session } = makeSession();
    await startSession(session);
    await Promise.resolve();

    session._claudeSessionFileExists = jest.fn().mockReturnValue(true);

    let ptyWasNullDuringStart = false;
    const origStart = session.start.bind(session);
    session.start = jest.fn(async (env) => {
      // At the moment start() is called, pty should already be null
      ptyWasNullDuringStart = session.pty === null;
      await origStart(env);
    });

    await session.refresh({});

    expect(ptyWasNullDuringStart).toBe(true);
  });

  test('refresh() error message includes session id when not RUNNING', async () => {
    const { session } = makeSession({ id: 'my-session-xyz' });

    await expect(session.refresh({})).rejects.toThrow('my-session-xyz');
  });

  test('refresh() error message includes claudeSessionId when no conversation file', async () => {
    const { session } = makeSession({ claudeSessionId: 'conv-file-abc' });

    await startSession(session);
    await Promise.resolve();

    session._claudeSessionFileExists = jest.fn().mockReturnValue(false);

    await expect(session.refresh({})).rejects.toThrow('conv-file-abc');
  });
});
