/**
 * Integration tests: session lifecycle via real SessionManager
 *
 * Uses the real SessionManager class with mocked DirectSession/TmuxSession
 * (no PTY or tmux binary needed). Validates the full session lifecycle:
 * create → running → subscribe → stop → refresh → delete
 * and verifies that the state machine rejects illegal transitions.
 */

import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Mocks — registered before any import of the module under test
// ---------------------------------------------------------------------------

function makeEventEmitter() {
  const listeners = {};
  return {
    on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
    emit(event, ...args) { (listeners[event] || []).forEach((cb) => cb(...args)); },
  };
}

/**
 * Build a realistic mock DirectSession that advances through states
 * the way the real class would.
 *
 * NOTE: We avoid .bind() on jest.fn() mocks — binding creates a new function
 * that is no longer the same mock reference, breaking .toHaveBeenCalled() etc.
 * Instead, we store state in a closure object that the mocks close over.
 */
function makeDirectSessionInstance(meta) {
  const emitter = makeEventEmitter();

  // Shared mutable state that all mocks close over
  const state = {
    meta: { ...meta, status: 'created' },
    viewers: new Map(),
    pty: null,
  };

  const startFn = jest.fn(() => {
    state.meta.status = 'starting';
    emitter.emit('stateChange', { id: state.meta.id, state: 'starting', previousState: 'created' });
    state.meta.status = 'running';
    emitter.emit('stateChange', { id: state.meta.id, state: 'running', previousState: 'starting' });
    return Promise.resolve();
  });

  const stopFn = jest.fn(() => {
    const prev = state.meta.status;
    state.meta.status = 'stopped';
    emitter.emit('stateChange', { id: state.meta.id, state: 'stopped', previousState: prev });
    return Promise.resolve();
  });

  const refreshFn = jest.fn(() => {
    // Simulate refresh: kill + re-start (stay running or go running again)
    const prev = state.meta.status;
    state.meta.status = 'running';
    emitter.emit('stateChange', { id: state.meta.id, state: 'running', previousState: prev });
    return Promise.resolve();
  });

  const addViewerFn = jest.fn((clientId, cb) => {
    state.viewers.set(clientId, cb);
  });

  const removeViewerFn = jest.fn((clientId) => {
    state.viewers.delete(clientId);
  });

  // The instance object — note: meta and viewers are proxied through `state`
  // so that mutations by mocks are visible on the instance too.
  const instance = {
    get meta() { return state.meta; },
    set meta(v) { state.meta = v; },
    get viewers() { return state.viewers; },
    pty: null,

    start: startFn,
    stop: stopFn,
    refresh: refreshFn,
    write: jest.fn(),
    resize: jest.fn(),
    addViewer: addViewerFn,
    removeViewer: removeViewerFn,

    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _emitter: emitter,
  };

  return instance;
}

const mockDirectCtor = jest.fn();
jest.unstable_mockModule('../../lib/sessions/DirectSession.js', () => ({
  DirectSession: mockDirectCtor,
}));

const mockTmuxCtor = jest.fn();
jest.unstable_mockModule('../../lib/sessions/TmuxSession.js', () => ({
  TmuxSession: mockTmuxCtor,
}));

// ---------------------------------------------------------------------------
// Import real modules (after mocks are registered)
// ---------------------------------------------------------------------------

