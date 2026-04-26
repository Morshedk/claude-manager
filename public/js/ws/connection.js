/**
 * WebSocket connection manager with auto-reconnect.
 * Dispatches incoming messages to registered handlers by type.
 */

import { log } from '../logger/logger.js';

const RECONNECT_DELAY = 3000;

let _ws = null;
let reconnectTimer = null;
let _connectAttempt = 0;
let _lastDisconnectTs = null;
let _lastDisconnectCode = null;
let _manualReconnect = false;

// Map of message type → Set<handler fn>
const handlers = new Map();

function dispatch(message) {
  const set = handlers.get(message.type);
  if (set) {
    for (const fn of [...set]) {
      try { fn(message); } catch (err) { console.error('[ws] handler error:', err); }
    }
  }
  // Also dispatch to '*' wildcard listeners
  const wildcard = handlers.get('*');
  if (wildcard) {
    for (const fn of [...wildcard]) {
      try { fn(message); } catch (err) { console.error('[ws] wildcard handler error:', err); }
    }
  }
}

export function connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

  _connectAttempt++;
  const attempt = _connectAttempt;
  const trigger = _manualReconnect ? 'manual' : (attempt === 1 ? 'initial' : 'auto');
  const downtime = _lastDisconnectTs ? Date.now() - _lastDisconnectTs : null;
  console.log(`[ws] connect attempt #${attempt} trigger=${trigger}` +
    (downtime !== null ? ` downtime=${downtime}ms lastClose=${_lastDisconnectCode}` : ''));
  _manualReconnect = false;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}`);

  _ws.addEventListener('open', () => {
    const elapsed = _lastDisconnectTs ? Date.now() - _lastDisconnectTs : 0;
    console.log(`[ws] connected (attempt #${attempt}, reconnect took ${elapsed}ms)`);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
      console.warn('[ws] received non-JSON message');
      return;
    }
    dispatch(message);
  });

  _ws.addEventListener('close', (event) => {
    _lastDisconnectTs = Date.now();
    _lastDisconnectCode = event.code;
    console.log(`[ws] disconnected code=${event.code} reason="${event.reason || 'none'}" — reconnecting in ${RECONNECT_DELAY}ms`);
    dispatch({ type: 'connection:close' });
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  });

  _ws.addEventListener('error', (err) => {
    console.error(`[ws] error (attempt #${attempt}):`, err);
    dispatch({ type: 'connection:error', error: err });
  });
}

/**
 * Send a message to the server.
 * @param {object} message
 */
export function send(message) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) {
    console.warn('[ws] send called but socket not open');
    return;
  }
  _ws.send(JSON.stringify(message));
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
    try { handler(message); } catch (err) { console.error('[ws] once handler error:', err); }
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

  _manualReconnect = true;
  const stateNames = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
  const wsState = _ws ? stateNames[_ws.readyState] || _ws.readyState : 'null';
  console.log(`[ws] reconnectNow called — wsState=${wsState}`);

  if (!_ws) {
    connect();
    return;
  }

  const state = _ws.readyState;
  if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
    console.log(`[ws] reconnectNow: already ${wsState}, skipping`);
    _manualReconnect = false;
    return;
  }
  if (state === WebSocket.CLOSING) {
    console.log('[ws] reconnectNow: CLOSING — deferring connect to next tick');
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
