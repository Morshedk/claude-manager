# Tmux Default, Third Space Tabs, Clickable Filepaths, Scroll Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tmux the default session type, redesign the project terminals area into a unified tab bar (Terminals + Files + Todos), wire the + button to create real terminals, add clickable file paths, style event timestamps, and fix terminal scroll.

**Architecture:** All changes are client-side UI except the two-line tmux default fix. The "third space" refactor extracts a `ThirdSpaceTabBar` component and promotes the active-tab state to a global signal so xterm link clicks (in the session overlay) can navigate the project panel's Files tab. FileBrowser responds to a new `fileBrowserTarget` signal.

**Tech Stack:** Preact + htm/preact, preact/signals, xterm.js v5, WebSocket protocol (ws/protocol.js), node-pty via TerminalManager.

---

## File Map

| Action | File |
|--------|------|
| Modify | `lib/sessions/SessionManager.js` |
| Modify | `public/js/components/NewSessionModal.js` |
| Modify | `public/js/state/store.js` |
| Modify | `public/js/state/actions.js` |
| **Create** | `public/js/components/ThirdSpaceTabBar.js` |
| Modify | `public/js/components/ProjectDetail.js` |
| Modify | `public/js/components/FileBrowser.js` |
| Modify | `public/js/components/SessionLogPane.js` |
| Modify | `public/js/components/TerminalPane.js` |
| Modify | `public/css/styles.css` |

---

## Task 1: Tmux as Default

**Files:**
- Modify: `lib/sessions/SessionManager.js:133`
- Modify: `public/js/components/NewSessionModal.js:46`

- [ ] **Step 1: Change server-side default**

In `lib/sessions/SessionManager.js`, line 133, change:
```js
async create({ projectId, name, command, mode = 'direct', cols = 120, rows = 30, telegram = false } = {}) {
```
to:
```js
async create({ projectId, name, command, mode = 'tmux', cols = 120, rows = 30, telegram = false } = {}) {
```

- [ ] **Step 2: Change UI default**

In `public/js/components/NewSessionModal.js`, line 46, change:
```js
const settingsMode = (s && s.session && s.session.defaultMode) || 'direct';
```
to:
```js
const settingsMode = (s && s.session && s.session.defaultMode) || 'tmux';
```

- [ ] **Step 3: Commit**
```bash
git add lib/sessions/SessionManager.js public/js/components/NewSessionModal.js
git commit -m "feat: default session mode to tmux"
```

---

## Task 2: Add Global Signals for Third Space Navigation

**Files:**
- Modify: `public/js/state/store.js`
- Modify: `public/js/state/actions.js`

The `thirdSpaceTab` signal is global so xterm link providers (in SessionOverlay/TerminalPane) can switch the third space to Files when a filepath is clicked.

- [ ] **Step 1: Add signals to store.js**

At the end of `public/js/state/store.js`, append:
```js
// ── Third space ───────────────────────────────────────────────────────────────
/** Active tab in the third space: 'files' | 'todos' | <terminalId> */
export const thirdSpaceTab = signal('files');

/** File path to navigate to in FileBrowser; consumed and cleared by FileBrowser */
export const fileBrowserTarget = signal(null);
```

- [ ] **Step 2: Add openFileInThirdSpace action to actions.js**

First, add the new imports at the top of `public/js/state/actions.js`. Find the existing import line for store values and add `thirdSpaceTab` and `fileBrowserTarget`:
```js
import {
  // ... existing imports ...
  thirdSpaceTab,
  fileBrowserTarget,
} from './store.js';
```

Then at the end of `public/js/state/actions.js`, append:
```js
/** Navigate the third space FileBrowser to a specific file path */
export function openFileInThirdSpace(path) {
  fileBrowserTarget.value = path;
  thirdSpaceTab.value = 'files';
}
```

- [ ] **Step 3: Commit**
```bash
git add public/js/state/store.js public/js/state/actions.js
git commit -m "feat: add thirdSpaceTab and fileBrowserTarget signals, openFileInThirdSpace action"
```

---

## Task 3: Create ThirdSpaceTabBar Component

**Files:**
- Create: `public/js/components/ThirdSpaceTabBar.js`

