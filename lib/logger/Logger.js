// lib/logger/Logger.js
import fs from 'fs';
import path from 'path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 3;
const MAX_DATA_BYTES = 2048;

function safeSerialize(data) {
  if (data === undefined || data === null) return undefined;
  const seen = new WeakSet();
  try {
    const str = JSON.stringify(data, (key, value) => {
      if (value instanceof Error) return { message: value.message, stack: value.stack };
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    if (str.length > MAX_DATA_BYTES) {
      return { _truncated: true, preview: str.slice(0, MAX_DATA_BYTES) };
    }
    return JSON.parse(str);
  } catch {
    return { _serializeError: true };
  }
}

class Logger {
  constructor() {
    this._settingsStore = null;
    this._logFile = null;
    this._health = null;
    this._logSubscribers = null;
    this._defaultLevel = 'warn';
  }

  init({ settingsStore, logFile, health, logSubscribers }) {
    this._settingsStore = settingsStore;
    this._logFile = logFile;
    this._health = health;
    this._logSubscribers = logSubscribers;
  }

  _getLevel(tag) {
    try {
      const s = this._settingsStore?.getSync?.() || {};
      const levels = s?.logging?.levels || {};
      return levels[tag] ?? levels.default ?? this._defaultLevel;
    } catch {
      return this._defaultLevel;
    }
  }

  _shouldLog(level, tag) {
    const configured = this._getLevel(tag);
    return LEVELS[level] <= LEVELS[configured];
  }

  _write(level, tag, msg, data) {
    try {
      const entry = {
        ts: new Date().toISOString(),
        level,
        tag,
        msg,
        source: 'server',
        ...(data !== undefined ? { data: safeSerialize(data) } : {}),
      };
      const line = JSON.stringify(entry) + '\n';

      if (this._logFile) {
        try {
          this._rotate();
          fs.appendFileSync(this._logFile, line);
        } catch { /* file write failure is non-fatal */ }
      }

      const prefix = `[${tag}] ${level.toUpperCase()}: ${msg}`;
      if (level === 'error') process.stderr.write(prefix + '\n');
      else process.stdout.write(prefix + '\n');

      if (this._health && LEVELS[level] <= LEVELS['info']) {
        this._health.record(tag, level);
      }

      if (this._logSubscribers) {
        this._logSubscribers.broadcast({ type: 'log:entry', entry });
      }
    } catch { /* logger must never throw */ }
  }

  _rotate() {
    if (!this._logFile) return;
    try {
      try {
        const stat = fs.statSync(this._logFile);
        if (stat.size < MAX_FILE_BYTES) return;
      } catch {
        return; // file doesn't exist yet
      }
      // Delete oldest backup if it exists
      const oldest = `${this._logFile}.${MAX_ROTATIONS}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      // Shift: app.log.2 → app.log.3, app.log.1 → app.log.2
      for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
        const from = `${this._logFile}.${i}`;
        const to = `${this._logFile}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      // app.log → app.log.1
      fs.renameSync(this._logFile, `${this._logFile}.1`);
    } catch { /* rotation failure is non-fatal */ }
  }

  error(tag, msg, data) { if (this._shouldLog('error', tag)) this._write('error', tag, msg, data); }
  warn(tag, msg, data)  { if (this._shouldLog('warn',  tag)) this._write('warn',  tag, msg, data); }
  info(tag, msg, data)  { if (this._shouldLog('info',  tag)) this._write('info',  tag, msg, data); }
  debug(tag, msg, data) { if (this._shouldLog('debug', tag)) this._write('debug', tag, msg, data); }
}

export const log = new Logger();
export { safeSerialize };
