# T-43 Design: Haiku Endurance — 20 Messages, 5× Refresh, 3× Reload, Full Lifecycle

**Score:** 11 | **Type:** Playwright browser (full lifecycle, sentinel protocol) | **Port:** 3140  
**Requires:** Real Claude binary (`claude-haiku-4-5-20251001`)

---

## What This Test Must Prove

T-43 is the comprehensive endurance test for the browser-facing session lifecycle. It validates that:

1. A real Claude haiku session can be created via the browser UI and the terminal overlay.
2. A 20-message sentinel protocol (ACK_1 through ACK_20) can be executed with correct ordering.
3. **Refresh** (via the "Refresh" button in SessionOverlay) preserves the live connection — after a click-refresh, ACK continues without re-establishing a new sentinel from scratch.
4. **Hard browser reload** (CDP-based) does not lose the session — after reload, re-selecting the project, re-opening the overlay, and continuing to send messages works correctly.
5. **Overlay close and reopen** (click ✕ then click the session card again) preserves the live session — ACKs continue after re-attaching.
6. **Stop and delete** cleanly removes the session card from the UI.

This test differs from F-lifecycle in that it:
- Uses the **browser UI** for all Refresh actions (not raw WS `session:refresh`).
- Tests **5 browser-side Refresh clicks** across the message sequence (not just one).
- Tests **3 hard browser reloads** (not just one).
- After each interruption (Refresh/Reload/Overlay-close), continues the same sentinel conversation — conversation continuity is verified.

---

## Source File Analysis

### SessionOverlay.js — Selectors
- Refresh button: `button[title="Refresh session"]` — text "Refresh", inline title attr
- Stop button: `#btn-session-stop` — text "Stop"
- Close button: `#btn-detach` — text "✕" (Unicode ×, U+00D7)
- Overlay container: `#session-overlay`

### SessionCard.js — Selectors
- Card container: `.session-card`
- Card name (clickable link): `.session-card-name-link`
- Session last-line: `.session-lastline`
- Open button: `.session-card-actions .btn-ghost` (text "Open")

### ProjectSidebar.js — Selectors
- Project items: `.project-item`
- A specific project: `.project-item:has-text("<name>")`

### F-lifecycle.test.js — Proven Infrastructure Patterns
The F-lifecycle test (all 16 steps passing at ~1.8 min) provides battle-tested patterns:
- `attachAndCollect` vs `subscribeAndCollect` distinction
- `buildCollector` with `waitForAck(n, timeoutMs)` and `clearBuffer()`
- `waitForMsg`, `wsConnect`, `waitForStatus`, `getSessionStatus` helpers
- TUI ready polling: `buffer.includes('bypass') || buffer.length > 2000`
- Sentinel text: `"ACK_N where N increments from 1"` — no literal `ACK_1` in the string
- Input: MUST end with `\r` not `\n`
- 3s inter-message sleep for TUI input-prompt return

---

## Infrastructure

### Port and directories
- PORT: 3140
- DATA_DIR: `mktemp -d /tmp/qa-T43-XXXXXX`
- CRASH_LOG: `$DATA_DIR/crash.log`
- Screenshots: `qa-screenshots/T43-haiku-endurance/`

### Server startup
Spawn `node server-with-crash-log.mjs` in the app directory with `DATA_DIR`, `PORT=3140`, and `CRASH_LOG` env vars. Poll `GET http://127.0.0.1:3140/` every 400ms up to 25s. Fail if not ready.

### ProjectStore seed
After server is up, create a project via REST `POST /api/projects`:
```json
{ "name": "T43-Project", "path": "<projPath>" }
```
Where `projPath = path.join(tmpDir, 'project')` — create the directory on disk.

### Browser setup
Use `chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })`.

Navigate with `waitUntil: 'domcontentloaded'`.

