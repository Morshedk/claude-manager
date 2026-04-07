/**
 * MessageRouter — routes incoming WebSocket messages to the right handler
 * based on the message type prefix.
 *
 * Session messages:  session:*
 * Terminal messages: terminal:*
 * Everything else:   systemHandlers
 */
export class MessageRouter {
  /**
   * @param {{ sessionHandlers, terminalHandlers, systemHandlers }} handlers
   */
  constructor({ sessionHandlers, terminalHandlers, systemHandlers }) {
    this.sessionHandlers = sessionHandlers;
    this.terminalHandlers = terminalHandlers;
    this.systemHandlers = systemHandlers;
  }

  /**
   * Route an incoming message to the correct handler.
   * @param {string} clientId
   * @param {{ type: string, [key: string]: any }} message
   * @param {import('./clientRegistry.js').clientRegistry} registry
   */
  route(clientId, message, registry) {
    const { type } = message;

    if (!type) {
      console.warn('[MessageRouter] received message with no type from:', clientId);
      return;
    }

    if (type.startsWith('session:')) {
      this._routeSession(clientId, message, registry);
    } else if (type.startsWith('terminal:')) {
      this._routeTerminal(clientId, message, registry);
    } else {
      this.systemHandlers.handle(clientId, message, registry);
    }
  }

  _routeSession(clientId, message, registry) {
    const action = message.type.slice('session:'.length); // e.g. 'create', 'subscribe'
    const handler = this.sessionHandlers[action];
    if (typeof handler === 'function') {
      handler.call(this.sessionHandlers, clientId, message, registry);
    } else {
      console.warn(`[MessageRouter] unknown session action: "${action}"`);
    }
  }

  _routeTerminal(clientId, message, registry) {
    const action = message.type.slice('terminal:'.length); // e.g. 'create', 'input'
    const handler = this.terminalHandlers[action];
    if (typeof handler === 'function') {
      handler.call(this.terminalHandlers, clientId, message, registry);
    } else {
      console.warn(`[MessageRouter] unknown terminal action: "${action}"`);
    }
  }
}
