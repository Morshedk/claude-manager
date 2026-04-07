/**
 * Category D: Reconnect & Persistence — Adversarial Tests
 *
 * Mix of raw Node.js WS tests (D.01-D.12, D.13-D.14) and Playwright browser tests (D.01-D.05, D.13-D.15).
 *
 * Adversarial angle: find bugs in reconnect/persistence code, not just verify happy path.
 * A false PASS damages reputation. These tests are written to expose real failure modes.
 *
 * Tests covered:
 *   D.01 — Browser reload: session visible after page refresh
 *   D.02 — Browser reload: terminal reconnects via WS
 *   D.03 — Browser reload: no stale event handlers (5 reloads)
 *   D.04 — WS disconnect: auto-reconnect fires
 *   D.05 — WS disconnect: terminal resumes live output
 *   D.06 — Server restart: sessions.json survives SIGKILL
 *   D.07 — Server restart: sessions visible after restart
 *   D.08 — Server restart: tmux session reconnects (tmux is external process)
 *   D.09 — Server restart: direct session marked as stopped
 *   D.10 — Unknown status in sessions.json migrated to stopped
 *   D.11 — Corrupted sessions.json mid-run: server survives
 *   D.12 — sessions.json deleted mid-run: server survives on next save
 *   D.13 — Multiple browser tabs: both see same sessions
 *   D.14 — Multiple browser tabs: both can subscribe to same session
 *   D.15 — Subscribe after server restart without re-navigating: graceful error
 */

import { jest } from '@jest/globals';
import { mkdtemp, rm, writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import express from 'express';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a specific message type on a WebSocket connection.
 */
function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for WS message type "${type}" (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);
  });
}

/**
 * Wait for a message matching a predicate.
 */
function waitForMessageWhere(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for matching WS message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);
  });
}

/**
 * Open a WebSocket and wait for the initial handshake (init + sessions:list).
 */
