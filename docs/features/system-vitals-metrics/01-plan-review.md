# 01 Plan Review: System Vitals Metrics

## Completeness

All 5 required sections are present and substantive:
- Section 1 (Problem & Context): thorough, identifies existing code with file paths and line numbers
- Section 2 (Design Decision): step-by-step modification plan with 7 numbered changes
- Section 3 (Acceptance Criteria): 10 specific Given/When/Then criteria
- Section 4 (Lifecycle Stories): 5 user journey stories with observable outcomes
- Section 5 (Risks): 4 risks + 4 false-PASS risks identified

## Specificity

### File citations verified (spot checks):

1. **`lib/watchdog/WatchdogManager.js` line 522-548** (`checkResources()`): VERIFIED. The method exists at exactly those lines and returns `{ diskPct, diskAvailGb, memAvailMb, loadPct, cpus, alerts }`.

2. **`lib/watchdog/WatchdogManager.js` line 1100-1112** (resource check in tick): VERIFIED. The 5-minute throttled block is at exactly those lines, calling `this.checkResources()` and sending alerts.

3. **`lib/watchdog/WatchdogManager.js` line 1213-1219** (broadcast): VERIFIED. The `clientRegistry.broadcast()` call is at those lines with the exact payload described.

4. **`public/js/components/TopBar.js` line 34** (empty `global-stats` div): VERIFIED. The empty `<div class="global-stats"></div>` exists at line 34.

5. **`public/js/state/sessionState.js` line 75-83** (init handler): VERIFIED. The `on(SERVER.INIT, ...)` handler is at those lines with the body described.

### Design specificity assessment:

- Each of the 7 changes specifies exact file paths AND line numbers for modifications. This is above the minimum standard.
- The data flow section traces the complete path: origin (os module calls) -> transformation (vitals object shape) -> transport (WS broadcast) -> consumption (signal update) -> display (component render).
- Function signatures and payload shapes are specified with field names and types.
- The scope boundary is explicit with 5 "NOT building" items.

### Minor observation on Section 2, Change 4 (actions.js):
The design mentions adding `handleWatchdogTick` and `handleInit` to `actions.js`, but then Section 2 Change 5 clarifies the actual wiring is in `sessionState.js` where handlers are registered inline (not via named exports from actions.js). The design is internally consistent -- the inline handler in sessionState.js is the correct approach. The actions.js code snippets in Change 4 appear to be illustrative but are NOT the actual implementation path. The implementer should follow Change 5 (sessionState.js) and can skip adding named exports to actions.js since the handler is a one-liner.

## Testability

- Acceptance criteria are observable: each one describes a visual or data outcome that can be verified by looking at the running app or inspecting WS messages.
- Lifecycle stories are written as user journeys with observable actions and outcomes, not technical steps. All 5 stories describe what the user sees and does.

## Codebase Grounding

All 5 spot-checked citations are accurate. The designer correctly identified:
- The existing `checkResources()` method and its return shape
- The existing `watchdog:tick` broadcast and its current payload
- The empty `global-stats` div in TopBar as the insertion point
- The init handler wiring in `sessionState.js`

The proposed change at the correct insertion point (line 1213 broadcast) would produce the described behavior.

## Risk Coverage

- Section 5 identifies 4 genuine risks (df latency, stale data, init handler wiring, multi-path coverage) -- all are specific to this feature, not generic.
- 4 false-PASS risks are identified and each explains what a vacuous test would look like vs. what a genuine test must check.
- The risks are realistic and actionable.

## One Structural Concern (non-blocking)

The design proposes calling `checkResources()` on EVERY tick (moved from the 5-minute throttle). The `checkResources()` method calls `execSync("df / | awk ...")` which spawns a shell process. On a 30-second tick interval, this is one `df` exec every 30 seconds -- low overhead but not zero. This is acceptable for the stated use case. If tick interval were ever reduced (e.g., to 5 seconds), this would need revisiting. The designer acknowledged this with "The `checkResources()` method is cheap" -- agreed for 30-second intervals.

---

### Verdict: APPROVED

The design document is thorough, specific, and grounded in the actual codebase. All section requirements are met. File:line citations are accurate. The data flow is traced end-to-end. Acceptance criteria are observable and testable. The one potential confusion between Changes 4 and 5 is minor and self-resolving (Change 5 supersedes Change 4 for the wiring approach). The implementer has sufficient information to build this feature without asking additional questions.
