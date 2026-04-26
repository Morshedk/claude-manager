# 01 Design: System Vitals Metrics

## Section 1: Problem & Context

### What user problem this solves
The user monitors multiple Claude sessions through the web app and needs at-a-glance visibility into server health (CPU load, RAM usage) without leaving the UI or SSHing into the box. Today, the only way to check system resources is via the watchdog's periodic Telegram alerts (which only fire when thresholds are exceeded) or by manually running `htop`/`free` on the server. The user wants continuous, ambient system metrics visible alongside their sessions.

### What currently exists that is related

**WatchdogManager.js** (`lib/watchdog/WatchdogManager.js`):
- Line 522-548: `checkResources()` method already collects CPU load percentage, free RAM in MB, disk usage %, and disk free GB using `os.cpus()`, `os.loadavg()`, `os.totalmem()`, `os.freemem()`, and `df`. It returns `{ diskPct, diskAvailGb, memAvailMb, loadPct, cpus, alerts }`.
- Line 1100-1112: In the `tick()` method, `checkResources()` is only called every 5 minutes (`RESOURCE_CHECK_INTERVAL_S = 300` at line 52) and only emits a `resourceAlert` event when alerts exist. The data is not persisted or broadcast.
- Line 1210-1220: At the end of `tick()`, a `watchdog:tick` message is already broadcast to all clients via `clientRegistry.broadcast()`, but it only includes `{ type, count, creditState, lowPower }` -- no system metrics.

**WatchdogPanel.js** (`public/js/components/WatchdogPanel.js`):
- Full-panel watchdog display that shows credit info, burn rate charts, and activity logs.
- Line 72: Shows "Watchdog" as the user-facing name with enabled/disabled badge.
- Lines 83-103: Status summary area with Model, Interval, Last Tick, and optional Thinking cards.
- Does NOT display any system resource metrics.

**TopBar.js** (`public/js/components/TopBar.js`):
- Line 34: Contains an empty `<div class="global-stats"></div>` that is clearly a placeholder for global metrics. This is the ideal insertion point.

**Store.js** (`public/js/state/store.js`):
- No signals for system metrics or vitals exist yet.

**Protocol.js** (`public/js/ws/protocol.js`):
- Line 33: `WATCHDOG_TICK: 'watchdog:tick'` already exists as a server->client message type. The tick payload just needs to be enriched with metrics.

**server.js** (`server.js`):
- Line 33: WatchdogManager is constructed with `clientRegistry` already injected, so it has direct broadcast access.
- Line 64-68: On WS connection, an `init` message is sent. This should also include a snapshot of current vitals so the UI is populated immediately.

**connection.js** (`public/js/ws/connection.js`):
- Line 14-28: Client-side message dispatch system using `handlers` map keyed by message type. Any component can register a handler via `on(type, fn)`.

### What's missing and why
1. **No metrics in watchdog:tick broadcast** -- `checkResources()` returns the data, but `tick()` does not include it in the broadcast payload.
2. **No store signals for metrics** -- The frontend has no reactive state for CPU/RAM.
3. **No UI component for metrics** -- Nothing renders system stats.
4. **No metrics on initial connection** -- When a client connects, it receives no vitals snapshot.
5. **No user-facing name for the timer** -- The watchdog is called "Watchdog" everywhere, which is a technical/internal name. The user wants a friendlier name.

---

## Section 2: Design Decision

### User-facing name: "Vitals"

**Recommendation: "Vitals"** over alternatives:
- "Pulse" -- too abstract, sounds like a heartbeat check (binary alive/dead)
- "Heartbeat" -- overloaded term in distributed systems, implies keep-alive protocol
- "Vitals" -- medical metaphor that directly communicates "health metrics"; maps naturally to CPU/RAM as vital signs; concise enough for a small UI badge

The user-facing label "Vitals" will appear in the TopBar. The internal code will use `vitals` as the naming convention for new signals and data fields. The existing "Watchdog" name stays for the full watchdog panel and its session health/credits functionality -- Vitals is the metrics subset.

### What to build

#### 1. Backend: Enrich watchdog:tick with system metrics

**File: `lib/watchdog/WatchdogManager.js`**

