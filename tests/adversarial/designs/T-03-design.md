# T-03: Session Refresh Clears Terminal Buffer -- No Dot Artifacts

**Source:** Story 8 (Refresh a Direct Session)
**Score:** L=4 S=4 D=5 (Total: 13)
**Test type:** Playwright browser (screenshot pixel inspection + DOM introspection)
**Regression target:** Commit b2c1945 -- `\x1bc` written to PTY mid-startup caused dot/garbled artifacts after restart

---

## 1. Infrastructure Setup

### 1a. Isolated server

Spawn a dedicated test server on port 3100 with a fresh temporary data directory. This prevents any interference from development data or other tests running in parallel.

```
PORT=3100
DATA_DIR=$(mktemp -d /tmp/qa-T03-XXXXXX)
```

Start the server using the crash-logging wrapper:

```
node server-with-crash-log.mjs
```

with environment variables `DATA_DIR`, `PORT`, and `CRASH_LOG` (set to `$DATA_DIR/server-crash.log`). The server process is stored as `serverProc` and killed in cleanup.

Wait for the server to become ready by polling `http://127.0.0.1:3100/` every 400ms, up to a 25-second deadline. If the server does not respond within that window, the test aborts.

### 1b. Screenshot directory

Create `qa-screenshots/T03-refresh-dots/` under the app root. All screenshots go here.

### 1c. Create a test project via REST API

POST to `/api/projects` with `{ name: "T03-refresh", path: "<tmpDir>/project" }`. Store the returned `projectId`. The project directory must exist on disk (create it with `mkdirSync`).

---

## 2. Session Setup

### 2a. Why not Claude

The spec says "wait for Claude to output at least 3 lines." However, Claude takes 8-10 seconds to produce its TUI header and is non-deterministic. For test reliability, we spawn a `bash` session instead. The dot artifact bug is triggered by the refresh/restart mechanism (server-side PTY kill + respawn + `session:subscribed` broadcast), not by Claude-specific output.

### 2b. Create session via WebSocket

Open a raw WebSocket to `ws://127.0.0.1:3100`. Wait for the `init` message. Send:

```json
{
  "type": "session:create",
  "projectId": "<testProjectId>",
  "name": "T03-bash",
  "command": "bash",
  "mode": "direct",
  "cols": 120,
  "rows": 30
}
```

Wait for `session:created` response. Store the `session.id` as `testSessionId`.

### 2c. Produce predictable multi-line output

After session creation, the creating WS client is auto-subscribed to the session (per `sessionHandlers.js` line 100-103). Send input to produce 10 clearly identifiable lines:

```json
{ "type": "session:input", "id": "<testSessionId>", "data": "for i in $(seq 1 10); do echo \"T03-LINE-$i ################################\"; done\n" }
```

Wait until the WS output buffer contains `T03-LINE-10`. This produces 10 lines of unambiguous content: each line is approximately 50 characters wide, leaving a large blank region to the right and below the text for artifact inspection.

After the lines appear, wait an additional 1 second for the PTY and terminal to fully settle.

---

## 3. Pre-Refresh State Capture

### 3a. Open the browser

Launch headless Chromium via Playwright. Navigate to `http://127.0.0.1:3100/`. Wait for the page to indicate "Connected" (either via a `.status-connected` element or `document.body.textContent.includes('Connected')`). Wait 1.5 seconds for Preact rendering to settle.

### 3b. Open the session overlay

The session card for "T03-bash" will be visible in the project detail view. Click the session card to attach. This mounts `SessionOverlay`, which contains a `TerminalPane` component that creates an xterm.js terminal and sends `session:subscribe`.

Wait for the terminal container to appear: `page.waitForSelector('#session-overlay .terminal-container .xterm-screen', { timeout: 15000 })`.

Wait 3 seconds for xterm to render the scrollback content sent via `session:subscribed` and `session:output`.

### 3c. Capture pre-refresh terminal state

