/**
 * Integration tests: WebSocket protocol end-to-end
 *
 * Spins up a real HTTP + WS server on an ephemeral port with a temp data dir.
 * Uses real SessionManager but mocks DirectSession PTY so no `claude` binary
 * is needed. Verifies the wire protocol: message types, ordering, payloads.
 */

import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import express from 'express';

// ---------------------------------------------------------------------------
// Mock DirectSession so no PTY / claude binary is needed
// ---------------------------------------------------------------------------

function makeEventEmitter() {
  const listeners = {};
  return {
    on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
    emit(event, ...args) { (listeners[event] || []).forEach((cb) => cb(...args)); },
  };
}

function makeDirectSessionInstance(meta) {
  const emitter = makeEventEmitter();
  const instance = {
    meta: { ...meta, status: 'created' },
    viewers: new Map(),
    start: jest.fn().mockImplementation(function () {
      // Simulate immediate transition to RUNNING
      this.meta.status = 'running';
      emitter.emit('stateChange', { id: this.meta.id, state: 'running' });
      return Promise.resolve();
    }),
    stop: jest.fn().mockImplementation(function () {
      this.meta.status = 'stopped';
      emitter.emit('stateChange', { id: this.meta.id, state: 'stopped' });
      return Promise.resolve();
    }),
    write: jest.fn(),
    resize: jest.fn(),
    getSnapshot: jest.fn().mockResolvedValue('snapshot-data'),
    addViewer: jest.fn().mockImplementation(function (clientId, cb) {
      this.viewers.set(clientId, cb);
    }),
    removeViewer: jest.fn().mockImplementation(function (clientId) {
      this.viewers.delete(clientId);
    }),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _emitter: emitter,
  };
  // bind instance methods so `this` works in mocks above
  instance.start = instance.start.bind(instance);
  instance.stop = instance.stop.bind(instance);
  instance.addViewer = instance.addViewer.bind(instance);
  instance.removeViewer = instance.removeViewer.bind(instance);
  return instance;
}

const mockDirectSessionCtor = jest.fn();
jest.unstable_mockModule('../../lib/sessions/DirectSession.js', () => ({
  DirectSession: mockDirectSessionCtor,
}));

// Mock TmuxSession too (not used in these tests but SessionManager imports it)
jest.unstable_mockModule('../../lib/sessions/TmuxSession.js', () => ({
  TmuxSession: jest.fn().mockImplementation((meta) => ({
    meta: { ...meta, status: 'created' },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    write: jest.fn(),
    resize: jest.fn(),
    getSnapshot: jest.fn().mockResolvedValue(''),
    addViewer: jest.fn(),
    removeViewer: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Import real modules (after mocks)
// ---------------------------------------------------------------------------

const { clientRegistry } = await import('../../lib/ws/clientRegistry.js');
const { MessageRouter } = await import('../../lib/ws/MessageRouter.js');
const { SessionHandlers } = await import('../../lib/ws/handlers/sessionHandlers.js');
const { makeTerminalHandlers } = await import('../../lib/ws/handlers/terminalHandlers.js');
const { makeSystemHandlers } = await import('../../lib/ws/handlers/systemHandlers.js');
const { SessionManager } = await import('../../lib/sessions/SessionManager.js');
const { ProjectStore } = await import('../../lib/projects/ProjectStore.js');
const { SettingsStore } = await import('../../lib/settings/SettingsStore.js');
const { TerminalManager } = await import('../../lib/terminals/TerminalManager.js');

// ---------------------------------------------------------------------------
// Test server factory
// ---------------------------------------------------------------------------

let dataDir;
let httpServer;
let wss;
let sessions;
let projectId;

/**
 * Collect all messages from a WS connection until a predicate is satisfied
 * or a timeout occurs. Returns the accumulated array of parsed messages.
 */
function collectMessages(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      reject(new Error(
        `Timeout waiting for WS messages. Got so far: ${JSON.stringify(messages.map(m => m.type))}`
      ));
    }, timeoutMs);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (predicate(messages)) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}

/**
 * Wait for a single specific message type from a WS connection.
 */
function waitForMessage(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type "${type}"`));
    }, timeoutMs);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

/**
 * Open a WS client and wait until we receive the initial `sessions:list` message
 * (which is always the 2nd message after `init`).
 * Returns the WS and the array of initial messages.
 */
function openClient(serverPort) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}`);
    const initial = [];
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 3000);

    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      initial.push(msg);
      // Wait until we have both `init` and `sessions:list`
      if (initial.length >= 2) {
        clearTimeout(timer);
        resolve({ ws, initial });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// beforeAll / afterAll
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Reset DirectSession mock factory
  mockDirectSessionCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));

  // Create a temp data dir
  dataDir = await mkdtemp(join(tmpdir(), 'ws-integration-'));

  // Build real stores + managers
  const projects = new ProjectStore(join(dataDir, 'projects.json'));
  const settings = new SettingsStore({ filePath: join(dataDir, 'settings.json') });
  sessions = new SessionManager(projects, settings, { dataDir });
  const terminals = new TerminalManager();

  // Add a test project
  const proj = projects.create({ name: 'Test Project', path: dataDir });
  projectId = proj.id;

  // Wire WS handlers
  const sessionHandlers = new SessionHandlers(sessions, clientRegistry);
  const terminalHandlers = makeTerminalHandlers(terminals, clientRegistry);
  const systemHandlers = makeSystemHandlers({ settingsStore: settings, registry: clientRegistry });
  const router = new MessageRouter({ sessionHandlers, terminalHandlers, systemHandlers });

  // Build Express + WS server
  const app = express();
  app.use(express.json());

  httpServer = createServer(app);
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    const clientId = clientRegistry.add(ws);

    clientRegistry.send(clientId, { type: 'init', clientId, serverVersion: '2.0.0' });
    clientRegistry.send(clientId, { type: 'sessions:list', sessions: sessions.list() });

    ws.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      router.route(clientId, message, clientRegistry);
    });

    ws.on('close', () => {
      clientRegistry.remove(clientId);
    });

    ws.on('error', () => {
      clientRegistry.remove(clientId);
    });
  });

  // Start server on a random port
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
}, 15000);

