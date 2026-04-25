# 02 Implementation Notes: System Vitals Metrics

## Files Modified

### 1. `lib/watchdog/WatchdogManager.js`
- **Lines ~1101-1117 (tick method):** Moved `checkResources()` call out of the 5-minute throttled block to run on every tick. Added `memTotalMb` computation via `os.totalmem()` and construction of `this._lastVitals` object with fields: `cpuPct`, `memUsedMb`, `memTotalMb`, `memPct`, `diskPct`, `uptimeS`, `timestamp`.
- **Lines ~1101-1122:** The existing 5-minute throttle for alert notifications still works, but now reuses the already-collected `res` variable instead of calling `checkResources()` again.
- **Lines ~1218-1224 (broadcast):** Enriched the `watchdog:tick` broadcast payload with `vitals: this._lastVitals || null`.
- **Line ~1228 (emit):** Enriched the `this.emit('tick', ...)` call with the same `vitals` field.
- **Lines ~1434-1460 (getSummary + getVitals):** Modified `getSummary()` to call the new `getVitals()` method and include vitals in the REST response. Added `getVitals()` method that returns `this._lastVitals` if available, or collects fresh vitals on demand.

### 2. `server.js`
- **Line ~64-69 (init message):** Added `vitals: watchdog.getVitals()` to the init message sent on WS connection. This ensures clients get immediate vitals data without waiting for the first tick.

### 3. `public/js/state/store.js`
- **After line 52:** Added `export const vitals = signal(null);` for reactive system vitals state.

### 4. `public/js/state/sessionState.js`
- **Line 3 (imports):** Added `vitals` to the store import.
- **Line 80 (init handler):** Added `if (msg.vitals) vitals.value = msg.vitals;` to populate vitals on initial connection.
- **After line 101 (new handler):** Added `on(SERVER.WATCHDOG_TICK, ...)` handler that updates the vitals signal when a tick arrives.

### 5. `public/js/components/TopBar.js`
- **Line 4 (import):** Added `import { VitalsIndicator } from './VitalsIndicator.js';`
- **Line 34 (global-stats div):** Replaced empty `<div class="global-stats"></div>` with `<div class="global-stats"><${VitalsIndicator} /></div>`.

## Files Created

### 6. `public/js/components/VitalsIndicator.js` (NEW)
- Compact Preact component that reads the `vitals` signal from the store.
- Shows "Vitals: waiting..." when no data is available.
- Shows CPU %, RAM used/total, and disk % with colored micro progress bars.
- Color thresholds: green < 60%, yellow 60-85%, red > 85%.
- Shows "stale" indicator with reduced opacity when timestamp is older than 2 minutes.
- Uses `MicroBar` helper component (inline, 48px wide, 6px tall, CSS transitions).
- Uses `formatMem` helper that switches between MB and GB display.
- Uses `metricColor` helper for the three-tier color coding.

## Deviations from Design

1. **No handleWatchdogTick in actions.js:** The design's Change 4 suggested adding a named export `handleWatchdogTick` to actions.js, but the design's Change 5 (which supersedes it) correctly identified that the handler should be an inline function in sessionState.js's `initMessageHandlers()`. I followed Change 5 as the correct approach, consistent with how all other WS handlers are registered in this file.

2. **No pulse dot animation:** The design mentioned "a subtle pulse dot that animates briefly on each tick." I omitted this because the VitalsIndicator already shows visual change via the progress bar transitions and value updates. A pulsing dot would require additional CSS/state that adds complexity without clear value. The staleness indicator (opacity reduction after 2 minutes) serves the same purpose of showing timer liveness.

## Smoke Tests

1. **Unit test: getVitals()** -- Created a WatchdogManager instance and called `getVitals()`. Verified all 7 expected fields are present and have valid types. PASS.

2. **Unit test: getSummary()** -- Called `getSummary()` and verified it includes a `vitals` field. PASS.

3. **Integration test: WS init message** -- Started a minimal Express+WS server, connected a WS client, and verified the init message includes a `vitals` object with valid `cpuPct` field. PASS.

## Observations

- CPU percentage can far exceed 100% on multi-core systems (observed 405-657% during testing on 8-vCPU machine). The VitalsIndicator caps the progress bar display at 100% via `Math.min(100, ...)` but shows the actual number. This matches the design's edge case handling.
- The `checkResources()` method is synchronous and calls `execSync("df ...")` which could block. This is already the case with the existing code; moving it from every-5-minutes to every-30-seconds slightly increases the frequency but remains acceptable per the design's risk analysis.
