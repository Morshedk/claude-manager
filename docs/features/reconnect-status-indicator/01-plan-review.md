# Plan Review: Clickable Connection Status Indicator (Manual Reconnect)

**Reviewer role:** Independent adversarial reviewer
**Design reviewed:** `docs/features/reconnect-status-indicator/01-design.md`
**Date:** 2026-04-18

---

## Verdict: APPROVED (with minor non-blocking observations)

The design is implementation-ready. All five required sections are present and substantive. Section 2 cites exact files, lines, and function names. The data flow is end-to-end. Acceptance criteria are observable from the running app. Lifecycle stories are written as user journeys with observable outcomes. Cited code was spot-verified and matches reality. The same-origin safety invariant is correctly grounded in the existing `location.host`-derived URL construction and is reinforced both by code comment and by an explicit test assertion. Risks include real failure modes (CLOSING-state race, invariant rot via future parameter addition) and a strong list of false-PASS risks specific to this feature.

---

## Codebase Verification (spot checks)

I verified three of the most load-bearing citations against the working tree:

1. **`public/js/ws/connection.js`** — Confirmed:
   - Line 6: `const RECONNECT_DELAY = 3000;` ✓
   - Line 9: `let reconnectTimer = null;` ✓
   - Lines 30–34: `connect()` with the OPEN/CONNECTING guard and the `proto`/`location.host` URL construction exactly as described ✓
   - Lines 53–57: `close` handler dispatches `connection:close` and schedules `setTimeout(connect, RECONNECT_DELAY)` ✓
   - Line 114: `export const ws = { connect, send, on, off, once };` — note: design says "line 114" and that `connect` is "already exported, so external callers can invoke `connect()` directly" — both true ✓

2. **`public/js/components/TopBar.js`** — Confirmed:
   - Lines 37–40 contain the `<div class="system-status">` block with the `status-dot` and `status-text` exactly as described ✓
   - Line 3 is the existing `import { openSettingsModal } from '../state/actions.js';` — confirms the join point for the new import ✓

3. **`public/js/state/actions.js`** — Confirmed:
   - Line 1: `import { send } from '../ws/connection.js';` — so adding `reconnectNow` to that import is a one-token edit, as the design implies ✓
   - Line 132: `showToast(message, type, duration)` exists with the (message, type, duration=3000) signature the design assumes ✓
   - Line 145: `openSettingsModal` is exactly where the design says, providing the natural insertion point for `manualReconnect` ✓

4. **`public/js/state/sessionState.js`** lines 86–87 — Confirmed: `on('connection:open', () => { connected.value = true; });` and `on('connection:close', () => { connected.value = false; });` ✓

5. **`public/css/styles.css`** lines 65–81 — Confirmed: `.system-status`, `.status-dot`, `.status-dot.connected`, `.status-dot.error` exist and match the design's description (no hover, no cursor change today) ✓

All cited code exists and the proposed insertion points would produce the described behavior.

---

## Section-by-Section Notes

### Section 1 (Problem & Context) — Substantive
Identifies a concrete user problem, names the current 3-second wait as the cost, ties it to QA T-17, and enumerates exactly what is missing in code. Good.

### Section 2 (Design Decision) — Specific
- Four discrete changes, each with the file path, the line area, the exact function name, and the exact behavior.
- Same-origin invariant is correctly grounded in `location.host` derivation and is *enforced by absence* (no URL parameter) rather than by validation logic — this is the right approach.
- Data flow is shown end-to-end including the failure path.
- Scope boundary ("What NOT to Build") is unusually thorough — explicitly excludes exponential backoff, "Connecting…" intermediate state, persistent banner, silent-death detection, URL override, retry counter, and any server-side change.

### Section 3 (Acceptance Criteria) — Observable
All 10 criteria are observable from the running app. AC4 ("connection attempt within 50 ms") and AC7/AC8 (exact URL match) are particularly well-formed because they are directly verifiable in DevTools Network → WS panel. AC10 (DOM is `<div>` not `<button>` when connected) is observable via DOM inspection. None are internal-state assertions.

### Section 4 (Lifecycle Stories) — User journeys, not feature lists
All five stories follow user-action-and-outcome form. Story E (cross-environment safety with v1+v2+beta tabs open) is exactly the right scenario for the safety requirement and is written as a concrete user situation rather than a technical assertion.

### Section 5 (Risks) — Real failure modes + false-PASS risks
- Five real risks, including the non-obvious "same-origin invariant rot" via a future contributor adding a URL parameter — exactly the kind of latent regression risk an adversarial reviewer hopes to see.
- Seven false-PASS risks. The strongest are: (1) auto-retry firing during the click window and giving a false success signal, (2) substring URL matching that lets `localhost:6666` pass when expecting `localhost:7777`, and (7) the `<div tabindex="0">` vs `<button>` keyboard pitfall.

---

## Minor Observations (non-blocking)

These are nits the implementer should be aware of, but none rise to the level of a revise:

1. **Connected-state `<div>` cannot carry an HTML `title` attribute via Preact identically to a `<button>`** — both can, this is fine, but AC1 expects the *cursor remains the default arrow*. The design specifies adding only `title="Already connected"` to the connected `<div>` with no class change. Confirm in implementation that no inherited rule (e.g., a future `.system-status:hover`) accidentally introduces a pointer cursor on the `<div>`. Currently `.system-status` has no hover rule, so this is safe today.

2. **`reconnectTimer` is module-private to `connection.js`** (line 9). The design's `reconnectNow()` clears it directly, which is correct. Just flag for the implementer: do not export `reconnectTimer`; mutating it from outside would break the encapsulation that makes the OPEN/CONNECTING guard reliable.

3. **Toast duration of 1500 ms** is shorter than the default 3000 ms `showToast` uses. This is fine and intentional per the design, but the implementer must remember to pass the third argument explicitly — `showToast('Reconnecting…', 'info', 1500)` — or it will linger for 3 s.

4. **AC4 says "within 50 ms"**. That is achievable on a warm event loop but may be flaky in heavily loaded test environments. The false-PASS mitigation in Risk 1 says "<200 ms". Suggest the implementer treat the 50 ms as a target and the 200 ms as the test threshold, or harmonise the two numbers in the test.

5. **`ws` compatibility object update** — the design correctly notes adding `reconnectNow` to the `ws` object on line 114. Confirmed there are no current callers of `ws.reconnectNow` (because it does not exist yet), so this is purely additive and cannot break existing consumers.

6. **`import { reconnectNow }` placement in `actions.js`** — the existing import on line 1 is `import { send } from '../ws/connection.js';`. Cleanest is to extend that line to `import { send, reconnectNow } from '../ws/connection.js';` rather than adding a second import statement. Design implies but does not state this; worth being explicit at implementation time.

7. **`SERVER.INIT` re-loads projects/sessions/settings on every reconnect** (sessionState.js lines 75–83). This is correct for Story B (laptop wake) but means a manual reconnect during normal flow will trigger a full data reload. Not a bug — same behavior as auto-reconnect today — but worth knowing it is *not* a "lightweight" reconnect.

---

## Conclusion

This is the level of specificity an implementer can pick up and execute without further discovery. The same-origin safety invariant is enforced structurally (no URL parameter exists) rather than by validation, which is the correct architectural choice. The false-PASS risks section in particular shows the designer thought through how the feature could fail tests *while still being broken* — the exact thing this review is meant to surface.

Approved for implementation.
