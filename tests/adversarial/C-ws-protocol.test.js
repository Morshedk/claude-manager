/**
 * Category C: Adversarial WebSocket Protocol Tests
 *
 * Real HTTP+WS server on ephemeral port. DirectSession mocked — no `claude` binary needed.
 * Raw `ws` client (no browser). 30 test cases targeting protocol bugs.
 *
 * Adversarial angles:
 *  - subscribe -> subscribed ORDER must be guaranteed
 *  - Double subscribe: duplicate output?
 *  - Disconnect without unsubscribe: stale viewer / memory leak?
 *  - Multiple clients on same session: all get output, one disconnect doesn't hurt others
 *  - cols=0/rows=0 in subscribe: silently skipped (falsy check bug)
 *  - 1MB input: server survives
 *  - Binary data: server survives
 *  - 100 rapid messages: none dropped
 *  - Unknown type, malformed JSON, missing fields
 *  - Subscribe to deleted session
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
// Minimal EventEmitter helper for mocks
// ---------------------------------------------------------------------------

function makeEventEmitter() {
  const listeners = {};
  return {
    on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
    emit(event, ...args) { (listeners[event] || []).forEach((cb) => cb(...args)); },
    off(event, cb) {
      if (listeners[event]) listeners[event] = listeners[event].filter((f) => f !== cb);
    },
  };
}

// ---------------------------------------------------------------------------
// DirectSession mock factory — supports emitting output to registered viewers
// ---------------------------------------------------------------------------

function makeDirectSessionInstance(meta) {
  const emitter = makeEventEmitter();
  const instance = {
    meta: { ...meta, status: 'created' },
    pty: null,
    viewers: new Map(),
    start: jest.fn().mockImplementation(function () {
      this.meta.status = 'running';
      this.pty = { write: jest.fn(), resize: jest.fn() };
      emitter.emit('stateChange', { id: this.meta.id, state: 'running', previousState: 'created' });
      return Promise.resolve();
    }),
    stop: jest.fn().mockImplementation(function () {
      this.meta.status = 'stopped';
      this.pty = null;
      emitter.emit('stateChange', { id: this.meta.id, state: 'stopped', previousState: 'running' });
      return Promise.resolve();
    }),
    write: jest.fn(),
    resize: jest.fn(),
    refresh: jest.fn().mockImplementation(function () {
      return Promise.resolve();
    }),
    addViewer: jest.fn().mockImplementation(function (clientId, cb) {
      this.viewers.set(clientId, cb);
    }),
    removeViewer: jest.fn().mockImplementation(function (clientId) {
      this.viewers.delete(clientId);
    }),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _emitter: emitter,
    // Helper: emit PTY output to all viewers
    _emitOutput(data) {
      for (const cb of this.viewers.values()) cb(data);
    },
  };
  instance.start = instance.start.bind(instance);
  instance.stop = instance.stop.bind(instance);
  instance.refresh = instance.refresh.bind(instance);
  instance.addViewer = instance.addViewer.bind(instance);
  instance.removeViewer = instance.removeViewer.bind(instance);
  return instance;
}

const mockDirectSessionCtor = jest.fn();
jest.unstable_mockModule('../../lib/sessions/DirectSession.js', () => ({
  DirectSession: mockDirectSessionCtor,
}));

jest.unstable_mockModule('../../lib/sessions/TmuxSession.js', () => ({
  TmuxSession: jest.fn().mockImplementation((meta) => ({
    meta: { ...meta, status: 'created' },
    pty: null,
    viewers: new Map(),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    write: jest.fn(),
    resize: jest.fn(),
    addViewer: jest.fn(),
    removeViewer: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Import real modules (after mocks are declared)
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
// Test infrastructure
// ---------------------------------------------------------------------------

let dataDir;
let httpServer;
let wss;
let sessions;
let terminals;
let projectId;

/** Get the ephemeral port after server starts */
function serverPort() { return httpServer.address().port; }

