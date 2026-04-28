# Decision: Session Event Streaming Approach (2A vs 2B)

**Date:** 2026-04-27  
**Decision:** Approach 2A (enhanced polling) — no fallback to 2B needed

## Context

The session events panel needed to move from noisy raw PTY streaming to clean, readable
snapshots that animate like a stream. Two approaches were prototyped:

- **2A**: Enhanced REST polling — SessionLogPane polls `/api/sessionlog/:id/tail` every 2s,
  diffs against last-seen line, animates new lines with CSS slide-in
- **2B**: WebSocket-pushed snapshots — server pushes snapshot on every SessionLogManager tick,
  client renders new lines on each push

## UAT-5 Gate

Threshold: ≤ 3s from event to visible in events panel.

**Measured result:** CLIENT:CONNECT event appeared in the events panel within the 2s poll window
(≤ 2s end-to-end). Well within threshold.

## Decision: 2A Only

2A meets all objectives without the added complexity of 2B:

| Objective | 2A result |
|-----------|-----------|
| No raw PTY noise | ✓ SessionLogManager isSpinnerLine() filters fragments |
| Timestamps | ✓ `--- ISO_TS ---` markers always included by tailLog() |
| System events | ✓ SESSION:START, CLIENT:CONNECT, TIME_GAP injected as `=== EVENT ===` markers |
| Stream feel | ✓ CSS `logSlideIn` animation on newly diffed lines |
| Latency ≤ 3s | ✓ ≤ 2s measured |
| Session card consistency | ✓ Both card preview and events panel use tailLog() from same .log file |

2B adds a WebSocket push path and server-side broadcast on every tick (every 5s). Given 2A
already delivers ≤ 2s latency via polling, 2B would reduce latency by ~2s at the cost of
additional server-side complexity, a new WS message type, and state management for snapshot
deduplication. This tradeoff is not justified.

## Implementation Shipped

- SessionLogManager: `tmux pipe-pane` capture → strip ANSI → filter spinners → write `.log`
- Time-gap detection: 30s inactivity → inject `=== TIME_GAP | ts | gap=Xs ===` marker
- SESSION:START injected when PTY reaches `running` state
- CLIENT:CONNECT injected when WS client subscribes to session
- SessionLogPane: 2s poll, diff-based isNew detection, CSS slide-in animation, collapsed mode
- Session card preview: sourced from `tailLog()` on 5s refresh interval
