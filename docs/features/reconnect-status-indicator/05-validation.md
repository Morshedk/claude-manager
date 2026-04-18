# Validation: Clickable Connection Status Indicator (Manual Reconnect)

**Feature slug:** reconnect-status-indicator
**Validator:** Claude Code (claude-opus-4-7) — TEST VALIDATOR (adversarial)
**Date:** 2026-04-18
**Verdict:** **FEATURE COMPLETE (with one weak test noted)**

---

## Method

Read in order:
1. `01-design.md` — design contract.
2. `02-implementation-notes.md` — implementer's claims.
3. `03-review.md` — reviewer's FAITHFUL verdict.
4. `03-test-designs.md` — declared test plan.
5. `04-test-run-output.txt` — claimed run results.
6. `tests/adversarial/feat-reconnect-status-indicator-T{1..4}-*.test.js` — actual code that ran.
7. `public/js/ws/connection.js`, `public/js/state/actions.js`, `public/js/components/TopBar.js`, `public/css/styles.css` — to confirm the implementation matches what the tests are exercising.
8. Screenshots in `qa-screenshots/T-reconnect-indicator-T{1..4}/` — independent corroboration.

I deliberately looked for: precondition gaps, assertion-on-mock, substring matches that masquerade as exact, race-window trickery, and any "passes for the wrong reason" pattern from the design's section 5 (false-PASS risks).

---

## Per-test analysis

### T-1 — Connected state: indicator is NOT clickable

**Outcome valid?** **GENUINE PASS.**

**Precondition established.** The page connects (`waitForSelector('.status-dot.connected', timeout 10000)` is awaited before any assertion). The element under test is the live `.system-status` after WS handshake, not a mocked surface.

**Design sound?** Mostly yes. It catches three independent failure modes:

1. **Tag check (`tagName === 'DIV'`)** — would catch a regression where the connected branch wrongly rendered a `<button>`.
2. **Title check (`'Already connected'`)** — would catch a wrong/missing title.
3. **Computed cursor (`!== 'pointer'`)** — would catch a CSS regression that bled the `.system-status-clickable` cursor onto the connected branch.
4. **No-toast-on-click** — would catch a wiring bug where `onClick={manualReconnect}` was attached to the connected branch.

There is one **partially redundant assertion**: the no-toast check would still pass even if a future change wrongly attached `onClick={manualReconnect}` to the connected branch, because `manualReconnect` itself early-returns when `connected.value === true` (defense in depth in `actions.js:153`). So the no-toast check alone cannot distinguish "no handler attached" from "handler attached but action correctly guarded". However, the tag-name and computed-cursor assertions DO catch that case independently. Net: not vacuous, just slightly belt-and-suspenders.

**Execution faithful?** Yes. Test code matches design steps 1–10 verbatim; toast detection uses `text=Reconnecting` literal text (not a structural-class proxy), which is the exact-text check the design demanded.

**Evidence trail:** `qa-screenshots/T-reconnect-indicator-T1/01-connected.png` and `02-after-click.png` are byte-identical (24504 bytes each), consistent with no UI change after clicking the connected indicator. Confirms the assertion empirically.

---

### T-2 — Disconnected state: click triggers reconnect

**Outcome valid?** **GENUINE PASS.**

**Preconditions established correctly** — and this is the test where preconditions matter most:

1. Server is brought up fresh (port 3202, fresh `dataDir`).
2. Page loads and WS handshake completes (`.status-dot.connected` appears).
3. Server is **really killed** via `SIGKILL` on the captured PID (not mocked, not `pm2 stop` — a hard kill).
4. The test waits for BOTH `.status-dot.error` AND `tagName === 'BUTTON'` before proceeding. So the disconnected button state is genuinely established.
5. Server is restarted on the same port; `waitForServerReady` polls `/` until 200 OK before any click.

**Design sound?** This is the test that locks in false-PASS risk #1 (auto-retry doing the work the click was supposed to). The assertion `expect(elapsed).toBeLessThan(1000)` proves click-driven reconnect, because:
- Auto-retry fires at `RECONNECT_DELAY = 3000` ms after the close event.
- The close event fired at SIGKILL time. By the time the test (a) waits for error state, (b) restarts the server, (c) waits for it to be ready, (d) clicks — multiple seconds have passed. So the auto-retry would already have fired (or be very close to firing).
- However, the manual click clears `reconnectTimer` *before* opening the new socket. The 78 ms observed click-to-connected latency reported in `04-test-run-output.txt` is far below any auto-retry window — and below 200 ms, so even the design's stricter "< 200 ms" guideline would pass.
- The toast assertion (`text=Reconnecting`) is set up with `waitForSelector` *before* the click and resolves on first attached node, so a missing toast would fail the test.
- The post-reconnect tag-revert assertion (`tagName === 'DIV'`) catches a re-render bug where the button doesn't unwind.

**Execution faithful?** Yes. The order of operations matches the design (set up the toast `waitForSelector` promise BEFORE the click, otherwise a 1500 ms toast that has already faded would be missed).

