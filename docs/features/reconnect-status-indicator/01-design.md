# Design: Clickable Connection Status Indicator (Manual Reconnect)

**Feature slug:** reconnect-status-indicator
**Date:** 2026-04-18
**Status:** Draft

---

## Section 1: Problem & Context

### User Problem

When the WebSocket between the browser and the server drops (server restarted, laptop slept, network blip, PM2 reload, etc.), the status indicator in the top bar flips from green "Connected" to red "Disconnected". The auto-reconnect logic in `public/js/ws/connection.js` (line 6, `RECONNECT_DELAY = 3000`, line 56, `setTimeout(connect, RECONNECT_DELAY)`) will retry every three seconds, but:

1. The user has no visible affordance to reconnect *now* — they must wait up to three seconds, often longer if the server is still coming back up and several `close` events fire in succession.
2. The dot is purely informational. There is no way to confirm "yes, I am still trying" without opening DevTools.
3. When a user notices a stale terminal or "no response" symptom, the natural instinct is to click the obvious red dot. Today nothing happens.

A manual "click to reconnect now" cuts that wait to zero and gives users a deliberate recovery path. It also makes the QA story for "server restart while UI is open" much faster to execute (T-17 in `qa-screenshots/T-17-server-restart`).

### What Currently Exists

**TopBar component** — `public/js/components/TopBar.js`:

- Lines 36–40 render the status block. The dot is a `<div class="status-dot connected|error">` and the label is `<span class="status-text">Connected|Disconnected</span>`. Neither is wrapped in a `<button>`, neither has an `onClick`, and there is no `title` attribute.
- The component reads the `connected` signal (line 10) and re-renders whenever it flips.

**Connection module** — `public/js/ws/connection.js`:

- `connect()` at line 30 is the single entry point that opens the socket. It guards against double-opening at line 31 (`OPEN || CONNECTING`).
- The URL is computed at lines 33–34: `const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';` then `new WebSocket(`${proto}//${location.host}`)`. This uses `location.host` — i.e. the same hostname **and port** the page was loaded from — and the protocol is keyed off `location.protocol`. This is exactly the same-origin guarantee the safety requirement asks for; the URL is constructed in code, not from user input.
- On `close` (line 53–57) it dispatches `connection:close` and schedules another `connect` via `reconnectTimer = setTimeout(connect, RECONNECT_DELAY)`.
- `connect` and the compatibility `ws` object (line 114) are already exported, so external callers can invoke `connect()` directly.

**State store** — `public/js/state/store.js`:

- Line 5: `export const connected = signal(false);`
- Lines 8–14: `clientId`, `serverVersion`, `serverEnv` signals — only `connected` matters for this feature.

**Connection lifecycle wiring** — `public/js/state/sessionState.js`:

- Lines 86–87: `on('connection:open', () => { connected.value = true; });` and `on('connection:close', () => { connected.value = false; });`. So the dot's `connected` truthiness reliably tracks `WebSocket.open`/`close` events.
- Lines 75–83: on `SERVER.INIT`, `connected` is also flipped to true (a redundant but harmless second flip after `open`).

**Actions module** — `public/js/state/actions.js`:

- Houses every UI-callable side effect (toasts, modal toggles, REST + WS sends). Where a manual reconnect action would live by convention (next to `openSettingsModal`, line 145).

**CSS** — `public/css/styles.css`, lines 65–81:

- `.system-status` is a flex row, `.status-dot` is the colored circle, `.status-dot.connected` is green with glow, `.status-dot.error` is red. There is no hover style and no cursor change.

### What's Missing

1. The status block is not interactive — no click handler, no cursor affordance, no tooltip.
2. There is no exported "force a reconnect now" action; the only way to trigger one is to wait for the timer in `connection.js`.
3. There is no way for a click handler to skip the 3-second debounce: even if it called `connect()` directly today, it would also need to clear `reconnectTimer` so the pending retry does not race the manual one.
4. The connected-state UX (tooltip "already connected" vs disabled affordance) is undefined.

---

## Section 2: Design Decision

### What to Build

**Three small, additive changes. No file is created; nothing is renamed; nothing is removed.**

#### Change 1 — `public/js/ws/connection.js`: export a `reconnectNow()` helper

Add (do not modify existing behavior) a new exported function `reconnectNow()` that:

1. Cancels any pending `reconnectTimer` (`clearTimeout(reconnectTimer); reconnectTimer = null;`) so the auto-retry will not double-fire on top of the manual call.
2. If the socket is currently `OPEN` or `CONNECTING`, returns early (no-op). This is the same guard already at line 31 — we keep it co-located so the helper is safe to call regardless of state.
3. If the socket is `CLOSING`, schedules a one-shot retry on the next tick (so we don't try to open while the previous instance is mid-teardown).
4. Otherwise calls `connect()`.
5. Returns nothing. (No promise — UI feedback is driven entirely by the existing `connection:open` / `connection:close` dispatch path.)

Also add `reconnectNow` to the `ws` compatibility object exported at line 114 so callers using the namespaced import get it too.

The same-origin guarantee comes for free because `reconnectNow()` calls `connect()`, which constructs the URL from `location.protocol` + `location.host` (lines 33–34). There is no user-supplied URL anywhere in this code path. We will explicitly call this out in code comments so a future refactor cannot quietly introduce a parameter.

#### Change 2 — `public/js/state/actions.js`: add `manualReconnect()` action

Add a single new exported function `manualReconnect()` adjacent to `openSettingsModal` (around line 145). It:

1. Imports `reconnectNow` from `../ws/connection.js` (the file already imports `send` from there).
2. Reads `connected.value`. If true, returns early — no-op (the click handler will gate on this too, this is defense in depth).
3. Calls `reconnectNow()`.
4. Calls `showToast('Reconnecting…', 'info', 1500)` so the user gets immediate feedback that their click was registered. (Without this, in the half-second between click and the next `connection:close → connection:open` cycle, the UI looks dead.)

We deliberately keep the toast short (1.5s) and informational rather than persistent because the indicator itself will flip to green within that window if the reconnect succeeds.

#### Change 3 — `public/js/components/TopBar.js`: make the status block a button when disconnected

Modify lines 37–40. The current `<div class="system-status">` block becomes:

- When `isConnected === true`: render the existing `<div class="system-status">` unchanged in structure, but add a `title="Already connected"` attribute on the wrapper. No click handler, no cursor change. Visually identical to today.
- When `isConnected === false`: render a `<button type="button" class="system-status system-status-clickable" title="Click to reconnect now" onClick=${manualReconnect}>` containing the same dot + label. We add a second class `system-status-clickable` so we can give it a pointer cursor and a subtle hover state without affecting the connected case.

Importing `manualReconnect` joins the existing `openSettingsModal` import on line 3.

#### Change 4 (CSS) — `public/css/styles.css` around line 81

Append two small rules:

- `.system-status-clickable { cursor: pointer; background: transparent; border: none; padding: 0; font: inherit; color: inherit; }` — strip default button chrome so the clickable variant looks identical to the read-only div.
- `.system-status-clickable:hover .status-dot.error { box-shadow: 0 0 6px var(--danger); }` — a subtle glow on hover so the user knows the dot is interactive without changing layout.

Optionally add `.system-status-clickable:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }` for keyboard accessibility (the element becomes a real `<button>`, so it is keyboard-focusable for free).

### Data Flow

```
User clicks the red dot in the TopBar
  → onClick fires manualReconnect()         [actions.js, new]
    → guard: connected.value === false
    → showToast('Reconnecting…', 'info')    [existing util]
    → reconnectNow()                        [connection.js, new]
      → clearTimeout(reconnectTimer)
      → if OPEN/CONNECTING: return
      → connect()                           [existing, line 30]
        → new WebSocket(${proto}//${location.host})  [SAME ORIGIN]
        → on 'open': dispatch('connection:open')
          → sessionState.js handler flips connected.value = true
            → TopBar re-renders, dot turns green, button reverts to <div>
        → on SERVER.INIT: loadProjects/Sessions/Settings refresh
```

Failure path:

```
User clicks while server is still down
  → manualReconnect → reconnectNow → connect()
  → new WebSocket fails → 'close' fires
  → existing handler dispatches connection:close (no-op, already false)
  → existing handler schedules reconnectTimer = setTimeout(connect, 3000)
  → Toast already faded; user is free to click again immediately
```

### Edge Cases & Failure Modes

1. **Rapid clicking.** The OPEN/CONNECTING guard inside `reconnectNow` (and the `connected.value` guard inside `manualReconnect`) means N clicks in 100ms collapse to at most one `new WebSocket` per actual close. The toast may queue, but `showToast` already supports concurrent toasts.
2. **Click while the socket is mid-teardown (`CLOSING`).** Without handling this, `connect()` would short-circuit because the readyState is neither OPEN nor CONNECTING but the old socket is still occupying `_ws`. We handle it by scheduling a `setTimeout(connect, 0)` so the close event fires first, then the new open begins.
3. **Click while the auto-reconnect timer is about to fire.** We clear `reconnectTimer` in `reconnectNow` so the timer cannot race the manual call. If we did not, two `connect()` calls would fire and the second would be a no-op due to the OPEN/CONNECTING guard — harmless but confusing in logs.
4. **Click while `connected.value` is true but the socket actually died silently.** The signal can only be true if `connection:open` fired without a subsequent `connection:close`. If a real silent death occurred, the next attempted `send()` would log `[ws] send called but socket not open` (connection.js line 71). This is out of scope — fixing silent-death detection is a separate feature (heartbeat/ping). We document this in the scope-boundary section.
5. **Server is on a different origin (reverse proxy, dev tunnel).** The `location.host` derivation guarantees we always reconnect to the exact origin the page was loaded from. Hardcoding or allowing a parameter would create the cross-environment hazard the requirement explicitly forbids. Code comment will state: "Do NOT add a URL parameter to reconnectNow(). Same-origin is a safety invariant."
6. **Tooltip in mobile browsers.** `title` is a no-op on touch devices. Not a regression — the dot is still tappable. We are not adding a custom popover to keep scope tight.
7. **Accessibility.** Switching `<div>` to `<button>` when disconnected makes it focusable and Enter/Space-activatable for keyboard users. The connected variant remains a `<div>` (non-interactive content does not need to be a button).
8. **Loss of connection while a Toast is up.** The new toast is independent of the existing toast lifecycle, so this is a non-issue.

### What NOT to Build

- **No exponential backoff.** The existing 3s fixed delay stays. Tightening backoff is a separate concern and would interact with this feature only superficially.
- **No "Connecting…" intermediate label.** The dot currently has only two visual states. Adding a third (yellow/pulsing) is tempting but expands the design surface and CSS. A short toast covers the gap.
- **No persistent banner / no modal.** The status block is the entire UI surface for this feature.
- **No silent-death detection (heartbeat / ping).** Out of scope. Documented as a known limitation.
- **No URL override / no environment switcher.** The same-origin invariant is enforced by *not having* a URL parameter on `reconnectNow`.
- **No retry counter, no "tried N times" UI.** Existing console logs are sufficient for diagnostics.
- **No change to the auto-reconnect cadence**, the WebSocket protocol, or any server file.

---

## Section 3: Acceptance Criteria

1. Given the WebSocket is connected (green dot, "Connected" label), when the user hovers the status block, then the cursor remains the default arrow and a tooltip reads "Already connected".
2. Given the WebSocket is connected, when the user clicks the status block, then no network traffic is generated, no toast appears, and the indicator state is unchanged.
3. Given the server has just been restarted (red dot, "Disconnected" label) and the auto-reconnect timer is mid-wait, when the user hovers the status block, then the cursor changes to a pointer and a tooltip reads "Click to reconnect now".
4. Given the indicator is red, when the user clicks it, then a toast saying "Reconnecting…" appears immediately and a new WebSocket connection attempt is made within 50 ms (observable in DevTools Network → WS panel).
5. Given the indicator is red and the server is reachable, when the user clicks it, then within ~1 second the dot turns green, the label flips to "Connected", and the button reverts to a non-interactive `<div>`.
6. Given the indicator is red and the server is still down, when the user clicks it three times in two seconds, then exactly one WebSocket attempt fires per actual close (no socket leak; verifiable via DevTools showing one WS row per real attempt).
7. Given the page was loaded from `https://app.example.com:8443/`, when a manual reconnect fires, then the WebSocket URL is exactly `wss://app.example.com:8443/` — same protocol, host, and port. Reproducible by inspecting the WS request URL in DevTools.
8. Given the page was loaded from `http://localhost:7777/` (v2 dev), when a manual reconnect fires, then it never targets a different port (e.g., the v1 7777 vs beta port). Verifiable by Network panel.
9. Given the user activates the (button) indicator with the keyboard (Tab to focus, Enter to activate) while disconnected, then the same reconnect flow runs as on click.
10. Given the page is loaded fresh and the server is up, when the user inspects the DOM, then the status block is rendered as a `<div>` (not a `<button>`) — confirming the connected variant is non-interactive.

---

## Section 4: User Lifecycle Stories

### Story A — Server restart during active work

Mara is mid-conversation in a Claude session when her sysadmin pushes a server update via PM2. The terminal output stops. Within ~1 second the dot in the top bar flips red and reads "Disconnected". She glances at it, hovers — the cursor changes to a pointer and the tooltip says "Click to reconnect now". She clicks. A "Reconnecting…" toast appears, and a moment later the dot turns green again. She types into her terminal and the response streams back. She did not have to refresh the page or wait an unknown number of seconds for an automatic retry.

### Story B — Laptop wakes from sleep

Devon closes his laptop lid for an hour. When he reopens it, the browser tab is still loaded but the dot is red. He clicks it. The reconnect succeeds, the projects/sessions list refreshes (existing `SERVER.INIT` handler reloads everything), and his last open session overlay reattaches via the existing `TerminalPane` reconnect logic. He continues working without a page reload.

### Story C — Server is genuinely down

Priya's dev server crashed. She sees the red dot, clicks it. A "Reconnecting…" toast appears and disappears, but the dot stays red. She fixes the server, clicks the dot again — this time it goes green. She is never blocked by an unclickable indicator and is never told to refresh.

### Story D — Confirming everything is fine

Sam notices a slow terminal response and wonders if the WebSocket is alive. He hovers the dot — it is green and the tooltip confirms "Already connected". He clicks it: nothing happens. He immediately knows the connection is not the problem and looks elsewhere. The "already connected" state never accidentally tears down a healthy socket.

### Story E — Cross-environment safety

A user has both v1 (port 7777) and v2 (port 7778) open in adjacent tabs, plus a beta instance on a third port. v1 server restarts. The v1 tab's dot goes red. She clicks it. The reconnect targets the same `location.host` the v1 tab was loaded from — port 7777 only. The v2 and beta tabs are untouched. She never accidentally pulls v1 traffic into v2 or vice versa, even though the manual reconnect feature exists in all three apps.

---

## Section 5: Risks & False-PASS Risks

### Real risks

1. **Browser caches old `connection.js`.** If a user's tab was loaded *before* the deploy of this change, the new `reconnectNow` does not exist and `manualReconnect` would call an undefined import. Mitigation: import lives in `actions.js`, which is fetched as part of the same page load — so a stale tab without the new connection.js is impossible (the browser would not have loaded either change). Hard refresh after deploy is the standard expectation.
2. **Toast spam on rapid clicks.** Clicking the dot ten times queues ten toasts. The reconnect itself is debounced, but the visual noise is not. Acceptable for an action a user takes deliberately. If it becomes annoying, a future iteration can throttle the toast to one-per-second.
3. **Click-while-CLOSING race.** Mishandling the `CLOSING` readyState would mean the manual click silently does nothing. Mitigation: the explicit `setTimeout(connect, 0)` branch in `reconnectNow`. Tests must specifically exercise the close-then-immediate-click path.
4. **Confusing "click does nothing" when connected.** A user who clicks the green dot, sees no feedback, and assumes the feature is broken. Mitigation: tooltip "Already connected" on hover. Could be reinforced by a brief visual pulse on click — out of scope for v1.
5. **Same-origin invariant rot.** A future contributor adds `reconnectNow(url)` thinking it's helpful for tests. The cross-environment hazard returns. Mitigation: code comment in `connection.js` immediately above `reconnectNow` stating "Do NOT add a URL parameter — same-origin is a safety invariant. The URL is derived from `location` for a reason." A test that asserts the WS URL equals `${proto}//${location.host}` after reconnect locks this in.

### False-PASS risks (test that "passes" while feature is broken)

1. **Test asserts the dot turns green, but the green came from the auto-reconnect timer rather than the click.** If a tester clicks the dot 2.9 seconds into the 3-second auto-retry window, the auto-retry would have happened anyway. Mitigation: any test must measure the time from click to `open` event being **<200 ms**, which is an order of magnitude faster than auto-retry could achieve. Alternatively, the test must clear or extend `RECONNECT_DELAY` for the test run.
2. **Test asserts a click reconnects, but the click is hitting the connected-state click path which is a no-op.** A test that runs while connected, clicks the dot, and then waits for any reconnect at all will incorrectly pass if auto-retry happens for unrelated reasons. Mitigation: tests must explicitly assert "no WS connection attempt occurred during the connected-state click test."
3. **Test asserts tooltip text by reading `title` attribute, but the attribute is set on the wrong element.** Easy to put `title="Already connected"` on the inner `<span>` not the wrapper, and the visible tooltip differs by browser. Mitigation: assert on the wrapper element specifically.
4. **Test asserts URL same-origin by checking the string `'localhost'` is in the URL.** This passes if the URL is `ws://localhost:6666/` even though the page was on `http://localhost:7777/`. Mitigation: assert exact equality with `${proto}//${location.host}`, never substring matches.
5. **Test asserts a toast appears, but the toast is from a different source (e.g., session error).** Mitigation: assert the exact toast text "Reconnecting…" and the type `info`.
6. **Test passes because the WebSocket helper in test mode is mocked to always succeed.** A mock that ignores the URL entirely lets a buggy URL slip through. Mitigation: at least one end-to-end test must use a real browser WS against a real server — the existing Playwright pipeline already supports this (see `playwright-feat-*.config.js` files at repo root).
7. **Keyboard activation appears to work because the focus ring is visible, but Enter does nothing.** A common pitfall when a `<div>` is given `tabindex="0"` instead of being changed to a real `<button>`. Mitigation: the design specifies a real `<button>`, and the test must use `keyboard.press('Enter')` after focusing, not just check focus styles.