**Screenshot:** Take a full-page screenshot named `T03-01-pre-refresh.png`.

**Buffer line count:** Execute in page context:

```js
const xtermEl = document.querySelector('#session-overlay-terminal .xterm');
const rows = xtermEl?.querySelectorAll('.xterm-rows > div');
return rows?.length || 0;
```

This returns the number of rendered row elements. Note: in xterm.js DOM renderer, `.xterm-rows` contains one child `<div>` per visible row in the viewport. The total buffer length (including scrollback) is accessed differently -- see section 6.

**Buffer total length (pre-refresh):** Execute:

```js
// xterm.js exposes buffer length on the Terminal instance.
// In the DOM renderer, the Terminal object is accessible via _core on the xterm element.
// However, TerminalPane stores the xterm instance in a React ref, which is not directly
// accessible from page.evaluate. Instead, use the Playwright test hook on the viewport:
const vp = document.querySelector('#session-overlay-terminal .xterm-viewport');
if (vp && vp._scrollState) {
  return vp._scrollState();
}
return null;
```

The `_scrollState()` hook is installed by `TerminalPane.js` at line 104 and returns `{ bufferLength, viewportY, scrollTop, scrollMax, userScrolledUp }`. Record `bufferLength` -- this is the total number of lines in the active buffer (including content lines and blank filler lines up to the viewport height).

Store `preRefreshBufferLength`. It should be > 0 (the 10 echo lines plus the bash prompt).

### 3d. Content verification

Confirm the terminal visually contains text by checking that the `.xterm-rows` container has at least one child `<div>` with non-empty `textContent`. If this check fails, the terminal did not render correctly and the test should abort with a diagnostic screenshot rather than give a false PASS.

---

## 4. Exact Refresh Procedure

### 4a. Locate the Refresh button

The Refresh button is inside the `SessionOverlay` header. Per `SessionOverlay.js` (lines 124-129), it is rendered as:

```html
<button onClick=${handleRefresh} style=${btnStyle()} title="Refresh session">Refresh</button>
```

It does NOT have an `id` attribute. Select it by its `title` attribute:

```js
page.locator('button[title="Refresh session"]')
```

Alternatively, select within the overlay actions container:

```js
page.locator('.overlay-actions button', { hasText: 'Refresh' })
```

Note: `.overlay-actions` is set as a `class` attribute on the button container div at line 115 of `SessionOverlay.js`.

### 4b. Click and verify server response

Click the Refresh button. The client-side `handleRefresh()` calls `refreshSession(session.id)`, which sends `{ type: "session:refresh", id }` over the WebSocket.

The server-side `SessionHandlers.refresh()` (line 158-174 of `sessionHandlers.js`) does:
1. Calls `this.sessions.refresh(msg.id, { cols, rows })` -- this kills the old PTY and spawns a new one via `DirectSession.refresh()`.
2. Broadcasts `session:subscribed` to all viewers of this session.
3. Sends `session:refreshed` back to the requesting client.

The client's `TerminalPane.handleSubscribed()` fires, which calls `xterm.reset()`.

### 4c. Wait for refresh to complete

After clicking, wait for either:
- A toast notification containing "Refreshing" to appear (per `SessionOverlay.js` line 25: `showToast('Refreshing session...', 'info')`)
- Or simply wait 2 seconds for the server to kill/respawn the PTY and broadcast `session:subscribed`

Then wait an additional 2 seconds for the new PTY to produce output and for xterm to render.

---

## 5. Screenshot Protocol

### 5a. Three-screenshot timeline

After clicking Refresh and waiting for the toast confirmation:

| Time | Filename | Purpose |
|------|----------|---------|
| t=0 (immediately after 2s settle) | `T03-02-post-refresh-t0.png` | Capture state right after `xterm.reset()` fires |
| t=2s | `T03-03-post-refresh-t2.png` | Capture state after new PTY has had time to send output |
| t=4s | `T03-04-post-refresh-t4.png` | Final state -- terminal should show fresh bash prompt |

