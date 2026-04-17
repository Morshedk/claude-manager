import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import {
  selectedProject,
  projectSessions,
  selectedProjectId,
} from '../state/store.js';
import { openNewSessionModal } from '../state/actions.js';
import { SessionCard } from './SessionCard.js';
import { WatchdogPanel } from './WatchdogPanel.js';
import { TodoPanel } from './TodoPanel.js';
import { FileBrowser } from './FileBrowser.js';
import { initResize } from '../utils/dom.js';

/**
 * ProjectDetail — main content area.
 * Shows the session list for the selected project.
 * Terminal pane tabs are handled in phase 5C.
 */
export function ProjectDetail() {
  const [activeTab, setActiveTab] = useState('sessions');
  const project = selectedProject.value;

  // Wire sessions resize handle — must run after project is selected so DOM elements exist
  useEffect(() => {
    const handle = document.getElementById('resize-sessions');
    const area = document.getElementById('sessions-area');
    if (!handle || !area) return;
    return initResize(handle, 'v', area, { min: 60, max: 800 });
  }, [selectedProjectId.value]);

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

  return html`
    <main id="detail-pane">
      <div id="project-detail" class="visible">

        <!-- Sessions area -->
        <div id="sessions-area">
          <div class="area-header">
            <span class="area-title" id="sessions-area-title">
              ${project.name}
            </span>
            ${activeTab === 'sessions' ? html`
              <button
                class="btn btn-primary btn-sm"
                onClick=${openNewSessionModal}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12">
                  <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
                </svg>
                New Claude Session
              </button>
            ` : null}
          </div>

          <!-- Tab bar -->
          <div class="sessions-tab-bar" style="display:flex;gap:2px;padding:4px 12px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg-base);">
            <button
              class=${'tab-btn' + (activeTab === 'sessions' ? ' active' : '')}
              onClick=${() => setActiveTab('sessions')}
              style=${`font-size:12px;padding:4px 12px;border-radius:var(--radius-sm);border:1px solid ${activeTab === 'sessions' ? 'var(--accent)' : 'var(--border)'};background:${activeTab === 'sessions' ? 'var(--accent)' : 'transparent'};color:${activeTab === 'sessions' ? '#000' : 'var(--text-secondary)'};cursor:pointer;font-weight:${activeTab === 'sessions' ? '600' : '400'};transition:all 0.15s;`}
            >Sessions</button>
            <button
              class=${'tab-btn' + (activeTab === 'watchdog' ? ' active' : '')}
              id="watchdog-tab-btn"
              onClick=${() => setActiveTab('watchdog')}
              style=${`font-size:12px;padding:4px 12px;border-radius:var(--radius-sm);border:1px solid ${activeTab === 'watchdog' ? 'var(--accent)' : 'var(--border)'};background:${activeTab === 'watchdog' ? 'var(--accent)' : 'transparent'};color:${activeTab === 'watchdog' ? '#000' : 'var(--text-secondary)'};cursor:pointer;font-weight:${activeTab === 'watchdog' ? '600' : '400'};transition:all 0.15s;`}
            >Watchdog</button>
            <button
              class=${'tab-btn' + (activeTab === 'todos' ? ' active' : '')}
              id="todos-tab-btn"
              onClick=${() => setActiveTab('todos')}
              style=${`font-size:12px;padding:4px 12px;border-radius:var(--radius-sm);border:1px solid ${activeTab === 'todos' ? 'var(--accent)' : 'var(--border)'};background:${activeTab === 'todos' ? 'var(--accent)' : 'transparent'};color:${activeTab === 'todos' ? '#000' : 'var(--text-secondary)'};cursor:pointer;font-weight:${activeTab === 'todos' ? '600' : '400'};transition:all 0.15s;`}
            >TODOs</button>
            <button
              class=${'tab-btn' + (activeTab === 'files' ? ' active' : '')}
              id="files-tab-btn"
              onClick=${() => setActiveTab('files')}
              style=${`font-size:12px;padding:4px 12px;border-radius:var(--radius-sm);border:1px solid ${activeTab === 'files' ? 'var(--accent)' : 'var(--border)'};background:${activeTab === 'files' ? 'var(--accent)' : 'transparent'};color:${activeTab === 'files' ? '#000' : 'var(--text-secondary)'};cursor:pointer;font-weight:${activeTab === 'files' ? '600' : '400'};transition:all 0.15s;`}
            >Files</button>
          </div>

          ${activeTab === 'sessions' ? html`
            <div id="project-sessions-list">
              ${sessions.length === 0
                ? html`<div class="sessions-empty">No sessions — start one with the button above</div>`
                : sessions.map(s => html`<${SessionCard} key=${s.id} session=${s} />`)
              }
            </div>
          ` : activeTab === 'todos' ? html`
            <div id="todo-panel-container" style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;">
              <${TodoPanel} projectId=${project.id} />
            </div>
          ` : activeTab === 'files' ? html`
            <div id="file-browser-container" style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;">
              <${FileBrowser} projectId=${project.id} projectPath=${project.path} />
            </div>
          ` : html`
            <div id="watchdog-panel-container" style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;">
              <${WatchdogPanel} />
            </div>
          `}
        </div>

        <!-- Sessions/Terminals vertical resize handle -->
        <div class="resize-handle resize-handle-v" id="resize-sessions"></div>

        <!-- Terminals area (TerminalPane mounted in phase 5C) -->
        <div id="terminals-area">
          <div class="terminals-bar">
            <div id="project-terminal-tabs" class="terminal-tabs"></div>
            <button class="btn btn-icon" title="New terminal" id="btn-new-terminal">
              <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
              </svg>
            </button>
          </div>
          <div id="project-terminal-content" class="terminal-area">
            <div class="terminals-empty">
              Open a terminal with the + button above
            </div>
          </div>
        </div>

      </div>
    </main>
  `;
}
