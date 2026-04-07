# Category E: Watchdog Stress — Adversarial Test Findings

**Date:** 2026-04-07
**File:** `tests/adversarial/E-watchdog.test.js`
**Results:** 75 PASS / 0 FAIL — all 25 test cases implemented, 75 total assertions

---

## BUGS FOUND

### BUG-E-001 (MEDIUM): Hardcoded 4-second sleep in dead-session restart path

**Tests:** E.01 (revealed by 5000ms Jest timeout on first pass)
**Severity:** Medium — operational correctness concern, not a crash

**Symptom:** In `_checkSession()`, when a session is dead and not paused, the code calls:
```js
this._startSession(sess);
const count = this._incrementRestart(sess.name);
await new Promise(r => setTimeout(r, 4000));  // ← hardcoded 4s
```

With 2 monitored sessions (`factory`, `factory2`), a single `tick()` on two dead sessions takes at minimum **8 seconds** of blocking sleep (4s × 2 sessions, run sequentially). Combined with the MCP dead path (2s + 1s sleeps), a worst-case tick with all conditions firing could take **14+ seconds of sleep alone** before any actual readiness check.

**Root cause:** `WatchdogManager.js` lines 1129, 1151, 1153 — hardcoded sleeps inserted to let the session start before polling for readiness. There is no way to reduce or override these in tests, which forced all E.01/E.06/E.07 tests to use `{ timeout: 30000 }`.

**Impact:** In production, the watchdog tick interval is 30 seconds. If tick execution itself takes 14s due to sleeps, the actual check frequency could degrade significantly under bad conditions. Additionally, if `_tickInterval` is ever reduced, the hardcoded sleeps could cause ticks to run longer than the interval itself.

**Fix:** Replace hardcoded sleep with a configurable delay (e.g., `this._startupWaitMs = 4000` set in constructor) so tests can set it to 0.

---

### BUG-E-002 (LOW): `sendTelegram` leaves open TLSWRAP handle

**Tests:** E.22 (revealed open handle warning on every test run)
**Severity:** Low — does not crash, but indicates a resource leak

**Symptom:** After `sendTelegram()` is called with a bad token (as in E.22), Jest reports:
```
Jest has detected the following 1 open handle potentially keeping Jest from exiting:
  ●  TLSWRAP
      at WatchdogManager.sendTelegram (lib/watchdog/WatchdogManager.js:274:25)
```

**Root cause:** `sendTelegram` calls `https.request()` to `api.telegram.org`. Even when the `req.on('error')` handler fires and resolves the Promise to `false`, the underlying TLS socket remains open until the OS-level connection attempt completes or times out. There is no `req.destroy()` call in the error handler.

**Location:** `lib/watchdog/WatchdogManager.js` line 283:
```js
req.on('error', () => resolve(false));
// ← should be: req.on('error', () => { req.destroy(); resolve(false); });
```

