# 03 Test Designs: System Vitals Metrics

## T-1: Init message delivers vitals on connection
**Flow:**
1. Start a test server on port 3200 with `DATA_DIR` pointing to a temp directory.
2. Connect a WebSocket client to `ws://127.0.0.1:3200`.
3. Wait for the first message (init).
4. Parse the JSON message.

**Pass condition:** The init message has `type: 'init'`, `vitals` is an object (not null/undefined), and `vitals` contains all 7 fields: `cpuPct` (number), `memUsedMb` (number, > 0), `memTotalMb` (number, > 0), `memPct` (number, 0-100), `diskPct` (number, >= 0), `uptimeS` (number, >= 0), `timestamp` (ISO string).

**Fail signal:** `vitals` is null/undefined/missing, or any field is missing or has wrong type. This would mean the server.js change was not applied or `getVitals()` is broken.

**Test type:** WS protocol

**Port:** 3200


## T-2: Watchdog tick broadcasts vitals
**Flow:**
1. Start a test server on port 3201 with a short watchdog tick interval (e.g., 2 seconds).
2. Connect a WebSocket client.
3. Receive and discard the init message.
4. Wait up to 10 seconds for a message with `type: 'watchdog:tick'`.

**Pass condition:** A `watchdog:tick` message arrives within 10 seconds, it contains a `vitals` object with all 7 required fields, and `vitals.timestamp` is a recent ISO timestamp (within last 15 seconds).

**Fail signal:** No `watchdog:tick` message arrives within 10 seconds, or the message arrives but `vitals` is null/missing. This would mean the tick() modification was not applied correctly.

**Test type:** WS protocol

**Port:** 3201


## T-3: VitalsIndicator renders in TopBar on page load
**Flow:**
1. Start a test server on port 3202.
2. Open Playwright browser and navigate to `http://127.0.0.1:3202`.
3. Wait for the page to load (`domcontentloaded`).
4. Wait up to 5 seconds for the `.vitals-indicator` element to appear in the TopBar.
5. Check its text content.

**Pass condition:** A `.vitals-indicator` element exists inside `#topbar .global-stats`. It contains the text "Vitals" and at least one of: "CPU", "RAM", "Disk". It displays numeric values (not just "waiting...") -- meaning the init vitals populated successfully.

**Fail signal:** The `.vitals-indicator` element doesn't exist (component not mounted), OR it shows "waiting..." permanently (init handler not wiring vitals to the signal), OR it renders outside the TopBar (wrong mount point).

**Test type:** Playwright browser

**Port:** 3202


## T-4: Vitals display updates on watchdog tick
**Flow:**
1. Start a test server on port 3203 with a 3-second watchdog tick interval.
2. Open Playwright browser, navigate to the page.
3. Wait for initial vitals to render (CPU % appears).
4. Record the initial CPU % text and RAM text.
5. Wait for at least one watchdog tick to arrive (up to 10 seconds).
6. Read the vitals display again.
7. Verify the `timestamp` in the vitals data has changed (or the values are plausibly different -- they should at minimum have a different timestamp).

**Pass condition:** The vitals display updates after a tick. At minimum, the data has a different timestamp from the init data (verifiable by inspecting the title attribute which shows "Updated Ns ago"). The display continues to show numeric CPU/RAM/Disk values.

**Fail signal:** Vitals display never changes from its initial state after the init message. This would mean the `watchdog:tick` handler is not updating the signal, or the VitalsIndicator is not re-rendering on signal change.

**Test type:** Playwright browser

**Port:** 3203


## T-5: REST endpoint /api/watchdog/state includes vitals
**Flow:**
1. Start a test server on port 3204.
2. Send a GET request to `http://127.0.0.1:3204/api/watchdog/state`.
3. Parse the JSON response.

**Pass condition:** The response includes a `vitals` field that is an object with `cpuPct`, `memUsedMb`, `memTotalMb`, `memPct`, `diskPct`, `uptimeS`, and `timestamp`.

**Fail signal:** The `vitals` field is missing from the response. This would mean `getSummary()` was not updated to include vitals.

**Test type:** REST

**Port:** 3204


## T-6: Color threshold -- CPU bar turns red above 85%
**Flow:**
1. Start a test server on port 3205.
2. Open Playwright browser, navigate to the page.
3. Wait for vitals to render.
4. Use `page.evaluate()` to inject a synthetic vitals update into the Preact signal: set `vitals.value = { cpuPct: 92, memUsedMb: 2000, memTotalMb: 4000, memPct: 50, diskPct: 50, uptimeS: 100, timestamp: new Date().toISOString() }`.
5. Wait for re-render (brief delay).
6. Find the CPU percentage text element and check its color.

**Pass condition:** The CPU value "92%" is displayed with a red/danger color (contains `f04848` or matches `var(--danger)`). The RAM and Disk values have green/accent colors (since they are at 50%).

**Fail signal:** CPU shows 92% but the color is green or yellow. This would mean the color threshold logic in `metricColor()` is wrong. OR the injected vitals didn't cause a re-render (signal reactivity broken).

**Test type:** Playwright browser

**Port:** 3205


## T-7: Stale vitals indicator (adversarial)
**Flow:**
1. Start a test server on port 3206.
2. Open Playwright browser, navigate to the page.
3. Wait for vitals to render with real data.
4. Use `page.evaluate()` to inject vitals with a timestamp 5 minutes in the past: `{ cpuPct: 30, memPct: 40, memUsedMb: 1500, memTotalMb: 4000, diskPct: 50, uptimeS: 100, timestamp: new Date(Date.now() - 300000).toISOString() }`.
5. Check the vitals indicator state.

**Pass condition:** The vitals indicator shows "(stale)" text AND has reduced opacity (0.5). The title attribute mentions "stale" or "paused".

**Fail signal:** The vitals indicator displays normally with full opacity despite having a 5-minute-old timestamp. This would mean the staleness detection logic is broken.

**Test type:** Playwright browser

**Port:** 3206


## T-8: Null vitals shows waiting placeholder
**Flow:**
1. Start a test server on port 3207.
2. Open Playwright browser, navigate to the page.
3. Before the init message arrives (or by injecting `vitals.value = null`), check the vitals display.

**Pass condition:** The vitals indicator shows "Vitals" label and "waiting..." text. No crash, no blank space, no undefined text.

**Fail signal:** The component crashes (white screen / error in console), shows "undefined%" or "NaN", or is completely invisible. This would mean the null guard in VitalsIndicator is broken.

**Test type:** Playwright browser

**Port:** 3207
