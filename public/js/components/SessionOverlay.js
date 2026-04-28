import { html } from 'htm/preact';
import { useRef, useState } from 'preact/hooks';
import { TerminalPane } from './TerminalPane.js';
import { SessionLogPane } from './SessionLogPane.js';
import { CommandBuffer } from './CommandBuffer.js';
import { attachedSession, splitView, splitPosition } from '../state/store.js';
import { detachSession, refreshSession, stopSession, showToast } from '../state/actions.js';

const EVENTS_COLLAPSED_HEIGHT = 28;
const EVENTS_DEFAULT_HEIGHT = 120;
const EVENTS_COLLAPSE_THRESHOLD = 44;

function loadEventsHeight() {
  try {
    const v = parseInt(localStorage.getItem('eventsHeight') || '0', 10);
    return v > 0 ? v : EVENTS_DEFAULT_HEIGHT;
  } catch { return EVENTS_DEFAULT_HEIGHT; }
}

function saveEventsHeight(h) {
  try { localStorage.setItem('eventsHeight', String(h)); } catch {}
}

/**
 * SessionOverlay — full-screen (or split) terminal view for the attached session.
 *
 * Layout (top to bottom):
 *   - Overlay header (40px)
 *   - Events strip (resizable, default 120px, collapses to 28px)
 *   - Drag handle (6px)
 *   - Terminal pane (flex: 1)
 *   - CommandBuffer input bar
 */
export function SessionOverlay() {
  const session = attachedSession.value;
  if (!session) return null;

  const isSplit = splitView.value;
  const [eventsHeight, setEventsHeight] = useState(loadEventsHeight);
  const isCollapsed = eventsHeight <= EVENTS_COLLAPSE_THRESHOLD;
  const eventsResizing = useRef(false);
  const isDragging = useRef(false);

  const toggleSplit = () => {
    splitView.value = !splitView.value;
    try { localStorage.setItem('splitView', String(splitView.value)); } catch {}
  };

  // ── Split resize handle (horizontal) ────────────────────────────────────────
  const handleResizeMouseDown = (e) => {
    e.preventDefault();
    isDragging.current = true;
    const handle = e.currentTarget;
    handle.classList.add('dragging');

    const onMouseMove = (ev) => {
      if (!isDragging.current) return;
      const pct = Math.min(85, Math.max(20, (ev.clientX / window.innerWidth) * 100));
      document.documentElement.style.setProperty('--split-pos', pct + '%');
    };

    const onMouseUp = (ev) => {
      isDragging.current = false;
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const pct = Math.min(85, Math.max(20, (ev.clientX / window.innerWidth) * 100));
      splitPosition.value = pct;
      try { localStorage.setItem('splitPosition', String(pct)); } catch {}
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // ── Events panel vertical resize ─────────────────────────────────────────────
  const handleEventsResizeMouseDown = (e) => {
    e.preventDefault();
    eventsResizing.current = true;
    const startY = e.clientY;
    const startH = eventsHeight;

    const onMouseMove = (ev) => {
      if (!eventsResizing.current) return;
      const raw = Math.max(EVENTS_COLLAPSED_HEIGHT, Math.min(500, startH + (ev.clientY - startY)));
      setEventsHeight(raw);
    };

    const onMouseUp = (ev) => {
      eventsResizing.current = false;
      const raw = Math.max(EVENTS_COLLAPSED_HEIGHT, Math.min(500, startH + (ev.clientY - startY)));
      const snapped = raw <= EVENTS_COLLAPSE_THRESHOLD ? EVENTS_COLLAPSED_HEIGHT : raw;
      setEventsHeight(snapped);
      saveEventsHeight(snapped);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleRefresh = () => {
    refreshSession(session.id);
    showToast('Refreshing session…', 'info');
  };

  const handleStop = () => {
    stopSession(session.id);
    showToast('Stopping session…', 'info');
  };

  const handleClose = () => detachSession();

  const displayName = session.name || session.projectName || session.id.slice(0, 8);

  const statusColor = {
    running: 'var(--accent)',
    starting: 'var(--warning)',
    stopped: 'var(--text-muted)',
    error: 'var(--danger)',
  }[session.status || session.state] || 'var(--text-muted)';

  const isActive = session.status === 'running';

  return html`
    <div
      id="session-overlay"
      style="
        position: fixed;
        ${isSplit ? 'left: var(--split-pos, 50%);' : 'left: 0;'}
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
      ${isSplit ? html`
        <div
          class="split-resize-handle"
          onMouseDown=${handleResizeMouseDown}
          title="Drag to resize"
        ></div>
      ` : null}

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
        <span style="
          width: 7px; height: 7px; border-radius: 50%;
          background: ${statusColor}; flex-shrink: 0;
        "></span>

        <span
          id="overlay-title"
          style="
            font-size: 13px; font-weight: 600; color: var(--text-bright);
            flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          "
        >${displayName}</span>

        ${session.claudeSessionId ? html`
          <span
            title=${'Claude session: ' + session.claudeSessionId}
            style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); cursor: default; flex-shrink: 0;"
          >${session.claudeSessionId.slice(0, 8)}</span>
        ` : null}

        <div class="overlay-actions" style="display: flex; gap: 4px; flex-shrink: 0;">
          <button
            onClick=${toggleSplit}
            style=${btnStyle()}
            title=${isSplit ? 'Expand to full screen' : 'Switch to split view'}
          >${isSplit ? 'Full' : 'Split'}</button>

          <button onClick=${handleRefresh} style=${btnStyle()} title="Refresh session">Refresh</button>

          ${isActive ? html`
            <button
              id="btn-session-stop"
              onClick=${handleStop}
              style=${btnStyle('var(--danger-bg)', 'var(--danger)')}
              title="Stop session"
            >Stop</button>
          ` : null}

          <button
            id="btn-detach"
            onClick=${handleClose}
            style=${btnStyle()}
            title="Close terminal overlay"
          >✕</button>
        </div>
      </header>

      <!-- Events strip (top, resizable) -->
      <div
        style="
          height: ${eventsHeight}px;
          min-height: ${EVENTS_COLLAPSED_HEIGHT}px;
          flex-shrink: 0;
          overflow: hidden;
          border-bottom: 1px solid var(--border);
        "
      >
        <${SessionLogPane} sessionId=${session.id} collapsed=${isCollapsed} />
      </div>

      <!-- Vertical drag handle for events strip -->
      <div
        onMouseDown=${handleEventsResizeMouseDown}
        title="Drag to resize events panel"
        style="
          height: 6px;
          flex-shrink: 0;
          background: var(--bg-surface);
          border-bottom: 1px solid var(--border);
          cursor: row-resize;
          display: flex;
          align-items: center;
          justify-content: center;
          user-select: none;
        "
      >
        <div style="width: 32px; height: 2px; border-radius: 2px; background: var(--border);"></div>
      </div>

      <!-- Terminal body -->
      <div style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
        <div
          id="session-overlay-terminal"
          style="flex: 1; min-height: 0; overflow: hidden; position: relative;"
        >
          <${TerminalPane} sessionId=${session.id} />
        </div>

        <${CommandBuffer} targetId=${session.id} inputType="session" />
      </div>
    </div>
  `;
}

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
