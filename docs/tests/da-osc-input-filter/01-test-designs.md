# DA/OSC/Mouse Input Filter — Test Designs

## Root Cause

**File**: `/home/claude-runner/apps/claude-web-app-v2/public/js/components/TerminalPane.js`
**Line**: 127

```javascript
if (/^\x1b\[[\?]?\d+[;\d]*[cn]$/.test(data)) return;
```

This single regex attempts to filter xterm's automatic escape-sequence responses before they are sent as `session:input` to the server. It has three confirmed gaps:

1. **DA2 responses** (`\x1b[>0;276;0c`): The `>` prefix before the digits is not matched by `[\?]?`. The character class only optionally matches `?`, not `>`.
2. **OSC color query responses** (`\x1b]10;rgb:0c0c/1111/1919\x07`, `\x1b]11;rgb:...\x07`): These use `\x1b]` (OSC introducer), not `\x1b[` (CSI). No OSC filter exists at all.
3. **Mouse event reports** (`\x1b[<0;45;27M`, `\x1b[<0;45;27m`): SGR mouse encoding. The `<` after `[` is not matched by `[\?]?`.

All three leak through the filter and get forwarded as `session:input`, injecting garbage into the PTY.

---

## Brainstorm

### What exact sequences leak through?

| Sequence | Hex representation | Trigger | Why filter misses it |
|---|---|---|---|
| `\x1b[>0;276;0c` | `1b 5b 3e 30 3b 32 37 36 3b 30 63` | xterm replays scrollback containing DA2 query `\x1b[>c` | Regex expects `[\?]?` but `>` is not `?` |
| `\x1b]10;rgb:0c0c/1111/1919\x07` | `1b 5d 31 30 3b 72 67 62 3a ... 07` | Server/scrollback sends `\x1b]10;?\x07` (fg color query) | No OSC pattern at all; regex only handles CSI (`\x1b[`) |
| `\x1b]11;rgb:0c0c/1111/1919\x07` | Similar | Background color query `\x1b]11;?\x07` | Same — no OSC handling |
| `\x1b[<0;45;27M` | `1b 5b 3c 30 3b 34 35 3b 32 37 4d` | Mouse button press while SGR mouse mode is active | `<` not matched by `[\?]?` |
| `\x1b[<0;45;27m` | Same but lowercase `m` | Mouse button release | Same |

### What terminal event triggers each one?

