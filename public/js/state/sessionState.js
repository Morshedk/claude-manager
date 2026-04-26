import { on } from '../ws/connection.js';
import { SERVER } from '../ws/protocol.js';
import { sessions, connected, clientId, attachedSessionId, serverVersion, serverEnv, vitals } from './store.js';
import {
  loadProjects,
  loadSessions,
  loadSettings,
  handleSessionCreated,
  handleSessionState,
  handleSessionsList,
  handleSettingsUpdated,
  handleTodosUpdated,
  showToast,
  closeEditSessionModal,
} from './actions.js';

/**
 * Get a session by ID from the current signal value.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getSession(id) {
  return sessions.value.find(s => s.id === id);
}

/**
 * Get all sessions for a project.
 * @param {string} projectId
 * @returns {object[]}
 */
export function getSessionsForProject(projectId) {
  return sessions.value.filter(s => s.projectId === projectId);
}

/**
 * Get the currently attached session object (via attachedSessionId signal).
 * Use the attachedSession computed from store.js for reactive access.
 * @returns {object|undefined}
 */
export function getAttachedSession() {
  return getSession(attachedSessionId.value);
}

/**
 * Upsert a session record into the sessions signal.
 * Replaces if id matches, appends if new.
 * @param {object} session
 */
export function upsertSession(session) {
  const current = sessions.value;
  const idx = current.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    const next = [...current];
    next[idx] = { ...current[idx], ...session };
    sessions.value = next;
  } else {
    sessions.value = [...current, session];
  }
}

/**
 * Remove a session by ID from the sessions signal.
 * @param {string} id
 */
export function removeSession(id) {
  sessions.value = sessions.value.filter(s => s.id !== id);
}

/**
 * Wire up all global WebSocket message handlers.
 * Call once at startup (from main.js) before mounting the app.
 */
export function initMessageHandlers() {
  // On server init: mark connected, store clientId, load initial data + vitals
  on(SERVER.INIT, (msg) => {
    connected.value = true;
    if (msg.clientId) clientId.value = msg.clientId;
    if (msg.serverVersion) serverVersion.value = msg.serverVersion;
    if (msg.serverEnv) serverEnv.value = msg.serverEnv;
    if (msg.vitals) vitals.value = msg.vitals;
    loadProjects();
    loadSessions();
    loadSettings();
  });

  // Connection lifecycle
  on('connection:open',  () => { connected.value = true; });
  on('connection:close', () => { connected.value = false; });

  // Session list refresh (bulk replace)
  on(SERVER.SESSIONS_LIST, handleSessionsList);

  // Individual session lifecycle events
  on(SERVER.SESSION_CREATED, handleSessionCreated);

  on(SERVER.SESSION_STATE, handleSessionState);

  // Settings pushed from server
  on(SERVER.SETTINGS_UPDATED, handleSettingsUpdated);

  // Todo updates pushed from server
  on(SERVER.TODOS_UPDATED, handleTodosUpdated);

  // Watchdog tick — update system vitals
  on(SERVER.WATCHDOG_TICK, (msg) => {
    if (msg.vitals) vitals.value = msg.vitals;
  });

  // Session refreshed — update session state
  on('session:refreshed', (msg) => {
    if (msg.session) upsertSession(msg.session);
  });

  // Terminal errors and session errors → toast
  on(SERVER.SESSION_ERROR, (msg) => {
    showToast(msg.error || 'Session error', 'error');
  });
  on(SERVER.TERMINAL_ERROR, (msg) => {
    showToast(msg.error || 'Terminal error', 'error');
  });

  // session:updated — server confirmed metadata update
  on(SERVER.SESSION_UPDATED, (msg) => {
    if (msg.session) upsertSession(msg.session);
    closeEditSessionModal();
    showToast('Session updated', 'success');
  });

  // session:subscribed and session:output are handled per-terminal in TerminalPane
  // They are NOT stored in global state — handled locally in the component
}
