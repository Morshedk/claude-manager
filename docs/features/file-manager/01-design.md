# File Manager — Design Document

## Section 1: Problem & Context

### The user problem

A developer using the Claude Web App (v2) frequently needs to look at project files while Claude works in a terminal session: source files Claude is editing, generated reports, screenshots Claude just saved, log files, markdown plans. Today there is no way to do this inside the app. The user has to leave the browser, open a separate editor or file manager, and context-switch between two windows.

Three specific frictions motivate this feature:

1. **Screenshots, generated images, and binary-producing tools are invisible.** When Claude saves an image (e.g. a Playwright screenshot) the user cannot preview it in-app. They must copy the path to an external viewer.
2. **Cross-referencing code and terminal output requires window swapping.** When Claude says "I updated `src/foo.js` — here's the diff," the user wants to confirm the file's actual current content while keeping the terminal in view.
3. **Path input is tree-click-only.** Even if a user already knows the exact path of a file ("I need `lib/api/routes.js`"), today the only way to surface it would be to click down `lib/` → `api/` → `routes.js`. The path is in their head already; the app should let them type it.

### What exists in v2 that relates to this

- **`public/js/components/FileBrowser.js` (lines 1–231).** A complete two-pane file browser component (left: directory listing with breadcrumbs, right: content viewer with text-with-line-numbers / markdown / image preview / "Open ↗" button). It takes `{ projectId, projectPath }` as props. It hits `/api/fs/ls`, `/api/fs/read`, `/api/fs/image`. **It is fully implemented, but not imported, rendered, or referenced anywhere in the app.** It is dead code today.
- **`public/js/state/store.js` line 100.** A `fileBrowserOpen` signal initialized to `false`. **It is exported but not read anywhere.** No action toggles it. No component consumes it.
- **`lib/api/routes.js` lines 142–240.** Four `/api/fs/*` endpoints already implemented and tested:
  - `GET /api/fs/dirs?path=…` — directory autocomplete.
  - `GET /api/fs/ls?path=…&projectPath=…` — list directory, filtered (no dotfiles, SKIP = node_modules/.git/.next/etc).
  - `GET /api/fs/read?path=…&projectPath=…` — returns `text/plain` UTF-8 file contents. 1 MB limit. Binary detection rejects files containing `\0` in the first 512 bytes.
  - `GET /api/fs/image?path=…&projectPath=…` — serves image with proper MIME. 10 MB limit. Extension allow-list.
  All four enforce `resolved.startsWith(resolvedProject)` as path-traversal protection.
- **Split-view plumbing is already in place.** `splitView` signal (store.js line 63), `splitPosition` signal (store.js line 76), `body.session-split` class toggled by `App.js` lines 65–68, `--split-pos` CSS variable applied by `App.js` lines 60–62, `body.session-split #workspace { margin-right: calc(100% - var(--split-pos, 50%)) }` rule at `public/css/styles.css` lines 702–705, draggable `.split-resize-handle` (styles.css lines 707–735), and a working drag implementation in `SessionOverlay.js` lines 28–54. All of it currently only fires when `attachedSessionId.value` is truthy — i.e. when a session is attached.
- **The existing FileBrowser component has a single "Open ↗" button.** `FileBrowser.js` lines 178–189 calls `window.open(...)` on `/api/fs/read?…` or `/api/fs/image?…`. For text files this opens raw `text/plain` in the browser — no line numbers, no code styling, no markdown rendering, no dark theme.
- **`marked` (markdown library) is referenced in `FileBrowser.js` line 210** via `typeof marked !== 'undefined' ? marked.parse(fileContent) : …` — but `marked` is **not loaded** in `public/index.html` (vendor directory, `public/vendor/`, has only xterm assets). The component silently falls back to wrapping the raw text in `<pre>`. This is working code-path wise, but the user never gets rendered markdown today.
- **`public/js/utils/dom.js` lines 54–90** exports `initResize(handle, axis, target, opts)`. Axis `'h'` sets `width` in px on the target, `'v'` sets `height`. Used today for `#sidebar-resize` (App.js line 75) and `#resize-sessions` (ProjectDetail.js line 28).
- **`ProjectDetail.js` lines 19–133** renders the detail pane with `activeTab` state (`'sessions' | 'watchdog' | 'todos'`). The tab bar is at lines 73–91. The terminals area is at lines 115–128. No file-related UI.

### What's missing and why

1. **A way to open the file browser.** `fileBrowserOpen` signal exists, but nothing sets it. No button, no tab, no keyboard shortcut. Users have no entry point.

2. **"Open in new browser tab" as a styled viewer, not raw text.** Current "Open ↗" goes to the raw REST endpoint. The browser renders `text/plain` with the user's browser font in light mode. Per the feature request, we need a standalone styled page with dark theme, syntax-appropriate rendering (line numbers for code, rendered markdown for `.md`, image-fit layout for images).

3. **Split-screen file viewer alongside the terminal.** Today `splitView` only splits *workspace | session overlay*. There is no third pane. Users who want to "see the file + see the terminal" must close the overlay, open the file browser, then reopen the session — losing split context. We need a way to put a file viewer side-by-side with the terminal.