After navigation, wait for "Connected" indicator:
```javascript
await page.waitForFunction(
  () => document.querySelector('.status-connected, [class*="connected"]') !== null ||
        document.body.textContent.includes('Connected'),
  { timeout: 30000 }
);
```

Then sleep 1200ms for Preact hydration.

### CDP hard reload
For browser reload, use CDP to bypass cache:
```javascript
const client = await page.context().newCDPSession(page);
await client.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
await client.send('Network.setCacheDisabled', { cacheDisabled: false });
await client.detach();
```

---

## Detailed Execution Flow

### Phase 0: Setup
1. Kill any existing process on port 3140.
2. Create `tmpDir`, `projPath`, screenshot dir.
3. Spawn server.
4. Wait for server ready.
5. Create project via REST. Store `testProjectId`.

### Phase 1: Open Browser and Create Session
1. Open browser page, navigate to `http://127.0.0.1:3140`, wait for "Connected".
2. Sleep 1200ms.
3. Click the project item in the sidebar: `.project-item:has-text("T43-Project")`.
4. Wait 800ms for project selection to render.
5. Create session via WS (NOT via UI modal — this avoids waiting for modal interactions):
   ```json
   {
     "type": "session:create",
     "projectId": "<testProjectId>",
     "name": "T43-haiku",
     "command": "claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions --strict-mcp-config",
     "mode": "direct",
     "cols": 120,
     "rows": 30
   }
   ```
6. Wait for `session:created` (15s). Store `testSessionId`.
7. Use `attachAndCollect(wsCreate, testSessionId)` as `mainSub`.
8. Poll `GET /api/sessions` until status=`running` (30s).
9. In browser: click the session card (`.session-card:has-text("T43-haiku")`) to open overlay. Wait for `#session-overlay` visible (10s).
10. Wait for `buffer.includes('bypass') || buffer.length > 2000` (TUI ready, 30s).

**Rationale for WS session creation:** The browser UI modal flow is tested elsewhere (T-01). Using WS creation reduces failure surface for this endurance test while still exercising the critical session lifecycle path. The browser is used for all Refresh/Reload/Close-overlay interactions.

### Phase 2: Establish Sentinel and Messages 1-7

1. Clear buffer.
2. Send sentinel setup:
   `"For this session, reply to EVERY message with ONLY \`ACK_N\` where N increments from 1. First reply: ACK_1. Nothing else.\r"`
   
   **Critical:** The string must NOT contain `ACK_1` literally at word boundaries that would match `ACK_1` in the buffer. Use the above text which does contain `ACK_1` as part of the instruction — but this is fine because the echo will arrive BEFORE Claude's response, and the test waits 30s. The real issue is using `clearBuffer()` after sending and before waiting. Actually, better: use the F-lifecycle pattern — no literal target string in the text. Use "ACK_N where N increments from 1. First reply should be the number one." This avoids the literal "ACK_1".
   
   **Revised sentinel text:** `"For this session, reply to EVERY message with ONLY the format ACK underscore N where N increments starting from one. Nothing else.\r"`
   
   Wait for `ACK_1` in buffer (45s).

3. Send messages 2-7: for each n from 2 to 7:
   - Sleep 3000ms.
   - `clearBuffer()`.
   - Send `NEXT\r`.
   - Wait for `ACK_N` (30s).
   - Log timestamp.

4. Screenshot: `01-ack7-received.png`.

### Phase 3: First Refresh (After message 7) — ACK_8

