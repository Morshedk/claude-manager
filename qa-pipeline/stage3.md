# Stage 3 — Fix Confirmed

## Root Cause
lib/sessions/TmuxSession.js — no `_previewBuffer`, no `getScrollback()`.

SessionManager.subscribe() (line 285) dispatches: `session.getScrollback ? session.getScrollback() : ''`
TmuxSession had no `getScrollback`, so always returned ''. Second subscriber got empty scrollback,
xterm.reset() cleared the terminal, nothing was written back.

## Fix
Four changes to TmuxSession.js:
1. Constructor: `this._previewBuffer = meta.lastScrollback || ''` — restores buffer across restarts
2. `_wirePty.onData`: appends to `_previewBuffer` (8 KB ring buffer) — same pattern as DirectSession
3. `getScrollback()`: new method returning the buffer
4. `toJSON()`: `return { ...this.meta, lastScrollback: this._previewBuffer }` — persists to disk

## Evidence
```
[T] Step 3: Waiting for sentinel in terminal...
[T] ✓ Sentinel visible before switch-away
[T] Step 4: Navigate away to Session B...
[T] Navigated to Session B
[T] Step 5: Navigate back to Session A...
[T] Step 6: Asserting sentinel visible after switch-back...
[T] Terminal text after return (first 300): "        bash [GNU long option] [option] script-file ...
GNU long options:
        --debug
..."
[T] ✓ PASS — sentinel visible after switch-back

=== RESULT: PASS ===
```

## Causal Audit
Fix touches TmuxSession.js — the file spec.md's Preliminary Investigation identified as the root cause.
Yes: fix is on the exact code path identified in spec.