4. **A path text input.** `FileBrowser.js` lines 130–139 shows only breadcrumbs. There is no input to type/paste a path. Power users who already know a path have no direct path to it.

5. **Markdown rendering.** `marked` is referenced but not loaded. Either we load it or we drop the reference and fall back to plain code view. Design decision needed.

6. **Entry point from the detail pane.** The detail pane has three tabs (Sessions, Watchdog, TODOs). "Files" is a natural fourth tab, but it needs a mounting point and wiring.

---

## Section 2: Design Decision

### 2.1 What we are building — overview

Three capabilities, all orbiting around the existing `FileBrowser` component:

- **(A) "Files" tab** in `ProjectDetail`, bringing the existing FileBrowser component into the main UI.
- **(B) "Open in new tab"** button on any selected file, which navigates to a new dedicated viewer page (`/viewer.html?path=…&projectPath=…`) that renders the file with dark theme, line numbers or markdown or image preview — not raw `text/plain`.
- **(C) "Split" button** on any selected file, which pins the file viewer to the right half of the screen alongside whatever is on the left (the project detail + terminal). Drives off the same `--split-pos` variable the session overlay already uses, so the existing split-resize-handle works for file split too.
- **(D) Path input** inside the FileBrowser header, where the user can type or paste a path. Submitting navigates to that file (if it is under `projectPath`), or surfaces an error toast if invalid or outside the project.

### 2.2 Files to create

1. **`public/viewer.html`** (new) — the standalone styled file-viewer page targeted by "Open in new tab." URL path the browser hits is `/viewer.html` (see 2.3 item 7 for why we do **not** use a pretty `/viewer` URL).
2. **`public/js/viewer.js`** (new) — ESM entry for `viewer.html`. Reads URL query params, fetches `/api/fs/read` or `/api/fs/image`, renders a styled, dark-themed view. Self-contained: no imports from `state/`, `ws/`, or any app component; vanilla DOM + `fetch` + `marked` only. Rough shape: a single `main()` of ~60 lines with one branch per file type (image / markdown / code).
3. **`public/js/components/FileContentView.js`** (new, required) — extracted shared render logic for the right-pane content area: loading state, error state, image, markdown, code-with-line-numbers. Takes `{ path, projectPath }` as props. Used by both `FileBrowser.js` (in its right pane) and `FileSplitPane.js` (in the split pane body). Extracted to avoid the duplication called out in the plan review (G3). This is **not** optional — if the implementer skips extracting it, the duplication risk returns.
4. **`public/js/components/FileSplitPane.js`** (new, required) — a right-side fixed-position pane that renders the file viewer in split mode. Mirrors `SessionOverlay.js`'s positioning rules. Body renders `<FileContentView ... />`.

Note on `FilePanel`: an earlier draft proposed a `FilePanel.js` wrapper around `FileBrowser`. **Decision: do NOT build `FilePanel.js`.** The path input, selected-file state, and action buttons all land directly inside `FileBrowser.js`. `ProjectDetail.js` imports `FileBrowser` directly. No wrapper file is created. Any reference to `FilePanel` elsewhere in this doc should be treated as referring to `FileBrowser`.

### 2.3 Files to modify

1. **`public/js/components/ProjectDetail.js`**
   - **Line 20:** add `'files'` as a valid value for `activeTab`.
   - **Lines 73–91 (tab bar):** add a fourth tab button "Files" immediately after "TODOs," following the same styling pattern.
   - **Lines 93–108 (content switch):** add a new branch when `activeTab === 'files'`, rendering `<FileBrowser projectId=${project.id} projectPath=${project.path} />`.
   - **Import:** add `import { FileBrowser } from './FileBrowser.js';` at the top.

2. **`public/js/components/FileBrowser.js`**
   - **Lines 126–139 (header):** add a path-input text field next to (or above) the breadcrumbs. Placeholder `"Type a path, e.g. lib/api/routes.js"`. Keyboard behavior (spec — see 2.8):
     - **Enter** submits the path (resolution logic in 2.5).
     - **Escape** clears the input's current value AND dismisses any suggestion list; focus remains in the input.
     - **Blur** (click outside, Tab away) dismisses any suggestion list but does **not** clear the input (so the user can tab back to it).
     - ARIA: input has `aria-label="File path"`.
   - **Lines 174–190 (content header):** change the single "Open ↗" button into two buttons: "Open in new tab" (navigates to `/viewer.html?path=…&projectPath=…` — see 2.3 item 7 for URL-path choice) and "Split" (dispatches a new action to open the file in the split pane — see 2.4).
   - **Right pane body:** replace the inline loading / error / image / markdown / code-line JSX (FileBrowser.js lines ~193–224) with a single `<FileContentView path=${selectedFilePath} projectPath=${projectPath} />`. Same logic, one source of truth.
   - **Behavior change (image fallback removed):** when "Open in new tab" fires for an image, we still point at `/viewer.html?path=…&projectPath=…`; the viewer page is responsible for detecting the extension and rendering an `<img>`. We no longer use `/api/fs/image` directly from the Open button.