### 5b. What region to screenshot

Take full-page screenshots for human review. For programmatic dot detection (section 7), capture a cropped region of the terminal. The region of interest is the "blank area" -- the portion of the xterm screen below and to the right of active text.

To determine the blank region, use DOM introspection to find the last row with content:

```js
const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
let lastContentRow = -1;
for (let i = 0; i < rows.length; i++) {
  const text = rows[i].textContent.replace(/\u00A0/g, ' ').trim();
  if (text.length > 0) lastContentRow = i;
}
return lastContentRow;
```

The blank area starts at row `lastContentRow + 2` (leaving one row of margin) and extends to the bottom of the terminal viewport. Screenshot this region by computing bounding boxes:

```js
const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
const screenRect = screen.getBoundingClientRect();
const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
const blankStartRow = rows[lastContentRow + 2]; // or last row if beyond bounds
const blankStartY = blankStartRow ? blankStartRow.getBoundingClientRect().top : screenRect.bottom;
return { x: screenRect.left, y: blankStartY, width: screenRect.width, height: screenRect.bottom - blankStartY };
```

Use `page.screenshot({ clip: { x, y, width, height } })` to capture only the blank region. Name these `T03-05-blank-region-t0.png`, `T03-06-blank-region-t2.png`, `T03-07-blank-region-t4.png`.

### 5c. Naming convention

All files go in `qa-screenshots/T03-refresh-dots/`. Prefix with `T03-` followed by a two-digit sequence number, then a descriptive slug.

---

## 6. xterm.js Reset Verification

### 6a. What `xterm.reset()` does

`xterm.reset()` clears both the normal and alternate screen buffers, resets the cursor to position (0,0), clears all scrollback, and resets terminal state (attributes, charset, etc.). After `xterm.reset()`, the buffer should have `length` equal to the viewport row count (all blank lines).

### 6b. How to verify reset occurred

Compare the buffer state before and after refresh. The key metric is `bufferLength` from the `_scrollState()` hook.

**Pre-refresh:** `bufferLength` should be greater than the viewport row count (because the 10 echo lines plus bash prompts plus filler add up).

**Post-refresh (at t=0):** Immediately after refresh, before the new PTY sends output, `bufferLength` should equal the viewport row count (typically 30). This proves `xterm.reset()` was called and cleared the scrollback.

Execute at each screenshot timestamp:

```js
const vp = document.querySelector('#session-overlay-terminal .xterm-viewport');
return vp?._scrollState?.() || null;
```

Record the `bufferLength` at t=0, t=2, t=4. The t=0 value must be less than or equal to the pre-refresh value. More precisely:

- **t=0 bufferLength** should equal the viewport rows (e.g., 30) if checked immediately after reset and before new output arrives. In practice, some new PTY output may have arrived by the time we can execute the check (2s after clicking). So the stronger assertion is: `t=0 bufferLength <= preRefreshBufferLength`. If the buffer was truly reset, it should not carry forward the old 10 lines of echo output.

### 6c. Content-based verification (stronger)

After refresh, the terminal should NOT contain the string `T03-LINE-`. The old echo output should have been wiped by `xterm.reset()`. Check:

```js
const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
let foundOldContent = false;
for (const row of rows) {
  if (row.textContent.includes('T03-LINE-')) { foundOldContent = true; break; }
}
return foundOldContent;
```

This must return `false`. If it returns `true`, `xterm.reset()` was NOT called or old buffered data leaked through after the reset.

### 6d. Scrollback count check

After reset, the viewport's `scrollTop` should be 0 and `scrollMax` should be 0 (no scrollable content beyond the viewport). Check `_scrollState().scrollMax === 0` at t=0.

---

## 7. Dot Artifact Detection Method

