import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { showToast } from '../state/actions.js';
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
 * Left pane: directory listing with breadcrumb navigation.
 * Right pane: file content viewer (text with line numbers, markdown, image preview).
 * Props: { projectId, projectPath }
 */
export function FileBrowser({ projectId, projectPath }) {
  const [currentPath, setCurrentPath] = useState(projectPath || '/');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeFile, setActiveFile] = useState(null);
  const [fileContent, setFileContent] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);

  // Load directory on mount and when currentPath changes
  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath]);

  async function loadDirectory(dirPath) {
    setLoading(true);
    setActiveFile(null);
    setFileContent(null);
    setImageUrl(null);
    setFileError(null);
    try {
      const res = await fetch(`/api/fs/ls?path=${encodeURIComponent(dirPath)}&projectPath=${encodeURIComponent(projectPath)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Failed to list directory');
      }
      const data = await res.json();
      setEntries(Array.isArray(data) ? data : (data.entries || []));
    } catch (e) {
      setEntries([]);
      showToast('Failed to load directory: ' + e.message, 'error');
    }
    setLoading(false);
  }

  async function loadFile(filePath) {
    const fileName = filePath.split('/').pop();
    setActiveFile(filePath);
    setFileContent(null);
    setImageUrl(null);
    setFileError(null);
    setContentLoading(true);

    if (isImageFile(fileName)) {
      setImageUrl(`/api/fs/image?path=${encodeURIComponent(filePath)}&projectPath=${encodeURIComponent(projectPath)}`);
      setFileContent('__image__');
      setContentLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}&projectPath=${encodeURIComponent(projectPath)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setFileError(err.error || 'Failed to read file');
        setContentLoading(false);
        return;
      }
      const text = await res.text();
      setFileContent(text);
    } catch (e) {
      setFileError('Failed to load file: ' + e.message);
    }
    setContentLoading(false);
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
      loadFile(fullPath);
    }
  }

  const fileName = activeFile ? activeFile.split('/').pop() : '';
  const fileExt = fileName.split('.').pop().toLowerCase();

  return html`
    <div class="file-browser" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- Breadcrumbs -->
      <div class="fb-header" style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap;">
        ${segments.map((seg, i) => html`
          ${i > 0 ? html`<span class="fb-breadcrumb-sep" style="color:var(--text-muted);font-size:12px;">›</span>` : null}
          <span
            class=${'fb-breadcrumb' + (i === segments.length - 1 ? ' fb-breadcrumb-current' : '')}
            style=${`font-size:12px;cursor:${i === segments.length - 1 ? 'default' : 'pointer'};color:${i === segments.length - 1 ? 'var(--text-primary)' : 'var(--accent)'};`}
            onClick=${i === segments.length - 1 ? null : () => navigateToBreadcrumb(i)}
          >${seg}</span>
        `)}
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
                <!-- Content header with filename + open-in-new-tab -->
                <div class="fb-content-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;font-size:13px;">
                  <span>${getFileIcon(fileName, 'file')}</span>
                  <span style="flex:1;color:var(--text-bright);font-weight:500;">${fileName}</span>
                  <button
                    class="fb-open-newtab"
                    title="Open in new tab"
                    onClick=${() => {
                      if (isImageFile(fileName)) {
                        window.open(`/api/fs/image?path=${encodeURIComponent(activeFile)}&projectPath=${encodeURIComponent(projectPath)}`, '_blank');
                      } else {
                        window.open(`/api/fs/read?path=${encodeURIComponent(activeFile)}&projectPath=${encodeURIComponent(projectPath)}`, '_blank');
                      }
                    }}
                    style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-secondary);cursor:pointer;"
                  >Open ↗</button>
                </div>

                <!-- Content body -->
                <div class="fb-content-body" style="flex:1;overflow:auto;min-height:0;">
                  ${contentLoading
                    ? html`<div style="padding:12px;color:var(--text-muted);font-size:12px;">Loading…</div>`
                    : fileError
                      ? html`<div class="fb-content-error" style="padding:12px;color:var(--danger);font-size:12px;">${fileError}</div>`
                      : fileContent === '__image__' && imageUrl
                        ? html`
                            <div class="fb-image-preview" style="padding:16px;display:flex;justify-content:center;">
                              <img
                                src=${imageUrl}
                                alt=${fileName}
                                style="max-width:100%;max-height:calc(100vh - 200px);object-fit:contain;border-radius:var(--radius);"
                                onError=${(e) => { e.target.replaceWith(Object.assign(document.createElement('div'), { className: 'fb-content-error', textContent: 'Failed to load image', style: 'color:var(--danger);padding:12px;font-size:12px;' })); }}
                              />
                            </div>
                          `
                        : fileContent !== null && fileExt === 'md'
                          ? html`<div class="fb-markdown" style="padding:16px;max-width:800px;" dangerouslySetInnerHTML=${{ __html: typeof marked !== 'undefined' ? (() => { const d = marked.parse(fileContent); return d; })() : `<pre>${fileContent}</pre>` }} />`
                          : fileContent !== null
                            ? html`
                                <div class="fb-code" style="font-family:var(--font-mono);font-size:12px;line-height:1.5;">
                                  ${fileContent.split('\n').map((line, i) => html`
                                    <div key=${i} class="fb-code-line" style="display:flex;">
                                      <span class="fb-code-linenum" style="min-width:40px;padding:0 8px;color:var(--text-muted);text-align:right;user-select:none;border-right:1px solid var(--border);flex-shrink:0;">${i + 1}</span>
                                      <span class="fb-code-text" style="padding:0 12px;white-space:pre;color:var(--text-primary);">${line}</span>
                                    </div>
                                  `)}
                                </div>
                              `
                            : null
                  }
                </div>
              `
          }
        </div>
      </div>
    </div>
  `;
}
