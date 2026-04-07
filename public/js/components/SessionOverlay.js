import { html } from 'htm/preact';
import { TerminalPane } from './TerminalPane.js';
import { attachedSession, splitView } from '../state/store.js';
import { detachSession, restartSession, stopSession, showToast } from '../state/actions.js';

/**
 * SessionOverlay — full-screen (or split) terminal view for the attached session.
 *
 * Modes:
 *   - Full: overlays the entire workspace (default)
 *   - Split: covers right half of the workspace; session list stays visible left
 *
 * Controls: Split/Full toggle, Restart, Stop (when running), Close (✕)
 */
export function SessionOverlay() {
  const session = attachedSession.value;
  if (!session) return null;

  const isSplit = splitView.value;

  const toggleSplit = () => { splitView.value = !splitView.value; };

  const handleRestart = () => {
    restartSession(session.id);
    showToast('Restarting session\u2026', 'info');
  };

  const handleStop = () => {
    stopSession(session.id);
    showToast('Stopping session\u2026', 'info');
  };

  const handleClose = () => detachSession();

  // Display name: prefer session.name, then projectName, then id prefix
  const displayName = session.name || session.projectName || session.id.slice(0, 8);

  // Status dot color
  const statusColor = {
    running: 'var(--accent)',
    starting: 'var(--warning)',
    stopped: 'var(--text-muted)',
    error: 'var(--danger)',
    shell: 'var(--accent)',
  }[session.status || session.state] || 'var(--text-muted)';

  const isActive = session.status === 'running' || session.status === 'shell';

  return html`
    <div
      id="session-overlay"
      style="
        position: fixed;
        ${isSplit ? 'left: 50%;' : 'left: 0;'}
        right: 0;
        top: var(--topbar-h);
        bottom: 0;
        background: var(--bg-base);
        display: flex;
        flex-direction: column;
        z-index: 100;
        border-left: ${isSplit ? '1px solid var(--border)' : 'none'};
      "
    >
      <!-- Header -->
      <header
        class="overlay-header"
        style="
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 12px;
          height: 40px;
          background: var(--bg-surface);
          border-bottom: 1px solid var(--border);
          flex-shrink: 0;
        "
      >
        <!-- Status dot -->
        <span style="
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: ${statusColor};
          flex-shrink: 0;
        "></span>

        <!-- Session name -->
        <span
          id="overlay-title"
          style="
            font-size: 13px;
            font-weight: 600;
            color: var(--text-bright);
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          "
        >${displayName}</span>

        ${session.claudeSessionId ? html`
          <span
            title=${'Claude session: ' + session.claudeSessionId}
            style="
              font-size: 11px;
              color: var(--text-muted);
              font-family: var(--font-mono);
              cursor: default;
              flex-shrink: 0;
            "
          >${session.claudeSessionId.slice(0, 8)}</span>
        ` : null}

        <!-- Actions -->
        <div class="overlay-actions" style="display: flex; gap: 4px; flex-shrink: 0;">
          <button
            onClick=${toggleSplit}
            style=${btnStyle()}
            title=${isSplit ? 'Expand to full screen' : 'Switch to split view'}
          >
            ${isSplit ? 'Full' : 'Split'}
          </button>

          <button
            onClick=${handleRestart}
            style=${btnStyle()}
            title="Restart session"
          >
            Restart
          </button>

          ${isActive ? html`
            <button
              id="btn-session-stop"
              onClick=${handleStop}
              style=${btnStyle('var(--danger-bg)', 'var(--danger)')}
              title="Stop session"
            >
              Stop
            </button>
          ` : null}

          <button
            id="btn-detach"
            onClick=${handleClose}
            style=${btnStyle()}
            title="Close terminal overlay"
          >
            \u2715
          </button>
        </div>
      </header>

      <!-- Terminal body -->
      <div
        id="session-overlay-terminal"
        style="flex: 1; min-height: 0; overflow: hidden; position: relative;"
      >
        <${TerminalPane} sessionId=${session.id} />
      </div>
    </div>
  `;
}

/** Returns an inline style string for overlay action buttons. */
function btnStyle(bg = 'var(--bg-raised)', color = 'var(--text-secondary)') {
  return `
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: ${bg};
    color: ${color};
    font-size: 12px;
    font-family: var(--font-sans);
    cursor: pointer;
    white-space: nowrap;
  `;
}
