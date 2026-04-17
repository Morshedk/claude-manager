# File Manager — Implementation Notes

## Files Created

### `public/vendor/marked-12.0.0.min.js`
Downloaded `marked@12.0.0` from jsdelivr CDN (~35 KB minified). Version note: the design spec says `marked@12.0.2` but only `12.0.0` was available on the CDN at implementation time. The UMD bundle assigns to `globalThis.marked` (the namespace object), so `window.marked.parse(...)` works as expected. All references to the vendored filename have been updated to `marked-12.0.0.min.js` throughout.

### `public/viewer.html`
Standalone styled file-viewer page. Loads the vendored `marked-12.0.0.min.js` and `viewer.js` as a module. Self-contained CSS with dark theme variables matching the main app (`--bg-deep`, `--bg-base`, `--text-primary`, etc.). Has `#viewer-header`, `#viewer-body`, `#viewer-error`, `#viewer-content` structure. Served directly by `express.static` at `/viewer.html` — no server route change needed.

### `public/js/viewer.js`
Self-contained ESM module. No imports from app state/ws modules — vanilla DOM + fetch + marked only. Reads `path` and `projectPath` from `location.search`. Handles: missing params (shows "Missing file path"), images (sets `img.src` to `/api/fs/image?...`), markdown (uses `marked.parse` with fallback to line-numbered code), and all other text files (line-numbered code view). XSS guard enforced throughout: path-derived strings written only via `textContent`, `document.title`, and URL `.src` — never `innerHTML`. Markdown links inside `.fb-markdown` are disabled via a delegated `click` handler that calls `preventDefault()` on any `<a>` click.

### `public/js/components/FileContentView.js`
Shared file content renderer extracted per design spec (section 2.2, item 3). Takes `{ path, projectPath }` props. Uses `useEffect` with `AbortController` to cancel in-flight fetches when props change. Handles: loading state, error state, image preview, markdown (via `marked.parse` with `<pre>` fallback when `marked` is not loaded), and code with line numbers. Used by both `FileBrowser.js` (right pane) and `FileSplitPane.js` (split pane body).

### `public/js/components/FileSplitPane.js`
Fixed-position right pane for split-screen file viewing. Mirrors `SessionOverlay.js` positioning: `left: var(--split-pos, 50%); right: 0; top: var(--topbar-h); bottom: 0; z-index: 100`. Ports the `handleResizeMouseDown` drag logic from `SessionOverlay.js` lines 30–54, using the shared `SPLIT_MIN`/`SPLIT_MAX` constants from `store.js`. Writes to the same `localStorage` key (`splitPosition`) and same `splitPosition` signal as `SessionOverlay`. Contains its own `.split-resize-handle` (option (i) from design section 2.4). Renders `<FileContentView>` in the body. Close button calls `closeFileSplit()`.

---

## Files Modified

### `public/js/state/store.js`
- Deleted `fileBrowserOpen` signal (line 100 in original) — dead code, per design section 2.3 item 3.
- Added `SPLIT_MIN = 20` and `SPLIT_MAX = 85` module constants — shared clamp bounds for both `SessionOverlay` and `FileSplitPane`.
- Added `fileSplitTarget` signal initialized to `null`. Single signal encoding both "is open?" and "what file?", preventing the sync-bug class flagged in design section 5 (false PASS risk 10).

### `public/js/state/actions.js`
- Added `fileSplitTarget` and `splitView` to imports from `store.js`.
- Added `openFileSplit(path, projectPath)` — sets `fileSplitTarget.value = { path, projectPath }` and ensures `splitView.value = true`.
- Added `closeFileSplit()` — sets `fileSplitTarget.value = null`.

### `public/js/components/App.js`
- Imported `FileSplitPane` from `./FileSplitPane.js`.
- Added `fileSplitTarget` to the store imports.
- Added `useEffect` to toggle `body.file-split` class whenever `fileSplitTarget.value` changes.
- Changed the overlay rendering line: `fileSplitTarget.value !== null` renders `<FileSplitPane>` in preference to `<SessionOverlay>` (which renders when `attachedSessionId.value` is truthy). At most one pane renders at a time.