Renders `[+] [Terminal 1 ×] [Terminal 2 ×] [Files] [Todos]`. Terminal tabs are closeable; Files and Todos are permanent.

- [ ] **Step 1: Create the file**

```js
import { html } from 'htm/preact';

const PLUS_ICON = html`<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
  <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
</svg>`;

const CLOSE_ICON = html`<svg viewBox="0 0 20 20" fill="currentColor" width="10" height="10">
  <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
</svg>`;

/**
 * ThirdSpaceTabBar — tab bar for the project "third space".
 * Shows terminal tabs (dynamic, closeable) + permanent Files and Todos tabs.
 *
 * @param {Array<{id:string, label:string}>} terminalTabs
 * @param {string}   activeTabId       - currently active tab id, 'files', 'todos', or terminalId
 * @param {function} onTabSelect       - (id) => void
 * @param {function} onAddTerminal     - () => void
 * @param {function} onCloseTerminal   - (id) => void
 */
export function ThirdSpaceTabBar({ terminalTabs, activeTabId, onTabSelect, onAddTerminal, onCloseTerminal }) {
  const tabStyle = (id) => `
    display:flex;align-items:center;gap:5px;
    padding:0 12px;height:36px;
    font-family:var(--font-mono);font-size:12px;
    color:${activeTabId === id ? 'var(--accent)' : 'var(--text-muted)'};
    border-bottom:2px solid ${activeTabId === id ? 'var(--accent)' : 'transparent'};
    background:${activeTabId === id ? 'var(--bg-hover)' : 'transparent'};
    cursor:pointer;white-space:nowrap;flex-shrink:0;
    transition:all 0.12s;user-select:none;
  `;

  const handleCloseClick = (e, id) => {
    e.stopPropagation();
    onCloseTerminal(id);
  };

  return html`
    <div class="terminals-bar" style="gap:0;padding-right:0;">
      <!-- New terminal button -->
      <button
        class="btn btn-icon"
        title="New terminal"
        onClick=${onAddTerminal}
        style="margin:0 4px;flex-shrink:0;"
      >${PLUS_ICON}</button>

      <div style="width:1px;height:20px;background:var(--border);flex-shrink:0;margin:0 2px;"></div>

      <!-- Terminal tabs -->
      <div style="display:flex;align-items:center;flex:1;overflow-x:auto;scrollbar-width:none;height:100%;">
        ${terminalTabs.map(t => html`
          <div
            key=${t.id}
            style=${tabStyle(t.id)}
            onClick=${() => onTabSelect(t.id)}
          >
            <span>${t.label}</span>
            <span
              onClick=${(e) => handleCloseClick(e, t.id)}
              style="display:flex;align-items:center;opacity:0.5;cursor:pointer;margin-left:2px;"
              title="Close terminal"
            >${CLOSE_ICON}</span>
          </div>
        `)}

        <!-- Permanent tabs: Files and Todos -->
        <div style=${tabStyle('files')} onClick=${() => onTabSelect('files')}>Files</div>
        <div style=${tabStyle('todos')} onClick=${() => onTabSelect('todos')}>Todos</div>
      </div>
    </div>
  `;
}
```

- [ ] **Step 2: Commit**
```bash
git add public/js/components/ThirdSpaceTabBar.js
git commit -m "feat: add ThirdSpaceTabBar component"
```

---

## Task 4: Rewrite ProjectDetail Third Space

**Files:**
- Modify: `public/js/components/ProjectDetail.js`

Remove Todos/Files from the upper tab bar. Replace the terminals area with `ThirdSpaceTabBar` + dynamic content. Use `thirdSpaceTab` global signal for active tab state.

- [ ] **Step 1: Replace ProjectDetail.js entirely**

