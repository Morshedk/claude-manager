# Session Card Portrait Preview -- Test Designs

Date: 2026-04-09

## Infrastructure

- **WS URL:** bare `ws://127.0.0.1:<port>`
- **ProjectStore seed:** `{ "projects": [{ "id": "proj-test-1", "name": "Test Project", "path": "/tmp/test-project" }], "scratchpad": [] }`
- **Sessions list REST:** `GET /api/sessions` returns `{ managed: [...], detected: [...] }`
- **waitUntil:** `domcontentloaded`
- **Chromium path:** `~/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
- **Server entry:** `node server.js` (or `node server-with-crash-log.mjs` if available)
- **Data isolation:** Each test uses `DATA_DIR=/tmp/test-portrait-T<N>-<timestamp>` to avoid state bleed

---

### T-1: Portrait card renders with all four structural sections

**Flow:**
1. Start server on port 3500 with a fresh DATA_DIR.
2. Launch Chromium, navigate to `http://127.0.0.1:3500`, wait for `domcontentloaded`.
3. Open WebSocket to `ws://127.0.0.1:3500`.
4. Create a project via REST: `POST /api/projects { name: "T1", path: "/tmp/test-project" }`.
5. Create a session via WS: `{ type: "session:create", projectId: "<id>", name: "test-portrait", mode: "direct" }`.
6. Wait for `session:created` response.
7. Click the project in the sidebar to navigate to its detail view.
8. Wait for `.session-card` to appear in the DOM.
9. Assert the following child elements exist within the first `.session-card`:
   - `.session-card-titlebar` containing a `.session-card-name` with text "test-portrait"
   - `.session-card-titlebar` containing a `.session-card-summary` (with "No summary yet" placeholder)
   - `.session-card-tags` containing at least one `.badge` element
   - `.session-card-preview` (a `<pre>` element)
   - `.session-card-actionbar` containing a `.btn-icon` button (wrench)
10. Assert there is NO element with class `session-card-actions` (old layout) inside the card.
11. Assert the card's computed `flex-direction` is `column`.

**Pass condition:** All four structural sections (titlebar, tags, preview, actionbar) exist as children of `.session-card` with correct content. No legacy `session-card-actions` element present.

**Fail signal:** Card renders in old horizontal layout (flex-direction: row), or any of the four sections is missing. Preview pane is an xterm canvas element instead of `<pre>`.

**Test type:** Playwright browser

**Port:** 3500

---

### T-2: Preview lines update after PTY output

**Flow:**
1. Start server on port 3501.
2. Open WebSocket to `ws://127.0.0.1:3501`.
3. Wait for `init` message.
4. Create a project and session (direct mode), wait for `session:created`.
5. Subscribe to the session: `{ type: "session:subscribe", id: "<sessionId>" }`.
6. Wait for `session:subscribed`.
7. Send a distinctive string to the PTY that will appear in output: `{ type: "session:input", id: "<sessionId>", data: "echo PREVIEW_MARKER_T2_UNIQUE_12345\n" }`.
8. Wait 25 seconds (the preview interval is 20s, add 5s margin).
9. Request the sessions list via WS: observe the next `sessions:list` broadcast OR call `GET /api/sessions`.
10. Find the session in the list and inspect `session.previewLines`.

**Pass condition:** `previewLines` is a non-empty array of strings, and at least one line contains the substring `PREVIEW_MARKER_T2_UNIQUE_12345`.

**Fail signal:** `previewLines` is undefined, null, or an empty array after 25 seconds. Or the array exists but contains only empty/placeholder content without the marker string. This would indicate the preview interval is not running, getPreviewLines is broken, or the broadcast does not include previewLines.

**Test type:** WS protocol

**Port:** 3501

---

### T-3: cardSummary appears after watchdog summarizes

**Flow:**
1. Start server on port 3502 with watchdog enabled in settings (`watchdog.enabled: true`, `watchdog.intervalMinutes: 1` for faster testing).
2. Open WebSocket, wait for `init`.
3. Create a project and session (direct mode).
4. Subscribe to the session. Send enough input to exceed `MIN_DELTA_FOR_SUMMARY` (send a multiline echo command producing >500 bytes of output).
5. Wait up to 90 seconds, collecting all `sessions:list` messages received.
6. For each received `sessions:list`, check if the session object has a non-empty `cardSummary` field.

**Pass condition:** Within 90 seconds, at least one `sessions:list` broadcast contains the session with a non-empty `cardSummary` string (truthy, not "No summary yet").

**Fail signal:** No `sessions:list` message ever contains `cardSummary` on the session. This indicates either the watchdog prompt change was not applied, the `cardLabel` field is not being extracted from the API response, or the `meta.cardSummary` assignment is failing (e.g., the `instanceof Map` guard is blocking it).

**Test type:** WS protocol (requires Claude API access or a mock)

**Port:** 3502

---

### T-4: Settings change (previewLines count) takes effect on next sweep

