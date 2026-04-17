# Stage 1 — Test Design

## Test description
Playwright browser test. Creates a tmux session with a fast-output bash command so the
terminal fills with a known sentinel string immediately. Navigates away to a second session.
Navigates back. Asserts the sentinel string is visible in the terminal.

## Mapping to Then clause
Then clause: "The terminal shows the previous output — the user sees the last lines of
content, not a blank screen"

Test assertion: After navigating back, `page.locator('.xterm-rows').textContent()` must
contain the sentinel string "SWITCH_BACK_SENTINEL". This is directly observable content
inside the xterm terminal element — exactly what the user sees.

## Why this is NOT a proxy metric
- The test uses a real browser (Playwright) to navigate, not WS client bypass
- The assertion reads visible text from the rendered xterm terminal, not WS byte counts,
  DOM attributes, or session status fields
- If scrollback replay is broken, the xterm canvas shows blank — `textContent()` on the
  xterm rows will be empty or contain only cursor characters
- The test sends no input to the session — it only observes what is already rendered

## What the FAIL output looks like (pre-fix)
Expected: xterm-rows textContent to include "SWITCH_BACK_SENTINEL"
Received: "" (empty string — blank terminal after switch-back)

The xterm.reset() in handleSubscribed clears the terminal. With no scrollback returned
by the server, nothing is written back. The terminal stays blank.

## What the PASS output looks like (post-fix)
Expected: xterm-rows textContent to include "SWITCH_BACK_SENTINEL"
Received: "...SWITCH_BACK_SENTINEL..." — the buffered preview content is sent as
session:output after session:subscribed, filling the terminal.

## This test will FAIL before the fix because:
TmuxSession.getScrollback() did not exist, so SessionManager.subscribe() returned ''.
sessionHandlers.subscribe() never sends the scrollback session:output. The client's
xterm.reset() clears the terminal and nothing is written back.

## This test will PASS after the fix because:
TmuxSession._previewBuffer is populated by onData during the first subscription.
TmuxSession.getScrollback() returns that buffer. SessionManager.subscribe() returns it.
sessionHandlers.subscribe() sends it as session:output after session:subscribed.
TerminalPane writes it to xterm. The sentinel string is visible.
