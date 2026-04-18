# Review: Clickable Connection Status Indicator (Manual Reconnect)

**Feature slug:** reconnect-status-indicator
**Reviewer:** Claude Code (claude-opus-4-7)
**Date:** 2026-04-18
**Verdict:** **FAITHFUL**

---

## Section 1: Design vs. Implementation, Decision by Decision

### Change 1 — `public/js/ws/connection.js`: `reconnectNow()` helper

| Design requirement | Actual implementation (lines) | Match? |
| --- | --- | --- |
| New exported function `reconnectNow()` added; existing behaviour untouched | `export function reconnectNow()` at line 117; `connect()`/`send()`/`on()`/`off()`/`once()` and the `close → setTimeout(connect, RECONNECT_DELAY)` retry path are unchanged | YES |
| Cancel any pending `reconnectTimer` first | Line 119: `if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }` | YES |
| If `OPEN` or `CONNECTING`, return early (no-op) | Lines 127–130 | YES |
| If `CLOSING`, schedule one-shot `setTimeout(connect, 0)` | Lines 131–135 | YES |
| Otherwise call `connect()` | Line 137 | YES |
| No URL parameter (same-origin invariant is structural) | Function signature is bare; comment block at lines 112–116 explicitly forbids future addition | YES |
| Add `reconnectNow` to `ws` compat object | Line 144: `export const ws = { connect, send, on, off, once, reconnectNow };` | YES |

**Implementer addition not in design:** an explicit `if (!_ws) { connect(); return; }` branch (lines 121–124). The design's pseudocode assumed `_ws` was always set after first load and would have crashed on `_ws.readyState` if `reconnectNow()` were ever invoked before the first `connect()`. This is a defensive correctness improvement and is documented in section "Things the Designer Missed" of `02-implementation-notes.md`. **Justified.**

### Change 2 — `public/js/state/actions.js`: `manualReconnect()` action

| Design requirement | Actual (lines) | Match? |
| --- | --- | --- |
| Extend existing `import { send }` line | Line 1: `import { send, reconnectNow } from '../ws/connection.js';` | YES |
| Add `connected` to existing named-import block from `./store.js` | Line 9 includes `connected` (the design said "reads `connected.value`" but did not call out the missing import; implementer correctly noticed) | YES |
| Place adjacent to `openSettingsModal` (~line 145) | Defined at line 152, immediately after `closeSettingsModal` at line 146 | YES (logical placement matches intent) |
| Guard on `connected.value` (early return) | Line 153 | YES |
| `showToast('Reconnecting…', 'info', 1500)` — exact string, info type, 1500 ms | Line 154 — exact match including the U+2026 ellipsis | YES |
| Call `reconnectNow()` after the toast | Line 155 | YES |

### Change 3 — `public/js/components/TopBar.js`: button when disconnected

| Design requirement | Actual (lines) | Match? |
| --- | --- | --- |
| Import `manualReconnect` joined to existing `openSettingsModal` import | Line 3: single import line | YES |
| Connected branch: `<div class="system-status" title="Already connected">` — structurally unchanged | Lines 38–41 | YES |
| Disconnected branch: `<button type="button" class="system-status system-status-clickable" title="Click to reconnect now" onClick=${manualReconnect}>` | Lines 42–50 | YES |
| Same dot + label children inside both branches | Lines 39–40 (dot.connected + "Connected"); lines 48–49 (dot.error + "Disconnected") | YES |

### Change 4 — `public/css/styles.css`

| Design requirement | Actual (lines) | Match? |
| --- | --- | --- |
| `.system-status-clickable { cursor: pointer; background: transparent; border: none; padding: 0; font: inherit; color: inherit; }` | Lines 82–89 — all six properties present | YES |
| `.system-status-clickable:hover .status-dot.error { box-shadow: 0 0 6px var(--danger); }` | Line 90 | YES |
| (Optional) `.system-status-clickable:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }` | Line 91 | YES (optional rule was included) |
| Append after the existing `.status-dot.error` rule | Inserted directly after line 81, before the `/* ===== WORKSPACE ===== */` block at line 93 | YES |

---

## Section 2: What Was Missed, Skipped, or Done Differently

**Nothing material.** Every numbered behaviour from sections 2 and 3 of the design doc is reflected in code. The two micro-deltas are:

1. **Extra `if (!_ws)` guard** in `reconnectNow` — added, justified, documented. **Improvement, not divergence.**
2. **`manualReconnect` is at line 152 instead of 145** — file grew between design and implementation. Logically adjacent to `openSettingsModal`/`closeSettingsModal`, exactly as required. **Trivial.**

No design decision was silently dropped. No undocumented behaviour was added. The "Explicitly NOT Done" list in the implementation notes corresponds exactly to the "What NOT to Build" list in the design.

---

## Section 3: Security, Error Handling, Race Conditions

### Security

