# T-25: Paste Large Input Into Terminal — No Hang or Truncation

**Score:** L=2 S=3 D=5 (Total: 10)
**Test type:** Playwright browser
**Port:** 3122

---

## 1. What This Test Proves

When a user pastes 5,000 characters of text into an xterm.js terminal:
1. **No hang:** The browser tab does not become unresponsive
2. **No truncation:** The full 5,000 characters reach the PTY (bash receives the complete input)
3. **Terminal UI remains responsive:** After paste, the user can still type new input

This test matters because large paste operations can expose:
- xterm.js `onData` callback performance (fires for every character or chunk)
- WS message size limits (server may reject oversized messages)
- PTY write buffer saturation (node-pty may drop data if write too fast)
- Browser clipboard API + xterm bracketed paste interaction

---

## 2. Code Path Analysis

### 2a. xterm.js paste handling

xterm.js handles paste internally: when the terminal has focus and receives a clipboard `paste` event (or when `xterm.paste(text)` is called), it processes the text. If bracketed paste mode is enabled (bash with `bind 'set enable-bracketed-paste on'`), it wraps the text in `\x1b[200~...\x1b[201~`. Then `onData` fires with the full string.

**Concern:** `xterm.onData` fires once per paste event, not once per character. So even for 5,000 chars, the WS message is a single JSON with `data` = 5000-char string. This is well within typical WS message size limits (~1MB default in ws library).

### 2b. Server-side write

`sessionHandlers.input()` calls `this.sessions.write(msg.id, msg.data)`. `DirectSession.write()` calls `this.pty.write(data)`. node-pty's `write()` is a synchronous passthrough to the underlying PTY file descriptor. For 5,000 chars, this is a single `fd.write()` call.

**Concern:** PTY write may buffer. bash readline receives the input and echoes it back. If bash echoes 5,000 chars, the output may stream back in chunks. We need to wait long enough for the full echo.

### 2c. Playwright paste mechanism

Playwright's `page.keyboard.type()` sends one `keydown`/`keypress`/`keyup` per character — extremely slow for 5,000 chars (potentially 50+ seconds).

**Better approach:** Use `page.evaluate()` to call `xterm.paste(text)` directly on the terminal instance. xterm.js exposes `paste(text: string)` as a public API.

**Alternative:** Use `navigator.clipboard.writeText()` + `Ctrl+V` simulation. But clipboard API requires `--allow-clipboard` permissions in headless Chrome.

**Best approach:** `xterm.paste(5000_chars)` via page.evaluate on the xterm instance, accessible via `xtermRef.current.xterm`. We need to find a way to access this from page.evaluate.

### 2d. How to call xterm.paste from page.evaluate

`xtermRef.current` is a local variable in the React effect — not directly accessible from `page.evaluate`. However, we can:

1. Listen on the WS for `session:input` messages from the server-side and count received bytes
2. Use `page.keyboard.type()` on a small test payload (too slow for 5000 chars)
3. Use `page.evaluate()` to find the xterm instance via DOM hacks
4. Use `writeText` via the server-side WS (`session:input`) and verify receipt

**Best approach for this test:** Send the large input directly via WebSocket from the test side (`session:input`). Then verify the PTY received it by checking the bash echo in the terminal. This bypasses the browser paste UI but tests the full data path: WS → server → PTY → bash → PTY echo → WS → browser xterm.

**Alternative for UI-level test:** Use `page.evaluate` to dispatch a paste event on the xterm element.

---

## 3. Test Architecture — Two Sub-Tests

### Sub-Test A: WS-level large write (fundamental path)

Send 5,000 chars via `session:input` WS message from the test's Node.js WS client. Monitor the bash echo output (via `session:output` WS messages). Verify all 5,000 chars are echoed back within 5 seconds. No browser involved — tests PTY write + node-pty robustness.

### Sub-Test B: Browser paste UI (xterm UI path)

Open the session overlay in the browser. Use `page.evaluate` to dispatch a synthetic paste event on the xterm canvas element, or call `window.__xterm?.paste(text)` if we can expose the instance.

**Simpler browser approach:** Use `page.evaluate` to:
1. Find the xterm terminal's input textarea (`.xterm-helper-textarea` is the actual input element that receives keyboard events)
2. Set its value to the 5000-char string
3. Dispatch a paste event

Actually, the cleanest approach is to use `page.evaluate` to call `xterm.paste()` directly. We can expose xterm globally: `window.__xtermInstance = xterm` in TerminalPane.js. But we can't modify source files for a test.

**Practical approach:** Use `page.evaluate` to find the hidden textarea and set selection, or use Playwright's clipboard API with `page.context().grantPermissions(['clipboard-read', 'clipboard-write'])` + `page.evaluate(() => navigator.clipboard.writeText(...))` + `Ctrl+V`.

---

## 4. Infrastructure Setup

### 4a. Server on port 3122

```
DATA_DIR=$(mktemp -d /tmp/qa-T25-XXXXXX)
PORT=3122 node server-with-crash-log.mjs
```

### 4b. Pre-seed project

```json
{
  "projects": [{ "id": "proj-t25", "name": "T25-Paste", "path": "<tmpDir>", "createdAt": "..." }],
  "scratchpad": []
}
```

### 4c. Create a bash session via WS before opening browser

Use the control WS to create a bash session and wait for it to reach running state.

---

## 5. Test Steps (WS-Level — Sub-Test A, Primary)

### Step 1: Generate 5,000 char payload

```javascript
// 5000 chars of easily verifiable content: "PASTE_TEST_" repeated + unique marker
const PAYLOAD_CHARS = 5000;
const BASE_CHUNK = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // 26 chars
let payload = '';
while (payload.length < PAYLOAD_CHARS - 20) {
  payload += BASE_CHUNK;
}
payload = payload.slice(0, PAYLOAD_CHARS - 20) + '_END_MARKER_5000\r'; // \r to submit
```

