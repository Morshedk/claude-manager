// public/js/components/SessionLogPane.js
import { html } from 'htm/preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { openFileInThirdSpace, showToast } from '../state/actions.js';
import { copyText } from '../utils/clipboard.js';

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

function renderLineWithPaths(line, color) {
  const parts = [];
  let lastIdx = 0;
  let m;
  FILE_PATH_RE.lastIndex = 0;
  while ((m = FILE_PATH_RE.exec(line)) !== null) {
    if (m.index > lastIdx) parts.push(line.slice(lastIdx, m.index));
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

function renderLine(line, i, isNew) {
  const className = isNew ? 'log-line-new' : undefined;
  const parts = line.split(' | ');
  if (line.startsWith('===') && parts.length >= 2) {
    const rawTs = parts[1]?.trim();
    const isIso = rawTs && /^\d{4}-\d{2}-\d{2}T/.test(rawTs);
    const timeStr = isIso ? formatTimestamp(rawTs) : null;
    const displayText = timeStr ? parts[0] + ' | ' + parts.slice(2).join(' | ') : line;
    return html`<div key=${i} class=${className} style="display:flex;gap:8px;align-items:baseline;">
      ${timeStr ? html`<span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);flex-shrink:0;letter-spacing:0.02em;opacity:0.85;">${timeStr}</span>` : null}
      <span style="color:var(--warning);">${renderLineWithPaths(displayText, 'var(--warning)')}</span>
    </div>`;
  }
  return html`<div key=${i} class=${className} style=${'color:' + lineColor(line) + ';'}>${renderLineWithPaths(line, lineColor(line))}</div>`;
}

/**
 * SessionLogPane — scrollable event log for a session.
 *
 * @param {string}  sessionId
 * @param {boolean} [collapsed=false] — when true, renders a single-line summary (latest event only)
 */
export function SessionLogPane({ sessionId, collapsed = false }) {
  const [entries, setEntries] = useState([]); // { line: string, isNew: boolean }[]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const bottomRef = useRef(null);
  const lastBottomLineRef = useRef('');

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
        setEntries([]);
        setError(null);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const newLines = data.lines || [];

      setEntries(prev => {
        const lastSeen = lastBottomLineRef.current;

        // Find where new content starts by searching for lastSeen from the end
        let firstNewIdx = newLines.length; // default: nothing is new
        if (lastSeen) {
          for (let i = newLines.length - 1; i >= 0; i--) {
            if (newLines[i] === lastSeen) {
              firstNewIdx = i + 1;
              break;
            }
          }
          // If lastSeen not found and we have prev entries, log may have rotated —
          // treat all as old to avoid a burst animation on rotation
          if (firstNewIdx === newLines.length && prev.length > 0) {
            firstNewIdx = newLines.length;
          }
        } else {
          // First load: no animation on initial render
          firstNewIdx = newLines.length;
        }

        if (newLines.length > 0) {
          lastBottomLineRef.current = newLines[newLines.length - 1];
        }

        return newLines.map((line, i) => ({ line, isNew: i >= firstNewIdx }));
      });

      setError(null);
      const wasAtBottom = isAtBottom();
      if (wasAtBottom) {
        requestAnimationFrame(() => scrollToBottom());
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [sessionId, isAtBottom, scrollToBottom]);

  useEffect(() => {
    setEntries([]);
    setLoading(true);
    lastBottomLineRef.current = '';
    fetchTail();
    const interval = setInterval(fetchTail, 2000);
    return () => clearInterval(interval);
  }, [sessionId]);

  useEffect(() => {
    if (!loading && entries.length > 0) scrollToBottom();
  }, [loading]);

  // Collapsed mode: single-line summary showing latest event
  if (collapsed) {
    const latestLine = entries.length > 0 ? entries[entries.length - 1].line : null;
    return html`
      <div style="display:flex;align-items:center;padding:0 12px;height:100%;gap:8px;overflow:hidden;">
        ${latestLine
          ? html`<span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${latestLine}</span>`
          : html`<span style="font-size:11px;color:var(--text-muted);font-style:italic;">No events yet — drag handle down to expand</span>`
        }
      </div>
    `;
  }

  return html`
    <div style="display:flex;flex-direction:column;height:100%;background:var(--bg-base);overflow:hidden;">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:8px;padding:0 12px;height:32px;background:var(--bg-surface);border-bottom:1px solid var(--border);flex-shrink:0;">
        <span style="font-size:12px;font-weight:600;color:var(--text-bright);">Session Events</span>
        <div style="flex:1;"></div>
        ${loading ? html`<span style="font-size:10px;color:var(--text-muted);">Loading…</span>` : null}
        <button
          onClick=${() => {
            if (entries.length === 0) return;
            copyText(entries.map(e => e.line).join('\n')).then(
              () => showToast('Copied to clipboard', 'success'),
              () => showToast('Copy failed', 'error'),
            );
          }}
          style="font-size:11px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 7px;cursor:pointer;"
          title="Copy all log lines"
        >⎘ Copy</button>
        <a
          href=${`/api/sessionlog/${sessionId}/full`}
          download
          style="font-size:11px;color:var(--text-muted);text-decoration:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 7px;cursor:pointer;"
        >↓ Download</a>
      </div>

      <!-- Log body -->
      <div ref=${containerRef} style="flex:1;min-height:0;overflow-y:auto;padding:8px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;">
        ${entries.length === 0 && !loading ? html`
          <span style="color:var(--text-muted);font-style:italic;">No log yet — waiting for session output…</span>
        ` : null}
        ${error ? html`<span style="color:var(--danger);">Error: ${error}</span>` : null}
        ${entries.map(({ line, isNew }, i) => renderLine(line, i, isNew))}
        <div ref=${bottomRef}></div>
      </div>
    </div>
  `;
}
