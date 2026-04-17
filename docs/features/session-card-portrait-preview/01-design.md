# Session Card Portrait Preview -- Design Document

Date: 2026-04-09

## Section 1: Problem & Context

### Current card implementation

The session card component lives at `public/js/components/SessionCard.js` (lines 63-168). Each card is a horizontal strip rendered inside a CSS grid (`#project-sessions-list` in `public/css/styles.css`, line 257) with `grid-template-columns: repeat(auto-fill, minmax(290px, 1fr))`. The grid lays cards out in a responsive auto-fill pattern with a minimum width of 290px.

Each card currently shows:
- **Session name** as an accent-colored monospace link (`.session-card-name`, styles.css line 293, max-width 200px, truncated with ellipsis).
- **Status badge** via `getBadgeClass()` / `getBadgeLabel()` (SessionCard.js lines 15-41): running, starting, stopping, stopped, created, error.
- **Optional badges**: Telegram ("TG"), mode (e.g., "tmux").
- **Claude session ID** (first 8 chars, click to copy).
- **Relative timestamp** ("3m ago", "2h ago") from `timeAgo()`.
- **Action buttons**: "Open", "Stop"/"Refresh", "Delete" (lines 129-153).
- **Last line**: a single line of stripped PTY output (`session.lastLine`, line 157-159), displayed in `.session-lastline` (styles.css line 324) -- monospace 10.5px, nowrap, ellipsis overflow.
- **Watchdog summary**: a single-line `watchdogSummary` string if present (line 161-165), displayed inline with inline styles.

The card header (`.session-card-header`, styles.css line 286) uses `display: flex; flex-wrap: wrap; gap: 8px` with all elements in a single row. The entire card is clickable (`onClick` calls `attachSession`, line 100).

### Why the current cards are insufficient

When managing 5-10+ sessions simultaneously, the current cards fail in several ways:

1. **No visual glanceability.** All cards look identical except for the name and badge color. A user cannot distinguish a session writing tests from one deploying to production without clicking into each one.

2. **The "last line" is nearly useless.** It shows one truncated line of terminal output with no context. A line like `Compiling...` or `>>>` tells the user nothing about what the session has been doing.

3. **No summary of session purpose.** The user must remember what each session is for. After stepping away for 30 minutes and coming back to 8 sessions, the names alone ("fix-auth", "deploy-v3") are insufficient -- the user needs "Fixing OAuth token refresh in middleware" vs. just "fix-auth".

4. **The action buttons are text-heavy and take up space.** The card's "Edit" button (SessionCard.js lines 130-135) is a text label that adds visual weight. In the new compact portrait layout it will be replaced with a small spanner/wrench icon to save horizontal space while preserving the action. Clicking the card body already attaches to the session (line 100) -- no separate "Open" button is needed or present.

### What data is already available vs. what needs to be added

**Already available (no new work needed):**
- Session metadata: name, state, mode, timestamps, claudeSessionId -- all in `store.js` sessions signal.
- Last line of PTY output: `session.lastLine` -- maintained by `DirectSession._updateLastLine()` (DirectSession.js line 251) with a 500ms debounced broadcast via `lastLineChange` event (SessionManager.js line 402).
- Watchdog summaries: `WatchdogManager.summarizeSession()` (WatchdogManager.js line 588) already calls the Claude API to produce 1-2 sentence summaries and key actions. Emitted as `'summary'` events.
- ANSI stripping: `lib/utils/stripAnsi.js` handles CSI, OSC, G-set, and control bytes.
- Tmux capture-pane: `WatchdogManager.tmuxCapture()` can grab N lines from a tmux session.

**Partially available (needs extension):**
- **Scrollback buffer for direct sessions**: `TerminalManager` has `getScrollback()` (TerminalManager.js line 156), but `SessionManager` does not expose a `getScrollback()` method for sessions (confirmed by grep -- no match in SessionManager.js). DirectSession accumulates PTY data in viewer callbacks but does not retain a scrollback buffer. The `_lastLineBuffer` (DirectSession.js line 31) only holds 1024 bytes for single-line extraction. A new scrollback ring buffer is needed on DirectSession/TmuxSession.
- **REST endpoint**: `/api/sessions/:id/scrollback/raw` exists (routes.js line 103) but calls `sessions.getScrollback()` which does not exist on SessionManager. This endpoint is broken/dead code.

