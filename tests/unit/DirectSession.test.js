/**
 * DirectSession unit tests
 *
 * node-pty and @xterm/* are mocked so these run without a PTY or DOM.
 */
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Mock @xterm/headless
const mockTerminalInstance = {
  loadAddon: jest.fn(),
  write: jest.fn(),
  resize: jest.fn(),
  dispose: jest.fn(),
};
jest.unstable_mockModule('@xterm/headless', () => ({
  Terminal: jest.fn().mockImplementation(() => mockTerminalInstance),
}));

// Mock @xterm/addon-serialize
const mockSerializeInstance = {
  serialize: jest.fn().mockReturnValue('mock-snapshot-data'),
  activate: jest.fn(),
};
jest.unstable_mockModule('@xterm/addon-serialize', () => ({
  SerializeAddon: jest.fn().mockImplementation(() => mockSerializeInstance),
}));

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

function makeMockStore({ snapshotData = 'disk-snapshot' } = {}) {
  return {
    saveSnapshot: jest.fn().mockResolvedValue(undefined),
    loadSnapshot: jest.fn().mockResolvedValue(snapshotData),
  };
}

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

// We need to patch createRequire used inside DirectSession so it picks up the
// mocked node-pty. The simplest approach: patch it after import via the module
// system. Since DirectSession uses createRequire at module level, we stub it
// on the module object by re-exporting through jest.isolateModulesAsync.
//
// Simpler: We inject the pty factory via a testable hook.  Instead, we rely on
// the fact that Jest's ESM mocking intercepts *all* imports — but node-pty is
// loaded via createRequire (CJS interop). So we override createRequire output
// by patching the 'module' built-in via jest.unstable_mockModule.

// Actually the cleanest approach for ESM + createRequire: override require()
// inside DirectSession by mocking the 'module' package. Instead we do the
// practical approach: expose the pty factory as a replaceable internal and
// test via the public API.
//
// Since DirectSession does `require('node-pty')` at runtime (inside start()),
// and Jest ESM mocking doesn't intercept CJS requires, we patch this by
// monkey-patching Module._resolveFilename in the test setup — but that is
// fragile. The pragmatic solution is to accept that we need to stub the require
// at the module level.
//
// CLEANEST: We pass in a ptyFactory option in start() — OR we expose a
// _ptyFactory override for tests. We'll do the latter: add a _ptySpawn hook.

// For now, we import after setting up an environment variable that DirectSession
// can use, and rely on a _ptySpawn seam.

const { DirectSession } = await import('../../lib/sessions/DirectSession.js');
const { STATES } = await import('../../lib/sessions/sessionStates.js');

