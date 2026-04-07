import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { STATES, assertTransition } from './sessionStates.js';

const require = createRequire(import.meta.url);

/**
 * DirectSession -- manages a Claude Code process spawned directly via node-pty.
 *
 * On subscribe, the client receives a session:subscribed signal and then
 * live PTY output. The client calls xterm.reset() on subscribe to start
 * with a clean buffer.
 */
export class DirectSession extends EventEmitter {
  /**
   * @param {object} meta  — { id, projectId, name, command, cwd, claudeSessionId, ... }
   * @param {import('./SessionStore.js').SessionStore} store
   * @param {{ cols?: number, rows?: number }} [opts]
   */
  constructor(meta, store, { cols = 120, rows = 30 } = {}) {
    super();
    this.meta = { ...meta, status: STATES.CREATED };
    this.store = store;
    this.pty = null;
    this.viewers = new Map(); // clientId → callback(data)
    this._cols = cols;
    this._rows = rows;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Spawn the PTY process.
   * @param {object} authEnv — environment variables (from SessionManager._buildAuthEnv)
   * @returns {Promise<void>}
   */
  async start(authEnv = {}) {
    this._setState(STATES.STARTING);

    // Build command + args
    const { command, cwd, claudeSessionId } = this.meta;
    const cmdParts = (command || 'claude').split(/\s+/);
    const binary = cmdParts[0] || 'claude';

    // Determine whether to resume an existing conversation or start fresh
    const args = this._buildArgs(cmdParts, claudeSessionId);

    let ptyProcess;
    try {
      const pty = require('node-pty');
      ptyProcess = pty.spawn(binary, args, {
        name: 'xterm-256color',
        cols: this._cols,
        rows: this._rows,
        cwd: cwd || process.cwd(),
        env: { ...authEnv, TERM: 'xterm-256color' },
      });
    } catch (err) {
      this._setState(STATES.ERROR);
      throw new Error(`Failed to spawn PTY: ${err.message}`);
    }

    this.pty = ptyProcess;
    this.meta.pid = ptyProcess.pid;
    this.meta.startedAt = new Date().toISOString();

    this._wirePty();
  }

  /**
   * Kill the PTY process.
   */
  stop() {
    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }

    if (
      this.meta.status === STATES.RUNNING ||
      this.meta.status === STATES.STARTING
    ) {
      this._setState(STATES.STOPPED);
    }
  }

  /**
   * Send raw input to the PTY.
   * @param {string} data
   */
  write(data) {
    if (this.meta.status !== STATES.RUNNING) return;
    if (!this.pty) return;
    this.pty.write(data);
  }

  /**
   * Resize the PTY to match the client viewport.
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
   * Subscribe a client to live PTY output.
   * @param {string} clientId
   * @param {function(string): void} callback
   */
  addViewer(clientId, callback) {
    this.viewers.set(clientId, callback);
  }

  /**
   * Unsubscribe a client.
   * @param {string} clientId
   */
  removeViewer(clientId) {
    this.viewers.delete(clientId);
  }

  /**
   * Serialize session metadata to a plain object (for persistence).
   * @returns {object}
   */
  toJSON() {
    return { ...this.meta };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Wire PTY data + exit events.
   * Called once after spawn.
   */
  _wirePty() {
    const ptyProcess = this.pty;
    let firstData = true;

    ptyProcess.onData((data) => {
      // Transition to RUNNING on first data chunk
      if (firstData) {
        firstData = false;
        if (this.meta.status === STATES.STARTING) {
          this._setState(STATES.RUNNING);
        }
      }

      // Stream to all connected clients
      for (const [, cb] of this.viewers) {
        try { cb(data); } catch { /* ignore broken viewer */ }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.pty = null;
      this.meta.exitCode = exitCode;
      this.meta.exitedAt = new Date().toISOString();

      if (
        this.meta.status === STATES.RUNNING ||
        this.meta.status === STATES.STARTING
      ) {
        const nextState = exitCode === 0 ? STATES.STOPPED : STATES.ERROR;
        this._setState(nextState);
      }

      this.emit('exit', { id: this.meta.id, exitCode });
    });

    // Transition to RUNNING immediately if PTY spawned successfully (some
    // processes don't emit data right away but are clearly alive)
    // We do this via a short microtask so that _wirePty() completes first.
    Promise.resolve().then(() => {
      if (this.meta.status === STATES.STARTING) {
        this._setState(STATES.RUNNING);
      }
    });
  }

  /**
   * Build the CLI argument list for the spawned process.
   * Preserves --model / --effort flags from the original command.
   * Uses --resume if a Claude session file exists, --session-id otherwise.
   * @param {string[]} cmdParts
   * @param {string} claudeSessionId
   * @returns {string[]}
   */
  _buildArgs(cmdParts, claudeSessionId) {
    const args = [];

    // Pass through any extra flags from the original command (skip binary at [0])
    for (let i = 1; i < cmdParts.length; i++) {
      if (
        (cmdParts[i] === '--model' || cmdParts[i] === '--effort') &&
        cmdParts[i + 1]
      ) {
        args.push(cmdParts[i], cmdParts[i + 1]);
        i++;
      }
    }

    if (claudeSessionId) {
      const hasConversation = this._claudeSessionFileExists(claudeSessionId);
      if (hasConversation) {
        args.push('--resume', claudeSessionId);
      } else {
        args.push('--session-id', claudeSessionId);
      }
    }

    return args;
  }

  /**
   * Check whether Claude has a saved conversation file for this session ID.
   * @param {string} claudeSessionId
   * @returns {boolean}
   */
  _claudeSessionFileExists(claudeSessionId) {
    try {
      const { existsSync } = require('fs');
      const { join } = require('path');
      const cwd = (this.meta.cwd || '').replace(/\/+$/, '');
      const encodedPath = cwd.replace(/\//g, '-');
      const sessionFile = join(
        process.env.HOME || '/home/claude-runner',
        '.claude', 'projects', encodedPath, claudeSessionId + '.jsonl'
      );
      return existsSync(sessionFile);
    } catch {
      return false;
    }
  }

  /**
   * Transition state and emit 'stateChange'.
   * @param {string} newState
   */
  _setState(newState) {
    assertTransition(this.meta.status, newState);
    this.meta.status = newState;
    this.emit('stateChange', { id: this.meta.id, state: newState });
  }
}
