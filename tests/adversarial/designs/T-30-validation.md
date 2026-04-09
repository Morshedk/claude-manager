# T-30 Validation: Tmux Session Refresh — PID Unchanged

**Validator role:** Adversarially review design + execution. Find false PASSes.

---

## Three Questions

### 1. Did the test pass?

**YES — GENUINE PASS** (after 1 fix iteration, using 2 of 3 allowed attempts).

Final result: `PID before refresh: 3054280` == `PID after refresh: 3054280`. The tmux pane process was NOT killed by the refresh operation.

### 2. Was the design correct?

**YES, with one design gap that the executor found and fixed.**

The design was correct in:
- Using `tmux display-message` to get pane PID (this was the recommended approach)
- Using `session:refresh` WS message to trigger refresh
- Collecting both `session:refreshed` and `session:subscribed` messages
- Verifying tmux session alive before AND after refresh

**Design gap that caused Attempt 1 to fail incorrectly:** The design stated "Method: `tmux send-keys -t cm-<id> "echo PID=\$\$" Enter` then parse output from terminal buffer." This approach is **incorrect**. The `$$` shell variable is expanded by `execSync`'s `/bin/sh -c` subprocess — a new process each invocation — NOT by the bash inside the tmux pane. This would always give a false-FAIL since two different `sh -c` processes have different PIDs.

The executor's actual design used `tmux display-message -p '#{pane_pid}'` which was the correct approach (also listed in the design as alternative). The initial test code incorrectly used `$$` first.

**Fix applied:** The executor discovered the `$$` expansion bug, replaced with `tmux display-message -t <name> -p '#{pane_pid}'`. This gives the PID of the process running in the tmux pane, queried directly from the tmux server — no shell expansion.

### 3. Was the execution faithful?

**YES** (with one justifiable deviation: fixing the `$$` bug in the approach).

The executor:
1. Verified tmux availability with `tmux -V` (hard throw as required)
2. Created tmux bash session via WS with `mode: 'tmux'`
3. Confirmed tmux session existence with `tmux has-session`
4. Got PID before refresh via `tmux display-message`
5. Sent `session:refresh` and waited for both `session:refreshed` AND `session:subscribed`
6. Verified tmux session alive after refresh
7. Got PID after refresh via `tmux display-message`
8. Asserted PIDs identical
9. Verified browser shows running state

---

## Adversarial Scrutiny

**Could this be a vacuous pass (PID matched trivially)?**

No. The PID comes from `tmux display-message` which queries the live tmux server for the foreground process PID in the pane. This is the bash shell running inside tmux. If the shell had been killed and replaced by a new process (which would happen if tmux session was recreated or bash restarted), the PID would differ. The PID being identical proves the same bash process survived the refresh.

**Could `tmux display-message` return the same PID for a different reason?**

Only if the OS reused the same PID for a new process. This requires: (1) old process died, (2) OS recycled the PID number for a new process, (3) both events happened between `display-message` calls (<1 second apart). Astronomically unlikely.

**Is the pane_pid the right thing to check?**

`#{pane_pid}` is the PID of the outermost process in the pane — in this case, `bash -c "bash; exec bash"`. The inner bash (interactive) has a child PID. If the outer bash were killed, the inner bash would also die. If refresh killed the tmux session and respawned it, the outer bash PID would change. Checking `pane_pid` is correct and sufficient.

**Was there a real potential bug to find?**

Yes. The original test (Attempt 1) found what looked like a PID change. The validator's first impulse was to flag this as a genuine app bug. Careful analysis proved it was a test bug (`$$` expansion). This is the correct adversarial posture: investigate WHY the PID changed before concluding either way.

The actual app behavior is CORRECT: `TmuxSession.refresh()` on the "alive" path does `pty.kill()` (kills the `tmux attach-session` PTY process) and `_attachPty()` (creates a new PTY attachment). The bash inside tmux is unaffected.

---

## Verdict

**GENUINE PASS.** The tmux session refresh correctly preserves the process inside the pane. `pane_pid` is identical before and after refresh (3054280 = 3054280). The tmux session name `cm-6bade30d` survived unchanged. Browser confirms session still shows running state.

**Test quality note:** The initial `$$` bug in Attempt 1 was correctly identified and fixed within the allowed 3 attempts. The design's recommendation of `tmux display-message` was the right approach; the executor initially implemented it incorrectly with `$$` instead. The fix is clean and the final test is correct.

**Score: 13. Passes.**