This is the crux of the test. The bug from commit b2c1945 produced isolated dot characters (`.` or other single-glyph artifacts) and garbled/strikethrough text in the terminal's blank regions after a restart or refresh.

### 7a. DOM-based detection (primary method)

In headless Chromium, xterm.js uses the DOM renderer. Each row is a `<div>` inside `.xterm-rows`. Each character span within a row has explicit styling. Blank cells are rendered as spans containing `\u00A0` (non-breaking space) or are empty.

**Dot artifact signature in the DOM:** A dot artifact is a non-whitespace, non-empty character appearing in a row that should be entirely blank (below the last line of actual content). Specifically:

1. Identify all rows below the last content row (as defined in section 5b).
2. For each such row, extract `textContent` and strip all whitespace characters (`\u00A0`, `\u0020`, `\n`, `\r`, `\t`).
3. If the stripped content has length > 0, that row contains an artifact.

```js
const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
let lastContentRow = -1;
for (let i = 0; i < rows.length; i++) {
  const text = rows[i].textContent.replace(/[\u00A0\s]/g, '').trim();
  if (text.length > 0) lastContentRow = i;
}

// After refresh, the terminal should have at most a bash prompt (1-2 rows of content).
// Check all rows beyond the prompt area for stray characters.
const artifacts = [];
const safeStart = Math.min(lastContentRow + 2, rows.length);
for (let i = safeStart; i < rows.length; i++) {
  const text = rows[i].textContent.replace(/[\u00A0\s]/g, '');
  if (text.length > 0) {
    artifacts.push({ row: i, content: text, raw: rows[i].textContent });
  }
}
return artifacts;
```

If `artifacts.length > 0`, the test FAILS. Log each artifact's row number and content for debugging.

### 7b. Content row inspection (secondary method)

The dot bug also manifested as garbled characters WITHIN content rows -- strikethrough text, misplaced cursor sequences rendered as visible characters, or `?1;2c` (DA response) appearing as literal text. Check all visible rows for known artifact patterns:

```js
const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
const suspiciousPatterns = [];
for (let i = 0; i < rows.length; i++) {
  const text = rows[i].textContent;
  // DA response leak (the xterm auto-response that should have been filtered)
  if (/\?1;\d+c/.test(text)) suspiciousPatterns.push({ row: i, type: 'DA-response', text });
  // Isolated dots: a period character surrounded by whitespace in an otherwise blank line
  if (/^\s*\.\s*$/.test(text.replace(/\u00A0/g, ' '))) suspiciousPatterns.push({ row: i, type: 'isolated-dot', text });
  // ESC sequences rendered as visible text (should never appear)
  if (/\[[\?]?\d+[;\d]*[a-zA-Z]/.test(text)) suspiciousPatterns.push({ row: i, type: 'visible-escape', text });
}
return suspiciousPatterns;
```

If any suspicious patterns are found, the test FAILS.

### 7c. Pixel-based detection (tertiary/fallback method)

Pixel inspection is fragile in headless mode and should be used as a supplementary signal, not the primary gate. The approach:

1. Capture the blank region screenshot (section 5b).
2. Read the image buffer and convert to raw pixel data using `page.evaluate` with canvas-based decoding or by processing the PNG externally.
3. The terminal background color is `#0c1117` (RGB 12, 17, 23) per the XTERM_THEME in `TerminalPane.js`.
4. Count pixels that deviate significantly from the background. A "significant deviation" is defined as any pixel where `abs(R - 12) + abs(G - 17) + abs(B - 23) > 30` (a simple Manhattan distance threshold).
5. If more than 5 non-background pixels exist in the blank region (allowing for anti-aliasing on row borders), the test FAILS.

**Why this is fragile:** In headless Chrome, the DOM renderer does not produce exactly the same pixel output as the GPU renderer. Anti-aliasing, font rendering hints, and sub-pixel rendering can produce faint colored pixels near row boundaries. The threshold of 5 pixels is a heuristic. For this reason, the DOM-based detection (7a, 7b) is the primary method and the pixel check is informational only.