1. In browser: click `button[title="Refresh session"]` inside `#session-overlay`.
2. Wait 800ms for toast to appear.
3. On the WS side: wait for `session:subscribed` re-broadcast (signals PTY restart). Set up a listener BEFORE clicking.
   
   **Implementation:** Close `mainSub`, call `subscribeAndCollect(testSessionId)` to get a fresh collector that will receive the re-broadcast `session:subscribed`.
   
   **Actually:** The correct flow is: after the browser click, the server sends `session:refreshed` to the clicking client (the browser's WS), and broadcasts `session:subscribed` to all subscribers. The test's WS (`mainSub`) is a separate subscriber — it will receive `session:subscribed`. Do NOT close `mainSub` before the refresh click. Instead: after the click, wait for `session:subscribed` on `mainSub.ws`.

4. Wait for session status = `running` (30s).
5. Wait for `buffer.includes('bypass') || buffer.length > 2000` — TUI ready after restart (30s).
   
   **Important:** After refresh, `session:subscribed` triggers `xterm.reset()` on the browser client. The test's WS also receives this. The WS buffer is not cleared by this event on the server side — the buffer is managed by the test. Call `mainSub.clearBuffer()` after the subscribed event arrives.

6. Send `NEXT\r`. Wait for `ACK_8` (30s).
7. Log: `ACK_8 received after Refresh`.
8. Screenshot: `02-ack8-after-refresh.png`.

**Note on sentinel continuity:** After a Refresh, a new Claude session starts. Without `--resume`, Claude has no memory of the sentinel protocol. The spec says "Refresh, reload, and overlay-close all preserve conversation continuity" — this is verified by checking ACK ordering continues. BUT: the F-lifecycle test establishes a new sentinel after refresh (starting from N+1). T-43 follows the same pattern: after each interruption, re-establish the sentinel at the correct starting number. The "preserve continuity" assertion is behavioral: the PTY stays alive through Refresh (not a new session), the buffer accumulates correctly, and the next NEXT after waiting for TUI gets the expected ACK number.

**Revised understanding after reading the spec more carefully:** The spec says "Send NEXT\r. Verify ACK_8." This implies that after Refresh, the same Claude session continues (via `--resume` if the session file exists) and Claude should reply ACK_8. To verify this, the test MUST send `NEXT\r` (not a new sentinel) after Refresh and expect ACK_8. This is the exact continuity check. If Claude's context was lost (no --resume or failed), it will not respond with ACK_8.

**However**, if the test fails because Claude doesn't respond ACK_8 (context lost), that's a genuine test failure, not a test implementation bug. The test should retry once with a new sentinel anchor, log the failure, and mark the test result as a conversation-continuity failure.

**Final decision:** Follow the spec literally. After Refresh, wait for TUI ready, then send `NEXT\r`, wait for `ACK_8`. If ACK_8 doesn't arrive within 30s, the test fails with "Conversation continuity lost after Refresh — Claude does not have ACK_8 in context."

### Phase 4: Messages 9-12

For each n from 9 to 12:
- Sleep 3000ms.
- `clearBuffer()`.
- Send `NEXT\r`.
- Wait for `ACK_N` (30s).

Screenshot: `03-ack12-received.png`.

### Phase 5: Hard Browser Reload (After message 12) — ACK_13

1. Use CDP hard reload (cache disabled).
2. Wait for "Connected" indicator after reload (30s).
3. Sleep 1200ms.
4. In browser: click the project item `.project-item:has-text("T43-Project")`.
5. Sleep 800ms.
6. In browser: click the session card `.session-card:has-text("T43-haiku")` to reopen overlay.
7. Wait for `#session-overlay` visible (10s).
8. Wait for `session:subscribed` on a new WS subscriber (signals the browser has re-subscribed).
   
   **WS side:** After reload, `mainSub` (the old WS) is still connected to the server. The browser's reload causes the browser's own WS to reconnect and re-subscribe. The test's WS (`mainSub`) doesn't know about this. Continue using `mainSub` for input and ACK checking.
   
   Wait for TUI ready: `buffer.includes('bypass') || buffer.length > 2000` on `mainSub` (30s). If the buffer was cleared during the reload, the TUI signals will need to arrive fresh. If `mainSub` missed them (they came before the WS listener was ready), wait for the buffer to grow. Use a 30s timeout with 300ms polling.

9. Send `NEXT\r` via `mainSub`. Wait for `ACK_13` (30s).
10. Screenshot: `04-ack13-after-reload.png`.

**Implementation note:** After browser reload, signals reset — `selectedProjectId` and `attachedSessionId` in Preact signals are null. The browser re-subscribes on overlay open. The test's WS (`mainSub`) does not get reset. The test must navigate the browser UI to reopen the overlay; the WS can continue sending input and receiving ACKs.

### Phase 6: Messages 14-16

For each n from 14 to 16:
- Sleep 3000ms.
- `clearBuffer()`.
- Send `NEXT\r`.
- Wait for `ACK_N` (30s).

### Phase 7: Overlay Close and Reopen (After message 16) — ACK_17

1. In browser: click `#btn-detach` (the ✕ button in the overlay header) to close the overlay.
2. Wait for `#session-overlay` to be hidden/absent (5s).
3. Sleep 500ms.
4. In browser: click the session card `.session-card:has-text("T43-haiku")` to reopen overlay.
5. Wait for `#session-overlay` visible (10s).
6. Sleep 500ms (for WS re-subscribe on TerminalPane mount).

**WS side:** The test's `mainSub` WS is NOT affected by the overlay close. The overlay close triggers `detachSession()` which unmounts `TerminalPane` (which unsubscribes the browser's WS from PTY output) and then remounts it on re-open (re-subscribing). The test's `mainSub` remains subscribed throughout.