**Modify `tick()` method (line 1056-1228):**
- Move `checkResources()` call from the throttled 5-minute block (lines 1100-1112) to EVERY tick. The `checkResources()` method is cheap (one `os.loadavg()` call, one `os.freemem()` call, one `df` exec). The existing 5-minute throttle was only for the Telegram alert notification -- the data collection itself is inexpensive.
- Keep the existing alert notification logic at its 5-minute throttle (lines 1100-1112). Only move the data collection to run unconditionally.
- At line 1213, enrich the `watchdog:tick` broadcast payload:

```
{
  type: 'watchdog:tick',
  count: this._tickCount,
  creditState: this._creditState,
  lowPower: this._lowPower,
  vitals: {
    cpuPct: loadPct,        // CPU load as percentage (loadavg / cpus * 100)
    memUsedMb: memTotalMb - memAvailMb,  // Used memory in MB
    memTotalMb: memTotalMb, // Total memory in MB
    memPct: Math.round(((memTotalMb - memAvailMb) / memTotalMb) * 100), // Memory used %
    diskPct: diskPct,       // Disk usage %
    uptimeS: Math.floor(process.uptime()), // Node process uptime in seconds
    timestamp: new Date().toISOString(),
  }
}
```

- Also enrich the `this.emit('tick', ...)` call on line 1222 with the same vitals object.

**Modify `getSummary()` method (line 1421-1433):**
- Call `checkResources()` and include the vitals snapshot in the returned object, so the REST endpoint `/api/watchdog/state` also returns current vitals. This ensures the WatchdogPanel's existing `loadSummary()` fetch gets vitals data too.

#### 2. Backend: Include vitals in init message

**File: `server.js`**

**Modify WS connection handler (line 59-68):**
- After constructing the `init` message, call `watchdog.checkResources()` and attach a `vitals` field to the init payload. This gives newly connected clients an immediate metrics snapshot without waiting for the next tick.

#### 3. Frontend: Add vitals signals to store

**File: `public/js/state/store.js`**

Add after the Settings section (~line 52):
```js
// -- Vitals (system metrics from watchdog) --
/** System vitals: { cpuPct, memUsedMb, memTotalMb, memPct, diskPct, uptimeS, timestamp } */
export const vitals = signal(null);
```

#### 4. Frontend: Handle vitals in WS message handlers

**File: `public/js/state/actions.js`**

Add a new handler function:
```js
export function handleWatchdogTick(msg) {
  if (msg.vitals) {
    vitals.value = msg.vitals;
  }
}
```

Also modify the existing init handler (or add one) to populate vitals on connection:
```js
export function handleInit(msg) {
  clientId.value = msg.clientId;
  serverVersion.value = msg.serverVersion;
  serverEnv.value = msg.serverEnv;
  if (msg.vitals) {
    vitals.value = msg.vitals;
  }
}
```

**File: `public/js/ws/protocol.js`**

No changes needed -- `WATCHDOG_TICK` is already defined at line 33.

#### 5. Frontend: Wire up WS listeners in sessionState.js

**File: `public/js/state/sessionState.js`**

This is where all global WS message handlers are registered (line 73-125, `initMessageHandlers()` function).

**Modify the `on(SERVER.INIT, ...)` handler at line 75-83:**
Add `if (msg.vitals) vitals.value = msg.vitals;` inside the existing init handler body, after line 79.

**Add new handler registration after line 101** (after the `TODOS_UPDATED` handler):
```js
on(SERVER.WATCHDOG_TICK, (msg) => {
  if (msg.vitals) vitals.value = msg.vitals;
});
```

**Update imports at line 3:** Add `vitals` to the store imports.

#### 6. Frontend: Create VitalsIndicator component

**File: `public/js/components/VitalsIndicator.js`** (NEW file)

A compact, always-visible component for the TopBar that shows:
- A small "Vitals" label
- CPU % with a micro progress bar (colored: green <60%, yellow 60-85%, red >85%)
- RAM used/total (e.g. "1.2 / 3.8 GB") with a micro progress bar (same color coding)
- A subtle pulse dot that animates briefly on each tick to show the timer is alive

Layout: horizontal, compact, fitting inside the TopBar's empty `<div class="global-stats">` (TopBar.js line 34).

Approximate visual:
```
[Vitals]  CPU ████░░ 42%  |  RAM ██████░ 1.2/3.8 GB  |  Disk 67%
```

If no vitals data is available yet (before first tick), show a muted "Vitals: waiting..." placeholder.