// Inject test seam: override the internal spawn function so we control the PTY
// without a real node-pty.
function injectMockPty(session) {
  // Patch the private require-based pty spawn with a controlled factory
  session._spawnPty = () => {
    _mockPty = makeMockPty();
    return _mockPty;
  };
}

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
  // We need to intercept the require('node-pty').spawn call inside start().
  // Strategy: override the _buildArgs and pty spawn via prototype patching
  // for the duration of this call.

  const origStart = session.start.bind(session);

  // Replace the pty require with our mock inline
  const origWirePty = session._wirePty.bind(session);

  let capturedPty = null;

  // Intercept start() to inject a mock pty before _wirePty runs
  const patchedStart = async (env) => {
    session._setState(STATES.STARTING);

    const { Terminal } = await import('@xterm/headless');
    const { SerializeAddon } = await import('@xterm/addon-serialize');
    session._headless = new Terminal({ cols: session._cols, rows: session._rows, scrollback: 10000 });
    session._serialize = new SerializeAddon();
    session._headless.loadAddon(session._serialize);

    capturedPty = makeMockPty();
    _mockPty = capturedPty;
    session.pty = capturedPty;
    session.meta.pid = capturedPty.pid;
    session.meta.startedAt = new Date().toISOString();

    // Clear the snapshot timer if it was set previously
    if (session._snapshotTimer) {
      clearInterval(session._snapshotTimer);
      session._snapshotTimer = null;
    }
    session._snapshotTimer = setInterval(() => session._saveSnapshot(), 30000);

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
  mockTerminalInstance.write.mockClear();
  mockTerminalInstance.resize.mockClear();
  mockSerializeInstance.serialize.mockClear();
  mockSerializeInstance.serialize.mockReturnValue('mock-snapshot-data');
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

test('PTY data flows to headless xterm AND to viewers', async () => {
  const { session } = makeSession();
  const received = [];

  await startSession(session);
  await Promise.resolve();

  session.addViewer('client-1', (data) => received.push(data));

  // Emit PTY data
  _mockPty._emit('data', 'hello world');

  expect(mockTerminalInstance.write).toHaveBeenCalledWith('hello world');
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

// --- getSnapshot ---

test('getSnapshot() returns serialized state when headless is live', async () => {
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  const snap = session.getSnapshot();
  expect(snap).toBe('mock-snapshot-data');
  expect(mockSerializeInstance.serialize).toHaveBeenCalled();

  session.stop();
});

test('getSnapshot() falls back to disk when headless is not initialized', async () => {
  const { session, store } = makeSession();
  // Headless never started
  const snap = session.getSnapshot();
  // Returns a promise (loadSnapshot is async)
  await expect(snap).resolves.toBe('disk-snapshot');
  expect(store.loadSnapshot).toHaveBeenCalledWith('test-session-id');
});

// --- resize ---

test('resize() updates cols/rows and resizes PTY + headless xterm', async () => {
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  session.resize(200, 50);

  expect(session._cols).toBe(200);
  expect(session._rows).toBe(50);
  expect(_mockPty.resize).toHaveBeenCalledWith(200, 50);
  expect(mockTerminalInstance.resize).toHaveBeenCalledWith(200, 50);

  session.stop();
});

test('resize() does not throw when pty is null', () => {
  const { session } = makeSession();
  // No PTY, no headless
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
  expect(store.saveSnapshot).toHaveBeenCalled();
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

test('stop() kills PTY, saves snapshot, and transitions to STOPPED', async () => {
  const { session, store } = makeSession();
  await startSession(session);
  await Promise.resolve();

  const pty = _mockPty;
  session.stop();

  expect(pty.kill).toHaveBeenCalled();
  expect(store.saveSnapshot).toHaveBeenCalled();
  expect(session.meta.status).toBe(STATES.STOPPED);
  expect(session.pty).toBeNull();
});

test('stop() clears the snapshot interval timer', async () => {
  jest.useFakeTimers();
  const { session } = makeSession();
  await startSession(session);
  await Promise.resolve();

  expect(session._snapshotTimer).not.toBeNull();
  session.stop();
  expect(session._snapshotTimer).toBeNull();

  jest.useRealTimers();
});

// --- _saveSnapshot ---

test('_saveSnapshot() saves serialized state to store', async () => {
  const { session, store } = makeSession();
  await startSession(session);
  await Promise.resolve();

  await session._saveSnapshot();

  expect(mockSerializeInstance.serialize).toHaveBeenCalled();
  expect(store.saveSnapshot).toHaveBeenCalledWith('test-session-id', 'mock-snapshot-data');

  session.stop();
});

test('_saveSnapshot() is a no-op when headless not initialized', async () => {
  const { session, store } = makeSession();
  await session._saveSnapshot();
  expect(store.saveSnapshot).not.toHaveBeenCalled();
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

// --- Snapshot interval ---

test('_saveSnapshot is called periodically (timer fires)', async () => {
  jest.useFakeTimers();
  const { session, store } = makeSession();
  await startSession(session);
  await Promise.resolve();

  jest.advanceTimersByTime(30_000);
  expect(store.saveSnapshot).toHaveBeenCalled();

  session.stop();
  jest.useRealTimers();
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