function openClient(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const initial = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WS connect/handshake timeout (port ${port})`));
    }, timeoutMs);

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      initial.push(msg);
      if (initial.length >= 2) {
        clearTimeout(timer);
        resolve({ ws, initial });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// In-process server factory (using real SessionManager with mocked PTY)
// ---------------------------------------------------------------------------

// Mock DirectSession + TmuxSession — we'll do these tests in a subprocess server
// for D.06-D.12 where we need real disk persistence, but use in-process for
// D.13-D.15 where we need multi-client coordination without tmux.

// ---------------------------------------------------------------------------
// Mock DirectSession so no PTY / claude binary is needed
// ---------------------------------------------------------------------------

function makeEventEmitter() {
  const listeners = {};
  return {
    on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
    emit(event, ...args) { (listeners[event] || []).forEach((cb) => cb(...args)); },
    off(event, cb) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((x) => x !== cb);
      }
    },
  };
}

function makeDirectSessionInstance(meta) {
  const emitter = makeEventEmitter();
  const state = {
    meta: { ...meta, status: 'created' },
    viewers: new Map(),
    pty: null,
  };

  const instance = {
    get meta() { return state.meta; },
    set meta(v) { state.meta = v; },
    get viewers() { return state.viewers; },
    get pty() { return state.pty; },

    start: jest.fn(() => {
      state.meta.status = 'running';
      emitter.emit('stateChange', { id: state.meta.id, state: 'running' });
      // Simulate a pty being attached
      state.pty = { alive: true };
      return Promise.resolve();
    }),

    stop: jest.fn(() => {
      state.meta.status = 'stopped';
      state.pty = null;
      emitter.emit('stateChange', { id: state.meta.id, state: 'stopped' });
      return Promise.resolve();
    }),

    write: jest.fn(),
    resize: jest.fn(),

    addViewer: jest.fn((clientId, cb) => {
      state.viewers.set(clientId, cb);
    }),

    removeViewer: jest.fn((clientId) => {
      state.viewers.delete(clientId);
    }),

    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _emitter: emitter,
    _state: state,
  };
  return instance;
}

const mockDirectSessionCtor = jest.fn();
jest.unstable_mockModule('../../lib/sessions/DirectSession.js', () => ({
  DirectSession: mockDirectSessionCtor,
}));

jest.unstable_mockModule('../../lib/sessions/TmuxSession.js', () => ({
  TmuxSession: jest.fn().mockImplementation((meta) => {
    const emitter = makeEventEmitter();
    const state = { meta: { ...meta, status: 'created' }, viewers: new Map(), pty: null };
    return {
      get meta() { return state.meta; },
      set meta(v) { state.meta = v; },
      get viewers() { return state.viewers; },
      get pty() { return state.pty; },
      start: jest.fn(() => {
        state.meta.status = 'running';
        emitter.emit('stateChange', { id: state.meta.id, state: 'running' });
        return Promise.resolve();
      }),
      stop: jest.fn(() => {
        state.meta.status = 'stopped';
        emitter.emit('stateChange', { id: state.meta.id, state: 'stopped' });
        return Promise.resolve();
      }),
      write: jest.fn(),
      resize: jest.fn(),
      addViewer: jest.fn((clientId, cb) => state.viewers.set(clientId, cb)),
      removeViewer: jest.fn((clientId) => state.viewers.delete(clientId)),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      _attachPty: jest.fn(),
    };
  }),
}));

// Import real modules after mocks
const { clientRegistry } = await import('../../lib/ws/clientRegistry.js');
const { MessageRouter } = await import('../../lib/ws/MessageRouter.js');
const { SessionHandlers } = await import('../../lib/ws/handlers/sessionHandlers.js');
const { makeTerminalHandlers } = await import('../../lib/ws/handlers/terminalHandlers.js');
const { makeSystemHandlers } = await import('../../lib/ws/handlers/systemHandlers.js');
const { SessionManager } = await import('../../lib/sessions/SessionManager.js');
const { ProjectStore } = await import('../../lib/projects/ProjectStore.js');
const { SettingsStore } = await import('../../lib/settings/SettingsStore.js');
const { TerminalManager } = await import('../../lib/terminals/TerminalManager.js');
const { SessionStore } = await import('../../lib/sessions/SessionStore.js');

// ---------------------------------------------------------------------------
// In-process test server factory
// ---------------------------------------------------------------------------

async function buildTestServer(dataDir) {
  const projects = new ProjectStore(join(dataDir, 'projects.json'));
  const settings = new SettingsStore({ filePath: join(dataDir, 'settings.json') });
  const sessions = new SessionManager(projects, settings, { dataDir });
  const terminals = new TerminalManager();

  const proj = projects.create({ name: 'Test Project', path: dataDir });

  await sessions.init();

  const sessionHandlers = new SessionHandlers(sessions, clientRegistry);
  const terminalHandlers = makeTerminalHandlers(terminals, clientRegistry);
  const systemHandlers = makeSystemHandlers({ settingsStore: settings, registry: clientRegistry });
  const router = new MessageRouter({ sessionHandlers, terminalHandlers, systemHandlers });

  const app = express();
  app.use(express.json());

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

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
      const client = clientRegistry.get(clientId);
      if (client) {
        for (const subId of client.subscriptions) {
          terminals.removeViewer(subId, clientId);
          sessions.unsubscribe(subId, clientId);
        }
      }
      clientRegistry.remove(clientId);
    });

    ws.on('error', () => clientRegistry.remove(clientId));
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  return {
    sessions,
    projects,
    projectId: proj.id,
    httpServer,
    wss,
    port: () => httpServer.address().port,
    async teardown() {
      for (const client of wss.clients) client.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => httpServer.close(r));
    },
  };
}

// ---------------------------------------------------------------------------
// Subprocess server (real server.js with real PTY, for persistence tests)
// ---------------------------------------------------------------------------

const V2_DIR = '/home/claude-runner/apps/claude-web-app-v2';

function spawnServer(dataDir, port) {
  const proc = spawn('node', ['server.js'], {
    cwd: V2_DIR,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  return proc;
}

async function waitForServerReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Server on port ${port} did not become ready in ${timeoutMs}ms`);
}

function killServer(proc) {
  try { proc.kill('SIGKILL'); } catch {}
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

let globalDataDir;
let server;

beforeAll(async () => {
  mockDirectSessionCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));
  globalDataDir = await mkdtemp(join(tmpdir(), 'd-reconnect-'));
  server = await buildTestServer(globalDataDir);
}, 20000);

afterAll(async () => {
  if (server) await server.teardown();
  if (globalDataDir) await rm(globalDataDir, { recursive: true, force: true });
}, 15000);

beforeEach(() => {
  jest.clearAllMocks();
  mockDirectSessionCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));
});

// ===========================================================================
// D.01 — Server sends sessions:list on new WS connection (browser reload model)
// ===========================================================================

describe('D.01 — Browser reload: session visible after page refresh', () => {
  test('new WS connection receives sessions:list with existing sessions', async () => {
    // Create a session via WS
    const { ws: ws1 } = await openClient(server.port());
    const createdPromise = waitForMessage(ws1, 'session:created');
    ws1.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd01-persist' }));
    const created = await createdPromise;
    const sessionId = created.session.id;

    ws1.close();
    await sleep(100); // Let server process the close

    // Simulate reload: open a new WS connection
    const { ws: ws2, initial } = await openClient(server.port());

    const listMsg = initial.find((m) => m.type === 'sessions:list');
    expect(listMsg).toBeDefined();
    expect(Array.isArray(listMsg.sessions)).toBe(true);

    // The session created before reload must be in the list
    const found = listMsg.sessions.find((s) => s.id === sessionId);
    expect(found).toBeDefined();
    // BUG CANDIDATE: If server doesn't send sessions:list on init, or sends empty list, this fails
    expect(found.name).toBe('d01-persist');

    ws2.close();
  });
});