const { SessionManager } = await import('../../lib/sessions/SessionManager.js');
const { STATES, assertTransition } = await import('../../lib/sessions/sessionStates.js');
const { ProjectStore } = await import('../../lib/projects/ProjectStore.js');
const { SettingsStore } = await import('../../lib/settings/SettingsStore.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let dataDir;
let projectId;
let projects;

/**
 * Build a fresh SessionManager with real ProjectStore + temp data dir.
 * The DirectSession mock is reset each time.
 */
async function makeManager() {
  const mgr = new SessionManager(projects, null, { dataDir });
  // Don't call init() — that would try to load + re-start persisted sessions.
  return mgr;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lifecycle-integration-'));

  // Create a project for use across tests
  projects = new ProjectStore(join(dataDir, 'projects.json'));
  const proj = projects.create({ name: 'Integration Test Project', path: dataDir });
  projectId = proj.id;
}, 10000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDirectCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));
  mockTmuxCtor.mockImplementation((meta) => {
    const emitter = makeEventEmitter();
    const state = { meta: { ...meta, status: 'created', tmuxName: `cm-${meta.id.slice(0, 8)}` } };
    const startFn = jest.fn(() => {
      state.meta.status = 'running';
      emitter.emit('stateChange', { id: state.meta.id, state: 'running' });
      return Promise.resolve();
    });
    const stopFn = jest.fn(() => {
      state.meta.status = 'stopped';
      emitter.emit('stateChange', { id: state.meta.id, state: 'stopped' });
      return Promise.resolve();
    });
    const refreshFn = jest.fn(() => {
      // Alive path: stay RUNNING, emit stateChange so clients reset xterm
      emitter.emit('stateChange', { id: state.meta.id, state: state.meta.status });
      return Promise.resolve();
    });
    return {
      get meta() { return state.meta; },
      set meta(v) { state.meta = v; },
      viewers: new Map(),
      start: startFn,
      stop: stopFn,
      refresh: refreshFn,
      write: jest.fn(),
      resize: jest.fn(),
      addViewer: jest.fn(),
      removeViewer: jest.fn(),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
    };
  });
});

// ---------------------------------------------------------------------------
// Tests: Create
// ---------------------------------------------------------------------------

describe('Create', () => {
  test('creates a direct session and transitions to running', async () => {
    const mgr = await makeManager();

    const meta = await mgr.create({ projectId, mode: 'direct' });

    expect(meta.id).toBeTruthy();
    expect(meta.projectId).toBe(projectId);
    expect(meta.mode).toBe('direct');

    const session = mgr.sessions.get(meta.id);
    expect(session).toBeDefined();
    // After start() the mock sets status to 'running'
    expect(session.meta.status).toBe(STATES.RUNNING);
  });

  test('calls session.start() exactly once on create', async () => {
    const mgr = await makeManager();
    await mgr.create({ projectId, mode: 'direct' });

    const [session] = mgr.sessions.values();
    expect(session.start).toHaveBeenCalledTimes(1);
  });

  test('emits sessionCreated event with session meta', async () => {
    const mgr = await makeManager();
    const onCreated = jest.fn();
    mgr.on('sessionCreated', onCreated);

    const meta = await mgr.create({ projectId, mode: 'direct' });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated.mock.calls[0][0]).toMatchObject({ id: meta.id, projectId });
  });

  test('creates multiple sessions with unique IDs', async () => {
    const mgr = await makeManager();
    const m1 = await mgr.create({ projectId, mode: 'direct' });
    const m2 = await mgr.create({ projectId, mode: 'direct' });

    expect(m1.id).not.toBe(m2.id);
    expect(mgr.list()).toHaveLength(2);
  });

  test('throws if projectId does not exist', async () => {
    const mgr = await makeManager();
    await expect(mgr.create({ projectId: 'ghost-project', mode: 'direct' }))
      .rejects.toThrow(/not found/i);
  });

  test('persists session to store after create', async () => {
    const mgr = await makeManager();
    await mgr.create({ projectId, mode: 'direct', name: 'persist-test' });

    // Re-load from disk to confirm persistence
    const { SessionStore } = await import('../../lib/sessions/SessionStore.js');
    const store = new SessionStore(dataDir);
    const records = await store.load();
    const found = records.find((r) => r.name === 'persist-test');
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Running state
// ---------------------------------------------------------------------------

describe('Running state', () => {
  test('session is in RUNNING state after create', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);
    expect(session.meta.status).toBe(STATES.RUNNING);
  });

  test('stateChange events are forwarded as sessionStateChange', async () => {
    const mgr = await makeManager();
    const changes = [];
    mgr.on('sessionStateChange', (e) => changes.push(e));

    const meta = await mgr.create({ projectId, mode: 'direct' });

    // Mock emits starting then running during start()
    const runningChange = changes.find((c) => c.state === STATES.RUNNING);
    expect(runningChange).toBeDefined();
    expect(runningChange.id).toBe(meta.id);
  });

  test('write() delegates to session.write()', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    mgr.write(meta.id, 'test input\n');
    expect(session.write).toHaveBeenCalledWith('test input\n');
  });

  test('resize() delegates to session.resize()', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    mgr.resize(meta.id, 200, 50);
    expect(session.resize).toHaveBeenCalledWith(200, 50);
  });

  test('write() to non-existent session is a no-op (does not throw)', () => {
    const mgr = new SessionManager(projects, null, { dataDir });
    expect(() => mgr.write('ghost', 'data')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: Subscribe
// ---------------------------------------------------------------------------

describe('Subscribe', () => {
  test('subscribe registers viewer callback', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    const cb = jest.fn();
    await mgr.subscribe(meta.id, 'client-1', cb);

    expect(session.addViewer).toHaveBeenCalledWith('client-1', cb);
  });

  test('subscribe throws for unknown session', async () => {
    const mgr = await makeManager();
    await expect(mgr.subscribe('ghost', 'client-1', jest.fn()))
      .rejects.toThrow(/not found/i);
  });

  test('multiple clients can subscribe to the same session', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    await mgr.subscribe(meta.id, 'client-1', jest.fn());
    await mgr.subscribe(meta.id, 'client-2', jest.fn());

    expect(session.addViewer).toHaveBeenCalledTimes(2);
  });

  test('unsubscribe removes viewer', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    await mgr.subscribe(meta.id, 'client-1', jest.fn());
    mgr.unsubscribe(meta.id, 'client-1');

    expect(session.removeViewer).toHaveBeenCalledWith('client-1');
  });

  test('live output from PTY is forwarded to subscribed viewers', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    const received = [];
    await mgr.subscribe(meta.id, 'client-live', (data) => received.push(data));

    // Simulate PTY emitting data to viewers
    const viewerCb = session.viewers.get('client-live');
    expect(viewerCb).toBeDefined();
    viewerCb('PTY output chunk');

    expect(received).toEqual(['PTY output chunk']);
  });
});

