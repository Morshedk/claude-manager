import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { SerializeAddon } from '@xterm/addon-serialize';
import { STATES, assertTransition } from './sessionStates.js';

const require = createRequire(import.meta.url);

// @xterm/headless is CJS; load lazily via dynamic import so that:
//   • jest.unstable_mockModule('@xterm/headless') can intercept it in tests.
//   • Node runtime can access the CJS module's .default.Terminal.
let _Terminal = null;
async function getTerminalClass() {
  if (!_Terminal) {
    const mod = await import('@xterm/headless');
    // Jest mock returns { Terminal } (named export).
    // Node CJS interop returns { default: { Terminal } }.
    _Terminal = mod.Terminal ?? mod.default?.Terminal;
  }
  return _Terminal;
}

const SNAPSHOT_INTERVAL_MS = 30_000;

/**
 * DirectSession — manages a Claude Code process spawned directly via node-pty.
 *
 * Key design: a server-side headless xterm instance mirrors all PTY output in
 * real time. When a client subscribes it receives a clean rendered snapshot
 * (no raw byte replay) which eliminates the dot/artifact scrollback bug.
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
    this._headless = null;   // @xterm/headless Terminal instance
    this._serialize = null;  // SerializeAddon instance
    this._snapshotTimer = null;
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

    // Initialise headless xterm (lazy load handles CJS + test mock interop)
    const TerminalClass = await getTerminalClass();
    this._headless = new TerminalClass({ cols: this._cols, rows: this._rows, scrollback: 10000 });
    this._serialize = new SerializeAddon();
    this._headless.loadAddon(this._serialize);

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

    // Start periodic snapshot saves
    this._snapshotTimer = setInterval(() => this._saveSnapshot(), SNAPSHOT_INTERVAL_MS);
  }

  /**
   * Kill the PTY process and save a final snapshot.
   */
  stop() {
    // Cancel the periodic timer first
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }

    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }

    // Save snapshot synchronously-ish (fire and forget — cannot await in stop())
    this._saveSnapshot();

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
   * Resize the PTY and the headless xterm to match the client viewport.
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    if (this.pty) {
      try { this.pty.resize(cols, rows); } catch { /* ignore */ }
    }
    if (this._headless) {
      this._headless.resize(cols, rows);
    }
  }

  /**
   * Get a serialized snapshot of the current terminal state.
   * If the headless xterm is not running (e.g. after server restart), falls
   * back to the last snapshot saved to disk.
   * @returns {string | Promise<string>}
   */
  getSnapshot() {
    if (this._headless && this._serialize) {
      return this._serialize.serialize();
    }
    // Server restart case — load from disk
    return this.store.loadSnapshot(this.meta.id);
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
      // Feed headless xterm (maintains rendered state)
      if (this._headless) {
        this._headless.write(data);
      }

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
      if (this._snapshotTimer) {
        clearInterval(this._snapshotTimer);
        this._snapshotTimer = null;
      }

      this.pty = null;
      this.meta.exitCode = exitCode;
      this.meta.exitedAt = new Date().toISOString();

      // Save final snapshot before transitioning state
      this._saveSnapshot();

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
   * Persist the current headless xterm state to disk.
   * Fire-and-forget (returns a Promise but callers don't need to await).
   * @returns {Promise<void>}
   */
  _saveSnapshot() {
    if (!this._headless || !this._serialize) return Promise.resolve();
    try {
      const data = this._serialize.serialize();
      return this.store.saveSnapshot(this.meta.id, data).catch(() => { /* ignore */ });
    } catch {
      return Promise.resolve();
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
