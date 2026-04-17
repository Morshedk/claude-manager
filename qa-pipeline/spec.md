# QA Spec

## Bug
Switching away from a tmux session and back shows a blank terminal instead of the previous content.

## Acceptance Criteria
Given: A running tmux session has been opened in the browser (PTY attached, output visible in terminal)
When:  The user navigates to a different session and then navigates back to the original session
Then:  The terminal shows the previous output — the user sees the last lines of content, not a blank screen

## Specific Instance
Session: any tmux-mode session
Reproducible on other instance: yes — all prod sessions are mode:tmux; second subscribe always returned empty scrollback

## Preliminary Investigation

### Root cause
`TmuxSession` (lib/sessions/TmuxSession.js) had no `_previewBuffer` and no `getScrollback()` method.

`SessionManager.subscribe()` (lib/sessions/SessionManager.js:285) returns scrollback via:
  `return session.getScrollback ? session.getScrollback() : ''`

For TmuxSession, `getScrollback` was undefined → always returned `''`.

`TmuxSession.addViewer()` (line 153) only calls `_attachPty()` when `!this.pty`. On the
first subscribe, PTY attaches and tmux replays its scrollback to the live stream. On the
second subscribe (switch-back), `this.pty` already exists so no re-attach occurs — meaning
no tmux replay and no buffered content to return. Client receives `session:subscribed` with
empty scrollback, calls `xterm.reset()`, and sees a blank terminal.

### Files examined
- lib/sessions/TmuxSession.js — missing _previewBuffer, getScrollback(), lastScrollback in toJSON()
- lib/sessions/SessionManager.js:285 — getScrollback dispatch
- lib/ws/handlers/sessionHandlers.js:99-120 — subscribe handler, sends scrollback to client
- public/js/components/TerminalPane.js:182-201 — client: reset on subscribed, write on output

## Confirmed
true
