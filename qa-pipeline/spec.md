# QA Spec

## Bug
Session events log shows garbled/unreadable text in the SessionLogPane. User reports "the sessionlog still looks messy" even after a previous fix to handle cursor-forward (ESC[NC) sequences.

## Acceptance Criteria
Given: a tmux session is running Claude Code and has been captured for at least one 20s tick (producing output to the .raw file)
When:  the user opens the Events pane in the session overlay
Then:  the log lines are readable English text — tool names, file paths, and command output are legible with correct spacing; no raw escape codes, control characters, or mangled character sequences are visible

## Specific Instance
Session: b6237bba-12e5-4811-8e60-aa1d541b2a07
Reproducible on other instances: yes (raw tmux output contains same patterns)

## Preliminary Investigation

### Code Path
1. **Raw capture** (`startCapture`): tmux pipe-pane writes raw bytes to .raw file (contains terminal escape codes, CRLF/CR line endings)
2. **Processing** (`_processSession`): Reads new bytes from .raw, strips ANSI with `stripAnsi()`, appends to .log file
3. **Serving** (`tailLog`): Reads .log file, splits on `\n` only, returns array of lines
4. **Rendering** (SessionLogPane): Fetches lines every 3s, renders each as `<div>` with `white-space:pre-wrap`

### Root Cause Analysis

**File: lib/utils/stripAnsi.js (line 15)**
- Correctly removes `\r` via `.replace(/\r/g, '')` 
- Does NOT replace `\r` with `\n`, just deletes it
- Problem: When tmux output uses `\r` alone (CR only, not CRLF) to move cursor to start of line, removing it without replacement concatenates lines

**File: lib/sessionlog/SessionLogManager.js (lines 88, 92)**
- `_processSession` calls `stripAnsi(content)` on bytes read from .raw
- Appends stripped result directly to .log: `appendFileSync(logPath, "\n--- timestamp ---\n" + stripped)`
- No re-delimiting after stripping

**File data/sessionlog/b6237bba-12e5-4811-8e60-aa1d541b2a07.raw**
- Contains escape sequences for cursor movement: `\x1b[2C`, `\x1b[3A`, `\x1b[2D`, `\x1b[3B` (cursor right, up, left, down)
- Contains UTF-8 sequences: `e2 94 80` (…), `e2 81 a4` (−), etc.
- Line endings are `\r\r\n` (double CR + LF) and bare `\r` (CR only)
- File type: "Unicode text, UTF-8 text, with very long lines, with CRLF, CR line terminators, with escape sequences"

**File data/sessionlog/b6237bba-12e5-4811-8e60-aa1d541b2a07.log**
- Contains `\r\r\n` sequences (example at byte offset 0x340: `\r\r\n`)
- Contains non-ASCII bytes that are UTF-8 multi-byte sequences
- When inspected with `od -c`, shows sequences like: `342 226 220` (UTF-8 for box-drawing chars)
- Bare `\r` characters have been removed by stripAnsi, but `\r\r\n` becomes `\r\n` (one CR + LF)
- File type: "Unicode text, UTF-8 text, with CRLF, CR, LF line terminators"

**Verification via test**
```javascript
stripAnsi("line1\r\rline2\r\r\n") → "line1line2\n"
// When split('\n'): ["line1line2", ""]
// Expected: ["line1", "line2", ""]
```

### Specific Evidence
1. Raw file hex dump shows: `1b5b3341` (ESC[3A cursor up), `1b5b3342` (ESC[3B cursor down), `0d0d0a` (CR CR LF)
2. Log file octal dump shows: `\r  \r  \n` (CR CR LF) at line boundaries
3. Session Pane display shows: concatenated text like "  P  c" and "r  e" on separate lines when they should all be on one logical line with proper spacing

### Why Previous Fix Was Incomplete
- The prior fix in stripAnsi.js (line 10) converts `\x1b[NC` (cursor forward) to spaces: `.replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(...))`
- This only handles cursor-RIGHT sequences
- But cursor-UP (`\x1b[NA`), cursor-DOWN, cursor-LEFT sequences are still stripped completely (line 11) without any replacement
- The core problem: `\r` (carriage return) is used by the terminal to reposition for in-place updates (like animated spinners, progress bars, REPL prompt rewrites)
- When bare `\r` is simply deleted without context of what it means, multiple output lines merge into one

### Impact on User
- Lines in log appear as fragments: "P", "r", "o", spread across multiple div elements with extra blank lines
- Characters that should form words or paths are separated
- Command output and tool invocation details become unreadable
- Makes the session log feature unusable for debugging/reference

## Confirmed
true
