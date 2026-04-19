import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { showToast, openFileSplit } from '../state/actions.js';
import { attachedSessionId, fileBrowserTarget } from '../state/store.js';
import { FileContentView } from './FileContentView.js';
import { formatBytes } from '../utils/format.js';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);

function isImageFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function getFileIcon(name, type) {
  if (type === 'dir') return '📁';
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    md: '📝', txt: '📄', js: '🟨', ts: '🔷', json: '📋', html: '🌐', css: '🎨',
    py: '🐍', rb: '💎', go: '🔵', rs: '🦀', sh: '⚙️', yml: '📐', yaml: '📐',
    toml: '📐', xml: '📰', svg: '🖼️', png: '🖼️', jpg: '🖼️', gif: '🖼️',
    lock: '🔒', env: '🔑', log: '📊',
  };
  return icons[ext] || '📄';
}

/**
 * FileBrowser — two-pane file browser component.
 * Left pane: directory listing with breadcrumb navigation + path input.
 * Right pane: FileContentView (delegated rendering).
 * Props: { projectId, projectPath }
 */
export function FileBrowser({ projectId, projectPath }) {
  const [currentPath, setCurrentPath] = useState(projectPath || '/');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeFile, setActiveFile] = useState(null);
  const [pathInput, setPathInput] = useState('');
  const dirAbortRef = useRef(null);

  // Navigate to external filepath requests (from clickable paths in terminal/events)
  const navTarget = fileBrowserTarget.value;
  useEffect(() => {
    if (!navTarget) return;
    const parts = navTarget.split('/');
    parts.pop(); // strip filename to get directory
    const dir = parts.join('/') || '/';
    loadDirectory(dir);
    setActiveFile(navTarget);
    fileBrowserTarget.value = null; // consume
  }, [navTarget]);

  // Load directory on mount and when currentPath changes
  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath]);

  async function loadDirectory(dirPath) {
    if (dirAbortRef.current) dirAbortRef.current.abort();
    const ctrl = new AbortController();
    dirAbortRef.current = ctrl;
    setLoading(true);
    setActiveFile(null);
    try {
      const res = await fetch(
        `/api/fs/ls?path=${encodeURIComponent(dirPath)}&projectPath=${encodeURIComponent(projectPath)}`,
        { signal: ctrl.signal }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Failed to list directory');
      }
      const data = await res.json();
      setEntries(Array.isArray(data) ? data : (data.entries || []));
    } catch (e) {
      if (e.name === 'AbortError') return;
      setEntries([]);
      showToast('Failed to load directory: ' + e.message, 'error');
    }
    setLoading(false);
  }

  function resolvePath(typed, base) {
    if (!typed) return null;
    if (typed.startsWith('/')) return typed;
    return base.replace(/\/$/, '') + '/' + typed;
  }

  async function submitPathInput(typed) {
    const trimmed = typed.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('~') || trimmed.startsWith('$')) {
      showToast('Absolute paths only — ~ and $ variables are not supported', 'error');
      return;
    }
    const fullPath = resolvePath(trimmed, currentPath);
    if (!fullPath) return;

    // Trailing slash → treat as directory shortcut
    if (trimmed.endsWith('/')) {
      setCurrentPath(fullPath.replace(/\/$/, ''));
      setPathInput('');
      return;
    }

    try {
      const res = await fetch(
        `/api/fs/read?path=${encodeURIComponent(fullPath)}&projectPath=${encodeURIComponent(projectPath)}`
      );
      if (res.status === 200) {
        const dirPart = fullPath.split('/').slice(0, -1).join('/');
        setCurrentPath(dirPart || projectPath);
        setActiveFile(fullPath);
        setPathInput('');
      } else if (res.status === 400) {
        // Not a file — treat as directory
        setCurrentPath(fullPath);
        setPathInput('');
      } else if (res.status === 403) {
        showToast('Access denied', 'error');
      } else if (res.status === 404) {
        showToast('File not found', 'error');
      } else if (res.status === 413) {
        showToast('File too large to display', 'warning');
      } else if (res.status === 415) {
        const dirPart = fullPath.split('/').slice(0, -1).join('/');
        setCurrentPath(dirPart || projectPath);
        setActiveFile(fullPath);
        setPathInput('');
      } else {
        showToast(`Unexpected response: ${res.status}`, 'error');
      }
    } catch (e) {
      showToast('Network error: ' + e.message, 'error');
    }
  }

  // Build breadcrumbs
  const relPath = currentPath.startsWith(projectPath)
    ? currentPath.slice(projectPath.length).replace(/^\//, '')
    : currentPath;
  const projectName = projectPath.split('/').pop() || 'root';
  const segments = [projectName, ...relPath.split('/').filter(Boolean)];

  function navigateToBreadcrumb(idx) {
    if (idx === 0) {
      setCurrentPath(projectPath);
    } else {
      const target = projectPath + '/' + segments.slice(1, idx + 1).join('/');
      setCurrentPath(target);
    }
  }

  function handleEntryClick(item) {
    const fullPath = currentPath + '/' + item.name;
    if (item.type === 'dir') {
      setCurrentPath(fullPath);
    } else {
      setActiveFile(fullPath);
    }
  }

  const fileName = activeFile ? activeFile.split('/').pop() : '';
  const sessionAttached = !!attachedSessionId.value;

  return html`
    <div class="file-browser" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- Header row 1: breadcrumbs -->
      <div class="fb-header" style="padding:6px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap;">
        ${segments.map((seg, i) => html`
          ${i > 0 ? html`<span class="fb-breadcrumb-sep" style="color:var(--text-muted);font-size:12px;">›</span>` : null}
          <span
            class=${'fb-breadcrumb' + (i === segments.length - 1 ? ' fb-breadcrumb-current' : '')}
            style=${`font-size:12px;cursor:${i === segments.length - 1 ? 'default' : 'pointer'};color:${i === segments.length - 1 ? 'var(--text-primary)' : 'var(--accent)'};`}
            onClick=${i === segments.length - 1 ? null : () => navigateToBreadcrumb(i)}
          >${seg}</span>
        `)}
      </div>

      <!-- Header row 2: path input -->
      <div style="padding:4px 12px;border-bottom:1px solid var(--border);flex-shrink:0;">
        <input
          class="fb-path-input"
          type="text"
          aria-label="File path"
          placeholder="Type a path and press Enter…"
          value=${pathInput}
          onInput=${e => setPathInput(e.target.value)}
          onKeyDown=${e => {
            if (e.key === 'Enter') submitPathInput(pathInput);
            if (e.key === 'Escape') setPathInput('');
          }}
          style="width:100%;box-sizing:border-box;font-family:var(--font-mono);font-size:11px;padding:4px 8px;background:var(--bg-deep);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);outline:none;"
        />
      </div>

      <!-- Body: two-pane -->
      <div class="fb-body" style="flex:1;display:flex;overflow:hidden;min-height:0;">

        <!-- Left: file list -->
        <div class="fb-list-panel file-list" style="width:240px;min-width:160px;max-width:400px;overflow-y:auto;border-right:1px solid var(--border);flex-shrink:0;">
          ${loading
            ? html`<div style="padding:12px;color:var(--text-muted);font-size:12px;">Loading…</div>`
            : entries.length === 0
              ? html`<div class="fb-empty" style="padding:12px;color:var(--text-muted);font-size:12px;">Empty directory</div>`
              : entries.map(item => {
                  const fullPath = currentPath + '/' + item.name;
                  const isActive = activeFile === fullPath;
                  return html`
                    <div
                      key=${item.name}
                      class=${'fb-entry' + (isActive ? ' active' : '')}
                      onClick=${() => handleEntryClick(item)}
                      style=${`display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.04));background:${isActive ? 'var(--bg-active,rgba(255,255,255,0.06))' : 'transparent'};`}
                    >
                      <span class="fb-entry-icon" style="flex-shrink:0;">${getFileIcon(item.name, item.type)}</span>
                      <span class="fb-entry-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${item.type === 'dir' ? 'var(--text-bright)' : 'var(--text-primary)'};">${item.name}</span>
                      ${item.type === 'file' ? html`<span class="fb-entry-meta" style="color:var(--text-muted);flex-shrink:0;">${formatBytes(item.size || 0)}</span>` : null}
                    </div>
                  `;
                })
          }
        </div>

        <!-- Right: content panel -->
        <div class="fb-content-panel file-content" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;">
          ${!activeFile
            ? html`<div class="fb-content-empty" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">Select a file to view its contents</div>`
            : html`
                <!-- Content header -->
                <div class="fb-content-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;font-size:13px;">
                  <span>${getFileIcon(fileName, 'file')}</span>
                  <span style="flex:1;color:var(--text-bright);font-weight:500;">${fileName}</span>
                  <button
                    class="fb-open-newtab"
                    title="Open in new tab"
                    onClick=${() => {
                      const params = `path=${encodeURIComponent(activeFile)}&projectPath=${encodeURIComponent(projectPath)}`;
                      window.open(`/viewer.html?${params}`, '_blank');
                    }}
                    style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-secondary);cursor:pointer;"
                  >Open in new tab ↗</button>
                  <button
                    class="fb-split-btn"
                    title=${sessionAttached ? 'Close the session overlay first to use split view' : 'Open in split view'}
                    disabled=${sessionAttached}
                    onClick=${() => { if (!sessionAttached) openFileSplit(activeFile, projectPath); }}
                    style=${`font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:${sessionAttached ? 'var(--text-muted)' : 'var(--text-secondary)'};cursor:${sessionAttached ? 'not-allowed' : 'pointer'};opacity:${sessionAttached ? '0.5' : '1'};`}
                  >Split</button>
                </div>

                <!-- Content body delegated to FileContentView -->
                <div class="fb-content-body" style="flex:1;overflow:auto;min-height:0;">
                  <${FileContentView} path=${activeFile} projectPath=${projectPath} />
                </div>
              `
          }
        </div>
      </div>
    </div>
  `;
}
