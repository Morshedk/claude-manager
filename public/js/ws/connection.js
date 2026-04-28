/**
 * WebSocket connection manager with auto-reconnect.
 * Dispatches incoming messages to registered handlers by type.
 */

import { log } from '../logger/logger.js';
import { connectionStatus, connected } from '../state/store.js';

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const MAX_ATTEMPTS = 10;

let _ws = null;
let reconnectTimer = null;
let _connectAttempt = 0;
let _consecutiveFailures = 0;
let _backoffDelay = BASE_DELAY;
let _lastDisconnectTs = null;
let _lastDisconnectCode = null;
let _manualReconnect = false;

// Send queue: messages buffered while reconnecting
const _sendQueue = [];

// Page Visibility: reconnect immediately when tab comes to foreground
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && connectionStatus.value === 'reconnecting') {
    log.info('ws', 'visibilitychange: tab foregrounded, reconnecting now');
    reconnectNow();
  }
});

// Map of message type → Set<handler fn>
const handlers = new Map();

function dispatch(message) {
  const set = handlers.get(message.type);
  if (set) {
    for (const fn of [...set]) {
      try { fn(message); } catch (err) { log.error('ws', 'handler error', { err }); }
    }
  }
  // Also dispatch to '*' wildcard listeners
  const wildcard = handlers.get('*');
  if (wildcard) {
    for (const fn of [...wildcard]) {
      try { fn(message); } catch (err) { log.error('ws', 'wildcard handler error', { err }); }
    }
  }
}

