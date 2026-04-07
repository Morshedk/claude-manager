import { html } from 'htm/preact';
import {
  attachSession,
  stopSession,
  restartSession,
  deleteSession,
  showToast,
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
    case 'shell':    return 'badge badge-activity badge-activity-shell';
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
    case 'shell':    return '\u2588 shell';
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
  return s === 'running' || s === 'shell' || s === 'starting';
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

/**
 * SessionCard — compact card for a single session.
 * Props: { session }
 */
export function SessionCard({ session }) {
  const sessionName = session.name || `Session ${session.id.slice(0, 6)}`;
  const active = isActive(session);

  function handleAttach(e) {
    e.stopPropagation();
    attachSession(session.id);
  }

  function handleStop(e) {
    e.stopPropagation();
    stopSession(session.id);
    showToast('Stopping session...', 'info');
  }

  function handleRestart(e) {
    e.stopPropagation();
    restartSession(session.id);
    showToast('Restarting session...', 'info');
  }

  function handleDelete(e) {
    e.stopPropagation();
    if (!confirm(`Delete session "${sessionName}"?`)) return;
    deleteSession(session.id);
  }

  function handleCopyId(e) {
    e.stopPropagation();
    if (session.claudeSessionId) {
      navigator.clipboard.writeText(session.claudeSessionId)
        .then(() => showToast('Session ID copied', 'success'))
        .catch(() => {});
    }
  }

  return html`
    <div class="session-card" onClick=${() => attachSession(session.id)}>
      <div class="session-card-header">
        <span
          class="session-card-name session-card-name-link"
          onClick=${handleAttach}
        >${sessionName}</span>

        <span class=${getBadgeClass(session)}>
          ${getBadgeLabel(session)}
        </span>

        ${session.telegramEnabled ? html`
          <span class="badge badge-telegram">TG</span>
        ` : null}

        ${session.mode ? html`
          <span class="badge badge-mode badge-mode-${session.mode}">${session.mode}</span>
        ` : null}

        ${session.claudeSessionId ? html`
          <span
            class="session-card-meta session-id-hint"
            title=${'Click to copy: ' + session.claudeSessionId}
            onClick=${handleCopyId}
          >${session.claudeSessionId.slice(0, 8)}</span>
        ` : null}

        <span class="session-card-meta">${timeAgo(session.startedAt || session.createdAt)}</span>

        <div class="session-card-actions">
          <button
            class="btn btn-ghost btn-sm"
            title="Open session"
            onClick=${handleAttach}
          >Open</button>

          ${active ? html`
            <button
              class="btn btn-danger btn-sm"
              onClick=${handleStop}
            >Stop</button>
          ` : html`
            <button
              class="btn btn-primary btn-sm"
              onClick=${handleRestart}
            >Restart</button>
          `}

          ${(!active) ? html`
            <button
              class="btn btn-danger btn-sm"
              onClick=${handleDelete}
            >Delete</button>
          ` : null}
        </div>
      </div>

      ${session.lastLine ? html`
        <div class="session-lastline">${session.lastLine}</div>
      ` : null}

      ${session.watchdogSummary ? html`
        <div class="session-description" style="font-size:0.8em;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title=${session.watchdogSummary}>
          ${session.watchdogSummary}
        </div>
      ` : null}
    </div>
  `;
}
