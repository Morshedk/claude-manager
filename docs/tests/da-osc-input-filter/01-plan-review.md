# DA/OSC/Mouse Input Filter — Plan Review (Cycle 2)

## Verdict: APPROVED

All 7 gaps from cycle 1 have been resolved. No new blocking issues introduced.

---

## Gap Resolution Status

### Gap 1: T-1 injection via printf shell command — RESOLVED

T-1 step 2 now explicitly states: "send `session:input` with the shell command text `printf '\x1b[>c'\n` (i.e., the literal characters `p`, `r`, `i`, `n`, `t`, `f`, ..., followed by a newline). Bash executes the printf, which writes the raw escape `\x1b[>c` to stdout. The PTY forwards this to xterm as output, triggering xterm's DA2 auto-reply."

This is clear, correct, and unambiguous. The executor will understand that a shell command string is being typed, not raw escape bytes.

### Gap 2: T-2 OSC injection — committed to printf approach — RESOLVED

T-2 step 2 now reads: "send `session:input` with the shell command text `printf '\x1b]10;?\x07' && printf '\x1b]11;?\x07'\n` (a newline-terminated bash command)." No alternative methods are mentioned. The ambiguity is gone.

### Gap 3: T-3 mouse mode enable as shell command — RESOLVED

T-3 step 2 now states: "send `session:input` with the shell command text `printf '\x1b[?1006h'\n` (a newline-terminated bash command). Bash executes the printf, which writes the raw escape `\x1b[?1006h` to stdout. The PTY forwards this to xterm as output, activating SGR mouse mode."

The distinction between shell command text and raw escape bytes is clear.

### Gap 4: T-6 liveness check — RESOLVED

T-6 step 8 now includes a full liveness check: after the 3-second observation window, type `x`, wait 1 second, verify at least one `session:input` frame containing `x` appears. Only then assert 0 frames during the observation window. The pass condition and fail signal both reference the liveness check explicitly. False-PASS from a dead WebSocket pipeline is eliminated.

### Gap 5: Pre-fix failure confirmation — RESOLVED

T-1, T-2, and T-3 each now contain a dedicated paragraph titled "Pre-fix failure confirmation" stating: "Before applying the fix, run this test and confirm it FAILS ... If the test passes on pre-fix code, the trigger mechanism is broken and the test is invalid." This is present in all three leak tests.

### Gap 6: Regex edge cases documented — RESOLVED

The Fix Design section now includes a "Regex edge cases for executor verification" subsection listing:
- `\x1b[c]` (bare query, no match -- correct)
- `\x1b[?1;2c` (DA1 response -- matches)
- `\x1b[>0;276;0c` (DA2 response -- matches)
- `\x1b[0n` (DSR OK -- matches)

Each case includes an explanation of which part of the regex handles it.

### Gap 7: DA1 regression guard in T-5 — RESOLVED

T-5 now includes a DA1 regression check as step 7: trigger a DA1 query via `printf '\x1b[c'\n`, wait 2 seconds, verify no `session:input` frame matches `/^\x1b\[\?\d+[;\d]*c$/`. The pass condition explicitly requires "Zero `session:input` frames contain DA1 response data." The title was updated to "Arrow keys, special keys, and DA1 regression guard."

---

## Check for New Issues Introduced by Revision

**Ports**: All unique and sequential (3300-3305). No conflicts.

**Consistency**: All six tests follow the same structural format (root cause, flow, pre/post output, pass condition, fail signal, port). No structural regressions.

**Fix design coherence**: The three-line replacement is consistent with what all six tests expect. The regex edge case documentation aligns with the T-5 DA1 regression check.

**No new ambiguities detected.** The revision is clean and focused -- it addressed exactly the 7 gaps without introducing new complexity or contradictions.

---

## Minor Observations (Non-blocking)

1. **T-1 step 3 ordering**: The flow creates the session and injects the DA2 trigger via raw WS client (step 2) before opening Playwright (step 3). This means the DA2 query is already in the scrollback when xterm mounts and replays. This is actually the correct approach for testing the replay-triggered auto-reply scenario. Just noting that the executor should understand that step 2 uses a raw WS client (not the browser), and step 3 opens the browser separately.

2. **T-3 mouse event timing**: Step 5 says "After 1 second (let mouse mode propagate)" before moving the mouse. This is a reasonable safety margin but somewhat arbitrary. If tests are flaky, this delay could be the first thing to increase. Non-blocking since 1 second should be sufficient for local testing.

3. **OSC terminator coverage**: The fix design's OSC regex handles both BEL (`\x07`) and ST (`\x1b\\`) terminators, but T-2 only triggers BEL-terminated responses (since xterm.js uses BEL for OSC replies). This is fine -- the regex is defensive, and the test covers the realistic case.
