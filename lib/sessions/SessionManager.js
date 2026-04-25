import { EventEmitter } from 'events';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DirectSession } from './DirectSession.js';
import { TmuxSession } from './TmuxSession.js';
import { SessionStore } from './SessionStore.js';
import { STATES } from './sessionStates.js';

const TELEGRAM_CHANNELS_FLAG = '--channels plugin:telegram@claude-plugins-official';

/**
 * SessionManager — orchestration layer over all active sessions.
 *
 * Responsibilities:
 *  - Create / stop / restart / delete sessions
 *  - Delegate to DirectSession or TmuxSession
 *  - Subscribe clients to session output
 *  - Persist state via SessionStore
 *  - Forward session stateChange events to callers
 */
export class SessionManager extends EventEmitter {
  /**
   * @param {object} projectStore — must have .get(id) returning { id, path, name }
   * @param {object} settingsStore — optional; used for flag injection
   * @param {{ dataDir?: string }} [opts]
   */
  constructor(projectStore, settingsStore, { dataDir, sessionLogManager = null } = {}) {
    super();
    /** @type {Map<string, DirectSession|TmuxSession>} */
    this.sessions = new Map();
    this.store = new SessionStore(dataDir);
    this.projectStore = projectStore;
    this.settingsStore = settingsStore || null;
    this.sessionLogManager = sessionLogManager || null;
    /** @type {Map<string, ReturnType<typeof setTimeout>>} debounce timers for lastLine broadcasts */
    this._lastLineTimers = new Map();
    /** @type {ReturnType<typeof setInterval>|null} preview refresh interval handle */
    this._previewInterval = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load persisted sessions from disk and auto-resume running direct sessions.
   * Should be called once after construction.
   */
  async init() {
    let records;
    try {
      records = await this.store.load();
    } catch {
      records = [];
    }

    for (const meta of records) {
      const mode = meta.mode || (meta.tmuxName ? 'tmux' : 'direct');
      meta.mode = mode;

      // Migrate unknown/legacy statuses (e.g. 'shell' from v1) to 'exited'
      const knownStatuses = Object.values(STATES);
      if (!knownStatuses.includes(meta.status)) {
        meta.status = STATES.STOPPED;
      }

      // Normalize 'starting' to 'stopped' — a session that was starting when
      // the server crashed has no live PTY. Treating it as RUNNING would skip
      // it (wasLive check below only covers RUNNING), leaving it stuck in
      // 'starting' permanently with no recovery path. Normalize to STOPPED so
      // the auto-resume logic below can restart it correctly.
      if (meta.status === STATES.STARTING) {
        meta.status = STATES.STOPPED;
      }

      // Determine which class to use
      const SessionClass = mode === 'tmux' ? TmuxSession : DirectSession;
      const opts = mode === 'tmux' ? { sessionLogManager: this.sessionLogManager } : {};
      const session = new SessionClass(meta, this.store, opts);
      // Override constructed status with persisted status
      session.meta = { ...session.meta, ...meta };

      this._wireSessionEvents(session);
      this.sessions.set(meta.id, session);

      // Auto-resume direct sessions that were RUNNING when server stopped
      const wasLive = meta.status === STATES.RUNNING;

      if (mode === 'direct' && wasLive) {
        try {
          // Reset to STOPPED so assertTransition allows STARTING
          session.meta.status = STATES.STOPPED;
          const authEnv = this._buildAuthEnv();
          await session.start(authEnv);
        } catch {
          session.meta.status = STATES.ERROR;
        }
      } else if (mode === 'tmux' && wasLive) {
        // TmuxSession: try to re-attach PTY — _attachPty is idempotent
        try {
          session._attachPty();
          // _attachPty() returns silently (no throw) when tmux is dead.
          // Check that a PTY was actually created — if not, tmux is gone.
          if (!session.pty) {
            session.meta.status = STATES.STOPPED;
            await this.store.save(this.sessions);
          } else {
            this.sessionLogManager?.injectEvent(
              meta.id, 'SERVER:START',
              `pid=${process.pid}, sessionCount=${records.length}`
            );
          }
        } catch {
          session.meta.status = STATES.ERROR;
        }
      }
    }

    // Persist the updated state map
    await this.store.save(this.sessions).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /**
   * Create a new session.
   * @param {{ projectId: string, name?: string, command?: string, mode?: string, cols?: number, rows?: number, telegram?: boolean }} params
   * @returns {Promise<object>} session meta
   */
  async create({ projectId, name, command, mode = 'tmux', cols = 120, rows = 30, telegram = false } = {}) {
    const project = this.projectStore.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const id = uuidv4();
    const cwd = project.path;

    // Build base command
    let claudeCmd = command || 'claude';
    const baseCmd = this._buildClaudeCommand(claudeCmd, []);

    // Add Telegram flag if requested
    if (telegram && !baseCmd.includes('--channels')) {
      claudeCmd = baseCmd + ` ${TELEGRAM_CHANNELS_FLAG}`;
    } else {
      claudeCmd = baseCmd;
    }

    const authEnv = this._buildAuthEnv();

    if (mode === 'tmux') {
      return await this._createTmux({ id, project, claudeCmd, name, cols, rows, telegram, authEnv });
    } else {
      return await this._createDirect({ id, project, claudeCmd, name, cols, rows, telegram, authEnv });
    }
  }

  async _createDirect({ id, project, claudeCmd, name, cols, rows, telegram, authEnv }) {
    const claudeSessionId = uuidv4(); // Always fresh — never resume on create

    const meta = {
      id,
      projectId: project.id,
      projectName: project.name,
      name: name || null,
      command: claudeCmd,
      cwd: project.path,
      mode: 'direct',
      claudeSessionId,
      tmuxName: null,
      telegramEnabled: !!telegram,
      createdAt: new Date().toISOString(),
    };

    const session = new DirectSession(meta, this.store, { cols, rows });
    this._wireSessionEvents(session);
    this.sessions.set(id, session);

    await session.start(authEnv);
    await this.store.save(this.sessions);

    this.emit('sessionCreated', session.meta);
    return { ...session.meta };
  }

  async _createTmux({ id, project, claudeCmd, name, cols, rows, telegram, authEnv }) {
    const claudeSessionId = uuidv4(); // Always fresh — never resume on create

    // Inject session ID into command if not already there
    let fullCmd = claudeCmd;
    if (!fullCmd.includes('--resume') && !fullCmd.includes('--session-id')) {
      fullCmd += ` --session-id ${claudeSessionId}`;
    }

    const meta = {
      id,
      projectId: project.id,
      projectName: project.name,
      name: name || null,
      command: claudeCmd,
      cwd: project.path,
      mode: 'tmux',
      claudeSessionId,
      tmuxName: null, // TmuxSession constructor sets this
      telegramEnabled: !!telegram,
      createdAt: new Date().toISOString(),
    };

    const session = new TmuxSession(meta, this.store, { cols, rows, sessionLogManager: this.sessionLogManager });
    this._wireSessionEvents(session);
    this.sessions.set(id, session);

    await session.start(fullCmd, authEnv);
    await this.store.save(this.sessions);

    this.emit('sessionCreated', session.meta);
    return { ...session.meta };
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /**
   * Get session metadata by ID.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    const session = this.sessions.get(id);
    return session ? { ...session.meta } : null;
  }

  /**
   * List all session metas.
   * @returns {object[]}
   */
  list() {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.meta }));
  }