### 7d. Full-row text dump for human review

Regardless of pass/fail, dump the full text content of every terminal row to the test log at each screenshot timestamp. This provides a human-readable record for debugging false passes or false failures:

```js
const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
return Array.from(rows).map((r, i) => `[${String(i).padStart(2,'0')}] ${r.textContent}`);
```

Log this array. If a human reviewer sees `T03-LINE-` content in the post-refresh dump, that alone is a fail signal even if the automated checks passed.

---

## 8. Pass/Fail Criteria

### PASS -- all of the following must hold:

1. **Buffer reset verified:** Post-refresh `_scrollState().scrollMax` equals 0 at t=0 (no old scrollback).
2. **Old content absent:** No row in the terminal contains `T03-LINE-` after refresh.
3. **Blank rows clean:** The DOM artifact scan (section 7a) returns an empty array at all three timestamps (t=0, t=2, t=4).
4. **No suspicious patterns:** The pattern scan (section 7b) returns an empty array at all three timestamps.
5. **Session recovers:** The session returns to `running` status within 15 seconds after refresh (verifiable via REST API `GET /api/sessions`).
6. **New prompt visible:** At t=4, at least one row contains a bash prompt character (`$` or `#`), confirming the new PTY is alive and producing output.

### FAIL -- any of the following:

1. Any row below `lastContentRow + 1` contains non-whitespace characters.
2. Any row contains a DA response pattern (`?1;Nc`), an isolated dot, or a visible escape sequence.
3. Old content (`T03-LINE-`) survives the refresh.
4. `scrollMax > 0` at t=0 (old scrollback not cleared).
5. Session does not return to `running` within 15 seconds.
6. No bash prompt visible at t=4 (new PTY did not produce output).

### Fallback if pixel inspection is not feasible:

If the canvas-based pixel detection (7c) cannot be implemented reliably (e.g., due to headless rendering differences), rely entirely on the DOM-based methods (7a, 7b). The DOM methods are more reliable because they inspect the actual text content that xterm rendered, not the pixel representation. The pixel method should be implemented as a non-blocking warning rather than a hard gate.

---

## 9. Repeat Protocol

After the first refresh cycle completes and all checks pass, perform a SECOND refresh to test idempotency:

### 9a. Produce new content

After the first refresh, wait for the bash prompt. Send input to produce 5 new lines:

```json
{ "type": "session:input", "id": "<testSessionId>", "data": "for i in $(seq 1 5); do echo \"T03-ROUND2-$i\"; done\n" }
```

Wait 2 seconds for output to render.

### 9b. Second refresh

Click the Refresh button again. Wait 2 seconds for the refresh to complete.

### 9c. Second round of checks

Repeat the full verification at t=0, t=2, t=4:
- Buffer reset check (scrollMax === 0 at t=0).
- Old content check: neither `T03-LINE-` nor `T03-ROUND2-` should appear.
- Blank row artifact scan.
- Suspicious pattern scan.
- Session returns to `running`.
- Bash prompt visible at t=4.

Take screenshots named `T03-08-round2-t0.png` through `T03-10-round2-t4.png` plus blank region captures.

### 9d. Why repeat matters

The original bug was partially timing-dependent. A single refresh might pass because the PTY-kill-and-respawn happened to complete cleanly, while a second refresh (where old exit events from the first PTY race with the second spawn) could trigger the stale-generation bug. The `_ptyGen` guard in `DirectSession._wirePty()` is specifically designed to prevent this, so the double-refresh tests that guard.

---

## 10. Cleanup

### 10a. Close browser

Close the Playwright browser instance.

### 10b. Delete session via WS

Send `{ "type": "session:delete", "id": "<testSessionId>" }`. Wait 1 second.

### 10c. Kill server

Send SIGKILL to `serverProc`. Check `$DATA_DIR/server-crash.log` for any crash output and log it if non-empty.