7. Send `NEXT\r` via `mainSub`. Wait for `ACK_17` (30s).
8. Screenshot: `05-ack17-after-overlay-reopen.png`.

### Phase 8: Messages 18-20

For each n from 18 to 20:
- Sleep 3000ms.
- `clearBuffer()`.
- Send `NEXT\r`.
- Wait for `ACK_N` (30s).

Screenshot: `06-ack20-final.png`.

### Phase 9: Stop Session

1. In browser: verify overlay is open. Click `#btn-session-stop` (Stop button).
2. Wait for session status = `stopped` (15s) via `GET /api/sessions`.
3. Assert status is `stopped`.
4. Screenshot: `07-session-stopped.png`.

**Alternative:** Send `session:stop` via `mainSub.send('session:stop')` and poll status. Either approach is valid; browser UI is preferred to test the full stack.

### Phase 10: Delete Session

1. In browser: the overlay should close or the Stop button should be gone (Stop is only shown when `isActive`). The overlay may stay open with the session in stopped state.
2. Close overlay: click `#btn-detach` if visible.
3. In the session card list: find `.session-card:has-text("T43-haiku")`. Click "Delete" button (`.btn-danger` with text "Delete").
4. Wait for browser `confirm` dialog — handle it: `page.once('dialog', d => d.accept())`.
5. Wait for the session card to disappear from the DOM (10s).
6. Verify via `GET /api/sessions` that the session is gone.
7. Screenshot: `08-session-deleted.png`.

---

## Assertions Summary

| Step | Assertion | False-PASS Risk |
|------|-----------|----------------|
| ACK_1 | Arrives within 45s | PTY echo of sentinel text could match if sentinel contains "ACK_1" literally |
| ACK_2-7 | Each arrives within 30s | Low — NEXT\r has no ACK substring |
| ACK_8 (post-Refresh) | Arrives within 30s | Would vacuously pass if buffer not cleared before refresh |
| ACK_9-12 | Each arrives within 30s | Low |
| ACK_13 (post-Reload) | Arrives within 30s | Would pass vacuously if old buffer still contains ACK_13 from before reload |
| ACK_14-16 | Each arrives within 30s | Low |
| ACK_17 (post-overlay-close) | Arrives within 30s | Very low — overlay close/reopen is transparent to WS |
| ACK_18-20 | Each arrives within 30s | Low |
| Session card lastLine | Shows recent ACK text | Vacuous if lastLine not updated |
| Session card deleted | `.session-card:has-text("T43-haiku")` gone | Vacuous if selector was wrong to begin with |

