// ── Client → Server message types ────────────────────────────────────────────
export const CLIENT = {
  SESSION_CREATE:      'session:create',
  SESSION_SUBSCRIBE:   'session:subscribe',
  SESSION_UNSUBSCRIBE: 'session:unsubscribe',
  SESSION_INPUT:       'session:input',
  SESSION_RESIZE:      'session:resize',
  SESSION_STOP:        'session:stop',
  SESSION_RESTART:     'session:restart',
  SESSION_DELETE:      'session:delete',
  TERMINAL_CREATE:     'terminal:create',
  TERMINAL_INPUT:      'terminal:input',
  TERMINAL_RESIZE:     'terminal:resize',
  TERMINAL_CLOSE:      'terminal:close',
};

// ── Server → Client message types ────────────────────────────────────────────
export const SERVER = {
  INIT:              'init',
  SESSION_CREATED:   'session:created',
  SESSION_STATE:     'session:state',
  SESSION_SUBSCRIBED:'session:subscribed',
  SESSION_OUTPUT:    'session:output',
  SESSION_ERROR:     'session:error',
  SESSIONS_LIST:     'sessions:list',
  TERMINAL_CREATED:  'terminal:created',
  TERMINAL_OUTPUT:   'terminal:output',
  TERMINAL_CLOSED:   'terminal:closed',
  TERMINAL_ERROR:    'terminal:error',
  TODOS_UPDATED:     'todos:updated',
  WATCHDOG_SUMMARY:  'watchdog:summary',
  WATCHDOG_TICK:     'watchdog:tick',
  SETTINGS_UPDATED:  'settings:updated',
};
