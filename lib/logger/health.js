// lib/logger/health.js
import fs from 'fs';

const SUBSYSTEMS = ['ws', 'sessions', 'watchdog', 'terminals', 'todos', 'api'];
const ONE_HOUR_MS = 3_600_000;

// Map: tag → array of error timestamps (ms)
const errorTimes = new Map(SUBSYSTEMS.map(s => [s, []]));

// Map: tag → { [signalKey]: ISO string }
const lastSeen = new Map(SUBSYSTEMS.map(s => [s, {}]));

let _healthFile = null;

export const health = {
  init(healthFile) {
    _healthFile = healthFile;
  },

  record(tag, level) {
    const now = Date.now();
    if (level === 'error' || level === 'warn') {
      const times = errorTimes.get(tag);
      if (times) {
        times.push(now);
        const cutoff = now - ONE_HOUR_MS;
        const pruned = times.filter(t => t >= cutoff);
        errorTimes.set(tag, pruned);
      }
    }
    this._flush();
  },

  signal(tag, key) {
    const map = lastSeen.get(tag) || {};
    map[key] = new Date().toISOString();
    lastSeen.set(tag, map);
    this._flush();
  },

  get() {
    const now = Date.now();
    const cutoff = now - ONE_HOUR_MS;
    const result = { updatedAt: new Date().toISOString() };
    for (const sub of SUBSYSTEMS) {
      const times = (errorTimes.get(sub) || []).filter(t => t >= cutoff);
      result[sub] = {
        ...(lastSeen.get(sub) || {}),
        errorCount1h: times.length,
      };
    }
    return result;
  },

  _flush() {
    if (!_healthFile) return;
    try {
      fs.writeFileSync(_healthFile + '.tmp', JSON.stringify(this.get(), null, 2));
      fs.renameSync(_healthFile + '.tmp', _healthFile);
    } catch { /* non-fatal */ }
  },
};