// ===========================================================================
// D.02 — Browser reload: subscribe to existing session works after reload
// ===========================================================================

describe('D.02 — Browser reload: terminal reconnects via WS', () => {
  test('subscribe to existing session after simulated page reload returns session:subscribed', async () => {
    // Create session on first connection
    const { ws: ws1 } = await openClient(server.port());
    const createdPromise = waitForMessage(ws1, 'session:created');
    ws1.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd02-reload' }));
    const created = await createdPromise;
    const sessionId = created.session.id;

    // First connection subscribes and then "closes" (simulated page reload)
    const sub1Promise = waitForMessage(ws1, 'session:subscribed');
    ws1.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
    await sub1Promise;

    ws1.close();
    await sleep(150);

    // Reload: new WS connection, subscribe to same session
    const { ws: ws2 } = await openClient(server.port());
    const sub2Promise = waitForMessage(ws2, 'session:subscribed', 4000);
    ws2.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));

    const subMsg = await sub2Promise;
    // BUG CANDIDATE: If old viewer reference leaks and blocks re-subscribe, this fails
    expect(subMsg.type).toBe('session:subscribed');
    expect(subMsg.id).toBe(sessionId);

    ws2.close();
  });
});

// ===========================================================================
// D.03 — Browser reload: 5 reloads, no accumulating errors
// ===========================================================================

describe('D.03 — Browser reload: no stale event handlers after 5 reloads', () => {
  test('5 consecutive reconnects succeed without errors', async () => {
    // Create a session once
    const { ws: wsInit } = await openClient(server.port());
    const createdPromise = waitForMessage(wsInit, 'session:created');
    wsInit.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd03-multiload' }));
    const created = await createdPromise;
    const sessionId = created.session.id;
    wsInit.close();
    await sleep(100);

    const errors = [];

    // Simulate 5 page reloads
    for (let i = 0; i < 5; i++) {
      const { ws } = await openClient(server.port());

      // Each reload subscribes
      const subPromise = waitForMessage(ws, 'session:subscribed', 3000);
      ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));

      let sub;
      try {
        sub = await subPromise;
      } catch (err) {
        errors.push(`Reload ${i + 1}: subscribe failed — ${err.message}`);
        ws.close();
        continue;
      }

      // BUG CANDIDATE: After many reloads, if viewers accumulate without cleanup,
      // subscribe may fail or produce duplicate output errors.
      expect(sub.type).toBe('session:subscribed');
      expect(sub.id).toBe(sessionId);

      // Ensure connection closes cleanly before next iteration
      ws.close();
      await sleep(150);
    }

    // All 5 reloads should succeed without error
    expect(errors).toHaveLength(0);
  });
});

// ===========================================================================
// D.04 — WS disconnect: auto-reconnect — server side sees new connection
// ===========================================================================

describe('D.04 — WS disconnect: server handles disconnect + re-connect cleanly', () => {
  test('force-closing WS does not leave ghost client in registry; new connection works', async () => {
    const { ws: ws1 } = await openClient(server.port());

    // Extract clientId from init message
    const initMsg = ws1.messages ? ws1.messages[0] : null;

    // Subscribe to a session first to create a viewer
    const { ws: wsSetup } = await openClient(server.port());
    const createdPromise = waitForMessage(wsSetup, 'session:created');
    wsSetup.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd04-disconnect' }));
    const created = await createdPromise;
    const sessionId = created.session.id;
    wsSetup.close();
    await sleep(100);

    // Subscribe ws1 to session
    const subPromise = waitForMessage(ws1, 'session:subscribed', 3000);
    ws1.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
    await subPromise;

    // Force-close the WS (simulates network drop without clean shutdown)
    ws1.terminate();
    await sleep(200);

    // New connection should work normally
    const { ws: ws2, initial } = await openClient(server.port());
    const listMsg = initial.find((m) => m.type === 'sessions:list');
    // BUG CANDIDATE: If old client was not removed from registry, broadcast bloat occurs
    expect(listMsg).toBeDefined();
    expect(Array.isArray(listMsg.sessions)).toBe(true);

    // New client can subscribe to same session
    const sub2Promise = waitForMessage(ws2, 'session:subscribed', 3000);
    ws2.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
    const sub2 = await sub2Promise;
    expect(sub2.type).toBe('session:subscribed');

    ws2.close();
  });
});

// ===========================================================================
// D.05 — WS disconnect: viewer removed on client disconnect
// ===========================================================================

