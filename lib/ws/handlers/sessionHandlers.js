/**
 * SessionHandlers — handles all session:* WebSocket messages.
 * Instantiated with a SessionManager and clientRegistry; methods are called
 * by MessageRouter with (clientId, message, registry).
 */
export class SessionHandlers {
  /**
   * @param {import('../../sessions/SessionManager.js').SessionManager} sessionManager
   * @param {import('../clientRegistry.js').clientRegistry} registry
   */
  constructor(sessionManager, registry) {
    this.sessions = sessionManager;
    this.registry = registry;

    // Forward session state changes to all connected clients
    sessionManager.on('sessionStateChange', ({ id, state, previousState }) => {
      registry.broadcast({ type: 'session:state', id, state, previousState });
    });
  }

  // ---------------------------------------------------------------------------
  // Subscribe / unsubscribe
  // ---------------------------------------------------------------------------

  /**
   * session:subscribe — client wants live output from a session.
   * Protocol order: subscribed -> live output (via viewer callback).
   * @param {string} clientId
   * @param {{ type: string, id: string, cols?: number, rows?: number }} msg
   */
  async subscribe(clientId, msg) {
    const { id } = msg;
    const client = this.registry.get(clientId);
    if (!client) return;

    if (!this.sessions.exists(id)) {
      this.registry.send(clientId, { type: 'session:error', id, error: `Session not found: ${id}` });
      return;
    }

    try {
      // Register viewer — callback streams live PTY output to this client.
      await this.sessions.subscribe(id, clientId, (data) => {
        this.registry.send(clientId, { type: 'session:output', id, data });
      });

      // Track subscription in registry so broadcastToSession works
      this.registry.subscribe(clientId, id);

      // Signal client that subscription is ready; live output follows
      this.registry.send(clientId, { type: 'session:subscribed', id });
    } catch (err) {
      this.registry.send(clientId, { type: 'session:error', id, error: err.message });
    }
  }

  /**
   * session:unsubscribe — client stops listening to a session.
   * @param {string} clientId
   * @param {{ type: string, id: string }} msg
   */
  unsubscribe(clientId, msg) {
    const { id } = msg;
    this.sessions.unsubscribe(id, clientId);
    this.registry.unsubscribe(clientId, id);
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /**
   * session:create — create a new Claude Code session.
   * @param {string} clientId
   * @param {{ type: string, projectId: string, name?: string, command?: string, mode?: string, cols?: number, rows?: number, telegram?: boolean }} msg
   */
  async create(clientId, msg) {
    try {
      const session = await this.sessions.create({
        projectId: msg.projectId,
        name: msg.name || null,
        command: msg.command,
        mode: msg.mode || 'direct',
        cols: msg.cols || 120,
        rows: msg.rows || 30,
        telegram: !!msg.telegram,
      });

      // Auto-subscribe the creating client to the new session's output
      await this.sessions.subscribe(session.id, clientId, (data) => {
        this.registry.send(clientId, { type: 'session:output', id: session.id, data });
      });
      this.registry.subscribe(clientId, session.id);

      this.registry.send(clientId, { type: 'session:created', session });
      this._broadcastSessionsList();
    } catch (err) {
      this.registry.send(clientId, { type: 'session:error', error: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Input / resize (synchronous — no await needed)
  // ---------------------------------------------------------------------------

  /**
   * session:input — send keyboard input to a running session's PTY.
   * @param {string} clientId
   * @param {{ type: string, id: string, data: string }} msg
   */
  input(clientId, msg) {
    this.sessions.write(msg.id, msg.data);
  }

  /**
   * session:resize — resize the terminal for a session.
   * @param {string} clientId
   * @param {{ type: string, id: string, cols: number, rows: number }} msg
   */
  resize(clientId, msg) {
    this.sessions.resize(msg.id, msg.cols, msg.rows);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle mutations
  // ---------------------------------------------------------------------------

  /**
   * session:stop — stop a running session gracefully.
   * @param {string} clientId
   * @param {{ type: string, id: string }} msg
   */
  async stop(clientId, msg) {
    try {
      await this.sessions.stop(msg.id);
    } catch (err) {
      this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
      return;
    }
    this._broadcastSessionsList();
  }

  /**
   * session:refresh — refresh a session's connection.
   * @param {string} clientId
   * @param {{ type: string, id: string, cols?: number, rows?: number }} msg
   */
  async refresh(clientId, msg) {
    try {
      const session = await this.sessions.refresh(msg.id, {
        cols: msg.cols,
        rows: msg.rows,
      });
      this.registry.send(clientId, { type: 'session:refreshed', session });
    } catch (err) {
      this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
      return;
    }
    this._broadcastSessionsList();
  }

  /**
   * session:delete — permanently delete a session.
   * @param {string} clientId
   * @param {{ type: string, id: string }} msg
   */
  async delete(clientId, msg) {
    try {
      await this.sessions.delete(msg.id);
    } catch (err) {
      this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
      return;
    }
    this._broadcastSessionsList();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Broadcast the current sessions list to all connected clients.
   * Called after any lifecycle mutation so every client stays in sync.
   */
  _broadcastSessionsList() {
    const sessions = this.sessions.list();
    this.registry.broadcast({ type: 'sessions:list', sessions });
  }
}
