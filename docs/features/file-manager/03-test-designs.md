# File Manager — Test Designs

Purpose: lifecycle + adversarial tests that exercise the file-manager feature end-to-end against a real isolated server. Each test maps to a user-lifecycle story (Section 4 of `01-design.md`) and/or an implementation gap identified in `03-review.md`. Tests must fail on a pre-implementation codebase (or on the partially implemented surface where gaps exist), and pass on a fully correct implementation.

Rules:
- Every test starts its own server instance on a dedicated port (3350+), with an isolated `DATA_DIR` tmp dir.
- No mocking. All endpoints hit a real server; all UI is driven through a real Chromium via Playwright (unless the test is purely REST).
- Tests must assert observable outcomes — DOM content, file content, HTTP status, and localStorage values — not just that a click happened.
- Each test cleans up its server and tmpDir in `afterAll`.

Legend:
- `Test type: Playwright browser` — full-page navigation + interaction through `chromium`.
- `Test type: REST` — `fetch()`-only, no browser.
- `Test type: server-level` — multi-surface (REST + WS + DOM) integration test.

Port allocation:
- T-1: 3350
- T-2: 3351
- T-3: 3352
- T-4: 3353
- T-5: 3354
- T-6: 3355
- T-7: 3356
- T-8: 3357

---

### T-1: Screenshot reviewer (Story 1) — path input loads image, Open-in-new-tab renders it on dark bg

**Flow:**
1. Start isolated server with `DATA_DIR` containing one project `{ id: 'p1', name: 'Demo', path: tmpDir }`.
2. Write a 1×1 PNG to `${tmpDir}/qa-screenshots/dashboard/A-01.png` (valid PNG header, minimal pixels).
3. Launch Chromium, navigate to `http://127.0.0.1:3350/`.
4. Select project `Demo` in sidebar. Click the `Files` tab.
5. In the path input (`.fb-path-input`), type `qa-screenshots/dashboard/A-01.png` and press Enter.
6. Wait for `.fb-image-preview img` inside the right pane. Assert the `img.src` endpoint `/api/fs/image?path=...&projectPath=...` returns HTTP 200 when fetched directly.
7. Click `.fb-open-newtab` (the "Open in new tab ↗" button). Capture the new tab's URL via `page.context().waitForEvent('page')`.
8. In the new tab, wait for `img.src` to resolve. Take a computed style of `body.background-color` and assert it equals a dark-theme value (`rgb(12, 17, 23)` — the `--bg-deep`).

**Pass condition:**
- Opened URL `startsWith('http://127.0.0.1:3350/viewer.html?path=')` and contains `A-01.png` (URI-encoded) in the query string.
- Response for that URL has `content-type: text/html` and the body contains the unique marker `<div id="viewer-content">` (present only in `viewer.html`, NOT `index.html`).
- New tab renders `<img>` with `naturalWidth > 0` (image actually loaded).
- New tab `document.title === 'A-01.png'`.
- `getComputedStyle(document.body).backgroundColor === 'rgb(12, 17, 23)'`.

**Fail signal:**
- `window.open` fires with `/api/fs/read?…` (design-original raw-text path) instead of `/viewer.html?…`.
- Viewer body contains `<div id="app">` (index.html catch-all served instead of `viewer.html`) — the false-PASS F11 case.
- Viewer body background is light (`rgb(255, 255, 255)`) — theme not applied.
- `naturalWidth === 0` — image failed to load (server path-traversal check broken, or encoding bug).

**Test type:** Playwright browser
**Port:** 3350

---

### T-2: Side-by-side reviewer (Story 2) — Split button opens FileSplitPane, workspace is clipped, resize drag persists