The component imports `vitals` from the store and renders reactively whenever the signal updates.

#### 7. Frontend: Mount VitalsIndicator in TopBar

**File: `public/js/components/TopBar.js`**

**Modify line 34:** Replace the empty `<div class="global-stats"></div>` with:
```html
<div class="global-stats">
  <${VitalsIndicator} />
</div>
```

Add import at top:
```js
import { VitalsIndicator } from './VitalsIndicator.js';
```

### Data flow (end-to-end)

```
Every 30s watchdog tick:
  WatchdogManager.tick()
    → calls checkResources() (returns { diskPct, diskAvailGb, memAvailMb, loadPct, cpus })
    → transforms into vitals object { cpuPct, memUsedMb, memTotalMb, memPct, diskPct, uptimeS, timestamp }
    → clientRegistry.broadcast({ type: 'watchdog:tick', ..., vitals })
    → WebSocket delivers JSON to all connected browsers
    → connection.js dispatch('watchdog:tick')
    → handleWatchdogTick(msg) in actions.js
    → vitals.value = msg.vitals (Preact signal update)
    → VitalsIndicator re-renders with new values (signal subscription)

On initial connection:
  server.js wss.on('connection')
    → watchdog.checkResources()
    → clientRegistry.send(clientId, { type: 'init', ..., vitals })
    → connection.js dispatch('init')
    → handleInit(msg) populates vitals.value
    → VitalsIndicator renders immediately
```

### Edge cases and failure modes

1. **checkResources() `df` command fails**: Already handled -- the existing code uses try/catch and defaults to `diskPct=0, diskAvailGb=0`. The vitals object will have `diskPct: 0` which is fine to display.

2. **watchdog disabled**: When `watchdog.enabled === false`, the `tick()` method returns early at line 1059. No vitals will be broadcast. The VitalsIndicator should show stale data with a "stale" indicator if the timestamp is older than 2 minutes, or "Vitals: paused" if null.

3. **WebSocket disconnected**: The `connected` signal already tracks this. VitalsIndicator can optionally dim when disconnected, but the existing TopBar already shows connection status, so no special handling needed.

4. **Multiple rapid ticks**: The `_ticking` guard at line 1071 prevents concurrent ticks. Each broadcast replaces the previous vitals in the signal (not accumulated).

5. **CPU > 100%**: `loadPct` is `(loadAvg / cpus) * 100` which can exceed 100% on multi-core systems under heavy load. The progress bar should cap display at 100% but show the actual number.

### Scope boundary: what NOT to build

- **Per-session CPU/RAM**: Not feasible without cgroups or expensive per-PID tracking. Out of scope.
- **Historical metrics graph**: The WatchdogPanel already has a burn-rate chart. A vitals history chart could be a follow-up feature but is NOT in scope for this design.
- **Alerts/thresholds in UI**: The existing Telegram alert system handles threshold notifications. We display metrics, not configure alerts.
- **Disk I/O, network stats**: Out of scope. Stick to CPU, RAM, disk usage %.
- **Renaming "Watchdog" to "Vitals"**: The Watchdog panel keeps its name. "Vitals" is only for the new TopBar metrics indicator.

---

## Section 3: Acceptance Criteria

1. **Given** the app is loaded and connected, **when** the first watchdog tick fires (within 30 seconds), **then** the TopBar shows CPU %, RAM used/total, and disk % with colored progress bars.

2. **Given** a fresh page load, **when** the WebSocket connects and the `init` message arrives, **then** the Vitals indicator populates immediately (before the next watchdog tick).

3. **Given** CPU load is above 85%, **when** the vitals update, **then** the CPU progress bar turns red (danger color).

4. **Given** CPU load is between 60-85%, **when** the vitals update, **then** the CPU progress bar turns yellow (warning color).

5. **Given** CPU load is below 60%, **when** the vitals update, **then** the CPU progress bar is green (accent/success color).

6. **Given** the same color coding applies to RAM usage, **when** RAM is >85% used, **then** the RAM bar turns red.

7. **Given** the watchdog is disabled in settings, **when** no ticks fire, **then** the Vitals indicator shows "Vitals: paused" or a stale indicator rather than blank or broken UI.

8. **Given** the WebSocket reconnects after a disconnect, **when** the init message arrives, **then** the Vitals indicator updates with fresh data.