export function connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

  _connectAttempt++;
  const attempt = _connectAttempt;
  const trigger = _manualReconnect ? 'manual' : (attempt === 1 ? 'initial' : 'auto');
  const downtime = _lastDisconnectTs ? Date.now() - _lastDisconnectTs : null;
  log.info('ws', 'connect attempt', { attempt, trigger, ...(downtime !== null ? { downtimeMs: downtime, lastCloseCode: _lastDisconnectCode } : {}) });
  _manualReconnect = false;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}`);

  _ws.addEventListener('open', () => {
    const elapsed = _lastDisconnectTs ? Date.now() - _lastDisconnectTs : 0;
    log.info('ws', 'connected', { attempt, elapsedMs: elapsed });
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // Reset backoff state on successful connection
    _consecutiveFailures = 0;
    _backoffDelay = BASE_DELAY;

    // Update connection status signals
    connectionStatus.value = 'connected';
    connected.value = true;

    // Flush send queue before dispatching connection:open so handlers can send too
    if (_sendQueue.length > 0) {
      log.info('ws', 'flushing send queue', { count: _sendQueue.length });
      while (_sendQueue.length > 0) {
        const queued = _sendQueue.shift();
        try { _ws.send(JSON.stringify(queued)); } catch (err) {
          log.warn('ws', 'queue flush send failed', { error: err.message });
        }
      }
    }

    dispatch({ type: 'connection:open' });

    // Flush client log buffer to server
    const unflushed = log.getUnflushed();
    if (unflushed.length > 0) {
      try {
        _ws.send(JSON.stringify({ type: 'log:client', entries: unflushed }));
        log.markFlushed();
      } catch { /* non-fatal */ }
    }

    // Report reconnect diagnostics to the server
    if (attempt > 1) {
      try {
        _ws.send(JSON.stringify({
          type: 'client:reconnect',
          attempt,
          trigger,
          downtimeMs: elapsed,
          lastCloseCode: _lastDisconnectCode,
          userAgent: navigator.userAgent,
        }));
      } catch {}
    }
  });

  _ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      log.warn('ws', 'received non-JSON message');
      return;
    }
    dispatch(message);
  });

  _ws.addEventListener('close', (event) => {
    _lastDisconnectTs = Date.now();
    _lastDisconnectCode = event.code;
    _consecutiveFailures++;

    if (_consecutiveFailures >= MAX_ATTEMPTS) {
      // Retry budget exhausted — move to permanently disconnected state
      log.warn('ws', 'max reconnect attempts reached, giving up', { attempts: _consecutiveFailures });
      connectionStatus.value = 'disconnected';
      connected.value = false;
      dispatch({ type: 'connection:close' });
      return;
    }

    // Apply jitter: ±20% of current delay
    const jitter = _backoffDelay * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.round(Math.min(_backoffDelay + jitter, MAX_DELAY));
    log.info('ws', 'disconnected', { code: event.code, reason: event.reason || 'none', reconnectInMs: delay, attempt: _consecutiveFailures });
    log.warn('ws', 'reconnect scheduled', { attempt: _connectAttempt + 1, delayMs: delay });

    // Escalate backoff for next failure
    _backoffDelay = Math.min(_backoffDelay * 2, MAX_DELAY);

    // Transition to reconnecting state
    connectionStatus.value = 'reconnecting';
    connected.value = false;

    dispatch({ type: 'connection:close' });
    reconnectTimer = setTimeout(connect, delay);
  });

  _ws.addEventListener('error', (err) => {
    log.warn('ws', 'socket error', { attempt });
    dispatch({ type: 'connection:error', error: err });
  });
}

/**
 * Send a message to the server.
 * While reconnecting, messages are queued and flushed on reconnect.
 * While permanently disconnected, messages are dropped.
 * @param {object} message
 */
export function send(message) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(message));
    return;
  }
  if (connectionStatus.value === 'reconnecting') {
    log.info('ws', 'send queued (reconnecting)', { type: message.type });
    _sendQueue.push(message);
    return;
  }
  log.warn('ws', 'send called but socket not open and not reconnecting — dropped', { type: message.type });
}

/**
 * Register a handler for a message type (or '*' for all messages).
 * @param {string} type
 * @param {function} handler
 */
export function on(type, handler) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(handler);
}

/**
 * Remove a previously registered handler.
 * @param {string} type
 * @param {function} handler
 */
export function off(type, handler) {
  const set = handlers.get(type);
  if (set) set.delete(handler);
}

/**
 * Register a one-time handler that auto-removes after first call.
 * @param {string} type
 * @param {function} handler
 */
export function once(type, handler) {
  const wrapper = (message) => {
    off(type, wrapper);
    try { handler(message); } catch (err) { log.error('ws', 'once handler error', { err }); }
  };
  on(type, wrapper);
}

/**
 * Trigger an immediate reconnect, bypassing the auto-reconnect timer.
 *
 * SAFETY: Do NOT add a URL parameter to this function. The WebSocket URL is
 * derived from `location.protocol` and `location.host` inside `connect()`.
 * Same-origin is a hard invariant — the URL must never come from user input.
 */
export function reconnectNow() {
  // Cancel any pending auto-reconnect so it cannot race this manual call.
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  // If previously gave up (disconnected), reset counters so retry budget is restored
  if (connectionStatus.value === 'disconnected') {
    _consecutiveFailures = 0;
    _backoffDelay = BASE_DELAY;
    connectionStatus.value = 'reconnecting';
  }

  _manualReconnect = true;
  const stateNames = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
  const wsState = _ws ? stateNames[_ws.readyState] || _ws.readyState : 'null';
  log.info('ws', 'reconnectNow called', { wsState });

  if (!_ws) {
    connect();
    return;
  }

  const state = _ws.readyState;
  if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
    log.info('ws', 'reconnectNow: already connected, skipping', { wsState });
    _manualReconnect = false;
    return;
  }
  if (state === WebSocket.CLOSING) {
    log.info('ws', 'reconnectNow: CLOSING — deferring connect to next tick');
    setTimeout(connect, 0);
    return;
  }
  // CLOSED or any other state — connect immediately.
  connect();
}

/**
 * Compatibility object export — allows `import { ws } from './connection.js'`
 * and calling `ws.send(...)`, `ws.on(...)`, etc.
 */
export const ws = { connect, send, on, off, once, reconnectNow };
