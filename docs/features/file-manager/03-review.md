# File Manager — Implementation Review

Reviewer role: independent reviewer, did not author the design or the implementation.
Design reviewed: `/home/claude-runner/apps/claude-web-app-v2/docs/features/file-manager/01-design.md`
Implementation notes: `/home/claude-runner/apps/claude-web-app-v2/docs/features/file-manager/02-implementation-notes.md`
App directory: `/home/claude-runner/apps/claude-web-app-v2`

---

## Verdict: PARTIAL

The implementation is faithful to nearly all design decisions and acceptance criteria. Most file-level work, state modelling, split-pane plumbing, XSS hygiene in the standalone `/viewer.html`, and error-handling branches in the path-input flow are correct.

However, two design commitments are **not** implemented:

1. **`FileContentView` is an XSS sink via `dangerouslySetInnerHTML=${{ __html: marked.parse(text) }}` without the `event.preventDefault()` delegated click handler that the standalone viewer has** — so an internal markdown link click inside the in-app `.fb-markdown` container navigates the **entire SPA** to a broken URL, falls through `app.get('*')`, and gets `index.html`. Risk #7 / false-PASS F12 both explicitly target this. In `viewer.js` the preventDefault handler is present; in `FileContentView.js` it is absent.
2. **Path-input Escape behavior diverges from Section 2.8**. Spec: "Escape — clear the input's current value; dismiss the suggestion list (if any is visible); **keep focus in the input.**" Implementation: Escape clears the value but the keyDown handler does not call `e.preventDefault()` and does not re-assert focus. This is a minor deviation, but observable.

The combined effect of (1) is a material regression: a user clicking a `[link](./other.md)` in the Files tab navigates away from the project detail entirely. This is the exact scenario Risk #7 was written to prevent, and the design explicitly labels the fix as "must be installed" (AC/implementation test asserts `<a>` clicks inside `.fb-markdown` do not cause navigation).

Because of (1), the verdict cannot be FAITHFUL. Lifecycle tests below (in `03-test-designs.md`) are written to catch these gaps — they will fail against the current implementation, which validates that the issues are real.

---

## 1. Design decision by decision