9. **Given** the vitals data is visible, **when** the user inspects the TopBar, **then** they see the label "Vitals" followed by CPU %, RAM in human-readable format (MB or GB), and disk %.

10. **Given** the existing WatchdogPanel, **when** it fetches `/api/watchdog/state`, **then** the response also includes the vitals object (so the panel could optionally display it too in the future).

---

## Section 4: User Lifecycle Stories

### Story 1: First impressions
A user opens the Claude Manager web app in their browser. The page loads, the WebSocket connects, and within a second they see "Vitals" in the top bar with current CPU, RAM, and disk metrics displayed as compact colored bars. Without clicking anything or navigating anywhere, they have immediate confidence the server is healthy. Every 30 seconds, the numbers update subtly -- the CPU bar might grow or shrink, the RAM figure might tick up by a few MB. The updates are ambient and non-disruptive.

### Story 2: Noticing resource pressure
A user has 4 Claude sessions running. They glance at the top bar and notice the CPU bar has turned yellow (72%) and RAM is approaching the red zone (83%). They decide to stop one session to free resources, and over the next couple of ticks, they see CPU drop to green and RAM settle. The vitals gave them the signal to act before the system became unresponsive.

### Story 3: Reconnection after network blip
The user's laptop goes to sleep and wakes up 20 minutes later. The WebSocket reconnects automatically. The Vitals indicator, which was showing stale data, immediately refreshes to show current metrics from the init message. The user doesn't need to manually refresh anything -- the numbers are live again.

### Story 4: Watchdog disabled
The user disables the watchdog in Settings (perhaps to save API credits during a quiet period). The Vitals indicator in the TopBar shows "paused" instead of metrics, clearly communicating that monitoring is off. When they re-enable the watchdog, the next tick populates fresh vitals.

### Story 5: Disk pressure awareness
A user notices the disk indicator in the TopBar shows 87% (red). They realize accumulated session logs and temp files are filling the disk. They open a terminal in the third-space to clean up old data. After the next tick, disk drops to 74% (yellow). The ambient display kept them aware of a problem they wouldn't have noticed otherwise.

---

## Section 5: Risks & False-PASS Risks

### Risk 1: `df` command latency on slow/NFS disks
The `checkResources()` method shells out to `df /`. On local SSDs this is instant, but on NFS or degraded disks it could block for seconds, which would delay the entire watchdog tick (tick runs sequentially). **Mitigation:** The existing code already has a 3000ms timeout on the exec. Worst case, the tick takes 3 extra seconds, which is acceptable on a 30-second cycle.

### Risk 2: Stale vitals after watchdog disable
If the user disables the watchdog, the last vitals snapshot stays in the signal forever. The UI must distinguish "fresh data" from "stale data" using the timestamp field. A simple check: if `vitals.timestamp` is older than `2 * tickInterval`, show a staleness indicator.

### Risk 3: Signal not updating on init
The existing init message handler may not be in `actions.js` -- it could be inline in a component or in a different file. If the handler isn't found and extended correctly, the init-time vitals won't populate the signal, and the UI will be blank until the first tick (up to 30 seconds). **Mitigation:** The implementer must trace the init handler wiring before modifying it.

### False-PASS Risk 1: Vitals component renders but with null data
A test could check "VitalsIndicator is rendered in the TopBar" and pass, but the component might be showing placeholder text because the WS handler isn't wired correctly. Tests must assert actual numeric values are displayed, not just component presence.

### False-PASS Risk 2: CPU % is always 0
On a very idle test server, `os.loadavg()[0]` could be near 0, making `loadPct` effectively 0%. A test that checks "CPU shows a number" would pass with 0%, but it wouldn't prove the data pipeline works correctly. Tests should verify the vitals object has all expected fields with valid types, not just check the UI render.

### False-PASS Risk 3: Init vitals work but tick vitals don't (or vice versa)
There are two paths for vitals data: init message and watchdog:tick. A test that only checks one path could pass while the other is broken. Tests must cover both paths independently.

### False-PASS Risk 4: Progress bar color thresholds are wrong
The color transitions at 60% and 85% are visual and hard to assert in automated tests. A test that checks "the bar has a background color" would pass even if the thresholds are wrong. Tests should inject specific vitals values (e.g., cpuPct=90) and verify the resulting color matches the danger color.