- **DA2**: xterm auto-replies when its parser encounters a DA2 query (`\x1b[>c` or `\x1b[>0c`) in the output stream. This happens every time scrollback is replayed on subscribe, if the scrollback contains the query.
- **OSC color queries**: xterm auto-replies when its parser encounters `\x1b]10;?\x07` or `\x1b]11;?\x07`. Some programs (vim, tmux, etc.) query terminal colors on startup. These queries end up in scrollback and trigger replies on replay.
- **Mouse events**: When SGR mouse mode is active (e.g., `\x1b[?1006h` was sent by a program like less, vim, or Claude's TUI), every mouse press/move/release generates input. This happens continuously while the user moves the mouse.

### How do we capture them in a test?

**Primary method: Playwright WebSocket interception.** Playwright can intercept all WebSocket frames from the browser. We:
1. Start the server and create a bash session via REST/WS.
2. Open the page in Playwright, which mounts TerminalPane.
3. Intercept all outgoing WS frames from the page.
4. Trigger the conditions (write DA2 query to PTY output, write OSC query to PTY output, enable mouse mode and move mouse).
5. Collect all `session:input` messages and check whether the escape sequences were forwarded.

**Secondary verification: PTY content check.** After sending the escape sequences, read the PTY output (via `session:output`) and check whether garbage text appears in the bash prompt/output.

### What are the false-PASS risks?

1. **Session not actually connected**: If the session fails to subscribe, no input flows at all, and the test passes vacuously. Mitigation: always verify that normal keyboard input (e.g., "echo hi") does flow through as `session:input`.
2. **Timing**: The escape sequence response might arrive before our WS interceptor is attached. Mitigation: attach the interceptor before navigating to the page.
3. **xterm version difference**: If xterm.js does not actually reply to DA2/OSC queries in the test environment, no sequence is generated. Mitigation: verify at least one input message flows in the unfiltered case (pre-fix assertion).
4. **Mouse mode not enabled**: If we forget to enable SGR mouse mode via PTY output before moving the mouse, no mouse events fire. Mitigation: explicitly write `\x1b[?1006h` to enable SGR mouse mode.

### What happens if we over-filter?

- Real user input starting with `\x1b[` (arrow keys, function keys, etc.) could be blocked. Arrow keys are `\x1b[A` through `\x1b[D` — these end in letters A-D, not `c`, `n`, `M`, or `m`, so the DA filter should not hit them. But we must test that arrow keys still work after the fix.
- Alt+letter sequences (`\x1b` + char) should not match any of the three patterns since they lack the `[` or `]` prefix structure.
- Bracketed paste (`\x1b[200~...`) should not match because it ends with `~`, not `c`/`n`/`M`/`m`.

---

## Test Designs

### T-1: DA2 response leak — `\x1b[>0;276;0c`

**Root cause**: `TerminalPane.js:127` — regex `[\?]?` does not match `>`, so DA2 response `\x1b[>0;276;0c` passes through to `session:input`.

**Pre-fix failure confirmation**: Before applying the fix, run this test and confirm it FAILS — leaked DA2 frames must be detected in the `session:input` capture. If the test passes on pre-fix code, the trigger mechanism is broken and the test is invalid.

**Flow**:
1. Start server on port 3300, create a bash session via WS API.
2. Subscribe to the session via a raw WS client and send `session:input` with the shell command text `printf '\x1b[>c'\n` (i.e., the literal characters `p`, `r`, `i`, `n`, `t`, `f`, ..., followed by a newline). Bash executes the printf, which writes the raw escape `\x1b[>c` to stdout. The PTY forwards this to xterm as output, triggering xterm's DA2 auto-reply.
3. Open the page in Playwright with WS frame interception enabled on all outgoing frames.
4. Wait for `session:subscribed` to fire (xterm mounts and replays scrollback).
5. Collect all outgoing WS frames for 3 seconds.
6. Parse frames as JSON, filter for `type === 'session:input'`.
7. Check if any `session:input` message contains `data` matching `/\x1b\[>\d/` (the DA2 response pattern).

**Pre-fix output**: At least one `session:input` frame contains `\x1b[>0;276;0c` (or similar DA2 response). The frame count of `session:input` messages before any user typing is >= 1 (DA2 leak confirmed).

**Post-fix output**: Zero `session:input` frames match the DA2 response pattern. Only user-initiated input appears.

**Pass condition**: No outgoing `session:input` frame contains data matching `/^\x1b\[>[;\d]*c$/`.

**Fail signal**: One or more `session:input` frames contain a DA2 response string. Test logs the raw hex of the leaked frame.

**Test type**: Playwright browser + WS protocol interception

**Port**: 3300

---

### T-2: OSC color query response leak — `\x1b]10;rgb:...\x07`

**Root cause**: `TerminalPane.js:127` — no OSC filter exists. The regex only handles CSI sequences (`\x1b[`), so OSC responses (`\x1b]...`) pass through entirely.

**Pre-fix failure confirmation**: Before applying the fix, run this test and confirm it FAILS — leaked OSC frames must be detected in the `session:input` capture. If the test passes on pre-fix code, the trigger mechanism is broken and the test is invalid.

**Flow**:
1. Start server on port 3301, create a bash session.
2. Via a raw WS client, send `session:input` with the shell command text `printf '\x1b]10;?\x07' && printf '\x1b]11;?\x07'\n` (a newline-terminated bash command). Bash executes the two printf commands, which write the raw OSC queries to stdout. The PTY forwards these to xterm as output, triggering xterm's OSC color auto-replies.
3. Open the page in Playwright with WS frame interception.
4. Wait for xterm to mount, subscribe, and process the output containing the color queries.
5. Collect outgoing WS frames for 3 seconds.
6. Check for `session:input` frames whose `data` starts with `\x1b]` (OSC introducer).

**Pre-fix output**: At least one (likely two) `session:input` frames contain OSC responses like `\x1b]10;rgb:0c0c/1111/1919\x07` and `\x1b]11;rgb:0c0c/1111/1919\x07`. The exact RGB values depend on the XTERM_THEME configuration (background `#0c1117`, foreground `#d0d8e0`).

**Post-fix output**: Zero `session:input` frames contain OSC sequences.

**Pass condition**: No outgoing `session:input` frame contains data matching `/^\x1b\]/`.

**Fail signal**: OSC response frames appear in the captured `session:input` messages.

**Test type**: Playwright browser + WS protocol interception

**Port**: 3301

---

### T-3: SGR mouse event leak — `\x1b[<0;col;rowM`

**Root cause**: `TerminalPane.js:127` — regex `[\?]?` does not match `<`, so SGR mouse reports pass through as `session:input`.

**Pre-fix failure confirmation**: Before applying the fix, run this test and confirm it FAILS — leaked mouse event frames must be detected in the `session:input` capture. If the test passes on pre-fix code, the trigger mechanism is broken and the test is invalid.

**Flow**:
1. Start server on port 3302, create a bash session.
2. Via raw WS client, send `session:input` with the shell command text `printf '\x1b[?1006h'\n` (a newline-terminated bash command). Bash executes the printf, which writes the raw escape `\x1b[?1006h` to stdout. The PTY forwards this to xterm as output, activating SGR mouse mode.
3. Open page in Playwright with WS frame interception.
4. Wait for terminal to mount and subscribe.
5. After 1 second (let mouse mode propagate), move the mouse over the terminal element and click.
6. Collect outgoing WS frames for 3 seconds.
7. Filter `session:input` frames and check for data matching the SGR mouse pattern `\x1b[<`.

**Pre-fix output**: Multiple `session:input` frames contain mouse event data like `\x1b[<0;45;27M` (press) and `\x1b[<0;45;27m` (release). Typically 2+ frames per click.

**Post-fix output**: Zero `session:input` frames contain SGR mouse sequences.

**Pass condition**: No outgoing `session:input` frame contains data matching `/^\x1b\[<[\d;]+[Mm]$/`.

**Fail signal**: Mouse event frames appear in captured `session:input` messages.

**Test type**: Playwright browser + WS protocol interception

**Port**: 3302

---

### T-4: Normal input still flows after fix (anti-over-filter)

**Root cause**: N/A — this is a regression guard. The fix must not block legitimate user input.

**Flow**:
1. Start server on port 3303, create a bash session.
2. Open page in Playwright with WS frame interception.
3. Wait for terminal mount and subscribe.
4. Type the string `echo hello` followed by Enter using `page.keyboard.type()`.
5. Collect outgoing WS frames for 3 seconds.
6. Verify that `session:input` frames contain individual characters: `e`, `c`, `h`, `o`, ` `, `h`, `e`, `l`, `l`, `o`, `\r` (or `\n`).

**Pre-fix output**: The characters appear in `session:input` frames (PASS). This test passes on both pre-fix and post-fix code. Its purpose is to catch an over-zealous filter.

**Post-fix output**: Same — characters appear in `session:input` frames (PASS).

**Pass condition**: All expected characters (`e`, `c`, `h`, `o`, ` `, `h`, `e`, `l`, `l`, `o`) appear in `session:input` frame data. At least 10 `session:input` frames captured.

**Fail signal**: Fewer than 10 `session:input` frames, or expected characters are missing. This means the filter is blocking real input.

**Test type**: Playwright browser + WS protocol interception

**Port**: 3303

---

### T-5: Arrow keys, special keys, and DA1 regression guard

**Root cause**: N/A — regression guard ensuring CSI sequences for arrow keys (`\x1b[A` through `\x1b[D`), Home (`\x1b[H`), End (`\x1b[F`), and function keys are not blocked by the expanded filter. Also verifies that DA1 responses (`\x1b[?1;2c`) remain filtered after the regex rewrite, preventing a regression where the new regex accidentally breaks DA1 filtering.

**Flow**:
1. Start server on port 3304, create a bash session.
2. Open page in Playwright with WS frame interception.
3. Wait for terminal mount and subscribe.
4. Press arrow keys (Up, Down, Left, Right) and Home/End using `page.keyboard.press()`.
5. Collect outgoing WS frames for 3 seconds.
6. Verify that `session:input` frames contain the expected escape sequences: `\x1b[A`, `\x1b[B`, `\x1b[C`, `\x1b[D`, `\x1b[H` or `\x1bOH`, `\x1b[F` or `\x1bOF`.
7. **DA1 regression check**: Via raw WS client, send `session:input` with the shell command text `printf '\x1b[c'\n` to trigger a DA1 query in the terminal output. Wait 2 seconds, then verify that NO `session:input` frame contains data matching `/^\x1b\[\?\d+[;\d]*c$/` (the DA1 response pattern `\x1b[?1;2c`). This confirms the rewritten regex still filters DA1 responses.

**Pre-fix output**: Arrow key sequences flow through (PASS on both pre- and post-fix).

**Post-fix output**: Same. DA1 responses remain filtered (not leaked).

**Pass condition**: At least 4 `session:input` frames contain arrow-key escape sequences (`\x1b[A` through `\x1b[D`). Zero `session:input` frames contain DA1 response data matching `/^\x1b\[\?\d+[;\d]*c$/`.

**Fail signal**: Arrow key sequences are missing from `session:input` frames — the filter is eating them. Or: DA1 response frames appear in `session:input` — the regex rewrite broke DA1 filtering.

**Test type**: Playwright browser + WS protocol interception

**Port**: 3304

---

### T-6: Combined scenario — mount triggers zero spurious input

**Root cause**: `TerminalPane.js:127` — all three leaks combined. On every terminal mount, xterm auto-generates DA/DA2 responses and OSC color replies, sending 3+ spurious `session:input` messages before the user types anything.

**Flow**:
1. Start server on port 3305, create a bash session.
2. Via raw WS client, pre-load the session output with sequences that will trigger all three auto-responses by sending `session:input` with shell commands:
   - Send `printf '\x1b[>c'\n` (triggers DA2 reply when xterm processes the output)
   - Send `printf '\x1b]10;?\x07'\n` (triggers OSC fg color reply)
   - Send `printf '\x1b[?1006h'\n` (enables SGR mouse mode)
3. Open page in Playwright with WS frame interception attached **before** navigation.
4. Navigate to the app. Terminal mounts, subscribes, replays scrollback.
5. Move mouse over terminal (triggers mouse events if mode is active).
6. Wait 3 seconds. Do NOT type anything.
7. Count all `session:input` frames captured during the observation window.
8. **Liveness check**: After the 3-second observation window, type a single character (`x`) using `page.keyboard.type()` and wait 1 second. Verify that at least one `session:input` frame containing `x` appears. This proves the WebSocket pipeline is live and `xterm.onData` is firing. Only then assert that 0 frames were captured during the observation window (step 7).

**Pre-fix output**: 3 or more `session:input` frames appear during the observation window (DA2 response + OSC responses + mouse events). These are all spurious — the user typed nothing.

**Post-fix output**: Zero `session:input` frames during the observation window. The liveness check produces at least one frame containing `x`.

**Pass condition**: Exactly 0 `session:input` frames captured during the observation window (no user typing occurred), AND at least 1 `session:input` frame containing `x` captured during the liveness check.

**Fail signal**: Any `session:input` frame appears during the observation window without user action. Log the count and content of each leaked frame. OR: No `session:input` frame appears during the liveness check — the test harness is broken and results are invalid.

**Test type**: Playwright browser + WS protocol interception

**Port**: 3305

---

## Fix Design

**File**: `/home/claude-runner/apps/claude-web-app-v2/public/js/components/TerminalPane.js`
**Line**: 127

**Current code** (single line):
```javascript
        if (/^\x1b\[[\?]?\d+[;\d]*[cn]$/.test(data)) return;
```

**Replace with** (3 lines):
```javascript
        if (/^\x1b\[[\?>\d][;\d]*[cn]$/.test(data)) return;   // DA / DA2
        if (/^\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)$/.test(data)) return;  // OSC
        if (/^\x1b\[<[\d;]+[Mm]$/.test(data)) return;           // mouse events
```

**What each line does**:

1. **DA / DA2 filter**: Changed `[\?]?` to `[\?>\d]`. This now matches both DA1 responses (`\x1b[?1;2c`) and DA2 responses (`\x1b[>0;276;0c`). The `\d` alternative also covers bare digit starts like `\x1b[0n` (DSR OK response).

2. **OSC filter**: New pattern. Matches `\x1b]` followed by a number, semicolon, any non-BEL/non-ESC content, terminated by either BEL (`\x07`) or ST (`\x1b\\`). Catches all OSC responses including color queries (`\x1b]10;rgb:...\x07`) and title responses.

3. **Mouse event filter**: New pattern. Matches SGR mouse encoding `\x1b[<` followed by digits and semicolons, terminated by `M` (press) or `m` (release). These are generated by xterm when SGR mouse mode (`?1006`) is active.

**Regex edge cases for executor verification**: The executor should verify the DA/DA2 regex handles these sequences correctly:
- `\x1b[c]` — no digits, no prefix character between `[` and `c`. Should NOT match (and does not: `[\?>\d]` requires exactly one character). This is fine because bare `\x1b[c` is a DA1 *query*, not a *response*.
- `\x1b[?1;2c` — DA1 response. Should match: `?` hits `[\?>\d]`, `1;2` hits `[;\d]*`, `c` terminates.
- `\x1b[>0;276;0c` — DA2 response. Should match: `>` hits `[\?>\d]`, `0;276;0` hits `[;\d]*`, `c` terminates.
- `\x1b[0n` — DSR OK response. Should match: `0` hits `[\?>\d]`, nothing for `[;\d]*`, `n` terminates.

**Why this does not over-filter**:
- Arrow keys end in `A`-`D`, not `c`/`n`/`M`/`m` — DA filter ignores them.
- Function keys use `~` terminator — not matched.
- Bracketed paste uses `~` terminator — not matched.
- Normal characters have no `\x1b` prefix — not matched.
- Alt+key sequences are `\x1b` + single char (no `[` or `]`) — not matched.