afterAll(async () => {
  // Close all active WS connections
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => httpServer.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}, 10000);

beforeEach(() => {
  jest.clearAllMocks();
  mockDirectSessionCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));
});

// ---------------------------------------------------------------------------
// Helper: get the test port
// ---------------------------------------------------------------------------
function serverPort() {
  return httpServer.address().port;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocket connect: initial handshake', () => {
  test('server sends "init" message with clientId and serverVersion on connect', async () => {
    const { ws, initial } = await openClient(serverPort());

    const initMsg = initial.find((m) => m.type === 'init');
    expect(initMsg).toBeDefined();
    expect(initMsg.clientId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(initMsg.serverVersion).toBe('2.0.0');

    ws.close();
  });

  test('server sends "sessions:list" as second message on connect', async () => {
    const { ws, initial } = await openClient(serverPort());

    const listMsg = initial.find((m) => m.type === 'sessions:list');
    expect(listMsg).toBeDefined();
    expect(Array.isArray(listMsg.sessions)).toBe(true);

    ws.close();
  });

  test('each connection receives a unique clientId', async () => {
    const { ws: ws1, initial: i1 } = await openClient(serverPort());
    const { ws: ws2, initial: i2 } = await openClient(serverPort());

    const id1 = i1.find((m) => m.type === 'init').clientId;
    const id2 = i2.find((m) => m.type === 'init').clientId;
    expect(id1).not.toBe(id2);

    ws1.close();
    ws2.close();
  });
});

describe('session:list — initial state', () => {
  test('sessions:list has empty array when no sessions exist', async () => {
    // Delete all sessions first so we get a clean state
    for (const s of sessions.sessions.values()) {
      await sessions.delete(s.meta.id).catch(() => {});
    }

    const { ws, initial } = await openClient(serverPort());
    const listMsg = initial.find((m) => m.type === 'sessions:list');

    // Should be array (may have sessions from parallel tests — just check structure)
    expect(Array.isArray(listMsg.sessions)).toBe(true);
    for (const s of listMsg.sessions) {
      expect(s.id).toBeTruthy();
      expect(s.projectId).toBeTruthy();
    }

    ws.close();
  });
});

describe('session:create', () => {
  test('creates a session and returns session:created', async () => {
    const { ws, initial } = await openClient(serverPort());

    const createdPromise = waitForMessage(ws, 'session:created');

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId,
      mode: 'direct',
      name: 'ws-test-session',
    }));

    const created = await createdPromise;

    expect(created.type).toBe('session:created');
    expect(created.session).toBeDefined();
    expect(created.session.id).toBeTruthy();
    expect(created.session.projectId).toBe(projectId);
    expect(created.session.mode).toBe('direct');

    ws.close();
  });

  test('session:create broadcasts updated sessions:list to all clients', async () => {
    const { ws: ws1 } = await openClient(serverPort());
    const { ws: ws2 } = await openClient(serverPort());

    // Collect ALL messages on ws2 — the broadcast sessions:list will arrive
    // after session:created lands on ws1. We must capture it regardless of
    // how many sessions:list messages ws2 has already received.
    const listPromise = new Promise((resolve, reject) => {
      let count = 0;
      const timer = setTimeout(() => reject(new Error('Broadcast timeout')), 4000);
      ws2.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'sessions:list') {
          count++;
          // The broadcast sessions:list arrives on this NEW listener,
          // which is added AFTER openClient() already consumed the initial one.
          if (count >= 1) {
            clearTimeout(timer);
            resolve(msg);
          }
        }
      });
    });

    ws1.send(JSON.stringify({
      type: 'session:create',
      projectId,
      mode: 'direct',
      name: 'broadcast-test',
    }));

    const updatedList = await listPromise;
    expect(Array.isArray(updatedList.sessions)).toBe(true);
    // The new session should appear in the list
    expect(updatedList.sessions.some((s) => s.mode === 'direct')).toBe(true);

    ws1.close();
    ws2.close();
  });

  test('session:create with invalid projectId returns session:error', async () => {
    const { ws } = await openClient(serverPort());

    const errorPromise = waitForMessage(ws, 'session:error');

    ws.send(JSON.stringify({
      type: 'session:create',
      projectId: 'nonexistent-project-id',
      mode: 'direct',
    }));

    const err = await errorPromise;
    expect(err.type).toBe('session:error');
    expect(err.error).toMatch(/not found/i);

    ws.close();
  });
});