**Flow:**
1. Start server on port 3503.
2. Create a project and direct-mode session.
3. Subscribe and send enough PTY input to produce 30+ lines of output (e.g., `for i in $(seq 1 40); do echo "LINE_$i"; done`).
4. Wait 25 seconds for the first preview sweep.
5. Verify `previewLines` array length is <= 20 (default).
6. Change the setting: `PUT /api/settings { "previewLines": 10 }`. Assert response returns `previewLines: 10`.
7. Wait another 25 seconds for the next preview sweep.
8. Collect the next `sessions:list` broadcast and inspect `previewLines`.

**Pass condition:** After the settings change, `previewLines` array length is <= 10 (and > 0). Before the change, it was <= 20. The count changed.

**Fail signal:** `previewLines` length stays at 20 after the settings change. This indicates the interval is not re-reading the setting on each tick, or `settingsStore.get('previewLines')` is cached.

**Test type:** WS protocol + REST

**Port:** 3503

---

### T-5: Adversarial -- previewLines with ANSI escape sequences are stripped

**Flow:**
1. Start server on port 3504.
2. Create a project and direct-mode session.
3. Subscribe to the session.
4. Send ANSI-heavy input to the PTY that exercises multiple escape families:
   ```
   echo -e "\x1b[31mRED_TEXT\x1b[0m \x1b[1;4mBOLD_UNDERLINE\x1b[0m"
   echo -e "\x1b]0;WINDOW_TITLE\x07"
   echo -e "\x1b[3CCURSOR_FORWARD"
   echo -e "CLEAN_SENTINEL_LINE"
   echo -e "\x1b[?25lHIDDEN_CURSOR"
   echo -e "\x1b(B\x1b)0GSET_SWITCH"
   ```
5. Wait 25 seconds for the preview sweep.
6. Collect `sessions:list` and inspect `previewLines`.

**Pass condition:** Every line in `previewLines` is free of:
- Any byte with char code < 32 (except newline, which should not appear inside a single line)
- The literal substring `\x1b` or `\u001b`
- The literal substring `[31m`, `[0m`, `[1;4m`, `]0;`, `[3C`, `[?25l`, `(B`, `)0`
The lines should contain the readable text: `RED_TEXT`, `BOLD_UNDERLINE`, `CURSOR_FORWARD`, `CLEAN_SENTINEL_LINE`, `HIDDEN_CURSOR`.

Additionally, render the `previewLines` into a browser DOM `<pre>` element and assert it contains no elements (no injected HTML tags).

**Fail signal:** Raw ANSI escape bytes survive in the previewLines array. Or `stripAnsi` converts cursor-forward (`\x1b[3C`) into visible garbled characters instead of removing them. The `CLEAN_SENTINEL_LINE` is the control -- if it is absent, the echo commands themselves failed.

**Test type:** WS protocol + Playwright (for DOM XSS check)

**Port:** 3504

---

### T-6: Wrench icon Edit button opens EditSessionModal

**Flow:**
1. Start server on port 3505.
2. Launch Chromium, navigate to `http://127.0.0.1:3505`, wait for `domcontentloaded`.
3. Create a project and session via WS (from a parallel connection or REST).
4. Navigate to the project detail view.
5. Wait for `.session-card` to appear.
6. Locate the `.btn-icon` button within `.session-card-actionbar`.
7. Assert the `.btn-icon` has `title="Edit session"`.
8. Click the `.btn-icon` button.
9. Wait for an edit modal to appear in the DOM (look for a modal overlay or `.modal` element with session edit fields -- e.g., a text input pre-filled with the session name).

**Pass condition:** Clicking the wrench icon opens a modal containing an editable session name field pre-filled with the session's name. The card body click did NOT fire (session is not attached/opened).

**Fail signal:** Clicking the wrench icon attaches to the session instead of opening the edit modal (stopPropagation failure). Or the wrench button does not exist (old text "Edit" button still present). Or no modal appears.

**Test type:** Playwright browser

**Port:** 3505

---

### T-7: Duplicate .btn-icon CSS rule causes style regression

**Flow:**
1. Start server on port 3506.
2. Launch Chromium, navigate to `http://127.0.0.1:3506`.
3. Create a project and session.
4. Navigate to the project detail view, wait for `.session-card` to appear.
5. Locate the `.btn-icon` element inside `.session-card-actionbar`.
6. Use `window.getComputedStyle()` to read the button's computed `padding`, `width`, and `height`.

**Pass condition:** The `.btn-icon` has `padding: 0px` (or `padding: 0px 0px 0px 0px`), `width: 24px`, `height: 24px` as specified in the portrait card CSS (lines 379-393). The wrench icon is visually compact and fits within the 28px action bar height.

**Fail signal:** The computed `padding` is `6px` (from the generic `.btn-icon` rule at line 587), which means the later CSS rule is overriding the portrait-card-specific rule. The button appears larger than intended and may overflow the action bar. This is a real bug found during review -- there are duplicate `.btn-icon` selectors at lines 379 and 587 with conflicting styles.

**Test type:** Playwright browser

**Port:** 3506