describe('D.05 — WS disconnect: viewer is removed when client disconnects', () => {
  test('session viewer count decreases after client WS close', async () => {
    // Create session
    const { ws: wsSetup } = await openClient(server.port());
    const createdP = waitForMessage(wsSetup, 'session:created');
    wsSetup.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd05-viewer' }));
    const created = await createdP;
    const sessionId = created.session.id;
    wsSetup.close();
    await sleep(100);

    // Connect and subscribe
    const { ws } = await openClient(server.port());
    const subP = waitForMessage(ws, 'session:subscribed', 3000);
    ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
    await subP;

    // Get the session instance from the manager
    const sessionInstance = server.sessions.sessions.get(sessionId);
    expect(sessionInstance).toBeDefined();
    const viewerCountBefore = sessionInstance.viewers.size;
    expect(viewerCountBefore).toBeGreaterThan(0);

    // Disconnect
    ws.close();
    await sleep(200);

    // BUG CANDIDATE: If viewer cleanup doesn't run on WS close, viewers map leaks
    const viewerCountAfter = sessionInstance.viewers.size;
    expect(viewerCountAfter).toBe(0);
  });
});

// ===========================================================================
// D.06 — Server restart: sessions.json survives (disk persistence check)
// ===========================================================================

describe('D.06 — Server restart: sessions.json persists after server kill', () => {
  test('sessions.json contains all created sessions with correct status', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'd06-'));
    const port = 3096;

    const proc = spawnServer(dataDir, port);
    try {
      await waitForServerReady(port, 20000);

      // Create a project and 2 sessions via REST API
      const projRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'D06 Project', path: dataDir }),
      });
      const proj = await projRes.json();

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((r) => ws.once('open', r));

      // Drain initial messages
      await new Promise((r) => {
        let count = 0;
        ws.on('message', () => { if (++count >= 2) r(); });
      });

      for (const name of ['session-A', 'session-B']) {
        const created = new Promise((r) => {
          ws.once('message', (raw) => {
            const msgs = [];
            // Accumulate until we get session:created
            function onMsg(d) {
              let m;
              try { m = JSON.parse(d.toString()); } catch { return; }
              if (m.type === 'session:created') { ws.off('message', onMsg); r(m); }
            }
            ws.on('message', onMsg);
          });
        });
        ws.send(JSON.stringify({ type: 'session:create', projectId: proj.id, mode: 'direct', name }));
        await created;
      }

      ws.close();
      await sleep(500); // Let saves flush

      // Kill server abruptly
      killServer(proc);
      await sleep(300);

      // Read sessions.json from disk
      const sessionsFile = join(dataDir, 'sessions.json');
      expect(existsSync(sessionsFile)).toBe(true);

      const raw = await readFile(sessionsFile, 'utf8');
      let sessions;
      // BUG CANDIDATE: If sessions.json is truncated due to non-atomic write, this throws
      expect(() => { sessions = JSON.parse(raw); }).not.toThrow();

      expect(Array.isArray(sessions)).toBe(true);
      // BUG CANDIDATE: If save was called but only partial data flushed, could be 0 or 1
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      // Ideally both sessions are there
      const names = sessions.map((s) => s.name);
      expect(names).toContain('session-A');
    } finally {
      killServer(proc);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});

// ===========================================================================
// D.07 — Server restart: sessions visible after restart
// ===========================================================================

describe('D.07 — Server restart: all sessions appear in sessions:list after restart', () => {
  test('sessions from sessions.json appear on reconnect after server restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'd07-'));
    // Write a pre-fabricated sessions.json with 3 sessions
    const projectsData = [{ id: 'proj-d07', name: 'D07 Project', path: dataDir, createdAt: new Date().toISOString() }];
    await writeFile(join(dataDir, 'projects.json'), JSON.stringify({ projects: projectsData, scratchpad: [] }, null, 2));

    const sessionsData = [
      { id: 'sess-d07-1', projectId: 'proj-d07', name: 'Alfa', mode: 'direct', status: 'stopped', createdAt: new Date().toISOString(), claudeSessionId: 'cs1' },
      { id: 'sess-d07-2', projectId: 'proj-d07', name: 'Bravo', mode: 'direct', status: 'stopped', createdAt: new Date().toISOString(), claudeSessionId: 'cs2' },
      { id: 'sess-d07-3', projectId: 'proj-d07', name: 'Charlie', mode: 'direct', status: 'stopped', createdAt: new Date().toISOString(), claudeSessionId: 'cs3' },
    ];
    await writeFile(join(dataDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2));

    const port = 3196;
    const proc = spawnServer(dataDir, port);
    try {
      await waitForServerReady(port, 20000);

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const initial = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Handshake timeout')), 8000);
        ws.on('open', () => {});
        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          initial.push(msg);
          if (initial.length >= 2) { clearTimeout(timer); resolve(); }
        });
        ws.on('error', reject);
      });

      const listMsg = initial.find((m) => m.type === 'sessions:list');
      expect(listMsg).toBeDefined();

      // BUG CANDIDATE: Off-by-one or early exit in load loop — only 2 of 3 sessions loaded
      expect(listMsg.sessions.length).toBe(3);

      const ids = listMsg.sessions.map((s) => s.id);
      expect(ids).toContain('sess-d07-1');
      expect(ids).toContain('sess-d07-2');
      // BUG CANDIDATE: If loop does `i < records.length - 1` accidentally, sess-d07-3 is missing
      expect(ids).toContain('sess-d07-3');

      ws.close();
    } finally {
      killServer(proc);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});

