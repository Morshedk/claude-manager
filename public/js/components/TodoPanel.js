import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { showToast } from '../state/actions.js';
import { timeAgo } from '../utils/format.js';

/**
 * TodoPanel — todo list for a project.
 * Grid of todo items with priority colors, checkbox to complete, × to delete.
 * Add form at bottom, reward claim for completed items.
 * Props: { projectId }
 */
export function TodoPanel({ projectId }) {
  const [items, setItems] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filterPriority, setFilterPriority] = useState('all');
  const [filterStatus, setFilterStatus] = useState('pending');
  const [showAddForm, setShowAddForm] = useState(false);

  // Add form state
  const [addTitle, setAddTitle] = useState('');
  const [addPriority, setAddPriority] = useState('medium');
  const [addEstimate, setAddEstimate] = useState('');
  const [addBlocked, setAddBlocked] = useState('');

  useEffect(() => {
    if (projectId) loadTodos();
  }, [projectId]);

  async function loadTodos() {
    setLoading(true);
    try {
      const data = await fetch(`/api/todos/${projectId}`).then(r => r.json());
      setItems(data.items || []);
      setUpdatedAt(data.updatedAt || null);
    } catch (e) {
      setItems([]);
    }
    setLoading(false);
  }

  async function refreshTodos() {
    showToast('Refreshing TODOs…', 'info');
    try {
      const data = await fetch(`/api/todos/${projectId}/refresh`, { method: 'POST' }).then(r => r.json());
      setItems(data.items || []);
      setUpdatedAt(data.updatedAt || null);
      showToast('TODOs refreshed', 'success');
    } catch (e) {
      showToast('Refresh failed: ' + e.message, 'error');
    }
  }

  async function toggleTodo(todoId, complete) {
    try {
      await fetch(`/api/todos/${projectId}/${todoId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: complete ? 'completed' : 'pending' }),
      });
      await loadTodos();
    } catch (e) {
      showToast('Failed to update todo', 'error');
    }
  }

  async function deleteTodo(todoId) {
    try {
      await fetch(`/api/todos/${projectId}/${todoId}`, { method: 'DELETE' });
      await loadTodos();
    } catch (e) {
      showToast('Failed to delete todo', 'error');
    }
  }

  async function addTodo() {
    const title = addTitle.trim();
    if (!title) return;
    try {
      await fetch(`/api/todos/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          priority: addPriority,
          estimate: addEstimate.trim() || '15m',
          blockedBy: addBlocked.trim() || null,
        }),
      });
      setAddTitle('');
      setAddEstimate('');
      setAddBlocked('');
      setShowAddForm(false);
      await loadTodos();
    } catch (e) {
      showToast('Failed to add todo', 'error');
    }
  }

  // Filter items
  let visibleItems = items;
  if (filterPriority !== 'all') visibleItems = visibleItems.filter(i => i.priority === filterPriority);
  if (filterStatus !== 'all') visibleItems = visibleItems.filter(i => i.status === filterStatus);

  const priorities = ['all', 'high', 'medium', 'low'];
  const statuses = ['pending', 'completed', 'all'];

  const priorityColor = { high: 'var(--danger)', medium: 'var(--warning)', low: 'var(--text-secondary)' };

  return html`
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-surface);">

      <!-- Header -->
      <div class="todo-header" style="display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0;gap:8px;">
        <div style="flex:1;">
          <span class="todo-header-title" style="font-size:14px;font-weight:600;color:var(--text-bright);">TODO List</span>
          ${updatedAt ? html`<span class="todo-header-meta" style="font-size:11px;color:var(--text-muted);margin-left:8px;">· updated ${timeAgo(updatedAt)}</span>` : null}
        </div>
        <div class="todo-header-actions" style="display:flex;gap:6px;">
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => setShowAddForm(v => !v)}
            style="font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-primary);cursor:pointer;"
          >${showAddForm ? '− Cancel' : '+ Add'}</button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${refreshTodos}
            style="font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-secondary);cursor:pointer;"
          >Refresh</button>
        </div>
      </div>

      <!-- Filters -->
      <div class="todo-filters" style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap;">
        ${priorities.map(p => html`
          <button
            key=${p}
            class=${'todo-filter-btn' + (filterPriority === p ? ' active' : '')}
            onClick=${() => setFilterPriority(p)}
            style=${`font-size:11px;padding:3px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:${filterPriority === p ? 'var(--accent)' : 'transparent'};color:${filterPriority === p ? '#000' : 'var(--text-secondary)'};cursor:pointer;`}
          >${p}</button>
        `)}
        <div class="todo-filter-sep" style="width:1px;height:16px;background:var(--border);margin:0 4px;"></div>
        ${statuses.map(s => html`
          <button
            key=${s}
            class=${'todo-filter-btn' + (filterStatus === s ? ' active' : '')}
            onClick=${() => setFilterStatus(s)}
            style=${`font-size:11px;padding:3px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:${filterStatus === s ? 'var(--accent)' : 'transparent'};color:${filterStatus === s ? '#000' : 'var(--text-secondary)'};cursor:pointer;`}
          >${s}</button>
        `)}
      </div>

      <!-- Add form (inline, above list) -->
      ${showAddForm ? html`
        <div class="todo-add-form" style="padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:8px;background:var(--bg-raised);">
          <div class="todo-add-row" style="display:flex;gap:6px;">
            <input
              value=${addTitle}
              onInput=${e => setAddTitle(e.target.value)}
              onKeyDown=${e => e.key === 'Enter' && addTodo()}
              placeholder="What needs to be done? (think smallest first step)"
              style="flex:1;padding:6px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;"
              autoFocus
            />
          </div>
          <div class="todo-add-row" style="display:flex;gap:6px;align-items:center;">
            <select
              value=${addPriority}
              onChange=${e => setAddPriority(e.target.value)}
              style="padding:6px 8px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:12px;"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <input
              value=${addEstimate}
              onInput=${e => setAddEstimate(e.target.value)}
              placeholder="Time (5m, 15m, 1h)"
              style="width:120px;padding:6px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:12px;"
            />
            <input
              value=${addBlocked}
              onInput=${e => setAddBlocked(e.target.value)}
              placeholder="Blocked by… (optional)"
              style="flex:1;padding:6px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:12px;"
            />
            <button
              onClick=${addTodo}
              style="padding:6px 14px;border-radius:var(--radius-sm);background:var(--accent);color:#000;font-weight:600;font-size:12px;cursor:pointer;border:none;"
            >Add</button>
          </div>
        </div>
      ` : null}

      <!-- List -->
      <div class="todo-list" style="flex:1;overflow-y:auto;padding:8px 14px;display:flex;flex-direction:column;gap:6px;">
        ${loading
          ? html`<div style="color:var(--text-muted);font-size:13px;padding:12px;">Loading…</div>`
          : visibleItems.length === 0 && items.length === 0
            ? html`
                <div class="todo-empty" style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:40px 0;color:var(--text-muted);">
                  <div class="todo-empty-icon" style="font-size:32px;">📋</div>
                  <span style="font-size:13px;">No TODOs yet</span>
                  <span style="font-size:11px;color:var(--text-muted);">Items will auto-generate from session activity, or add your own.</span>
                </div>
              `
            : visibleItems.length === 0
              ? html`<div class="todo-empty" style="color:var(--text-muted);font-size:13px;padding:12px 0;">No items match this filter</div>`
              : visibleItems.map(item => html`<${TodoItem} key=${item.id} item=${item} projectId=${projectId} onToggle=${toggleTodo} onDelete=${deleteTodo} />`)
        }
      </div>
    </div>
  `;
}

