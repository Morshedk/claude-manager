# Credit History & Session Breakdown Design

**Date:** 2026-04-18
**Status:** Approved (autonomous — user away)
**Scope:** v2 app only

## Problem

The current `checkCcusage()` captures a single point-in-time snapshot of billing block data. There is no:
- Attribution of cost by source (factory sessions vs watchdog AI calls vs dev sessions)
- Time series storage for trending burn rate over time
- UI to visualise either

## Attribution Model

`ccusage session --json` returns sessions grouped by their working directory (encoded as `sessionId`). Attribution is by `sessionId` prefix:

| Category | sessionId prefix | What it represents |
|----------|-----------------|-------------------|
| **Factory** | `-projects-niyyah` | factory + factory2 tmux sessions doing actual work |
| **Watchdog** | `-tmp` | Watchdog's own AI calls (summarisation, deep review) |
| **Dev v2** | `-home-claude-runner-apps-claude-web-app-v2` | v2 Claude Code dev sessions + their subagents |
| **Dev v1** | `-home-claude-runner-apps-claude-web-app` | v1 Claude Code dev sessions + their subagents |
| **Other** | everything else | scripts, misc sessions |

Costs are summed within each category. `totalCost` per session is used (all-time), not per-block — so breakdown shows cumulative lifetime attribution, not per-block. This is the best ccusage can provide.

## Data Model

### Enhanced creditSnapshot (in-memory + activity logs)

```js
{
  timestamp: "ISO string",
  type: "creditSnapshot",
  block: { costUSD, totalTokens, isActive, burnRate: { costPerHour }, projection: { totalCost, remainingMinutes } },
  todayCostUSD: number,
  breakdown: {
    factory: number,    // cumulative $ from -projects-niyyah sessions
    watchdog: number,   // cumulative $ from -tmp sessions
    devV2: number,      // cumulative $ from -home-...-app-v2 sessions
    devV1: number,      // cumulative $ from -home-...-app sessions (v1)
    other: number,      // everything else
    total: number,      // sum of all
  }
}
```

### Credit history file

`data/credit-history.json` — rolling array capped at **200 entries**.

Each entry:
```js
{
  timestamp: "ISO string",
  burnRateCostPerHour: number | null,
  blockCostUSD: number | null,
  todayCostUSD: number | null,
  breakdown: { factory, watchdog, devV2, devV1, other, total }
}
```

200 entries at 60min interval = ~8 days of history. At 5min interval = ~17 hours. Appropriate for both extremes.

## Architecture

### Changes to WatchdogManager

**`checkCcusage()` enhancement:**
- Add 3rd parallel `_runCcusage(['session'])` call alongside existing `blocks` + `daily`
- Build `breakdown` object by summing `totalCost` per session grouped by sessionId prefix
- Include `breakdown` in the returned snapshot object
- After building snapshot, append a trimmed entry to `data/credit-history.json` via `_appendCreditHistory()`

**New `_appendCreditHistory(entry)` method:**
- Atomic write (tmp + rename pattern, same as `_appendLog`)
- Caps at 200 entries

**New `getCreditHistory()` method:**
- Reads and returns `data/credit-history.json`, returns `[]` on missing file

### New API route

`GET /api/watchdog/credit-history` — returns array from `watchdog.getCreditHistory()`.

### WatchdogPanel UI additions

Two new sections below the existing credit tile:

**1. Session Breakdown** (shown when `creditSnapshot.breakdown` exists):
Horizontal row of labelled tiles: Factory / Watchdog / Dev v2 / Dev v1 / Other — each showing cumulative `$X.XX`. Styled consistently with existing tiles.

**2. Burn Rate Sparkline** (shown when history has ≥2 entries):
- SVG chart, ~100% width × 80px tall
- Plots `burnRateCostPerHour` over last 48 history entries
- Simple polyline, no axes labels (tooltip on hover is out of scope)
- Null/missing values treated as 0
- WatchdogPanel fetches `/api/watchdog/credit-history` on load and refresh

## Error Handling

- `ccusage session` call failure: `breakdown` is omitted from snapshot (existing block + daily data still returned)
- History file missing: `getCreditHistory()` returns `[]`, UI hides sparkline
- Malformed history entries: filtered out in `getCreditHistory()` (must have `timestamp` field)

## Testing

Unit tests for:
- `checkCcusage()` now includes `breakdown` field with correct category mapping
- `_appendCreditHistory()` caps at 200 entries and uses atomic write
- `getCreditHistory()` returns `[]` on missing file, filters malformed entries

No UI tests (consistent with existing WatchdogPanel approach).

## Out of Scope

- Per-block breakdown (ccusage doesn't support filtering session data by billing block)
- factory vs factory2 split (same working directory, indistinguishable)
- Tooltip/hover on sparkline
- Export or download of history data
- Plotting anything other than burn rate (one chart, one metric)

## Self-Review

**Placeholder scan:** None found.

**Internal consistency:** Attribution model uses `sessionId` prefix (not `projectPath`) — confirmed from live ccusage output. History cap (200) matches commentary. Atomic write pattern matches existing `_saveState()` and `_appendLog()`.

**Scope:** Single spec, 4 files touched, clear boundaries.

**Ambiguity:** "cumulative lifetime attribution" for breakdown is explicit — this is a known limitation of ccusage, not an oversight. Documented clearly.