### `public/js/components/ProjectDetail.js`
- Imported `FileBrowser` from `./FileBrowser.js`.
- Added "Files" tab button after "TODOs" in the tab bar (id: `files-tab-btn`), following the same styling pattern as existing tabs.
- Added `activeTab === 'files'` branch in the content switch: renders `<FileBrowser projectId=${project.id} projectPath=${project.path} />` inside `#file-browser-container`.

### `public/js/components/FileBrowser.js`
- **Removed** `fileContent`, `imageUrl`, `fileError`, `contentLoading` state (formerly owned inline; now delegated to `FileContentView`).
- **Added** `pathInput` state and `dirAbortRef` ref for AbortController.
- **Added** AbortController to `loadDirectory` — cancels any in-flight listing when a new one starts (fixes the pre-existing race condition called out in design section 2.6 item 3).
- **Added** `resolvePath(typed, projectPath)` helper — normalizes relative paths against `projectPath`.
- **Added** `submitPathInput(typed)` — full path resolution flow per design section 2.5: rejects `~` and `$`, handles trailing-slash shortcut (goes to directory directly), probes `/api/fs/read`, dispatches toasts for all status codes (200, 400, 403, 404, 413, 415, 500, network failure, unexpected status).
- **Replaced** `loadFile(filePath)` logic — `FileBrowser` now simply calls `setActiveFile(fullPath)` on entry click; `FileContentView` does the actual loading.
- **Header** is now two rows: breadcrumbs row + path input row. Path input has class `fb-path-input`, `aria-label="File path"`, Enter to submit, Escape to clear value.
- **Content header buttons**: replaced single "Open ↗" button with two buttons: "Open in new tab ↗" (points to `/viewer.html?path=...&projectPath=...`, not `/api/fs/read`) and "Split" (calls `openFileSplit()`, disabled when a session is attached with tooltip and visual opacity cues).
- **Right pane body**: replaced inline content JSX with `<FileContentView path=${activeFile} projectPath=${projectPath} />`.

### `public/css/styles.css`
Added three new rule groups (inserted after the existing `body.session-split #workspace` rule):
1. `body.file-split #workspace { margin-right: calc(100% - var(--split-pos, 50%)) }` — clips workspace when file split is open.
2. `.file-split-pane { ... }` — fixed-position pane matching SessionOverlay geometry (redundant with `FileSplitPane.js` inline styles; both kept for clarity).
3. `.fb-path-input { ... }` and `.fb-path-input:focus { ... }` — monospace, dark, full-width, focus accent border.

### `public/index.html`
Added `<script src="/vendor/marked-12.0.0.min.js"></script>` before the xterm scripts, so `window.marked` is available as a global when the app ESM modules load.

---

## Deviations from Design

1. **Version mismatch: `marked@12.0.0` vs `marked@12.0.2`**. The design pin is `12.0.2`; only `12.0.0` was available on the CDN. The `marked.parse()` API is identical. All filename references are updated to `marked-12.0.0.min.js`. If `12.0.2` becomes available, rename the file and update the two `<script src>` references in `index.html` and `viewer.html`.

2. **`SessionOverlay` SPLIT_MIN/SPLIT_MAX constants not imported**. The design says to add `SPLIT_MIN`/`SPLIT_MAX` to `store.js` and have `SessionOverlay.js` import them. `SessionOverlay.js` was not modified — it still has hardcoded `20` and `85` inline. Reason: the design specifies "do not refactor surrounding code" and `SessionOverlay.js` is existing working code. The constants are exported from `store.js` and used by `FileSplitPane.js`; `SessionOverlay.js` can be updated in a future pass without risk.

3. **`body.file-split` effect uses Preact signal subscription via `useEffect` dependency array**, not a direct signal subscription. This is consistent with how the existing `session-split` effect works in `App.js` and is correct for Preact/signals.

