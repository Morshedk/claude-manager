# Session UX Improvements — Design Spec

**Date:** 2026-04-27  
**Status:** Approved (user approved approaches 1B · 2B · 3A and authorised autonomous delivery)

---

## Overview

Three targeted UX improvements to the claude-web-app-v2 session management interface:

1. **Events panel at top** — move the session event log from a hidden bottom drawer to a resizable strip at the top of the terminal overlay
2. **Snapshot-based session feed** — replace noisy raw-output polling with a versioned snapshot (clean lines + system events) that animates like a stream
3. **Command send fix** — remove bracket-paste wrapping so pressing Send actually executes the command

---

## Change 1: Events Panel — Resizable Strip at Top of Overlay

### Problem
The current events panel is hidden behind an "Events" toggle button at the bottom of the terminal overlay. Users miss reconnect events, session lifecycle markers, and timing information. It takes an extra click to surface it, and it competes with terminal space in an awkward position.

### Design (Option 1B)

The `SessionLogPane` moves from below the terminal to above it. A vertical drag handle between the events strip and the terminal lets the user resize the two panes. Preferences persist to `localStorage`.

**Layout (top to bottom inside overlay):**
```
┌─ Overlay header (40px) ───────────────────────────────┐
├─ Events strip (default 120px, resizable via drag) ────┤
├─ Drag handle (6px) ───────────────────────────────────┤
├─ Terminal pane (flex: 1, takes remaining space) ───────┤
├─ CommandBuffer input bar ─────────────────────────────┤
└───────────────────────────────────────────────────────┘
```

**Collapsed state:** When dragged to ≤40px, the events strip snaps to a 28px summary bar showing only the most recent event. A "▼ expand" affordance lets the user re-open it.

**No toggle button:** The bottom tab bar and "Events" toggle are removed entirely. Events are always visible (or collapsed by user choice).

### Files affected
- `public/js/components/SessionOverlay.js` — move `SessionLogPane` above terminal, add drag handle, remove bottom tab bar, add collapse logic
- `public/js/components/SessionLogPane.js` — remove internal scroll-to-bottom behaviour when collapsed

---

## Change 2: Snapshot-Based Session Feed

### Problem
The current approach has two separate data paths that diverge:
- Session cards: `previewLines` from `sessions:list` WS broadcast (raw PTY lines, no timestamps, no lifecycle events, no animation)
- Events panel: polls `/api/sessionlog/:id/tail` REST endpoint every 3s (log file, separate from card data, noisy)

Result: the card and panel show different things, updates feel janky (content replacement vs smooth scroll), and there are no system events (reconnects, time gaps, session start/stop).

### Design (Option 2B — to be validated against Option 2A via UAT)

**Server computes a versioned snapshot per session:**

```js
// Shape pushed on sessions:list WS broadcast
{
  id: 'abc123',
  // ... existing session fields ...
  snapshot: {
    version: 42,           // increments on each meaningful change
    lines: [               // last 50 clean terminal lines
      { ts: 1714176000, text: 'Reading src/api/routes.js…' },
      { ts: 1714176004, text: 'Found 3 endpoints' },
    ],
    events: [              // system lifecycle events interspersed
      { ts: 1714175940, type: 'start',     text: 'Session started' },
      { ts: 1714176195, type: 'reconnect', text: 'Reconnected after 2m07s gap' },
      { ts: 1714176300, type: 'stop',      text: 'Session stopped (exit 0)' },
    ]
  }
}
```

**What "meaningful change" means (server-side throttle):**
- Terminal output change + debounce 1.5s (avoids firing on every spinner frame)
- Immediate on system events (reconnect, start, stop)
- Max one snapshot per 2s even during heavy output

**Client-side diff and animation:**
- Client stores `lastVersion` per session
- On receiving a snapshot with `version > lastVersion`: compute new lines (those with `ts > lastSeenTs`)
- Reveal new lines staggered: 60ms delay per line, CSS `slide-in` from bottom
- Both session card preview and events panel (top-of-overlay) read from the same snapshot

**Stream illusion:** The staggered reveal of each snapshot diff makes periodic snapshots feel like a live stream even at 1.5–2s intervals.

### Alternative: Option 2A (Enhanced Polling)

Keep the existing `SessionLogManager` log file approach but:
- Write clean lines + system event markers to the log file
- Client polls every 2s, diffs against previous result, animates

**Decision criteria (test both, pick winner):** See UAT section below. If Option 2A meets the UAT and feels indistinguishable from 2B, prefer 2A (less architectural change).

### Filtering rules (both options)
Lines to exclude from snapshot:
- Spinner frames: lines matching `isSpinnerLine()` in `SessionLogManager.js` (already exists, extend it)
- ANSI escape sequences: strip with existing `stripAnsi()` utility
- Blank lines at start/end of batch
- Lines shorter than 3 chars

System events to inject:
- `session:start` — when session transitions to `running`
- `session:stop` — when session transitions to `stopped`/`error`
- `session:reconnect` — when WS client reconnects to an existing session
- `time:gap` — when there is >30s gap between consecutive log lines (inject a separator: `── 2m pause ──`)

