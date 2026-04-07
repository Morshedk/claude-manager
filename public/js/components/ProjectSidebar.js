import { html } from 'htm/preact';
import { projects, selectedProjectId, sessions } from '../state/store.js';
import { selectProject, openNewSessionModal } from '../state/actions.js';

/**
 * ProjectSidebar — left panel listing all projects.
 * Click a project to select it. "New Project" button at bottom.
 */
export function ProjectSidebar() {
  const projectList = projects.value;
  const activePid = selectedProjectId.value;
  const allSessions = sessions.value;

  function getRunningCount(projectId) {
    return allSessions.filter(
      s => s.projectId === projectId && (s.status === 'running' || s.state === 'running')
    ).length;
  }

  return html`
    <aside id="project-sidebar">
      <div class="sidebar-header">PROJECTS</div>

      <div id="project-list">
        ${projectList.length === 0
          ? html`<div class="sidebar-empty">No projects yet — add one below</div>`
          : projectList.map(p => {
              const running = getRunningCount(p.id);
              const isActive = activePid === p.id;
              return html`
                <div
                  key=${p.id}
                  class=${'project-item' + (isActive ? ' active' : '')}
                  onClick=${() => selectProject(p.id)}
                >
                  <div class="project-item-name">${p.name}</div>
                  <div class="project-item-path">${p.path}</div>
                  <div class=${'project-item-badge' + (running > 0 ? ' has-sessions' : '')}>
                    ${running > 0
                      ? `${running} session${running !== 1 ? 's' : ''} running`
                      : 'idle'}
                  </div>
                  <div class="project-item-actions">
                    <button
                      class="btn-item-action"
                      title="Edit"
                      onClick=${(e) => { e.stopPropagation(); /* edit modal — phase 5D */ }}
                    >✎</button>
                  </div>
                </div>
              `;
            })
        }
      </div>

      <div class="sidebar-actions">
        <button
          class="btn btn-ghost btn-sm sidebar-new-btn"
          onClick=${() => { /* new project modal — phase 5D */ }}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
            <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
          </svg>
          New Project
        </button>
      </div>
    </aside>
  `;
}
