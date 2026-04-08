import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { editProjectModalOpen, editProjectTarget } from '../state/store.js';
import { closeEditProjectModal, updateProject, showToast } from '../state/actions.js';

/**
 * EditProjectModal — edit an existing project's name.
 * Path is read-only; changing paths causes data inconsistency.
 * Opens when editProjectModalOpen signal is true, with the target
 * project stored in editProjectTarget.
 */
export function EditProjectModal() {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const project = editProjectTarget.value;

  // Pre-fill name when modal opens with a project
  useEffect(() => {
    if (!editProjectModalOpen.value || !project) return;
    setName(project.name || '');
    setSubmitting(false);
  }, [editProjectModalOpen.value, project]);

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      showToast('Project name is required', 'error');
      return;
    }
    if (!project) return;
    setSubmitting(true);
    try {
      await updateProject(project.id, { name: trimmedName });
      showToast(`Project renamed to "${trimmedName}"`, 'success');
      closeEditProjectModal();
    } catch (err) {
      showToast('Failed to update project', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') closeEditProjectModal();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave();
  }

  if (!editProjectModalOpen.value || !project) return null;

  return html`
    <div
      class="dialog-overlay"
      onClick=${closeEditProjectModal}
      onKeyDown=${handleKeyDown}
      style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:200;"
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit Project"
        onClick=${e => e.stopPropagation()}
        style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);width:min(440px,95vw);display:flex;flex-direction:column;max-height:90vh;"
      >
        <!-- Header -->
        <div class="dlg-header" style="display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <h2 style="font-size:15px;font-weight:600;color:var(--text-bright);flex:1;margin:0;">
            Edit Project
          </h2>
          <button
            onClick=${closeEditProjectModal}
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
              id="edit-project-name"
              value=${name}
              onInput=${e => setName(e.target.value)}
              placeholder="e.g. My App"
              style="width:100%;padding:8px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;box-sizing:border-box;"
            />
          </div>

          <!-- Project path (read-only) -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Project Path <span style="color:var(--text-muted);font-size:11px;">(read-only)</span></label>
            <input
              class="form-input"
              value=${project.path || ''}
              readOnly
              style="width:100%;padding:8px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-muted);font-size:13px;font-family:var(--font-mono);box-sizing:border-box;cursor:not-allowed;opacity:0.7;"
            />
            <div class="form-help" style="font-size:11px;color:var(--text-muted);margin-top:3px;">Path cannot be changed — it is used to link sessions to this project.</div>
          </div>

        </div>

        <!-- Footer -->
        <div class="dlg-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border);flex-shrink:0;">
          <button
            class="btn btn-ghost"
            onClick=${closeEditProjectModal}
            style="padding:8px 16px;border-radius:var(--radius-sm);background:transparent;border:1px solid var(--border);color:var(--text-primary);cursor:pointer;font-size:13px;"
          >Cancel</button>
          <button
            class="btn btn-primary"
            onClick=${handleSave}
            disabled=${submitting}
            style="padding:8px 18px;border-radius:var(--radius-sm);background:var(--accent);color:#000;font-weight:600;font-size:13px;cursor:pointer;border:none;opacity:${submitting ? 0.6 : 1};"
          >${submitting ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  `;
}
