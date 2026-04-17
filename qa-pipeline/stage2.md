# Stage 2 — Failure Confirmed

Test output (actual stdout):
```
[T] Step 3: Waiting for sentinel in terminal...
[T] ✓ Sentinel visible before switch-away
[T] Step 4: Navigate away to Session B...
[T] Navigated to Session B
[T] Step 5: Navigate back to Session A...
[T] Step 6: Asserting sentinel visible after switch-back...
[T] Terminal text after return (first 300): " 



"
[T] ✗ FAIL — Terminal blank after switch-back. Got: " "

=== RESULT: FAIL ===
Reason: Terminal blank after switch-back.
```

Confirmed: the bug is present on current (broken) code.