/** Single todo item card */
function TodoItem({ item, projectId, onToggle, onDelete }) {
  const [reward, setReward] = useState(null);
  const [rewardLoading, setRewardLoading] = useState(false);

  const isCompleted = item.status === 'completed';
  const priorityColor = { high: 'var(--danger)', medium: 'var(--warning)', low: 'var(--text-muted)' };

  async function claimReward() {
    if (reward || rewardLoading) return;
    setRewardLoading(true);
    try {
      const r = await fetch(`/api/todos/${projectId}/${item.id}/reward`).then(res => res.json());
      setReward(r);
    } catch {
      setReward(item.reward || null);
    }
    setRewardLoading(false);
  }

  return html`
    <div
      class=${'todo-item' + (isCompleted ? ' completed' : '')}
      style=${`display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-raised);opacity:${isCompleted ? 0.75 : 1};`}
    >
      <!-- Checkbox -->
      <div
        class=${'todo-checkbox' + (isCompleted ? ' checked' : '')}
        onClick=${() => onToggle(item.id, !isCompleted)}
        style=${`width:16px;height:16px;border-radius:50%;border:2px solid ${isCompleted ? 'var(--accent)' : 'var(--border)'};background:${isCompleted ? 'var(--accent)' : 'transparent'};cursor:pointer;flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;`}
      >
        ${isCompleted ? html`<span style="color:#000;font-size:10px;font-weight:700;">✓</span>` : null}
      </div>

      <!-- Body -->
      <div class="todo-body" style="flex:1;min-width:0;">
        <div class="todo-title" style=${`font-size:13px;color:var(--text-primary);${isCompleted ? 'text-decoration:line-through;' : ''}`}>${item.title}</div>
        <div class="todo-meta" style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;">
          <span
            class=${`todo-priority todo-priority-${item.priority}`}
            style=${`font-size:10px;font-weight:600;text-transform:uppercase;color:${priorityColor[item.priority] || 'var(--text-muted)'};`}
          >${item.priority}</span>
          ${item.estimate ? html`<span class="todo-estimate" style="font-size:11px;color:var(--text-muted);">${item.estimate}</span>` : null}
          ${item.blockedBy ? html`<span class="todo-blocked" style="font-size:11px;color:var(--warning);">blocked: ${item.blockedBy}</span>` : null}
          ${item.source ? html`<span class="todo-source" style="font-size:10px;color:var(--text-muted);opacity:0.6;">${item.source}</span>` : null}
          ${isCompleted && item.reward && !reward ? html`
            <button
              class="todo-reward-claim"
              onClick=${claimReward}
              disabled=${rewardLoading}
              style="font-size:11px;padding:2px 8px;border-radius:var(--radius-sm);background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;border:none;cursor:pointer;font-weight:600;"
            >${rewardLoading ? '…' : 'Claim Reward'}</button>
          ` : null}
        </div>

        <!-- Reward display -->
        ${reward ? html`
          <div class="todo-reward" style="margin-top:8px;padding:10px;background:var(--bg-surface);border-radius:var(--radius-sm);border:1px solid var(--border);">
            ${reward.type === 'video_url' ? html`
              <div class="todo-reward-text" style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">You earned a video break!</div>
              <div class="todo-reward-embed" style="position:relative;width:100%;padding-top:56.25%;">
                <iframe
                  src=${reward.content}
                  style="position:absolute;inset:0;width:100%;height:100%;border-radius:var(--radius-sm);"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullscreen
                ></iframe>
              </div>
            ` : reward.type === 'video_query' ? html`
              <div class="todo-reward-text" style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">You earned a video break! Search: ${reward.content}</div>
              <div class="todo-reward-embed" style="position:relative;width:100%;padding-top:56.25%;">
                <iframe
                  src=${`https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(reward.content)}`}
                  style="position:absolute;inset:0;width:100%;height:100%;border-radius:var(--radius-sm);"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullscreen
                ></iframe>
              </div>
            ` : html`
              <div class="todo-reward-text" style="font-size:12px;color:var(--text-secondary);">${reward.content || 'Great job completing that task!'}</div>
            `}
          </div>
        ` : null}
      </div>

      <!-- Delete -->
      <span
        class="todo-delete"
        onClick=${() => onDelete(item.id)}
        style="font-size:16px;color:var(--text-muted);cursor:pointer;flex-shrink:0;padding:0 2px;line-height:1;"
        title="Delete"
      >×</span>
    </div>
  `;
}
