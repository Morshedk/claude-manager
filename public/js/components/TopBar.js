import { html } from 'htm/preact';
import { connected, serverVersion, serverEnv } from '../state/store.js';
import { openSettingsModal, manualReconnect } from '../state/actions.js';
import { VitalsIndicator } from './VitalsIndicator.js';

/**
 * TopBar — app-level header.
 * Shows: brand name + version badge, connection status, settings button.
 */
export function TopBar() {
  const isConnected = connected.value;
  const ver = serverVersion.value;
  const env = serverEnv.value;
  const isBeta = env === 'BETA';
  const versionLabel = ver ? `v${ver} ${env}` : 'v2';
  const badgeStyle = `
    font-family:var(--font-mono);
    font-size:9px;
    border-radius:3px;
    padding:1px 5px;
    letter-spacing:0.04em;
    background:${isBeta ? 'rgba(245,158,11,0.12)' : 'var(--accent-bg)'};
    color:${isBeta ? '#f59e0b' : 'var(--accent-dim)'};
    border:1px solid ${isBeta ? 'rgba(245,158,11,0.35)' : 'var(--accent-border)'};
  `;

  return html`
    <header id="topbar">
      <div class="brand">
        <span class="brand-icon">⚡</span>
        <span class="brand-text">CLAUDE<span class="brand-sub"> MANAGER</span></span>
        <span style="${badgeStyle}">${versionLabel}</span>
      </div>

      <div class="global-stats">
        <${VitalsIndicator} />
      </div>

      <div class="topbar-right">
        ${isConnected
          ? html`<div class="system-status" title="Already connected">
              <div class="status-dot connected"></div>
              <span class="status-text">Connected</span>
            </div>`
          : html`<button
              type="button"
              class="system-status system-status-clickable"
              title="Click to reconnect now"
              onClick=${manualReconnect}
            >
              <div class="status-dot error"></div>
              <span class="status-text">Disconnected</span>
            </button>`
        }
        <button
          class="btn btn-ghost btn-sm"
          title="Settings"
          onClick=${openSettingsModal}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
          </svg>
          Settings
        </button>
      </div>
    </header>
  `;
}
