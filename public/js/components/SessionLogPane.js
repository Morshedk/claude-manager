// public/js/components/SessionLogPane.js
import { html } from 'htm/preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { openFileInThirdSpace } from '../state/actions.js';

const FILE_PATH_RE = /((?:\/|~\/)[\w.\-/]+\.\w[\w]*)/g;

function lineColor(line) {
  if (line.startsWith('===')) return 'var(--warning)';
  if (line.startsWith('---')) return 'var(--text-muted)';
  return 'var(--text-secondary)';
}

function formatTimestamp(iso) {
  const t = iso.split('T')[1];
  return t ? t.replace('Z', '').split('.')[0] : iso;
}

function renderLine(line, i) {
  const parts = line.split(' | ');
  if (line.startsWith('===') && parts.length >= 2) {
    const rawTs = parts[1]?.trim();
    const isIso = rawTs && /^\d{4}-\d{2}-\d{2}T/.test(rawTs);
    const timeStr = isIso ? formatTimestamp(rawTs) : null;
    const displayText = timeStr ? parts[0] + ' | ' + parts.slice(2).join(' | ') : line;
    return html`<div key=${i} style="display:flex;gap:8px;align-items:baseline;">
      ${timeStr ? html`<span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);flex-shrink:0;letter-spacing:0.02em;opacity:0.85;">${timeStr}</span>` : null}
      <span style="color:var(--warning);">${renderLineWithPaths(displayText, 'var(--warning)')}</span>
    </div>`;
  }
  return html`<div key=${i} style=${'color:' + lineColor(line) + ';'}>${renderLineWithPaths(line, lineColor(line))}</div>`;
}

function renderLineWithPaths(line, color) {
  const parts = [];
  let lastIdx = 0;
  let m;
  FILE_PATH_RE.lastIndex = 0;
  while ((m = FILE_PATH_RE.exec(line)) !== null) {
    if (m.index > lastIdx) {
      parts.push(line.slice(lastIdx, m.index));
    }
    const path = m[0];
    parts.push(html`<span
      style="color:var(--accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px;"
      onClick=${() => openFileInThirdSpace(path)}
      title=${'Open ' + path}
    >${path}</span>`);
    lastIdx = m.index + path.length;
  }
  if (lastIdx < line.length) parts.push(line.slice(lastIdx));
  return parts;
}

export function SessionLogPane({ sessionId }) {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const bottomRef = useRef(null);

  const isAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, []);

  const fetchTail = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessionlog/${sessionId}/tail?lines=500`);
      if (res.status === 404) {
        setLines([]);
        setError(null);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const newLines = data.lines || [];
      const wasAtBottom = isAtBottom();
      setLines(newLines);
      setError(null);
      if (wasAtBottom) {
        requestAnimationFrame(() => scrollToBottom());
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [sessionId, isAtBottom, scrollToBottom]);

  useEffect(() => {
    fetchTail();
    const interval = setInterval(fetchTail, 3000);
    return () => clearInterval(interval);
  }, [fetchTail]);

  // Scroll to bottom after initial load
  useEffect(() => {
    if (!loading && lines.length > 0) scrollToBottom();
  }, [loading]);

  return html`
    <div style="display:flex;flex-direction:column;height:100%;background:var(--bg-base);border-left:1px solid var(--border);overflow:hidden;">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:8px;padding:0 12px;height:32px;background:var(--bg-surface);border-bottom:1px solid var(--border);flex-shrink:0;">
        <span style="font-size:12px;font-weight:600;color:var(--text-bright);">Session Events</span>
        <div style="flex:1;"></div>
        ${loading ? html`<span style="font-size:10px;color:var(--text-muted);">Loading…</span>` : null}
        <a
          href=${`/api/sessionlog/${sessionId}/full`}
          download
          style="font-size:11px;color:var(--text-muted);text-decoration:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 7px;cursor:pointer;"
        >↓ Download</a>
      </div>

      <!-- Log body -->
      <div ref=${containerRef} style="flex:1;min-height:0;overflow-y:auto;padding:8px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;">
        ${lines.length === 0 && !loading ? html`
          <span style="color:var(--text-muted);font-style:italic;">No log yet — waiting for session output…</span>
        ` : null}
        ${error ? html`<span style="color:var(--danger);">Error: ${error}</span>` : null}
        ${lines.map((line, i) => renderLine(line, i))}
        <div ref=${bottomRef}></div>
      </div>
    </div>
  `;
}
