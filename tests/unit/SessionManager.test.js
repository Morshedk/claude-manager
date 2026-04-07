/**
 * Unit tests for SessionManager
 *
 * DirectSession, TmuxSession, and SessionStore are all mocked so no PTY,
 * tmux, or disk I/O occurs.
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — registered before any imports of the module under test
// ---------------------------------------------------------------------------

// Shared mock EventEmitter-style event handler
function makeEventEmitter() {
  const listeners = {};
  return {
    on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
    emit(event, ...args) { (listeners[event] || []).forEach((cb) => cb(...args)); },
    _listeners: listeners,
  };
}

// Factory for a mock DirectSession instance
function makeDirectSessionInstance(meta) {
  const emitter = makeEventEmitter();
  return {
    meta: { ...meta, status: 'created' },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    refresh: jest.fn().mockResolvedValue(undefined),
    write: jest.fn(),
    resize: jest.fn(),
    addViewer: jest.fn(),
    removeViewer: jest.fn(),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _emitter: emitter,
  };
}

// Factory for a mock TmuxSession instance
function makeTmuxSessionInstance(meta) {
  const emitter = makeEventEmitter();
  return {
    meta: { ...meta, status: 'created', tmuxName: `cm-${meta.id.slice(0, 8)}` },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    refresh: jest.fn().mockResolvedValue(undefined),
    write: jest.fn(),
    resize: jest.fn(),
    addViewer: jest.fn(),
    removeViewer: jest.fn(),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _emitter: emitter,
  };
}

// Mock DirectSession module
const mockDirectSessionCtor = jest.fn();
jest.unstable_mockModule('../../lib/sessions/DirectSession.js', () => ({
  DirectSession: mockDirectSessionCtor,
}));

// Mock TmuxSession module
const mockTmuxSessionCtor = jest.fn();
jest.unstable_mockModule('../../lib/sessions/TmuxSession.js', () => ({
  TmuxSession: mockTmuxSessionCtor,
}));

// Mock SessionStore
const mockStoreSave = jest.fn().mockResolvedValue(undefined);
const mockStoreLoad = jest.fn().mockResolvedValue([]);
const mockStoreRemove = jest.fn().mockResolvedValue(undefined);
const mockStoreUpsert = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../lib/sessions/SessionStore.js', () => ({
  SessionStore: jest.fn().mockImplementation(() => ({
    save: mockStoreSave,
    load: mockStoreLoad,
    remove: mockStoreRemove,
    upsert: mockStoreUpsert,
  })),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { SessionManager } = await import('../../lib/sessions/SessionManager.js');
const { STATES } = await import('../../lib/sessions/sessionStates.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectStore(projects = []) {
  const map = new Map(projects.map((p) => [p.id, p]));
  return {
    get: (id) => map.get(id) || null,
  };
}

const DEFAULT_PROJECT = { id: 'proj-1', name: 'Test Project', path: '/tmp/test-project' };

function makeManager(projects = [DEFAULT_PROJECT]) {
  mockDirectSessionCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));
  mockTmuxSessionCtor.mockImplementation((meta) => makeTmuxSessionInstance(meta));
  const projectStore = makeProjectStore(projects);
  return new SessionManager(projectStore, null, { dataDir: '/tmp/test-data' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockStoreLoad.mockResolvedValue([]);
  mockStoreSave.mockResolvedValue(undefined);
  mockStoreRemove.mockResolvedValue(undefined);
  mockDirectSessionCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));
  mockTmuxSessionCtor.mockImplementation((meta) => makeTmuxSessionInstance(meta));
});

// --- create() ---

describe('create()', () => {
  test('creates a DirectSession for direct mode', async () => {
    const mgr = makeManager();
    const result = await mgr.create({ projectId: 'proj-1', mode: 'direct' });

    expect(mockDirectSessionCtor).toHaveBeenCalledTimes(1);
    expect(mockTmuxSessionCtor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ projectId: 'proj-1', mode: 'direct' });
    expect(result.id).toBeTruthy();
  });

  test('creates a TmuxSession for tmux mode', async () => {
    const mgr = makeManager();
    const result = await mgr.create({ projectId: 'proj-1', mode: 'tmux' });

    expect(mockTmuxSessionCtor).toHaveBeenCalledTimes(1);
    expect(mockDirectSessionCtor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ projectId: 'proj-1', mode: 'tmux' });
  });

  test('throws if projectId is invalid', async () => {
    const mgr = makeManager();
    await expect(mgr.create({ projectId: 'nonexistent', mode: 'direct' })).rejects.toThrow('Project not found');
  });

  test('calls session.start() after construction', async () => {
    const mgr = makeManager();
    await mgr.create({ projectId: 'proj-1', mode: 'direct' });

    // The session instance created by DirectSession mock
    const [session] = mgr.sessions.values();
    expect(session.start).toHaveBeenCalledTimes(1);
  });

  test('persists session via store.save() after creation', async () => {
    const mgr = makeManager();
    await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    expect(mockStoreSave).toHaveBeenCalled();
  });

  test('emits sessionCreated event', async () => {
    const mgr = makeManager();
    const onCreated = jest.fn();
    mgr.on('sessionCreated', onCreated);

    await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated.mock.calls[0][0]).toMatchObject({ projectId: 'proj-1' });
  });

  test('adds Telegram flag when telegram=true', async () => {
    const mgr = makeManager();
    await mgr.create({ projectId: 'proj-1', mode: 'direct', telegram: true });

    const [session] = mgr.sessions.values();
    expect(session.meta.telegramEnabled).toBe(true);
  });

  test('generates unique IDs for each session', async () => {
    const mgr = makeManager();
    const r1 = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    const r2 = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    expect(r1.id).not.toBe(r2.id);
  });
});

// --- list() and get() ---

describe('list() and get()', () => {
  test('list() returns empty array initially', () => {
    const mgr = makeManager();
    expect(mgr.list()).toEqual([]);
  });

  test('list() returns meta for all sessions', async () => {
    const mgr = makeManager();
    await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    await mgr.create({ projectId: 'proj-1', mode: 'tmux' });

    const sessions = mgr.list();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.id)).toBe(true);
  });

  test('get() returns meta for known session', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    const result = mgr.get(id);
    expect(result).toMatchObject({ id, projectId: 'proj-1' });
  });

  test('get() returns null for unknown session', () => {
    const mgr = makeManager();
    expect(mgr.get('nonexistent')).toBeNull();
  });

  test('exists() returns true for known session', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    expect(mgr.exists(id)).toBe(true);
  });

  test('exists() returns false for unknown session', () => {
    const mgr = makeManager();
    expect(mgr.exists('ghost')).toBe(false);
  });
});

// --- subscribe() and unsubscribe() ---

describe('subscribe() and unsubscribe()', () => {
  test('subscribe() calls session.addViewer', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    const cb = jest.fn();

    await mgr.subscribe(id, 'client-1', cb);

    const session = mgr.sessions.get(id);
    expect(session.addViewer).toHaveBeenCalledWith('client-1', cb);
  });

  test('subscribe() throws for unknown session', async () => {
    const mgr = makeManager();
    await expect(mgr.subscribe('ghost', 'client-1', jest.fn())).rejects.toThrow('Session not found');
  });

  test('unsubscribe() calls session.removeViewer', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });

    mgr.unsubscribe(id, 'client-1');
    const session = mgr.sessions.get(id);
    expect(session.removeViewer).toHaveBeenCalledWith('client-1');
  });

  test('unsubscribe() is a no-op for unknown session', () => {
    const mgr = makeManager();
    expect(() => mgr.unsubscribe('ghost', 'client-1')).not.toThrow();
  });
});

// --- write() and resize() ---

describe('write() and resize()', () => {
  test('write() delegates to session.write()', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });

    mgr.write(id, 'hello\n');
    const session = mgr.sessions.get(id);
    expect(session.write).toHaveBeenCalledWith('hello\n');
  });

  test('write() is a no-op for unknown session', () => {
    const mgr = makeManager();
    expect(() => mgr.write('ghost', 'data')).not.toThrow();
  });

  test('resize() delegates to session.resize()', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });

    mgr.resize(id, 200, 50);
    const session = mgr.sessions.get(id);
    expect(session.resize).toHaveBeenCalledWith(200, 50);
  });

  test('resize() is a no-op for unknown session', () => {
    const mgr = makeManager();
    expect(() => mgr.resize('ghost', 100, 30)).not.toThrow();
  });
});

// --- stop() ---

describe('stop()', () => {
  test('stop() calls session.stop() and persists', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    mockStoreSave.mockClear();

    await mgr.stop(id);

    const session = mgr.sessions.get(id);
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(mockStoreSave).toHaveBeenCalled();
  });

  test('stop() throws for unknown session', async () => {
    const mgr = makeManager();
    await expect(mgr.stop('ghost')).rejects.toThrow('Session not found');
  });
});

// --- delete() ---

describe('delete()', () => {
  test('delete() removes session from map', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });

    await mgr.delete(id);
    expect(mgr.exists(id)).toBe(false);
  });

  test('delete() calls store.remove', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    mockStoreRemove.mockClear();

    await mgr.delete(id);

    expect(mockStoreRemove).toHaveBeenCalledWith(id);
  });

  test('delete() is a no-op for unknown session', async () => {
    const mgr = makeManager();
    await expect(mgr.delete('ghost')).resolves.toBeUndefined();
  });

  test('delete() stops session if it is running', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    const session = mgr.sessions.get(id);
    session.meta.status = STATES.RUNNING;

    await mgr.delete(id);
    expect(session.stop).toHaveBeenCalled();
  });
});

// --- stateChange event forwarding ---

describe('stateChange event forwarding', () => {
  test('forwards session stateChange as sessionStateChange', async () => {
    const mgr = makeManager();
    await mgr.create({ projectId: 'proj-1', mode: 'direct' });

    const [session] = mgr.sessions.values();
    const onStateChange = jest.fn();
    mgr.on('sessionStateChange', onStateChange);

    // Simulate a stateChange from the session
    session.emit('stateChange', { id: session.meta.id, state: STATES.RUNNING });

    expect(onStateChange).toHaveBeenCalledWith({ id: session.meta.id, state: STATES.RUNNING });
  });

  test('persists on stateChange', async () => {
    const mgr = makeManager();
    await mgr.create({ projectId: 'proj-1', mode: 'direct' });

    const [session] = mgr.sessions.values();
    mockStoreSave.mockClear();

    session.emit('stateChange', { id: session.meta.id, state: STATES.RUNNING });

    // store.save is called asynchronously — wait a tick
    await new Promise((r) => setImmediate(r));
    expect(mockStoreSave).toHaveBeenCalled();
  });
});

// --- _buildAuthEnv() ---

describe('_buildAuthEnv()', () => {
  test('returns env with TERM set', () => {
    const mgr = makeManager();
    const env = mgr._buildAuthEnv();
    expect(env.TERM).toBe('xterm-256color');
  });

  test('includes CLAUDE_CODE_OAUTH_TOKEN when set', () => {
    const mgr = makeManager();
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

    const env = mgr._buildAuthEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();

    if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
  });
});

// --- refresh() ---

describe('refresh()', () => {
  test('refresh() calls session.refresh() for tmux mode', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'tmux' });
    const session = mgr.sessions.get(id);
    session.meta.status = STATES.RUNNING;

    await mgr.refresh(id);
    expect(session.refresh).toHaveBeenCalled();
  });

  test('refresh() throws for unknown session', async () => {
    const mgr = makeManager();
    await expect(mgr.refresh('ghost')).rejects.toThrow('Session not found');
  });

  test('refresh() for direct mode: calls session.refresh()', async () => {
    const mgr = makeManager();
    const { id } = await mgr.create({ projectId: 'proj-1', mode: 'direct' });
    const session = mgr.sessions.get(id);
    session.meta.status = STATES.RUNNING;

    await mgr.refresh(id);

    expect(session.refresh).toHaveBeenCalled();
  });
});

// --- init() ---

describe('init()', () => {
  test('init() loads sessions from store', async () => {
    const mgr = makeManager();
    mockStoreLoad.mockResolvedValueOnce([
      { id: 'sess-1', projectId: 'proj-1', mode: 'direct', status: STATES.STOPPED, command: 'claude', cwd: '/tmp' },
    ]);

    await mgr.init();
    expect(mgr.exists('sess-1')).toBe(true);
  });

  test('init() returns without error if store is empty', async () => {
    const mgr = makeManager();
    mockStoreLoad.mockResolvedValueOnce([]);
    await expect(mgr.init()).resolves.toBeUndefined();
  });
});
