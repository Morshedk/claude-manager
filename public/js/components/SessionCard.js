import { html } from 'htm/preact';
import { useRef, useEffect } from 'preact/hooks';
import {
  attachSession,
  stopSession,
  refreshSession,
  deleteSession,
  showToast,
  openEditSessionModal,
} from '../state/actions.js';

/**
 * Map session status/state to badge class names.
 * v2 uses `state` field (from sessionStates.js) but also supports `status` for
 * compatibility with v1 shaped objects.
 */
function getBadgeClass(session) {
  const s = session.state || session.status || 'stopped';
  switch (s) {
    case 'running':  return 'badge badge-activity badge-activity-busy';
    case 'starting': return 'badge badge-activity badge-activity-busy';
    case 'stopping': return 'badge badge-activity badge-activity-idle';
    case 'stopped':
    case 'exited':
    case 'created':  return 'badge badge-activity badge-activity-exited';
    case 'error':    return 'badge badge-activity badge-activity-exited';
    default:         return 'badge badge-activity badge-activity-idle';
  }
}

function getBadgeLabel(session) {
  const s = session.state || session.status || 'stopped';
  switch (s) {
    case 'running':  return '\u25B6 running';
    case 'starting': return '\u25B6 starting';
    case 'stopping': return '\u23F8 stopping';
    case 'stopped':
    case 'exited':   return '\u23F9 stopped';
    case 'created':  return '\u25CB created';
    case 'error':    return '\u26A0 error';
    default:         return s;
  }
}

function isActive(session) {
  const s = session.state || session.status || '';
  return s === 'running' || s === 'starting';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Wrench SVG icon (14x14)
const WrenchIcon = () => html`
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>
`;

/**
 * SessionCard — portrait "window" card for a single session.
 * Shows title bar (name + summary), tag row (badges), terminal preview pane,
 * and compact action bar.
 * Props: { session }
 */
export function SessionCard({ session }) {
  const sessionName = session.name || `Session ${session.id.slice(0, 6)}`;
  const active = isActive(session);
  const previewRef = useRef(null);

  // Auto-scroll preview pane to bottom whenever previewLines updates
  useEffect(() => {
    if (previewRef.current) {
      previewRef.current.scrollTop = previewRef.current.scrollHeight;
    }
  }, [session.previewLines]);

  function handleEdit(e) {
    e.stopPropagation();
    openEditSessionModal(session);
  }

  function handleStop(e) {
    e.stopPropagation();
    stopSession(session.id);
    showToast('Stopping session...', 'info');
  }

  function handleRefresh(e) {
    e.stopPropagation();
    refreshSession(session.id);
    showToast('Refreshing session...', 'info');
  }

  function handleDelete(e) {
    e.stopPropagation();
    if (!confirm(`Delete session "${sessionName}"?`)) return;
    deleteSession(session.id);
  }

  // Build preview pane content
  const previewLines = session.previewLines;
  const hasPreview = Array.isArray(previewLines) && previewLines.length > 0;
  const previewText = hasPreview ? previewLines.join('\n') : null;

  // Card summary: cardSummary from watchdog, or placeholder
  const cardSummary = session.cardSummary || null;

  return html`
    <div class="session-card" onClick=${() => attachSession(session.id)}>

      <!-- Title bar: name + summary -->
      <div class="session-card-titlebar">
        <span
          class="session-card-name session-card-name-link"
          onClick=${(e) => { e.stopPropagation(); attachSession(session.id); }}
        >${sessionName}</span>
        ${cardSummary ? html`
          <span class="session-card-summary" title=${cardSummary}>
            \u2014 ${cardSummary}
          </span>
        ` : html`
          <span class="session-card-summary" style="font-style:italic;">No summary yet</span>
        `}
      </div>

      <!-- Tag row: status badge + optional mode/telegram badges -->
      <div class="session-card-tags">
        <span class=${getBadgeClass(session)}>
          ${getBadgeLabel(session)}
        </span>
        ${session.telegramEnabled ? html`
          <span class="badge badge-telegram">TG</span>
        ` : null}
        ${session.mode ? html`
          <span class="badge badge-mode badge-mode-${session.mode}">${session.mode}</span>
        ` : null}
      </div>

      <!-- Terminal preview pane -->
      <pre class="session-card-preview" ref=${previewRef} onClick=${(e) => e.stopPropagation()}>
        ${hasPreview
          ? previewText
          : html`<span class="session-card-preview-empty">No output</span>`
        }
      </pre>

      <!-- Action bar -->
      <div class="session-card-actionbar">
        <button
          class="btn-icon"
          title="Edit session"
          onClick=${handleEdit}
        ><${WrenchIcon} /></button>

        ${active ? html`
          <button
            class="btn btn-danger btn-sm"
            onClick=${handleStop}
          >Stop</button>
        ` : html`
          <button
            class="btn btn-primary btn-sm"
            onClick=${handleRefresh}
          >Refresh</button>
        `}

        ${(!active) ? html`
          <button
            class="btn btn-danger btn-sm"
            onClick=${handleDelete}
          >Delete</button>
        ` : null}

        <span class="session-card-meta">${timeAgo(session.startedAt || session.createdAt)}</span>
      </div>

    </div>
  `;
}
