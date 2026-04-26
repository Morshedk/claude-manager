/**
 * TerminalManager — manages persistent project terminals (not Claude sessions).
 * Each project can have one or more PTY terminals that survive UI refreshes.
 *
 * node-pty is loaded lazily on first use so the module can be imported in
 * test environments without a real PTY (tests inject a mock via _setPty).
 */

import { createRequire } from 'module';
import { log } from '../logger/Logger.js';
import { health } from '../logger/health.js';

const _require = createRequire(import.meta.url);

const MAX_SCROLLBACK = 500000;

let _ptyModule = null;

/** @internal — for tests only */
export function _setPty(mock) {
  _ptyModule = mock;
}

function getPty() {
  if (!_ptyModule) {
    _ptyModule = _require('node-pty');
  }
  return _ptyModule;
}

export class TerminalManager {
  constructor() {
    // Map of id → { pty, scrollback, viewers: Map<clientId, callback>, meta }
    this.terminals = new Map();
  }

  /**
   * Create a new PTY terminal.
   * @param {string} id - unique terminal id
   * @param {{ cwd?: string, cols?: number, rows?: number, projectId?: string }} opts
   * @returns {object} terminal metadata
   */
  create(id, { cwd, cols, rows, projectId } = {}) {
    if (this.terminals.has(id)) {
      throw new Error(`Terminal ${id} already exists`);
    }

    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = getPty().spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd: cwd || process.env.HOME || '/root',
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const terminal = {
      pty: ptyProcess,
      scrollback: '',
      viewers: new Map(),
      meta: {
        id,
        cwd,
        projectId: projectId || null,
        pid: ptyProcess.pid,
        createdAt: new Date().toISOString(),
        alive: true,
      },
    };

    ptyProcess.onData((data) => {
      terminal.scrollback += data;
      if (terminal.scrollback.length > MAX_SCROLLBACK) {
        terminal.scrollback = terminal.scrollback.slice(-MAX_SCROLLBACK);
      }
      for (const [, callback] of terminal.viewers) {
        callback(data);
      }
    });

    ptyProcess.onExit(() => {
      terminal.meta.alive = false;
    });

    this.terminals.set(id, terminal);
    log.info('terminals', 'terminal spawned', { id });
    health.signal('terminals', 'lastSpawn');
    return terminal.meta;
  }

  /**
   * Check if a terminal exists.
   * @param {string} id
   * @returns {boolean}
   */
  exists(id) {
    return this.terminals.has(id);
  }

  /**
   * List metadata copies for all terminals.
   * @returns {object[]}
   */
  list() {
    const result = [];
    for (const [, terminal] of this.terminals) {
      result.push({ ...terminal.meta });
    }
    return result;
  }

  /**
   * List metadata for all terminals belonging to a project.
   * @param {string} projectId
   * @returns {object[]}
   */
  listForProject(projectId) {
    return this.list().filter(t => t.projectId === projectId);
  }

  /**
   * Get the internal terminal record (includes pty reference).
   * @param {string} id
   * @returns {object|undefined}
   */
  get(id) {
    return this.terminals.get(id);
  }

  /**
   * Write input to a terminal's PTY.
   * @param {string} id
   * @param {string} data
   */
  write(id, data) {
    const terminal = this.terminals.get(id);
    if (terminal && terminal.meta.alive) {
      terminal.pty.write(data);
    }
  }

  /**
   * Resize a terminal.
   * @param {string} id
   * @param {number} cols
   * @param {number} rows
   */
  resize(id, cols, rows) {
    const terminal = this.terminals.get(id);
    if (terminal && terminal.meta.alive) {
      try { terminal.pty.resize(cols, rows); } catch { /* ignore */ }
    }
  }

  /**
   * Get accumulated scrollback for a terminal.
   * @param {string} id
   * @returns {string}
   */
  getScrollback(id) {
    const terminal = this.terminals.get(id);
    return terminal ? terminal.scrollback : '';
  }

  /**
   * Add a viewer (client) to receive terminal output via callback.
   * @param {string} id
   * @param {string} clientId
   * @param {function} callback - called with each chunk of PTY output
   */
  addViewer(id, clientId, callback) {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.viewers.set(clientId, callback);
    }
  }

  /**
   * Remove a viewer from a terminal.
   * @param {string} id
   * @param {string} clientId
   */
  removeViewer(id, clientId) {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.viewers.delete(clientId);
    }
  }

  /**
   * Destroy a terminal, killing its PTY.
   * @param {string} id
   */
  destroy(id) {
    const terminal = this.terminals.get(id);
    if (terminal) {
      try { terminal.pty.kill(); } catch { /* already dead */ }
      this.terminals.delete(id);
    }
  }

  /**
   * Alias for destroy — compatible with v2 scaffold naming.
   * @param {string} id
   */
  close(id) {
    this.destroy(id);
  }

  /**
   * Destroy all terminals.
   */
  destroyAll() {
    for (const [id] of this.terminals) {
      this.destroy(id);
    }
  }
}