**Needs to be built:**
- A server-side scrollback buffer on each session (capped, ring-buffer style) that retains the last N bytes of PTY output.
- A periodic job (server-side) that extracts the last N lines from this buffer, strips ANSI, and pushes the result to connected clients.
- A short summary string (5-7 words) derived from session activity, stored on the session metadata and pushed to clients.
- New card layout and CSS for the "portrait window" design.


## Section 2: Design Decision

### Card layout

The card transforms from a flat horizontal strip into a vertical "portrait window" that resembles a miniature terminal.

**Structure (top to bottom):**

1. **Title bar** (28px): Session name on the left, 5-7 word summary on the right (or wrapping below on narrow cards). Monospace, 11px. The summary is displayed in a muted secondary color next to the name, separated by an em dash or pipe character. Example: `fix-auth -- Fixing OAuth token refresh bug`

2. **Tag row** (22px): Status badge (running/stopped/etc.), optional mode badge (tmux), optional Telegram badge. Same badge components as today but in a dedicated row below the title, not crammed into the header flex.

3. **Terminal preview pane** (the bulk of the card, ~160-200px tall): A `<pre>` element styled to look like a miniature terminal window -- dark background (`--bg-deep` or `--bg-base`), monospace font at 9px, `overflow-x: auto; overflow-y: auto;` with thin scrollbars. Shows the last 20 lines of stripped terminal output. No word wrap. Content is plain text (not a live xterm.js instance -- that would be wasteful for a preview card).

4. **Action bar** (28px): Compact icon buttons for Edit (wrench/spanner icon), Stop/Refresh, and Delete. No "Open" button -- clicking the card itself opens the session (which is already implemented). Timestamp shown as a muted label on the right side of this row.

**Dimensions:**
- Minimum width: 300px (up from 290px).
- The grid CSS changes to: `grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))`.
- Card total height: approximately 260-280px (title 28 + tags 22 + preview ~180 + actions 28 + padding/gaps).
- At typical screen widths (1440px detail pane minus sidebar), this fits 3-4 cards per row.

**Visual treatment:**
- The preview pane gets a 1px inset border (`--border`) and slightly darker background than the card surface to create the "window within a window" effect.
- Border-radius on the preview pane matches `--radius-sm` (5px).
- The card itself retains its existing border and hover behavior.

### Session name + summary

The 5-7 word summary is an AI-generated description of what the session is currently doing or has been doing. Examples:
- "Building REST API authentication middleware"
- "Running test suite for payment module"
- "Debugging CSS layout overflow in sidebar"

**Where the summary comes from:**

The WatchdogManager already generates session summaries via Claude API calls in `summarizeSession()` (WatchdogManager.js line 588). It produces `{ summary, keyActions, state }` objects. The `summary` field is a 1-2 sentence string. This is longer than the 5-7 word card label needs.

The design proposes adding a `cardSummary` field: a terse 5-7 word label extracted from the same Claude API call. The summarization prompt (WatchdogManager.js line 56) would be extended to also request a `cardLabel` field in its JSON output schema.

**When it is generated -- the cost-effective approach:**

The summary is generated:
- (a) On the first watchdog tick after the session produces substantial new output (the existing `MIN_DELTA_FOR_SUMMARY` threshold, which requires meaningful scrollback change).
- (b) When the session stops or exits.
- (c) When the user explicitly clicks a "refresh summary" action on the card.

It is NOT generated on a 20-second polling loop. The watchdog already ticks on its existing cadence (WatchdogManager.js line 99, `_tickInterval = 30_000`). The summary is only regenerated when the scrollback delta exceeds the minimum threshold, which naturally rate-limits API calls to meaningful activity changes. **No new Claude API calls are introduced by this feature.** The preview capture (every 20 seconds) is a free local buffer read. The summary uses the watchdog's existing API infrastructure -- the only change is adding a `cardLabel` field to the existing summarization prompt.

**How it is stored:**

The `cardSummary` string is stored on `session.meta.cardSummary` alongside the existing `lastLine`. It is persisted via `SessionStore` (which already saves all meta fields) and broadcast to clients via the existing `sessions:list` broadcast mechanism (sessionHandlers.js line 223-226).

### Terminal preview

The last 20 lines of terminal output are captured server-side. This is a pure text operation -- no Claude API call needed.

