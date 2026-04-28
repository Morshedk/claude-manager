# Events Bottom Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Events log from a left-right side-split (which squishes terminal width and causes xterm resize issues) to a bottom panel revealed by a horizontal tab bar below the terminal.

**Architecture:** Single-file change in `SessionOverlay.js`. Remove Events button from header. Add a always-visible horizontal tab strip at the bottom of the overlay. When the Events tab is active, render `SessionLogPane` in a fixed-height panel below the terminal. Terminal always stays full width.

**Tech Stack:** Preact, htm, inline styles (no CSS file changes needed)

---

## File Map

- **Modify:** `public/js/components/SessionOverlay.js` — layout restructure only, no logic changes

---

### Task 1: Restructure SessionOverlay layout — bottom panel instead of side split

**Files:**
- Modify: `public/js/components/SessionOverlay.js`

The current body section (lines 195–206) uses a horizontal flex row that squishes the terminal when Events is open. Replace it with a vertical flex column where Events opens below the terminal.

- [ ] **Step 1: Remove the Events button from the header**

In `SessionOverlay.js`, delete lines 152–158 (the Events button in `.overlay-actions`):

```js
// DELETE these lines:
          <button
            onClick=${toggleLog}
            style=${btnStyle(showLog ? 'var(--bg-raised)' : 'transparent', showLog ? 'var(--accent)' : 'var(--text-secondary)')}
            title=${showLog ? 'Hide session events' : 'Show session events'}
          >
            Events
          </button>
```

- [ ] **Step 2: Replace the body section with a column layout**

Replace lines 194–206:

```js
      <!-- Terminal body (+ optional events split) -->
      <div style="flex: 1; min-height: 0; overflow: hidden; display: flex;">
        <div
          id="session-overlay-terminal"
          style=${'flex: 1; min-height: 0; overflow: hidden; position: relative;' + (showLog ? ' max-width: 50%;' : '')}
        >
          <${TerminalPane} sessionId=${session.id} />
        </div>
        ${showLog ? html`
          <div style="flex: 1; min-height: 0; min-width: 0;">
            <${SessionLogPane} sessionId=${session.id} />
          </div>
        ` : null}
      </div>
```

With this new version:

```js
      <!-- Terminal body -->
      <div style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
        <div
          id="session-overlay-terminal"
          style="flex: 1; min-height: 0; overflow: hidden; position: relative;"
        >
          <${TerminalPane} sessionId=${session.id} />
        </div>

        <!-- Bottom tab bar (always visible) -->
        <div style="
          display: flex;
          align-items: center;
          height: 28px;
          background: var(--bg-surface);
          border-top: 1px solid var(--border);
          flex-shrink: 0;
          gap: 0;
        ">
          <button
            onClick=${toggleLog}
            style="
              height: 100%;
              padding: 0 14px;
              background: ${showLog ? 'var(--bg-base)' : 'transparent'};
              color: ${showLog ? 'var(--accent)' : 'var(--text-muted)'};
              border: none;
              border-right: 1px solid var(--border);
              border-top: ${showLog ? '2px solid var(--accent)' : '2px solid transparent'};
              font-size: 11px;
              font-family: var(--font-sans);
              cursor: pointer;
              white-space: nowrap;
            "
            title=${showLog ? 'Hide session events' : 'Show session events'}
          >Events</button>
        </div>

        <!-- Events panel (below terminal, fixed height) -->
        ${showLog ? html`
          <div style="height: 260px; min-height: 0; flex-shrink: 0; overflow: hidden;">
            <${SessionLogPane} sessionId=${session.id} />
          </div>
        ` : null}
      </div>
```

- [ ] **Step 3: Remove the `border-left` from SessionLogPane since it's now below, not beside**

In `public/js/components/SessionLogPane.js`, find the outer div style (around line 108):

```js
<div style="display:flex;flex-direction:column;height:100%;background:var(--bg-base);border-left:1px solid var(--border);overflow:hidden;">
```

Change `border-left` to `border-top`:

```js
<div style="display:flex;flex-direction:column;height:100%;background:var(--bg-base);border-top:1px solid var(--border);overflow:hidden;">
```

- [ ] **Step 4: Deploy to beta and verify**

```bash
cd /home/claude-runner/apps/claude-web-app-v2-beta
git merge main
pm2 restart claude-v2-beta
```

Open http://localhost:3002, open a running session. Confirm:
- No Events button in the header
- Thin tab bar visible at the bottom of the overlay
- Clicking "Events" tab opens the log panel BELOW the terminal (terminal stays full width)
- Terminal does not resize horizontally when Events is toggled
- Clicking "Events" again collapses the panel

- [ ] **Step 5: Commit**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
git add public/js/components/SessionOverlay.js public/js/components/SessionLogPane.js
git commit -m "fix: move Events to bottom tab panel to prevent terminal width resize"
```
