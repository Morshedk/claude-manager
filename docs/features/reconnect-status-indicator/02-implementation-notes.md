# Implementation Notes: Clickable Connection Status Indicator

**Feature slug:** reconnect-status-indicator
**Implemented:** 2026-04-18
**Implementer:** Claude Code (claude-sonnet-4-6)

---

## Files Modified

### 1. `public/js/ws/connection.js`
**What changed:** Added exported function `reconnectNow()` immediately before the `ws` compat object at the bottom of the file. Also added `reconnectNow` to the `ws` compat object export.

`reconnectNow()` behaviour:
- Clears `reconnectTimer` first (prevents auto-retry racing the manual call).
- If `_ws` is null, calls `connect()` directly.
- If readyState is `OPEN` or `CONNECTING`, returns early (no-op).
- If readyState is `CLOSING`, schedules `connect` on next tick via `setTimeout(connect, 0)`.
- Otherwise (CLOSED) calls `connect()` immediately.
- Has no URL parameter — the same-origin safety invariant is structural, enforced by a code comment directly above the function.

### 2. `public/js/state/actions.js`
**What changed (3 additions, 0 deletions):**

1. Extended the existing `import { send }` line to `import { send, reconnectNow }` — did not add a second import line.
2. Added `connected` to the existing named-import list from `./store.js`.
3. Added exported function `manualReconnect()` directly after `closeSettingsModal`, adjacent to other UI modal actions (around line 145 as specified). The function:
   - Guards on `connected.value` (returns if already connected).
   - Calls `showToast('Reconnecting…', 'info', 1500)` with explicit 1500ms duration.
   - Then calls `reconnectNow()`.

### 3. `public/js/components/TopBar.js`
**What changed:**

- Extended the `import { openSettingsModal }` line to also import `manualReconnect`.
- Replaced the static `<div class="system-status">` block with a conditional expression:
  - When `isConnected === true`: `<div class="system-status" title="Already connected">` — structurally identical to before, adds only the `title` attribute.
  - When `isConnected === false`: `<button type="button" class="system-status system-status-clickable" title="Click to reconnect now" onClick=${manualReconnect}>` wrapping the same dot + label children.

### 4. `public/css/styles.css`
**What changed:** Three rules appended immediately after `.status-dot.error { background: var(--danger); }` (between the status-dot block and the `/* ===== WORKSPACE ===== */` comment):

```css
.system-status-clickable { cursor: pointer; background: transparent; border: none; padding: 0; font: inherit; color: inherit; }
.system-status-clickable:hover .status-dot.error { box-shadow: 0 0 6px var(--danger); }
.system-status-clickable:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
```

---

## Deviations from Design

None. All four changes were implemented exactly as specified. The plan-review notes were incorporated:

- Toast duration is explicitly `1500` (not relying on the default).
- `reconnectNow` has no URL parameter — same-origin is structural.
- The `import` from `connection.js` in `actions.js` was extended on the existing line, not added as a second import.
- Acceptance-test timing note (use <200ms not 50ms) is in the design doc; no code change needed for that — it is a test-authoring guideline.

---

## Smoke Test

**Test type:** Static structural analysis — 17 assertions run via Node against the modified source files directly (no browser required; the app serves static ESM modules, so syntax and structural correctness is the primary risk).

**Test tool:** `node --input-type=module` with inline scripts.

**Assertions checked:**

*connection.js (3 checks)*
- All named exports present (connect, send, on, off, once, reconnectNow)
- `reconnectNow()` has no URL parameter (same-origin safety invariant)
- `ws` compat object includes `reconnectNow`

*actions.js (6 checks)*
- Import extends existing line with `reconnectNow`
- `connected` imported from store on the existing import line
- `manualReconnect` is exported
- `connected.value` guard is present
- `showToast('Reconnecting…', 'info', 1500)` — exact text and 1500ms duration
- `reconnectNow()` is called

*TopBar.js (6 checks)*
- Single import line for both `openSettingsModal` and `manualReconnect`
- `title="Already connected"` on the connected wrapper
- `title="Click to reconnect now"` on the disconnected button
- Disconnected variant renders as `<button class="system-status system-status-clickable">`
- `type="button"` present
- `onClick=${manualReconnect}` wired

*styles.css (5 checks)*
- `.system-status-clickable` rule present
- `cursor: pointer`
- `background: transparent`
- Hover glow rule on `.status-dot.error`
- `focus-visible` rule

**Result: 17/17 PASSED.**

Server liveness check: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/` returned **200**. PM2 process `claude-v2-prod` remained `online` throughout.

---

## Things the Designer Missed / Worth Noting

1. **`_ws === null` is a distinct state.** The design's `reconnectNow()` pseudocode only discussed `readyState` guards, implicitly assuming `_ws` is always set after first load. In practice, if `reconnectNow` is called before the very first `connect()` (e.g., from a unit test or an unusual startup sequence), `_ws.readyState` would throw. Added an explicit `if (!_ws) { connect(); return; }` early exit.

2. **`connected` was not yet imported in `actions.js`.** The design said "reads `connected.value`" but did not note that `actions.js` had no existing import of `connected` from the store. Resolved by adding it to the existing named-import block.

3. **The design says `manualReconnect` should be adjacent to `openSettingsModal` "around line 145".** Placing it directly after `closeSettingsModal` keeps it in the UI-actions section as intended, but the line numbers shifted slightly due to earlier additions in the file. The logical placement matches the design intent.

---

## Explicitly NOT Done

- No exponential backoff change.
- No "Connecting…" intermediate visual state or third dot colour.
- No persistent banner or modal.
- No silent-death detection / heartbeat / ping.
- No URL override or environment switcher.
- No retry counter UI.
- No change to server-side files.
- No change to the auto-reconnect timer value (`RECONNECT_DELAY = 3000` unchanged).
- No toast throttling for rapid clicks (acceptable for v1 per design).
- No custom popover for mobile tooltip fallback.
