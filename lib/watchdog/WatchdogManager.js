import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_STATE_PATH = join(__dirname, '../../data/watchdog-state.json');

/**
 * WatchdogManager — monitors all sessions, detects hangs/crashes,
 * persists watchdog state, broadcasts ticks to connected clients.
 */
export class WatchdogManager {
  /**
   * @param {{ statePath?: string, clientRegistry?: object, sessionManager?: object, detector?: object }} [opts]
   */
  constructor({ statePath = DEFAULT_STATE_PATH, clientRegistry = null, sessionManager = null, detector = null } = {}) {
    this.statePath = statePath;
    this.clientRegistry = clientRegistry;
    this.sessionManager = sessionManager;
    this.detector = detector;
    this._timer = null;
    this._tickInterval = 30_000; // 30 seconds
    this._state = {
      lastTick: null,
      sessions: {},
    };
  }

  /**
   * Start the watchdog tick loop.
   */
  start() {
    // TODO: clear any existing timer, set interval calling this._tick()
    throw new Error('TODO: WatchdogManager.start not implemented');
  }

  /**
   * Stop the watchdog tick loop.
   */
  stop() {
    // TODO: clearInterval(this._timer), this._timer = null
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run a single watchdog tick: scan processes, update state, broadcast.
   * @returns {Promise<void>}
   */
  async _tick() {
    // TODO: call detector.scan(), compare with known sessions,
    // detect hangs (no output for N seconds), update this._state,
    // save state, broadcast watchdog:tick to all clients
    throw new Error('TODO: WatchdogManager._tick not implemented');
  }

  /**
   * Load persisted watchdog state from disk.
   * @returns {Promise<void>}
   */
  async loadState() {
    // TODO: readFile, JSON.parse, merge into this._state
    throw new Error('TODO: WatchdogManager.loadState not implemented');
  }

  /**
   * Save watchdog state to disk.
   * @returns {Promise<void>}
   */
  async saveState() {
    // TODO: JSON.stringify, writeFile
    throw new Error('TODO: WatchdogManager.saveState not implemented');
  }

  /**
   * Get a summary of current watchdog state.
   * @returns {object}
   */
  getSummary() {
    // TODO: return { lastTick, sessionCount, hangCount, errorCount }
    return { ...this._state, lastTick: this._state.lastTick };
  }
}
