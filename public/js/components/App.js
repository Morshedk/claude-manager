import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { TopBar } from './TopBar.js';
import { ProjectSidebar } from './ProjectSidebar.js';
import { ProjectDetail } from './ProjectDetail.js';
import { SessionOverlay } from './SessionOverlay.js';
import { FileSplitPane } from './FileSplitPane.js';
import { NewSessionModal } from './NewSessionModal.js';
import { NewProjectModal } from './NewProjectModal.js';
import { EditProjectModal } from './EditProjectModal.js';
import { EditSessionModal } from './EditSessionModal.js';
import { SettingsModal } from './SettingsModal.js';
import { initResize } from '../utils/dom.js';
import { attachedSessionId, newSessionModalOpen, settingsModalOpen, newProjectModalOpen, editProjectModalOpen, editSessionModalOpen, toasts, splitView, splitPosition, fileSplitTarget } from '../state/store.js';

/**
 * ToastContainer — inline small component for toast notifications.
 */
function ToastContainer() {
  const items = toasts.value;
  if (!items.length) return null;

  const typeStyles = {
    info:    { bg: 'var(--bg-raised)', border: 'var(--border)', color: 'var(--text-primary)' },
    success: { bg: 'var(--success-bg)', border: 'var(--accent-border)', color: 'var(--success)' },
    error:   { bg: 'var(--danger-bg)', border: 'rgba(240,72,72,0.3)', color: 'var(--danger)' },
    warning: { bg: 'var(--warning-bg)', border: 'rgba(232,160,32,0.3)', color: 'var(--warning)' },
  };

  return html`
    <div style="position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;">
      ${items.map(t => {
        const s = typeStyles[t.type] || typeStyles.info;
        return html`
          <div key=${t.id} style="
            background:${s.bg};
            border:1px solid ${s.border};
            color:${s.color};
            padding:10px 16px;
            border-radius:var(--radius);
            font-size:13px;
            box-shadow:var(--shadow-lg);
            max-width:320px;
            pointer-events:all;
          ">${t.message}</div>
        `;
      })}
    </div>
  `;
}

/**
 * App — root component. Renders the full shell layout:
 *   TopBar
 *   ├── ProjectSidebar (left)
 *   └── ProjectDetail (right)
 * Plus session overlay and toasts.
 */
export function App() {
  // Apply --split-pos CSS variable from stored signal value on mount and when it changes
  useEffect(() => {
    document.documentElement.style.setProperty('--split-pos', splitPosition.value + '%');
  }, [splitPosition.value]);

  // Apply/remove session-split body class based on split view + session state
  useEffect(() => {
    const inSplit = splitView.value && !!attachedSessionId.value;
    document.body.classList.toggle('session-split', inSplit);
  }, [splitView.value, attachedSessionId.value]);

  // Apply/remove file-split body class when file split pane is open
  useEffect(() => {
    document.body.classList.toggle('file-split', !!fileSplitTarget.value);
  }, [fileSplitTarget.value]);

  // Wire sidebar resize handle (always in DOM at mount)
  useEffect(() => {
    const sidebarHandle = document.getElementById('sidebar-resize');
    const sidebar = document.getElementById('project-sidebar');
    if (!sidebarHandle || !sidebar) return;
    return initResize(sidebarHandle, 'h', sidebar, { min: 140, max: 500 });
  }, []);

  return html`
    <div id="app-shell" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <${TopBar} />
      <div id="workspace" style="flex:1;display:flex;overflow:hidden;min-height:0;">
        <${ProjectSidebar} />
        <div class="resize-handle resize-handle-h" id="sidebar-resize"></div>
        <${ProjectDetail} />
      </div>
      ${fileSplitTarget.value ? html`<${FileSplitPane} />` : attachedSessionId.value ? html`<${SessionOverlay} />` : null}
      ${newSessionModalOpen.value ? html`<${NewSessionModal} />` : null}
      ${newProjectModalOpen.value ? html`<${NewProjectModal} />` : null}
      ${editProjectModalOpen.value ? html`<${EditProjectModal} />` : null}
      ${editSessionModalOpen.value ? html`<${EditSessionModal} />` : null}
      ${settingsModalOpen.value ? html`<${SettingsModal} />` : null}
      <${ToastContainer} />
    </div>
  `;
}