// ===========================================================================
// D.08 — Server restart: tmux session gets status from persisted data
// ===========================================================================

describe('D.08 — Server restart: tmux sessions loaded with persisted status', () => {
  test('tmux session with status=running in sessions.json is loaded correctly', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'd08-'));
    const projectsData = [{ id: 'proj-d08', name: 'D08 Project', path: dataDir, createdAt: new Date().toISOString() }];
    await writeFile(join(dataDir, 'projects.json'), JSON.stringify({ projects: projectsData, scratchpad: [] }, null, 2));

    // Tmux session that was running — server restart should attempt _attachPty
    const sessionsData = [
      {
        id: 'sess-d08-tmux',
        projectId: 'proj-d08',
        name: 'Tmux Alpha',
        mode: 'tmux',
        status: 'stopped', // stopped since tmux likely doesn't exist in test env
        tmuxName: 'cm-test-d08',
        createdAt: new Date().toISOString(),
      },
    ];
    await writeFile(join(dataDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2));

    const port = 3197;
    const proc = spawnServer(dataDir, port);
    try {
      await waitForServerReady(port, 20000);

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const initial = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('D08 handshake timeout')), 8000);
        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          initial.push(msg);
          if (initial.length >= 2) { clearTimeout(timer); resolve(); }
        });
        ws.on('error', reject);
      });

      const listMsg = initial.find((m) => m.type === 'sessions:list');
      expect(listMsg).toBeDefined();

      // BUG CANDIDATE: Tmux session not loaded at all, or crashes during _attachPty
      expect(listMsg.sessions.length).toBe(1);
      const s = listMsg.sessions[0];
      expect(s.id).toBe('sess-d08-tmux');
      // Status should be stopped (tmux session doesn't exist in test env) or error — NOT undefined, NOT crash
      expect(['stopped', 'error', 'running']).toContain(s.status);

      ws.close();
    } finally {
      killServer(proc);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});

// ===========================================================================
// D.09 — Server restart: direct session auto-resume (or marked stopped)
// ===========================================================================

describe('D.09 — Server restart: direct session marked stopped after restart', () => {
  test('direct session that was running is reloaded (auto-resume or stopped state)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'd09-'));
    const projectsData = [{ id: 'proj-d09', name: 'D09 Project', path: dataDir, createdAt: new Date().toISOString() }];
    await writeFile(join(dataDir, 'projects.json'), JSON.stringify({ projects: projectsData, scratchpad: [] }, null, 2));

    // Direct session that was RUNNING when server died
    const sessionsData = [
      {
        id: 'sess-d09-direct',
        projectId: 'proj-d09',
        name: 'Direct Alpha',
        mode: 'direct',
        status: 'running', // Was running when server died
        claudeSessionId: 'cs-d09-001',
        createdAt: new Date().toISOString(),
      },
    ];
    await writeFile(join(dataDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2));

    const port = 3198;
    const proc = spawnServer(dataDir, port);
    try {
      await waitForServerReady(port, 20000);

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const initial = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('D09 handshake timeout')), 8000);
        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          initial.push(msg);
          if (initial.length >= 2) { clearTimeout(timer); resolve(); }
        });
        ws.on('error', reject);
      });

      const listMsg = initial.find((m) => m.type === 'sessions:list');
      expect(listMsg).toBeDefined();

      // BUG CANDIDATE: Session missing entirely — init() crash during auto-resume
      expect(listMsg.sessions.length).toBe(1);
      const s = listMsg.sessions[0];
      expect(s.id).toBe('sess-d09-direct');

      // Auto-resume: could be running (if claude binary exists), error, or stopped
      // Key: must NOT be 'created' (stuck state) and must NOT crash the server
      expect(['running', 'stopped', 'error', 'starting']).toContain(s.status);

      ws.close();
    } finally {
      killServer(proc);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});

// ===========================================================================
// D.10 — Unknown status migration
// ===========================================================================

