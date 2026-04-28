# Session UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move events panel to top of terminal overlay with a resize handle, make session feed show clean log data with stream-like animation, and fix the command Send button so it actually executes without needing a second Return press.

**Architecture:** Three independent changes executed in order. Change 3 (command send) is a 2-line fix. Change 1 (events at top) is UI-only in SessionOverlay.js. Change 2 (snapshot-based feed) enhances SessionLogManager on the server and SessionLogPane on the client — session cards also switch to reading from the log rather than raw PTY capture. Option 2A (enhanced polling) is implemented first and validated against UAT-5; Option 2B (WS snapshot push) is only implemented if 2A fails.

**Tech Stack:** Preact + htm (frontend), Node.js/Express (backend), existing WebSocket infrastructure, existing SessionLogManager, CSS animations (no external libraries)

**Spec:** `docs/superpowers/specs/2026-04-27-session-ux-improvements-design.md`

---

## File Map

| File | Change |
|------|--------|
| `public/js/components/CommandBuffer.js` | Remove bracket-paste, add `\r` (lines 31, 68) |
| `public/js/components/SessionOverlay.js` | Move events strip to top, add resize handle, remove bottom tab bar |
| `public/js/components/SessionLogPane.js` | Accept `collapsed` prop, reduce poll to 2s, add diff animation |
| `public/css/` | Add `log-line-new` CSS animation (check if a single CSS file exists) |
| `lib/sessionlog/SessionLogManager.js` | Add time-gap detection in `_processSession()`, improve `injectEvent` format |
| `lib/sessions/SessionManager.js` | Call `injectEvent` for session START; wire card preview to log data |
| `lib/ws/handlers/sessionHandlers.js` | Call `injectEvent` CLIENT:CONNECT on subscription |
| `tests/adversarial/` | UAT playwright tests |

---

## Task 1: Fix Command Send — Remove Bracket-Paste

**Files:**
- Modify: `public/js/components/CommandBuffer.js:31` and `:68`

- [ ] **Step 1.1: Read the current CommandBuffer send logic**

```bash
grep -n "x1b\[200" /home/claude-runner/apps/claude-web-app-v2/public/js/components/CommandBuffer.js
```
Expected: two matches at lines ~31 and ~68.

- [ ] **Step 1.2: Fix the immediate send path (line ~31)**

In `CommandBuffer.js`, find the `handleSend` function. Replace:
```js
send({ type: msgType, id: targetId, data: '\x1b[200~' + content + '\x1b[201~' });
```
With:
```js
send({ type: msgType, id: targetId, data: content + '\r' });
```

- [ ] **Step 1.3: Fix the queue drain path (line ~68)**

In the same file, inside the `drainQueue` `setTimeout` callback, replace:
```js
send({ type: msgType, id: targetId, data: '\x1b[200~' + currentItem.text + '\x1b[201~' });
```
With:
```js
send({ type: msgType, id: targetId, data: currentItem.text + '\r' });
```

- [ ] **Step 1.4: Verify no other bracket-paste occurrences remain**

```bash
grep -n "x1b\[200\|x1b\[201" /home/claude-runner/apps/claude-web-app-v2/public/js/components/CommandBuffer.js
```
Expected: no output (zero matches).

- [ ] **Step 1.5: Restart beta and smoke test via Playwright**

```bash
pm2 restart claude-v2-beta
```

Then in Playwright navigate to the app, open a session, type `echo hello` in the command buffer, click Send. Verify `hello` appears in the terminal output without needing an extra Return press.

- [ ] **Step 1.6: Commit**

```bash
git add public/js/components/CommandBuffer.js
git commit -m "fix: remove bracket-paste from CommandBuffer so Send executes commands immediately"
```

---

## Task 2: Add Time-Gap Detection to SessionLogManager

**Files:**
- Modify: `lib/sessionlog/SessionLogManager.js`

The current `_processSession()` writes raw content to the log whenever new bytes arrive in the `.raw` file. We need to detect when >30s has elapsed since the last write and inject a time-gap marker.

- [ ] **Step 2.1: Add a `_lastWriteTs` map to track last write time per session**

In the `constructor`, after `this._offsets = new Map()`:
```js
/** @type {Map<string, number>} sessionId → Date.now() of last log write */
this._lastWriteTs = new Map();
```