**Capture mechanism:**

A new scrollback ring buffer is added to `DirectSession` (and corresponding tmux capture-pane logic for `TmuxSession`):

- `DirectSession` gets a `_previewBuffer` field: a string ring buffer capped at 8KB. The existing `_wirePty` data handler (DirectSession.js line 192) appends each PTY chunk to this buffer (in addition to streaming to viewers).
- Every 20 seconds, a server-side interval job on `SessionManager` iterates all sessions, extracts the last N lines from each buffer using `stripAnsi()`, and stores the result on `session.meta.previewLines` (an array of strings).
- For `TmuxSession`: the same interval calls `tmux capture-pane -p -t <name> -S -20` to grab the last 20 lines directly from tmux. This is a local shell command, not an API call.

**How it reaches the client:**

A new WebSocket message type `session:preview` is added to the protocol:
```
{ type: "session:preview", id: "<sessionId>", lines: ["line1", "line2", ...] }
```

The 20-second interval broadcasts this to all connected clients for each active session. Alternatively, it can piggyback on the existing `sessions:list` broadcast by including `previewLines` in the session metadata. The latter approach is simpler (no new message type) but increases the payload size of the sessions list. Given that preview data is ~20 lines of text (~2KB per session), piggybacking on `sessions:list` is acceptable for up to ~20 sessions.

**Rendering on the client:**

The preview pane is a `<pre>` element with a fixed height and overflow scrollbars. It is NOT a live xterm.js instance. Reasons:
- Creating xterm.js Terminal objects for every card would be extremely heavy (each one spins up a canvas/WebGL renderer).
- The preview is read-only, non-interactive, and only needs to display plain text.
- A `<pre>` with monospace font at 9px achieves the "tiny terminal window" look without the overhead.

The `<pre>` is auto-scrolled to the bottom so the most recent output is visible. The user can manually scroll up within the preview pane.

**ANSI stripping:**

The server strips ANSI codes using the existing `lib/utils/stripAnsi.js` before sending preview lines. The client receives clean text only. This avoids the complexity of rendering ANSI colors in a `<pre>` element and eliminates the risk of garbled escape sequences in the preview.

### The background job

**Server-side, not client-side.** The job runs in `SessionManager` (or a new `PreviewManager` helper class instantiated by the server).

Two independent intervals:

1. **Preview lines interval (20 seconds):** Iterates all sessions with status RUNNING or STARTING. For each, extracts last N lines from the scrollback buffer (DirectSession) or via `tmux capture-pane` (TmuxSession). Strips ANSI. Stores on `session.meta.previewLines`. Broadcasts updated data to clients via WebSocket.

2. **Summary refresh:** Handled by the existing WatchdogManager tick cycle (30 seconds). The only change is adding the `cardSummary` field to the summarization prompt output.

**Push to client:** The preview lines update is pushed via the existing `sessions:list` broadcast or a new `session:preview` message. The client's `sessionState.js` `upsertSession()` (sessionState.js line 48) merges the new fields into the signal-based store, triggering a re-render of SessionCard components that read `session.previewLines` and `session.cardSummary`.

### Configurability

The "20 lines" default is a global app setting stored in the settings store (accessed via `GET /api/settings` and `PUT /api/settings`). The setting is named `previewLines` with a default of 20, minimum of 5, maximum of 50.

This is exposed in the Settings modal (`public/js/components/SettingsModal.js`) as a numeric input: "Terminal preview lines: [20]".

The preview refresh interval (20 seconds) is not user-configurable in this phase. It can be made configurable later if needed.

### The "Edit" button

The current card has an **"Edit" button** (SessionCard.js lines 130-135), not an "Open" button -- the design's earlier reference to an "Open" button was a factual error. The entire card `div` is already clickable (line 100), so no separate "Open" action is needed.

**Decision:** Keep the Edit button, but style it as a small spanner/wrench icon instead of the text label. Use a wrench SVG icon (or the 🔧 emoji as a fallback) sized to match the compact action bar (~14px). The icon sits in the card's action area alongside Stop/Refresh and Delete. No text label -- icon only, with a `title` tooltip of "Edit session" for accessibility.

The action bar retains: wrench icon (Edit), Stop/Refresh, and Delete. Clicking the card body (outside action buttons) attaches to the session.

### What NOT to build