```js
import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import {
  selectedProject,
  projectSessions,
  selectedProjectId,
  thirdSpaceTab,
} from '../state/store.js';
import { send } from '../ws/connection.js';
import { CLIENT } from '../ws/protocol.js';
import { openNewSessionModal } from '../state/actions.js';
import { SessionCard } from './SessionCard.js';
import { WatchdogPanel } from './WatchdogPanel.js';
import { TodoPanel } from './TodoPanel.js';
import { FileBrowser } from './FileBrowser.js';
import { ProjectTerminalPane } from './ProjectTerminalPane.js';
import { ThirdSpaceTabBar } from './ThirdSpaceTabBar.js';
import { initResize } from '../utils/dom.js';

export function ProjectDetail() {
  const [upperTab, setUpperTab] = useState('sessions');
  const [terminalTabs, setTerminalTabs] = useState([]);
  const [mountedTerminals, setMountedTerminals] = useState(new Set());
  const nextNum = useRef(1);
  const project = selectedProject.value;
  const projectId = project?.id;

  // Wire sessions resize handle
  useEffect(() => {
    const handle = document.getElementById('resize-sessions');
    const area = document.getElementById('sessions-area');
    if (!handle || !area) return;
    return initResize(handle, 'v', area, { min: 60, max: 800 });
  }, [projectId]);

  // Reset third space when project changes
  useEffect(() => {
    setTerminalTabs([]);
    setMountedTerminals(new Set());
    nextNum.current = 1;
    thirdSpaceTab.value = 'files';
  }, [projectId]);

  if (!project) {
    return html`
      <main id="detail-pane">
        <div id="no-project-view">
          <div class="empty-state" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;">
            <div style="font-size:40px;">📁</div>
            <p style="color:var(--text-primary);font-size:14px;">Select a project</p>
            <p style="color:var(--text-muted);font-size:12px;text-align:center;max-width:260px;">
              Choose a project from the sidebar to see its sessions and terminals
            </p>
          </div>
        </div>
      </main>
    `;
  }

  const sessions = projectSessions.value;
  const activeThirdTab = thirdSpaceTab.value;

  const tabBtnStyle = (id) => `
    font-size:12px;padding:4px 12px;border-radius:var(--radius-sm);
    border:1px solid ${upperTab === id ? 'var(--accent)' : 'var(--border)'};
    background:${upperTab === id ? 'var(--accent)' : 'transparent'};
    color:${upperTab === id ? '#000' : 'var(--text-secondary)'};
    cursor:pointer;font-weight:${upperTab === id ? '600' : '400'};transition:all 0.15s;
  `;

  function handleAddTerminal() {
    const id = crypto.randomUUID();
    const num = nextNum.current++;
    const tab = { id, label: `Terminal ${num}`, cwd: project.path };
    setTerminalTabs(prev => [...prev, tab]);
    setMountedTerminals(prev => new Set([...prev, id]));
    thirdSpaceTab.value = id;
  }

  function handleCloseTerminal(terminalId) {
    send({ type: CLIENT.TERMINAL_CLOSE, id: terminalId });
    setTerminalTabs(prev => prev.filter(t => t.id !== terminalId));
    setMountedTerminals(prev => { const s = new Set(prev); s.delete(terminalId); return s; });
    if (thirdSpaceTab.value === terminalId) {
      thirdSpaceTab.value = 'files';
    }
  }

  return html`
    <main id="detail-pane">
      <div id="project-detail" class="visible">

        <!-- Upper sessions area -->
        <div id="sessions-area">
          <div class="area-header">
            <span class="area-title" id="sessions-area-title">${project.name}</span>
            ${upperTab === 'sessions' ? html`
              <button class="btn btn-primary btn-sm" onClick=${openNewSessionModal}>
                <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12">
                  <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
                </svg>
                New Claude Session
              </button>
            ` : null}
          </div>

          <!-- Upper tab bar: Sessions | Watchdog only -->
          <div class="sessions-tab-bar" style="display:flex;gap:2px;padding:4px 12px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg-base);">
            <button style=${tabBtnStyle('sessions')} onClick=${() => setUpperTab('sessions')}>Sessions</button>
            <button id="watchdog-tab-btn" style=${tabBtnStyle('watchdog')} onClick=${() => setUpperTab('watchdog')}>Watchdog</button>
          </div>

          ${upperTab === 'sessions' ? html`
            <div id="project-sessions-list">
              ${sessions.length === 0
                ? html`<div class="sessions-empty">No sessions — start one with the button above</div>`
                : sessions.map(s => html`<${SessionCard} key=${s.id} session=${s} />`)}
            </div>
          ` : html`
            <div id="watchdog-panel-container" style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;">
              <${WatchdogPanel} />
            </div>
          `}
        </div>

        <!-- Vertical resize handle -->
        <div class="resize-handle resize-handle-v" id="resize-sessions"></div>

        <!-- Third space: unified tab bar + content -->
        <div id="terminals-area">
          <${ThirdSpaceTabBar}
            terminalTabs=${terminalTabs}
            activeTabId=${activeThirdTab}
            onTabSelect=${(id) => { thirdSpaceTab.value = id; }}
            onAddTerminal=${handleAddTerminal}
            onCloseTerminal=${handleCloseTerminal}
          />

          <div id="project-terminal-content" class="terminal-area">
            <!-- Terminal panes: always mounted once activated, hidden via CSS when inactive -->
            ${terminalTabs.filter(t => mountedTerminals.has(t.id)).map(t => html`
              <div key=${t.id} class=${'terminal-pane' + (activeThirdTab === t.id ? ' active' : '')}>
                <${ProjectTerminalPane}
                  terminalId=${t.id}
                  cwd=${t.cwd}
                  projectId=${project.id}
                  create=${true}
                />
              </div>
            `)}

            <!-- Files panel -->
            ${activeThirdTab === 'files' ? html`
              <div class="terminal-pane active" style="display:flex;flex-direction:column;">
                <${FileBrowser} projectId=${project.id} projectPath=${project.path} />
              </div>
            ` : null}

            <!-- Todos panel -->
            ${activeThirdTab === 'todos' ? html`
              <div class="terminal-pane active" style="display:flex;flex-direction:column;">
                <${TodoPanel} projectId=${project.id} />
              </div>
            ` : null}

            <!-- Empty state: no terminals and no panel active (should not occur in normal use) -->
            ${terminalTabs.length === 0 && activeThirdTab !== 'files' && activeThirdTab !== 'todos' ? html`
              <div class="terminals-empty">Open a terminal with the + button above</div>
            ` : null}
          </div>
        </div>

      </div>
    </main>
  `;
}
```