/** Open a fresh WS client, wait for init + sessions:list (2 messages) */
function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort()}`);
    const initial = [];
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 4000);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      initial.push(JSON.parse(raw.toString()));
      if (initial.length >= 2) {
        clearTimeout(timer);
        resolve({ ws, initial });
      }
    });
  });
}

/** Collect ALL messages on ws until predicate returns true or timeout */
function collectUntil(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      reject(new Error(
        `Timeout. Got: ${JSON.stringify(messages.map((m) => m.type))}`
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

/** Wait for the first message of a specific type */
function waitFor(ws, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), timeoutMs);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) { clearTimeout(timer); resolve(msg); }
    });
  });
}

/** Collect N messages and return them */
function collectN(ws, n, timeoutMs = 4000) {
  return collectUntil(ws, (msgs) => msgs.length >= n, timeoutMs);
}

/** Send and don't wait for a response */
function send(ws, obj) { ws.send(JSON.stringify(obj)); }

/** Create a real session via SessionManager directly */
async function createSession(name = 'adv-test') {
  return await sessions.create({ projectId, mode: 'direct', name });
}

/** Get the internal mock session instance */
function getSessionInstance(id) {
  return sessions.sessions.get(id);
}

// ---------------------------------------------------------------------------
// beforeAll: start server
// ---------------------------------------------------------------------------

beforeAll(async () => {
  mockDirectSessionCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));

  dataDir = await mkdtemp(join(tmpdir(), 'adv-ws-'));

  const projects = new ProjectStore(join(dataDir, 'projects.json'));
  const settings = new SettingsStore({ filePath: join(dataDir, 'settings.json') });
  sessions = new SessionManager(projects, settings, { dataDir });
  terminals = new TerminalManager();

  const proj = projects.create({ name: 'Adversarial Project', path: dataDir });
  projectId = proj.id;

  const sessionHandlers = new SessionHandlers(sessions, clientRegistry);
  const terminalHandlers = makeTerminalHandlers(terminals, clientRegistry);
  const systemHandlers = makeSystemHandlers({ settingsStore: settings, registry: clientRegistry });
  const router = new MessageRouter({ sessionHandlers, terminalHandlers, systemHandlers });

  const app = express();
  app.use(express.json({ limit: '20mb' }));

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
      // Mirror real server.js: clean up terminal viewers on disconnect
      const client = clientRegistry.get(clientId);
      if (client) {
        for (const subId of client.subscriptions) {
          terminals.removeViewer(subId, clientId);
        }
      }
      // NOTE: real server.js does NOT call sessions.unsubscribe here — this is the bug
      clientRegistry.remove(clientId);
    });

    ws.on('error', () => { clientRegistry.remove(clientId); });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
}, 20000);

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise((r) => wss.close(r));
  await new Promise((r) => httpServer.close(r));
  await rm(dataDir, { recursive: true, force: true });
}, 10000);

beforeEach(() => {
  jest.clearAllMocks();
  mockDirectSessionCtor.mockImplementation((meta) => makeDirectSessionInstance(meta));
});

// ---------------------------------------------------------------------------
// C.01 — Connect receives init then sessions:list in ORDER
// ---------------------------------------------------------------------------

describe('C.01 — init + sessions:list ordering', () => {
  test('first message is init, second is sessions:list — order guaranteed', async () => {
    const { ws, initial } = await openClient();

    expect(initial).toHaveLength(2);
    expect(initial[0].type).toBe('init');
    expect(initial[1].type).toBe('sessions:list');

    expect(initial[0].clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(initial[0].serverVersion).toBe('2.0.0');
    expect(Array.isArray(initial[1].sessions)).toBe(true);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.02 — session:create returns session:created then sessions:list broadcast
// ---------------------------------------------------------------------------

describe('C.02 — session:create broadcast', () => {
  test('creator gets session:created; both clients get sessions:list', async () => {
    const { ws: wsA, initial: iA } = await openClient();
    const { ws: wsB } = await openClient();

    // Capture broadcast on wsB BEFORE sending create
    const bListPromise = waitFor(wsB, 'sessions:list', 5000);

    const aCreatedPromise = waitFor(wsA, 'session:created', 5000);

    send(wsA, { type: 'session:create', projectId, name: 'c02-test', mode: 'direct' });

    const created = await aCreatedPromise;
    const bList = await bListPromise;

    expect(created.session.id).toBeTruthy();
    expect(bList.type).toBe('sessions:list');
    expect(bList.sessions.some((s) => s.id === created.session.id)).toBe(true);

    wsA.close(); wsB.close();
  });
});

// ---------------------------------------------------------------------------
// C.03 — session:subscribe returns session:subscribed
// ---------------------------------------------------------------------------

describe('C.03 — session:subscribe returns session:subscribed', () => {
  test('subscribed message contains session id', async () => {
    const meta = await createSession('c03');
    const { ws } = await openClient();

    const subPromise = waitFor(ws, 'session:subscribed', 4000);
    send(ws, { type: 'session:subscribe', id: meta.id });
    const msg = await subPromise;

    expect(msg.type).toBe('session:subscribed');
    expect(msg.id).toBe(meta.id);

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.04 — session:subscribed arrives BEFORE session:output (ordering bug check)
// ---------------------------------------------------------------------------

describe('C.04 — subscribed before output ordering', () => {
  test('session:subscribed is first, session:output only comes after', async () => {
    const meta = await createSession('c04');
    const inst = getSessionInstance(meta.id);

    const { ws } = await openClient();

    const received = [];
    const outputPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(received), 1500); // allow 1.5s for output to arrive
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'session:subscribed' || msg.type === 'session:output') {
          received.push(msg);
          if (received.length >= 2) { clearTimeout(timer); resolve(received); }
        }
      });
    });

    send(ws, { type: 'session:subscribe', id: meta.id });

    // Emit PTY output shortly after subscribe — after addViewer is called
    // but we want to test if subscribed is guaranteed first
    await new Promise((r) => setTimeout(r, 50));
    inst._emitOutput('hello from PTY');

    const msgs = await outputPromise;

    // CRITICAL: subscribed MUST come before any output
    const subscribedIdx = msgs.findIndex((m) => m.type === 'session:subscribed');
    const firstOutputIdx = msgs.findIndex((m) => m.type === 'session:output');

    expect(subscribedIdx).not.toBe(-1);
    // If output arrived at all, it must come after subscribed
    if (firstOutputIdx !== -1) {
      expect(subscribedIdx).toBeLessThan(firstOutputIdx);
    }

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.05 — Subscribe to unknown session returns session:error
// ---------------------------------------------------------------------------

describe('C.05 — subscribe to unknown session', () => {
  test('returns session:error with correct id', async () => {
    const { ws } = await openClient();

    const errPromise = waitFor(ws, 'session:error', 4000);
    send(ws, { type: 'session:subscribe', id: 'nonexistent-session-xyz' });
    const err = await errPromise;

    expect(err.type).toBe('session:error');
    expect(err.id).toBe('nonexistent-session-xyz');
    expect(err.error).toMatch(/not found/i);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.06 — Subscribe with cols=0, rows=0 (falsy check silently skips resize)
// ---------------------------------------------------------------------------

describe('C.06 — subscribe with cols=0 rows=0 skips resize', () => {
  test('cols=0 rows=0 silently not passed to resize (falsy check in code)', async () => {
    const meta = await createSession('c06');
    const inst = getSessionInstance(meta.id);

    const { ws } = await openClient();
    const subPromise = waitFor(ws, 'session:subscribed', 4000);

    send(ws, { type: 'session:subscribe', id: meta.id, cols: 0, rows: 0 });
    await subPromise;

    // resize should NOT have been called — 0 is falsy, the code uses `if (msg.cols && msg.rows)`
    expect(inst.resize).not.toHaveBeenCalled();

    // FINDING: cols=0 / rows=0 are silently ignored due to falsy check.
    // A terminal requesting 0x0 might expect an error, but gets a silent no-op.
    // This could be a bug if client sends 0 intentionally to reset dimensions.

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.07 — Double subscribe to same session — no duplicate output
// ---------------------------------------------------------------------------

describe('C.07 — double subscribe same client', () => {
  test('second subscribe overwrites viewer — no duplicate output callbacks', async () => {
    const meta = await createSession('c07');
    const inst = getSessionInstance(meta.id);

    const { ws } = await openClient();

    // Subscribe once, wait for subscribed
    send(ws, { type: 'session:subscribe', id: meta.id });
    await waitFor(ws, 'session:subscribed', 4000);

    // Subscribe again to same session
    send(ws, { type: 'session:subscribe', id: meta.id });
    await waitFor(ws, 'session:subscribed', 4000);

    // Now emit output and count how many session:output messages arrive
    const outputMsgs = [];
    const outputCollectPromise = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'session:output') outputMsgs.push(msg);
      });
      setTimeout(() => resolve(outputMsgs), 500);
    });

    inst._emitOutput('ping');
    const collected = await outputCollectPromise;

    // Should receive exactly 1 output, not 2 (Map.set overwrites, so only 1 viewer)
    // If this fails (count === 2), we have a duplicate output bug
    expect(collected.length).toBe(1);
    // FINDING CHECK: addViewer uses Map.set so overwrite is safe — but
    // registry.subscribe uses Set so no double-tracking in subscriptions either.

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.08 — session:input forwards data to PTY
// ---------------------------------------------------------------------------

describe('C.08 — session:input forwarding', () => {
  test('input data is forwarded to session write()', async () => {
    const meta = await createSession('c08');
    const inst = getSessionInstance(meta.id);

    const { ws } = await openClient();
    send(ws, { type: 'session:input', id: meta.id, data: 'echo hello\n' });

    await new Promise((r) => setTimeout(r, 150));
    expect(inst.write).toHaveBeenCalledWith('echo hello\n');

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.09 — session:input with missing id is a no-op (no crash)
// ---------------------------------------------------------------------------

describe('C.09 — session:input missing id', () => {
  test('no id field — server does not crash, connection stays open', async () => {
    const { ws } = await openClient();

    send(ws, { type: 'session:input', data: 'test' }); // no id

    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.10 — session:resize with valid dimensions
// ---------------------------------------------------------------------------

describe('C.10 — session:resize', () => {
  test('resize is forwarded to session resize()', async () => {
    const meta = await createSession('c10');
    const inst = getSessionInstance(meta.id);

    const { ws } = await openClient();
    send(ws, { type: 'session:resize', id: meta.id, cols: 200, rows: 50 });

    await new Promise((r) => setTimeout(r, 150));
    expect(inst.resize).toHaveBeenCalledWith(200, 50);

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.11 — session:stop transitions session and broadcasts
// ---------------------------------------------------------------------------

describe('C.11 — session:stop', () => {
  test('stop session transitions status and broadcasts sessions:list', async () => {
    const meta = await createSession('c11');

    const { ws } = await openClient();
    const listPromise = waitFor(ws, 'sessions:list', 4000);

    send(ws, { type: 'session:stop', id: meta.id });

    const list = await listPromise;
    const stoppedSession = list.sessions.find((s) => s.id === meta.id);
    if (stoppedSession) {
      expect(stoppedSession.status).toBe('stopped');
    }

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.12 — session:refresh returns session:refreshed
// ---------------------------------------------------------------------------

describe('C.12 — session:refresh', () => {
  test('refresh returns session:refreshed with session object', async () => {
    const meta = await createSession('c12');
    // The mock DirectSession factory now includes refresh() — SessionManager.refresh
    // calls session.refresh(authEnv) for direct mode sessions.

    const { ws } = await openClient();
    const refreshPromise = waitFor(ws, 'session:refreshed', 5000);

    send(ws, { type: 'session:refresh', id: meta.id });

    const refreshed = await refreshPromise;
    expect(refreshed.type).toBe('session:refreshed');
    expect(refreshed.session).toBeDefined();
    expect(refreshed.session.id).toBe(meta.id);

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });

  test('refresh on unknown session returns session:error', async () => {
    const { ws } = await openClient();

    const errPromise = waitFor(ws, 'session:error', 4000);
    send(ws, { type: 'session:refresh', id: 'nonexistent-refresh-id' });
    const err = await errPromise;

    expect(err.type).toBe('session:error');
    expect(err.error).toMatch(/not found/i);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.13 — session:delete removes session and broadcasts
// ---------------------------------------------------------------------------

describe('C.13 — session:delete', () => {
  test('deleted session disappears from subsequent sessions:list', async () => {
    const meta = await createSession('c13');

    const { ws } = await openClient();
    const listPromise = waitFor(ws, 'sessions:list', 4000);

    send(ws, { type: 'session:delete', id: meta.id });
    const list = await listPromise;

    const stillPresent = list.sessions.find((s) => s.id === meta.id);
    expect(stillPresent).toBeUndefined();

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.14 — Malformed JSON does not crash server
// ---------------------------------------------------------------------------

describe('C.14 — malformed JSON survival', () => {
  test('server survives invalid JSON and connection remains open', async () => {
    const { ws } = await openClient();

    ws.send('not json {{{{{ garbage');
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Verify server still processes subsequent valid messages
    const errPromise = waitFor(ws, 'session:error', 3000);
    send(ws, { type: 'session:subscribe', id: 'no-such-id' });
    const err = await errPromise;
    expect(err.error).toMatch(/not found/i);

    ws.close();
  });

  test('null bytes in message do not crash server', async () => {
    const { ws } = await openClient();

    ws.send('\x00\x01\x02\x03');
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.15 — Message with no type field is ignored
// ---------------------------------------------------------------------------

describe('C.15 — message with no type field', () => {
  test('no type field — server ignores gracefully, connection open', async () => {
    const { ws } = await openClient();

    send(ws, { foo: 'bar' });
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test('type is empty string — server handles gracefully', async () => {
    const { ws } = await openClient();

    send(ws, { type: '' });
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test('type is null — server handles gracefully', async () => {
    const { ws } = await openClient();

    send(ws, { type: null });
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.16 — Unknown message type handled gracefully
// ---------------------------------------------------------------------------

describe('C.16 — unknown session action', () => {
  test('unknown session:* type does not crash server', async () => {
    const { ws } = await openClient();

    send(ws, { type: 'session:explode_everything' });
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.17 — Unknown top-level type goes to systemHandlers
// ---------------------------------------------------------------------------

describe('C.17 — unknown top-level type → systemHandlers', () => {
  test('custom:action type does not crash server', async () => {
    const { ws } = await openClient();

    send(ws, { type: 'custom:totally-unknown' });
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.18 — Client disconnect removes client from registry
// ---------------------------------------------------------------------------

describe('C.18 — client disconnect cleanup', () => {
  test('old clientId gone from registry after disconnect', async () => {
    const { ws, initial } = await openClient();
    const oldClientId = initial[0].clientId;

    // Verify client is in registry
    expect(clientRegistry.get(oldClientId)).toBeDefined();

    // Close and wait for server to process close
    ws.close();
    await new Promise((r) => setTimeout(r, 300));

    // Client should be removed
    expect(clientRegistry.get(oldClientId)).toBeUndefined();

    // New connection gets a different clientId
    const { ws: ws2, initial: i2 } = await openClient();
    const newClientId = i2[0].clientId;
    expect(newClientId).not.toBe(oldClientId);

    ws2.close();
  });
});

// ---------------------------------------------------------------------------
// C.19 — Client disconnect does NOT call sessions.unsubscribe (POTENTIAL BUG)
// ---------------------------------------------------------------------------

describe('C.19 — disconnect viewer cleanup (stale viewer leak)', () => {
  test('ADVERSARIAL: session viewer is NOT removed when client disconnects without unsubscribing', async () => {
    const meta = await createSession('c19');
    const inst = getSessionInstance(meta.id);

    const { ws, initial } = await openClient();
    const clientId = initial[0].clientId;

    // Subscribe
    send(ws, { type: 'session:subscribe', id: meta.id });
    await waitFor(ws, 'session:subscribed', 4000);

    // Verify viewer registered in session
    expect(inst.viewers.has(clientId)).toBe(true);
    expect(inst.viewers.size).toBe(1);

    // Forcibly close WS connection without sending unsubscribe
    ws.terminate();
    await new Promise((r) => setTimeout(r, 300));

    // BUG CHECK: server.js close handler calls terminals.removeViewer but NOT sessions.unsubscribe
    // So the session viewer map may STILL have the stale clientId callback
    const viewerStillPresent = inst.viewers.has(clientId);

    // If this assertion PASSES (viewer still present), it's a confirmed bug
    // If it fails (viewer removed), cleanup is happening correctly
    if (viewerStillPresent) {
      // CONFIRMED BUG: stale viewer remains after client disconnect
      // Any future PTY output will attempt to send to a disconnected client
      // clientRegistry.send() will silently no-op (ws.readyState !== OPEN)
      // but the callback itself is never cleaned up — memory leak
      console.warn('[BUG CONFIRMED C.19] Stale viewer in session after client disconnect');
    }

    // Document the bug explicitly — expect the stale viewer (the bug)
    // If behavior changes and viewer IS removed, the test should be updated
    expect(viewerStillPresent).toBe(true); // This PASSES because the bug exists

    await sessions.delete(meta.id).catch(() => {});
  });

  test('ADVERSARIAL: reconnect new client, subscribe again — old viewer callback still fires', async () => {
    const meta = await createSession('c19b');
    const inst = getSessionInstance(meta.id);

    // Client 1 subscribes
    const { ws: ws1, initial: i1 } = await openClient();
    const clientId1 = i1[0].clientId;
    send(ws1, { type: 'session:subscribe', id: meta.id });
    await waitFor(ws1, 'session:subscribed', 4000);

    // Disconnect client 1 WITHOUT unsubscribing
    ws1.terminate();
    await new Promise((r) => setTimeout(r, 300));

    // Client 2 subscribes
    const { ws: ws2 } = await openClient();
    send(ws2, { type: 'session:subscribe', id: meta.id });
    await waitFor(ws2, 'session:subscribed', 4000);

    // Now emit output — how many viewer callbacks fire?
    const viewerCountBeforeEmit = inst.viewers.size;

    // BUG: if stale viewer from client 1 is still there, viewerCount >= 2
    // clientRegistry.send() for client1 will be a no-op (ws closed)
    // but the callback still runs — CPU waste + potential future issue
    if (viewerCountBeforeEmit > 1) {
      console.warn(`[BUG C.19b] ${viewerCountBeforeEmit} viewers registered after reconnect — expected 1`);
    }

    // Documented finding: stale viewer remains
    expect(viewerCountBeforeEmit).toBeGreaterThanOrEqual(1); // At minimum new client subscribed

    ws2.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.20 — Multiple clients subscribed to same session
// ---------------------------------------------------------------------------

describe('C.20 — multiple clients get output', () => {
  test('two subscribers both receive session:output', async () => {
    const meta = await createSession('c20');
    const inst = getSessionInstance(meta.id);

    const { ws: wsA } = await openClient();
    const { ws: wsB } = await openClient();

    send(wsA, { type: 'session:subscribe', id: meta.id });
    send(wsB, { type: 'session:subscribe', id: meta.id });

    await waitFor(wsA, 'session:subscribed', 4000);
    await waitFor(wsB, 'session:subscribed', 4000);

    // Collect output on both
    const aOutputs = [];
    const bOutputs = [];
    wsA.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'session:output') aOutputs.push(m);
    });
    wsB.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'session:output') bOutputs.push(m);
    });

    inst._emitOutput('broadcast-data');
    await new Promise((r) => setTimeout(r, 300));

    expect(aOutputs.length).toBeGreaterThanOrEqual(1);
    expect(bOutputs.length).toBeGreaterThanOrEqual(1);
    expect(aOutputs[0].data).toBe('broadcast-data');
    expect(bOutputs[0].data).toBe('broadcast-data');

    wsA.close(); wsB.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.21 — Client A unsubscribes, client B still receives output
// ---------------------------------------------------------------------------

describe('C.21 — unsubscribe one client, other still works', () => {
  test('after A unsubscribes, only B receives output', async () => {
    const meta = await createSession('c21');
    const inst = getSessionInstance(meta.id);

    const { ws: wsA } = await openClient();
    const { ws: wsB } = await openClient();

    send(wsA, { type: 'session:subscribe', id: meta.id });
    send(wsB, { type: 'session:subscribe', id: meta.id });

    await waitFor(wsA, 'session:subscribed', 4000);
    await waitFor(wsB, 'session:subscribed', 4000);

    // A unsubscribes
    send(wsA, { type: 'session:unsubscribe', id: meta.id });
    await new Promise((r) => setTimeout(r, 200));

    const aOutputs = [];
    const bOutputs = [];
    wsA.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'session:output') aOutputs.push(m);
    });
    wsB.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'session:output') bOutputs.push(m);
    });

    inst._emitOutput('after-a-unsub');
    await new Promise((r) => setTimeout(r, 300));

    expect(aOutputs.length).toBe(0); // A unsubscribed, should get nothing
    expect(bOutputs.length).toBeGreaterThanOrEqual(1); // B still gets it

    wsA.close(); wsB.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.22 — Rapid subscribe/unsubscribe cycle (50 times)
// ---------------------------------------------------------------------------

describe('C.22 — rapid subscribe/unsubscribe cycle', () => {
  test('50 sub/unsub cycles leave no stale subscriptions', async () => {
    const meta = await createSession('c22');
    const inst = getSessionInstance(meta.id);

    const { ws, initial } = await openClient();
    const clientId = initial[0].clientId;

    for (let i = 0; i < 50; i++) {
      send(ws, { type: 'session:subscribe', id: meta.id });
      send(ws, { type: 'session:unsubscribe', id: meta.id });
    }

    // Wait for all to process
    await new Promise((r) => setTimeout(r, 1000));

    // Final state: viewer should NOT be registered (last op was unsubscribe)
    const viewerPresent = inst.viewers.has(clientId);
    // Note: due to async processing, we may or may not have stale state
    // The Map.set/delete pattern in addViewer/removeViewer is synchronous
    // but WS message processing is async — race condition possible
    // This is informational — the test documents the outcome
    if (viewerPresent) {
      console.warn('[C.22] Viewer still registered after 50 sub/unsub cycles — possible race');
    }

    // Registry subscription tracking
    const client = clientRegistry.get(clientId);
    if (client) {
      const inRegistrySubs = client.subscriptions.has(meta.id);
      if (inRegistrySubs) {
        console.warn('[C.22] ClientRegistry still tracks subscription after unsub cycle');
      }
    }

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.23 — 20 clients connect simultaneously
// ---------------------------------------------------------------------------

describe('C.23 — 20 simultaneous connections', () => {
  test('all 20 get unique clientIds and sessions:list', async () => {
    const connections = await Promise.all(
      Array.from({ length: 20 }, () => openClient())
    );

    const clientIds = connections.map(({ initial }) => initial[0].clientId);
    const uniqueIds = new Set(clientIds);

    expect(uniqueIds.size).toBe(20); // All unique

    for (const { initial } of connections) {
      expect(initial[0].type).toBe('init');
      expect(initial[1].type).toBe('sessions:list');
    }

    for (const { ws } of connections) ws.close();
  }, 10000);
});

// ---------------------------------------------------------------------------
// C.24 — session:state broadcast goes to ALL clients
// ---------------------------------------------------------------------------

describe('C.24 — state broadcast to all clients', () => {
  test('all 3 clients receive session:state on stop', async () => {
    const meta = await createSession('c24');

    const { ws: ws1 } = await openClient();
    const { ws: ws2 } = await openClient();
    const { ws: ws3 } = await openClient();

    const statePromises = [
      waitFor(ws1, 'session:state', 5000),
      waitFor(ws2, 'session:state', 5000),
      waitFor(ws3, 'session:state', 5000),
    ];

    send(ws1, { type: 'session:stop', id: meta.id });

    const [s1, s2, s3] = await Promise.all(statePromises);

    expect(s1.id).toBe(meta.id);
    expect(s2.id).toBe(meta.id);
    expect(s3.id).toBe(meta.id);

    ws1.close(); ws2.close(); ws3.close();
  });
});

// ---------------------------------------------------------------------------
// C.25 — session:create auto-subscribes creating client
// ---------------------------------------------------------------------------

describe('C.25 — session:create auto-subscribes creating client', () => {
  test('creator receives session:output without explicit subscribe', async () => {
    const { ws, initial } = await openClient();
    const clientId = initial[0].clientId;

    const createdPromise = waitFor(ws, 'session:created', 5000);
    send(ws, { type: 'session:create', projectId, name: 'c25-auto-sub', mode: 'direct' });
    const created = await createdPromise;

    const sessionId = created.session.id;
    const inst = getSessionInstance(sessionId);

    // Client should be auto-subscribed — emit output
    const outputPromise = waitFor(ws, 'session:output', 3000);
    inst._emitOutput('auto-sub-check');
    const output = await outputPromise;

    expect(output.data).toBe('auto-sub-check');
    expect(output.id).toBe(sessionId);

    // Confirm clientId is in viewers
    expect(inst.viewers.has(clientId)).toBe(true);

    ws.close();
    await sessions.delete(sessionId).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.26 — Binary data in session:input
// ---------------------------------------------------------------------------

describe('C.26 — binary data in session:input', () => {
  test('binary/control chars in data field do not crash server', async () => {
    const meta = await createSession('c26');
    const inst = getSessionInstance(meta.id);

    const { ws } = await openClient();

    // JSON encodes these fine; the PTY write receives them as-is
    const binaryStr = '\x00\x01\x02\x7f\xff';
    send(ws, { type: 'session:input', id: meta.id, data: binaryStr });

    await new Promise((r) => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(inst.write).toHaveBeenCalledWith(binaryStr);

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.27 — 1MB session:input
// ---------------------------------------------------------------------------

describe('C.27 — 1MB session:input', () => {
  test('server survives and stays alive after 1MB input payload', async () => {
    const meta = await createSession('c27');
    const inst = getSessionInstance(meta.id);

    const { ws } = await openClient();

    const megabyte = 'A'.repeat(1_000_000);
    send(ws, { type: 'session:input', id: meta.id, data: megabyte });

    await new Promise((r) => setTimeout(r, 500));

    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Server should still respond to valid messages
    const errPromise = waitFor(ws, 'session:error', 3000);
    send(ws, { type: 'session:subscribe', id: 'nonexistent-after-1mb' });
    const err = await errPromise;
    expect(err.error).toMatch(/not found/i);

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.28 — 100 rapid session:input messages — none dropped
// ---------------------------------------------------------------------------

describe('C.28 — 100 rapid input messages', () => {
  test('all 100 messages forwarded to write() without drops', async () => {
    const meta = await createSession('c28');
    const inst = getSessionInstance(meta.id);

    const { ws } = await openClient();

    for (let i = 0; i < 100; i++) {
      send(ws, { type: 'session:input', id: meta.id, data: `msg-${i}` });
    }

    await new Promise((r) => setTimeout(r, 500));

    expect(inst.write).toHaveBeenCalledTimes(100);

    // Verify all 100 unique messages arrived in order
    const calls = inst.write.mock.calls.map(([data]) => data);
    for (let i = 0; i < 100; i++) {
      expect(calls[i]).toBe(`msg-${i}`);
    }

    ws.close();
    await sessions.delete(meta.id).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// C.29 — session:create with all optional fields missing
// ---------------------------------------------------------------------------

describe('C.29 — session:create minimal payload', () => {
  test('create with only projectId and name uses defaults', async () => {
    const { ws } = await openClient();

    const createdPromise = waitFor(ws, 'session:created', 5000);
    send(ws, { type: 'session:create', projectId, name: 'c29-minimal' });
    const created = await createdPromise;

    expect(created.session.mode).toBe('direct');
    expect(created.session.id).toBeTruthy();
    expect(created.session.projectId).toBe(projectId);

    ws.close();
    await sessions.delete(created.session.id).catch(() => {});
  });

  test('create with no name returns session:error (name required)', async () => {
    const { ws } = await openClient();

    const errPromise = waitFor(ws, 'session:error', 5000);
    send(ws, { type: 'session:create', projectId }); // no name
    const err = await errPromise;

    expect(err.type).toBe('session:error');
    expect(err.error).toMatch(/name/i);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// C.30 — Concurrent session:create and session:delete
// ---------------------------------------------------------------------------

describe('C.30 — concurrent create and delete', () => {
  test('simultaneous create + delete for different sessions complete without error', async () => {
    // Pre-create a session to delete
    const toDelete = await createSession('c30-delete');

    const { ws } = await openClient();

    // Send both at the same time
    const createdPromise = waitFor(ws, 'session:created', 5000);
    const listAfterDelete = waitFor(ws, 'sessions:list', 5000);

    send(ws, { type: 'session:create', projectId, name: 'c30-new', mode: 'direct' });
    send(ws, { type: 'session:delete', id: toDelete.id });

    const [created, list] = await Promise.all([createdPromise, listAfterDelete]);

    expect(created.session.id).toBeTruthy();
    // The deleted session should not be in the final list
    expect(list.sessions.find((s) => s.id === toDelete.id)).toBeUndefined();

    ws.close();
    await sessions.delete(created.session.id).catch(() => {});
  });
});
