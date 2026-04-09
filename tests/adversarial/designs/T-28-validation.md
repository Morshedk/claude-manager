# T-28 Validation: Delete Button Absent on Running Session

**Date:** 2026-04-08
**Status:** PASS
**Score:** L=4 S=3 D=2 (Total: 9)

## Test Run Summary

| Assertion | State | Result |
|-----------|-------|--------|
| Stop button present | running | PASS |
| Delete button absent | running | PASS (count=0) |
| Refresh button absent | running | PASS (count=0) |
| DOM: no delete-related elements in card | running | PASS (0 found) |
| Delete button present | stopped | PASS |
| Stop button absent | stopped | PASS (count=0) |
| Refresh button present | stopped | PASS |

**Total: 1/1 passed in 9.8s**

## Assertions Verified

**Running state (session just started via WS):**
1. `.session-card-actions button` with text "Stop" is visible.
2. `.session-card-actions button` with text "Delete" does NOT exist (count=0).
3. `.session-card-actions button` with text "Refresh" does NOT exist (count=0).
4. Full DOM inspection of session card finds zero buttons with "delete" in text/id/class.

**Stopped state (after session:stop):**
5. "Delete" button is now visible in session card actions.
6. "Stop" button is absent (count=0).
7. "Refresh" button is now visible in session card actions.

**Server health:**
8. No unhandled rejections or uncaught exceptions in crash log.

## Fixes Made to Test

- `playwright.config.js`: Added T-28 to `testMatch` allowlist.
- **WS message type for state changes**: Server broadcasts `session:state` (with `id` field), not `session:stateChange` (with `sessionId` field). Updated `waitForSessionRunning` and `waitForSessionStopped` to handle `session:state`.
- **Stop message field**: Server expects `{ type: 'session:stop', id: ... }` but test sent `{ type: 'session:stop', sessionId: ... }`. Fixed to use `id`.
- **WS-based polling replaced with REST API polling**: The WS connection that creates the session is closed after `session:created` is received. The subsequent `session:state` broadcast for `running` arrives after the socket is closed and is never seen. Replaced both wait functions with `GET /api/sessions` polling loops (max 20s, 500ms interval).

## App Behavior Confirmed

The `SessionCard` component correctly gates the Delete button:

```js
function isActive(session) {
  const s = session.state || session.status || '';
  return s === 'running' || s === 'starting';
}

// Renders Stop (active) XOR Delete+Refresh (inactive) — never both
${active ? html`<button>Stop</button>` : html`<button>Refresh</button>`}
${!active ? html`<button>Delete</button>` : null}
```

The guard is symmetric and tested in both directions. No code path renders Delete on a running session.
No regressions detected.
