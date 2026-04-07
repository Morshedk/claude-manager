import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { STATES, assertTransition } from './sessionStates.js';

const require = createRequire(import.meta.url);

/**
 * TmuxSession — runs Claude inside a named tmux session.
 *
 * Key design: on subscribe, we send a `tmux capture-pane` snapshot (rendered
 * ANSI text) instead of replaying raw PTY bytes. This eliminates the dot/artifact
 * bug caused by replaying cursor-movement sequences into xterm.js.
 *
 * State transitions:
 *   CREATED → STARTING → RUNNING → SHELL → STOPPED
 *                                → STOPPED
 *                       → STOPPED
 */
export class TmuxSession extends EventEmitter {
  /**
   * @param {object} meta  — must include: id, cwd, command, claudeSessionId (optional)
   * @param {import('./SessionStore.js').SessionStore} store
   * @param {{ cols?: number, rows?: number }} [opts]
   */
  constructor(meta, store, { cols = 120, rows = 30 } = {}) {
    super();
    this.meta = {
      ...meta,
      status: STATES.CREATED,
      tmuxName: `cm-${meta.id.slice(0, 8)}`,
    };
    this.store = store;
    this.pty = null;
    this.viewers = new Map();   // clientId → callback(data)
    this._cols = cols;
    this._rows = rows;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create the tmux session and spawn Claude inside it.
   * @param {string} claudeCmd  — e.g. "claude --session-id <uuid>"
   * @param {object} authEnv    — environment variables (CLAUDE_CODE_OAUTH_TOKEN, etc.)
   */
  async start(claudeCmd, authEnv = {}) {
    assertTransition(this.meta.status, STATES.STARTING);
    this._setState(STATES.STARTING);

    const tmuxName = JSON.stringify(this.meta.tmuxName);
    const cols = this._cols;
    const rows = this._rows;

    // Build env prefix for tmux new-session -e flags
    const oauthToken = authEnv.CLAUDE_CODE_OAUTH_TOKEN;
    const apiKey = authEnv.ANTHROPIC_API_KEY;
    let tmuxEnvArgs = '';
    let cmdEnvPrefix = '';
    if (oauthToken) {
      tmuxEnvArgs = `-e CLAUDE_CODE_OAUTH_TOKEN=${JSON.stringify(oauthToken)} `;
      cmdEnvPrefix = 'env -u ANTHROPIC_API_KEY ';
    } else if (apiKey) {
      tmuxEnvArgs = `-e ANTHROPIC_API_KEY=${JSON.stringify(apiKey)} `;
    }

    // Wrap command so tmux stays alive as a shell when Claude exits
    const wrappedCmd = `${cmdEnvPrefix}${claudeCmd}; exec bash`;
    const cwd = this.meta.cwd || process.cwd();

    execSync(
      `tmux new-session -d ${tmuxEnvArgs}-s ${tmuxName} -x ${cols} -y ${rows} -c ${JSON.stringify(cwd)} -- bash -c ${JSON.stringify(wrappedCmd)}`,
      { timeout: 5000 }
    );

    // High history limit so capture-pane can reach far back
    try {
      execSync(`tmux set-option -t ${tmuxName} history-limit 50000`, { timeout: 2000 });
      execSync(`tmux set-option -t ${tmuxName} status off`, { timeout: 2000 });
      execSync(`tmux set-option -t ${tmuxName} prefix None`, { timeout: 2000 });
      execSync(`tmux set-option -t ${tmuxName} prefix2 None`, { timeout: 2000 });
    } catch { /* non-fatal */ }

    // Brief wait for tmux to settle
    try { execSync('sleep 0.3', { timeout: 1000 }); } catch { /* ignore */ }

    if (!this._tmuxSessionAlive()) {
      this._setState(STATES.ERROR);
      throw new Error(
        `tmux session "${this.meta.tmuxName}" died immediately — check command: ${claudeCmd}`
      );
    }

    this._attachPty();
    this._setState(STATES.RUNNING);
    await this.store.upsert(this.meta);
  }

  /**
   * Stop the session. Kills the tmux session and PTY attachment.
   */
  stop() {
    // Allow stop from any live state
    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }

    if (this.meta.tmuxName) {
      try {
        execSync(
          `tmux kill-session -t ${JSON.stringify(this.meta.tmuxName)} 2>/dev/null`,
          { timeout: 3000 }
        );
      } catch { /* ignore */ }
    }

    this._setState(STATES.STOPPED);
    this.store.upsert(this.meta).catch(() => {});
  }