- **Same-origin invariant is structural and intact.** `reconnectNow()` (connection.js:117) takes no parameters; the WebSocket URL is built once at line 34 inside `connect()` from `location.protocol` + `location.host`. There is no code path that allows a caller to influence the URL.
- **Defence-in-depth comment** at lines 112–116 explicitly forbids adding a URL parameter in future refactors. This is the strongest mitigation that does not require a runtime check.
- **No new user-controlled data path.** The toast message is a hardcoded string literal; no interpolation; no XSS surface.
- **Click handler is bound at render time** to a module-level function reference, not a string, so no `eval`/`Function`-like risk.

### Error handling

- `reconnectNow()` does not `try/catch` `connect()`. This is correct: `connect()` already swallows nothing — `new WebSocket(...)` does not throw synchronously for valid same-origin URLs (it asynchronously fires a `close`/`error` event), and the existing `'error'` listener (connection.js:59–62) handles that path. Wrapping the call in `try/catch` would be cargo-cult.
- `manualReconnect()` does not await anything (the toast is fire-and-forget; `reconnectNow` returns void). No promise-rejection paths to leak.
- `showToast` is already defensive (it just appends to a signal-backed array and schedules removal); no error-handling gap.

### Race conditions

The design called out four races; let me check each:

1. **Click while auto-reconnect timer is pending.** `reconnectNow` clears `reconnectTimer` before doing anything else (line 119). **Handled.**
2. **Click while `_ws` is `OPEN` or `CONNECTING`.** Early-return at lines 127–130 prevents a second socket from being constructed. **Handled.**
3. **Click while `_ws` is `CLOSING`.** `setTimeout(connect, 0)` defers to next tick so the `close` event fires first and `_ws` is in `CLOSED` state when the new `connect()` runs. **Handled.**
4. **Click before any `connect()` has ever run (`_ws === null`).** Implementer-added guard at lines 121–124 prevents `null.readyState` access. **Handled (design gap was caught).**

One subtle race that **is not** explicitly handled: a click happens between the `close` event being dispatched and `reconnectTimer = setTimeout(connect, RECONNECT_DELAY)` (line 56). Both lines run synchronously inside the close handler, so this window is effectively zero — not exploitable in practice. No fix needed.

---

## Section 4: Structural Debt Checks

### 1. Dead code (old paste listener pattern, etc.)

- No old click handler, no `addEventListener('click', …)`, no commented-out alternative implementation. The previous TopBar block was a static `<div>` with no listeners, so there is no event-listener removal to verify.
- **No dead code introduced.**

### 2. Scattered ownership (same concern in multiple places)

- The reconnect concern lives in exactly two places, by design:
  - `reconnectNow()` in `connection.js` — the *socket-state* concern (timer cancellation, readyState gating).
  - `manualReconnect()` in `actions.js` — the *UI* concern (connected-signal gate, toast).
- The `connected.value` check exists in two places (the action and the TopBar's branch), but the design explicitly calls this "defense in depth." The TopBar branch is structurally inevitable (it decides which JSX to render); the action's guard prevents a programmatic caller from racing into a no-op socket open. **Acceptable.**
- No third location exists where reconnect logic is duplicated. **Clean.**

### 3. Effect scope correctness (dependency arrays)

- This feature does not introduce any `useEffect`, `useMemo`, `useCallback`, or signal `effect()`. TopBar reads `connected.value` synchronously inside its render function, which is the standard Preact-signals subscription pattern — reactivity is automatic, no dependency array required.
- **No dependency-array hazards introduced.**

### 4. Cleanup completeness (teardown for every setup)

- No new event listeners are registered at the DOM level (`onClick=${manualReconnect}` is a Preact prop, removed automatically when the element unmounts).
- `reconnectNow` *cancels* a `setTimeout` via `clearTimeout` (line 119); the only `setTimeout` it *creates* is the `setTimeout(connect, 0)` at line 133, which auto-cleans on fire and runs once. No leaked timers.
- The toast inside `manualReconnect` uses `showToast`, which already self-schedules its own removal (`actions.js:135-137`).
- **No setup without teardown.**

### 5. Orphaned references (selectors / IDs that no longer exist)

- New CSS selector `.system-status-clickable` is referenced from `TopBar.js` line 44 — present.
- `.status-dot.error` selector inside the hover rule (styles.css:90) is referenced from `TopBar.js` line 48 — present.
- No stale class names, no dead `id="…"` attributes, no orphaned `querySelector` strings.
- **No orphaned references.**

---

## Section 5: Verdict

**FAITHFUL.**

Every design decision in section 2 of `01-design.md` maps to a concrete, correct line in the modified source. The two micro-deltas (the `_ws === null` guard, and the line-number drift of `manualReconnect`'s placement) are improvements over the design or trivial. No design decision was silently skipped. No security, error-handling, or race-condition gap is introduced. No structural debt is created (no dead code, no scattered ownership, no leaked timers, no orphaned references).

The implementation is ready to be locked in by the lifecycle tests in `03-test-designs.md`.
