import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PATH = join(__dirname, '../../data/settings.json');

export const MODEL_IDS = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

// Reverse lookup: full model ID -> short name
export const MODEL_NAMES = Object.fromEntries(
  Object.entries(MODEL_IDS).map(([k, v]) => [v, k])
);

export const DEFAULTS = {
  // UI settings
  theme: 'dark',
  fontSize: 14,
  fontFamily: "'JetBrains Mono', monospace",
  scrollback: 5000,
  bellEnabled: false,
  telegramEnabled: false,
  telegramChatId: null,
  telegramBotToken: null,
  // Session settings (from v1)
  session: {
    defaultModel: 'sonnet',
    extendedThinking: false,
    defaultFlags: '',
    defaultMode: 'tmux',
  },
  // Watchdog settings (from v1)
  watchdog: {
    enabled: true,
    defaultModel: 'sonnet',
    extendedThinking: false,
    defaultFlags: '',
    intervalMinutes: 5,
  },
  // Low-credit fallback (from v1)
  lowCredit: {
    enabled: false,
    active: false,
    defaultModel: 'haiku',
    extendedThinking: false,
    defaultFlags: '',
  },
  // Feature flags (from v1)
  features: {
    todoRewards: true,
  },
  // Session card preview settings
  previewLines: 20,
  // Structured logging levels (per-tag overrides)
  logging: {
    levels: {
      default: 'warn',
      ws: 'warn',
      sessions: 'warn',
      watchdog: 'warn',
      router: 'warn',
      terminals: 'warn',
      todos: 'warn',
      api: 'warn',
      process: 'warn',
      app: 'warn',
    },
  },
};

/**
 * Deep-merge `source` into `target` (in-place).
 * Only merges keys that already exist in `target` (defaults win for shape).
 * Nested plain objects are merged recursively; all other values are overwritten.
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      key in target &&
      typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
      typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
    ) {
      deepMerge(target[key], source[key]);
    } else if (key in target) {
      target[key] = source[key];
    }
  }
}

/**
 * SettingsStore — persists and exposes app-level settings.
 */
export class SettingsStore {
  /**
   * @param {{ filePath?: string }} [opts]
   */
  constructor({ filePath = DEFAULT_PATH } = {}) {
    this.filePath = filePath;
    this._settings = null;
  }

  /**
   * Load settings from disk, merging with defaults.
   * @returns {Promise<object>}
   */
  async load() {
    const settings = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      deepMerge(settings, parsed);
    } catch {
      // File missing or corrupt — use defaults
    }
    this._settings = settings;
    return JSON.parse(JSON.stringify(this._settings));
  }

  /**
   * Ensure settings are loaded (lazy init).
   * @returns {Promise<void>}
   */
  async _ensureLoaded() {
    if (this._settings === null) {
      await this.load();
    }
  }

  /**
   * Get all current settings (load if not yet loaded).
   * @returns {Promise<object>}
   */
  async getAll() {
    await this._ensureLoaded();
    return JSON.parse(JSON.stringify(this._settings));
  }

  /**
   * Get a single top-level section or key.
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(key) {
    await this._ensureLoaded();
    const val = this._settings[key];
    return val !== undefined ? JSON.parse(JSON.stringify(val)) : undefined;
  }

  /**
   * Synchronously get current settings (returns empty object if not yet loaded).
   * For use by Logger and other sync contexts.
   * @returns {object}
   */
  getSync() {
    return this._settings || {};
  }

  /**
   * Update settings (partial update, merged with current).
   * @param {object} updates
   * @returns {Promise<object>} new settings
   */
  async set(updates) {
    await this._ensureLoaded();
    deepMerge(this._settings, updates);
    await this.save();
    return JSON.parse(JSON.stringify(this._settings));
  }

  /**
   * Alias for set() — matches v1 API name.
   * @param {object} updates
   * @returns {Promise<object>} new settings
   */
  async update(updates) {
    return this.set(updates);
  }

  /**
   * Save current settings to disk.
   * @returns {Promise<void>}
   */
  async save() {
    await this._ensureLoaded();
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this._settings, null, 2));
  }

  /**
   * Reset all settings to defaults.
   * @returns {Promise<object>}
   */
  async reset() {
    this._settings = JSON.parse(JSON.stringify(DEFAULTS));
    await this.save();
    return JSON.parse(JSON.stringify(this._settings));
  }

  /**
   * Effective session settings considering low-credit override.
   * @returns {Promise<object>}
   */
  async getEffectiveSessionSettings() {
    await this._ensureLoaded();
    const { lowCredit, session } = this._settings;
    if (lowCredit.enabled && lowCredit.active) {
      return {
        defaultModel: lowCredit.defaultModel,
        extendedThinking: lowCredit.extendedThinking,
        defaultFlags: lowCredit.defaultFlags,
        defaultMode: session.defaultMode,
      };
    }
    return JSON.parse(JSON.stringify(session));
  }

  /**
   * Build a claude CLI command string from effective session settings.
   * @param {object} [overrides]
   * @returns {Promise<string>}
   */
  async buildCommand(overrides = {}) {
    const effective = await this.getEffectiveSessionSettings();
    const model = overrides.model || effective.defaultModel;
    const thinking = overrides.extendedThinking !== undefined
      ? overrides.extendedThinking : effective.extendedThinking;
    const flags = overrides.flags !== undefined
      ? overrides.flags : effective.defaultFlags;

    let cmd = 'claude';
    const modelId = MODEL_IDS[model] || model;
    if (modelId) cmd += ` --model ${modelId}`;
    if (thinking) cmd += ' --effort max';
    if (flags && flags.trim()) cmd += ` ${flags.trim()}`;
    return cmd;
  }

  /**
   * Build a command string for watchdog sessions.
   * @returns {Promise<string>}
   */
  async buildWatchdogCommand() {
    await this._ensureLoaded();
    const { watchdog: w, lowCredit: lc } = this._settings;
    const useLowCredit = lc.enabled && lc.active;
    const model = useLowCredit ? lc.defaultModel : w.defaultModel;
    const thinking = useLowCredit ? lc.extendedThinking : w.extendedThinking;
    const flags = useLowCredit ? lc.defaultFlags : w.defaultFlags;

    let cmd = 'claude';
    const modelId = MODEL_IDS[model] || model;
    if (modelId) cmd += ` --model ${modelId}`;
    if (thinking) cmd += ' --effort max';
    if (flags && flags.trim()) cmd += ` ${flags.trim()}`;
    return cmd;
  }

  /**
   * Check if a feature flag is enabled.
   * @param {string} feature
   * @returns {Promise<boolean>}
   */
  async isFeatureEnabled(feature) {
    await this._ensureLoaded();
    return this._settings.features[feature] !== false;
  }
}
