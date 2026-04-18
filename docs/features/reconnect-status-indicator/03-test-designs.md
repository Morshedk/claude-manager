# Test Designs: Clickable Connection Status Indicator

**Feature slug:** reconnect-status-indicator
**Author:** Claude Code (claude-opus-4-7)
**Date:** 2026-04-18

These tests cover the user lifecycle stories A–E in section 4 of `01-design.md`. Each test runs against a real server on its own port to avoid cross-test interference. Tests are designed to fail loudly if the implementation regresses — in particular, false-PASS risk #1 (auto-retry timer doing the work the click was supposed to do) is mitigated by measuring click-to-open latency.

---

## Infrastructure for the Test Executor

- **Server entrypoint:** `node server.js` (NOT `server-with-crash-log.mjs`). Confirmed present in repo root.
- **Env vars per test:** `DATA_DIR=/tmp/test-recon-T<N>` and `PORT=3200+<N>`.
  - Seed `${DATA_DIR}/projects.json` with `{ "projects": [], "scratchpad": [] }` (object, NOT a bare array — required by ProjectStore).
  - Seed `${DATA_DIR}/sessions.json` with `[]`.
- **Playwright config:** create `playwright-feat-reconnect-indicator.config.js` at repo root.
  - **Import:** `import { defineConfig, devices } from 'playwright/test';` (NOT `'@playwright/test'`).
  - **Module type:** ES modules (package.json declares `"type": "module"`); use `import`, never `require`.
- **WebSocket URL the page opens:** bare `ws://localhost:<PORT>` (no `/ws` suffix). The server upgrades any WS request on the same origin.
- **Session status field:** `session.status` (NOT `session.state`) when asserting on session shape — though no test below needs this.
- **How to break the connection from the page side:** `page.evaluate(() => window._ws?.close())`. The connection module does not expose `_ws` on `window` today, so use one of:
  - **Preferred:** kill the server process (`pm2 stop` is not appropriate here; spawn fresh via Node child process and SIGKILL it).
  - **Alternative:** in the test's setup, monkey-patch `WebSocket.prototype.close` exposure via `page.addInitScript` to capture the socket onto `window._wsForTest`, then call `.close()` on it.
- **`window._ws` is NOT a public surface.** Tests below use the server-kill approach to keep the production code untouched.

---

## T-1: Connected state — indicator is NOT clickable

**Story covered:** D (confirming everything is fine).

**Flow:**
1. Start server on `PORT=3201`, `DATA_DIR=/tmp/test-recon-T1`.
2. Launch Playwright; `page.goto('http://localhost:3201/')`.
3. Wait for `.status-dot.connected` to be visible (verifies WS handshake completed).
4. Locate the status block via `page.locator('.system-status')`.
5. Assert `await locator.evaluate(el => el.tagName)` returns `'DIV'` (not `'BUTTON'`).
6. Assert `await locator.getAttribute('title')` equals `'Already connected'`.
7. Assert that the element has no `onclick` property and no `cursor: pointer` style: `await locator.evaluate(el => getComputedStyle(el).cursor)` should NOT be `'pointer'` (will be `'auto'` or `'default'`).
8. Click the element (Playwright will allow click on a `<div>`).
9. Wait 500 ms. Assert that no toast was rendered: `await page.locator('.toast, [class*="toast"]').count()` returns `0`.
10. Assert the dot is still `.status-dot.connected`.

**Pass condition:** Element is a `<div>`, has `title="Already connected"`, has no pointer cursor, click produces no toast and no state change.

**Fail signal:** Element is a `<button>` while connected, OR a "Reconnecting…" toast appears, OR cursor computes to `pointer`. Any of these means the connected branch is wrongly rendering the clickable variant.

**Test type:** Playwright browser

**Port:** 3201

---

## T-2: Disconnected state — click triggers reconnect

**Story covered:** A (server restart during active work).

**Flow:**
1. Start server on `PORT=3202`, `DATA_DIR=/tmp/test-recon-T2`. Capture the child PID.
2. Launch Playwright; `page.goto('http://localhost:3202/')`.
3. Wait for `.status-dot.connected` to appear.
4. Kill the server child (`process.kill(pid, 'SIGKILL')`).
5. Wait for `.status-dot.error` to appear AND `.system-status` to become a `<button>` (poll up to 5 s).
6. Restart the server on the same port (re-spawn Node with same env). Wait for `curl http://localhost:3202/` to return 200.
7. Record `clickStart = Date.now()`. Click `.system-status` (the button).
8. Wait for `.status-dot.connected` to reappear (timeout 2 s).
9. Record `clickEnd = Date.now()`. Assert `clickEnd - clickStart < 1000` (click-driven, not auto-retry — auto-retry is 3 s).
10. Assert a toast with text `Reconnecting…` was visible at some point during the wait (check `page.locator('text=Reconnecting…')` was rendered, even briefly — use `page.waitForSelector('text=Reconnecting…', { state: 'attached', timeout: 500 })` immediately after the click).
11. After reconnect, assert `.system-status` is a `<div>` again (button has reverted).

