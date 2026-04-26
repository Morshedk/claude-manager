// public/js/logger/logger.js

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const BUFFER_SIZE = 500;

const _buffer = [];
let _flushedUpTo = 0;
let _levels = { default: 'warn' };

const _con = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function _shouldLog(level, tag) {
  const configured = _levels[tag] ?? _levels.default ?? 'warn';
  return LEVELS[level] <= LEVELS[configured];
}

function _writeEntry(level, tag, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    tag,
    msg,
    ...(data !== undefined ? { data } : {}),
  };
  if (_buffer.length >= BUFFER_SIZE) _buffer.shift();
  _buffer.push(entry);
  return entry;
}

function _dispatch(level, tag, msg, data) {
  if (!_shouldLog(level, tag)) return;
  const entry = _writeEntry(level, tag, msg, data);
  const line = `[${tag}] ${msg}`;
  if (level === 'error') _con.error(line, data ?? '');
  else if (level === 'warn') _con.warn(line, data ?? '');
  else if (level === 'debug') _con.debug(line, data ?? '');
  else _con.log(line, data ?? '');
  return entry;
}

export const log = {
  error: (tag, msg, data) => _dispatch('error', tag, msg, data),
  warn:  (tag, msg, data) => _dispatch('warn',  tag, msg, data),
  info:  (tag, msg, data) => _dispatch('info',  tag, msg, data),
  debug: (tag, msg, data) => _dispatch('debug', tag, msg, data),

  setLevels(levels) {
    _levels = levels || { default: 'warn' };
  },

  getBuffer() {
    return [..._buffer];
  },

  getUnflushed() {
    return _buffer.slice(_flushedUpTo);
  },

  markFlushed() {
    _flushedUpTo = _buffer.length;
  },
};

window.onerror = (msg, src, line, col, err) => {
  log.error('app', 'unhandled error', { msg: String(msg), src, line, col, stack: err?.stack });
};
window.onunhandledrejection = (e) => {
  log.error('app', 'unhandled rejection', { reason: String(e.reason) });
};

window.addEventListener('beforeunload', () => {
  const unflushed = log.getUnflushed();
  if (unflushed.length === 0) return;
  try {
    navigator.sendBeacon('/api/logs/client', JSON.stringify({ entries: unflushed }));
  } catch { /* non-fatal */ }
});