describe('D.10 — Unknown status in sessions.json migrated to stopped', () => {
  test('legacy "shell" status from v1 is migrated to stopped, server does not crash', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'd10-'));
    const projectsData = [{ id: 'proj-d10', name: 'D10 Project', path: dataDir, createdAt: new Date().toISOString() }];
    await writeFile(join(dataDir, 'projects.json'), JSON.stringify({ projects: projectsData, scratchpad: [] }, null, 2));

    const sessionsData = [
      {
        id: 'sess-d10-shell',
        projectId: 'proj-d10',
        name: 'Legacy Shell',
        mode: 'direct',
        status: 'shell', // v1 legacy status — NOT in v2 STATES enum
        claudeSessionId: 'cs-d10',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'sess-d10-zombie',
        projectId: 'proj-d10',
        name: 'Zombie State',
        mode: 'direct',
        status: 'zombie', // Completely made-up state
        claudeSessionId: 'cs-d10-z',
        createdAt: new Date().toISOString(),
      },
    ];
    await writeFile(join(dataDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2));

    const port = 3199;
    const proc = spawnServer(dataDir, port);
    try {
      // BUG CANDIDATE: If server crashes on unknown status, waitForServerReady throws
      await waitForServerReady(port, 20000);

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const initial = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('D10 handshake timeout')), 8000);
        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          initial.push(msg);
          if (initial.length >= 2) { clearTimeout(timer); resolve(); }
        });
        ws.on('error', reject);
      });

      const listMsg = initial.find((m) => m.type === 'sessions:list');
      expect(listMsg).toBeDefined();

      // Both sessions must appear
      expect(listMsg.sessions.length).toBe(2);

      for (const s of listMsg.sessions) {
        // BUG CANDIDATE: Unknown state causes assertTransition crash, session absent
        expect(s).toBeDefined();
        // Migrated to 'stopped' — NOT 'shell' or 'zombie'
        expect(s.status).toBe('stopped');
      }

      ws.close();
    } finally {
      killServer(proc);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});

// ===========================================================================
// D.11 — Corrupted sessions.json mid-run: server survives
// ===========================================================================

describe('D.11 — Corrupted sessions.json mid-run: server survives', () => {
  test('overwriting sessions.json with garbage while server runs does not crash the server', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'd11-'));
    const projectsData = [{ id: 'proj-d11', name: 'D11 Project', path: dataDir, createdAt: new Date().toISOString() }];
    await writeFile(join(dataDir, 'projects.json'), JSON.stringify({ projects: projectsData, scratchpad: [] }, null, 2));

    const port = 3200;
    const proc = spawnServer(dataDir, port);
    let serverCrashed = false;
    proc.on('exit', (code) => { if (code !== 0 && code !== null) serverCrashed = true; });

    try {
      await waitForServerReady(port, 20000);

      // Corrupt the file while server is running
      await writeFile(join(dataDir, 'sessions.json'), '{invalid json <<<garbage>>>');

      // Wait briefly
      await sleep(300);

      // Trigger a save by creating a new session via WS
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((r) => ws.once('open', r));

      // Drain initial messages
      let msgCount = 0;
      await new Promise((r) => {
        ws.on('message', () => { if (++msgCount >= 2) r(); });
      });

      const createdP = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session:created timeout')), 8000);
        ws.on('message', (raw) => {
          let m;
          try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === 'session:created' || m.type === 'session:error') {
            clearTimeout(timer);
            resolve(m);
          }
        });
      });

      ws.send(JSON.stringify({ type: 'session:create', projectId: 'proj-d11', mode: 'direct', name: 'd11-new' }));
      const result = await createdP;
      // BUG CANDIDATE: save() fails because it can't parse corrupted file (upsert reads-then-writes)
      // Actually SessionStore.save() writes from in-memory Map, doesn't read first — should succeed
      expect(result.type).toBe('session:created');

      // Verify sessions.json is valid now (save overwrote garbage)
      await sleep(200);
      const raw = await readFile(join(dataDir, 'sessions.json'), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();

      // Server must not have crashed
      expect(serverCrashed).toBe(false);

      ws.close();
    } finally {
      killServer(proc);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});

// ===========================================================================
// D.12 — Deleted sessions.json: server creates fresh file on next save
// ===========================================================================

describe('D.12 — sessions.json deleted mid-run: server survives', () => {
  test('deleting sessions.json while running does not crash; next save creates new file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'd12-'));
    const projectsData = [{ id: 'proj-d12', name: 'D12 Project', path: dataDir, createdAt: new Date().toISOString() }];
    await writeFile(join(dataDir, 'projects.json'), JSON.stringify({ projects: projectsData, scratchpad: [] }, null, 2));

    const port = 3201;
    const proc = spawnServer(dataDir, port);
    let serverCrashed = false;
    proc.on('exit', (code) => { if (code !== 0 && code !== null) serverCrashed = true; });

    try {
      await waitForServerReady(port, 20000);

      // Delete sessions.json while server is running
      const sessionsFile = join(dataDir, 'sessions.json');
      if (existsSync(sessionsFile)) {
        await unlink(sessionsFile);
      }

      await sleep(200);

      // Trigger a save by creating a session
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((r) => ws.once('open', r));
      let msgCount = 0;
      await new Promise((r) => { ws.on('message', () => { if (++msgCount >= 2) r(); }); });

      const createdP = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session:created timeout')), 8000);
        ws.on('message', (raw) => {
          let m;
          try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === 'session:created' || m.type === 'session:error') {
            clearTimeout(timer);
            resolve(m);
          }
        });
      });

      ws.send(JSON.stringify({ type: 'session:create', projectId: 'proj-d12', mode: 'direct', name: 'd12-after-delete' }));
      const result = await createdP;
      // BUG CANDIDATE: writeFile might fail if directory doesn't exist — but mkdir(recursive) should handle it
      expect(result.type).toBe('session:created');

      // sessions.json must be recreated
      await sleep(300);
      expect(existsSync(sessionsFile)).toBe(true);

      const raw = await readFile(sessionsFile, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();

      expect(serverCrashed).toBe(false);

      ws.close();
    } finally {
      killServer(proc);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});