**Pass condition:** Click while disconnected produces (a) a "Reconnecting…" toast within 500 ms, (b) `.status-dot.connected` within 1 s of the click, (c) the element reverts to `<div>` after success.

**Fail signal:** No toast appears (action did not run), OR the dot does not turn green within 1 s (proves auto-retry would have done the work — false-PASS risk #1), OR the element stays a `<button>` after reconnect (re-render bug).

**Test type:** Playwright browser

**Port:** 3202

---

## T-3: Same-origin safety — WebSocket URL is built from `window.location`

**Story covered:** E (cross-environment safety).

**Flow:**
1. Start server on `PORT=3203`, `DATA_DIR=/tmp/test-recon-T3`.
2. Launch Playwright with WebSocket request capture enabled (`page.on('websocket', ws => urls.push(ws.url()))`).
3. `page.goto('http://localhost:3203/')`. Wait for `.status-dot.connected`.
4. Assert exactly one entry in `urls` and that it equals `ws://localhost:3203/` exactly. (Substring matching on `'localhost'` is forbidden per false-PASS risk #4.)
5. Kill the server. Wait for `.status-dot.error`. Restart the server on the same port.
6. Click `.system-status`. Wait for `.status-dot.connected`.
7. Assert `urls.length === 2` and the second URL equals `ws://localhost:3203/` exactly — same protocol, same host, same port as the page origin.
8. Static-source assertion: `fetch /public/js/ws/connection.js` and assert the source contains the literal substring ``${proto}//${location.host}`` and does NOT contain the substring `ws://` as a hardcoded URL prefix in `connect`/`reconnectNow`.

**Pass condition:** Both WebSocket URLs equal `ws://localhost:3203/` exactly, and the source contains the `location.host` derivation.

**Fail signal:** A WebSocket URL has any other host or port (cross-origin leakage), OR the source contains a hardcoded URL string (regression of the same-origin invariant), OR the manual-reconnect WS URL differs from the initial WS URL.

**Test type:** Playwright browser

**Port:** 3203

---

## T-4 (adversarial): Rapid clicks while disconnected — only one socket per real close

**Story covered:** Edge case 1 in design section 2 (rapid clicking).

**Flow:**
1. Start server on `PORT=3204`, `DATA_DIR=/tmp/test-recon-T4`.
2. Launch Playwright with WebSocket request capture: `page.on('websocket', ws => urls.push({ url: ws.url(), t: Date.now() }))`.
3. `page.goto('http://localhost:3204/')`. Wait for `.status-dot.connected`. Snapshot `urls.length` (expect 1).
4. Kill the server. Wait for `.status-dot.error`.
5. While the server is still down, click `.system-status` ten times in rapid succession (`for (let i=0; i<10; i++) await locator.click({ force: true });` — no awaits in between beyond Playwright's internal queuing).
6. Wait 500 ms.
7. Count NEW WebSocket URLs created since step 3's snapshot. Assert: between **0 and 1** new URLs (zero is acceptable because the server is down and the OPEN/CONNECTING guard or CLOSING-deferral may not have produced a new socket; one is acceptable because the first click triggers a fresh connect attempt that immediately closes). The hard assertion is **NOT MORE THAN 1 new URL**.
8. Restart the server. Wait up to 5 s for `.status-dot.connected` to reappear (auto-retry from the close handler will reconnect).
9. Final assertion: total WebSocket URLs across the whole test ≤ (initial 1) + (rapid-click batch ≤ 1) + (post-restart open ≤ 2 due to possible interleaved auto-retry) = **≤ 4**. If 11+ URLs were created (one per click), the OPEN/CONNECTING guard is broken.

**Pass condition:** Ten rapid clicks produce **at most one** new WebSocket URL during the disconnected window. Total WS URLs across the whole test stays ≤ 4.

**Fail signal:** Ten clicks produce ten WebSocket entries (no debouncing — guard broken), OR the page hangs (synchronous loop blew up), OR the total URL count exceeds 4 (socket leak — `reconnectTimer` not being cleared so manual + auto are racing repeatedly).

**Test type:** Playwright browser

**Port:** 3204

---

## Cross-Test Notes

- Each test owns its own port and `DATA_DIR` so they are safe to run in parallel (`workers: 4` in the Playwright config), though `workers: 1` is the safer default given the server-kill choreography in T-2 and T-4.
- None of these tests asserts on session shape, so the `session.status` vs `session.state` distinction does not bite. The seed file format (`{ "projects": [], "scratchpad": [] }`) is what matters for server boot.
- T-2 and T-4's "kill server, restart server" pattern requires the test runner to track child PIDs. Use Node's `child_process.spawn` with `detached: false` so the child is automatically reaped, and capture the PID for `process.kill`.
- T-1 verifies the FAITHFUL implementation by assertion-on-tag; if a future refactor changes the connected-state element to a `<button disabled>`, T-1 will fail and force the refactor author to update or justify the change.
- All tests should produce screenshots into `qa-screenshots/T-N-reconnect-indicator/` for the QA evidence trail (consistent with existing T-NN naming in the repo).