  /**
   * Send raw input to the PTY (forwarded into tmux).
   * @param {string} data
   */
  write(data) {
    if (
      this.meta.status !== STATES.RUNNING &&
      this.meta.status !== STATES.SHELL
    ) return;
    if (this.pty) {
      this.pty.write(data);
    }
  }

  /**
   * Resize the PTY and tmux window.
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    if (this.pty) {
      try { this.pty.resize(cols, rows); } catch { /* ignore */ }
    }
  }

  /**
   * THE KEY METHOD — returns rendered screen state via tmux capture-pane.
   *
   * Replaces raw-byte scrollback replay. tmux has already applied all cursor
   * moves, clears, and overwrites. The result is clean ANSI with no artifacts.
   *
   * @returns {string}  ANSI text representing the full terminal history
   */
  getSnapshot() {
    if (!this._tmuxSessionAlive()) return '';
    try {
      const tmuxName = JSON.stringify(this.meta.tmuxName);
      // -p  print to stdout
      // -e  preserve ANSI escape sequences (colors)
      // -J  join wrapped lines
      // -S -  from start of scrollback history
      return execSync(
        `tmux capture-pane -p -e -J -S - -t ${tmuxName}`,
        { timeout: 5000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
    } catch {
      return '';
    }
  }

  /**
   * Register a viewer. Immediately returns the current snapshot via callback,
   * then streams live PTY output to it.
   *
   * @param {string} clientId
   * @param {function(string): void} callback
   */
  addViewer(clientId, callback) {
    this.viewers.set(clientId, callback);

    // Ensure PTY is attached so we receive live output
    if (!this.pty && (
      this.meta.status === STATES.RUNNING ||
      this.meta.status === STATES.SHELL
    )) {
      this._attachPty();
    }

    // NOTE: snapshot is NOT sent here. The subscribe protocol in SessionManager
    // calls getSnapshot() separately and sends it as a 'session:snapshot' message.
    // Sending it here via the viewer callback would cause a duplicate (once as
    // 'session:output', once as 'session:snapshot').
  }

  /**
   * Unregister a viewer.
   * @param {string} clientId
   */
  removeViewer(clientId) {
    this.viewers.delete(clientId);
  }

  /**
   * Restart Claude inside the existing tmux session.
   * For RUNNING/SHELL states: uses `tmux respawn-pane -k` (clean, no send-keys noise).
   *
   * @param {string} claudeCmd
   * @param {object} authEnv
   * @param {{ cols?: number, rows?: number }} [opts]
   */
  restart(claudeCmd, authEnv = {}, { cols, rows } = {}) {
    if (cols) this._cols = cols;
    if (rows) this._rows = rows;

    const canRespawn =
      this.meta.status === STATES.RUNNING ||
      this.meta.status === STATES.SHELL;

    if (canRespawn && this._tmuxSessionAlive()) {
      // Detach our PTY first
      if (this.pty) {
        try { this.pty.kill(); } catch { /* ignore */ }
        this.pty = null;
      }

      const tmuxName = JSON.stringify(this.meta.tmuxName);
      const oauthToken = authEnv.CLAUDE_CODE_OAUTH_TOKEN;
      const apiKey = authEnv.ANTHROPIC_API_KEY;
      let envPrefix = '';
      if (oauthToken) {
        envPrefix = `env -u ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN=${JSON.stringify(oauthToken)} `;
      } else if (apiKey) {
        envPrefix = `env ANTHROPIC_API_KEY=${JSON.stringify(apiKey)} `;
      }

      const wrappedCmd = `${envPrefix}${claudeCmd}; exec bash`;
      execSync(
        `tmux respawn-pane -k -t ${tmuxName} -- bash -c ${JSON.stringify(wrappedCmd)}`,
        { timeout: 5000 }
      );

      this._attachPty();
      // Transition to RUNNING — but only when coming from SHELL
      // (RUNNING → RUNNING is not a valid transition; if already RUNNING, skip)
      if (this.meta.status !== STATES.RUNNING) {
        this._setState(STATES.RUNNING);
      } else {
        this.emit('stateChange', { id: this.meta.id, state: STATES.RUNNING });
      }
      this.store.upsert(this.meta).catch(() => {});
      return;
    }

    // Session is dead — can't respawn, caller should recreate
    throw new Error(
      `Cannot restart session "${this.meta.id}": status=${this.meta.status}, tmux alive=${this._tmuxSessionAlive()}`
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the tmux session named this.meta.tmuxName is alive.
   * @returns {boolean}
   */
  _tmuxSessionAlive() {
    try {
      execSync(
        `tmux has-session -t ${JSON.stringify(this.meta.tmuxName)} 2>/dev/null`,
        { timeout: 2000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns true if a Claude/node process (not just bash/sh) is running in the pane.
   * @returns {boolean}
   */
  _tmuxRunningClaude() {
    try {
      const paneCmd = execSync(
        `tmux list-panes -t ${JSON.stringify(this.meta.tmuxName)} -F '#{pane_current_command}' 2>/dev/null`,
        { encoding: 'utf8', timeout: 2000 }
      ).trim();
      return paneCmd !== 'bash' && paneCmd !== 'sh' && paneCmd !== 'zsh';
    } catch {
      return false;
    }
  }

  /**
   * Spawn a node-pty process attached to the tmux session for live streaming.
   * The PTY is the conduit for both reading output and sending keystrokes.
   */
  _attachPty() {
    if (this.pty) return; // already attached
    if (!this._tmuxSessionAlive()) return;

    // Ensure status bar is off — prevents tmux chrome bleeding into xterm
    try {
      execSync(
        `tmux set-option -t ${JSON.stringify(this.meta.tmuxName)} status off 2>/dev/null || true`,
        { timeout: 2000 }
      );
    } catch { /* ignore */ }

    let ptyProcess;
    try {
      const pty = require('node-pty');
      ptyProcess = pty.spawn(
        'tmux',
        ['attach-session', '-t', this.meta.tmuxName],
        {
          name: 'xterm-256color',
          cols: this._cols,
          rows: this._rows,
          cwd: this.meta.cwd || process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color' },
        }
      );
    } catch (e) {
      // PTY spawn failed — session may be dead
      return;
    }

    this.pty = ptyProcess;
    this._wirePty();
  }

  /**
   * Wire data/exit handlers on this.pty.
   */
  _wirePty() {
    if (!this.pty) return;

    this.pty.onData((data) => {
      for (const callback of this.viewers.values()) {
        callback(data);
      }
    });

    this.pty.onExit(() => {
      this.pty = null;

      // PTY detached — check if tmux is still alive
      if (
        this.meta.status === STATES.RUNNING ||
        this.meta.status === STATES.SHELL
      ) {
        if (!this._tmuxSessionAlive()) {
          // tmux died too → session is stopped
          this._setState(STATES.STOPPED);
          this.store.upsert(this.meta).catch(() => {});
        } else if (!this._tmuxRunningClaude()) {
          // tmux alive but Claude exited → shell mode
          this._setState(STATES.SHELL);
          this.store.upsert(this.meta).catch(() => {});
        }
        // If Claude is still running, PTY just detached — stay in current state
      }
    });
  }

  /**
   * Transition to a new state, emit 'stateChange', and persist.
   * @param {string} newState
   */
  _setState(newState) {
    assertTransition(this.meta.status, newState);
    this.meta.status = newState;
    this.emit('stateChange', { id: this.meta.id, state: newState });
  }

  /**
   * Serialize to a plain object (for store persistence).
   * @returns {object}
   */
  toJSON() {
    return { ...this.meta };
  }
}
