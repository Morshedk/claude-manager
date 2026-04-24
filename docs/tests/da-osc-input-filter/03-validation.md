# DA/OSC/Mouse Input Filter -- Test Validation

Validator: TEST VALIDATOR (adversarial)
Date: 2026-04-09

---

## T-1: DA2 response leak

### 1. Outcome valid? GENUINE PASS

Pre-fix run confirmed 1 leaked DA2 frame (`1b 5b 3e 30 3b 32 37 36 3b 30 63` = `\x1b[>0;276;0c`). Post-fix run showed 0 leaked frames. The precondition (actual leak before fix) was established, and the fix eliminated it.

### 2. Design sound? YES

The test injects `printf '\x1b[>c'\n` into the live PTY after the browser subscribes. xterm parses the DA2 query from its output stream and auto-replies via `onData`. The WS frame interceptor captures any `session:input` containing the DA2 response pattern `/\x1b\[>[;\d]*c/`. This would catch a regression if the fix were reverted -- the DA2 response would pass through the old single-regex filter and appear in `session:input` frames.

### 3. Execution faithful? YES, with one infrastructure deviation

The design says to inject the DA2 query via raw WS *before* opening the browser (step 2), relying on scrollback replay. The executor discovered that DirectSession has no scrollback replay and changed the injection to occur *after* browser subscribe (step 3 in code, documented in run output as "infrastructure fix: corrected trigger timing"). This is a legitimate infrastructure fix. The assertion logic is unchanged: check for DA2 frames in `session:input`, expect 0.

**No assertion was watered down.** The test still expects exactly 0 leaked frames.

---

## T-2: OSC color query response leak

### 1. Outcome valid? GENUINE PASS