- No live xterm.js instances in card previews. Plain `<pre>` text only.
- No syntax highlighting or ANSI color rendering in the preview. Stripped plain text only.
- No per-session preview line configuration (global setting only, in this phase).
- No inline editing of session names from the card.
- No drag-and-drop card reordering.
- No card collapse/expand toggle.
- No thumbnail/screenshot capture of the terminal.


## Section 3: Acceptance Criteria

1. **Given** the sessions list is visible, **when** any session card renders, **then** it displays a title bar with the session name and a 5-7 word summary (or "No summary yet" placeholder), a tag row with status and mode badges, a terminal preview pane showing text content, and a compact action bar -- all stacked vertically.

2. **Given** a running session with PTY output, **when** 20 seconds elapse, **then** the card's terminal preview pane updates to show the last 20 lines (default) of ANSI-stripped output from that session, without requiring the user to click or interact.

3. **Given** a session with a tmux backend, **when** the preview refresh interval fires, **then** the server captures the last N lines via `tmux capture-pane` and pushes them to all connected clients.

4. **Given** a running session with enough scrollback delta to trigger summarization, **when** the next watchdog tick fires, **then** the session's card summary is generated (via a single Claude API call that also produces the existing watchdog summary) and displayed on the card's title bar.

5. **Given** a session whose summary was previously generated, **when** no significant new output has occurred, **then** no additional Claude API call is made for that session's summary -- the existing cached value continues to display.

6. **Given** any session card, **when** the user looks at the action bar, **then** there is no "Open" button. The action bar contains a wrench/spanner icon button (Edit), Stop/Refresh, and Delete. Clicking anywhere on the card body (outside action buttons) attaches to the session.

7. **Given** the Settings modal, **when** the user changes the "Terminal preview lines" value to 10, **then** subsequent preview refreshes capture and display 10 lines instead of 20.

8. **Given** 8+ sessions visible in the grid, **when** the browser window is 1440px wide, **then** the cards lay out in a responsive grid (3-4 per row) without horizontal overflow, and the preview panes have independent vertical/horizontal scroll bars for long or wide output.

9. **Given** a session whose PTY output contains ANSI escape sequences (colors, cursor movement, OSC), **when** the preview pane renders, **then** no raw escape characters or garbled text appears -- all ANSI is stripped server-side.

10. **Given** a stopped session with no PTY output, **when** the card renders, **then** the preview pane shows an empty state (e.g., "No output" in muted text) rather than being blank or collapsed.


## Section 4: User Lifecycle Stories

### Story 1: Morning check-in

The user opens the app after being away overnight. Eight sessions are visible in the project view. Without clicking into any session, the user scans the cards and immediately sees: "fix-auth -- Fixing OAuth refresh in middleware" shows a stopped badge and the last 20 lines ending with "All 47 tests passed"; "deploy-v3 -- Deploying to staging via Docker" shows a running badge and the preview scrolling with deployment logs. The user clicks the deployment card to attach and monitor it.

### Story 2: Launching a new session

The user creates a new session named "refactor-db". The card appears with a "starting" badge, an empty preview pane showing "No output", and the summary placeholder "No summary yet". After 30 seconds of Claude producing output, the preview pane fills with the last 20 lines of Claude's work. After the first watchdog tick detects substantial scrollback, the summary updates to "Refactoring database query layer for Postgres".

### Story 3: Spotting a stuck session

The user glances at 6 session cards. Five show active preview content scrolling with new output. One card -- "migrate-schema" -- has a running badge but its preview pane has been showing the same text for several minutes (the user notices because the timestamp says "12m ago" and the preview content looks stale). The watchdog summary says "Waiting for user input on migration conflict". The user clicks the card to investigate and provide input.

### Story 4: Cleaning up finished sessions

The user sees three sessions with "stopped" badges. Their summaries read "Completed auth middleware refactor", "Test suite passed, no failures", and "CSS layout fixes applied to sidebar". The user clicks Delete on the two that are clearly done, without needing to open them first to verify what they were doing. The preview panes confirm the final state of each session's output.

### Story 5: Adjusting preview depth

The user finds that 20 lines is too much for their small laptop screen, making cards too tall. They open Settings, change "Terminal preview lines" to 10, and the cards immediately shrink. The grid now fits more cards on screen. Later, on a large monitor, they increase it to 30 for more context.


