/**
 * WebSocket connection manager with auto-reconnect.
 * Dispatches incoming messages to registered handlers by type.
 */

const RECONNECT_DELAY = 3000;

let _ws = null;
let reconnectTimer = null;

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

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}`);

  _ws.addEventListener('open', () => {
    console.log('[ws] connected');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    dispatch({ type: 'connection:open' });
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

  _ws.addEventListener('close', () => {
    console.log('[ws] disconnected — reconnecting in', RECONNECT_DELAY, 'ms');
    dispatch({ type: 'connection:close' });
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  });

  _ws.addEventListener('error', (err) => {
    console.error('[ws] error:', err);
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
 * Compatibility object export — allows `import { ws } from './connection.js'`
 * and calling `ws.send(...)`, `ws.on(...)`, etc.
 */
export const ws = { connect, send, on, off, once };
