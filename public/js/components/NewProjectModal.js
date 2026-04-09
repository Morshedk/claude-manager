import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { newProjectModalOpen, projects } from '../state/store.js';
import { closeNewProjectModal, createProject, showToast } from '../state/actions.js';

/**
 * NewProjectModal — create project modal.
 * Collects a project name and path, then POSTs to /api/projects.
 * Shows/hides based on newProjectModalOpen signal.
 */
export function NewProjectModal() {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset form when modal opens
  useEffect(() => {
    if (!newProjectModalOpen.value) return;
    setName('');
    setPath('');
    setSubmitting(false);
  }, [newProjectModalOpen.value]);

  async function handleCreate() {
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    if (!trimmedName) {
      showToast('Project name is required', 'error');
      return;
    }
    if (!trimmedPath) {
      showToast('Project path is required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await createProject(trimmedName, trimmedPath);
      showToast(`Project "${trimmedName}" created`, 'success');
      closeNewProjectModal();
    } catch (err) {
      showToast('Failed to create project', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') closeNewProjectModal();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleCreate();
  }

  if (!newProjectModalOpen.value) return null;

  // Build datalist options: unique project paths + unique parent directories
  const allPaths = projects.value.map(p => p.path);
  const parentDirs = allPaths.map(p => {
    const idx = p.lastIndexOf('/');
    return idx > 0 ? p.slice(0, idx) : p;
  });
  const uniqueSuggestions = [...new Set([...allPaths, ...parentDirs])];

  return html`
    <div
      class="dialog-overlay"
      onClick=${closeNewProjectModal}
      onKeyDown=${handleKeyDown}
      style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:200;"
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New Project"
        onClick=${e => e.stopPropagation()}
        style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);width:min(440px,95vw);display:flex;flex-direction:column;max-height:90vh;"
      >
        <!-- Header -->
        <div class="dlg-header" style="display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <h2 style="font-size:15px;font-weight:600;color:var(--text-bright);flex:1;margin:0;">
            New Project
          </h2>
          <button
            onClick=${closeNewProjectModal}
            style="font-size:20px;color:var(--text-muted);background:none;border:none;cursor:pointer;line-height:1;padding:0;"
          >×</button>
        </div>

        <!-- Body -->
        <div class="dlg-body" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;">

          <!-- Project name -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Project Name</label>
            <input
              class="form-input"
              id="new-project-name"
              value=${name}
              onInput=${e => setName(e.target.value)}
              placeholder="e.g. My App"
              style="width:100%;padding:8px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;box-sizing:border-box;"
            />
          </div>

          <!-- Project path -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Project Path</label>
            <input
              class="form-input"
              id="new-project-path"
              list="project-paths-datalist"
              value=${path}
              onInput=${e => setPath(e.target.value)}
              placeholder="e.g. /home/user/my-app"
              style="width:100%;padding:8px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;font-family:var(--font-mono);box-sizing:border-box;"
            />
            <datalist id="project-paths-datalist">
              ${uniqueSuggestions.map(p => html`<option value=${p} />`)}
            </datalist>
            <div class="form-help" style="font-size:11px;color:var(--text-muted);margin-top:3px;">Absolute path to the project directory on disk.</div>
          </div>

        </div>

        <!-- Footer -->
        <div class="dlg-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border);flex-shrink:0;">
          <button
            class="btn btn-ghost"
            onClick=${closeNewProjectModal}
            style="padding:8px 16px;border-radius:var(--radius-sm);background:transparent;border:1px solid var(--border);color:var(--text-primary);cursor:pointer;font-size:13px;"
          >Cancel</button>
          <button
            class="btn btn-primary"
            onClick=${handleCreate}
            disabled=${submitting}
            style="padding:8px 18px;border-radius:var(--radius-sm);background:var(--accent);color:#000;font-weight:600;font-size:13px;cursor:pointer;border:none;opacity:${submitting ? 0.6 : 1};"
          >${submitting ? 'Creating…' : 'Create Project'}</button>
        </div>
      </div>
    </div>
  `;
}
