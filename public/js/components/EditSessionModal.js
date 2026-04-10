import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { editSessionModalOpen, editSessionTarget, projects } from '../state/store.js';
import { closeEditSessionModal, updateSession, showToast } from '../state/actions.js';

/**
 * EditSessionModal — edit a session's name and/or project assignment.
 * Opens when editSessionModalOpen signal is true, with the target
 * session stored in editSessionTarget.
 */
export function EditSessionModal() {
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const session = editSessionTarget.value;
  const allProjects = projects.value;

  useEffect(() => {
    if (!editSessionModalOpen.value || !session) return;
    setName(session.name || '');
    setProjectId(session.projectId || '');
    setSubmitting(false);
  }, [editSessionModalOpen.value, session]);

  function handleSave() {
    if (!session) return;
    if (submitting) return;
    setSubmitting(true);
    const updates = {};
    const trimmedName = name.trim();
    updates.name = trimmedName || null;
    if (projectId && projectId !== session.projectId) {
      updates.projectId = projectId;
    }
    updateSession(session.id, updates);
    // Modal closes when SESSION_UPDATED is received
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') closeEditSessionModal();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave();
  }

  if (!editSessionModalOpen.value || !session) return null;

  const singleProject = allProjects.length <= 1;

  return html`
    <div
      class="dialog-overlay"
      onClick=${closeEditSessionModal}
      onKeyDown=${handleKeyDown}
      style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:200;"
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit Session"
        onClick=${e => e.stopPropagation()}
        style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);width:min(440px,95vw);display:flex;flex-direction:column;max-height:90vh;"
      >
        <!-- Header -->
        <div class="dlg-header" style="display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <h2 style="font-size:15px;font-weight:600;color:var(--text-bright);flex:1;margin:0;">
            Edit Session
          </h2>
          <button
            onClick=${closeEditSessionModal}
            style="font-size:20px;color:var(--text-muted);background:none;border:none;cursor:pointer;line-height:1;padding:0;"
          >×</button>
        </div>

        <!-- Body -->
        <div class="dlg-body" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;">

          <!-- Session name -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Session Name</label>
            <input
              class="form-input"
              value=${name}
              onInput=${e => setName(e.target.value)}
              placeholder="e.g. auth refactor"
              style="width:100%;padding:8px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;box-sizing:border-box;"
            />
          </div>

          <!-- Project assignment -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Project</label>
            <select
              class="form-input"
              value=${projectId}
              onChange=${e => setProjectId(e.target.value)}
              disabled=${singleProject}
              style="width:100%;padding:8px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:${singleProject ? 'var(--text-muted)' : 'var(--text-primary)'};font-size:13px;box-sizing:border-box;cursor:${singleProject ? 'not-allowed' : 'pointer'};opacity:${singleProject ? 0.6 : 1};"
            >
              ${allProjects.map(p => html`
                <option key=${p.id} value=${p.id}>${p.name}</option>
              `)}
            </select>
            ${singleProject ? html`
              <div class="form-help" style="font-size:11px;color:var(--text-muted);margin-top:3px;">
                Create another project to move sessions between them.
              </div>
            ` : null}
          </div>

        </div>

        <!-- Footer -->
        <div class="dlg-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border);flex-shrink:0;">
          <button
            class="btn btn-ghost"
            onClick=${closeEditSessionModal}
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