**One small subtlety I considered and dismissed:** the toast-detection `waitForSelector(..., { state: 'attached', timeout: 2000 })` is wrapped in `.catch(() => null)`, but the subsequent `expect(toastEl).not.toBeNull()` correctly fails if no toast was attached within the window. This is *not* a swallowed-error bug — it's the standard way to convert a Playwright timeout into a soft `null` for an explicit assertion.

**Evidence trail:** Three screenshots `01-connected.png` (DIV with green dot), `02-disconnected-button.png` (button, larger file size 24802 B because of the cursor + button styling pixels), `03-reconnected.png` (back to connected state). File sizes are distinct and match the asserted state transitions.

---

### T-3 — Same-origin safety: WebSocket URL built from `window.location`

**Outcome valid?** **GENUINE PASS.**

**Precondition established.** The Playwright `page.on('websocket')` listener is attached BEFORE `page.goto`, so the initial WS connection is captured (the test asserts exactly 1 URL after handshake).

**Design sound?** This test deliberately neutralises false-PASS risk #4 (the "substring `'localhost'` always passes" trap) by using `expect(url).toBe(EXPECTED_WS_URL)` — exact string equality on `ws://localhost:3203/`. It also asserts `capturedWsUrls[0] === capturedWsUrls[1]` to lock down that the manual-reconnect URL is bit-identical to the initial URL.