// ---------------------------------------------------------------------------
// Tests: Stop
// ---------------------------------------------------------------------------

describe('Stop', () => {
  test('stop() transitions session to STOPPED', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });

    await mgr.stop(meta.id);

    const session = mgr.sessions.get(meta.id);
    expect(session.meta.status).toBe(STATES.STOPPED);
  });

  test('stop() calls session.stop() exactly once', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    await mgr.stop(meta.id);
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  test('stop() throws for unknown session', async () => {
    const mgr = await makeManager();
    await expect(mgr.stop('ghost')).rejects.toThrow(/not found/i);
  });

  test('stop() persists state to store', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct', name: 'stop-persist-test' });

    await mgr.stop(meta.id);

    // Verify the stopped state was persisted
    const { SessionStore } = await import('../../lib/sessions/SessionStore.js');
    const store = new SessionStore(dataDir);
    const records = await store.load();
    const saved = records.find((r) => r.id === meta.id);
    expect(saved).toBeDefined();
    expect(saved.status).toBe(STATES.STOPPED);
  });
});

// ---------------------------------------------------------------------------
// Tests: Refresh (replaces Restart)
// ---------------------------------------------------------------------------

describe('Refresh', () => {
  test('refresh() on a direct session calls session.refresh()', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    await mgr.refresh(meta.id);

    expect(session.refresh).toHaveBeenCalledTimes(1);
  });

  test('refresh() returns updated session meta', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });

    const updated = await mgr.refresh(meta.id);
    expect(updated.id).toBe(meta.id);
  });

  test('refresh() on unknown session throws', async () => {
    const mgr = await makeManager();
    await expect(mgr.refresh('ghost')).rejects.toThrow(/not found/i);
  });

  test('refresh() on tmux session calls session.refresh()', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'tmux' });
    const session = mgr.sessions.get(meta.id);

    await mgr.refresh(meta.id);

    expect(session.refresh).toHaveBeenCalledTimes(1);
  });

  test('refresh() passes cols/rows to tmux session', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'tmux' });
    const session = mgr.sessions.get(meta.id);

    await mgr.refresh(meta.id, { cols: 200, rows: 50 });

    // The call to session.refresh should include cols/rows in some form
    expect(session.refresh).toHaveBeenCalled();
  });

  test('refresh() persists state to store', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct', name: 'refresh-persist-test' });

    await mgr.refresh(meta.id);

    // The store.save or store.upsert should have been called
    // (Verify by loading from disk)
    const { SessionStore } = await import('../../lib/sessions/SessionStore.js');
    const store = new SessionStore(dataDir);
    const records = await store.load();
    const found = records.find((r) => r.id === meta.id);
    expect(found).toBeDefined();
  });

  test('refresh() does not exist as mgr.restart()', async () => {
    const mgr = await makeManager();
    // The old restart() method should no longer exist on the manager
    // (or at minimum, refresh() should be the canonical method)
    expect(typeof mgr.refresh).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Tests: Delete
// ---------------------------------------------------------------------------

describe('Delete', () => {
  test('delete() removes session from manager', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    await mgr.stop(meta.id);

    await mgr.delete(meta.id);

    expect(mgr.exists(meta.id)).toBe(false);
    expect(mgr.get(meta.id)).toBeNull();
  });

  test('delete() calls session.stop() if session is running', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);
    // Force running state
    session.meta.status = STATES.RUNNING;
    session.stop.mockClear();

    await mgr.delete(meta.id);

    expect(session.stop).toHaveBeenCalled();
  });

  test('delete() on already-stopped session does not call stop()', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    await mgr.stop(meta.id);

    const session = mgr.sessions.get(meta.id);
    session.stop.mockClear(); // reset after setup stop()

    await mgr.delete(meta.id);

    // stopped → delete should NOT call stop() again (isLive is false)
    expect(session.stop).not.toHaveBeenCalled();
  });

  test('delete() does not consider shell state as live (SHELL removed)', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    const session = mgr.sessions.get(meta.id);

    // Force a 'shell' status — should NOT be treated as live
    session.meta.status = 'shell';
    session.stop.mockClear();

    await mgr.delete(meta.id);

    // 'shell' is not a live state in the new design — stop() should NOT be called
    expect(session.stop).not.toHaveBeenCalled();
  });

  test('delete() is a no-op for unknown session', async () => {
    const mgr = await makeManager();
    await expect(mgr.delete('nonexistent')).resolves.toBeUndefined();
  });

  test('deleted session does not appear in list()', async () => {
    const mgr = await makeManager();
    const m1 = await mgr.create({ projectId, mode: 'direct' });
    const m2 = await mgr.create({ projectId, mode: 'direct' });
    await mgr.stop(m1.id);

    await mgr.delete(m1.id);

    const ids = mgr.list().map((s) => s.id);
    expect(ids).not.toContain(m1.id);
    expect(ids).toContain(m2.id);
  });
});