| Decision (Section ref) | Faithfully implemented? | Evidence |
|---|---|---|
| (A) Files tab in ProjectDetail (2.1, 2.3 item 1, AC #1) | YES | `ProjectDetail.js:92–97` "Files" tab button; `ProjectDetail.js:111–114` `activeTab === 'files'` branch mounts `<FileBrowser>`; import at `:12` |
| (B) `/viewer.html` styled viewer (2.1, 2.2 item 2, 2.3 item 7, AC #3) | YES | `public/viewer.html` self-contained, loads vendored marked, dark theme vars inline; `public/js/viewer.js` is vanilla DOM + fetch + marked; served by `express.static` — `server.js:43` unchanged, no route added |
| (C) Split button + FileSplitPane (2.1, 2.2 item 4, AC #5, #7) | YES | `FileBrowser.js:278–284` Split button calls `openFileSplit`; `FileSplitPane.js` mirrors SessionOverlay geometry (`position:fixed; left:var(--split-pos); right:0; top:var(--topbar-h); bottom:0; z-index:100`) |
| (D) Path input in header (2.1, 2.3 item 2, AC #8, #9, #10, #14) | MOSTLY | `FileBrowser.js:216–227` input with `aria-label="File path"`; Enter submits; Escape clears value; trailing-slash shortcut at `:103–107`; error toasts for 403/404/413/415/500/network/other (see `submitPathInput`). Missing: no explicit focus re-assertion after Escape (see Deviation 2). |
| `FileContentView.js` extracted (2.2 item 3) | YES, but see XSS | Used by both `FileBrowser.js:289` and `FileSplitPane.js:101`. Logic duplication avoided. |
| `FileSplitPane.js` created with ported drag logic (2.2 item 4, 2.4 option (i)) | YES | `FileSplitPane.js:21–45` port of SessionOverlay drag handler, uses `SPLIT_MIN`/`SPLIT_MAX` constants (unlike SessionOverlay itself, still hardcoded) |
| `fileBrowserOpen` deleted (2.3 item 3) | YES | grep in `public/` and `lib/` returns 0 hits |
| Single `fileSplitTarget` signal, null=closed (2.3 item 3) | YES | `store.js:107` signal; `actions.js:160–167` open/close toggle `{path, projectPath}` vs `null` |
| `SPLIT_MIN=20` / `SPLIT_MAX=85` exported (2.3 item 3) | PARTIAL | `store.js:100–101`; imported by `FileSplitPane.js`; **not** imported by `SessionOverlay.js` (still hardcoded at lines 38, 47). Documented as a deliberate non-change in implementation notes item 2 and "Explicitly NOT Done" — design did specify "imported by both." |
| `openFileSplit` / `closeFileSplit` actions (2.3 item 4) | YES | `actions.js:160–167` |
| `body.file-split` toggle in App.js (2.3 item 5) | YES | `App.js:72–74` |
| App.js single-pane guard: file split OR session overlay, not both (2.3 item 5, 2.6 item 8) | YES | `App.js:92` ternary renders `FileSplitPane` first when open, else `SessionOverlay`. Combined with "Split" button disabled while session attached (`FileBrowser.js:281`), the invariant holds. |
| CSS `body.file-split #workspace` margin rule (2.3 item 6) | YES | `styles.css:708–710` |
| `.file-split-pane` positioning rule (2.3 item 6) | YES (+ duplicate) | `styles.css:713–724` **and** inline in `FileSplitPane.js:49–61` — not wrong, but redundant. Implementation notes call out the duplication. |
| `.fb-path-input` CSS (2.3 item 6) | YES | `styles.css:727–741` |
| URL path `/viewer.html`, not `/viewer` (2.3 item 7) | YES | `FileBrowser.js:272`, `server.js` untouched |
| `marked` vendored at pinned version (2.3 item 8) | PARTIAL | Pinned version is `marked@12.0.0`, not `12.0.2` as spec says. Implementation notes Deviation 1 acknowledges. No functional regression — `marked.parse` API identical and `typeof marked !== 'undefined'` guard works (UMD assigns to `globalThis.marked`). Minor. |
| marked loaded in `index.html` (2.3 item 8) | YES | `index.html:15` `<script src="/vendor/marked-12.0.0.min.js">` before importmap and xterm scripts |
| marked loaded in `viewer.html` (2.3 item 8) | YES | `viewer.html:7` |
| Resolve path probe flow: 200/400/403/404/413/415/500/network/other (2.5, AC #15) | YES | `FileBrowser.js:118–168` all branches present. 200 navigates + sets active file. 400 → directory. 415 → image or binary toast. 413 → toast. 403/404/500 → toast. Network error → toast. Unknown status → generic toast with status code. |
| Trailing-slash shortcut (2.5 step 3, 2.6 item 10, AC #14) | YES | `FileBrowser.js:103–107` — no `/read` probe, goes direct to `setCurrentPath`, which triggers useEffect → `/api/fs/ls` |
| XSS safe in viewer: path-derived writes via textContent / title / .src only (2.5 step 5, 2.7 item 12, Risk #8, AC #13) | YES | `viewer.js:21,36,40,87,88` all textContent / title; only `innerHTML` at `:56` uses `marked.parse(text)` where `text` = server file body, not URL |
| Viewer: markdown link click prevented (2.5 step 7, Risk #7, F12) | YES | `viewer.js:58–61` `div.addEventListener('click', ...)` with `preventDefault` on any nested `<a>` |
| **FileContentView: markdown link click prevented** (not explicit in design but implied by Risk #7 for in-app) | **NO** | `FileContentView.js:103` uses `dangerouslySetInnerHTML` with no click-interception wrapper. A `<a href="./other.md">` click inside the in-app `.fb-markdown` navigates the SPA. This is the design's Risk #7 realized inside the main app. |
| AbortController on `loadDirectory` (2.6 item 3) | YES | `FileBrowser.js:58–60, 67, 74, 78, 82` |
| AbortController on file fetch (2.6 item 3, mentioned in notes) | YES | `FileContentView.js:30–33, 47, 57, 62–63, 68` |
| Disabled (not hidden) Split button when session attached (2.7 item 11, AC #11) | YES | `FileBrowser.js:278–284` — `disabled=${sessionAttached}`, tooltip "Close the session overlay to use split-file view", opacity 0.5, cursor not-allowed |
| Open in new tab button (AC #3, #4) | YES | `FileBrowser.js:268–277` — `window.open('/viewer.html?path=...&projectPath=...', '_blank')` |
| Reject `~` and `$` in path input (2.6 item 1) | YES | `FileBrowser.js:95–98` |
| `splitPosition` drag persists to localStorage (AC #6, #12, F9) | YES | `FileSplitPane.js:40` `localStorage.setItem('splitPosition', String(pct))` after mouseup |

### Path-input keyboard behavior (2.8)

| Behavior | Design | Implementation | Faithful? |
|---|---|---|---|
| Enter submits | yes | `FileBrowser.js:224` | YES |
| Escape clears value, **keeps focus**, dismisses suggestion list | yes | `FileBrowser.js:225` `setPathInput('')` only, no `e.preventDefault()`, no explicit focus re-assertion | PARTIAL — no suggestion list exists in impl, so "dismiss" is a no-op. Clears value OK. No re-focus: browser default may consume Escape differently. |
| Blur does not clear | yes | implicit (no blur handler clears) | YES |
| Tab default browser behavior | yes | implicit | YES |
| `aria-label="File path"` | yes | `FileBrowser.js:219` | YES |

---

## 2. What was missed, skipped, or changed without justification

1. **`FileContentView.js` markdown link interception missing.** Design Risk #7 and F12 both target the viewer; design spec 2.5 "Open in new tab" step 7 installs `preventDefault` only in `viewer.js`. But the same render path via `marked.parse(…)` + `innerHTML` exists in `FileContentView.js:99–103` (right-pane of `FileBrowser`, body of `FileSplitPane`). No corresponding click-prevention handler. A click on `[link](./other.md)` in either surface navigates the SPA; `app.get('*')` serves `index.html` and the user sees the main app unexpectedly (the exact Risk #7 description). Because `FileContentView.js` is an **implementation-introduced** file, the design's "disable internal markdown links" instruction logically applies here as well — this is a skip without justification.
2. **`marked` version pin `12.0.0` vs `12.0.2`.** Acknowledged in implementation notes Deviation 1. Justified (CDN availability). No functional impact on `.parse()` API.
3. **`SessionOverlay.js` does NOT import `SPLIT_MIN`/`SPLIT_MAX`.** Design 2.3 item 3 says "imported by both SessionOverlay and FileSplitPane so drag-bounds stay in sync." Implementation left SessionOverlay untouched with hardcoded 20/85. Justified in notes Deviation 2 ("do not refactor surrounding working code") — a narrow reading of instructions. But the constants `SPLIT_MIN`/`SPLIT_MAX` are now effectively for one caller only, defeating the "stay in sync" rationale. The values happen to agree now; a future change to the constants would silently skew SessionOverlay.
4. **Path input: no explicit `e.preventDefault()` on Enter.** `onKeyDown` handler calls `submitPathInput(pathInput)` on Enter but does not prevent default form submission. In the current DOM the input is not inside a `<form>`, so this is not observable — but is implicit coupling to the surrounding JSX structure.
5. **Trailing-slash shortcut and bare project path.** If the user types a single `/` and Enter, `resolvePath('/', projectPath)` returns `/` (absolute path). Then the trailing-slash branch at `FileBrowser.js:103` fires and calls `setCurrentPath(fullPath.replace(/\/$/, '') || projectPath)`. The regex yields empty string, so it falls through to `projectPath`. That's correct, but arguably a silent no-op when the user asked for root.
6. **`FileContentView.js` image error fallback** replaces the element with a `div` via direct DOM mutation inside a Preact render — works, but fights Preact's diff. A toast + setState would be more idiomatic. Not a bug, just structural.
7. **No image-too-large (413) branch in FileContentView.** If a user selects an image >10 MB, `/api/fs/image` returns 413, but `FileContentView.js:40–45` never fetches the image — it just sets `imageUrl` and lets `<img>` load. `img.onerror` fires generically; the user sees "Failed to load image" with no hint why. Minor UX gap; not a design violation.

---

## 3. Security issues (XSS, injection, unvalidated input)

1. **XSS via in-app markdown link → SPA navigation (Risk #7 realized).** Described above. Not a script-execution XSS, but a category of attack where a compromised or unsafe markdown file navigates the user away from the expected page without visible signal (the URL bar changes to `/other.md`, `index.html` renders the main app again, the user's file-view context is lost). **Fix: replicate `viewer.js:58–61` delegated click handler inside `FileContentView.js`** after `dangerouslySetInnerHTML`. Use a ref + useEffect.
2. **`marked.parse` HTML sanitization.** By default marked v12 does NOT sanitize raw HTML inside markdown. A file like `<img src=x onerror="alert(1)">` inside a `.md` file, rendered via `marked.parse` and written to `innerHTML`, **will execute the onerror handler.** This affects both `FileContentView.js:103` and `viewer.js:56`. Design Section 2.5 step 5 carefully says "fileContent is the server-returned file body — not the URL" — implying the server file is trusted. This is a defensible assumption for a local dev tool (you're already reading files from your own project), but should be explicit. If the user opens someone else's untrusted markdown file, the assumption breaks. The design does not address this; the implementation follows the design. Flag as a risk to document, not a bug to fix.
3. **Query-string XSS in viewer.** Handled. All path-derived strings use `textContent` / `document.title` / encoded URL params. Verified by reading `viewer.js`.
4. **Path-traversal.** Enforced server-side at `lib/api/routes.js:170, 208, 228` (`resolved.startsWith(resolvedProject)`). Client correctly surfaces 403 toasts. No client-side sanitization attempted beyond rejecting `~` and `$` — correct.
5. **`projectPath` in query strings is user-controlled.** A malicious bookmark like `/viewer.html?path=/etc/passwd&projectPath=/` would trigger the server's path-traversal check. Verified by reading `routes.js:168–170, 207–208, 227–228`: `resolved.startsWith(resolvedProject)`. If `projectPath=/`, `path.resolve('/')` = `/`, and `path.resolve('/etc/passwd').startsWith('/')` = true. **Server-side bypass confirmed**: `GET /api/fs/read?path=/etc/passwd&projectPath=/` would return the file body. This is a **pre-existing** server-side vulnerability; the file-manager feature did not introduce it (the endpoints shipped before). But the feature now provides a straightforward UI-level way to exploit it: typing `/etc/passwd` into the path input and pressing Enter. Recommended: server-side check also ensures `resolvedProject !== '/'` or walks back to a known project list. **Out of scope for this feature, flagged for triage.**

---

## 4. Error handling gaps

1. **FileContentView loading state cancellation on unmount.** The useEffect returns `controller.abort()` as the cleanup — good. On rapid prop changes the UI flashes "Loading" correctly.
2. **FileContentView does not handle 413/415 distinctly.** Any non-200 yields "Failed to read file" via the thrown Error. The user does not learn whether it was "too large" or "binary" here — only in `FileBrowser.submitPathInput` (path input path). Clicking a binary file in the directory listing and having it silently say "Failed to read file" is a UX regression from the original `FileBrowser` which used `isImageFile` short-circuit. The short-circuit is kept (`FileContentView.js:40`), so images work. But a non-image binary click shows "Failed to read file: Binary file" — the server error message ("Binary file") does propagate via `err.error`. Passable but not pretty.
3. **Viewer page: no 413 / 415 specific handling.** `viewer.js:112–122` collapses all non-2xx into `Failed to load file: <msg> (status N)`. 413 for a 1.1 MB file renders as a generic error. Acceptable.
4. **Network error while loading directory.** `loadDirectory` catches and toasts — good. Error sets entries to `[]`. Breadcrumbs remain pointing at the unreachable path — user may get stuck. Not a design violation.
5. **showError in viewer does not hide `#viewer-header`.** If a path fails, the filename in the header is already set to the basename. User sees "Loading…" replaced with the attempted filename + error block underneath. Minor.

---

## 5. Race conditions and state machine violations

1. **`splitView.value = true` when opening file split (`actions.js:162`).** Good — keeps the `--split-pos` variable active. But `splitView` is independently persisted in localStorage ("splitView" key, `SessionOverlay.js:24`). If the user has `splitView=false` before opening file-split, `openFileSplit` flips it to true without persisting. Next attach of a session, overlay opens in split mode unexpectedly. Minor.
2. **Close session while file-split is not open, then open file-split while still in split mode.** Session overlay is closed, `attachedSessionId=null`, file split renders. `splitView=true` still. Ordering looks fine.
3. **Open file split, then attach a session.** `App.js:92` evaluates `fileSplitTarget.value !== null` first, so file split wins and session overlay does not render. But the session is still attached and `TerminalPane` for that session never mounts — the subscription request from `attachSession` fires but the pane is not rendered to accept the data. When the user closes file-split, session overlay mounts and starts subscribing. Functional but wastes a subscribe cycle. Documented behavior: AC #11 disables the Split button when a session is attached, but does not disable Attach while file-split is open. Design does not cover this direction.
4. **Rapid Enter on path input** — `submitPathInput` is `async` but does not check for in-flight calls. Two quick Enters fire two `/api/fs/read` probes concurrently; whichever resolves last wins. Since there is no AbortController on the probe, late 200s can overwrite newer state. Minor race.
5. **Escape on path input while submission in flight** — does not cancel. Mostly harmless.

---

## 6. Structural debt checks

### 6.1 Dead code
- `fileBrowserOpen` removed — verified no references.
- `FileBrowser.js` original `fileContent/imageUrl/fileError/contentLoading` state correctly moved to `FileContentView`. No leftover imports.
- No unreferenced exports added.

### 6.2 Scattered ownership
- **`isImageFile` appears 3 times** (viewer.js, FileContentView.js, FileBrowser.js), each with the same `IMAGE_EXTENSIONS` Set. Implementation notes item 1 acknowledges. Logical home: `public/js/utils/fileHelpers.js` (sibling to `format.js`). Low severity — drifts silently over time.
- **SessionOverlay hardcodes 20/85**, FileSplitPane uses `SPLIT_MIN/SPLIT_MAX`. See Deviation 3 above.
- **`--split-pos` margin rule duplicated** (`styles.css:703–705` for session-split and `:708–710` for file-split). Identical rules; could be combined as `body.session-split #workspace, body.file-split #workspace { ... }`. Design section 2.3 item 6 prescribes them separately, so the implementation follows the design — structural debt inherited from the design.
- **File split pane geometry**: inline styles on `FileSplitPane.js:49–61` AND rules in `styles.css:713–724`. Redundant (implementation notes item 2 calls out "both kept for clarity" — but clarity cuts both ways; a future change in one will not propagate to the other).

### 6.3 Cleanup completeness
- `loadDirectory` AbortController — good.
- `FileContentView` effect cleanup returns `controller.abort()` — good.
- `FileSplitPane` mousedown handler adds `mousemove` + `mouseup` document listeners, removes them in `onMouseUp` — good. But if the component **unmounts mid-drag** (e.g. user presses Escape in a parent, `closeFileSplit()` fires), the listeners are orphaned. `SessionOverlay` has the same bug already; the port inherits it.
- `body.file-split` class toggled via useEffect — if the App component itself unmounts, the class stays on. Edge case; not normal flow.

### 6.4 Orphaned references
- All new imports resolve. Verified:
  - `App.js:7` `FileSplitPane` — exists.
  - `FileBrowser.js:6` `FileContentView` — exists.
  - `FileBrowser.js:3` `openFileSplit` — exported from actions.
  - `FileSplitPane.js:4` `SPLIT_MIN`/`SPLIT_MAX`/`fileSplitTarget`/`splitPosition` — all exported.
  - `FileSplitPane.js:5` `closeFileSplit` — exported.
  - `ProjectDetail.js:12` `FileBrowser` — exists.
- No orphans detected.

---

## 7. Summary of findings by severity

| # | Severity | Finding |
|---|---|---|
| 1 | **HIGH** | `FileContentView.js` markdown renders raw HTML without `preventDefault` on nested `<a>` clicks — Risk #7 realized in-app (not just in viewer). |
| 2 | MEDIUM | `marked` does not sanitize inline HTML; a hostile `.md` file executes inline `<img onerror>` in both `FileContentView` and `viewer.js`. Inherited from design assumption (local files are trusted). Document as known limitation. |
| 3 | MEDIUM | Pre-existing server-side path-traversal bypass when `projectPath=/` — reachable via path-input and viewer URL. Out of scope but reachable via this feature. |
| 4 | LOW | `SessionOverlay` not refactored to import `SPLIT_MIN`/`SPLIT_MAX`; design said both should import. |
| 5 | LOW | `marked` version pinned to 12.0.0 (design says 12.0.2). |
| 6 | LOW | Path-input Escape does not explicitly re-focus / preventDefault (design 2.8 spec: "focus remains in the input"). |
| 7 | LOW | FileContentView collapses 413/415 into generic "Failed to read file" for non-image binaries clicked from the listing. |
| 8 | LOW | Inline styles + CSS rules duplicated in FileSplitPane. |
| 9 | LOW | `isImageFile`/`IMAGE_EXTENSIONS` duplicated in 3 files. |
| 10 | LOW | Rapid-submit path input race (no probe AbortController). |
| 11 | LOW | Mid-drag unmount in FileSplitPane leaks document listeners (inherited from SessionOverlay). |
| 12 | LOW | `openFileSplit` flips `splitView` without persisting to localStorage. |

---

## 8. Verdict rationale

- All tab / split / viewer / path-input scaffolding is present and correct.
- All design-called-out acceptance criteria have visible code paths.
- Critical gap: the in-app markdown viewer lacks the internal-link guard that was explicitly called out as a risk (7) and false-PASS (F12). This is not a trivial miss — it reproduces the exact failure mode the design warned about.
- Several minor deviations are acknowledged in implementation notes.

**Verdict: PARTIAL.** Not FAITHFUL because finding #1 (a design-risk-mandated guard) is missing from a code path that exists specifically because of this feature. Not DIVERGED because the rest of the feature matches the design and every AC has a corresponding implementation.

Test designs in `03-test-designs.md` exercise this gap and the other observable behaviors.