- [ ] **Step 2.2: Update `_processSession()` to detect time gaps and inject gap markers**

Replace the existing `_processSession` method body with:

```js
_processSession(sessionId) {
  const rawPath = join(this._logDir, `${sessionId}.raw`);
  if (!existsSync(rawPath)) return;

  let fileSize;
  try { fileSize = statSync(rawPath).size; } catch { return; }

  const lastOffset = this._offsets.get(sessionId) || 0;
  if (fileSize <= lastOffset) return;

  let content;
  try {
    const bytesToRead = fileSize - lastOffset;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(rawPath, 'r');
    let bytesRead;
    try {
      bytesRead = readSync(fd, buf, 0, bytesToRead, lastOffset);
    } finally {
      closeSync(fd);
    }
    content = buf.slice(0, bytesRead).toString('utf8');
  } catch { return; }

  const stripped = stripAnsi(content);
  const now = Date.now();
  const lastWrite = this._lastWriteTs.get(sessionId) || 0;
  const ts = new Date().toISOString();
  const logPath = join(this._logDir, `${sessionId}.log`);

  // Detect time gaps > 30s between log batches
  const GAP_THRESHOLD_MS = 30_000;
  let gapMarker = '';
  if (lastWrite > 0 && (now - lastWrite) > GAP_THRESHOLD_MS) {
    const gapSec = Math.round((now - lastWrite) / 1000);
    const gapStr = gapSec >= 60
      ? `${Math.floor(gapSec / 60)}m ${gapSec % 60}s`
      : `${gapSec}s`;
    gapMarker = `\n=== TIME_GAP | ${ts} | gap=${gapStr} ===\n`;
  }

  try {
    appendFileSync(logPath, `${gapMarker}\n--- ${ts} ---\n${stripped}`);
    this._lastWriteTs.set(sessionId, now);
  } catch { return; }

  this._offsets.set(sessionId, fileSize);
}
```

- [ ] **Step 2.3: Verify `injectEvent` format is consistent**

The current `injectEvent` writes `=== EVENT | TS | DETAILS ===`. This matches how `renderLine()` in SessionLogPane parses them (splits on `|`). Confirm the gap marker format `=== TIME_GAP | ${ts} | gap=Xm Ys ===` follows the same pattern — it does. No change needed to `injectEvent`.

- [ ] **Step 2.4: Commit**

```bash
git add lib/sessionlog/SessionLogManager.js
git commit -m "feat: detect 30s time gaps in session log and inject TIME_GAP markers"
```

---

## Task 3: Inject CLIENT:CONNECT Event on WS Session Subscribe

**Files:**
- Modify: `lib/ws/handlers/sessionHandlers.js`

When a WebSocket client subscribes to a session (e.g. after a page reload or reconnect), inject a CLIENT:CONNECT event into the log so the user can see reconnection points in the events panel.

- [ ] **Step 3.1: Inject CLIENT:CONNECT in the subscribe handler**

In `lib/ws/handlers/sessionHandlers.js`, find the `subscribe` method (line ~79). After line 109 (`this.registry.send(clientId, { type: 'session:subscribed', id })`), add:

```js
// Inject client connect marker into session log
this.sessions.sessionLogManager?.injectEvent(
  id,
  'CLIENT:CONNECT',
  `clientId=${clientId}`
);
```

`this.sessions` is the SessionManager instance (already in scope). `this.sessions.sessionLogManager` is the `SessionLogManager` instance set in the constructor.

- [ ] **Step 3.4: Commit**

```bash
git add lib/ws/handlers/sessionHandlers.js
git commit -m "feat: inject CLIENT:CONNECT event into session log on WebSocket subscribe"
```

---

## Task 4: Update SessionLogPane — 2s Poll, Diff Animation, Collapsed Mode

**Files:**
- Modify: `public/js/components/SessionLogPane.js`

Key changes:
1. Reduce poll interval from 3000ms to 2000ms
2. Track the last-seen bottom line; animate only newly appended lines
3. Accept a `collapsed` prop — when true, render a single-line summary bar instead of the full panel

- [ ] **Step 4.1: Add CSS animation to the app stylesheet**

The main stylesheet is `public/css/styles.css` (loaded by `public/index.html` line 14). Append at the end of that file:

```css
@keyframes logSlideIn {
  from { opacity: 0; transform: translateY(5px); }
  to   { opacity: 1; transform: translateY(0); }
}
.log-line-new {
  animation: logSlideIn 0.3s ease forwards;
}
```

- [ ] **Step 4.2: Replace SessionLogPane.js with the updated implementation**

```js
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
 * @param {string} sessionId
 * @param {boolean} [collapsed=false] — when true, renders a single-line summary bar (latest event only)
 */
export function SessionLogPane({ sessionId, collapsed = false }) {
  const [entries, setEntries] = useState([]); // { line: string, isNew: boolean }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const bottomRef = useRef(null);
  const lastBottomLineRef = useRef(''); // text of last line seen, for diff detection

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

        // Find where new content starts: search backwards for the last-seen line
        let firstNewIdx = newLines.length; // default: nothing is new
        if (lastSeen) {
          for (let i = newLines.length - 1; i >= 0; i--) {
            if (newLines[i] === lastSeen) {
              firstNewIdx = i + 1;
              break;
            }
          }
          // If lastSeen not found (log rotated), treat all as not-new to avoid flash
          if (firstNewIdx === newLines.length && newLines.length > 0 &&
              newLines[newLines.length - 1] !== lastSeen) {
            // Check if we actually have prev entries — if not, this is first load
            if (prev.length === 0) {
              firstNewIdx = 0; // first load: all old (no animation on initial render)
            }
            // else: log rotation, treat as all-old to avoid big animation burst
          }
        } else {
          firstNewIdx = 0; // first load: nothing is "new" (no animation)
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
    // Reset state when sessionId changes
    setEntries([]);
    setLoading(true);
    lastBottomLineRef.current = '';
    fetchTail();
    const interval = setInterval(fetchTail, 2000); // 2s poll
    return () => clearInterval(interval);
  }, [fetchTail, sessionId]);

  useEffect(() => {
    if (!loading && entries.length > 0) scrollToBottom();
  }, [loading]);

  // Collapsed mode: single-line summary
  if (collapsed) {
    const latestEvent = entries.length > 0
      ? entries[entries.length - 1].line
      : null;
    return html`
      <div style="display:flex;align-items:center;padding:0 12px;height:100%;gap:8px;overflow:hidden;">
        ${latestEvent
          ? html`<span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${latestEvent}</span>`
          : html`<span style="font-size:11px;color:var(--text-muted);font-style:italic;">No events yet</span>`
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
```

- [ ] **Step 4.3: Restart beta and verify panel still loads**

```bash
pm2 restart claude-v2-beta && pm2 logs claude-v2-beta --lines 10 --nostream
```

Open the app, navigate to any session with a log, confirm the events panel loads and shows content. If there are console errors, check browser devtools.

- [ ] **Step 4.4: Commit**

```bash
git add public/js/components/SessionLogPane.js public/css/
git commit -m "feat: add diff-based slide-in animation to SessionLogPane, reduce poll to 2s, add collapsed mode"
```

---

## Task 5: Move Events Panel to Top of Terminal Overlay with Resize Handle

**Files:**
- Modify: `public/js/components/SessionOverlay.js`

Replace the bottom tab bar + conditional events pane with a resizable events strip at the top (above the terminal). The strip defaults to 120px, collapses to 28px when dragged below 40px, and saves preference to localStorage.

- [ ] **Step 5.1: Read the full current SessionOverlay.js**

Read `public/js/components/SessionOverlay.js` fully to confirm current structure before replacing.

- [ ] **Step 5.2: Replace SessionOverlay.js**

Replace the entire file with:

```js
import { html } from 'htm/preact';
import { useRef, useState } from 'preact/hooks';
import { TerminalPane } from './TerminalPane.js';
import { SessionLogPane } from './SessionLogPane.js';
import { CommandBuffer } from './CommandBuffer.js';
import { attachedSession, splitView, splitPosition } from '../state/store.js';
import { detachSession, refreshSession, stopSession, showToast } from '../state/actions.js';

const EVENTS_COLLAPSED_HEIGHT = 28;
const EVENTS_DEFAULT_HEIGHT = 120;
const EVENTS_COLLAPSE_THRESHOLD = 44; // snap to collapsed when dragged below this

function loadEventsHeight() {
  try {
    const v = parseInt(localStorage.getItem('eventsHeight') || '0', 10);
    return v > 0 ? v : EVENTS_DEFAULT_HEIGHT;
  } catch { return EVENTS_DEFAULT_HEIGHT; }
}

function saveEventsHeight(h) {
  try { localStorage.setItem('eventsHeight', String(h)); } catch {}
}

export function SessionOverlay() {
  const session = attachedSession.value;
  if (!session) return null;

  const isSplit = splitView.value;
  const [eventsHeight, setEventsHeight] = useState(loadEventsHeight);
  const isCollapsed = eventsHeight <= EVENTS_COLLAPSE_THRESHOLD;
  const eventsResizing = useRef(false);

  const toggleSplit = () => {
    splitView.value = !splitView.value;
    try { localStorage.setItem('splitView', String(splitView.value)); } catch {}
  };

  // ── Split resize handle ──────────────────────────────────────────────────────
  const isDragging = useRef(false);

  const handleResizeMouseDown = (e) => {
    e.preventDefault();
    isDragging.current = true;
    const handle = e.currentTarget;
    handle.classList.add('dragging');

    const onMouseMove = (ev) => {
      if (!isDragging.current) return;
      const pct = Math.min(85, Math.max(20, (ev.clientX / window.innerWidth) * 100));
      document.documentElement.style.setProperty('--split-pos', pct + '%');
    };

    const onMouseUp = (ev) => {
      isDragging.current = false;
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const pct = Math.min(85, Math.max(20, (ev.clientX / window.innerWidth) * 100));
      splitPosition.value = pct;
      try { localStorage.setItem('splitPosition', String(pct)); } catch {}
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // ── Events panel vertical resize ─────────────────────────────────────────────
  const handleEventsResizeMouseDown = (e) => {
    e.preventDefault();
    eventsResizing.current = true;
    const startY = e.clientY;
    const startH = eventsHeight;

    const onMouseMove = (ev) => {
      if (!eventsResizing.current) return;
      const delta = ev.clientY - startY;
      const raw = Math.max(EVENTS_COLLAPSED_HEIGHT, Math.min(500, startH + delta));
      setEventsHeight(raw);
    };

    const onMouseUp = (ev) => {
      eventsResizing.current = false;
      const delta = ev.clientY - startY;
      const raw = Math.max(EVENTS_COLLAPSED_HEIGHT, Math.min(500, startH + delta));
      // Snap to collapsed if dragged above threshold
      const snapped = raw <= EVENTS_COLLAPSE_THRESHOLD ? EVENTS_COLLAPSED_HEIGHT : raw;
      setEventsHeight(snapped);
      saveEventsHeight(snapped);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleRefresh = () => {
    refreshSession(session.id);
    showToast('Refreshing session…', 'info');
  };

  const handleStop = () => {
    stopSession(session.id);
    showToast('Stopping session…', 'info');
  };

  const handleClose = () => detachSession();

  const displayName = session.name || session.projectName || session.id.slice(0, 8);

  const statusColor = {
    running: 'var(--accent)',
    starting: 'var(--warning)',
    stopped: 'var(--text-muted)',
    error: 'var(--danger)',
  }[session.status || session.state] || 'var(--text-muted)';

  const isActive = session.status === 'running';

  return html`
    <div
      id="session-overlay"
      style="
        position: fixed;
        ${isSplit ? 'left: var(--split-pos, 50%);' : 'left: 0;'}
        right: 0;
        top: var(--topbar-h);
        bottom: 0;
        background: var(--bg-base);
        display: flex;
        flex-direction: column;
        z-index: 100;
        border-left: ${isSplit ? '1px solid var(--border)' : 'none'};
      "
    >
      ${isSplit ? html`
        <div
          class="split-resize-handle"
          onMouseDown=${handleResizeMouseDown}
          title="Drag to resize"
        ></div>
      ` : null}

      <!-- Header -->
      <header
        class="overlay-header"
        style="
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 12px;
          height: 40px;
          background: var(--bg-surface);
          border-bottom: 1px solid var(--border);
          flex-shrink: 0;
        "
      >
        <span style="
          width: 7px; height: 7px; border-radius: 50%;
          background: ${statusColor}; flex-shrink: 0;
        "></span>

        <span
          id="overlay-title"
          style="
            font-size: 13px; font-weight: 600; color: var(--text-bright);
            flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          "
        >${displayName}</span>

        ${session.claudeSessionId ? html`
          <span
            title=${'Claude session: ' + session.claudeSessionId}
            style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); cursor: default; flex-shrink: 0;"
          >${session.claudeSessionId.slice(0, 8)}</span>
        ` : null}

        <div class="overlay-actions" style="display: flex; gap: 4px; flex-shrink: 0;">
          <button onClick=${toggleSplit} style=${btnStyle()} title=${isSplit ? 'Full screen' : 'Split view'}>
            ${isSplit ? 'Full' : 'Split'}
          </button>
          <button onClick=${handleRefresh} style=${btnStyle()} title="Refresh session">Refresh</button>
          ${isActive ? html`
            <button id="btn-session-stop" onClick=${handleStop}
              style=${btnStyle('var(--danger-bg)', 'var(--danger)')} title="Stop session">Stop</button>
          ` : null}
          <button id="btn-detach" onClick=${handleClose} style=${btnStyle()} title="Close terminal overlay">
            ✕
          </button>
        </div>
      </header>

      <!-- Events strip (top, resizable) -->
      <div
        style="
          height: ${eventsHeight}px;
          min-height: ${EVENTS_COLLAPSED_HEIGHT}px;
          flex-shrink: 0;
          overflow: hidden;
          border-bottom: 1px solid var(--border);
          background: var(--bg-base);
        "
      >
        <${SessionLogPane} sessionId=${session.id} collapsed=${isCollapsed} />
      </div>

      <!-- Vertical resize handle for events strip -->
      <div
        onMouseDown=${handleEventsResizeMouseDown}
        title="Drag to resize events panel"
        style="
          height: 6px;
          flex-shrink: 0;
          background: var(--bg-surface);
          border-bottom: 1px solid var(--border);
          cursor: row-resize;
          display: flex;
          align-items: center;
          justify-content: center;
        "
      >
        <div style="width: 32px; height: 2px; border-radius: 2px; background: var(--border);"></div>
      </div>

      <!-- Terminal body -->
      <div style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
        <div
          id="session-overlay-terminal"
          style="flex: 1; min-height: 0; overflow: hidden; position: relative;"
        >
          <${TerminalPane} sessionId=${session.id} />
        </div>

        <${CommandBuffer} targetId=${session.id} inputType="session" />
      </div>
    </div>
  `;
}

function btnStyle(bg = 'var(--bg-raised)', color = 'var(--text-secondary)') {
  return `
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: ${bg};
    color: ${color};
    font-size: 12px;
    font-family: var(--font-sans);
    cursor: pointer;
    white-space: nowrap;
  `;
}
```

- [ ] **Step 5.3: Restart beta and verify layout**

```bash
pm2 restart claude-v2-beta
```

Open the app at port 3002. Open any session. Verify:
- Events strip is at the top (above the terminal)
- No "Events" toggle button at bottom
- Strip shows session log content
- Drag handle is visible between events and terminal

Take a screenshot to verify:
```bash
# Use Playwright to take a screenshot
```

- [ ] **Step 5.4: Verify resize works**

In the browser, drag the resize handle downward — verify events strip grows and terminal shrinks. Drag upward past threshold — verify it snaps to the 28px collapsed bar with "No events yet" or latest event text.

Close and reopen the overlay — verify height preference is restored from localStorage.

- [ ] **Step 5.5: Commit**

```bash
git add public/js/components/SessionOverlay.js
git commit -m "feat: move events panel to top of terminal overlay with resizable drag handle"
```

---

## Task 6: Update Session Card Preview to Use Log Data

**Files:**
- Modify: `lib/sessions/SessionManager.js`

Currently `startPreviewInterval` calls `session.getPreviewLines(n)` which runs `tmux capture-pane` — raw PTY output (noisy, no timestamps, no event markers). Change it to use `tailLog()` from `sessionLogManager` so cards show the same clean data as the events panel.

- [ ] **Step 6.1: Read `startPreviewInterval` in SessionManager.js**

Read lines ~457–486 of `lib/sessions/SessionManager.js` to see the current implementation.

- [ ] **Step 6.2: Update `startPreviewInterval` to source from log**

Replace the body of the `setInterval` callback inside `startPreviewInterval` with:

```js
this._previewInterval = setInterval(async () => {
  let n = 20;
  try {
    if (settingsStore) {
      const v = await settingsStore.get('previewLines');
      if (typeof v === 'number' && v >= 5 && v <= 50) n = v;
    }
  } catch { /* use default */ }

  let changed = false;
  for (const session of this.sessions.values()) {
    const status = session.meta.status;
    if (status !== STATES.RUNNING && status !== STATES.STARTING) continue;
    try {
      // Prefer clean log data (filtered, includes events); fall back to raw PTY
      let lines;
      if (this.sessionLogManager) {
        const logLines = this.sessionLogManager.tailLog(session.meta.id, n);
        lines = logLines || session.getPreviewLines(n);
      } else {
        lines = session.getPreviewLines(n);
      }
      session.meta.previewLines = lines;
      changed = true;
    } catch { /* non-fatal */ }
  }

  if (changed) {
    try { broadcastFn(); } catch { /* non-fatal */ }
  }
}, 5_000); // Reduced from 20s to 5s for more responsive cards
```

- [ ] **Step 6.3: Inject SESSION:START event on session creation**

In `_wireSessionEvents()`, in the `stateChange` handler when `e.state === 'running'`, add after the existing log.info call:

```js
if (e.state === 'running') {
  log.info('sessions', 'session started', { id: session.meta.id, projectId: session.meta.projectId });
  health.signal('sessions', 'lastStart');
  this.sessionLogManager?.injectEvent(session.meta.id, 'SESSION:START', `id=${session.meta.id}`);
}
```

- [ ] **Step 6.4: Restart and verify cards show cleaner content**

```bash
pm2 restart claude-v2-beta
```

Wait 10 seconds. Check session cards — they should now show log-formatted lines (with `---` timestamp headers and `===` event markers visible) rather than raw PTY output.

- [ ] **Step 6.5: Commit**

```bash
git add lib/sessions/SessionManager.js
git commit -m "feat: session cards now show clean log data instead of raw PTY output, refresh every 5s"
```

---

## Task 7: UAT Validation — Run All Acceptance Tests

Run each UAT from the spec manually via Playwright.

### UAT-1: Command Send

- [ ] **Step 7.1: Open a session in the app**

Use Playwright to navigate to the app, open or create a session.

- [ ] **Step 7.2: Test single-line execute**

Type `echo hello` in CommandBuffer, click Send. Screenshot the terminal output. Verify `hello` appears without pressing Return in terminal.

- [ ] **Step 7.3: Test multi-line block execute**

Type this into CommandBuffer (use Shift+Enter or paste to get newlines):
```
for i in 1 2 3
do echo $i
done
```
Click Send. Verify `1`, `2`, `3` appear in terminal output.

### UAT-2: Events Panel at Top

- [ ] **Step 7.4: Verify events at top**

Open a session. Screenshot the overlay. Verify events strip is above the terminal, no bottom Events toggle exists.

- [ ] **Step 7.5: Verify resize**

Drag the handle downward by ~100px. Screenshot. Verify events strip grew and terminal shrank.

- [ ] **Step 7.6: Verify collapse**

Drag the handle all the way up (above threshold). Verify the strip collapses to 28px showing just the latest event. Verify `▼ expand` or similar affordance appears.

Reload the page, reopen the session. Verify height is restored.

### UAT-3: Events Feed Content Quality

- [ ] **Step 7.7: Verify no spinner noise**

In a running session, wait 30 seconds while Claude is working. Screenshot the events panel. Verify no lines like `⠋ Thinking`, `✻ Processing`, `   8` (bare numbers) appear.

- [ ] **Step 7.8: Verify timestamps present**

Verify `===` event lines show `HH:MM:SS` formatted timestamps.

- [ ] **Step 7.9: Verify time gap marker**

If possible, pause a session for >30s (stop it, wait, restart). Verify a `=== TIME_GAP ===` marker appears in the events panel.

- [ ] **Step 7.10: Verify animation**

With the events panel open and a session running, watch for 30s. Verify new lines appear to slide in from the bottom rather than replacing all content.

### UAT-4: Session Card Consistency

- [ ] **Step 7.11: Compare card and events panel**

Open the sessions list alongside a session overlay. Verify the session card preview shows similar content to the events panel (both sourced from the log, both filtered).

### UAT-5: 2A vs 2B Decision Gate

- [ ] **Step 7.12: Measure update latency**

With a session actively running (Claude typing output), measure time from output appearing in terminal to appearing in events panel. Should be ≤3s.

If latency is consistently >3s or animation has visible flash/jump, implement Task 8 (Option 2B — WS snapshot push). Otherwise, Option 2A (current implementation) passes — skip Task 8.

- [ ] **Step 7.13: Document result**

Write one line to `docs/decisions/2026-04-27-snapshot-approach-decision.md` with the result: `2A passed` or `2A failed, implementing 2B`.

---

## Task 8 (Conditional): Option 2B — WebSocket Snapshot Push

**Only implement if Task 7, Step 7.12 shows 2A fails UAT-5.**

**Files:**
- Modify: `lib/sessions/SessionManager.js` — emit snapshot on lastLineChange
- Modify: `lib/ws/handlers/sessionHandlers.js` — include snapshot in sessions:list payload
- Modify: `public/js/state/store.js` — add snapshotVersion tracking per session
- Modify: `public/js/components/SessionCard.js` — read from session.snapshot.lines
- Modify: `public/js/components/SessionLogPane.js` — accept snapshot prop instead of polling

- [ ] **Step 8.1: Add snapshot computation to SessionManager**

In `SessionManager`, add a method that computes a snapshot for a session:

```js
_computeSnapshot(sessionId) {
  if (!this.sessionLogManager) return null;
  const lines = this.sessionLogManager.tailLog(sessionId, 50);
  if (!lines) return null;
  const version = this._snapshotVersions?.get(sessionId) || 0;
  return { version: version + 1, lines };
}
```

Track versions in a `Map`: add `this._snapshotVersions = new Map()` to constructor.

- [ ] **Step 8.2: Push snapshot on lastLineChange**

In the `_wireSessionEvents` method, in the `lastLineChange` debounce callback:

```js
const timer = setTimeout(() => {
  this._lastLineTimers.delete(id);
  const session = this.sessions.get(id);
  if (session) {
    const snapshot = this._computeSnapshot(id);
    if (snapshot) {
      const v = (this._snapshotVersions.get(id) || 0) + 1;
      this._snapshotVersions.set(id, v);
      session.meta.snapshot = { ...snapshot, version: v };
    }
  }
  this.emit('lastLineChange', { id });
}, 500);
```

- [ ] **Step 8.3: Verify snapshot is included in sessions:list broadcast**

Check `sessionHandlers.js` to confirm `sessions:list` sends full `session.meta` including the new `snapshot` field. If it serialises meta directly, no change needed. If it filters fields, add `snapshot`.

- [ ] **Step 8.4: Update SessionLogPane to accept snapshot prop and remove polling**

Replace the `useEffect` polling in `SessionLogPane` with prop-based rendering when `snapshot` prop is provided:

```js
export function SessionLogPane({ sessionId, collapsed = false, snapshot = null }) {
  // If snapshot prop is provided (2B path), use it directly; otherwise poll (2A path)
  const [polledEntries, setPolledEntries] = useState([]);
  // ... (existing polling logic, but gated on !snapshot)

  const entries = snapshot
    ? snapshot.lines.map(line => ({ line, isNew: false })) // animation handled by parent
    : polledEntries;
  // ...
}
```

- [ ] **Step 8.5: Commit 2B changes**

```bash
git add lib/sessions/SessionManager.js lib/ws/handlers/sessionHandlers.js \
        public/js/components/SessionLogPane.js public/js/components/SessionCard.js
git commit -m "feat: add WS-pushed session snapshot (2B) for zero-poll events feed"
```

---

## Task 9: Merge to Beta and Final Validation

- [ ] **Step 9.1: Ensure all tests pass**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
npm test 2>&1 | tail -20
```

If tests fail, fix before proceeding.

- [ ] **Step 9.2: Merge to main (already on main) and restart both servers**

```bash
git log --oneline -8
pm2 restart claude-v2-beta
pm2 logs claude-v2-beta --lines 15 --nostream
pm2 restart claude-v2-prod
pm2 logs claude-v2-prod --lines 15 --nostream
```

- [ ] **Step 9.3: Final screenshot of all three changes working**

Use Playwright to:
1. Screenshot the session overlay showing events at top
2. Confirm command Send works
3. Confirm animation visible

- [ ] **Step 9.4: Invoke superpowers:requesting-code-review skill**

The implementation is complete. Request a code review before declaring done.