### Step 2: Subscribe WS to receive session output

Open a second WS, subscribe to the session. Start collecting `session:output` data.

### Step 3: Send large input via session:input

```javascript
const startTs = Date.now();
sendWs(ctrlWs, { type: 'session:input', id: testSessionId, data: payload });
```

### Step 4: Wait for full echo within 5 seconds

Collect all `session:output` messages. Check for `END_MARKER_5000` in the accumulated output. Also count total received bytes.

```javascript
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  if (collector.includes('END_MARKER_5000')) break;
  await sleep(100);
}
const elapsed = Date.now() - startTs;
```

### Step 5: Assertions

- `collector.includes('END_MARKER_5000')` — full payload sent and echoed
- `elapsed < 5000` — completed within 5 seconds
- No WS disconnection during the write

---

## 6. Test Steps (Browser — Sub-Test B, UI Path)

### Step 1: Open session overlay in browser

Navigate → select project → click session card → wait for overlay.

### Step 2: Use Playwright clipboard paste

```javascript
// Grant clipboard permissions and use writeText + Ctrl+V
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await page.evaluate(async (text) => navigator.clipboard.writeText(text), payload.slice(0, -2)); // without \r
// Focus xterm
await page.click('#session-overlay-terminal .xterm-screen');
// Paste via keyboard shortcut
await page.keyboard.press('Control+V');
// Then press Enter
await page.keyboard.press('Enter');
```

**Alternative if clipboard unavailable:** Use `page.evaluate` to dispatch ClipboardEvent directly:
```javascript
await page.evaluate((text) => {
  const textarea = document.querySelector('.xterm-helper-textarea');
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
}, payload.slice(0, -2));
```

### Step 3: Verify terminal shows pasted content

Wait for `END_MARKER_5000` (or enough of the payload) to appear in the terminal xterm screen.

### Step 4: Verify UI responsiveness

After paste, click elsewhere in the terminal and verify the page responds (not hung):
```javascript
const isResponsive = await page.evaluate(() => {
  return new Promise(resolve => {
    setTimeout(() => resolve(true), 100);
  });
});
expect(isResponsive).toBe(true);
```

---

## 7. Pass / Fail Criteria

### PASS — all of the following:
1. **Sub-Test A:** `END_MARKER_5000` appears in collected output within 5s of write
2. **Sub-Test A:** Total output bytes suggest full echo (5000 chars)
3. **Sub-Test B:** Browser paste sends content to PTY (marker visible in terminal)
4. **Sub-Test B:** UI remains responsive after paste (page evaluate succeeds within 500ms)
5. No WS disconnection during large write
6. No server crash log entries during test window

### FAIL — any of the following:
1. `END_MARKER_5000` doesn't appear within 5s (truncation or hang)
2. WS connection drops during write (ws message too large)
3. Browser tab becomes unresponsive (page.evaluate times out)
4. Server crashes

---

## 8. False-PASS Risks

| Risk | Mitigation |
|------|-----------|
| END_MARKER_5000 appears but previous chars were truncated | Check output byte count is > 4000 |
| Browser paste works but data only reaches xterm, not PTY | WS output listener confirms PTY echo |
| Page "responsive" check passes trivially | Use a real DOM interaction (click) to verify |
| Bash echo splits 5000 chars across multiple output messages | Accumulate all output messages before checking |

---

## 9. Architecture Notes

xterm.js handles paste via its `_onPaste` handler which calls `this._stringToChars()`. For large inputs, xterm.js processes the entire paste in one synchronous call — there's no chunking at the xterm level. The `onData` callback fires once with the full string. The WS `send()` creates one JSON message. Server receives it, calls `pty.write(data)` — node-pty writes to the PTY FD.

**Known WS limit:** ws library default max message size is 100MB. 5,000 chars = ~5KB JSON. No size issue.

**Known PTY limit:** PTY write buffers are typically 64KB. 5,000 bytes is well within limit.

**Bracket paste mode:** bash enables bracketed paste by default in interactive mode. xterm.js handles this by wrapping pasted text in `\x1b[200~...\x1b[201~`. These control sequences instruct bash to accept the text as a literal block without executing it until Enter is pressed. This means the 5,000 chars are received by bash's readline intact.

---

## Execution Summary

**Result:** 2/2 PASS — 18.0s total (both sub-tests)

**Sub-Test A (WS-level):**
- 5000 chars sent via `session:input` WS message
- `END_MARKER_5000` found in PTY output within 101ms (well under 5s limit)
- 5011 chars received back (5000 chars echoed + 11 chars overhead from bash prompt/newlines)
- No WS disconnection
- Result: GENUINE PASS

**Sub-Test B (Browser UI):**
- `Ctrl+V` approach (clipboard API + key press) did NOT work in headless Playwright — xterm's internal paste handler wasn't triggered by this method
- **Fall-back:** `ClipboardEvent` dispatch on `.xterm-helper-textarea` DID work — marker found in terminal
- Full 5000-char WS write while browser watching: confirmed both via WS output (101ms) and browser terminal rendering
- UI remained responsive after large paste
- No critical console errors
- Result: GENUINE PASS

**Key findings:**
- `Ctrl+V` in headless Chrome does not trigger xterm's paste handler reliably — need ClipboardEvent dispatch on the hidden textarea
- PTY handles 5000-char single write in ~100ms — no buffering or truncation issues
- xterm renders the large output stream correctly in the browser
- WS message size for 5000 chars is ~5KB — well within limits