### Files affected (2B path)
- `lib/sessions/SessionManager.js` — compute and cache snapshot per session, expose via existing broadcast
- `lib/ws/handlers/sessionHandlers.js` — include `snapshot` in `sessions:list` payload; `previewLines` field is deprecated and removed
- `public/js/components/SessionCard.js` — read from `session.snapshot.lines` instead of `session.previewLines`
- `public/js/components/SessionLogPane.js` — accept `snapshot` as a prop instead of `sessionId`; remove internal REST polling; parent (SessionOverlay) passes `session.snapshot` down
- `public/js/state/store.js` — track `lastVersion` per session for diff computation; store `snapshot` per session in session map

### Files affected (2A path — alternative)
- `lib/sessionlog/SessionLogManager.js` — inject event markers into log file
- `public/js/components/SessionLogPane.js` — reduce poll interval to 2s, add diff + animation

---

## Change 3: Command Send Fix

### Problem
`CommandBuffer.js:31` wraps all input in bracket-paste sequences (`\x1b[200~`…`\x1b[201~`). Shells treat bracket-paste as "paste mode" — input is inserted but not executed. The user must press Return in the terminal to actually run the command.

### Design (Option 3A)

**One-line fix, two locations:**

`CommandBuffer.js:31` (immediate send):
```js
// Before
send({ type: msgType, id: targetId, data: '\x1b[200~' + content + '\x1b[201~' });
// After
send({ type: msgType, id: targetId, data: content + '\r' });
```

`CommandBuffer.js:68` (queue drain):
```js
// Before
send({ type: msgType, id: targetId, data: '\x1b[200~' + currentItem.text + '\x1b[201~' });
// After
send({ type: msgType, id: targetId, data: currentItem.text + '\r' });
```

`\r` (carriage return) is how terminals execute commands. The whole block is sent as-is (per user choice — multi-line constructs like heredocs work correctly). Bracket-paste is not needed here because CommandBuffer is an explicit command input, not an arbitrary clipboard target.

### Files affected
- `public/js/components/CommandBuffer.js` — lines 31 and 68

---

## User Acceptance Tests

### UAT-1: Command Send Executes Without Extra Return

**Given** the terminal overlay is open with an active session  
**When** I type `echo hello` into the CommandBuffer and click Send  
**Then** the terminal executes `echo hello` immediately (output `hello` appears in terminal)  
**And** I do not need to press Return in the terminal

**When** I type a multi-line bash block:
```
for i in 1 2 3
do echo $i
done
```
**And** click Send  
**Then** the for-loop executes as a block and outputs `1`, `2`, `3`

---

### UAT-2: Events Panel Visible at Top

**Given** I open the terminal overlay for any session  
**Then** the events panel is visible at the top of the overlay (above the terminal)  
**And** no "Events" toggle button exists at the bottom  

**When** I drag the resize handle downward  
**Then** the events strip grows and the terminal shrinks  
**And** the preference is saved (reopening the overlay restores the same height)  

**When** I drag the strip to collapsed  
**Then** a 28px summary bar shows the most recent event  
**And** a "▼ expand" control re-opens the strip

---

### UAT-3: Events Feed — Content Quality

**Given** a running session  
**Then** the events panel shows clean lines (no ANSI codes, no spinner frames like `⠋⠙⠹`)  
**And** shows timestamps per line in `HH:MM:SS` format  
**And** shows system events: `● Session started`, `↻ Reconnected after Xm pause`, `── Xm pause ──`  
**And** new content animates in (slides from bottom, staggered ~60ms per line) rather than replacing content

**When** the session has no output for 30+ seconds and then produces output  
**Then** a time-gap separator appears between the old and new content

---

### UAT-4: Session Card Consistency with Events Panel

**Given** the session card is visible in the main sessions list  
**And** the terminal overlay events panel is open for the same session  
**Then** the content in both shows the same lines (no divergence between card preview and events panel)

**When** new output arrives  
**Then** both card and events panel update within 3 seconds  
**And** both animate the new content in

---

### UAT-5: Event Streaming Approach Comparison (Autonomous Developer Gate — no user input required)

Before committing to Option 2B (WS snapshot) over Option 2A (enhanced polling):

| Criterion | 2A threshold | 2B threshold |
|-----------|-------------|-------------|
| Update latency (output → visible) | ≤ 3s | ≤ 2s |
| Animation smooth (no flash/jump) | Pass | Pass |
| System events appear (reconnect, stop) | Pass | Pass |
| Session card and events panel in sync | Pass | Pass |
| CPU overhead (idle sessions) | < 1% | < 1% |

If 2A meets all thresholds → use 2A (simpler). If 2A fails any threshold → use 2B.

---

## Implementation Order

1. **Change 3** (command send) — 2-line fix, instant win, zero risk
2. **Change 1** (events at top) — UI-only, no backend changes
3. **Change 2A** (enhanced polling) — build and test against UAT-5
4. **Change 2B** (WS snapshot) — build and test against UAT-5 if 2A fails
5. Final integration test against all UATs

---

## Out of Scope

- Parsing Claude-specific output patterns (tool calls, task status) — no LLM processing
- Storing events in a database — file-based log is sufficient
- Exporting or searching the event history
- Any changes to session creation, project management, or auth