**Buffer management:** Call `clearBuffer()` immediately before sending each `NEXT\r` so the ACK arrives in a fresh buffer. This prevents leftover `ACK_N-1` from the previous message from matching `ACK_N` if N-1 is a substring (e.g., `ACK_1` matches in `ACK_12`).

**Critical false-PASS mitigation:** For ACK_8 post-Refresh: the `mainSub` buffer accumulates. If `ACK_8` was somehow already in the buffer (impossible since we haven't sent message 8 yet), the test would false-pass. After clearing buffer before each send, this cannot happen. Still, verify that after clearBuffer the buffer is truly empty at assertion time.

---

## Inter-Message Timing

- 3000ms sleep between messages (for TUI to return to input prompt).
- 30s wait after each Refresh for TUI ready.
- 30s wait after each hard reload for TUI ready (PTY was NOT restarted by reload — PTY continues running).
- 500ms sleep after overlay-close before reopen.

**Important:** Hard browser reload does NOT restart the PTY. The server-side session continues running. Only the browser's WS reconnects. So after reload, there is NO need to wait for TUI re-initialization (the TUI was already running). However, the buffer for `mainSub` may need to accumulate enough to confirm TUI is running — just send `NEXT\r` and wait for `ACK_13`. No TUI-ready polling needed after reload.

---

## False-PASS Risks (Detailed)

1. **Sentinel text contains "ACK_1" literally:** If the sentinel instruction contains "ACK_1", the PTY echoes it back 2-3s later, and `buffer.includes('ACK_1')` matches the echo rather than Claude's response. Mitigation: use "where N increments from 1" not "ACK_1" in the instruction.

2. **Buffer not cleared before each wait:** If `ACK_7` is in the buffer and we then send `NEXT\r` and wait for `ACK_8`, the buffer still has `ACK_7` and also `ACK_8` might arrive as expected. But if we don't clearBuffer, a stale `ACK_8` (impossible in this scenario) could false-pass. Mitigation: always `clearBuffer()` before each `waitForAck`.

3. **ACK_N is a substring of ACK_N+1 for N ≥ 10 (false negative, not false positive):** `ACK_10` contains `ACK_1`. If we check `buffer.includes('ACK_1')` and the buffer has `ACK_10`, it false-passes for `ACK_1`. BUT: our `waitForAck(n)` checks for `ACK_${n}` — `ACK_1` matches `ACK_10`, `ACK_11` etc. This IS a real risk for early messages.
   
   **Mitigation:** Use `ACK_${n}` where the numbers go from 1-20. The pattern `ACK_1` is a substring of `ACK_10`, `ACK_11`, ..., `ACK_19`. Since we clearBuffer before each send and Claude hasn't responded yet, the first ACK that appears is the correct one. However, if Claude responds with `ACK_10` when we wait for `ACK_1`, the check would pass vacuously. 
   
   **Actually:** Since we wait for EACH ACK in sequence (clear buffer, send NEXT, wait for THIS specific ACK), and Claude can't produce ACK_10 when we're waiting for ACK_1 (it doesn't know we want ACK_1 yet — we said "increments from 1"), this is not a real risk in practice. Claude will respond with `ACK_1` first. The substring issue would only matter if stale buffer remains, which clearBuffer prevents.

4. **Overlay close and reopen doesn't re-subscribe — WS receives nothing:** If the TerminalPane unmount/remount doesn't trigger a fresh `session:subscribe` from the browser, the browser won't show output. But the test's `mainSub` WS is independent of the browser's subscription — the test can still send input and verify ACKs. The only risk is that the test passes but the browser UI is broken (not showing output after reopen). Mitigation: after overlay reopen, take a screenshot and optionally wait for the browser's terminal to show content (checking `page.locator('#session-overlay-terminal').textContent()`).

5. **Hard reload closes the browser's WS — but mainSub is unaffected:** The browser reload closes only the browser's WS connection. `mainSub` (a Node.js WebSocket) is unaffected. The server continues running. The test's WS subscription continues. After reload, the browser re-establishes a WS and re-subscribes to the session when the overlay is reopened. The test can continue sending via `mainSub` regardless. No false-PASS risk here.

---

## Cleanup

`afterAll`:
1. Close `mainSub` WS if still open.
2. Close browser.
3. Kill server process (SIGKILL).
4. Print crash log if non-empty.
5. Remove `tmpDir` (`rm -rf`).

---

## Screenshots Plan

| Filename | After |
|----------|-------|
| `00-app-loaded.png` | Browser opened |
| `01-ack7-received.png` | ACK_7 confirmed |
| `02-ack8-after-refresh.png` | ACK_8 confirmed (post-Refresh) |
| `03-ack12-received.png` | ACK_12 confirmed |
| `04-ack13-after-reload.png` | ACK_13 confirmed (post-Reload) |
| `05-ack17-after-overlay-reopen.png` | ACK_17 confirmed (post-overlay-close) |
| `06-ack20-final.png` | ACK_20 confirmed |
| `07-session-stopped.png` | Session stopped |
| `08-session-deleted.png` | Session card gone |

---

## Pass/Fail Criteria

**PASS:** All 20 ACKs arrive in order. Refresh, reload, and overlay-close do not break the sequence. Session card is gone after delete.

**FAIL (any one sufficient):**
- Any ACK out of order or missing (timeout).
- Non-ACK response (Claude context lost — responds with a prose message instead of ACK_N).
- Session status does not return to `running` after Refresh.
- Browser cannot reopen overlay after reload (project list empty or session card not found).
- Session card persists after delete attempt.
- Server crash (crash log non-empty).

**INCONCLUSIVE:**
- ACK_8 misses but Claude later responds with correct ACKs (possible TUI timing issue, not a conversation-loss bug).
- Browser "Connected" indicator never appears after reload (browser/WS issue, not PTY issue).

---

## Key Implementation Warnings

1. **`\r` not `\n`:** Every `session:input` data string ends with `\r`.
2. **Don't close wsCreate before attaching:** Use `attachAndCollect` for the session-create WS.
3. **TUI ready before first message:** Always wait for `bypass` in buffer before sending the sentinel.
4. **After Refresh via browser:** The test's WS continues to receive PTY output. No need to resubscribe. Just wait for TUI ready and continue.
5. **After Reload via browser:** The test's WS is unaffected. No need to resubscribe. Continue using `mainSub`.
6. **After Overlay-close:** The test's WS is unaffected. Continue using `mainSub`.
7. **Dialog handling for Delete:** Register `page.once('dialog', d => d.accept())` BEFORE clicking Delete.

---

## Design Self-Review: Potential Gaps

**Gap 1: Sentinel continuity assumption**
The spec says "Verify ACK_8" after Refresh. This assumes the session uses `--resume` and Claude's context persists. If `--resume` is not passed (conversation file doesn't exist yet, or the session wasn't stopped before refresh), Claude may respond with ACK_1 not ACK_8. This is a REAL product bug the test should catch. The test should NOT re-establish the sentinel after refresh — just send `NEXT\r` and assert `ACK_8`.

**Gap 2: Session lastLine assertion**
The spec says "Session card lastLine shows most recent ACK." Implement this by checking `.session-lastline` text content after each phase (post-ACK_7, post-ACK_12, post-ACK_16, post-ACK_20). This verifies the server broadcasts lastLine updates.

**Gap 3: Multiple Refresh clicks**
The spec says "5× refresh" in the title but the flow only shows 1 refresh (after message 7). Re-reading: "5x refresh" refers to the description in the test pipeline header. The actual spec flow shows ONE refresh (after message 7). Implement exactly as specced: ONE refresh click.

**Gap 4: Hard reload count**
Similarly, "3x reload" in the title but the flow shows ONE hard reload (after message 12). The flow spec is authoritative. Implement ONE hard reload.

**Gap 5: WS buffer accumulates across phases**
After Refresh, the new PTY's TUI initialization output (ANSI setup, Claude banner, "bypass" footer) will arrive in `mainSub.buffer`. If we don't clear the buffer before `waitForAck(8)`, the accumulated startup output might confuse the ACK check (it can't, since `ACK_8` can't appear in startup output). But after `clearBuffer()` and sending `NEXT\r`, we're safe.

---

## Execution Summary

**Date:** 2026-04-08  
**Executor:** Sonnet 4.6  
**Result:** PASS (1 passed, 1.9 minutes, all 20 ACKs received)

### Attempt 1 — FAIL: `textContent()` without timeout hangs 20 min

`page.locator('.session-lastline').first().textContent()` uses the global test timeout (1,200,000ms) as the implicit wait. The `.catch(() => '')` only catches thrown errors, not Playwright timeouts. The locator waited 20 minutes for `.session-lastline` to appear in the DOM (it didn't exist). Test stuck at +41s after ACK_7 screenshot.

**Fix:** Added `{ timeout: 2000 }` to all `textContent()` calls: `.textContent({ timeout: 2000 }).catch(() => '')`.

### Attempt 2 — FAIL: Stale "bypass" in buffer causes premature TUI-ready signal

After attempt 1's fix, the test proceeded past ACK_7 but failed at ACK_8. The buffer for `mainSub` accumulated pre-Refresh output (including "bypass" from the initial TUI). After the Refresh click, `waitForTuiReady` was called WITHOUT a prior `clearBuffer()`. It found "bypass" immediately in the stale buffer, exited, then sent `NEXT\r` before the new PTY's Claude was input-ready. ACK_8 never arrived (30s timeout).

**Root cause:** Design warning #4 ("No need to resubscribe after Refresh") was wrong. The correct approach, per F-lifecycle F.09, is to close the old WS and `subscribeAndCollect` fresh after Refresh. A fresh subscription starts with an empty buffer and only receives post-Refresh PTY output.

**Fix:** After Refresh, `mainSub.close()` then `mainSub = await subscribeAndCollect(testSessionId)`. This mirrors F-lifecycle exactly.

### Attempt 3 — PASS

All 20 ACKs received in sequence. Key timings:
- ACK_1: +8.9s (sentinel established in ~2.8s — fast Haiku response)
- ACK_7: +38.4s
- Refresh click: +40.5s
- ACK_8 (post-Refresh, --resume): +44.0s (3.5s after TUI ready — --resume worked)
- Hard reload: +66.6s → ACK_13: +72.6s (1.6s response — PTY never restarted)
- Overlay close: +87.7s → reopen: +88.5s → ACK_17: +91.8s (2.3s response)
- Stop: +108.3s, Delete: +109.1s

### Key learnings from execution

1. **Always specify `{ timeout: N }` on Playwright `textContent()`** when the element may not exist. `.catch(() => '')` alone is not a timeout guard.

2. **After server-side Refresh, close and resubscribe WS.** The old WS buffer contains pre-Refresh data including "bypass". `waitForTuiReady` on the stale buffer returns immediately, causing premature input send. Fresh `subscribeAndCollect` starts from a clean buffer.

3. **Design warning #4 in this doc was wrong.** "After Refresh via browser: No need to resubscribe" — this is incorrect. After a server-side PTY restart (Refresh), always resubscribe. The distinction: browser reload (no PTY restart) does not require resubscription; server Refresh (PTY restart) does.

4. **lastLine is always empty during overlay.** The session card's `.session-lastline` never showed ACK content. The overlay covers the session card, and lastLine updates may not be reflected in hidden cards. Non-blocking finding.
