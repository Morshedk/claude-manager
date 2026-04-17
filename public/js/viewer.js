/**
 * viewer.js — standalone file viewer for /viewer.html
 * No imports from app state/ws. Vanilla DOM + fetch + marked only.
 * XSS note: path/projectPath are NEVER written via innerHTML. Only textContent and .src/.href.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);

function isImageFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function basename(p) {
  return p.split('/').pop() || p;
}

function showError(msg) {
  const errEl = document.getElementById('viewer-error');
  const contentEl = document.getElementById('viewer-content');
  errEl.textContent = msg; // textContent, never innerHTML
  errEl.style.display = 'flex';
  contentEl.style.display = 'none';
}

function renderCodeWithLineNumbers(text, container) {
  const div = document.createElement('div');
  div.className = 'fb-code';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement('div');
    row.className = 'fb-code-line';

    const num = document.createElement('span');
    num.className = 'fb-code-linenum';
    num.textContent = String(i + 1);

    const code = document.createElement('span');
    code.className = 'fb-code-text';
    code.textContent = lines[i]; // textContent, never innerHTML

    row.appendChild(num);
    row.appendChild(code);
    div.appendChild(row);
  }
  container.appendChild(div);
}

function renderMarkdown(text, container) {
  const div = document.createElement('div');
  div.className = 'fb-markdown';

  if (typeof marked !== 'undefined') {
    // marked.parse is safe here: text comes from the server-returned file body,
    // not from URL parameters. path/projectPath never flow into innerHTML.
    div.innerHTML = marked.parse(text);
    // Disable all internal link clicks (relative links would break in /viewer.html context)
    div.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (a) e.preventDefault();
    });
  } else {
    // Graceful fallback: line-numbered plain text
    renderCodeWithLineNumbers(text, container);
    return;
  }

  container.appendChild(div);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const filePath = params.get('path');
  const projectPath = params.get('projectPath');

  const filenameEl = document.getElementById('viewer-filename');
  const contentEl = document.getElementById('viewer-content');

  if (!filePath || !projectPath) {
    filenameEl.textContent = 'File Viewer';
    showError('Missing file path');
    return;
  }

  const name = basename(filePath);
  // XSS-safe: document.title is not HTML-parsed; filenameEl uses textContent
  document.title = name;
  filenameEl.textContent = name;

  if (isImageFile(name)) {
    const img = document.createElement('img');
    // img.src is a URL, not HTML — safe to set from encoded query params
    img.src = '/api/fs/image?path=' + encodeURIComponent(filePath) + '&projectPath=' + encodeURIComponent(projectPath);
    img.alt = name;
    const wrap = document.createElement('div');
    wrap.className = 'fb-image-preview';
    img.onerror = () => showError('Failed to load image');
    wrap.appendChild(img);
    contentEl.appendChild(wrap);
    return;
  }

  // Fetch text content
  let res;
  try {
    res = await fetch('/api/fs/read?path=' + encodeURIComponent(filePath) + '&projectPath=' + encodeURIComponent(projectPath));
  } catch (err) {
    showError('Failed to load file: ' + err.message);
    return;
  }

  if (!res.ok) {
    let msg;
    try {
      const body = await res.json();
      msg = body.error || res.statusText;
    } catch {
      msg = res.statusText || ('HTTP ' + res.status);
    }
    showError('Failed to load file: ' + msg + ' (status ' + res.status + ')');
    return;
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    showError('Failed to read response: ' + err.message);
    return;
  }

  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'md') {
    renderMarkdown(text, contentEl);
  } else {
    renderCodeWithLineNumbers(text, contentEl);
  }
}

main();
