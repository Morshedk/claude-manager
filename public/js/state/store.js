import { signal, computed } from 'preact/signals';

// ── Connection ────────────────────────────────────────────────────────────────
/** Whether the WebSocket is currently connected */
export const connected = signal(false);

/** 3-state connection status: 'connected' | 'reconnecting' | 'disconnected' */
export const connectionStatus = signal('connected');

/** The clientId assigned by the server on init */
export const clientId = signal(null);

/** Server version string received on init (e.g. '2.02') */
export const serverVersion = signal(null);

/** Server environment received on init: 'PROD' or 'BETA' */
export const serverEnv = signal(null);

// ── Projects ──────────────────────────────────────────────────────────────────
/** Array of project records: { id, name, path, createdAt, settings } */
export const projects = signal([]);

/** Currently selected project ID in the sidebar */
export const selectedProjectId = signal(null);

/** Derived: the full project object for the selected project */
export const selectedProject = computed(() =>
  projects.value.find(p => p.id === selectedProjectId.value) ?? null
);

// ── Sessions ──────────────────────────────────────────────────────────────────
/** Array of session records: { id, projectId, state, type, ... } */
export const sessions = signal([]);

/** Explicitly selected session ID (in list/card context) */
export const selectedSessionId = signal(null);

/** Derived: all sessions belonging to the currently selected project */
export const projectSessions = computed(() => {
  const pid = selectedProjectId.value;
  if (!pid) return [];
  return sessions.value.filter(s => s.projectId === pid);
});

/** Session ID currently attached/viewed in the terminal overlay */
export const attachedSessionId = signal(null);

/** Derived: the full session object for the attached session */
export const attachedSession = computed(() =>
  sessions.value.find(s => s.id === attachedSessionId.value) ?? null
);

// ── Settings ──────────────────────────────────────────────────────────────────
/** App-level settings object */
export const settings = signal({});

// ── Vitals (system metrics from watchdog) ────────────────────────────────────
/** System vitals: { cpuPct, memUsedMb, memTotalMb, memPct, diskPct, uptimeS, timestamp } */
export const vitals = signal(null);

// ── Todos ─────────────────────────────────────────────────────────────────────
/** Map of projectId → { items: TodoItem[], loading: boolean } */
export const todos = signal({});

// ── UI State ──────────────────────────────────────────────────────────────────
/** Whether the project sidebar is visible */
export const sidebarVisible = signal(true);

/** Whether the session overlay is in split-view mode (default: true; persisted in localStorage) */
function readSplitView() {
  try {
    const v = localStorage.getItem('splitView');
    return v === null || v === 'true';
  } catch { return true; }
}
export const splitView = signal(readSplitView());

/** Split position as a percentage (0-100) for the split boundary (default: 50) */
function readSplitPosition() {
  try {
    const v = localStorage.getItem('splitPosition');
    if (v !== null) {
      const n = parseFloat(v);
      if (!isNaN(n)) return n;
    }
  } catch {}
  return 50;
}
export const splitPosition = signal(readSplitPosition());

/** Whether the new session modal is open */
export const newSessionModalOpen = signal(false);

/** Whether the settings modal is open */
export const settingsModalOpen = signal(false);

/** Whether the new project modal is open */
export const newProjectModalOpen = signal(false);

/** Whether the edit project modal is open */
export const editProjectModalOpen = signal(false);

/** The project object being edited (set when editProjectModalOpen opens) */
export const editProjectTarget = signal(null);

/** Whether the edit session modal is open */
export const editSessionModalOpen = signal(false);

/** The session object being edited (set when editSessionModalOpen opens) */
export const editSessionTarget = signal(null);

// ── File split pane ───────────────────────────────────────────────────────────
/** Clamp bounds for split position — shared with FileSplitPane and SessionOverlay */
export const SPLIT_MIN = 20;
export const SPLIT_MAX = 85;

/** File split target: { path, projectPath } when open, null when closed */
export const fileSplitTarget = signal(null);

// ── Toast notifications ───────────────────────────────────────────────────────
/** Array of { id, message, type } toast notifications */
export const toasts = signal([]);

// ── Logs ──────────────────────────────────────────────────────────────────────
/** Circular buffer of structured log entries streamed from server (max 1000) */
export const logEntries = signal([]);

// ── Health ────────────────────────────────────────────────────────────────────
/** Subsystem health from /api/health: { ws, sessions, watchdog, terminals, ... } */
export const healthState = signal(null);

// ── Third space ───────────────────────────────────────────────────────────────
/** Active tab in the third space: 'files' | 'todos' | <terminalId> */
export const thirdSpaceTab = signal('files');

/** File path to navigate to in FileBrowser; consumed and cleared by FileBrowser */
export const fileBrowserTarget = signal(null);