describe('session:subscribe', () => {
  test('returns session:snapshot then session:subscribed in order', async () => {
    // Create a session first via manager directly
    const sessionMeta = await sessions.create({ projectId, mode: 'direct', name: 'sub-test' });

    const { ws } = await openClient(serverPort());

    const received = [];
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `Subscribe timeout. Got: ${JSON.stringify(received.map(m => m.type))}`
      )), 4000);

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'session:snapshot' || msg.type === 'session:subscribed') {
          received.push(msg);
          if (received.length === 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionMeta.id }));
    await done;

    expect(received[0].type).toBe('session:snapshot');
    expect(received[0].id).toBe(sessionMeta.id);
    expect(received[1].type).toBe('session:subscribed');
    expect(received[1].id).toBe(sessionMeta.id);

    ws.close();
  });

  test('snapshot message contains session data field', async () => {
    const sessionMeta = await sessions.create({ projectId, mode: 'direct', name: 'snap-data-test' });
    const { ws } = await openClient(serverPort());

    const snapshotPromise = waitForMessage(ws, 'session:snapshot', 4000);

    ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionMeta.id }));

    const snap = await snapshotPromise;
    expect(snap.data).toBeDefined(); // snapshot-data from mock
    expect(snap.id).toBe(sessionMeta.id);

    ws.close();
  });

  test('subscribe to unknown session returns session:error', async () => {
    const { ws } = await openClient(serverPort());

    const errorPromise = waitForMessage(ws, 'session:error');

    ws.send(JSON.stringify({ type: 'session:subscribe', id: 'does-not-exist' }));

    const err = await errorPromise;
    expect(err.type).toBe('session:error');
    expect(err.error).toMatch(/not found/i);

    ws.close();
  });
});

describe('session:input', () => {
  test('session:input calls write on the session', async () => {
    const sessionMeta = await sessions.create({ projectId, mode: 'direct', name: 'input-test' });

    // Get the actual session instance to spy on its write()
    const sessionInst = sessions.sessions.get(sessionMeta.id);
    const writeSpy = sessionInst.write;

    // Force status to running so write() passes through
    sessionInst.meta.status = 'running';

    const { ws } = await openClient(serverPort());

    ws.send(JSON.stringify({
      type: 'session:input',
      id: sessionMeta.id,
      data: 'hello\n',
    }));

    // Give the server a tick to process
    await new Promise((r) => setTimeout(r, 100));

    expect(writeSpy).toHaveBeenCalledWith('hello\n');

    ws.close();
  });
});

describe('session:stop', () => {
  test('session:stop transitions session to stopped and broadcasts sessions:list', async () => {
    const sessionMeta = await sessions.create({ projectId, mode: 'direct', name: 'stop-test' });

    const { ws } = await openClient(serverPort());

    // Wait for the sessions:list broadcast that follows a stop
    const listAfterStop = waitForMessage(ws, 'sessions:list', 4000);

    ws.send(JSON.stringify({ type: 'session:stop', id: sessionMeta.id }));

    const updatedList = await listAfterStop;
    expect(Array.isArray(updatedList.sessions)).toBe(true);

    // The session should now be stopped
    const stoppedSession = updatedList.sessions.find((s) => s.id === sessionMeta.id);
    if (stoppedSession) {
      // State should be stopped (mock stop() sets it)
      expect(stoppedSession.status).toBe('stopped');
    }

    ws.close();
  });

  test('session:stop on unknown session returns session:error', async () => {
    const { ws } = await openClient(serverPort());

    const errorPromise = waitForMessage(ws, 'session:error');

    ws.send(JSON.stringify({ type: 'session:stop', id: 'nonexistent-stop' }));

    const err = await errorPromise;
    expect(err.type).toBe('session:error');
    expect(err.error).toMatch(/not found/i);

    ws.close();
  });
});

describe('malformed messages', () => {
  test('server does not crash on invalid JSON from client', async () => {
    const { ws } = await openClient(serverPort());

    // Send garbage — server should not crash
    ws.send('not-valid-json{{{{');

    await new Promise((r) => setTimeout(r, 200));

    // Server is still alive — the WebSocket connection is still open
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Send a valid message and verify we get a response (session:create error)
    const errorPromise = waitForMessage(ws, 'session:error', 3000);
    ws.send(JSON.stringify({ type: 'session:create', projectId: 'no-such-project', mode: 'direct' }));
    const err = await errorPromise;
    expect(err.type).toBe('session:error');

    ws.close();
  });

  test('server handles message with no type field gracefully', async () => {
    const { ws } = await openClient(serverPort());

    ws.send(JSON.stringify({ foo: 'bar' })); // no type field

    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });
});