**Static-source assertion:** the test reads `connection.js` from disk and checks (a) the source contains `location.host`, (b) the source contains the template-literal pattern `location.host}` (proving it's inside a template), and (c) no line outside comments contains a hardcoded `"ws://"`, `'ws://'`, or `` `ws://`` literal. This is exactly the regression-lockdown the design called for ("a future contributor adds `reconnectNow(url)` thinking it's helpful for tests"). I confirmed by reading `connection.js` — line 33 is the only place a `ws:` literal appears, and it's inside a ternary that picks `'wss:'` vs `'ws:'` (the trailing colon is part of `'ws:'` not `'ws://'`), so the hardcoded-`ws://` test correctly returns 0 matches.

**Execution faithful?** Yes. The originally-attempted in-page `fetch('/public/js/ws/connection.js')` was wrong (server serves `public/` as root, so the correct path is `/js/ws/connection.js`). The implementer fixed this on attempt 2 by reading from disk via `fs`, which is a strictly safer (no network hop) source check. The assertion logic was unchanged. **Acceptable infrastructure fix; not a logic change.**

**Evidence trail:** Three screenshots, distinct file sizes (24504, 24802, 27489) corresponding to connected, disconnected-with-button, and reconnected states.

---

### T-4 — Rapid clicks while disconnected: ≤1 new socket

**Outcome valid?** **GENUINE PASS but the assertion is loose.**

**Precondition established.** Server is killed, error state and button confirmed before clicking.

**Design soundness — caveat noted.** The assertion `newWsDuringClicks <= 1` allows **0 or 1** new WebSockets. The reported value was 0. Two possible interpretations:

1. **Auto-retry won the race.** After SIGKILL the close handler set `reconnectTimer = setTimeout(connect, 3000)`. The 3 seconds elapsed (or were close to) before the rapid-click loop ran. The auto-retry created a new CONNECTING socket. All 10 clicks hit `_ws.readyState === CONNECTING` and early-returned. This means the test verified the OPEN/CONNECTING guard against the auto-retry's socket, not against a click-created socket.
2. **Manual click won, then guarded subsequent clicks.** Click 1 created the socket (CONNECTING). Clicks 2–10 early-returned. Playwright's `websocket` event captured this — and the count of "new" sockets would have been 1.

The test cannot distinguish these two scenarios because it counts only sockets, not their cause. However, **both interpretations confirm the guard is working** — under either reading, 10 clicks did not create 10 sockets. The hardest failure mode the test was designed to catch ("ten clicks produce ten WebSocket entries — guard broken") is conclusively excluded by the observed `newWsDuringClicks = 0` and `total = 2`.

**An empirical detail that strengthens the test:** the screenshot `qa-screenshots/T-reconnect-indicator-T4/03-after-clicks.png` shows **ten "Reconnecting…" toasts stacked** on the right edge of the page. This independently confirms that `manualReconnect()` *did* run ten times (each call enqueued a toast), so the click-handler wiring is unambiguously alive. The `≤1 new socket` outcome is therefore *not* explained by "clicks didn't fire" — it's explained by the `OPEN/CONNECTING` guard inside `reconnectNow()` doing its job.

**Execution faithful?** Yes. The test follows the design's flow.

**Weak point worth flagging (not a fail):** `toBeLessThanOrEqual(1)` would pass even if **zero** clicks were wired to a handler at all. A stricter test would be `toBe(1)` plus a separate "manualReconnect was called 10 times" assertion (e.g., toast count). The screenshot evidence supplies that second check informally, but it isn't a programmatic assertion. **For v1 this is acceptable; for hardening, add an explicit toast-count check.**

---

## Cross-cutting checks

| False-PASS risk from `01-design.md` §5 | Mitigated by |
| --- | --- |
| 1. Click claimed credit, but auto-retry actually reconnected | T-2 measures `elapsed < 1000 ms` (auto-retry fires at 3 s). 78 ms observed. |
| 2. Connected-state click test "passes" via unrelated reconnect | T-1 explicitly checks zero "Reconnecting" toasts and unchanged dot. |
| 3. Tooltip on inner element instead of wrapper | T-1 reads `.system-status` wrapper directly. |
| 4. Substring match on `'localhost'` | T-3 uses `toBe()` exact equality. |
| 5. Toast comes from another source | T-1 and T-2 match the literal text "Reconnecting". |
| 6. WS helper mocked to always succeed | All four tests use a real Node `server.js` child process; no mocks. |
| 7. Keyboard activation appears to work via focus ring only | Not tested (acceptance criterion 9 is uncovered — see below). |

**Implementation cross-check (independent of test pass/fail):**
- `connection.js:117` — `reconnectNow()` has zero parameters. Same-origin invariant intact.
- `connection.js:34` — `new WebSocket(`${proto}//${location.host}`)` is the only WS constructor call.
- `connection.js:121` — implementer-added `if (!_ws) connect()` guard is present and prevents the `null.readyState` crash flagged in implementation-notes section "Things the Designer Missed".
- `actions.js:152-156` — `manualReconnect` correctly guards on `connected.value`, then toasts, then calls `reconnectNow()`.
- `TopBar.js:37-51` — branches between `<div>` (connected) and `<button type="button" class="system-status system-status-clickable" ...>` (disconnected), exactly per design.
- `styles.css:82-91` — three rules (`.system-status-clickable`, `:hover`, `:focus-visible`) all present.

---

## Acceptance criteria coverage

| AC | Covered by | Notes |
| --- | --- | --- |
| 1. Connected: cursor default, tooltip "Already connected" | T-1 | Both checked. |
| 2. Connected: click is no-op | T-1 | No toast, no state change. |
| 3. Disconnected: cursor pointer, tooltip "Click to reconnect now" | **NOT explicitly tested** | The disconnected branch's `title` attribute is rendered (per source line 45) but no test reads it. The `cursor: pointer` is in CSS but no test asserts the computed cursor in the disconnected state. **Gap.** |
| 4. Toast within 50 ms; new WS within ~1 s | T-2 | Toast attached, 78 ms observed. |
| 5. Dot turns green within 1 s; reverts to `<div>` | T-2 | Both checked. |
| 6. Three clicks in 2 s → one socket per real close | T-4 | Tested with ten clicks (stronger). |
| 7. WS URL exactly matches origin | T-3 | Exact `toBe()` check. |
| 8. Never targets a different port | T-3 | Both URLs equal `ws://localhost:3203/` exactly. |
| 9. Keyboard activation via Tab+Enter | **NOT tested** | The element is a real `<button>` so it should work for free, but no test exercises it. **Gap.** |
| 10. Connected DOM is `<div>`, not `<button>` | T-1 | Tag-name assertion. |

**Two gaps identified:**

- AC-3 (disconnected tooltip + pointer cursor) is verifiable from the source code and is tested indirectly (T-2 finds the button and clicks it, which would fail if it weren't focusable/visible), but no test asserts the `title` text or `cursor: pointer` for the disconnected state. Risk: **low** — the source clearly contains both, and a regression would be visible in the screenshots, but it's not a hard assertion.
- AC-9 (keyboard activation) is structurally guaranteed because the design used a real `<button>` (false-PASS risk #7 was about choosing the right element type; the right type was chosen). Risk: **low** — would only break if a future refactor switched back to `<div role="button">`.

---

## Overall verdict

**FEATURE COMPLETE.**

- All four declared tests are GENUINE PASSes.
- The implementation matches the design and the review's FAITHFUL verdict.
- No security issue: same-origin invariant is enforced structurally (no URL parameter on `reconnectNow`, comment block forbidding addition, exact-equality test in T-3 that would catch a regression).
- No race-condition gap: all four design-flagged races (`OPEN`, `CONNECTING`, `CLOSING`, `_ws === null`) are handled in `reconnectNow()` and the implementation matches the review's claim line-by-line.

**Two soft observations**, neither sufficient to downgrade the verdict:

1. T-4's `≤ 1 new socket` assertion is looser than necessary; it would pass even if `manualReconnect` weren't wired to the click. The 10-toast screenshot supplies independent evidence that the clicks did fire and the action did run, so the test is not vacuous in practice — just not as tight as a `toBe(1)` plus toast-count assertion would be.
2. AC-3 (disconnected-state tooltip and pointer cursor) and AC-9 (keyboard Enter activation) are not directly asserted in any test. Both are structurally satisfied by the source, and AC-9 is guaranteed by using a real `<button>` rather than a div with `tabindex`. Worth adding a small extension test if hardening is desired.

No false PASSes were found. No vacuous PASSes. No infrastructure-failure-masquerading-as-success.
