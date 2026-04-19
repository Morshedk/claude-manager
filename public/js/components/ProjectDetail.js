import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import {
  selectedProject,
  projectSessions,
  selectedProjectId,
  thirdSpaceTab,
} from '../state/store.js';
import { send } from '../ws/connection.js';
import { CLIENT } from '../ws/protocol.js';
import { openNewSessionModal } from '../state/actions.js';
import { SessionCard } from './SessionCard.js';
import { WatchdogPanel } from './WatchdogPanel.js';
import { TodoPanel } from './TodoPanel.js';
import { FileBrowser } from './FileBrowser.js';
import { ProjectTerminalPane } from './ProjectTerminalPane.js';
import { ThirdSpaceTabBar } from './ThirdSpaceTabBar.js';
import { initResize } from '../utils/dom.js';

export function ProjectDetail() {
  const [upperTab, setUpperTab] = useState('sessions');
  const [terminalTabs, setTerminalTabs] = useState([]);
  const [mountedTerminals, setMountedTerminals] = useState(new Set());
  const nextNum = useRef(1);
  const project = selectedProject.value;
  const projectId = project?.id;

  // Wire sessions resize handle
  useEffect(() => {
    const handle = document.getElementById('resize-sessions');
    const area = document.getElementById('sessions-area');
    if (!handle || !area) return;
    return initResize(handle, 'v', area, { min: 60, max: 800 });
  }, [projectId]);

  // Reset third space when project changes
  useEffect(() => {
    setTerminalTabs([]);
    setMountedTerminals(new Set());
    nextNum.current = 1;
    thirdSpaceTab.value = 'files';
  }, [projectId]);

  if (!project) {
    return html`
      <main id="detail-pane">
        <div id="no-project-view">
          <div class="empty-state" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;">
            <div style="font-size:40px;">📁</div>
            <p style="color:var(--text-primary);font-size:14px;">Select a project</p>
            <p style="color:var(--text-muted);font-size:12px;text-align:center;max-width:260px;">
              Choose a project from the sidebar to see its sessions and terminals
            </p>
          </div>
        </div>
      </main>
    `;
  }

  const sessions = projectSessions.value;
  const activeThirdTab = thirdSpaceTab.value;

  const tabBtnStyle = (id) => `
    font-size:12px;padding:4px 12px;border-radius:var(--radius-sm);
    border:1px solid ${upperTab === id ? 'var(--accent)' : 'var(--border)'};
    background:${upperTab === id ? 'var(--accent)' : 'transparent'};
    color:${upperTab === id ? '#000' : 'var(--text-secondary)'};
    cursor:pointer;font-weight:${upperTab === id ? '600' : '400'};transition:all 0.15s;
  `;

  function handleAddTerminal() {
    const id = crypto.randomUUID();
    const num = nextNum.current++;
    const tab = { id, label: `Terminal ${num}`, cwd: project.path };
    setTerminalTabs(prev => [...prev, tab]);
    setMountedTerminals(prev => new Set([...prev, id]));
    thirdSpaceTab.value = id;
  }

  function handleCloseTerminal(terminalId) {
    send({ type: CLIENT.TERMINAL_CLOSE, id: terminalId });
    setTerminalTabs(prev => prev.filter(t => t.id !== terminalId));
    setMountedTerminals(prev => { const s = new Set(prev); s.delete(terminalId); return s; });
    if (thirdSpaceTab.value === terminalId) {
      thirdSpaceTab.value = 'files';
    }
  }

  return html`
    <main id="detail-pane">
      <div id="project-detail" class="visible">

        <!-- Upper sessions area -->
        <div id="sessions-area">
          <div class="area-header">
            <span class="area-title" id="sessions-area-title">${project.name}</span>
            ${upperTab === 'sessions' ? html`
              <button class="btn btn-primary btn-sm" onClick=${openNewSessionModal}>
                <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12">
                  <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
                </svg>
                New Claude Session
              </button>
            ` : null}
          </div>

          <!-- Upper tab bar: Sessions | Watchdog only -->
          <div class="sessions-tab-bar" style="display:flex;gap:2px;padding:4px 12px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg-base);">
            <button style=${tabBtnStyle('sessions')} onClick=${() => setUpperTab('sessions')}>Sessions</button>
            <button id="watchdog-tab-btn" style=${tabBtnStyle('watchdog')} onClick=${() => setUpperTab('watchdog')}>Watchdog</button>
          </div>

          ${upperTab === 'sessions' ? html`
            <div id="project-sessions-list">
              ${sessions.length === 0
                ? html`<div class="sessions-empty">No sessions — start one with the button above</div>`
                : sessions.map(s => html`<${SessionCard} key=${s.id} session=${s} />`)}
            </div>
          ` : html`
            <div id="watchdog-panel-container" style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;">
              <${WatchdogPanel} />
            </div>
          `}
        </div>

        <!-- Vertical resize handle -->
        <div class="resize-handle resize-handle-v" id="resize-sessions"></div>

        <!-- Third space: unified tab bar + content -->
        <div id="terminals-area">
          <${ThirdSpaceTabBar}
            terminalTabs=${terminalTabs}
            activeTabId=${activeThirdTab}
            onTabSelect=${(id) => { thirdSpaceTab.value = id; }}
            onAddTerminal=${handleAddTerminal}
            onCloseTerminal=${handleCloseTerminal}
          />

          <div id="project-terminal-content" class="terminal-area">
            <!-- Terminal panes: always mounted once activated, hidden via CSS when inactive -->
            ${terminalTabs.filter(t => mountedTerminals.has(t.id)).map(t => html`
              <div key=${t.id} class=${'terminal-pane' + (activeThirdTab === t.id ? ' active' : '')}>
                <${ProjectTerminalPane}
                  terminalId=${t.id}
                  cwd=${t.cwd}
                  projectId=${project.id}
                  create=${true}
                />
              </div>
            `)}

            <!-- Files panel -->
            ${activeThirdTab === 'files' ? html`
              <div class="terminal-pane active" style="display:flex;flex-direction:column;">
                <${FileBrowser} projectId=${project.id} projectPath=${project.path} />
              </div>
            ` : null}

            <!-- Todos panel -->
            ${activeThirdTab === 'todos' ? html`
              <div class="terminal-pane active" style="display:flex;flex-direction:column;">
                <${TodoPanel} projectId=${project.id} />
              </div>
            ` : null}

            <!-- Empty state: no terminals and no panel active (should not occur in normal use) -->
            ${terminalTabs.length === 0 && activeThirdTab !== 'files' && activeThirdTab !== 'todos' ? html`
              <div class="terminals-empty">Open a terminal with the + button above</div>
            ` : null}
          </div>
        </div>

      </div>
    </main>
  `;
}
