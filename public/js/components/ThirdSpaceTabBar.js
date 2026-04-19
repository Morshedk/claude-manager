import { html } from 'htm/preact';

const PLUS_ICON = html`<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
  <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
</svg>`;

const CLOSE_ICON = html`<svg viewBox="0 0 20 20" fill="currentColor" width="10" height="10">
  <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
</svg>`;

/**
 * ThirdSpaceTabBar — tab bar for the project "third space".
 * Shows terminal tabs (dynamic, closeable) + permanent Files and Todos tabs.
 *
 * @param {Array<{id:string, label:string}>} terminalTabs
 * @param {string}   activeTabId       - currently active tab id, 'files', 'todos', or terminalId
 * @param {function} onTabSelect       - (id) => void
 * @param {function} onAddTerminal     - () => void
 * @param {function} onCloseTerminal   - (id) => void
 */
export function ThirdSpaceTabBar({ terminalTabs, activeTabId, onTabSelect, onAddTerminal, onCloseTerminal }) {
  const tabStyle = (id) => `
    display:flex;align-items:center;gap:5px;
    padding:0 12px;height:36px;
    font-family:var(--font-mono);font-size:12px;
    color:${activeTabId === id ? 'var(--accent)' : 'var(--text-muted)'};
    border-bottom:2px solid ${activeTabId === id ? 'var(--accent)' : 'transparent'};
    background:${activeTabId === id ? 'var(--bg-hover)' : 'transparent'};
    cursor:pointer;white-space:nowrap;flex-shrink:0;
    transition:all 0.12s;user-select:none;
  `;

  const handleCloseClick = (e, id) => {
    e.stopPropagation();
    onCloseTerminal(id);
  };

  return html`
    <div class="terminals-bar" style="gap:0;padding-right:0;">
      <!-- New terminal button -->
      <button
        class="btn btn-icon"
        title="New terminal"
        onClick=${onAddTerminal}
        style="margin:0 4px;flex-shrink:0;"
      >${PLUS_ICON}</button>

      <div style="width:1px;height:20px;background:var(--border);flex-shrink:0;margin:0 2px;"></div>

      <!-- Terminal tabs -->
      <div style="display:flex;align-items:center;flex:1;overflow-x:auto;scrollbar-width:none;height:100%;">
        ${terminalTabs.map(t => html`
          <div
            key=${t.id}
            style=${tabStyle(t.id)}
            onClick=${() => onTabSelect(t.id)}
          >
            <span>${t.label}</span>
            <span
              onClick=${(e) => handleCloseClick(e, t.id)}
              style="display:flex;align-items:center;opacity:0.5;cursor:pointer;margin-left:2px;"
              title="Close terminal"
            >${CLOSE_ICON}</span>
          </div>
        `)}

        <!-- Permanent tabs: Files and Todos -->
        <div style=${tabStyle('files')} onClick=${() => onTabSelect('files')}>Files</div>
        <div style=${tabStyle('todos')} onClick=${() => onTabSelect('todos')}>Todos</div>
      </div>
    </div>
  `;
}