**Flow:**
1. Start isolated server on port 3351 with a project rooted at a tmp dir.
2. Write `${tmpDir}/lib/sessions/SessionManager.js` with content `// file marker: T-2 SessionManager\nclass Foo {}`.
3. Launch Chromium, navigate to app, select project, click Files tab.
4. Click the directory entries to navigate to `lib/sessions/`, then click `SessionManager.js`.
5. Click the `.fb-split` button. Wait for `.file-split-pane` to appear.
6. Evaluate `getComputedStyle(document.getElementById('workspace')).marginRight` — assert it is NOT `0px` and equals `calc(100% - var(--split-pos, 50%))` resolution (verify by computing expected pixel value from 50% of window width).
7. Assert `document.body.classList.contains('file-split') === true`.
8. Assert the split pane contains the file's content (search for the literal `// file marker: T-2 SessionManager`).
9. Drag `.split-resize-handle` from its current x (~50% viewport width) to 30% viewport width. On mouseup, assert `localStorage.getItem('splitPosition')` is a string parsed to a number within `[28, 32]`.
10. Reload the page. Re-open Files tab, re-select file, click Split.
11. Assert `document.documentElement.style.getPropertyValue('--split-pos')` starts at the previously-saved value (approximately 30%).

**Pass condition:**
- `.file-split-pane` is present after Split click; contains the target file content; `body.file-split` class applied; `#workspace` margin-right ≠ 0; drag updates both `--split-pos` CSS variable and `localStorage.splitPosition`; reload preserves position.

**Fail signal:**
- Split pane renders but `body.file-split` not applied → `#workspace` still full-width (F2).
- Drag updates `--split-pos` but localStorage is not written (F9).
- After reload, `--split-pos` returns to default `50%` (persistence broken).

**Test type:** Playwright browser
**Port:** 3351

---

### T-3: Path-is-in-my-head developer (Story 3) — markdown renders with real headings, not a `<pre>` fallback

**Flow:**
1. Start isolated server on port 3352.
2. Write `${tmpDir}/docs/features/X/01-design.md` with content:
   ```
   # Alpha Heading

   Some paragraph text.

   - item one
   - item two
   ```
3. Navigate to app, select project, click Files tab.
4. In `.fb-path-input`, paste `docs/features/X/01-design.md` (do NOT navigate via clicking).
5. Press Enter.
6. Wait until `.fb-markdown` appears inside the right pane.
7. Assert the right pane's `.fb-markdown` has at least one `<h1>` child (produced by `marked.parse`) whose text is `Alpha Heading`.
8. Assert the `.fb-markdown` container's children count is >1 (not a single `<pre>` fallback).
9. Open the page at `/viewer.html?path=${encodeURIComponent(…)}&projectPath=${…}` directly. Assert the same `<h1>Alpha Heading</h1>` in the viewer body.

**Pass condition:**
- `.fb-markdown > h1:first-of-type` has textContent `Alpha Heading` in both in-app and viewer surfaces.
- Not a single `<pre>` child.

