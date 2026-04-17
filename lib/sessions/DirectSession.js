import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { STATES, assertTransition } from './sessionStates.js';
import { stripAnsi } from '../utils/stripAnsi.js';

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
    this._ptyGen = 0; // generation counter — incremented each time a new PTY is spawned
    this.viewers = new Map(); // clientId → callback(data)
    this._cols = cols;
    this._rows = rows;
    this._lastLineBuffer = ''; // rolling buffer for partial PTY lines
    this._previewBuffer = ''; // ring buffer for card preview (capped at 8KB)
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

    // Increment generation so old PTY exit events are ignored after refresh
    const myGen = ++this._ptyGen;
    this._wirePty(myGen);
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
   * Return the raw PTY scrollback buffer (up to 8 KB) for replay to a new subscriber.
   * @returns {string}
   */
  getScrollback() {
    return this._previewBuffer || '';
  }

  /**
   * Refresh: kill current PTY and re-spawn.
   *
   * Allowed from: RUNNING, STOPPED, ERROR
   * Blocked from: STARTING (race condition — wait for it to finish)
   * Blocked from: CREATED (session was never started — nothing to restart)
   *
   * @param {object} authEnv
   * @returns {Promise<void>}
   */
  async refresh(authEnv = {}) {
    if (this.meta.status === STATES.STARTING) {
      throw new Error(
        `Cannot refresh direct session "${this.meta.id}": already starting — wait for it to finish`
      );
    }

    if (this.meta.status === STATES.CREATED) {
      throw new Error(
        `Cannot refresh direct session "${this.meta.id}": session has never been started`
      );
    }

    // Kill existing PTY if still alive
    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }

    // Normalise to STOPPED so assertTransition allows STOPPED → STARTING
    if (this.meta.status !== STATES.STOPPED && this.meta.status !== STATES.ERROR) {
      this.meta.status = STATES.STOPPED;
    }

    // Re-start (Claude sessions use --resume if file exists; non-Claude restarts fresh)
    await this.start(authEnv);
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
  _wirePty(gen) {
    const ptyProcess = this.pty;
    let firstData = true;

    ptyProcess.onData((data) => {
      // Ignore data from a stale PTY (from before a refresh)
      if (gen !== this._ptyGen) return;

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

      // Append to preview ring buffer (capped at 8KB)
      this._previewBuffer += data;
      if (this._previewBuffer.length > 8192) {
        this._previewBuffer = this._previewBuffer.slice(-8192);
      }

      // Extract last non-blank line for session card preview
      this._updateLastLine(data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      // Ignore exit events from stale PTY processes (from before a refresh).
      // Without this guard, old PTY exit fires AFTER new PTY is already RUNNING
      // and incorrectly transitions the session back to STOPPED/ERROR.
      if (gen !== this._ptyGen) return;

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
      if (gen !== this._ptyGen) return; // stale — a newer PTY already took over
      if (this.meta.status === STATES.STARTING) {
        this._setState(STATES.RUNNING);
      }
    });
  }

  /**
   * Extract the last non-blank line from a PTY data chunk and store it in
   * meta.lastLine. Uses a rolling buffer to handle chunks that split mid-line.
   * Emits 'lastLineChange' if the value changes.
   * @param {string} data — raw PTY chunk
   */
  _updateLastLine(data) {
    // Append to rolling buffer; cap at 1024 bytes to avoid unbounded growth
    this._lastLineBuffer += data;
    if (this._lastLineBuffer.length > 1024) {
      this._lastLineBuffer = this._lastLineBuffer.slice(-1024);
    }

    // Split buffer on newlines to get candidate lines
    const parts = this._lastLineBuffer.split(/\r?\n/);

    // The last element is an incomplete line (no trailing newline yet) — keep it in buffer
    this._lastLineBuffer = parts[parts.length - 1];

    // Process all complete lines (everything except the last incomplete fragment)
    const completeLines = parts.slice(0, -1);

    // Strip ANSI, handle \r (in-place updates), trim whitespace
    let candidate = null;
    for (const raw of completeLines) {
      // Handle carriage return: take only the text after the last \r
      const afterCr = raw.split('\r').pop() || '';
      const stripped = stripAnsi(afterCr).trim();
      if (stripped.length > 0) {
        candidate = stripped;
      }
    }

    // If no complete lines yet, check the buffer fragment for in-place updates (\r)
    if (candidate === null && this._lastLineBuffer.includes('\r')) {
      const afterCr = this._lastLineBuffer.split('\r').pop() || '';
      const stripped = stripAnsi(afterCr).trim();
      if (stripped.length > 0) {
        candidate = stripped;
      }
    }

    if (candidate === null) return; // No non-blank line found in this chunk

    // Truncate to 200 characters
    if (candidate.length > 200) candidate = candidate.slice(0, 200);

    if (candidate !== this.meta.lastLine) {
      this.meta.lastLine = candidate;
      this.emit('lastLineChange', { id: this.meta.id, lastLine: candidate });
    }
  }

  /**
   * Extract the last N lines from the preview ring buffer, ANSI-stripped.
   * @param {number} [n=20]
   * @returns {string[]}
   */
  getPreviewLines(n = 20) {
    const stripped = stripAnsi(this._previewBuffer);
    const lines = stripped.split(/\r?\n/).filter(l => l.trim().length > 0);
    return lines.slice(-n);
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
    // Only pass Claude session flags when spawning the Claude binary.
    // Non-Claude commands (e.g. 'bash') don't accept --session-id / --resume
    // and should receive all their original args verbatim.
    const isClaude = /claude/i.test(cmdParts[0] || '');

    if (!isClaude) {
      // Non-Claude binary: pass all args as-is
      return cmdParts.slice(1);
    }

    // Claude binary: only pass through known flags to avoid forwarding stale
    // or invalid flags on restart.
    const args = [];
    // Flags that take a value argument (flag + next token)
    const VALUE_FLAGS = new Set(['--model', '--effort', '--channels', '--permission-mode', '--mcp-config']);
    // Boolean flags (standalone, no following value)
    const BOOL_FLAGS = new Set(['--dangerously-skip-permissions', '--strict-mcp-config', '--bare',
      '--allow-dangerously-skip-permissions']);
    for (let i = 1; i < cmdParts.length; i++) {
      if (VALUE_FLAGS.has(cmdParts[i]) && cmdParts[i + 1]) {
        args.push(cmdParts[i], cmdParts[i + 1]);
        i++;
      } else if (BOOL_FLAGS.has(cmdParts[i])) {
        args.push(cmdParts[i]);
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
