import { v4 as uuidv4 } from 'uuid';

// Map of clientId → { ws, subscriptions: Set<string> }
const clients = new Map();

/**
 * Send a JSON message to a WebSocket, checking readyState first.
 */
function sendWs(ws, message) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    console.error('[clientRegistry] sendWs error:', err.message);
  }
}

export const clientRegistry = {
  /**
   * Register a new WebSocket connection. Returns the generated clientId.
   * @param {WebSocket} ws
   * @returns {string} clientId
   */
  add(ws) {
    const clientId = uuidv4();
    clients.set(clientId, { ws, subscriptions: new Set() });
    return clientId;
  },

  /**
   * Remove a client by ID.
   * @param {string} clientId
   */
  remove(clientId) {
    clients.delete(clientId);
  },

  /**
   * Get a client record by ID.
   * @param {string} clientId
   * @returns {{ ws: WebSocket, subscriptions: Set<string> } | undefined}
   */
  get(clientId) {
    return clients.get(clientId);
  },

  /**
   * Iterate over all client records.
   * @returns {IterableIterator<[string, { ws: WebSocket, subscriptions: Set<string> }]>}
   */
  getAll() {
    return clients.entries();
  },

  /**
   * Broadcast a message to all connected clients.
   * @param {object} message
   */
  broadcast(message) {
    for (const [, client] of clients) {
      sendWs(client.ws, message);
    }
  },

  /**
   * Send a message to a single client by ID.
   * @param {string} clientId
   * @param {object} message
   */
  send(clientId, message) {
    const client = clients.get(clientId);
    if (!client) return;
    sendWs(client.ws, message);
  },

  /**
   * Send a message to all clients subscribed to a given session.
   * @param {string} sessionId
   * @param {object} message
   */
  broadcastToSession(sessionId, message) {
    for (const [, client] of clients) {
      if (client.subscriptions.has(sessionId)) {
        sendWs(client.ws, message);
      }
    }
  },

  /**
   * Subscribe a client to a session channel.
   * @param {string} clientId
   * @param {string} sessionId
   */
  subscribe(clientId, sessionId) {
    const client = clients.get(clientId);
    if (client) client.subscriptions.add(sessionId);
  },

  /**
   * Unsubscribe a client from a session channel.
   * @param {string} clientId
   * @param {string} sessionId
   */
  unsubscribe(clientId, sessionId) {
    const client = clients.get(clientId);
    if (client) client.subscriptions.delete(sessionId);
  },

  // Exposed for testing
  _clients: clients,
  sendWs,
};