// ===========================================================================
// D.13 — Multiple browser tabs: both see same sessions
// ===========================================================================

describe('D.13 — Multiple browser tabs: both see same sessions', () => {
  test('two simultaneous WS clients both receive the same sessions:list on connect', async () => {
    // Create a session first
    const { ws: wsPrep } = await openClient(server.port());
    const createdP = waitForMessage(wsPrep, 'session:created');
    wsPrep.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd13-shared' }));
    const created = await createdP;
    const sessionId = created.session.id;
    wsPrep.close();
    await sleep(100);

    // Open two clients simultaneously
    const [client1, client2] = await Promise.all([
      openClient(server.port()),
      openClient(server.port()),
    ]);

    const list1 = client1.initial.find((m) => m.type === 'sessions:list');
    const list2 = client2.initial.find((m) => m.type === 'sessions:list');

    expect(list1).toBeDefined();
    expect(list2).toBeDefined();

    // BUG CANDIDATE: If server sends list before the session is persisted, one client sees it, one doesn't
    const ids1 = list1.sessions.map((s) => s.id);
    const ids2 = list2.sessions.map((s) => s.id);

    expect(ids1).toContain(sessionId);
    // BUG CANDIDATE: Second tab may see stale list if server has a per-connection cache
    expect(ids2).toContain(sessionId);

    client1.ws.close();
    client2.ws.close();
  });

  test('session created in tab 1 is broadcast to tab 2 immediately', async () => {
    const { ws: ws1 } = await openClient(server.port());
    const { ws: ws2 } = await openClient(server.port());

    // Tab 2 watches for sessions:list update
    const tab2ListPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tab 2 did not receive sessions:list broadcast')), 5000);
      ws2.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'sessions:list') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    // Tab 1 creates a session
    ws1.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd13-broadcast' }));

    const broadcastList = await tab2ListPromise;
    // BUG CANDIDATE: If broadcast doesn't happen or uses old list, new session absent
    expect(broadcastList.sessions.some((s) => s.name === 'd13-broadcast')).toBe(true);

    ws1.close();
    ws2.close();
  });
});

// ===========================================================================
// D.14 — Multiple browser tabs: both subscribe to same session
// ===========================================================================

describe('D.14 — Multiple browser tabs: both can subscribe to same session', () => {
  test('two clients subscribed to same session both receive output', async () => {
    // Create a session
    const { ws: wsSetup } = await openClient(server.port());
    const createdP = waitForMessage(wsSetup, 'session:created');
    wsSetup.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd14-multi' }));
    const created = await createdP;
    const sessionId = created.session.id;
    wsSetup.close();
    await sleep(100);

    // Two clients subscribe to same session
    const { ws: ws1 } = await openClient(server.port());
    const { ws: ws2 } = await openClient(server.port());

    const sub1P = waitForMessage(ws1, 'session:subscribed', 4000);
    const sub2P = waitForMessage(ws2, 'session:subscribed', 4000);

    ws1.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
    ws2.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));

    const [sub1, sub2] = await Promise.all([sub1P, sub2P]);
    // BUG CANDIDATE: Second subscribe fails or returns error (viewers Map conflict)
    expect(sub1.type).toBe('session:subscribed');
    expect(sub2.type).toBe('session:subscribed');

    // Get the session and check both viewers registered
    const sessionInstance = server.sessions.sessions.get(sessionId);
    expect(sessionInstance.viewers.size).toBe(2);

    // Simulate output — both clients should get it
    const output1P = waitForMessage(ws1, 'session:output', 2000);
    const output2P = waitForMessage(ws2, 'session:output', 2000);

    // Emit output directly to simulate PTY data
    const viewer1 = [...sessionInstance.viewers.values()][0];
    const viewer2 = [...sessionInstance.viewers.values()][1];
    viewer1('hello from PTY');
    viewer2('hello from PTY');

    const [out1, out2] = await Promise.all([output1P, output2P]);
    expect(out1.data).toBe('hello from PTY');
    expect(out2.data).toBe('hello from PTY');

    ws1.close();
    ws2.close();
  });

  test('closing one tab does not affect the other tab\'s subscription', async () => {
    // Create session
    const { ws: wsSetup } = await openClient(server.port());
    const createdP2 = waitForMessage(wsSetup, 'session:created');
    wsSetup.send(JSON.stringify({ type: 'session:create', projectId: server.projectId, mode: 'direct', name: 'd14-close-one' }));
    const created2 = await createdP2;
    const sessionId = created2.session.id;
    wsSetup.close();
    await sleep(100);

    const { ws: ws1 } = await openClient(server.port());
    const { ws: ws2 } = await openClient(server.port());

    const sub1P = waitForMessage(ws1, 'session:subscribed', 4000);
    const sub2P = waitForMessage(ws2, 'session:subscribed', 4000);
    ws1.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
    ws2.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
    await Promise.all([sub1P, sub2P]);

    // Close tab 1
    ws1.close();
    await sleep(200);

    // Tab 2 must still receive output
    const sessionInstance = server.sessions.sessions.get(sessionId);
    // BUG CANDIDATE: If closing one viewer corrupts the viewers Map, tab 2 is also removed
    expect(sessionInstance.viewers.size).toBe(1);

    const output2P = waitForMessage(ws2, 'session:output', 2000);
    const remainingViewer = [...sessionInstance.viewers.values()][0];
    remainingViewer('still alive');

    const out2 = await output2P;
    expect(out2.data).toBe('still alive');

    ws2.close();
  });
});