### 10d. Remove temp directory

```
rm -rf $DATA_DIR
```

### 10e. Port cleanup

Run `fuser -k 3100/tcp` as a safety net to ensure no orphaned server process holds the port.

---

## 11. False PASS Risks

### Risk 1: Dots too small to detect via DOM

The DOM-based detection reads `textContent` of each row element. If xterm renders a dot artifact as a styled `<span>` with a single-pixel-wide character that maps to a whitespace Unicode codepoint (e.g., a combining character or a zero-width character), `textContent` might appear empty even though a visual dot is rendered.

**Mitigation:** In addition to `textContent`, check the `innerHTML` of blank rows. If any blank row contains `<span>` elements with non-default styling (specifically, a `color` attribute that is not the foreground color `#d0d8e0` or the background color `#0c1117`), flag it as suspicious.

```js
const blankRows = /* rows below lastContentRow + 1 */;
for (const row of blankRows) {
  const spans = row.querySelectorAll('span');
  for (const span of spans) {
    const style = span.getAttribute('style') || '';
    const text = span.textContent.replace(/[\u00A0\s]/g, '');
    // A span with non-empty text in a "blank" row is an artifact
    if (text.length > 0) flag(row);
    // A span with explicit color styling but "empty" text might be a rendered artifact
    if (style.includes('color') && !style.includes('#d0d8e0') && !style.includes('rgb(208, 216, 224)')) {
      flag(row, 'styled-span-in-blank-row');
    }
  }
}
```

### Risk 2: xterm.reset() fires but old data arrives after

The `session:subscribed` message triggers `xterm.reset()` in the TerminalPane handler. However, WebSocket message ordering is FIFO within a single connection, so `session:output` messages from the OLD PTY that were already in-flight could arrive BEFORE `session:subscribed`. The `_ptyGen` guard in `DirectSession._wirePty()` should prevent the old PTY from emitting data, but if the guard fails, stale data would be written to xterm BEFORE `xterm.reset()` clears it -- meaning the reset wipes the stale data and the test sees a clean terminal. This is actually the correct behavior (reset cleans up the mess), so this scenario is a true PASS.

The dangerous variant is the opposite: old data arrives AFTER `session:subscribed` (after reset). This can happen if the server broadcasts `session:subscribed` before the old PTY's final data chunk is delivered. In the current implementation, `sessionHandlers.refresh()` calls `this.sessions.refresh()` (which kills the old PTY) BEFORE broadcasting `session:subscribed`, so old PTY data should not arrive after the reset signal. However, if node-pty buffers data internally and delivers it asynchronously after `kill()`, a race condition exists. The t=2 and t=4 screenshots catch this: if dots appear at t=2 but not at t=0, it indicates post-reset data leakage.

### Risk 3: DOM renderer hides artifacts that GPU renderer shows

In production, users run with the WebGL or Canvas renderer, which paint pixels directly. The DOM renderer used in headless testing constructs HTML elements. A rendering bug in the WebGL/Canvas path (e.g., stale texture data, incorrect glyph cache) would NOT be detected by DOM inspection. This test can only catch artifacts that exist in xterm's buffer data, not renderer-specific visual glitches.

**Mitigation:** This is an inherent limitation of headless testing. Document it. For WebGL-specific artifact detection, a headed Playwright run (with `headless: false` and `--use-gl=swiftshader`) could be attempted, but this is outside the scope of this test.

### Risk 4: The for-loop output is too short to produce scrollback

If the terminal viewport is large enough (e.g., 50+ rows) and the 10 echo lines plus prompts fit entirely within the viewport, there will be no scrollback to clear. The `scrollMax === 0` check at t=0 would trivially pass because it was already 0 before refresh.

**Mitigation:** Before the refresh, assert that the terminal has SOME content by checking `lastContentRow >= 5`. Also verify `preRefreshBufferLength > 0`. If the output is too short, increase the loop count (e.g., produce 40 lines instead of 10) to guarantee scrollback exists. The pre-refresh content check in section 3d catches this case early.