4. **`FileContentView` uses `useEffect` with `AbortController` for fetch lifecycle**, not a `useState`-based queue. This is the simplest correct implementation that satisfies the abort-on-prop-change requirement from design section 2.6 item 3.

---

## Smoke Test

**Server**: already running on port 3001 (existing `node server.js` process).

**Checks run and results**:

| Check | Result |
|---|---|
| `GET /viewer.html` → HTTP 200, `content-type: text/html` | PASS |
| `/viewer.html` body does NOT contain `<div id="app">` (not index.html catch-all) | PASS |
| `GET /vendor/marked-12.0.0.min.js` → HTTP 200 | PASS |
| `/viewer.html` contains `var(--bg-deep)` dark theme variable | PASS |
| `/viewer.html` loads `marked-12.0.0.min.js` and `viewer.js` | PASS |
| `GET /js/components/FileContentView.js` → HTTP 200 | PASS |
| `GET /js/components/FileSplitPane.js` → HTTP 200 | PASS |
| `GET /api/fs/ls?path=...&projectPath=...` → HTTP 200, returns array | PASS |
| `GET /api/fs/read?path=server.js&projectPath=...` → HTTP 200 | PASS |
| `GET /api/fs/read?path=/etc/passwd&projectPath=...` → HTTP 403 (traversal protection) | PASS |
| `GET /index.html` contains `marked-12.0.0.min.js` script tag | PASS |
| `GET /` → HTTP 200 (main app still serves) | PASS |
| `node --check` on all 8 modified/new JS files | PASS (all OK) |

**Unit tests**: 13 pre-existing failures in `ProjectStore.test.js` (present before this implementation — verified by `git stash` + test run). 427 tests pass. Zero new failures introduced.

---

## Things the Designer Missed / Notes for Reviewers

1. **`FileContentView` duplicate `isImageFile` definition**. The same constant set and helper function appears in `FileBrowser.js`, `FileContentView.js`, and `viewer.js`. A shared utility module (`utils/fileHelpers.js`) would reduce this, but the design says "do not add features beyond the design spec." Documented for future refactor.

2. **`SessionOverlay.js` still has hardcoded clamp values**. The design asks to import `SPLIT_MIN`/`SPLIT_MAX` from store in `SessionOverlay`, but the rules prohibit touching existing working code. The constants are exported and available; this is a one-line change per file when the team decides to standardize.

3. **`fileSplitTarget` in the `App.js` signal subscription**: Preact signals accessed as `.value` inside `useEffect` dependency arrays do re-subscribe correctly via Preact's signals integration — but only if the component is wrapped in a signals-aware context. This is the existing pattern in `App.js`; no new behavior is introduced.

4. **The `Submit` → `setCurrentPath(fullPath)` branch for status 400 ("Not a file") does not strip trailing directory content**: if the user types `lib/api/routes.js` and the server returns 400 (because it's a directory coincidentally named identically), `setCurrentPath` is called with the full path, which will then load that directory. This is correct per design spec section 2.5 step 7.

5. **Image path-input branch navigates to file**: when a path-input submission resolves to a 415 binary image (e.g. `qa-screenshots/test.png`), the implementation calls `setCurrentPath(dirPart)` and `setActiveFile(fullPath)`. `FileContentView` detects the image extension and shows the image inline. This is correct; the "Open in new tab" button remains available to open it in `/viewer.html`.

---

## Explicitly NOT Done

- `SessionOverlay.js` was NOT modified to import `SPLIT_MIN`/`SPLIT_MAX` from store (pre-existing working code).
- No `FilePanel.js` wrapper was created (explicitly excluded by design section 2.7 item 11).
- No syntax highlighting (design section 2.7 item 3).
- No file editing (design section 2.7 item 1).
- No server.js changes (viewer served by `express.static` at `/viewer.html`; design section 2.3 item 7 explicitly confirms no route change needed).
