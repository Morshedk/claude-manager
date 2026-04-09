# Design: WatchdogPanel Mount in App UI

## 1. Problem & Context

`WatchdogPanel.js` is a complete, production-ready component that displays watchdog status (enabled/disabled badge), configuration summary (model, interval, extended-thinking), and a scrollable log of recent watchdog activity. It was built as an isolated component but was never wired into the App's component tree.

**Current state:** Users have zero UI path to the WatchdogPanel. It is completely unreachable. Two independent adversarial test agents (T-24, T-44) confirmed this gap.

**Component analysis:**
- `WatchdogPanel` reads `settings` signal from `store.js` — no new signals needed.
- It fetches `/api/watchdog/logs` on mount; gracefully degrades if the endpoint returns 500 or is absent.
- It takes no props — self-contained.
- It renders a full-height column layout (header → status cards → log list), identical in structure to `TodoPanel`.

**App layout:**
```
TopBar
└── workspace (flex row)
    ├── ProjectSidebar
    └── ProjectDetail
            ├── sessions-area (SessionCard list)
            ├── resize-handle-v
            └── terminals-area (xterm tabs)
```

`ProjectDetail` currently has two sections (sessions + terminals) separated by a vertical resize handle, with the sessions header holding a "New Claude Session" button. There is no tab navigation or side-panel mechanism.

## 2. Design Decision

### Chosen approach: Tab bar in the sessions-area header

Add a two-tab navigation row to `ProjectDetail` immediately below the `#sessions-area` header row. Tabs: **Sessions** (default) and **Watchdog**. The tab selection is tracked with local `useState`. The active tab controls whether the session list or `WatchdogPanel` fills the sessions-area body.

**Why this approach over alternatives:**

| Option | Pros | Cons |
|--------|------|------|
| Tab bar in sessions-area | Minimal code change, familiar pattern, no new signals, WatchdogPanel fills the same scrolling region as the session list | Slightly reduces visible session list area by one tab bar height (~34px) |
| Section below session list | No tabs needed | Watchdog would be below the fold, hard to reach, clutters the session flow |
| Collapsible panel (sidebar) | Non-intrusive | Requires new store signal, sidebar resize logic, and keyboard toggle wiring |
| TopBar global icon | Always accessible | Unrelated to project context; watchdog is project-adjacent, not global |

The tab-bar pattern is already familiar to users from the `terminals-bar` (which has tab buttons for terminal panes). It requires changes to only one file (`ProjectDetail.js`) plus one import.

### Exact mount location

**File:** `/home/claude-runner/apps/claude-web-app-v2/public/js/components/ProjectDetail.js`

**Where:** Inside the `ProjectDetail` function return, replacing the static `<div class="area-header">` block and `<div id="project-sessions-list">` block with a tab-bar plus conditional render.

**Structure after change:**
```
#sessions-area
  .area-header                        ← keep: title + "New Claude Session" button (hidden when Watchdog tab)
  .sessions-tab-bar                   ← NEW: two tab buttons (Sessions | Watchdog)
  #project-sessions-list              ← shown only when activeTab === 'sessions'
  <WatchdogPanel />                   ← shown only when activeTab === 'watchdog'
```

When the **Watchdog** tab is active:
- The "New Claude Session" button row is hidden (or the whole header is replaced by just the title and tabs — simpler: keep the header but hide the "New Session" button using conditional).
- `WatchdogPanel` fills the remaining sessions-area height (`flex:1; overflow:hidden`).

### Navigation path

1. User selects a project in the sidebar → `ProjectDetail` renders.
2. Two tabs appear below the session-area title: `Sessions` | `Watchdog`.
3. Clicking **Watchdog** switches the body to `WatchdogPanel`.
4. Clicking **Sessions** (or selecting a different project) switches back to the session list.

Tab state is **local** (`useState('sessions')`) — it resets when the selected project changes (component remounts). No persistence needed; the default view is always Sessions.

### New signals/state needed

None. `WatchdogPanel` already imports `settings` from `store.js`. Tab state is local to `ProjectDetail`.

### Props/context

`WatchdogPanel` takes no props. Mount it as `html\`<${WatchdogPanel} />\`` inside the conditional.

## 3. Acceptance Criteria

1. **Reachable:** A user can click a "Watchdog" tab inside `ProjectDetail` and see `WatchdogPanel` render without any console errors.
2. **Default view unchanged:** On first render (and after project switch), the active tab is "Sessions" — existing session-list UX is unaffected.
3. **Badge correct:** The ENABLED/DISABLED badge in `WatchdogPanel` reflects `settings.watchdog.enabled` from the store.
4. **Graceful degradation:** If `/api/watchdog/logs` returns 500, the panel renders with an empty log and no crash.
5. **Reload persistence:** After a browser reload, navigating back to the Watchdog tab still works (tab state resets to Sessions, which is the correct default — no reload persistence required for tab state).
6. **No layout regression:** The sessions-area still scrolls, the terminal-area resize handle still functions, and the "New Session" button is still visible when the Sessions tab is active.

## 4. User Lifecycle Stories

**Story A — First-time user:**
> "I opened a project. I see Sessions and Watchdog tabs. I clicked Watchdog. It showed me that the watchdog is Disabled and has no logs. I clicked Settings (TopBar) and enabled the watchdog. I came back to Watchdog tab — the badge now shows Enabled."

**Story B — Monitoring user:**
> "I have multiple sessions running. I clicked the Watchdog tab to check if any sessions were flagged. I saw three log entries. I clicked Refresh and got updated logs."

**Story C — Reload survival:**
> "I refreshed the page. The app loaded, I selected my project, clicked the Watchdog tab, and it worked exactly as before — no JS errors."

**Story D — Error tolerance:**
> "The server's watchdog log endpoint returned a 500. The panel showed an empty log section with the dog icon and 'No watchdog activity yet' text — no red screen, no crash."

## 5. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Tab bar adds clutter to the sessions header | Low | Tab bar is compact (34px), clearly labelled, consistent with terminals-bar style |
| WatchdogPanel fetch error crashes the panel | Very Low | WatchdogPanel already wraps fetch in try/catch and silently sets logs to [] |
| Tab state confusion on project switch | Low | `useState` resets on ProjectDetail remount (Preact unmounts on project change via `key` or full re-render) — verify this in tests |
| `/api/watchdog/logs` not implemented on server | Medium | WatchdogPanel already handles this gracefully (catch block, empty state) |
| Sessions tab "New Session" button absent on Watchdog tab | Acceptable | Hiding the button when Watchdog is active is intentional; users can switch tabs to create a session |

## Implementation Summary

**File to modify:** `public/js/components/ProjectDetail.js`

**Changes:**
1. Add import: `import { WatchdogPanel } from './WatchdogPanel.js';`
2. Add import: `import { useState } from 'preact/hooks';`
3. Inside `ProjectDetail()`: add `const [activeTab, setActiveTab] = useState('sessions');`
4. Add tab bar HTML below the `.area-header` div (or replace the header with a combined header+tabs block).
5. Conditionally render `<WatchdogPanel />` or the session list based on `activeTab`.

No other files need modification. No new API endpoints required. No store changes.