3. **`public/js/state/store.js`**
   - **Delete** line 100 (`fileBrowserOpen`). It is dead code (unread) and this feature does not revive it. Replacing it with the cleaner signal below avoids future confusion.
   - **Add** a single new signal `fileSplitTarget` — `{ path, projectPath } | null`. **Null means closed; non-null means open.** There is **no separate** `fileSplitOpen` boolean (design review collapsed two redundant signals into one to avoid sync bugs).
   - **Add** a module-level constant `SPLIT_MIN = 20`, `SPLIT_MAX = 85` (percent). These mirror the clamp bounds in SessionOverlay.js lines 38 and 47 and are imported by both SessionOverlay and FileSplitPane so drag-bounds stay in sync.

4. **`public/js/state/actions.js`**
   - Add `openFileSplit(path, projectPath)` — sets `fileSplitTarget.value = { path, projectPath }` and ensures `splitView.value = true` (so the `--split-pos` CSS variable is active).
   - Add `closeFileSplit()` — sets `fileSplitTarget.value = null`.

5. **`public/js/components/App.js`**
   - **Line 13:** add `fileSplitTarget` to the imports from store.
   - **Lines 65–68 (session-split body class effect):** extend so that `body.file-split` is toggled whenever `fileSplitTarget.value !== null`. Keep `body.session-split` untouched. Both classes share the same `margin-right: calc(100% - var(--split-pos, 50%))` effect on `#workspace` (see styles rule in 2.3 item 6).
   - **Line 86 (`${attachedSessionId.value ? … SessionOverlay … : null}`):** render the file split pane as a sibling, guarded by the single-signal rule: `${fileSplitTarget.value !== null ? html\`<${FileSplitPane} />\` : null}`. When a session overlay is attached the "Split" file button is **disabled** (see 2.3 item 2 and AC #11), so at most one of the two panes ever renders.

6. **`public/css/styles.css`**
   - Add scoped rules for `.file-browser`, `.fb-entry`, `.fb-entry.active`, `.fb-breadcrumb`, `.fb-code-line`, `.fb-code-linenum`, `.fb-markdown`, `.fb-path-input` etc. Today, `FileBrowser.js` has inline styles throughout. That works and is a valid intentional choice. For this feature we stick with inline styles in the component but add **three** new rules to styles.css:
     - `.fb-path-input` (input styling — monospace, dark, full-width-in-header).
     - `.file-split-pane` (fixed position right pane, mirrors `#session-overlay` positioning from SessionOverlay.js lines 82–96).
     - `body.file-split #workspace { margin-right: calc(100% - var(--split-pos, 50%)) }` and a companion `.split-resize-handle` gate so the handle is visible when `body.file-split` is present too (currently it is rendered inside `SessionOverlay` — see the note under 2.4).

7. **`server.js`** (new addition — required to fix the `/viewer` routing blocker)
   - **Decision: URL is `/viewer.html`, not `/viewer`.** Rationale: `express.static` at server.js line 43 already serves `public/viewer.html` for the request path `/viewer.html`. Using the `.html` URL avoids adding any new route and avoids the `app.get('*')` catch-all at server.js line 49 that would otherwise serve `index.html` (verified: lines 40–51 of server.js, `express.static` does not rewrite extensionless paths).
   - **Implication**: no modification to `server.js` is required. The URL is simply `/viewer.html?path=…&projectPath=…`. All references in this document (Section 2.3, Section 2.5, AC #3) use `/viewer.html` consistently.
   - If a future revision decides to use the pretty `/viewer` URL instead, the required change is: insert `app.get('/viewer', (req, res) => res.sendFile(join(__dirname, 'public', 'viewer.html')))` **immediately before line 49** (the `app.get('*')` catch-all). This is documented here so the decision is reviewable.

8. **`public/index.html`**
   - **Vendor `marked` at a pinned version.** Add `<script src="/vendor/marked-12.0.2.min.js"></script>` **before** the importmap. File path: `public/vendor/marked-12.0.2.min.js`. Version pin: `marked@12.0.2` (zero dependencies; ~40 KB minified; known-good with the `marked.parse(...)` call already in FileBrowser.js line 210). If a different version is chosen at implementation time, update this line of the design and verify `typeof marked !== 'undefined'` still resolves — newer versions have occasionally changed from a global `marked` to a named export.
   - The viewer page (`public/viewer.html`) also loads the same vendored script so markdown rendering is consistent across in-app and viewer-tab contexts.

### 2.4 The split pane and the split-resize-handle

Today the split-resize handle is rendered *inside* `SessionOverlay.js` lines 97–103. That means: no overlay → no handle. If we reuse the same handle pattern for the file split, we have two options:

- **(i)** Render a second identical `.split-resize-handle` inside `FileSplitPane.js`. Pro: symmetric with SessionOverlay. Con: two handles existing on the DOM if both somehow rendered at once (we disable that by preventing simultaneous file split + session overlay).
- **(ii)** Hoist the split-resize handle out of SessionOverlay into App.js, render it whenever `body.session-split` OR `body.file-split` is active. Pro: single source of truth. Con: touching existing working code (SessionOverlay's drag logic). Higher regression risk.

**Decision: option (i).** Port SessionOverlay.js lines 28–54 (the `handleResizeMouseDown` implementation) into FileSplitPane.js. They share the same localStorage key `'splitPosition'` and the same `splitPosition` signal, so drag-persist behavior is uniform. The two handles are exclusive (only one pane renders at a time), so there is no double-handle. Both handlers import the shared `SPLIT_MIN` (20) and `SPLIT_MAX` (85) constants from `store.js` (see 2.3 item 3) so clamp bounds cannot drift.

**Shared `splitPosition` between modes is intentional.** A user who drags the boundary to 30% in file-split mode will see the session overlay boundary also start at 30% next time they attach a session. This is desired: one UI, one preferred split. Documented as a design choice rather than a risk.

### 2.5 Data flow

**Path-input submission** (item 4 in user-request):
1. User types `lib/api/routes.js` in the path input and presses Enter.
2. FileBrowser resolves: `fullPath = path.startsWith('/') ? path : projectPath + '/' + path`. Normalizes double slashes.
3. **Trailing-slash shortcut**: if the typed value ends in `/`, skip the `/read` probe and call `/api/fs/ls?path=${fullPath}&projectPath=${projectPath}` directly (user explicitly signaled a directory). Continue with the same 403/404/500 handling below.
4. Otherwise, client calls `/api/fs/read?path=${fullPath}&projectPath=${projectPath}`.
5. If response is 200 → it's a readable text file → treat as file, `loadFile(fullPath)`.
6. If response is 415 ("Binary file") → the file exists but is binary → if extension is an image, trigger image preview; else show toast "Binary file — cannot preview."
7. If response is 400 ("Not a file") → it's a directory → call `setCurrentPath(fullPath)`. Do **not** make an extra `/api/fs/ls` call here; the existing `useEffect` at `FileBrowser.js:42` re-triggers `loadDirectory` when `currentPath` changes. (Clarified per plan review B2: one round trip, not two.)
8. If response is 404 → show toast "Path not found: …"
9. If response is 403 → show toast "Path is outside the project."
10. If response is 413 → show toast "File too large to preview (>1 MB)."
11. **If response is 500** → show toast "Server error accessing path. See logs." The current directory and selected file are unchanged.
12. **If the fetch itself rejects** (network failure / server unreachable / request aborted by a subsequent submission) → show toast "Could not reach server." Unchanged state otherwise.
13. **Any other unexpected status** (e.g. 401, 502) → show the generic toast "Could not access path (status N)." so the user gets visible feedback rather than a silent failure.

Note: we deliberately reuse `/api/fs/read` as the "does this path exist?" probe instead of adding a new `/api/fs/stat` endpoint. The 400 "Not a file" response path already exists at `routes.js` line 212. This avoids server changes.

**Open in new tab** (item 1):
1. User clicks "Open in new tab" on a selected file.
2. FileBrowser calls `window.open('/viewer.html?path=' + encodeURIComponent(fullPath) + '&projectPath=' + encodeURIComponent(projectPath), '_blank')`. URL ends in `.html` so it's served by `express.static` (see 2.3 item 7).
3. The new tab loads `public/viewer.html`, which executes `public/js/viewer.js`.
4. `viewer.js` reads `location.search`, extracts `path` and `projectPath`. Both values are treated as **untrusted** strings.
5. **XSS guard**: any path-derived string written to the DOM goes through `textContent`, never `innerHTML`. Specifically: `document.title = basename(path)` (setting `.title` is safe; it is not parsed as HTML), and the on-page filename header uses `headerEl.textContent = basename(path)`. The only element that ever uses `innerHTML` is the `.fb-markdown` container, and its source is `marked.parse(fileContent)` where `fileContent` is the server-returned file body — not the URL. `path` and `projectPath` never flow into `innerHTML`.
6. By extension: if image → `<img>` element with `.src` set to `/api/fs/image?path=…&projectPath=…` (URL components encoded); if `.md` → `fetch('/api/fs/read?…')`, render with `marked.parse(…)` into a `.fb-markdown` container; else → `fetch('/api/fs/read?…')`, render line-numbered monospace view.
7. **Markdown internal links**: after `marked.parse` populates the DOM, viewer.js attaches a single delegated click handler on the `.fb-markdown` container that intercepts `<a>` clicks and calls `event.preventDefault()` — internal links are **disabled** in v1. Rationale: relative links like `./other.md` would resolve against `/viewer.html` and break; resolving them correctly requires joining with `projectPath` and escaping, which is out of scope. Rendered anchors remain visually present so users can see where a link points, but clicking does nothing. Documented in user-visible scope (2.7) and risks (Section 5).
8. Page title is set to the basename of the path (via `document.title` — safe, not HTML-parsed).
9. If any fetch fails (including non-2xx status or network error), the page shows a single error block centered in dark theme with the status code or error message.
10. If `path` or `projectPath` is missing from the query string, the page shows "Missing file path" centered in dark theme and does not fetch anything.

**Open in split pane** (item 2):
1. User clicks "Split" on a selected file.
2. FileBrowser calls `openFileSplit(fullPath, projectPath)` (new action in actions.js).
3. Store updates: `fileSplitTarget.value = { path, projectPath }` (non-null means open), `splitView.value = true`.
4. `App.js` effect toggles `body.file-split` class on.
5. `App.js` renders `FileSplitPane`.
6. `FileSplitPane` renders at `left: var(--split-pos, 50%); right: 0; top: var(--topbar-h); bottom: 0` — identical positioning to `SessionOverlay`.
7. It contains a header (file name, "✕" close) and a scrollable body rendering the file (same code/markdown/image logic as `FileBrowser`'s right pane).
8. Close button calls `closeFileSplit()`; `body.file-split` comes off; workspace returns to full width.

### 2.6 Edge cases and failure modes

1. **Path input with `~` or environment variables.** Do not expand. Reject with toast "Use an absolute path or a path relative to the project."
2. **Path input with `..` that escapes `projectPath`.** The server rejects with 403 (`routes.js` lines 207–208). The client shows the 403 toast. No extra client-side normalization needed.
3. **Path input during directory-loading race.** If the user types a path while a previous directory is still loading, cancel the in-flight listing (use `AbortController`) before starting the new fetch. Otherwise the old `setEntries` can overwrite the new content. Today `FileBrowser.js` has no AbortController — this is a pre-existing latent bug that we should fix as part of this feature.
4. **File too large (>1 MB).** Server returns 413. Show toast "File too large to preview." The "Open in new tab" button could still try, but the viewer page would see the same 413 and show the same error. Document that 1 MB is the cap.
5. **Binary file.** Server returns 415. For images, the in-pane preview already handles this — the `isImageFile(filename)` check at `FileBrowser.js` line 75 short-circuits to the image URL. For non-image binaries (e.g. `.zip`, `.pdf`), show toast "Binary file — cannot preview."
6. **Viewer page loaded with no query params or malformed query.** `viewer.js` shows "Missing file path" centered in dark theme.
7. **Viewer page loaded after server restart mid-read.** Fetch fails with network error → show generic "Failed to load file: …"
8. **Split pane + session overlay conflict.** Both use `left: var(--split-pos, 50%)` and `z-index: 100`. If both render, the later-rendered z-index wins. We prevent this by disabling the file-split button while a session is attached and by rendering only one pane at a time (App.js branching).
9. **localStorage disabled (incognito, etc.).** `splitPosition` read wrapped in try/catch already (store.js lines 66–73). No change.
10. **Path input with trailing slash.** Treat as directory regardless of what the server replies. If user types `lib/api/`, go to the `/ls` endpoint directly rather than probing `/read`.
11. **"Open in new tab" against a path that moved between click and open.** The new tab fetches on its own → it gets 404 → shows error page. Acceptable.
12. **Markdown with embedded relative image paths.** `marked` will produce `<img src="./screenshot.png">`. The viewer page is at `/viewer.html?…`; relative paths resolve against `/` — images break. Do not try to fix this in v1 of the feature; note in risks.
13. **`marked` not loaded / CDN blocked.** Graceful degrade to `<pre>` rendering (already in FileBrowser.js line 210 code path). viewer.js should replicate the same `typeof marked !== 'undefined'` guard.

### 2.7 What NOT to build (scope)

1. **No file editing.** Read-only. No save, no inline edits, no "open in editor."
2. **No file tree with expandable folders.** The current flat-per-directory listing plus breadcrumbs is sufficient for this feature. Tree-style navigation is deferred.
3. **No syntax highlighting.** Code files render as plain monospace with line numbers. Adding Prism or Highlight.js is out of scope.
4. **No file search / grep.** There is no search field that searches inside files. The path input is for *navigation*, not content search.
5. **No multi-file tabs inside the file pane.** One selected file at a time.
6. **No drag-and-drop files into the pane.** Upload is handled by the existing image-upload endpoint (`routes.js` lines 244–254) used elsewhere; not part of this feature.
7. **No right-click context menu on files.** Just single-click-to-select, plus the two header buttons.
8. **No auto-refresh / file-system watcher.** If the file changes on disk, the user clicks the file again (or reloads).
9. **No global "open file by path" command palette.** The path input lives inside the file pane; no Cmd-P global shortcut.
10. **No resizing of the file-list pane inside FileBrowser beyond its current `width:240px; min-width:160px; max-width:400px`** (FileBrowser.js line 145).
11. **No `FilePanel.js` wrapper.** The path input, action buttons, and selected-file state land directly inside `FileBrowser.js`. No wrapper component is created. (Resolution of plan-review contradiction G2.)
12. **No clickable internal links in rendered markdown inside the viewer page.** Anchors render visually (so users see `[text]` and `href` via hover) but `click` is prevented by a delegated handler (see 2.5 "Open in new tab" step 7). v1 does not navigate between files via markdown links.

### 2.8 Path-input keyboard behavior (explicit spec)

Summarized in one place to prevent implementation drift:

- **Enter** — submit (runs the resolution flow in 2.5).
- **Escape** — clear the input's current value; dismiss the suggestion list (if any is visible); keep focus in the input.
- **Blur** (focus leaves the input via click-elsewhere, Tab, or keyboard) — dismiss the suggestion list; do **not** clear the input's value.
- **Tab** — default browser behavior; moves focus to next control.
- `aria-label="File path"` on the `<input>`.
- No global shortcut opens or focuses this input; it is local to the Files tab.

---

## Section 3: Acceptance Criteria

1. **Given** a user has selected a project, **when** they look at the tab bar in the detail pane (`ProjectDetail.js` lines 73–91), **then** they see a fourth tab labeled "Files" after Sessions, Watchdog, TODOs.

2. **Given** the user clicks the "Files" tab, **then** the `FileBrowser` component renders inside the sessions area, the left pane shows the contents of `project.path`, and the right pane shows the "Select a file to view its contents" placeholder (FileBrowser.js line 172).

3. **Given** the user is in the Files tab and has clicked on `README.md`, **when** they click the "Open in new tab" button, **then** a new browser tab opens at `/viewer.html?path=<path>&projectPath=<projectPath>` (response `Content-Type: text/html` served by `express.static`, not the `index.html` catch-all), the `<title>` is `README.md`, and the page uses the same dark theme (`--bg-deep`, `--text-primary`) as the main app.

   **3a.** **Given** `marked` is loaded (`/vendor/marked-12.0.2.min.js` returned 200 on the viewer page), **when** the file content is rendered, **then** the `.fb-markdown` container contains at least one `<h1>` (or `<p>`) element produced by `marked.parse` — **not** a single `<pre>` child.

   **3b.** **Given** `marked` failed to load (simulated by removing the script tag or blocking the URL), **when** the file content is rendered, **then** the markdown body is displayed as line-numbered monospace text inside a single `<pre>` (the graceful degradation path).

4. **Given** the user has selected an image file (e.g. `screenshot.png`), **when** they click "Open in new tab," **then** the new tab shows the image centered, fitted to the viewport (`max-width:100%; max-height:100vh`), on dark background.

5. **Given** the user has selected any file and there is no session currently attached, **when** they click the "Split" button, **then** the file viewer appears pinned to the right half of the screen (from `--split-pos` to the right edge), the `#workspace` is clipped to the left half, the file's content renders in the split pane with the same code/markdown/image logic as the main pane, and the split-resize handle at `--split-pos` is draggable.

6. **Given** a file is open in the split pane, **when** the user drags the split-resize handle to approximately 30%, **then** the file pane occupies approximately 70% of viewport width, the left workspace occupies 30%, and on mouseup `localStorage.setItem('splitPosition', ...)` is called (same behavior as SessionOverlay line 49).

7. **Given** a file is open in the split pane, **when** the user clicks the "✕" close button on the pane, **then** the pane disappears, `body.file-split` class comes off, and the workspace returns to full width.

8. **Given** the user is in the Files tab, **when** they type `lib/api/routes.js` into the path input and press Enter, **then** the right pane loads that file's content, and the breadcrumbs update to show `projectName › lib › api › routes.js`.

9. **Given** the user types a nonexistent path `foo/bar/baz.js` and presses Enter, **then** an error toast appears ("Path not found…") and the current directory / selected file are unchanged.

10. **Given** the user types an absolute path outside the project (e.g. `/etc/passwd`) and presses Enter, **then** an error toast appears ("Path is outside the project") and nothing navigates.

11. **Given** a session is currently attached, **when** the user opens the Files tab and selects a file, **then** the "Split" button is **disabled** (rendered but `disabled` attribute set, with tooltip "Close the session overlay to use split-file view") and the "Open in new tab" button is still enabled. Disabled — not hidden — so the affordance remains discoverable. (Resolution of plan-review G1.)

12. **Given** a file has been opened in the split pane and the user drags the resize handle, **when** the drag ends on mouseup, **then** `localStorage.getItem('splitPosition')` returns the new percentage value (within bounds `SPLIT_MIN`=20 to `SPLIT_MAX`=85) — verifying that the file-split handler writes the same localStorage key as the session overlay handler (false-PASS F9 guard).

13. **Given** a user opens `/viewer.html?path=<script>alert(1)</script>&projectPath=…`, **when** the viewer page renders, **then** no script executes, the `<title>` shows the string literally (via `document.title` assignment), and any on-page filename header shows the string literally via `textContent`. (XSS guard, see 2.5.)

14. **Given** a user has typed a directory path `lib/api/` (trailing slash) and presses Enter, **then** the client calls `/api/fs/ls` directly (no `/api/fs/read` probe is made), and the left pane updates to the directory contents.

15. **Given** any path-input submission encounters an HTTP 500, a network error, or an unexpected status, **then** a user-visible toast appears with a message matching the mapping in Section 2.5 (steps 11–13), and the current directory / selected file are unchanged.

---

## Section 4: User Lifecycle Stories

### Story 1: The screenshot reviewer

A QA engineer is running Claude to generate Playwright screenshots. Claude reports: "I saved the screenshot to `qa-screenshots/dashboard/A-01.png`." The user opens the project detail, clicks the Files tab, types `qa-screenshots/dashboard/A-01.png` into the path input, presses Enter. The image fills the right pane. They spot a visual regression, click "Open in new tab" to see it at full resolution on a dark background. They switch back to the terminal tab and tell Claude what they saw.

### Story 2: The side-by-side reviewer

A developer asks Claude to refactor `lib/sessions/SessionManager.js`. Claude reports changes line-by-line. The user wants to verify the actual file on disk matches what Claude described. They open the Files tab, click `lib/sessions/SessionManager.js` in the tree, then click "Split." The file viewer pins to the right half; the project detail (with session cards and terminal below) stays visible on the left. As Claude continues working, they scroll through the file and the terminal updates in parallel — no window swap.

### Story 3: The path-is-in-my-head developer

A developer knows a file lives at `docs/features/split-screen-ux-path-dropdown/01-design.md`. They don't want to click through four nested directories. They open Files, paste the full path into the input, hit Enter. The markdown renders, with headings and lists formatted. They scan it, find what they need, close the tab.

### Story 4: The multi-file investigator

A developer is debugging an API issue. They open the Files tab and click on `lib/api/routes.js` — it loads in the right pane. They realize they also need to see the handler module, so they type `lib/sessions/SessionManager.js` into the path input. The new file replaces the content in the right pane. They note the interaction, click Open in new tab on the current file to pin it in a browser tab for reference, then use the path input to navigate to a third file. They end the investigation with three browser tabs: the app, `SessionManager.js`, and `routes.js`.

### Story 5: The image-curious user

A user has a session running where Claude has written a series of plots to `analysis/out/`. They open the Files tab, click into `analysis/out/` via the breadcrumbs. The directory listing shows `plot-1.png`, `plot-2.png`, `plot-3.png`. They click each one; the right pane shows the image preview. They find `plot-2.png` interesting, click "Open in new tab" to zoom in. No external image viewer needed.

---

## Section 5: Risks & False-PASS Risks

### Risks

1. **Viewer page is a new independent bundle.** `viewer.html` is a new HTML file with its own `<script type="module" src="/js/viewer.js">`. It must import only what it needs (no Preact, no signals, no WebSocket — just raw DOM + fetch + marked). If someone accidentally imports from `state/store.js` or `ws/connection.js`, it pulls the whole app into the viewer and breaks cold start. Guard: keep `viewer.js` self-contained, use vanilla DOM APIs.

2. **`body.file-split` vs `body.session-split` interaction.** If both classes are somehow applied at once (e.g. due to a race between `attachSession` and `openFileSplit`), the `margin-right` rule is identical in both cases, so layout is fine — but the z-index competition between `#session-overlay` and `.file-split-pane` may cause flickering. Mitigation: App.js renders only one (`${fileSplitTarget.value !== null ? FileSplitPane : (attachedSessionId.value ? SessionOverlay : null)}`), and the Split file button is disabled when a session is attached.

3. **Dead `fileBrowserOpen` signal.** The existing `fileBrowserOpen` signal at store.js line 100 is unread. It is explicitly deleted as part of this feature (see 2.3 item 3). This risk is retained in the doc only so the deletion is not forgotten during implementation.

4. **Marked vendoring at pinned version.** `public/vendor/marked-12.0.2.min.js` (pinned per 2.3 item 8). If a future revision bumps this version, the implementer must verify that `typeof marked !== 'undefined'` still resolves — marked v13+ migrated to named exports in some bundles, which would silently break the guard and drop users into `<pre>` fallback without warning. Mitigation: the pinned filename includes the version (`marked-12.0.2.min.js`), so any change is visible in a diff.

5. **Path input heuristic may mis-classify.** "Is this a file or a dir?" is decided by probing `/api/fs/read` first. If `/api/fs/read` returns 415 (binary), we assume it is a file (correct). If it returns 400 "Not a file," we fall back to listing (correct). But if the server ever changes the error taxonomy, this client logic breaks silently. Mitigation: add a small `resolvePath(…)` helper with a comment pinning the assumed status codes (400, 403, 404, 413, 415).

6. **AbortController not currently used in FileBrowser.** Pre-existing latent bug: fast directory switches can race. This design calls for adding AbortController to `loadDirectory` and `loadFile`. Failing to do so in implementation lets the path-input feature appear to work but intermittently fail on fast navigation.

7. **Markdown internal links in viewer.** Clicking `[link](./other.md)` inside a rendered markdown document in the viewer tab would resolve against `/viewer.html`, 404. v1 design disables all `<a>` clicks inside `.fb-markdown` via `event.preventDefault()` (see 2.5 "Open in new tab" step 7). Risk: if the preventDefault handler is not installed, users click a link, the browser navigates to `/other.md`, the `app.get('*')` catch-all serves `index.html`, and the user sees the main app UI unexpectedly. Mitigation: AC and implementation test must assert `<a>` clicks inside `.fb-markdown` do not cause navigation.

8. **Viewer page XSS via query parameters.** `path` and `projectPath` come from `location.search` and are user-controlled. If any path-derived string reaches `innerHTML`, we have a script-injection vector. The design (2.5 step 5) pins all path-derived DOM writes to `textContent` and `document.title`. Risk: a future contributor adds a "you are viewing `<b>${path}</b>`" header using template strings and `innerHTML`. Mitigation: AC #13 is an explicit test for `<script>` and `<svg onload>` injection payloads; code review must flag any `innerHTML` write that reads from `path` or `projectPath`.

9. **`splitPosition` shared between file split and session overlay.** Dragging the handle in either mode writes to the same localStorage key and the same signal. Documented as intentional in 2.4 — one UI, one preferred split — but flagged as a risk so reviewers can confirm it's a deliberate product decision rather than an implementation oversight.

10. **Two-signals-for-one-state bug class (mitigated).** An earlier draft used both `fileSplitOpen` (boolean) and `fileSplitTarget` (nullable object). The design now uses a single `fileSplitTarget` signal where `null` = closed and non-null = open. This risk is listed here as a reminder: any future code that introduces a second "is it open?" boolean alongside `fileSplitTarget` reintroduces a sync-bug class flagged by codebase MEMORY notes.

### False-PASS risks

1. **"Open in new tab" visually opens but shows raw text.** A Playwright test that only checks `window.open` was called with a URL that is *some* URL (e.g. `/api/fs/read?…`) would pass despite the feature being broken. Test must assert the opened URL starts with `/viewer.html?`, and fetch that URL and verify the response `content-type` is `text/html` and the body contains `<html>` and our app's dark-theme class / variable.

2. **Split pane renders but doesn't clip workspace.** If `body.file-split` class is not applied, the split pane appears but the workspace behind it is still full-width — project cards visible underneath. A visual check could miss this. Test must assert the computed `margin-right` on `#workspace` is non-zero when file split is open.

3. **Path input "works" but only for files already in `currentPath`.** If the submit handler just calls `loadFile(currentPath + '/' + input)` instead of resolving absolute vs relative, a test that types a simple filename (which matches both logic paths) passes. Test must type a nested relative path like `a/b/c.js` with the user on the project root, and assert `currentPath` changes.

4. **Markdown appears rendered in dev but not production.** If `marked` is loaded via a CDN that requires network, and the test runs offline, the fallback `<pre>` renders and the test passes on the fallback. Test must assert the DOM inside `.fb-markdown` contains at least one `<h1>` or `<p>` (not just a single `<pre>` child) when the input is known to be `# Hello\n\nWorld`.

5. **File split button appears in DOM but does nothing when session is attached.** If we *render* the button but forget to gate its enabled state, a click while a session overlay is up could produce undefined behavior (two panes fighting for `--split-pos`). Test must attach a session, click the Split file button, assert the DOM contains exactly one of `#session-overlay` or `.file-split-pane`, not both.

6. **Path input submits navigation but the right pane doesn't update.** If the signal flow between the path input and the content viewer is wired incorrectly (e.g. local `useState` vs shared state), the breadcrumbs update but the content pane stays on the previous file. Test must, after path submission, assert the text of `.fb-content-header` (filename) equals the submitted filename AND assert the first line of the viewer matches the actual first line of the target file.

7. **Binary file appears blank.** If the path input probes `/api/fs/read` for a binary (non-image) file, it gets 415. If the handler swallows this and shows nothing, the user sees a blank pane with no explanation. Test must submit a known binary non-image path and assert a toast appears with the text "Binary file" or "Cannot preview."

8. **Viewer page loads but does not fetch.** A test that checks `viewer.html` returns 200 passes even if `viewer.js` is empty or errors. Test must load `/viewer.html?path=…&projectPath=…` with a real readable file and assert the rendered DOM contains the file's content.

9. **Split handle drag in file split pane updates --split-pos but not `splitPosition` signal / localStorage.** If the file split pane's handle is a copy-paste of SessionOverlay's handler that accidentally drops the signal/localStorage writes, behaviorally the drag *looks* fine during a session, but reloading drops the new position. Test must drag the handle in file split mode, reload, open file split again, assert split is at the dragged position.

10. **Viewer page XSS tested only with safe paths.** A test that opens `/viewer.html?path=README.md&projectPath=/tmp/x` and asserts the file renders gives no signal about injection safety. Test must additionally open `/viewer.html?path=%3Cscript%3Ealert(1)%3C%2Fscript%3E&projectPath=…` and `/viewer.html?path=%3Csvg%20onload%3Dalert(1)%3E&projectPath=…`, then assert: (a) `document.title` contains the literal `<script>…</script>` text, (b) no `<script>` or event handler was injected into the DOM, (c) page does not crash. Also assert any filename-header element's `.innerHTML` equals its `.textContent` (i.e. no HTML tags were injected).

11. **`/viewer.html` URL renders `index.html` under catch-all.** A flaky test where the server momentarily misroutes can give a passing "tab opens and contains dark theme" assertion, because `index.html` *also* uses the dark theme. Test must fetch `/viewer.html?path=…&projectPath=…` and assert the response body contains a string unique to `viewer.html` (e.g. a marker element like `<div id="viewer-root">`) and **does not** contain a string unique to `index.html` (e.g. the `<div id="app">` Preact mount point). This catches the B1-class routing regression.

12. **Markdown internal link appears clickable but does not navigate (want: does not navigate).** A test that only visually inspects the rendered markdown could miss whether `click` is prevented. Test must dispatch a `click` on an `<a href>` inside `.fb-markdown` in the viewer page and assert `location.pathname` remains `/viewer.html` (no navigation occurred).
