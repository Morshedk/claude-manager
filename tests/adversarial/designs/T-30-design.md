# T-30 Design: Tmux Session Refresh — Claude PID Unchanged

**Score:** 13  
**Port:** 3127  
**Type:** Server-level + Playwright browser test

---

## What We Are Testing

When a user clicks Refresh on a running tmux session, the **process inside the tmux pane must not be killed**. The tmux session `cm-<id>` should survive. The PTY detaches and re-attaches (see `TmuxSession.refresh()` — "Tmux alive path: detach + re-attach"), but the shell/process running inside tmux remains alive.

This is the key invariant that distinguishes tmux-mode from direct-mode: the tmux process is independent of the PTY attachment.

From source inspection of `TmuxSession.refresh()`:
```javascript
if (this._tmuxSessionAlive()) {
  // Tmux alive path: detach + re-attach
  if (this.pty) { this.pty.kill(); this.pty = null; }
  this._attachPty();
  this.emit('stateChange', ...);
  return;
}
```

**The PTY kills the `tmux attach-session` process, not the process inside tmux.** The PID inside the pane should be unchanged.

**Note:** Telegram is NOT needed. We use `command: 'bash'` (no Claude), which starts immediately. PID verification is done via `tmux send-keys` → shell echo → parse from terminal buffer.

---

## Infrastructure Setup

1. Verify `tmux -V` is available — throw if not
2. Create temp DATA_DIR with `mktemp -d /tmp/qa-T30-XXXXXX`
3. Seed `projects.json` as `{ "projects": [...], "scratchpad": [] }`
4. Launch server: `node server-with-crash-log.mjs` with `DATA_DIR`, `PORT=3127`, `CRASH_LOG`
5. Poll server ready

---

## Exact Actions and Timing

### Step 1: Create tmux bash session via WS
- Connect WS to `ws://127.0.0.1:3127`
- Send `session:create` with `{ type, projectId, name: 'T30-tmux', command: 'bash', mode: 'tmux' }`
- Wait for `session:created` → extract `sessionId`
- Extract `tmuxName` = `cm-<sessionId.slice(0,8)>`
- Wait for session running (via `session:stateChange` or `sessions:list`)

### Step 2: Get PID before refresh
- Send `session:subscribe` via WS to get PTY output
- Wait for `session:subscribed`
- Use `tmux send-keys` via execSync to inject a PID echo into the tmux pane:
  ```
  tmux send-keys -t "cm-<id>" "echo PIDMARKER=$$" Enter
  ```
- Wait up to 5s for the string `PIDMARKER=` to appear in WS output buffer
- Parse PID: extract digits after `PIDMARKER=`
- Throw if PID not found within 5s (precondition failure)
- Store as `pidBefore`

### Step 3: Click Refresh in browser (or via WS)
- Open Chromium browser and navigate to `http://127.0.0.1:3127`
- Select the project, find the session card, click "Refresh" button on the stopped/running session
- OR: send `session:refresh` via WS (simpler, avoids UI complexity)
- Wait for `session:refreshed` WS response (or session:stateChange back to running)
- Wait 1s for PTY re-attach to complete

**Preferred approach:** Use WS `session:refresh` directly, then verify via browser that it shows running. This avoids Playwright complexity for the refresh action itself.

### Step 4: Re-subscribe after refresh
- After `session:refreshed`, re-subscribe via WS (the old viewer may have been dropped on PTY re-attach)
- Or use the same WS that auto-subscribes

### Step 5: Get PID after refresh
- Send `tmux send-keys -t "cm-<id>" "echo PIDMARKER2=$$" Enter`
- Wait up to 5s for `PIDMARKER2=` in WS output buffer
- Parse `pidAfter`
- Throw if PID not found (precondition failure)

### Step 6: Verify tmuxName unchanged
- Run `tmux has-session -t "cm-<id>"` via execSync
- Assert it returns 0 (session alive)

### Step 7: Compare PIDs
- Assert `pidBefore === pidAfter`
- **PASS:** Same PID — the process inside tmux was not killed by refresh
- **FAIL:** Different PID — refresh killed and restarted the process

---

## Pass/Fail Criteria

| Outcome | Condition |
|---------|-----------|
| GENUINE PASS | `pidBefore === pidAfter`, tmux session alive after refresh |
| GENUINE FAIL | `pidBefore !== pidAfter` (process killed and respawned) |
| INCONCLUSIVE | Could not capture PID before or after (precondition failure) |

---

## False-PASS Risks

1. **`$$` in the tmux pane vs the shell spawning tmux-send-keys:** `$$` is a shell variable expanded by the shell inside the tmux pane, NOT by the shell running `tmux send-keys`. This is correct — we want the PID of the shell running inside tmux.

2. **PTY output buffering:** The WS subscriber receives PTY output. After re-attach, the PTY replay may include the old PIDMARKER output. We use `PIDMARKER2=` for the post-refresh check to avoid matching old buffer.

3. **Bash `$$` is always the same shell PID within a session:** Correct. If bash restarts, `$$` changes. If the tmux pane is the same bash process, `$$` is identical.

4. **tmux session renamed on refresh:** Source code shows `tmuxName = cm-<id.slice(0,8)>`. The refresh keeps the same tmuxName (alive path doesn't kill the tmux session). Check: `tmux has-session -t cm-<id>` after refresh.

5. **Race between PIDMARKER echo and PTY buffer delivery:** Allow 5s. If the terminal is active and shell is running, this is ample time.

6. **WS message timing:** After `session:refresh`, the server sends `session:refreshed` to the requester. The refresh also broadcasts `session:subscribed` to all subscribers. Be careful not to confuse these.

---

## Implementation Notes for Executor

- Use `execSync` to run `tmux send-keys` for PID injection
- Parse PID with regex: `/PIDMARKER=(\d+)/`
- Collect WS output into a string buffer; parse after each message
- The Playwright browser component is optional: can verify UI still shows running state after refresh, but the core assertion is server-side PID comparison
- Keep browser simple: navigate, select project, observe session card shows "running" after refresh
- Hard `throw new Error()` if tmux is unavailable at test start