**Impact:** In production this is harmless (sockets are eventually GC'd), but under high notification load (e.g., repeated session crashes all triggering `_notify`), open TLS connections could pile up. In tests it prevents clean Jest exit (requires `--forceExit`).

**Fix:** Add `req.destroy()` in the error handler:
```js
req.on('error', () => { req.destroy(); resolve(false); });
```

---

### BUG-E-003 (LOW — MISSING FEATURE): `tick()` does not honor `settingsStore.enabled = false`

**Tests:** E.11 (adversarial probe — test always passes, but reveals missing feature)
**Severity:** Low / Feature gap — no crash, but watchdog cannot be disabled via settings

**Symptom:** The `WatchdogManager` constructor accepts a `settingsStore` option, and the `server.js` passes it in. However, `tick()` never consults `this.settingsStore` to check if watchdog is enabled/disabled. Setting `{ watchdog: { enabled: false } }` in settings has zero effect on watchdog behavior.

**Root cause:** `tick()` method (lines 954–1103) has no settings check. The `settingsStore` field is stored but never read.

**E.11 console warning output during test run:**
```
[E.11] FINDING: WatchdogManager does not honor settings.enabled=false — tick executes anyway
```

**Impact:** Users cannot disable the watchdog without restarting the server. Any settings UI that shows a "watchdog enabled" toggle is essentially a no-op.

**Fix:** Add at the top of `tick()`:
```js
async tick() {
  if (this.settingsStore) {
    const s = this.settingsStore.get?.();
    if (s?.watchdog?.enabled === false) return;
  }
  if (this._ticking) return;
  // ...
}
```

---

## OBSERVATIONS (no bug, verified correct behavior)

### OBS-E-001: Re-entrant guard `_ticking` is synchronous and correct

The `_ticking = true` flag is set before any `await` (line 956), making the guard race-free in Node.js's single-threaded event loop. Confirmed by E.09: 50 concurrent `tick()` calls via `Promise.all()` result in `_tickCount === 1`.

### OBS-E-002: State file uses atomic write (tmp + rename)

`_saveState()` writes to a `.tmp` file then renames — confirmed no partial-write corruption risk. `_loadState()` has a catch-all that preserves defaults on any parse error. E.12/E.13 verify both paths.

### OBS-E-003: Activity log and learnings trimming both work correctly

E.14: 250 appends → exactly 200 entries max. Newest entries preserved (oldest trimmed).
E.15: 200 learnings → exactly 150 max. Newest entries preserved.

### OBS-E-004: Error loop detection at threshold boundary is correct

Exactly 2 consecutive `error_loop` with same fingerprint → detects. 1 entry → null. Mixed fingerprints → null. Verified E.16.

### OBS-E-005: `checkRateLimit` regex has a latent edge case with `rate-limit-options`

The regex `!/Stop and wait for limit|rate-limit-options/.test(pane)` matches if either phrase is present. A pane containing only `rate-limit-options` (without the full "Stop and wait for limit" phrase) triggers rate-limit detection. This is likely intentional but undocumented.

---

## SUMMARY TABLE

| Test | Result | Notes |
|------|--------|-------|
| E.01 (3 tests) | PASS | Reveals BUG-E-001: 4s sleep per dead session |
| E.02 (3 tests) | PASS | Alive sessions: no restart, counters reset, empty capture safe |
| E.03 (4 tests) | PASS | Rate limit detection: text, regex edge cases, normal |
| E.04 (3 tests) | PASS | Credit exhaustion short-circuit, recheck, remains exhausted |
| E.05 (3 tests) | PASS | Crash regression: error emitted, not fatal; server recovers |
| E.06 (2 tests) | PASS | Restart paused: event emitted, no restart; pause expiry allows restart |
| E.07 (2 tests) | PASS | MCP dead: kill + restart; kill failure swallowed |
| E.08 (2 tests) | PASS | 50 sequential ticks: _tickCount=50, inflightHistory capped |
| E.09 (3 tests) | PASS | 50 concurrent ticks: only 1 executes; _ticking resets on throw |
| E.10 (4 tests) | PASS | start/stop lifecycle: no leaked timers |
| E.11 (1 test) | PASS* | Reveals BUG-E-003: settings.enabled not honored |
| E.12 (3 tests) | PASS | State persistence round-trip |
| E.13 (4 tests) | PASS | Corrupt state file: all variants safe |
| E.14 (2 tests) | PASS | Activity log capped at 200, oldest trimmed |
| E.15 (3 tests) | PASS | Learnings capped at 150, oldest trimmed, NONE/null ignored |
| E.16 (5 tests) | PASS | Error loop detection at threshold boundary |
| E.17 (5 tests) | PASS | Low-power mode: trigger, callClaude rejection, recovery |
| E.18 (2 tests) | PASS | clientRegistry.broadcast called; null clientRegistry safe |
| E.19 (3 tests) | PASS | getSummary structure before/after ticks |
| E.20 (2 tests) | PASS | checkResources: no crash; resourceAlert event emitted |
| E.21 (1 test) | PASS | killOrphanBuns: pgrep failure returns 0 |
| E.22 (2 tests) | PASS | sendTelegram: resolves false; no throw — but reveals BUG-E-002 |
| E.23 (2 tests) | PASS | 100KB scrollback truncated; tiny delta returns null |
| E.24 (4 tests) | PASS | No dependencies: constructor, tick, getSummary, getLog all safe |
| E.25 (7 tests) | PASS | safeToInject: empty, whitespace, no session, Listening, bypass, timer |

**Total: 75 PASS, 0 FAIL**
**Bugs found: 3 (1 medium, 2 low / feature gap)**
