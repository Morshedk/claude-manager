/**
 * Resolve the Telegram channelId for lifecycle logging.
 * Checks in order:
 * 1. session.channelId — forward-looking: no session today has this field, but the
 *    session-meta shape may gain per-chat routing in a future release (see lib/api/routes.js
 *    access.allowFrom). This branch requires no change to lifecycle logging when that lands.
 * 2. settingsStore.telegramChatId — app-wide Telegram chat id, used when session.telegramEnabled.
 * 3. null — no channel available.
 *
 * @param {object} session - Session meta object
 * @param {object|null} settingsStore - SettingsStore instance (async .get(key))
 * @returns {Promise<string|null>}
 */
async function resolveChannelId(session, settingsStore) {
  // Branch 1: future per-session channelId field (no sessions have this today)
  if (session.channelId) return session.channelId;
  // Branch 2: app-wide Telegram chat id when telegram is enabled on the session
  if (session.telegramEnabled === true && settingsStore) {
    try {
      const id = await settingsStore.get('telegramChatId');
      if (id) return id;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * SessionHandlers — handles all session:* WebSocket messages.
 * Instantiated with a SessionManager and clientRegistry; methods are called
 * by MessageRouter with (clientId, message, registry).
 */
export class SessionHandlers {
  /**
   * @param {import('../../sessions/SessionManager.js').SessionManager} sessionManager
   * @param {import('../clientRegistry.js').clientRegistry} registry
   * @param {{ watchdogManager?: object, settingsStore?: object }} [opts]
   */
  constructor(sessionManager, registry, { watchdogManager = null, settingsStore = null } = {}) {
    this.sessions = sessionManager;
    this.registry = registry;
    this.watchdogManager = watchdogManager;
    this.settingsStore = settingsStore;
    // Dedup window: key = `${clientId}:${projectId}:${name}`, value = timestamp
    this._recentCreates = new Map();

    // Forward session state changes to all connected clients
    sessionManager.on('sessionStateChange', ({ id, state, previousState }) => {
      registry.broadcast({ type: 'session:state', id, state, previousState });
    });

    // Broadcast updated sessions list when lastLine changes (debounced in SessionManager)
    sessionManager.on('lastLineChange', () => {
      this._broadcastSessionsList();
    });

    // When watchdog generates a summary with cardLabel, broadcast updated sessions list
    if (watchdogManager) {
      watchdogManager.on('summary', () => {
        this._broadcastSessionsList();
      });
    }

    // Start 20-second preview refresh interval
    sessionManager.startPreviewInterval(settingsStore, () => {
      this._broadcastSessionsList();
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
      // Resize PTY to client dimensions BEFORE capturing scrollback.
      // Scrollback is captured at the current PTY column count; if we resize
      // after, scrollback is captured at the old width and renders with wrong
      // line wrapping in the client's terminal.
      if (msg.cols && msg.rows) {
        this.sessions.resize(id, msg.cols, msg.rows);
      }

      // Register viewer — now captures scrollback at the client's PTY dimensions.
      const scrollback = await this.sessions.subscribe(id, clientId, (data) => {
        this.registry.send(clientId, { type: 'session:output', id, data });
      });

      // Track subscription in registry so broadcastToSession works
      this.registry.subscribe(clientId, id);

      // Signal client that subscription is ready; live output follows.
      // Send scrollback AFTER session:subscribed so the client's xterm.reset()
      // fires first (clearing stale state), then the buffer fills the terminal.
      this.registry.send(clientId, { type: 'session:subscribed', id });
      if (scrollback) {
        this.registry.send(clientId, { type: 'session:output', id, data: scrollback });
      }
      this.sessions.sessionLogManager?.injectEvent(id, 'CLIENT:CONNECT', `clientId=${clientId}`);
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
    const name = (msg.name || '').trim();
    if (!name) {
      this.registry.send(clientId, { type: 'session:error', error: 'Session name is required' });
      return;
    }

    // Server-side dedup: reject duplicate create from same client within 2s
    const dedupKey = `${clientId}:${msg.projectId}:${name}`;
    const now = Date.now();
    const lastCreate = this._recentCreates.get(dedupKey);
    if (lastCreate && now - lastCreate < 2000) {
      return; // Silent drop — duplicate within window
    }
    this._recentCreates.set(dedupKey, now);
    // Prune stale entries to avoid unbounded growth
    if (this._recentCreates.size > 200) {
      const cutoff = now - 2000;
      for (const [k, ts] of this._recentCreates) {
        if (ts < cutoff) this._recentCreates.delete(k);
      }
    }

    try {
      const session = await this.sessions.create({
        projectId: msg.projectId,
        name,
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

      // Log session lifecycle — fire-and-forget (logSessionLifecycle is internally resilient)
      if (this.watchdogManager) {
        const channelId = await resolveChannelId(session, this.settingsStore);
        this.watchdogManager.logSessionLifecycle({ event: 'created', session, channelId });
      }

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
      // Broadcast session:subscribed to every client watching this session.
      // This triggers xterm.reset() on all subscribers so stale buffer is
      // cleared before fresh PTY output starts streaming in.
      this.registry.broadcastToSession(msg.id, { type: 'session:subscribed', id: msg.id });
      this.registry.send(clientId, { type: 'session:refreshed', id: msg.id, session });
    } catch (err) {
      this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
      return;
    }
    this._broadcastSessionsList();
  }

  /**
   * session:update — update session metadata (name, projectId).
   * @param {string} clientId
   * @param {{ type: string, id: string, name?: string, projectId?: string }} msg
   */
  async update(clientId, msg) {
    try {
      const session = await this.sessions.update(msg.id, {
        name: msg.name,
        projectId: msg.projectId,
      });
      this.registry.send(clientId, { type: 'session:updated', id: msg.id, session });
    } catch (err) {
      this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
      return;
    }
    this._broadcastSessionsList();
  }

  /**
   * session:delete — permanently delete a session.
   * Ordered steps (order is critical — see design doc):
   *   1. Capture meta BEFORE delete (meta is gone from Map after step 2)
   *   2. Delete unconditionally (no-op if session already missing — see SessionManager line 395)
   *   3. Log lifecycle if meta was captured (meta-capture failure suppresses only the log)
   *   4. Broadcast updated sessions list
   * @param {string} clientId
   * @param {{ type: string, id: string }} msg
   */
  async delete(clientId, msg) {
    // Step 1: capture meta BEFORE delete — it will be gone from the Map after step 2
    const meta = this.sessions.get(msg.id);

    // Step 2: unconditional delete — safe no-op for unknown ids (SessionManager.delete line 395)
    try {
      await this.sessions.delete(msg.id);
    } catch (err) {
      this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
      return;
    }

    // Step 3: log lifecycle — conditional on meta; meta-capture failure must not prevent delete
    if (meta && this.watchdogManager) {
      const channelId = await resolveChannelId(meta, this.settingsStore);
      this.watchdogManager.logSessionLifecycle({ event: 'deleted', session: meta, channelId });
    }

    // Step 4: broadcast
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