Pre-fix run confirmed 2 leaked OSC frames:
- `\x1b]10;rgb:d0d0/d8d8/e0e0\x1b\` (foreground color)
- `\x1b]11;rgb:0c0c/1111/1717\x1b\` (background color)

Post-fix run showed 0 leaked frames.

### 2. Design sound? YES

Trigger is correct: `printf '\x1b]10;?\x07' && printf '\x1b]11;?\x07'\n` injected into live PTY. xterm processes the OSC queries and auto-replies via `onData`. The interceptor checks for `session:input` frames starting with `\x1b]`. Regression would immediately surface.

### 3. Execution faithful? YES

Same timing infrastructure fix as T-1 (inject after subscribe, not before). Run output says "Attempts: 1 (clean run after T-1 infrastructure fix applied to same timing pattern)." No assertion changes.

**Notable finding from run output:** xterm replies with ST terminator (`\x1b\`) not BEL (`\x07`). The fix regex handles both: `(\x07|\x1b\\)$`. This was proactively validated by the run, confirming the regex covers the actual terminator xterm uses.

---

## T-3: SGR mouse event leak

### 1. Outcome valid? GENUINE PASS

Pre-fix run confirmed 6 leaked mouse frames (3 press + 3 release events). Post-fix run showed 0 leaked frames.

### 2. Design sound? YES

Trigger activates SGR mouse mode via `printf '\x1b[?1000h\x1b[?1006h'\n`, then dispatches mouse events on `.xterm-screen`. The interceptor checks for `session:input` frames matching `/^\x1b\[<[\d;]+[Mm]$/`.

### 3. Execution faithful? YES, with two infrastructure deviations

1. **Timing fix**: Same as T-1/T-2 -- inject after subscribe.
2. **Mouse dispatch fix**: Playwright's `page.mouse.down/up` was insufficient in headless mode. The executor added `dispatchEvent` with `{bubbles: true}` on `.xterm-screen` to reliably trigger xterm's internal mouse handler. This is a legitimate infrastructure fix -- xterm's mouse tracking listens on specific DOM elements and headless Chromium does not always route native mouse events there.

Additionally, the executor added a fallback that tries to call `xterm.input()` directly to force mouse mode activation (lines 210-228 of the test). This is a belt-and-suspenders approach but does NOT weaken the assertion. The test still checks whether mouse events *leak through* the `onData` -> `session:input` path.

**No assertion was watered down.**

---

## T-4: Normal input still flows (anti-over-filter)

### 1. Outcome valid? GENUINE PASS

Pre-fix: PASS (11 frames, all chars present). Post-fix: PASS (11 frames, all chars present). Both runs show identical behavior, which is the expected result for an anti-over-filter test.

### 2. Design sound? YES

Types `echo hello` + Enter, expects >= 10 `session:input` frames containing all characters. This would catch an over-aggressive filter that blocks printable characters or carriage return.

### 3. Execution faithful? YES

Code matches design exactly. The test resets `allInputFrames` and `inputDataConcat` after terminal mount (line 183-184), so only typing-generated frames are counted. No timing or assertion changes.

**Confirmed: passed on BOTH pre-fix and post-fix**, as required.

---

## T-5: Arrow keys, special keys, and DA1 regression guard

### 1. Outcome valid? GENUINE PASS

Pre-fix: PASS (8 arrow frames, 0 DA1 leaks). Post-fix: PASS (8 arrow frames, 0 DA1 leaks). Both runs pass, which is expected -- the old filter already handled DA1 (`\x1b[?1;2c`) and never blocked arrow keys.

### 2. Design sound? YES

Two-part test: (a) arrow keys must flow through (>= 4 frames), (b) DA1 response must remain filtered (0 frames). This catches both over-filtering (arrows blocked) and under-filtering (DA1 regression).

### 3. Execution faithful? YES

Code matches design. Presses 8 arrow keys (Up/Down/Left/Right x2), then injects DA1 trigger. The DA1 regex check `/^\x1b\[\?\d+[;\d]*c$/` correctly matches DA1 response format.

**Confirmed: passed on BOTH pre-fix and post-fix**, as required.

---

## T-6: Combined scenario -- mount triggers zero spurious input

### 1. Outcome valid? NOT IMPLEMENTED

**T-6 was designed but never implemented.** There is no test file `da-osc-filter-T6-*.test.js`. The run output (`02-run-output.txt`) contains results for T-1 through T-5 only. The T-6 design in `01-test-designs.md` specifies a combined scenario with a liveness check (type `x` and verify it arrives), but no executor built or ran it.

### 2. Impact assessment

T-6 was the **only test with a liveness check**. Without T-6, none of the five implemented tests verify that the WebSocket pipeline is actually alive during the observation window. The leak tests (T-1 through T-3) each confirm pre-fix leaks were detected, which indirectly proves the pipeline was live during the pre-fix run. But in the post-fix run, the test simply observes 0 leaked frames -- if the pipeline were dead, you would also see 0 leaked frames. This is partially mitigated by T-4 proving input flows, but T-4 runs in a separate server instance and does not share the same session/WS connection as T-1/T-2/T-3.

**However**, the pre-fix confirmation (showing actual leaked frames) for each leak test proves the trigger mechanism works. The only scenario where the post-fix PASS could be vacuous is if the fix *broke the WebSocket pipeline entirely* rather than filtering the sequences -- but T-4 and T-5 running on post-fix code confirm that the pipeline works for normal input.

**Verdict: Missing T-6 is a gap but not a false PASS source.** The combination of pre-fix leak confirmation (T-1/T-2/T-3) + post-fix normal input confirmation (T-4/T-5) provides reasonable confidence.

---

## Regex Correctness Analysis

### Fix code (TerminalPane.js lines 127-129):

```javascript
if (/^\x1b\[[\?>\d][;\d]*[cn]$/.test(data)) return;   // DA / DA2
if (/^\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)$/.test(data)) return;  // OSC
if (/^\x1b\[<[\d;]+[Mm]$/.test(data)) return;           // mouse events
```

### DA2 filtering: `\x1b[>0;276;0c`

- Regex: `/^\x1b\[[\?>\d][;\d]*[cn]$/`
- `\x1b[` matches the CSI introducer.
- `[\?>\d]` matches `>` (the DA2 prefix character). CORRECT.
- `[;\d]*` matches `0;276;0`. CORRECT.
- `[cn]$` matches the final `c`. CORRECT.
- **FILTERS CORRECTLY.**

### DA1 filtering preserved: `\x1b[?1;2c`

- `[\?>\d]` matches `?`. CORRECT.
- `[;\d]*` matches `1;2`. CORRECT.
- `[cn]$` matches `c`. CORRECT.
- **NO REGRESSION.**

### OSC filtering: `\x1b]10;rgb:0c0c/1111/1919\x07` and `\x1b]10;rgb:d0d0/d8d8/e0e0\x1b\`

- Regex: `/^\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)$/`
- `\x1b]` matches OSC introducer. CORRECT.
- `\d+` matches `10` or `11`. CORRECT.
- `;` matches the semicolon. CORRECT.
- `[^\x07\x1b]*` matches `rgb:0c0c/1111/1919` (no BEL or ESC in the color string). CORRECT.
- `(\x07|\x1b\\)$` matches either BEL terminator or ST terminator. CORRECT.
- **FILTERS CORRECTLY for both terminator types.**

### Mouse filtering: `\x1b[<0;45;27M` and `\x1b[<0;45;27m`

- Regex: `/^\x1b\[<[\d;]+[Mm]$/`
- `\x1b[` matches CSI. CORRECT.
- `<` matches the SGR mouse prefix. CORRECT.
- `[\d;]+` matches `0;45;27`. CORRECT.
- `[Mm]$` matches `M` (press) or `m` (release). CORRECT.
- **FILTERS CORRECTLY.**

### Over-filter checks:

| Sequence | Purpose | Matched? | Why |
|---|---|---|---|
| `\x1b[A` | Arrow Up | NO | `A` is not in `[\?>\d]` (first char after `[` is `A`, a letter not in the class). Also `A` does not match `[cn]`. Safe. |
| `\x1b[B` through `\x1b[D` | Arrow Down/Left/Right | NO | Same reason. |
| `\x1b[H` / `\x1b[F` | Home / End | NO | `H`/`F` not in `[\?>\d]`, not in `[cn]`. |
| `\x1bOA` through `\x1bOD` | Application mode arrows | NO | `O` is not `[` or `]`, no regex matches. |
| `\x1b[200~...` | Bracketed paste | NO | `2` matches `[\?>\d]` but `~` does not match `[cn]`. Safe. |
| `x`, `e`, `\r` | Normal chars | NO | No `\x1b` prefix. |
| `\x1ba` | Alt+a | NO | No `[` after `\x1b`. |

**One edge case worth noting:** The DA/DA2 regex matches `/^\x1b\[[\?>\d][;\d]*[cn]$/`. The sequence `\x1b[0n` (DSR OK response) matches: `0` in `[\?>\d]`, empty `[;\d]*`, `n` in `[cn]`. This is correct behavior -- DSR OK responses should be filtered. But `\x1b[5n` (DSR query response = "terminal OK") also matches: `5` in `[\?>\d]`, `n` in `[cn]`. This is also correct -- it is a terminal response, not user input.

**Potential gap:** The regex `[\?>\d]` uses `\d` which matches any single digit 0-9. This means `\x1b[1c` would match. Is `\x1b[1c` ever a legitimate user input? No -- CSI sequences ending in `c` are always DA responses. Safe.

---

## Infrastructure Fixes Assessment

Three infrastructure fixes were applied:

### Fix 1: Injection timing (affects T-1, T-2, T-3)

**Change:** Inject escape sequences into live PTY *after* browser subscribes, not before.
**Reason:** DirectSession has no scrollback replay; pre-seeded content never reaches xterm.
**Impact on assertions:** None. The assertion logic (check for leaked frames, expect 0) is unchanged. This fix was necessary to make the trigger mechanism work at all -- without it, xterm never saw the escape sequences and the test would be VACUOUS.
**Verdict: Infrastructure only. No assertion dilution.**

### Fix 2: Mouse dispatch method (affects T-3)

**Change:** Use `dispatchEvent` with `{bubbles: true}` on `.xterm-screen` instead of relying solely on Playwright's `page.mouse.*` API.
**Reason:** Headless Chromium does not reliably route native mouse events to xterm's internal mouse handler.
**Impact on assertions:** None. The assertion still checks that 0 mouse frames leak through.
**Verdict: Infrastructure only. No assertion dilution.**

### Fix 3: Direct xterm.input() for mouse mode (affects T-3)

**Change:** Added a fallback that calls `xterm.input('\x1b[?1000h')` and `xterm.input('\x1b[?1006h')` directly on the terminal instance.
**Reason:** Belt-and-suspenders approach to ensure mouse mode activates regardless of PTY timing.
**Impact on assertions:** None. `xterm.input()` feeds data into the terminal parser (same as PTY output), not into `onData`. It does not bypass the filter path.
**Verdict: Infrastructure only. No assertion dilution.**

---

## Specific Checks

### Pre-fix failure confirmation

| Test | Pre-fix leaked frames | Trigger worked? |
|---|---|---|
| T-1 (DA2) | 1 frame: `\x1b[>0;276;0c` | YES |
| T-2 (OSC) | 2 frames: `\x1b]10;rgb:...\x1b\` and `\x1b]11;rgb:...\x1b\` | YES |
| T-3 (Mouse) | 6 frames: 3 press + 3 release | YES |

All three leak tests confirmed actual pre-fix failures. No vacuous passes.

### Liveness check

**NOT PERFORMED.** T-6 (the only test with a liveness check) was never implemented. See T-6 section above for impact assessment.

### Anti-over-filter (T-4, T-5) pre/post-fix symmetry

| Test | Pre-fix | Post-fix | Symmetric? |
|---|---|---|---|
| T-4 (normal input) | PASS (11 frames) | PASS (11 frames) | YES |
| T-5 (arrows + DA1) | PASS (8 arrow, 0 DA1) | PASS (8 arrow, 0 DA1) | YES |

Both passed identically on pre-fix and post-fix. No suspicious asymmetry.

---

## Overall Verdict: BUG FIXED WITH GAPS

### What is confirmed:

- All three leak categories (DA2, OSC, mouse) had confirmed pre-fix failures and confirmed post-fix filtering. The fix works.
- The regex is correct and does not over-filter arrow keys, normal input, function keys, or bracketed paste.
- DA1 filtering is preserved (no regression from the regex rewrite).
- All three infrastructure fixes were to infrastructure only; no assertions were diluted.
- Anti-over-filter tests pass symmetrically on both pre-fix and post-fix code.

### Gaps:

1. **T-6 not implemented.** The combined scenario with liveness check was designed and approved but never built or executed. This means there is no single test that verifies all three filter categories simultaneously, and no test that includes an explicit liveness check (type a character, verify it arrives) in the same session as the leak observation. The risk of a vacuous PASS from a dead pipeline is low (pre-fix confirmation + T-4/T-5 normal input tests mitigate it) but the gap exists.

2. **No SGR mouse motion events tested.** T-3 tests button press/release (`M`/`m`) but not mouse motion reports (`\x1b[<35;col;rowM`). Mouse motion with button 35 (no button, just movement) is generated when `?1003h` (any-event tracking) is active. The fix regex would catch these too (since they match `\x1b[<[\d;]+M`), but it was not explicitly tested.

3. **No OSC with BEL terminator tested.** The run output shows xterm uses ST (`\x1b\`) not BEL (`\x07`) for OSC replies. The fix regex handles both, but only the ST path was exercised. This is a minor gap since the regex is clearly correct for both, but the BEL path is untested.

### False PASS assessment:

**No false PASSes found.** All five implemented tests have genuine outcomes. T-1/T-2/T-3 are genuine passes backed by pre-fix failure confirmation. T-4/T-5 are genuine passes backed by pre/post-fix symmetry. The missing T-6 is a coverage gap, not a false pass.
