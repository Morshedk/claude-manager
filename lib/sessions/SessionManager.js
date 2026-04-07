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
  constructor(projectStore, settingsStore, { dataDir } = {}) {
    super();
    /** @type {Map<string, DirectSession|TmuxSession>} */
    this.sessions = new Map();
    this.store = new SessionStore(dataDir);
    this.projectStore = projectStore;
    this.settingsStore = settingsStore || null;
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

      // Determine which class to use
      const SessionClass = mode === 'tmux' ? TmuxSession : DirectSession;
      const session = new SessionClass(meta, this.store);
      // Override constructed status with persisted status
      session.meta = { ...session.meta, ...meta };

      this._wireSessionEvents(session);
      this.sessions.set(meta.id, session);

      // Auto-resume direct sessions that were RUNNING or SHELL when server stopped
      const wasLive =
        meta.status === STATES.RUNNING || meta.status === STATES.SHELL;

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
  async create({ projectId, name, command, mode = 'direct', cols = 120, rows = 30, telegram = false } = {}) {
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
    const claudeSessionId = this._discoverClaudeSessionId(project.path) || uuidv4();

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
    const claudeSessionId = this._discoverClaudeSessionId(project.path) || uuidv4();

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

    const session = new TmuxSession(meta, this.store, { cols, rows });
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
   * @returns {Promise<string>} snapshot of current terminal state
   */
  async subscribe(sessionId, clientId, callback) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // IMPORTANT: Get snapshot BEFORE registering the viewer. This ensures no
    // live PTY output leaks to the client before it receives the snapshot.
    // The protocol is: snapshot → subscribed → live output.
    const snapshot = await session.getSnapshot();
    session.addViewer(clientId, callback);
    return snapshot;
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
   * Restart a session.
   * For tmux sessions: delegates to TmuxSession.restart().
   * For direct sessions: stops the PTY and starts fresh with --resume.
   * @param {string} sessionId
   * @param {{ cols?: number, rows?: number }} [opts]
   * @returns {Promise<object>} updated session meta
   */
  async restart(sessionId, { cols, rows } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const authEnv = this._buildAuthEnv();

    if (session.meta.mode === 'tmux') {
      // Build resume command
      const claudeCmd = this._buildResumeCommand(session);
      session.restart(claudeCmd, authEnv, { cols, rows });
    } else {
      // Direct mode: stop current PTY, clear snapshot, start new PTY
      session.stop();
      await this.store.deleteSnapshot(sessionId);
      // Reset to STOPPED so assertTransition allows STARTING
      if (session.meta.status !== STATES.STOPPED && session.meta.status !== STATES.ERROR) {
        session.meta.status = STATES.STOPPED;
      }
      await session.start(authEnv);
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
      session.meta.status === STATES.STARTING ||
      session.meta.status === STATES.SHELL;

    if (isLive) {
      try { await session.stop(); } catch { /* ignore */ }
    }

    this.sessions.delete(sessionId);
    await this.store.remove(sessionId);
    await this.store.deleteSnapshot(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Snapshot / scrollback
  // ---------------------------------------------------------------------------

  /**
   * Get the current snapshot for a session.
   * @param {string} sessionId
   * @returns {Promise<string>}
   */
  async getSnapshot(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return '';
    return await session.getSnapshot();
  }

  /**
   * Alias for getSnapshot — kept for watchdog/v1 compatibility.
   * @param {string} sessionId
   * @returns {Promise<string>}
   */
  async getScrollback(sessionId) {
    return this.getSnapshot(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Force resume (stuck sessions)
  // ---------------------------------------------------------------------------

  /**
   * Force-resume a direct session that is stuck or was lost on server restart.
   * @param {string} sessionId
   * @returns {Promise<object>} updated session meta
   */
  async forceResume(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.meta.mode !== 'direct') throw new Error('Only direct-mode sessions can be force-resumed');

    // Kill existing PTY if any
    if (session.pty) {
      try { session.pty.kill(); } catch { /* ignore */ }
      session.pty = null;
    }

    // Reset state so assertTransition allows STARTING
    if (session.meta.status !== STATES.STOPPED && session.meta.status !== STATES.ERROR) {
      session.meta.status = STATES.STOPPED;
    }

    const authEnv = this._buildAuthEnv();
    await session.start(authEnv);
    await this.store.save(this.sessions);
    return { ...session.meta };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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

    for (let i = 1; i < parts.length; i++) {
      if (
        (parts[i] === '--model' || parts[i] === '--effort' || parts[i] === '--channels') &&
        parts[i + 1]
      ) {
        preserved.push(parts[i], parts[i + 1]);
        i++;
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
    const { command, cwd, claudeSessionId, telegramEnabled } = session.meta;
    const binary = (command || 'claude').split(/\s+/)[0] || 'claude';
    let cmd = this._buildClaudeCommand(command, []);

    if (claudeSessionId) {
      const hasConversation = this._claudeSessionFileExists(cwd, claudeSessionId);
      const flag = hasConversation ? '--resume' : '--session-id';
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