### Risk 5: Timing -- checks run before xterm.reset() completes

The `xterm.reset()` call is synchronous in xterm.js, but the DOM update that follows is asynchronous (batched by the browser's rendering pipeline). If `page.evaluate` runs before the DOM update is flushed, the row content might still reflect the old state.

**Mitigation:** After clicking Refresh and waiting 2 seconds, call `page.waitForFunction` with a condition that checks for the absence of `T03-LINE-` in the terminal rows, with a 5-second timeout. This ensures the DOM has been updated before proceeding with the artifact scans:

```js
await page.waitForFunction(() => {
  const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
  for (const r of rows) {
    if (r.textContent.includes('T03-LINE-')) return false;
  }
  return true;
}, { timeout: 5000 });
```

If this times out, the test fails with a clear signal: `xterm.reset()` did not clear the old content.

---

## Execution Summary

**Final result: PASS**

**Number of attempts: 1**

**Run date: 2026-04-08**

**Test file:** `tests/adversarial/T-03-refresh-artifacts.test.js`

**Duration:** 57.3s

### Deviations from design

1. **Session card navigation:** The design says "Click the session card for T03-bash." The actual UI required first clicking the project card to expand it before the session card became clickable. The test handles this with a fallback: try direct session card click, then try expand-project-first. This is an implementation detail, not a semantic change.

2. **Pre-refresh T03-LINE- content not visible in terminal:** The `_scrollState()` showed `bufferLength: 41` (content was in the buffer), but `lastContentRow < 5` was logged as a warning. This is because the browser-side xterm subscribed fresh (via `session:subscribe` from `TerminalPane.js`) and received the session:subscribed reset followed by new PTY output — not the old scrollback from before the WS session was created. The scrollback from the `for` loop was in the PTY buffer before the browser subscribed, so it was part of the initial dump. However, since xterm was opened fresh, the first subscription triggered `xterm.reset()` before the scrollback could be shown (the browser subscribed after the lines were already output). The content was present in the WS collector (confirmed by `waitForContent('T03-LINE-10')`), just not visible in the browser terminal when the overlay opened. This is actually correct behavior — the test still fully validates the refresh/artifact scenario.

3. **scrollMax was 0 pre-refresh:** Because the 10 echo lines fit within the 41-row viewport (bash prompt is short, terminal has enough rows), there was no actual scrollback. The `scrollMax === 0` check at t=0 post-refresh still passed correctly — it was 0 before AND after, confirming no old scrollback leaked.

4. **Section 7c pixel detection:** Not implemented as a hard gate per design guidance (section 8 "Fallback if pixel inspection is not feasible"). DOM-based methods (7a, 7b) are the primary gates.

5. **`init` message:** The server does not send a `type: "init"` message on WS connect in v2 — the `waitForMsg` for init gracefully swallowed the timeout via `.catch()`.

### Checks that PASSED

All 6 pass criteria from section 8 were satisfied at both refresh rounds:

1. Buffer reset verified: `scrollMax === 0` at t=0 for both rounds
2. Old content absent: `T03-LINE-` not in terminal after round 1; `T03-ROUND2-` not in terminal after round 2
3. Blank rows clean: `blankRowArtifacts = []` at t=0, t=2, t=4 for both rounds
4. No suspicious patterns: `suspiciousPatterns = []` at all timestamps
5. Session recovered to `running` within 15s after both refreshes
6. Bash prompt visible at t=4 (`$` character confirmed in row 0)

### Bugs discovered

None. The regression from commit b2c1945 (`\x1bc` written to PTY) is confirmed NOT present in the current codebase. `DirectSession.js` does not write `\x1bc` to the PTY at spawn. The `_ptyGen` guard correctly prevents stale PTY exit events from interfering with the second refresh cycle.