  /**
   * Return a registry snapshot of all managed sessions including live viewer counts.
   * @returns {object[]}
   */
  getSessionRegistry() {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      name: session.meta.name,
      tmuxName: session.meta.tmuxName,
      telegramEnabled: session.meta.telegramEnabled,
      claudeSessionId: session.meta.claudeSessionId,
      status: session.meta.status,
      viewerCount: session.viewers ? session.viewers.size : 0,
    }));
  }

  /**
   * Check if a session exists.
   * @param {string} id
   * @returns {boolean}
   */
  exists(id) {
    return this.sessions.has(id);
  }

  // ---------------------------------------------------------------------------
  // Viewer management
  // ---------------------------------------------------------------------------

  /**
   * Subscribe a client to live output from a session.
   * @param {string} sessionId
   * @param {string} clientId
   * @param {function(string): void} callback
   * @returns {Promise<string>} scrollback buffer (raw PTY, may be empty)
   */
  async subscribe(sessionId, clientId, callback) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.addViewer(clientId, callback);

    // Direct session auto-resume: if PTY is gone and session is stopped/error,
    // restart it so browser page refresh reconnects seamlessly.
    // Note: we call start() directly, not refresh(), because refresh() requires
    // RUNNING state (it's for killing+restarting a live PTY). Here the PTY is
    // already dead, so we just need to re-spawn.
    if (
      session.meta.mode === 'direct' &&
      !session.pty &&
      (session.meta.status === STATES.STOPPED || session.meta.status === STATES.ERROR)
    ) {
      try {
        const authEnv = this._buildAuthEnv();
        // STOPPED/ERROR → STARTING is a legal transition
        await session.start(authEnv);
      } catch (err) {
        // Auto-resume failed — not fatal, session just stays stopped
        console.warn(`[SessionManager] auto-resume failed for ${sessionId}:`, err.message);
      }
    }

    // Return raw PTY scrollback for replay to the subscriber.
    // DirectSession exposes getScrollback(); TmuxSession uses tmux's natural
    // replay via _attachPty() so it returns nothing here.
    return session.getScrollback ? session.getScrollback() : '';
  }

  /**
   * Unsubscribe a client from a session.
   * @param {string} sessionId
   * @param {string} clientId
   */
  unsubscribe(sessionId, clientId) {
    const session = this.sessions.get(sessionId);
    if (session) session.removeViewer(clientId);
  }

  // ---------------------------------------------------------------------------
  // PTY operations
  // ---------------------------------------------------------------------------

  /**
   * Send raw input to a session's PTY.
   * @param {string} sessionId
   * @param {string} data
   */
  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.write(data);
  }

  /**
   * Resize a session's terminal.
   * @param {string} sessionId
   * @param {number} cols
   * @param {number} rows
   */
  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.resize(cols, rows);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle mutations
  // ---------------------------------------------------------------------------

  /**
   * Stop a session gracefully.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async stop(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await session.stop();
    await this.store.save(this.sessions);
  }

  /**
   * Refresh a session's client connection.
   * Tmux: delegates to TmuxSession.refresh().
   * Direct: delegates to DirectSession.refresh().
   * @param {string} sessionId
   * @param {{ cols?: number, rows?: number }} [opts]
   * @returns {Promise<object>} updated session meta
   */
  async refresh(sessionId, { cols, rows } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const authEnv = this._buildAuthEnv();

    if (session.meta.mode === 'tmux') {
      const claudeCmd = this._buildResumeCommand(session);
      await session.refresh(claudeCmd, authEnv, { cols, rows });
    } else {
      await session.refresh(authEnv);
    }

    await this.store.save(this.sessions);
    return { ...session.meta };
  }

  /**
   * Update session metadata (name, projectId, projectName, cwd).
   * Does not affect any running PTY process.
   * @param {string} sessionId
   * @param {{ name?: string, projectId?: string }} updates
   * @returns {Promise<object>} updated session meta
   */
  async update(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (updates.projectId !== undefined) {
      const project = this.projectStore.get(updates.projectId);
      if (!project) throw new Error(`Project not found: ${updates.projectId}`);
      session.meta.projectId = project.id;
      session.meta.projectName = project.name;
      session.meta.cwd = project.path;
    }

    if (updates.name !== undefined) {
      session.meta.name = updates.name || null;
    }

    await this.store.save(this.sessions);
    return { ...session.meta };
  }

  /**
   * Delete a session: stop it if running, remove from map and store.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async delete(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const isLive =
      session.meta.status === STATES.RUNNING ||
      session.meta.status === STATES.STARTING;

    if (isLive) {
      try { await session.stop(); } catch { /* ignore */ }
    }

    // Clear any pending lastLine debounce timer for this session
    const timer = this._lastLineTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this._lastLineTimers.delete(sessionId);
    }

    this.sessions.delete(sessionId);
    await this.store.remove(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Start the 20-second preview refresh interval.
   * Iterates all running/starting sessions, captures last N lines, stores on
   * session.meta.previewLines, then calls broadcastFn to push to clients.
   * @param {import('../settings/SettingsStore.js').SettingsStore} settingsStore
   * @param {function(): void} broadcastFn — called after each sweep to push sessions:list
   */
  startPreviewInterval(settingsStore, broadcastFn) {
    if (this._previewInterval) return; // already running

    const INTERVAL_MS = 20_000;

    this._previewInterval = setInterval(async () => {
      let n = 20;
      try {
        if (settingsStore) {
          const v = await settingsStore.get('previewLines');
          if (typeof v === 'number' && v >= 5 && v <= 50) n = v;
        }
      } catch { /* use default */ }

      let changed = false;
      for (const session of this.sessions.values()) {
        const status = session.meta.status;
        if (status !== STATES.RUNNING && status !== STATES.STARTING) continue;
        try {
          const lines = session.getPreviewLines(n);
          session.meta.previewLines = lines;
          changed = true;
        } catch { /* non-fatal */ }
      }

      if (changed) {
        try { broadcastFn(); } catch { /* non-fatal */ }
      }
    }, INTERVAL_MS);
  }

  /**
   * Stop the preview refresh interval.
   */
  stopPreviewInterval() {
    if (this._previewInterval) {
      clearInterval(this._previewInterval);
      this._previewInterval = null;
    }
  }

  /**
   * Wire stateChange events from a session to this manager,
   * and persist on every state change.
   * @param {DirectSession|TmuxSession} session
   */
  _wireSessionEvents(session) {
    session.on('stateChange', (e) => {
      this.emit('sessionStateChange', e);
      this.store.save(this.sessions).catch(() => {});
    });

    session.on('lastLineChange', ({ id }) => {
      // Debounce: broadcast sessions:list at most once per 500ms per session
      const existing = this._lastLineTimers.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this._lastLineTimers.delete(id);
        this.emit('lastLineChange', { id });
      }, 500);
      this._lastLineTimers.set(id, timer);
    });
  }

  /**
   * Build auth environment object for passing to session spawners.
   * @returns {object}
   */
  _buildAuthEnv() {
    const env = { ...process.env, TERM: 'xterm-256color' };
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      delete env.ANTHROPIC_API_KEY; // avoid auth conflict warning
    }
    return env;
  }

  /**
   * Build a Claude command string, injecting extra flags.
   * Preserves --model and --effort flags from the base command.
   * @param {string} baseCmd
   * @param {string[]} extraFlags
   * @returns {string}
   */
  _buildClaudeCommand(baseCmd, extraFlags = []) {
    const parts = (baseCmd || 'claude').split(/\s+/);
    const binary = parts[0] || 'claude';
    const preserved = [];

    // Flags that take a value argument (flag + next token)
    const VALUE_FLAGS = new Set(['--model', '--effort', '--channels', '--permission-mode', '--mcp-config']);
    // Boolean flags (standalone, no following value)
    const BOOL_FLAGS = new Set(['--dangerously-skip-permissions', '--strict-mcp-config', '--bare',
      '--allow-dangerously-skip-permissions']);

    for (let i = 1; i < parts.length; i++) {
      if (VALUE_FLAGS.has(parts[i]) && parts[i + 1]) {
        preserved.push(parts[i], parts[i + 1]);
        i++;
      } else if (BOOL_FLAGS.has(parts[i])) {
        preserved.push(parts[i]);
      }
    }

    return [binary, ...preserved, ...extraFlags].join(' ');
  }

  /**
   * Build a resume command for restart (picks --resume vs --session-id).
   * @param {DirectSession|TmuxSession} session
   * @returns {string}
   */
  _buildResumeCommand(session) {
    const { command, claudeSessionId, telegramEnabled } = session.meta;
    let cmd = this._buildClaudeCommand(command, []);

    if (claudeSessionId) {
      // For refresh, always use --resume. If no conversation file exists,
      // the tmux dead path still creates a new session — Claude handles
      // --resume gracefully for new session IDs.
      const flag = '--resume';
      cmd += ` ${flag} ${claudeSessionId}`;
    }

    if (telegramEnabled && !cmd.includes('--channels')) {
      cmd += ` ${TELEGRAM_CHANNELS_FLAG}`;
    }

    return cmd;
  }

  /**
   * Discover the most-recently-modified Claude session ID in the project dir,
   * skipping any already claimed by existing sessions.
   * @param {string} cwd
   * @returns {string|null}
   */
  _discoverClaudeSessionId(cwd) {
    const normalizedCwd = (cwd || '').replace(/\/+$/, '');
    const encodedPath = normalizedCwd.replace(/\//g, '-');
    const sessionsDir = join(
      process.env.HOME || '/home/claude-runner',
      '.claude', 'projects', encodedPath
    );
    try {
      if (!existsSync(sessionsDir)) return null;

      const claimed = new Set();
      for (const s of this.sessions.values()) {
        if (s.meta.claudeSessionId) claimed.add(s.meta.claudeSessionId);
      }

      const files = readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ name: f, mtime: statSync(join(sessionsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      for (const file of files) {
        const id = file.name.replace('.jsonl', '');
        if (!claimed.has(id)) return id;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Check whether Claude has a saved conversation file for a given session ID.
   * @param {string} cwd
   * @param {string} claudeSessionId
   * @returns {boolean}
   */
  _claudeSessionFileExists(cwd, claudeSessionId) {
    try {
      const normalizedCwd = (cwd || '').replace(/\/+$/, '');
      const encodedPath = normalizedCwd.replace(/\//g, '-');
      const sessionFile = join(
        process.env.HOME || '/home/claude-runner',
        '.claude', 'projects', encodedPath, claudeSessionId + '.jsonl'
      );
      return existsSync(sessionFile);
    } catch {
      return false;
    }
  }
}
