import { send } from '../ws/connection.js';
import { CLIENT } from '../ws/protocol.js';
import {
  sessions, projects, attachedSessionId,
  selectedProjectId, settings, todos, toasts,
  newSessionModalOpen, settingsModalOpen,
} from './store.js';
import { upsertSession, removeSession } from './sessionState.js';

// ── Data loading ──────────────────────────────────────────────────────────────

/** Fetch all projects from REST API and populate the projects signal. */
export async function loadProjects() {
  try {
    const data = await fetch('/api/projects').then(r => r.json());
    projects.value = Array.isArray(data) ? data : (data.projects || []);
  } catch (err) {
    console.error('[actions] loadProjects failed:', err);
  }
}

/** Fetch all sessions from REST API and populate the sessions signal. */
export async function loadSessions() {
  try {
    const data = await fetch('/api/sessions').then(r => r.json());
    // v2 API returns { managed, detected }; v1 returned an array or { sessions }
    if (Array.isArray(data)) {
      sessions.value = data;
    } else if (Array.isArray(data.managed)) {
      sessions.value = data.managed;
    } else {
      sessions.value = data.sessions || [];
    }
  } catch (err) {
    console.error('[actions] loadSessions failed:', err);
  }
}

/** Fetch settings from REST API and populate the settings signal. */
export async function loadSettings() {
  try {
    const data = await fetch('/api/settings').then(r => r.json());
    settings.value = data || {};
  } catch (err) {
    console.error('[actions] loadSettings failed:', err);
  }
}

/** Save partial settings updates via REST API. */
export async function saveSettings(updates) {
  try {
    const data = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }).then(r => r.json());
    settings.value = data || {};
  } catch (err) {
    console.error('[actions] saveSettings failed:', err);
  }
}

// ── Session actions ───────────────────────────────────────────────────────────

export function createSession(projectId, options = {}) {
  send({ type: CLIENT.SESSION_CREATE, projectId, ...options });
}

export function subscribeToSession(sessionId) {
  send({ type: CLIENT.SESSION_SUBSCRIBE, id: sessionId });
}

export function unsubscribeFromSession(sessionId) {
  send({ type: CLIENT.SESSION_UNSUBSCRIBE, id: sessionId });
}

export function sendSessionInput(sessionId, data) {
  send({ type: CLIENT.SESSION_INPUT, id: sessionId, data });
}

export function resizeSession(sessionId, cols, rows) {
  send({ type: CLIENT.SESSION_RESIZE, id: sessionId, cols, rows });
}

export function stopSession(sessionId) {
  send({ type: CLIENT.SESSION_STOP, id: sessionId });
}

export function restartSession(sessionId) {
  send({ type: CLIENT.SESSION_RESTART, id: sessionId });
}

export function deleteSession(sessionId) {
  send({ type: CLIENT.SESSION_DELETE, id: sessionId });
}

/**
 * Attach to a session: set the attached signal so SessionOverlay renders.
 * TerminalPane handles subscribe/unsubscribe in its own effect — do NOT
 * send a duplicate subscribe here.
 * @param {string} sessionId
 */
export function attachSession(sessionId) {
  attachedSessionId.value = sessionId;
}

/**
 * Detach from the currently attached session: clear state.
 * TerminalPane's cleanup effect handles unsubscribe when it unmounts.
 */
export function detachSession() {
  attachedSessionId.value = null;
}

// ── Project actions ───────────────────────────────────────────────────────────

export function selectProject(projectId) {
  selectedProjectId.value = projectId;
}

// ── Toast notifications ───────────────────────────────────────────────────────

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 * @param {number} duration  milliseconds before auto-dismiss
 */
export function showToast(message, type = 'info', duration = 3000) {
  const id = Date.now();
  toasts.value = [...toasts.value, { id, message, type }];
  setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id);
  }, duration);
}

// ── UI actions ────────────────────────────────────────────────────────────────

export function openNewSessionModal() { newSessionModalOpen.value = true; }
export function closeNewSessionModal() { newSessionModalOpen.value = false; }

export function openSettingsModal() { settingsModalOpen.value = true; }
export function closeSettingsModal() { settingsModalOpen.value = false; }

// ── Incoming message handlers (called by ws/connection.js listeners) ──────────

export function handleSessionCreated(msg) {
  if (msg.session) upsertSession(msg.session);
}

export function handleSessionState(msg) {
  // Support both { sessionId, state } and { id, state } shapes
  const id = msg.sessionId || msg.id;
  if (id) upsertSession({ id, state: msg.state, status: msg.state });
}

export function handleSessionsList(msg) {
  sessions.value = msg.sessions || [];
}

export function handleProjectsList(msg) {
  projects.value = msg.projects || [];
}

export function handleSettingsUpdated(msg) {
  settings.value = msg.settings || {};
}

export function handleTodosUpdated(msg) {
  if (msg.projectId) {
    todos.value = { ...todos.value, [msg.projectId]: msg.todos };
  }
}