- [ ] **Step 2: Verify the app loads and tabs switch**

Start the dev server:
```bash
pm2 logs --lines 20
```
Open the app. Verify:
- Upper tabs show only Sessions and Watchdog
- Third space shows Files tab by default
- Clicking Todos switches to Todos panel
- Clicking + creates a Terminal tab and switches to it

- [ ] **Step 3: Commit**
```bash
git add public/js/components/ProjectDetail.js
git commit -m "feat: third space unified tab bar — terminals, files, todos"
```

---

## Task 5: Update FileBrowser to Respond to Navigation Signal

**Files:**
- Modify: `public/js/components/FileBrowser.js`

When `fileBrowserTarget` changes, navigate to the file's directory and select the file.

- [ ] **Step 1: Import the signal and add navigation effect**

At the top of `public/js/components/FileBrowser.js`, add to the imports:
```js
import { fileBrowserTarget } from '../state/store.js';
```

Inside `FileBrowser`, after the existing state declarations (around line 39), add:
```js
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
```

- [ ] **Step 2: Verify**

With the app open, open the Files tab. Run `openFileInThirdSpace('/etc/hosts')` in the browser console:
```js
// In browser console:
import('/js/state/actions.js').then(m => m.openFileInThirdSpace('/etc/hosts'))
```
Expected: Files tab activates (or stays active), FileBrowser navigates to `/etc/`, selects `hosts`.

- [ ] **Step 3: Commit**
```bash
git add public/js/components/FileBrowser.js
git commit -m "feat: FileBrowser responds to fileBrowserTarget signal for external navigation"
```

---

## Task 6: Clickable Filepaths in SessionLogPane

**Files:**
- Modify: `public/js/components/SessionLogPane.js`

Detect file paths in log lines and render them as clickable spans that open the file in the third space.

- [ ] **Step 1: Add import and renderLine helper**

At the top of `public/js/components/SessionLogPane.js`, add:
```js
import { openFileInThirdSpace } from '../state/actions.js';
```

Replace the existing `lineColor` function and line rendering with:

```js
const FILE_PATH_RE = /((?:\/|~\/)[\w.\-/]+\.\w[\w]*)/g;

function lineColor(line) {
  if (line.startsWith('===')) return 'var(--warning)';
  if (line.startsWith('---')) return 'var(--text-muted)';
  return 'var(--text-secondary)';
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
```

- [ ] **Step 2: Update the line rendering in the return block**

Find the current line map in the return statement:
```js
${lines.map((line, i) => html`
  <div key=${i} style=${'color:' + lineColor(line) + ';'}>${line}</div>
`)}
```

Replace with:
```js
${lines.map((line, i) => html`
  <div key=${i} style=${'color:' + lineColor(line) + ';'}>
    ${renderLineWithPaths(line, lineColor(line))}
  </div>
`)}
```

- [ ] **Step 3: Commit**
```bash
git add public/js/components/SessionLogPane.js
git commit -m "feat: clickable file paths in session log open FileBrowser in third space"
```

---

## Task 7: Clickable Filepaths in TerminalPane (xterm link provider)

**Files:**
- Modify: `public/js/components/TerminalPane.js`

Register an xterm link provider that detects file paths in terminal output and opens them in the third space on click.

- [ ] **Step 1: Add import**

At the top of `public/js/components/TerminalPane.js`, add:
```js
import { openFileInThirdSpace } from '../state/actions.js';
```

- [ ] **Step 2: Register link provider after xterm.open()**

In `TerminalPane.js`, after the line `try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}` (around line 86), add:

```js
// Register file path link provider — clicks open the file in the third space
try {
  xterm.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = xterm.buffer.active.getLine(bufferLineNumber);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const re = /((?:\/|~\/)[\w.\-/]+\.\w[\w]*)/g;
      const links = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        const filePath = m[0];
        const x1 = m.index + 1; // xterm columns are 1-based
        const x2 = m.index + filePath.length;
        links.push({
          range: {
            start: { x: x1, y: bufferLineNumber },
            end: { x: x2, y: bufferLineNumber },
          },
          text: filePath,
          activate(_e, _text) { openFileInThirdSpace(filePath); },
        });
      }
      callback(links);
    },
  });
} catch (e) {
  console.warn('[TerminalPane] link provider failed:', e);
}
```

- [ ] **Step 3: Verify**

Open a session, type `ls /etc` in the terminal. Hover over a path like `/etc/hosts` — it should underline. Click it — the third space should switch to Files and navigate there.

- [ ] **Step 4: Commit**
```bash
git add public/js/components/TerminalPane.js
git commit -m "feat: xterm link provider for file paths — click opens FileBrowser in third space"
```

---

## Task 8: Timestamp Styling in SessionLogPane

**Files:**
- Modify: `public/js/components/SessionLogPane.js`

Event lines (from `SessionLogManager.injectEvent`) have the format:
`=== SERVER:START | 2026-04-18T00:00:00.000Z | pid=123 ===`

Add `formatTimestamp` and `renderLine` after the functions added in Task 6 — do NOT re-declare `FILE_PATH_RE`, `lineColor`, or `renderLineWithPaths`.

- [ ] **Step 1: Add formatTimestamp and renderLine after renderLineWithPaths**

In `public/js/components/SessionLogPane.js`, directly after the `renderLineWithPaths` function (added in Task 6), insert:

```js
function formatTimestamp(iso) {
  const t = iso.split('T')[1];
  return t ? t.replace('Z', '').split('.')[0] : iso;
}

function renderLine(line, i) {
  // === EVENT | 2026-04-18T12:34:56.789Z | details ===
  const parts = line.split(' | ');
  if (line.startsWith('===') && parts.length >= 2) {
    const rawTs = parts[1]?.trim();
    const isIso = rawTs && /^\d{4}-\d{2}-\d{2}T/.test(rawTs);
    const timeStr = isIso ? formatTimestamp(rawTs) : null;
    const displayText = timeStr
      ? parts[0] + ' | ' + parts.slice(2).join(' | ')
      : line;
    return html`<div key=${i} style="display:flex;gap:8px;align-items:baseline;">
      ${timeStr ? html`<span style="
        font-size:10px;color:var(--text-muted);font-family:var(--font-mono);
        flex-shrink:0;letter-spacing:0.02em;opacity:0.85;
      ">${timeStr}</span>` : null}
      <span style="color:var(--warning);">${renderLineWithPaths(displayText, 'var(--warning)')}</span>
    </div>`;
  }
  return html`<div key=${i} style=${'color:' + lineColor(line) + ';'}>
    ${renderLineWithPaths(line, lineColor(line))}
  </div>`;
}
```