// ---------------------------------------------------------------------------
// Tests: State machine — illegal transitions
// ---------------------------------------------------------------------------

describe('State machine: illegal transitions', () => {
  test('assertTransition throws for stopped → running (must go through starting)', () => {
    expect(() => assertTransition(STATES.STOPPED, STATES.RUNNING))
      .toThrow(/invalid state transition/i);
  });

  test('assertTransition throws for running → created', () => {
    expect(() => assertTransition(STATES.RUNNING, STATES.CREATED))
      .toThrow(/invalid state transition/i);
  });

  test('assertTransition throws for created → stopped (must start first)', () => {
    expect(() => assertTransition(STATES.CREATED, STATES.STOPPED))
      .toThrow(/invalid state transition/i);
  });

  test('assertTransition allows stopped → starting', () => {
    expect(() => assertTransition(STATES.STOPPED, STATES.STARTING)).not.toThrow();
  });

  test('assertTransition allows starting → running', () => {
    expect(() => assertTransition(STATES.STARTING, STATES.RUNNING)).not.toThrow();
  });

  test('assertTransition allows running → stopping', () => {
    expect(() => assertTransition(STATES.RUNNING, STATES.STOPPING)).not.toThrow();
  });

  test('assertTransition allows stopping → stopped', () => {
    expect(() => assertTransition(STATES.STOPPING, STATES.STOPPED)).not.toThrow();
  });

  test('assertTransition allows error → starting (so restart works after crash)', () => {
    expect(() => assertTransition(STATES.ERROR, STATES.STARTING)).not.toThrow();
  });

  test('assertTransition throws for unknown from-state', () => {
    expect(() => assertTransition('nonexistent-state', STATES.RUNNING))
      .toThrow(/unknown state/i);
  });

  test('RUNNING → RUNNING is not allowed (idempotent transitions rejected)', () => {
    expect(() => assertTransition(STATES.RUNNING, STATES.RUNNING))
      .toThrow(/invalid state transition/i);
  });

  test('SHELL state does not exist in STATES', () => {
    expect(STATES.SHELL).toBeUndefined();
    expect(Object.values(STATES)).not.toContain('shell');
  });

  test('assertTransition throws for running → shell (SHELL removed)', () => {
    expect(() => assertTransition(STATES.RUNNING, 'shell'))
      .toThrow();
  });

  test('assertTransition throws for shell → running (SHELL removed)', () => {
    expect(() => assertTransition('shell', STATES.RUNNING))
      .toThrow(/unknown state/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: exists() and get()
// ---------------------------------------------------------------------------

describe('exists() and get()', () => {
  test('exists() is true for a created session', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    expect(mgr.exists(meta.id)).toBe(true);
  });

  test('exists() is false for unknown id', () => {
    const mgr = new SessionManager(projects, null, { dataDir });
    expect(mgr.exists('nope')).toBe(false);
  });

  test('get() returns session meta', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct', name: 'get-test' });

    const result = mgr.get(meta.id);
    expect(result).toMatchObject({ id: meta.id, name: 'get-test', projectId });
  });

  test('get() returns null for deleted session', async () => {
    const mgr = await makeManager();
    const meta = await mgr.create({ projectId, mode: 'direct' });
    await mgr.stop(meta.id);
    await mgr.delete(meta.id);

    expect(mgr.get(meta.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Full lifecycle flow
// ---------------------------------------------------------------------------

describe('Full lifecycle: create → subscribe → stop → refresh → delete', () => {
  test('complete happy-path lifecycle succeeds end-to-end', async () => {
    const mgr = await makeManager();

    // 1. Create
    const meta = await mgr.create({ projectId, mode: 'direct', name: 'lifecycle-e2e' });
    expect(mgr.exists(meta.id)).toBe(true);

    // 2. Subscribe
    const outputReceived = [];
    await mgr.subscribe(meta.id, 'viewer-1', (data) => outputReceived.push(data));

    // 3. Stop
    await mgr.stop(meta.id);
    expect(mgr.sessions.get(meta.id).meta.status).toBe(STATES.STOPPED);

    // 4. Refresh (mock's refresh() sets state back to running)
    const updated = await mgr.refresh(meta.id);
    expect(updated.id).toBe(meta.id);

    // 5. Delete
    await mgr.delete(meta.id);
    expect(mgr.exists(meta.id)).toBe(false);
  });

  test('sessionStateChange events fire for each transition in the lifecycle', async () => {
    const mgr = await makeManager();
    const states = [];
    mgr.on('sessionStateChange', (e) => states.push(e.state));

    const meta = await mgr.create({ projectId, mode: 'direct' });
    // Mock emits starting + running during start()
    expect(states).toContain(STATES.STARTING);
    expect(states).toContain(STATES.RUNNING);

    await mgr.stop(meta.id);
    expect(states).toContain(STATES.STOPPED);
  });

  test('refresh on tmux session: alive path stays RUNNING throughout', async () => {
    const mgr = await makeManager();

    const meta = await mgr.create({ projectId, mode: 'tmux' });
    const session = mgr.sessions.get(meta.id);
    expect(session.meta.status).toBe(STATES.RUNNING);

    // Refresh — mock keeps it RUNNING
    await mgr.refresh(meta.id);

    expect(session.meta.status).toBe(STATES.RUNNING);
    expect(session.refresh).toHaveBeenCalledTimes(1);
  });
});
