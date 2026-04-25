import { html } from 'htm/preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);

function isImageFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * MarkdownView — renders HTML-parsed markdown with delegated link-click prevention.
 * Prevents internal <a> clicks from navigating the SPA (mirrors viewer.js lines 58-61).
 */
function MarkdownView({ content }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => {
      const a = e.target.closest('a');
      if (a) e.preventDefault();
    };
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, []);

  return html`<div
    ref=${containerRef}
    class="fb-markdown"
    style="padding:16px;max-width:800px;"
    dangerouslySetInnerHTML=${{ __html: content }}
  />`;
}

/**
 * FileContentView — shared file content renderer.
 * Handles loading, error, image preview, markdown, and code-with-line-numbers.
 * Props: { path, projectPath }
 * Used by FileBrowser (right pane) and FileSplitPane (split pane body).
 */
const PREVIEW_EXTENSIONS = new Set(['html', 'md']);

const previewToggleStyle = (active) => `
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: ${active ? 'var(--bg-raised)' : 'transparent'};
  color: ${active ? 'var(--accent)' : 'var(--text-muted)'};
  font-size: 11px;
  font-family: var(--font-sans);
  cursor: pointer;
`;

export function FileContentView({ path, projectPath }) {
  const [fileContent, setFileContent] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [preview, setPreview] = useState(false);
  const abortRef = useRef(null);
  const markdownRef = useRef(null);

  const fileName = path ? path.split('/').pop() : '';
  const fileExt = fileName.split('.').pop().toLowerCase();
  const canPreview = PREVIEW_EXTENSIONS.has(fileExt);

  useEffect(() => {
    if (!path || !projectPath) return;

    // Cancel any in-flight fetch
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setFileContent(null);
    setImageUrl(null);
    setFileError(null);
    setContentLoading(true);

    if (isImageFile(fileName)) {
      setImageUrl(`/api/fs/image?path=${encodeURIComponent(path)}&projectPath=${encodeURIComponent(projectPath)}`);
      setFileContent('__image__');
      setContentLoading(false);
      return;
    }

    fetch(`/api/fs/read?path=${encodeURIComponent(path)}&projectPath=${encodeURIComponent(projectPath)}`, { signal: controller.signal })
      .then(res => {
        if (!res.ok) {
          return res.json().catch(() => ({ error: res.statusText })).then(err => {
            throw Object.assign(new Error(err.error || 'Failed to read file'), { status: res.status });
          });
        }
        return res.text();
      })
      .then(text => {
        if (!controller.signal.aborted) {
          setFileContent(text);
          setContentLoading(false);
        }
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        setFileError(err.message || 'Failed to load file');
        setContentLoading(false);
      });

    return () => controller.abort();
  }, [path, projectPath]);

  if (contentLoading) {
    return html`<div style="padding:12px;color:var(--text-muted);font-size:12px;">Loading…</div>`;
  }

  if (fileError) {
    return html`<div class="fb-content-error" style="padding:12px;color:var(--danger);font-size:12px;">${fileError}</div>`;
  }

  if (fileContent === '__image__' && imageUrl) {
    return html`
      <div class="fb-image-preview" style="padding:16px;display:flex;justify-content:center;">
        <img
          src=${imageUrl}
          alt=${fileName}
          style="max-width:100%;max-height:calc(100vh - 200px);object-fit:contain;border-radius:var(--radius);"
          onError=${(e) => {
            e.target.replaceWith(Object.assign(document.createElement('div'), {
              className: 'fb-content-error',
              textContent: 'Failed to load image',
              style: 'color:var(--danger);padding:12px;font-size:12px;',
            }));
          }}
        />
      </div>
    `;
  }

  if (fileContent !== null) {
    const toggleBar = canPreview ? html`
      <div style="display:flex;gap:4px;padding:4px 8px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg-surface);">
        <button style=${previewToggleStyle(!preview)} onClick=${() => setPreview(false)}>Source</button>
        <button style=${previewToggleStyle(preview)} onClick=${() => setPreview(true)}>Preview</button>
      </div>
    ` : null;

    // HTML preview — render in sandboxed iframe
    if (preview && fileExt === 'html') {
      return html`
        <div style="display:flex;flex-direction:column;height:100%;">
          ${toggleBar}
          <iframe
            srcdoc=${fileContent}
            sandbox="allow-scripts"
            style="flex:1;width:100%;border:none;background:#fff;"
          />
        </div>
      `;
    }

    // Markdown preview
    if (fileExt === 'md') {
      const rendered = typeof marked !== 'undefined' ? marked.parse(fileContent) : null;
      if (rendered !== null) {
        return html`
          <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
            ${toggleBar}
            <div style="flex:1;overflow:auto;min-height:0;">
              ${preview
                ? html`<${MarkdownView} content=${rendered} />`
                : html`
                    <div class="fb-code" style="font-family:var(--font-mono);font-size:12px;line-height:1.5;">
                      ${fileContent.split('\n').map((line, i) => html`
                        <div key=${i} class="fb-code-line" style="display:flex;">
                          <span class="fb-code-linenum" style="min-width:40px;padding:0 8px;color:var(--text-muted);text-align:right;user-select:none;border-right:1px solid var(--border);flex-shrink:0;">${i + 1}</span>
                          <span class="fb-code-text" style="padding:0 12px;white-space:pre;color:var(--text-primary);">${line}</span>
                        </div>
                      `)}
                    </div>
                  `
              }
            </div>
          </div>
        `;
      }
    }

    // Default: code with line numbers
    return html`
      <div class="fb-code" style="font-family:var(--font-mono);font-size:12px;line-height:1.5;">
        ${fileContent.split('\n').map((line, i) => html`
          <div key=${i} class="fb-code-line" style="display:flex;">
            <span class="fb-code-linenum" style="min-width:40px;padding:0 8px;color:var(--text-muted);text-align:right;user-select:none;border-right:1px solid var(--border);flex-shrink:0;">${i + 1}</span>
            <span class="fb-code-text" style="padding:0 12px;white-space:pre;color:var(--text-primary);">${line}</span>
          </div>
        `)}
      </div>
    `;
  }

  return null;
}
