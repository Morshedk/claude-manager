# T-28 Design: Delete button absent on running session

## Test Goal
Verify that a running session card shows **only** a "Stop" button and **no** "Delete" button. A Delete button on a running session would bypass the Stop→Delete safety flow and risk leaving zombie processes.

---

## Code Path Analysis

### SessionCard button rendering logic

The `SessionCard` component (`public/js/components/SessionCard.js`) uses `isActive(session)` to determine which buttons to render:

```js
function isActive(session) {
  const s = session.state || session.status || '';
  return s === 'running' || s === 'starting';
}
```

Button rendering in the JSX:
```js
${active ? html`
  <button class="btn btn-danger btn-sm" onClick=${handleStop}>Stop</button>
` : html`
  <button class="btn btn-primary btn-sm" onClick=${handleRefresh}>Refresh</button>
`}

${(!active) ? html`
  <button class="btn btn-danger btn-sm" onClick=${handleDelete}>Delete</button>
` : null}
```

**Key insight:** When `active === true` (state is `running` or `starting`):
- Stop button IS rendered
- Delete button is NOT rendered (`(!active)` is false → renders `null`)

When `active === false` (state is `stopped`, `exited`, `created`, `error`):
- Refresh button IS rendered
- Delete button IS rendered

### The guarantee
The code guards are correct and symmetric:
- `active` → Stop shown, Delete hidden
- `!active` → Refresh shown, Delete shown

There is no code path that would render both Stop and Delete simultaneously.

### Potential failure modes

1. **State signal staleness:** If `sessions.value` still holds an old state (e.g. the session transitions from `starting` to `running` but the signal hasn't propagated), the card might briefly show `Delete`. This is unlikely since signals are synchronous in Preact, but worth verifying.

2. **`state` vs `status` field confusion:** The card checks `session.state || session.status`. If the server sends `status` instead of `state`, the fallback chain must resolve to `'running'`. This is handled explicitly in `isActive()`.

3. **Session reaches running state before first render:** If a session is created and immediately running before React/Preact renders the card, `active` would be `true` from first render. No risk of a flicker-Delete here.

4. **`starting` state edge case:** A session in `starting` state also suppresses Delete (per `isActive`). This is correct — a starting session has an active process.

5. **Double-render or key change causing re-mount:** If the component key changes on state change, a brief re-render could theoretically flash buttons. Very unlikely but checked in the test by inspecting steady-state.

---

## Test Strategy

### Setup
- Seed a project via `localStorage` (`ProjectStore` format: `{ "projects": [...], "scratchpad": [] }`)
- Navigate to the app with `waitUntil: 'domcontentloaded'`
- Create a bash session (fast to start, reaches `running` quickly)
- Wait for the session card to show "▶ running" badge

### Assertions on running state
1. **Stop button present:** Query `.session-card-actions button` text = "Stop"
2. **No Delete button:** Assert that no button with text "Delete" exists anywhere in the session card actions
3. **No Refresh button:** The Refresh button should also be absent (sanity check — only shown when stopped)

### Assertions on stopped state (complementary)
4. Stop the session, wait for "⏹ stopped" badge
5. **Delete button present:** Assert Delete button IS visible
6. **Stop button absent:** Assert no Stop button in the session card
7. **Refresh button present:** Assert Refresh button IS visible

### Key Playwright patterns
- Use `page.on('dialog', d => d.accept())` to handle the confirm() in handleDelete
- Use `waitUntil: 'domcontentloaded'` on navigate
- Seed `localStorage` before navigation
- Wait for badge text containing 'running' before checking buttons
- Selector: `.session-card-actions button` to scope to the card's action area

---

## Risk Assessment
- **L=4 (Lethality):** Zombie processes from premature delete are hard to detect and can accumulate
- **S=3 (Surprise):** Users expect "Delete" to be safe to click; seeing it on a running session invites accidental use
- **D=2 (Detectability):** The bug would be visible but easy to miss if you don't specifically look for it

**Total: 9** — High priority. The code currently passes this check (buttons are correctly gated), but regression risk exists if `isActive()` logic or the conditional rendering is accidentally modified.

## Execution Summary

**Date:** 2026-04-08
**Result:** PASS — 1/1 test passed (9.8s)
**Port:** 3125

### Fixes applied during validation

1. **playwright.config.js** — Added T-28 to `testMatch` allowlist.
2. **`waitForSessionRunning` WS message type** — The test listened for `sessions:list` and `session:stateChange` but the server broadcasts `session:state` (with `id` field, not `sessionId`). Added `session:state` case.
3. **`stopSessionViaWS` field name** — Server expects `{ type: 'session:stop', id: ... }` but the test sent `sessionId`. Fixed to use `id`.
4. **Replaced WS-based state polling with REST API polling** — The original WS that creates the session closes before the session transitions to `running`, so `session:state` broadcasts are missed. Replaced both `waitForSessionRunning` and `waitForSessionStopped` with REST API polling loops (`GET /api/sessions`, max 20s).

### Key findings

- Running session card shows only "Stop" button — no "Delete" or "Refresh" buttons present.
- The `isActive()` guard (`state === 'running' || state === 'starting'`) correctly suppresses Delete.
- After stopping, the card shows "Delete" and "Refresh" but no "Stop" — correct button flip.
- DOM inspection found zero delete-related elements in the running session card.
- No server crash log entries.
