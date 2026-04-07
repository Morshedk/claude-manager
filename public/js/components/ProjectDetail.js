import { html } from 'htm/preact';
import {
  selectedProject,
  projectSessions,
  selectedProjectId,
} from '../state/store.js';
import { openNewSessionModal } from '../state/actions.js';
import { SessionCard } from './SessionCard.js';

/**
 * ProjectDetail — main content area.
 * Shows the session list for the selected project.
 * Terminal pane tabs are handled in phase 5C.
 */
export function ProjectDetail() {
  const project = selectedProject.value;

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
              Sessions — ${project.name}
            </span>
            <button
              class="btn btn-primary btn-sm"
              onClick=${openNewSessionModal}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12">
                <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
              </svg>
              New Claude Session
            </button>
          </div>

          <div id="project-sessions-list">
            ${sessions.length === 0
              ? html`<div class="sessions-empty">No sessions — start one with the button above</div>`
              : sessions.map(s => html`<${SessionCard} key=${s.id} session=${s} />`)
            }
          </div>
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