- [ ] **Step 2: Update lines.map to use renderLine**

Find the lines.map updated in Task 6:
```js
${lines.map((line, i) => html`
  <div key=${i} style=${'color:' + lineColor(line) + ';'}>
    ${renderLineWithPaths(line, lineColor(line))}
  </div>
`)}
```

Replace with:
```js
${lines.map((line, i) => renderLine(line, i))}
```

- [ ] **Step 3: Commit**
```bash
git add public/js/components/SessionLogPane.js
git commit -m "feat: styled timestamps in session events log"
```

---

## Task 9: Fix Terminal Scroll and Scrollbar

**Files:**
- Modify: `public/css/styles.css`
- Possibly: `public/js/components/TerminalPane.js`

The terminal scrollbar has disappeared and mouse scroll is broken.

- [ ] **Step 1: Check computed styles on `.xterm-viewport`**

In browser devtools, inspect `.xterm-viewport` inside `#session-overlay-terminal`. Check:
- `overflow-y` — must be `scroll`, not `hidden`
- `scrollbar-width` — must not be `none`

- [ ] **Step 2: Check for conflicting CSS**

In `public/css/styles.css`, search for any rule that might override xterm viewport styles. Look for:
```bash
grep -n "xterm-viewport\|overflow.*hidden\|scrollbar-width.*none" public/css/styles.css
```

If `#session-overlay-terminal` or a parent has `overflow: hidden` that's clipping the scrollbar area, that's the issue.

- [ ] **Step 3: Apply scroll fix to styles.css**

Ensure these rules exist and are not overridden. Find the `/* ===== TERMINAL SCROLLBAR */` section (around line 776) and update:

```css
/* ===== TERMINAL SCROLLBAR (always visible) ===== */
.xterm-viewport {
  overflow-y: scroll !important;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.2) transparent;
}
.xterm-viewport::-webkit-scrollbar { width: 6px; }
.xterm-viewport::-webkit-scrollbar-track { background: transparent; }
.xterm-viewport::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.2);
  border-radius: 3px;
}
.xterm-viewport::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.4);
}
```

The `overflow-y: scroll !important` ensures xterm's internal styles can't suppress it.

- [ ] **Step 4: Verify scroll works**

Open a session with significant output. Verify:
- Scrollbar is visible on the right of the terminal
- Mouse wheel scrolls up through history
- Scrolling up locks auto-scroll; reaching bottom re-enables it

- [ ] **Step 5: Commit**
```bash
git add public/css/styles.css
git commit -m "fix: restore xterm viewport scroll and scrollbar visibility"
```

---

## Task 10: Restart Server and Full Smoke Test

- [ ] **Step 1: Restart PM2**
```bash
pm2 restart all
pm2 logs --lines 30
```
Expected: no startup errors.

- [ ] **Step 2: Smoke test checklist**

Open the app and verify:
- [ ] New session defaults to `tmux` mode (check mode badge in NewSessionModal)
- [ ] Upper tab bar shows only Sessions + Watchdog
- [ ] Third space shows Files tab by default
- [ ] Clicking Todos switches to Todo panel
- [ ] Clicking + creates Terminal 1 tab; terminal opens and accepts input
- [ ] Clicking + again creates Terminal 2 tab
- [ ] Clicking ✕ on Terminal 1 closes it, switches to Files
- [ ] Terminal stays alive when switching away and back to it
- [ ] File path in terminal output (e.g. type `ls /etc`) shows underlined paths on hover
- [ ] Clicking a path opens Files tab and navigates there
- [ ] Session Events panel shows HH:MM:SS timestamps in muted style before event names
- [ ] File paths in Events are clickable
- [ ] Terminal scrollbar is visible
- [ ] Mouse wheel scrolls terminal output

- [ ] **Step 3: Final commit if any last fixes applied**
```bash
git add -p
git commit -m "fix: smoke test corrections"
```