## Section 5: Risks & False-PASS Risks

### RISK 1: Claude API cost for summary generation

**Resolved.** This risk is eliminated by the confirmed architecture:

- The **20-line terminal preview** capture job runs every 20 seconds and makes **zero Claude API calls**. It reads the PTY scrollback buffer directly (DirectSession) or calls `tmux capture-pane` (TmuxSession). This is a free local operation.
- The **5-7 word card summary** is generated by the watchdog on the **watchdog's existing cadence** (30-second tick, delta-gated by `MIN_DELTA_FOR_SUMMARY`). No new API calls are added -- the only change is extending the existing summarization prompt to also return a `cardLabel` field.

The original concern about ~1,800 API calls/hour for 10 sessions does not apply. The two concerns are fully separated: preview capture is free, and summary generation reuses infrastructure that was already calling the API. There is no "Option A" (always-fresh every 20 seconds) being built. The delta-gated approach is the only approach.

### RISK 2: ANSI stripping failures

The existing `stripAnsi()` in `lib/utils/stripAnsi.js` handles CSI, OSC, G-set, and control bytes. However, Claude Code output can include:
- Cursor positioning sequences that span multiple lines.
- Alternate screen buffer switches (used by editors Claude invokes).
- Partial escape sequences split across PTY data chunks.

**Mitigation:** The scrollback buffer accumulates complete PTY output, so partial-sequence splitting is not an issue at extraction time. Alternate screen buffer content may produce meaningless output in the preview (the escape sequences get stripped but the spatial layout is lost). This is acceptable -- the preview is a best-effort glance, not a pixel-perfect reproduction.

**False-PASS risk:** A test that strips a known ANSI string and checks the result may pass, while real PTY output with interleaved cursor-forward sequences (`\x1b[C`) produces garbled spacing in the preview. Tests must use real captured PTY output samples, not synthetic ones.

### RISK 3: Performance with many sessions

The 20-second preview refresh iterates all active sessions and broadcasts updated data. With 20 sessions, each producing 20 lines of ~80 chars, that is ~32KB of data broadcast every 20 seconds. This is negligible for WebSocket bandwidth.

However, tmux sessions require a `tmux capture-pane` shell command per session. Twenty `execSync` calls every 20 seconds could introduce latency.

**Mitigation:** Use `execSync` with a 2-second timeout (already the pattern in TmuxSession). Consider batching: a single `tmux list-sessions` + parallel captures. If latency becomes measurable (>500ms total), switch to async `exec` with Promise.all.

### RISK 4: Layout overflow and card sizing

The portrait cards are taller than the current horizontal strips. If the sessions area has a fixed or small height (it is resizable via `#resize-sessions` handle, min 60px, max 800px -- ProjectDetail.js line 28), the taller cards may cause the sessions list to feel cramped.

**Mitigation:** The `#sessions-area` already has overflow scroll (via the grid's natural overflow behavior). The minimum area height of 60px is too small for portrait cards -- the resize minimum should be raised to 200px when this feature ships.

### RISK 5: Scrollback buffer memory

Adding an 8KB ring buffer per session means 20 sessions consume ~160KB. This is trivial. However, if the buffer size is made configurable and a user sets it to 1MB per session with 50 sessions, that is 50MB of in-process memory.

**Mitigation:** Cap the maximum buffer size at 32KB regardless of user configuration. The preview only needs 20 lines (~1.6KB), so 8KB provides ample headroom.

### RISK 6: Summary staleness after long idle

If a session sits idle for hours, the summary reflects the last activity, which may be outdated. The user sees "Running test suite for auth" when the tests finished 2 hours ago and the session is just sitting at a prompt.

**Mitigation:** Display the summary timestamp alongside the text (e.g., "Running test suite -- 2h ago"). When the session has been idle for >5 minutes with no scrollback delta, append "(idle)" to the summary or dim it visually.

### RISK 7: False-PASS in Playwright tests

A test that checks "the preview pane contains text" may pass with placeholder text or stale content. The real user value requires that the preview shows *current* terminal output, not cached/stale content.

**Mitigation:** Playwright tests should: (1) start a session, (2) send known input, (3) wait >20 seconds for the preview refresh, (4) verify the preview pane contains the expected output text from step 2. Use `expect(locator).toContainText()` with a timeout that accounts for the refresh interval.