**Fail signal:**
- `.fb-markdown` contains a single `<pre>` with the raw markdown source (F4: `marked` not loaded, fallback shown, but test passes if it only checks for presence of `.fb-markdown`).
- Viewer page serves `index.html` (renders `<div id="app">`) instead of `viewer.html` body.
- Right pane breadcrumb updates but content area still shows the previous file (F6: path-submit doesn't propagate to content viewer).

**Test type:** Playwright browser
**Port:** 3352

---

### T-4: In-app markdown link hijack — Risk #7 realized (HIGH finding)

**Flow:**
1. Start isolated server on port 3353.
2. Write `${tmpDir}/target.md` with content:
   ```
   # Target

   [other](./other.md)
   ```
3. Navigate to app, select project, click Files tab.
4. Click `target.md` in the directory listing.
5. Wait for `.fb-markdown` to render and contain an `<a>` element with `href` ending in `./other.md`.
6. Record `location.href` before click.
7. Click the `<a>` element inside the in-app `.fb-markdown`.
8. Wait 500ms.
9. Assert `location.href` is unchanged (still on `/`, NOT `/other.md`).
10. Assert the URL bar has NOT changed and that `document.body.classList.contains('file-split') === false` is still valid. Assert `.fb-markdown` still visible (we did NOT navigate away to `/other.md` which would render `index.html`).
11. Repeat against the viewer page: open `/viewer.html?path=${tmpDir}/target.md&projectPath=${tmpDir}` in a new tab; in that tab, click the `<a>`; assert `location.pathname` remains `/viewer.html`.

**Pass condition:**
- Click on `<a>` inside `.fb-markdown` does NOT navigate the page in either surface (in-app or viewer).
- `location.href` / `location.pathname` unchanged.
- Project detail UI still visible (proving we did not fall through `app.get('*')` to `index.html`).

**Fail signal:**
- After click, URL becomes `/other.md`, the server returns `index.html` (catch-all), and the main Preact app re-renders. This is the **current** behavior per `03-review.md` finding #1 — **this test is expected to FAIL on the current implementation**, validating the finding.
- The test also catches a pre-implementation codebase because `.fb-markdown` does not exist at all.

**Test type:** Playwright browser
**Port:** 3353

---

### T-5: XSS-in-path-query adversarial (AC #13, F10) — viewer does not execute injected script

**Flow:**
1. Start isolated server on port 3354 with a project.
2. Navigate `/viewer.html?path=%3Cscript%3Ewindow.__pwned%3Dtrue%3C%2Fscript%3E&projectPath=${tmpDir}`.
3. Wait for `#viewer-error` or `#viewer-content` to settle (page will error since the path does not exist, but must render).
4. Assert `window.__pwned` is NOT set.
5. Assert `document.title` equals the literal string `<script>window.__pwned=true</script>` (basename of the path, written via `document.title`).
6. Assert `document.getElementById('viewer-filename').innerHTML === document.getElementById('viewer-filename').textContent` (no HTML was parsed into the header element).
7. Also test the `<svg onload=…>` payload variant: navigate `/viewer.html?path=%3Csvg%20onload%3Dwindow.__pwned2%3Dtrue%3E&projectPath=…`. After settle, assert `window.__pwned2` is undefined.
8. As a negative control: `/viewer.html?path=&projectPath=` (both empty) — assert page shows "Missing file path" in `#viewer-error`.

**Pass condition:**
- No injected script executes (both `window.__pwned` and `window.__pwned2` are `undefined`).
- Filename header element uses `textContent`, not parsed HTML.
- Page does not crash.

**Fail signal:**
- `window.__pwned === true` — viewer wrote path into `innerHTML`.
- Filename element contains an actual `<script>` or `<svg>` child node.
- Page hangs or crashes (uncaught exception from malformed URL handling).

**Test type:** Playwright browser
**Port:** 3354

---

### T-6: Path-input resolution table — 200 / 400 / 403 / 404 / 413 / 415 (adversarial)

**Flow:**
1. Start isolated server on port 3355 with a project at `${tmpDir}`.
2. Prepare test fixtures:
   - `${tmpDir}/small.txt` (50 bytes of ASCII) — should map to 200.
   - `${tmpDir}/mydir/` (empty directory) — should map to 400 "Not a file" via path-input, then navigate to directory listing.
   - `${tmpDir}/big.txt` (1.5 MB of `'a'.repeat(...)`) — should map to 413 "File too large".
   - `${tmpDir}/bin.bin` (1024 bytes starting with `\x00\x00\x00\x00`) — should map to 415 "Binary file", not image → toast.
   - `${tmpDir}/pic.png` (valid PNG) — should map to 415 but isImageFile true → loads as image.
3. Navigate to app, open Files tab.
4. For each fixture, type its relative path, press Enter, assert:
   - **small.txt** → `.fb-content-header` filename is `small.txt`, first rendered line shows "50 byte ASCII" content. Breadcrumbs unchanged from root.
   - **mydir/** (trailing slash) → `.fb-list-panel` updates to show an "Empty directory" message. No `/api/fs/read` call is made (assert via `page.on('request')` listener: no request URL matches `/api/fs/read?path=.*mydir/`).
   - **big.txt** → toast appears with `File too large to preview`.
   - **bin.bin** → toast appears with `Binary file`.
   - **pic.png** → right pane shows `<img>` with `.src` matching `/api/fs/image?path=…pic.png…`.
5. Adversarial: type `/etc/passwd` and press Enter. Assert toast `Path is outside the project.`
6. Adversarial: type `nonexistent/path.js` and press Enter. Assert toast `Path not found: nonexistent/path.js`.
7. Adversarial: type `~/stuff` and press Enter. Assert toast `Use an absolute path or a path relative to the project.`
8. Adversarial: type `$HOME/x` and press Enter. Assert same toast.

**Pass condition:**
- All eight cases produce the exact expected UI response described.

**Fail signal:**
- Binary file silently blanks out the right pane (no toast) — F7.
- Directory probe makes `/api/fs/read` before `/api/fs/ls` (should be shortcut by trailing slash) — F3 / design 2.5 step 3.
- `/etc/passwd` loads (bypass — see `03-review.md` finding #5).
- `~/stuff` or `$HOME/x` submits to server instead of being rejected client-side.

**Test type:** Playwright browser
**Port:** 3355

---

### T-7: Session + file-split mutual exclusion (AC #11, F5) — adversarial ordering

**Flow:**
1. Start isolated server on port 3356.
2. Create a project and a session (via REST `/api/sessions`).
3. Navigate to app, select project.
4. Attach the session — click on the SessionCard to attach, wait for `#session-overlay` to render.
5. Click Files tab (tab bar still visible in left detail pane behind the overlay).
6. Select a file. Read the `.fb-split` button.
7. Assert `.fb-split` has `disabled` attribute set.
8. Force-click it anyway (`.fb-split[disabled]` — simulating a stuck-state user). Assert `.file-split-pane` does NOT appear in the DOM (no attempt to open).
9. Detach the session (`x` button on overlay). Wait for `#session-overlay` to disappear.
10. Assert `.fb-split` no longer has `disabled`. Click it. Assert `.file-split-pane` now appears.
11. Assert at this point EXACTLY ONE of `#session-overlay` and `.file-split-pane` is in the DOM, never both simultaneously.
12. Reverse ordering: open file-split first, then attach the session. Per review finding #5.3, file-split wins. Assert `#session-overlay` does NOT render while `.file-split-pane` is present (via `document.querySelectorAll('#session-overlay').length === 0`).
13. Close file-split. Assert `#session-overlay` now mounts.

**Pass condition:**
- Split button is `disabled` when a session is attached.
- At most one of `#session-overlay` / `.file-split-pane` ever renders.
- Ordering (attach-then-open-file-split) is correctly blocked by the disabled Split button.
- Ordering (open-file-split-then-attach) keeps file-split visible; session overlay mounts only after file-split is closed.

**Fail signal:**
- Both panes render simultaneously (F5).
- Split button is rendered but enabled while session is attached — clicking it opens the pane on top of the session overlay.
- After detach, Split button stays disabled.

**Test type:** Playwright browser
**Port:** 3356

---

### T-8: REST — `/viewer.html` routing guard + vendor file + pre-implementation diff

**Flow:**
1. Start isolated server on port 3357. No UI interaction.
2. `GET /viewer.html` — assert status 200 and `content-type` starts with `text/html`. Body contains the marker `<div id="viewer-content">` AND does NOT contain `<div id="app">`. (F11: proves the catch-all did not serve `index.html`.)
3. `GET /vendor/marked-12.0.0.min.js` — assert status 200 and `content-type` includes `javascript`. Body length > 10000 bytes (real lib, not a stub).
4. `GET /js/components/FileContentView.js` — assert 200, body contains the string `dangerouslySetInnerHTML` (proves the current implementation state).
5. `GET /js/components/FileSplitPane.js` — assert 200, body contains `SPLIT_MIN` and `SPLIT_MAX` imports from `../state/store.js`.
6. `GET /js/viewer.js` — assert 200, body contains the string `preventDefault()` (link-interception guard present) AND the string `addEventListener('click'` (the delegated click handler).
7. `GET /api/fs/read?path=${tmpDir}/README.md&projectPath=${tmpDir}` — create `${tmpDir}/README.md` first, assert 200, body is the file's content.
8. `GET /api/fs/read?path=/etc/passwd&projectPath=${tmpDir}` — assert 403 (traversal guarded when projectPath is a real project dir).
9. Adversarial: `GET /api/fs/read?path=/etc/passwd&projectPath=/` — document current behavior. If this returns 200 with file body, record as a confirmed pre-existing bypass (per `03-review.md` finding #3-5). Test records outcome; does not necessarily fail — but if the team fixes the bypass, this test should be updated to assert 403.
10. `GET /js/components/FileBrowser.js` — assert 200, body contains the string `aria-label="File path"` (the path-input element) AND contains `submitPathInput` function definition.

**Pass condition:**
- Steps 2–8 pass as described. Step 9 is informational; if the bypass is fixed in a follow-up, flip to assert 403.

**Fail signal:**
- `/viewer.html` serves `index.html` (catch-all routing regression — F11).
- `marked-12.0.0.min.js` is 404 or a stub < 1000 bytes (vendoring broken).
- `viewer.js` does NOT contain `preventDefault()` (F12 — link guard missing in viewer).
- `/api/fs/read?path=/etc/passwd&projectPath=${tmpDir}` returns 200 (per-project traversal broken).

**Test type:** REST
**Port:** 3357

---

## Coverage matrix

| Story / Gap | Test(s) |
|---|---|
| Story 1: Screenshot reviewer | T-1 |
| Story 2: Side-by-side reviewer | T-2 |
| Story 3: Path-is-in-my-head | T-3 |
| Story 4: Multi-file investigator | T-6 (path-input resolution covers replace) |
| Story 5: Image-curious | T-6 (image preview) + T-1 (image in viewer) |
| HIGH finding: in-app markdown link hijack | T-4 |
| XSS query param (AC #13, F10) | T-5 |
| Routing guard (F11) | T-1 (body check) + T-8 (REST) |
| Session + file-split exclusivity (AC #11, F5) | T-7 |
| Split handle drag persistence (AC #6, #12, F9) | T-2 |
| Path resolution table (AC #8, #9, #10, #14, #15, F3, F7) | T-6 |
| `marked` fallback to `<pre>` (F4) | T-3 (negative: asserts NOT a single `<pre>`) |
| Viewer loads and fetches, not empty (F8) | T-1, T-3 |
| `preventDefault` guard in viewer (F12) | T-4 step 11 + T-8 step 6 |
| Pre-existing `projectPath=/` bypass (review finding #3/5) | T-8 step 9 (informational) |

## How these tests catch a pre-implementation codebase

- **T-1 / T-2 / T-3 / T-6 / T-7**: depend on the Files tab and its children existing — pre-implementation has no Files tab, so `setActiveTab('files')` finds no button and the test times out at step 4.
- **T-4 / T-5**: depend on `/viewer.html` existing; pre-implementation gets the `app.get('*')` fallback and the test fails at the body-marker assertion.
- **T-8**: step 6 asserts `viewer.js` contains the `preventDefault()` guard. Fails if the file does not exist.

## How these tests catch the current (partial) implementation's HIGH finding

- **T-4** is a direct reproduction of the in-app markdown link hijack. The current `FileContentView.js` has no click-interception; clicking a markdown link navigates away from the app. T-4 will FAIL until a delegated click handler is added to `FileContentView.js` after `dangerouslySetInnerHTML`.

## Notes on test implementation

- Use Playwright's `page.context().waitForEvent('page')` to capture the new tab opened by `window.open`.
- Use a `page.on('request')` listener to assert which endpoints were hit (e.g. T-6 step 4b: no `/api/fs/read` call before `/api/fs/ls` on trailing-slash shortcut).
- Use `page.evaluate(() => localStorage.getItem('splitPosition'))` to verify persistence.
- For T-2 drag, use `page.mouse.move` + `page.mouse.down` + `page.mouse.move` + `page.mouse.up`. Avoid `.dragTo()` which is not guaranteed to produce mousemove events.
- Server startup per-test uses the pattern in `tests/adversarial/feat-session-cards-T1-dom-structure.test.js`: `spawn('node', ['server.js'], { env: { DATA_DIR, PORT } })` + `fetch('/api/projects')` readiness poll with 20s deadline.
