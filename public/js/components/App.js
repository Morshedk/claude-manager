import { html } from 'htm/preact';
import { TopBar } from './TopBar.js';
import { ProjectSidebar } from './ProjectSidebar.js';
import { ProjectDetail } from './ProjectDetail.js';
import { SessionOverlay } from './SessionOverlay.js';
import { NewSessionModal } from './NewSessionModal.js';
import { SettingsModal } from './SettingsModal.js';
import { attachedSessionId, newSessionModalOpen, settingsModalOpen, toasts } from '../state/store.js';

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
  return html`
    <div id="app-shell" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <${TopBar} />
      <div id="workspace" style="flex:1;display:flex;overflow:hidden;min-height:0;">
        <${ProjectSidebar} />
        <div class="resize-handle resize-handle-h" id="sidebar-resize"></div>
        <${ProjectDetail} />
      </div>
      ${attachedSessionId.value ? html`<${SessionOverlay} />` : null}
      ${newSessionModalOpen.value ? html`<${NewSessionModal} />` : null}
      ${settingsModalOpen.value ? html`<${SettingsModal} />` : null}
      <${ToastContainer} />
    </div>
  `;
}
