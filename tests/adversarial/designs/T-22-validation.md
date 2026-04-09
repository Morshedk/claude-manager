# T-22 Validation: Delete session while overlay is open

**Date:** 2026-04-08
**Overall result:** PASS (1/1)
**Time:** 21.5s

---

## Fixes Applied

### Fix 1: Project selector too broad
**Problem:** `page.locator('*').filter({ hasText: 'T22-Project' }).first()` matched the outermost DOM element containing that text (probably `<body>`), so the click didn't fire the Preact `onClick` on `.project-item`.

**Fix:** Changed to `page.locator('.project-item').filter({ hasText: 'T22-Project' }).first()` — targets the exact sidebar item element.

### Fix 2: Connected-state wait used wrong selector
**Problem:** `document.body.textContent.includes('Connected')` — the app has no "Connected" text, only a `.status-dot.connected` CSS class.

**Fix:** Changed to `page.waitForSelector('.status-dot.connected', { timeout: 10000 })`.

### Fix 3: Deletion approach — Delete button unavailable due to auto-resume
**Problem:** Opening the overlay sends `session:subscribe` to the server. The `SessionManager.subscribe()` method has an auto-resume feature: if a direct session is stopped with no PTY, it calls `session.start()` to restart it. This means after clicking "Open", the session transitions from `stopped` → `running`, and the Delete button (which only shows when `!active`) disappears.

**Fix:** Instead of clicking the UI Delete button, the test sends `{ type: 'session:delete', id: sessionId }` via a fresh WebSocket connection while the overlay is open. This matches the key lesson: "Deletion is WS-only."

---

## Auto-Resume Behavior Documented

The `subscribe()` method in `SessionManager.js` (lines 250-267) intentionally auto-resumes stopped direct sessions when a client subscribes. This is by design for page-refresh reconnect, but it makes the Delete button unavailable after opening the overlay. Tests that need to delete a session while the overlay is open must use WS-level deletion.

---

## Test Results

| Step | Result | Detail |
|------|--------|--------|
| Create bash session via WS | PASS | session:created received |
| Wait for session running | PASS | status=running confirmed via API |
| Stop session | PASS | status=stopped confirmed via API |
| Browser loads, project selected | PASS | .project-item click works |
| Session card "T22-bash" visible | PASS | innerText found within 15s |
| Overlay opened ("Open" button) | PASS | #session-overlay appeared |
| Split view enabled | PASS | "Split" button clicked |
| Overlay present before delete | PASS | #session-overlay in DOM |
| session:delete sent via WS | PASS | Fresh WS connection, message sent |
| Overlay disappears after delete | PASS | #session-overlay gone within 8s |
| Session card removed | PASS | No .session-card contains "T22-bash" |
| No critical console errors | PASS | Zero errors after filtering known-harmless |
| No post-delete session:subscribe | PASS | Zero post-delete subscribe frames |
| Overlay fully gone from DOM | PASS | Final check confirmed |

---

## Signal Chain Verified

After `session:delete`:
1. Server deletes session → broadcasts `sessions:list` (without deleted session)
2. Browser `handleSessionsList` updates `sessions.value` (session removed)
3. `attachedSession` computed returns `null` (session not in list)
4. `SessionOverlay` renders `null` → overlay unmounts
5. `TerminalPane` unmounts → cleanup sends `session:unsubscribe` (harmless)

No repeated subscribe, no JS errors, clean teardown confirmed.

---

## Verdict

PASS. All 13 checks passed. The overlay closes gracefully when its session is deleted via WS. The signal chain (computed `attachedSession` → overlay unmount) works correctly. The key fix was using WS-level deletion rather than the UI Delete button, which was unavailable due to auto-resume-on-subscribe behavior.
