# T-42 Design: Multi-Project Badge Counts Are Fully Independent

**Score:** 11  
**Test type:** Playwright browser  
**Port:** 3139  
**Date:** 2026-04-08

---

## 1. What This Test Covers

This test verifies that session count badges in the project sidebar are strictly per-project. Specifically:
- Project A with 3 running sessions shows "3 sessions running."
- Project B with 0 sessions shows "idle" (or absent badge).
- Stopping one session in Project A decrements A's badge to "2 sessions running."
- Project B's badge remains "idle" throughout — it is not affected by changes to A.

The failure mode this guards against is **global running count contamination**: a shared counter or incorrect filter in the badge computation logic.

---

## 2. Source Analysis

### ProjectSidebar.js — Badge computation

```js
function getRunningCount(projectId) {
  return allSessions.filter(
    s => s.projectId === projectId && (s.status === 'running' || s.state === 'running')
  ).length;
}
```

**Key finding:** The filter uses `s.projectId === projectId`. This is correct — it filters by `projectId`. The badge should be per-project.

**Risk 1:** If `s.projectId` is missing from session objects returned by the server, all sessions would fail the `=== projectId` check and all counts would be 0. That's a bug but in the opposite direction (always 0).

**Risk 2:** If the server sends sessions without `projectId` populated, the filter returns 0 for every project. This would make T-42 vacuously pass (both badges show 0/idle). The test must verify Project A's badge is actually non-zero before stopping any session.

**Risk 3:** The `sessions` signal is populated by `sessions:list` WS broadcasts. If the server broadcasts sessions from ALL projects in one flat array and the client doesn't filter correctly, cross-project contamination is possible. But looking at the code: `sessions.list()` returns all sessions from all projects (intentionally — `SessionManager.list()` returns all). The sidebar correctly filters by `projectId`. This design is correct.

**Risk 4:** Race condition in WS delivery — if the `sessions:list` broadcast arrives before Preact re-renders, the badge might briefly show stale data. Since xterm.js is not involved here, this is unlikely to be flaky, but the test should wait for a stable state.

### Sessions badge text

```js
${running > 0
  ? `${running} session${running !== 1 ? 's' : ''} running`
  : 'idle'}
```

So the badge text is:
- "idle" when running === 0
- "1 session running" when running === 1
- "2 sessions running" when running === 2
- etc.

The CSS class changes from `.project-item-badge` to `.project-item-badge.has-sessions` when running > 0.

---

## 3. Exact Test Steps

### Infrastructure Setup

1. Start server on port 3139 with fresh tmp DATA_DIR.
2. Seed `projects.json` with TWO projects:
   - Project A: "Project Alpha" at `/tmp/qa-T42-XXX/project-a`
   - Project B: "Project Beta" at `/tmp/qa-T42-XXX/project-b`
3. Both project dirs must exist on disk (for sessions to spawn).

### Phase 1: Create 3 sessions in Project A (WS, not browser)

Connect via WebSocket. Create 3 sessions in Project A using `bash` as the command (stays alive). Record all 3 session IDs.

Wait for each `session:created` response before creating the next.

After all 3 are created, wait 1 second for the sessions to reach RUNNING state.

### Phase 2: Navigate browser to app

Open Chromium, navigate to `http://127.0.0.1:3139` with `waitUntil: 'domcontentloaded'`.

Wait for the app to connect to WebSocket (poll for `.project-item` elements to appear).

### Phase 3: Assert initial badge state

**Check Project A badge:**
- Locate the `.project-item` containing "Project Alpha".
- Find its `.project-item-badge` child.
- Assert text includes "3 sessions running" OR includes "3 session".

**Check Project B badge:**
- Locate the `.project-item` containing "Project Beta".
- Find its `.project-item-badge` child.
- Assert text is "idle" (no sessions).

**If Project A badge shows 0 or "idle": FAIL with diagnostic — sessions not loaded into UI.**

### Phase 4: Stop one session in Project A (WS)

Via WebSocket, send `session:stop` for `session_id_1` (the first of the 3).
Wait for `sessions:list` broadcast to confirm the stopped session shows `status: stopped`.

### Phase 5: Assert badge after stop

Wait for UI to update (poll every 200ms, timeout 5s):

**Check Project A badge:**
- Assert text is "2 sessions running".

**Check Project B badge:**
- Assert text is still "idle".

**Fail condition:**
- Project B shows any non-idle text.
- Project A shows anything other than "2 sessions running".

### Phase 6: Screenshot

Take a screenshot of the full sidebar for the validation record.

---

## 4. Pass/Fail Criteria

### PASS
- [P1] Project A badge shows "3 sessions running" after setup.
- [P2] Project B badge shows "idle" at all times.
- [P3] After stopping one session, Project A badge shows "2 sessions running".
- [P4] Project B badge remains "idle" after the stop.

### FAIL
- [F1] Project A badge shows "idle" or 0 (sessions not loaded or projectId missing).
- [F2] Project B badge shows non-zero count at any point.
- [F3] Project A badge does not decrement after stop.
- [F4] Project B badge changes after stopping a session in Project A.

---

## 5. False-PASS Risks

### Risk 1: All badges show 0 (vacuous pass on independence)
If `projectId` is not set on sessions, the filter returns 0 for all projects, making both badges show "idle." The test appears to confirm independence but actually confirms nothing.
**Mitigation:** Step P1 must ASSERT Project A shows "3 sessions running" — if it fails, the test fails with a diagnostic rather than vacuously passing.

### Risk 2: Sessions take too long to reach RUNNING, badges show 0 temporarily
`bash` spawns instantly and transitions to RUNNING via the microtask path in `_wirePty`. But the WS `sessions:list` broadcast needs to reach the browser and Preact needs to re-render.
**Mitigation:** Wait for the Project A badge to show "3 sessions running" with a polling loop (timeout 8s) before proceeding to the stop phase.

### Risk 3: `session:stop` WS message races with UI
The stop triggers a `sessions:list` broadcast. The browser must receive and render it before we check badges.
**Mitigation:** After sending `session:stop`, poll for Project A badge to change from "3" to "2" before asserting Project B is still "idle". This ensures we're checking after the update, not before.

### Risk 4: Wrong selector for badge
The badge is `.project-item-badge` inside `.project-item`. If the DOM structure changed, the selector might match wrong elements.
**Mitigation:** Verify the selector with a page.evaluate() that lists all `.project-item-badge` texts.

---

## 6. Implementation Notes

- Use WS (not browser) to create sessions — faster and more reliable than UI clicks.
- Use `bash` as the command (not `claude`) so sessions start instantly and stay alive.
- The browser only needs to observe the sidebar — no overlay or terminal interaction needed.
- Sessions created via WS automatically appear in the browser's `sessions:list` signal (the server broadcasts on every session state change).
- Always select Project A in the browser to make the sidebar active (though it's always visible).
