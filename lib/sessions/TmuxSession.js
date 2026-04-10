import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { STATES, assertTransition } from './sessionStates.js';
import { stripAnsi } from '../utils/stripAnsi.js';

const require = createRequire(import.meta.url);

/**
 * TmuxSession -- runs Claude inside a named tmux session.
 *
 * On subscribe, the client receives a session:subscribed signal. tmux
 * natural PTY replay on re-attach handles scrollback restoration.
 * The client calls xterm.reset() to start with a clean buffer.
 *
 * State transitions:
 *   CREATED -> STARTING -> RUNNING -> STOPPED
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
    if (this.meta.status !== STATES.RUNNING) return;
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
   * Register a viewer. Streams live PTY output to it.
   *
   * @param {string} clientId
   * @param {function(string): void} callback
   */
  addViewer(clientId, callback) {
    this.viewers.set(clientId, callback);

    // Ensure PTY is attached so we receive live output
    if (!this.pty && this.meta.status === STATES.RUNNING) {
      this._attachPty();
    }
  }

  /**
   * Unregister a viewer.
   * @param {string} clientId
   */
  removeViewer(clientId) {
    this.viewers.delete(clientId);
  }

  /**
   * Refresh the client's connection to this session.
   *
   * Tmux alive: detach PTY, re-attach (tmux natural replay).
   * Tmux dead:  create new tmux session with --resume.
   *
   * @param {string} claudeCmd  — resume command (e.g. "claude --resume <id>")
   * @param {object} authEnv
   * @param {{ cols?: number, rows?: number }} [opts]
   */
  async refresh(claudeCmd, authEnv = {}, { cols, rows } = {}) {
    if (cols) this._cols = cols;
    if (rows) this._rows = rows;

    if (this._tmuxSessionAlive()) {
      // ── Tmux alive path: detach + re-attach ──
      if (this.pty) {
        try { this.pty.kill(); } catch { /* ignore */ }
        this.pty = null;
      }
      this._attachPty();
      // Stay in current state (RUNNING). Emit stateChange so clients know
      // to reset their xterm buffer.
      this.emit('stateChange', { id: this.meta.id, state: this.meta.status });
      return;
    }

    // ── Tmux dead path: recreate tmux session with --resume ──
    // Reset state so start() transition is legal
    if (this.meta.status !== STATES.STOPPED && this.meta.status !== STATES.ERROR) {
      this.meta.status = STATES.STOPPED;
    }
    await this.start(claudeCmd, authEnv);
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

    // Capture pty reference so that if refresh() replaces this.pty before
    // this exit fires, we don't null out the new PTY.
    const ptyRef = this.pty;
    this.pty.onExit(() => {
      if (this.pty === ptyRef) this.pty = null;
      if (this.meta.status === STATES.RUNNING) {
        if (!this._tmuxSessionAlive()) {
          this._setState(STATES.STOPPED);
          this.store.upsert(this.meta).catch(() => {});
        }
        // If tmux alive, PTY just detached — stay RUNNING
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
   * Capture the last N lines from the tmux session via capture-pane, ANSI-stripped.
   * @param {number} [n=20]
   * @returns {string[]}
   */
  getPreviewLines(n = 20) {
    if (!this._tmuxSessionAlive()) return [];
    try {
      const raw = execSync(
        `tmux capture-pane -t ${JSON.stringify(this.meta.tmuxName)} -p -e -S -${n}`,
        { timeout: 2000, encoding: 'utf8' }
      );
      const stripped = stripAnsi(raw);
      const lines = stripped.split(/\r?\n/).filter(l => l.trim().length > 0);
      return lines.slice(-n);
    } catch {
      return [];
    }
  }

  /**
   * Serialize to a plain object (for store persistence).
   * @returns {object}
   */
  toJSON() {
    return { ...this.meta };
  }
}
