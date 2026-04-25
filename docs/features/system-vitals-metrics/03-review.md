# 03 Review: System Vitals Metrics

## Design Fidelity Check

| Design Decision | Implementation | Verdict |
|---|---|---|
| 1. Enrich watchdog:tick broadcast with vitals | `tick()` collects vitals every tick, broadcasts in `watchdog:tick` payload | FAITHFUL |
| 2. Include vitals in init message | `server.js` sends `vitals: watchdog.getVitals()` in init | FAITHFUL |
| 3. Add `vitals` signal to store | `store.js` exports `vitals = signal(null)` | FAITHFUL |
| 4. Handle vitals in WS handlers | `sessionState.js` handles init + watchdog:tick, updates vitals signal | FAITHFUL |
| 5. Create VitalsIndicator component | New component with CPU/RAM/disk bars, color coding, stale detection | FAITHFUL |
| 6. Mount in TopBar | TopBar imports VitalsIndicator, renders in `.global-stats` div | FAITHFUL |
| 7. Include vitals in getSummary() | `getSummary()` calls `getVitals()` and includes it | FAITHFUL |

**Overall Verdict: FAITHFUL**

All 7 design decisions were implemented as specified. The two documented deviations (no `handleWatchdogTick` export in actions.js, no pulse dot animation) are both justified and non-functional -- they don't affect the feature's behavior.

## Structural Debt Checks

### 1. Dead code
No dead code introduced. The existing `checkResources()` call was refactored (moved from inside the throttle block to before it), and the old `const res = this.checkResources()` line inside the throttle was removed. The `res` variable is now shared between vitals collection and alert checking.

### 2. Scattered ownership
No scattered ownership. Vitals data has a single source (`checkResources()` + `os.totalmem()`), a single store location (`vitals` signal), and a single display component (`VitalsIndicator`). The `getVitals()` method has slight duplication with the inline vitals construction in `tick()` -- both compute `memTotalMb` and build the same object shape. Minor structural smell but acceptable since `getVitals()` is a fallback for when no tick has run yet.

### 3. Effect scope correctness
The VitalsIndicator component uses no hooks -- it reads `vitals.value` directly from the signal. This is correct for Preact signals; the component re-renders whenever the signal changes. No stale closure risk.

### 4. Cleanup completeness
No listeners, timers, or subscriptions are set up by VitalsIndicator. The WS handlers in sessionState.js are registered once at startup via `initMessageHandlers()` and never cleaned up (which is the pattern for all handlers in this file -- they live for the lifetime of the app).

### 5. Orphaned references
No orphaned references. The `vitals` signal is imported in exactly two places: `sessionState.js` (writes to it) and `VitalsIndicator.js` (reads from it). The `SERVER.WATCHDOG_TICK` constant was already defined in `protocol.js` and is now used.

## Security Issues
None. The vitals data is server-generated system metrics (CPU, RAM, disk). No user input flows into these values. The `checkResources()` method uses hardcoded shell commands (`df /`) with no user-controlled parameters. The vitals are broadcast to all connected clients, which is the intended behavior (all users of the web UI should see server health).

## Error Handling Gaps
Minor: if `checkResources()` throws (unlikely -- it has try/catch internally), the entire tick would fail and be caught by the outer try/catch at line 1236. The `_lastVitals` would not be updated, and the broadcast would send `null`. The VitalsIndicator handles `null` gracefully (shows "waiting..."). This is acceptable.

## Race Conditions
None. The `_ticking` guard prevents concurrent ticks. The vitals signal is a simple Preact signal with atomic assignment. The `getVitals()` method reads `this._lastVitals` which is set synchronously in `tick()`.

---

## Implementation Gaps Found

1. **Minor: Duplicate vitals construction logic** -- The same object shape is built in two places: `tick()` (line 1104-1112) and `getVitals()` fallback (line 1459-1469). If the vitals schema changes, both must be updated. This could be refactored to have `tick()` call `getVitals()` or a shared builder, but it's minor for a 7-field object.

No other gaps found.