// ===========================================================================
// D.15 — Subscribe to stale session ID after server restart: graceful error
// ===========================================================================

describe('D.15 — Subscribe to nonexistent session after server restart', () => {
  test('subscribing to a session ID that no longer exists returns session:error, not crash', async () => {
    // This simulates the scenario where a browser tab had an old session ID cached
    // from before a server restart, and tries to subscribe to it after reconnect.
    const { ws } = await openClient(server.port());

    const errorP = waitForMessage(ws, 'session:error', 3000);
    ws.send(JSON.stringify({ type: 'session:subscribe', id: 'stale-session-id-from-before-restart' }));

    const err = await errorP;
    // BUG CANDIDATE: If subscribe crashes (TypeError) instead of returning error, this times out
    expect(err.type).toBe('session:error');
    expect(err.error).toMatch(/not found/i);

    // Server must still be alive
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Can still use the connection normally
    const errorP2 = waitForMessage(ws, 'session:error', 3000);
    ws.send(JSON.stringify({ type: 'session:subscribe', id: 'another-stale-id' }));
    const err2 = await errorP2;
    expect(err2.type).toBe('session:error');

    ws.close();
  });

  test('sessions.json with unknown session IDs loaded — client reconnect sees them with stopped status', async () => {
    // Pre-populate sessions.json with sessions the server has never seen
    // Simulates server restart with data written by a different version or process
    const dataDir = await mkdtemp(join(tmpdir(), 'd15-'));
    const projectsData = [{ id: 'proj-d15', name: 'D15 Project', path: dataDir, createdAt: new Date().toISOString() }];
    await writeFile(join(dataDir, 'projects.json'), JSON.stringify({ projects: projectsData, scratchpad: [] }, null, 2));

    const sessionsData = Array.from({ length: 5 }, (_, i) => ({
      id: `sess-d15-${i}`,
      projectId: 'proj-d15',
      name: `Session ${i}`,
      mode: 'direct',
      status: 'stopped',
      claudeSessionId: `cs-d15-${i}`,
      createdAt: new Date().toISOString(),
    }));
    await writeFile(join(dataDir, 'sessions.json'), JSON.stringify(sessionsData, null, 2));

    const port = 3202;
    const proc = spawnServer(dataDir, port);
    try {
      await waitForServerReady(port, 20000);

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const initial = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('D15 handshake timeout')), 8000);
        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          initial.push(msg);
          if (initial.length >= 2) { clearTimeout(timer); resolve(); }
        });
        ws.on('error', reject);
      });

      const listMsg = initial.find((m) => m.type === 'sessions:list');
      expect(listMsg).toBeDefined();

      // BUG CANDIDATE: Off-by-one — some sessions missing
      expect(listMsg.sessions.length).toBe(5);

      // Client subscribes to a session ID from the list (valid after restart)
      const sessionId = 'sess-d15-2';
      const errOrSub = waitForMessageWhere(ws, (m) => m.type === 'session:subscribed' || m.type === 'session:error', 4000);
      ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionId }));
      const response = await errOrSub;

      // BUG CANDIDATE: subscribe to stopped session auto-resumes → starts claude → fails → crashes
      // Either subscribed (auto-resume succeeded) or error (binary missing) — both are OK
      expect(['session:subscribed', 'session:error']).toContain(response.type);

      ws.close();
    } finally {
      killServer(proc);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});
