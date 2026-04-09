# Category B: Terminal Rendering — Adversarial Findings

> Generated: 2026-04-07T22:23:53.655Z
> Total: 1 tests | 1 BUGS | 0 WARNS | 0 PASS

## Summary

**1 bug(s) found:**

- **B.03**: STALE BUFFER: marker "STALE_MARKER_1775600624329" still visible after Refresh. xterm.reset() not clearing buffer on session:subscribed.

## Full Results

| Test | Status | Detail |
|------|--------|--------|
| B.03 | BUG | STALE BUFFER: marker "STALE_MARKER_1775600624329" still visible after Refresh. xterm.reset() not clearing buffer on session:subscribed. |