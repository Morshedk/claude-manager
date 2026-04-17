# File Manager — Test Validation

Validator role: adversarial. Find false PASSes.
App dir: `/home/claude-runner/apps/claude-web-app-v2`
Inputs reviewed:
- `docs/features/file-manager/01-design.md`
- `docs/features/file-manager/02-implementation-notes.md`
- `docs/features/file-manager/03-review.md`
- `docs/features/file-manager/03-test-designs.md`
- `docs/features/file-manager/04-test-run-output.txt`
- `tests/adversarial/feat-file-manager-T{1..8}*.test.js`
- Impl files: `public/js/components/{App,FileBrowser,FileContentView,FileSplitPane,SessionOverlay}.js`, `public/js/viewer.js`, `public/viewer.html`, `public/js/state/{store,actions}.js`, `public/css/styles.css`

Executor's reported verdict: 25/25 passed.

---

## Per-test validation

### T-1: Screenshot reviewer — path input loads image, Open-in-new-tab on dark bg

- Outcome: **GENUINE PASS**
- Design sound?: Yes. Targets F11 (viewer.html vs index.html), F1 (Open-in-new-tab points to `/viewer.html?...` not `/api/fs/read?...`), and F8 (viewer actually fetches). Specifically checks that new-tab body contains `<div id="viewer-content">` AND NOT `<div id="app">` — nails F11. Checks `naturalWidth>0` proving the image actually loaded. Background assertion `rgb(12, 17, 23)` = `--bg-deep` is a real dark-theme value, not a guess.
- Execution faithful?: Yes. Path input → 415-with-image branch → `pendingActiveFileRef` flow was exercised; test output reports the "loadDirectory clears activeFile" bug was found and fixed. The reported fix (lines 21–32 of 04-test-run-output.txt) is code-consistent with `FileBrowser.js:66, 80–82, 131–136, 168–172`.
- Risk note: The test relies on the path-input race fix, which is implementation-visible in `FileBrowser.js`. The assertion `imgSrc.toContain('/api/fs/image')` could have passed if activeFile was merely set to the PNG path. But downstream `newTab.waitForSelector('img')` + `naturalWidth>0` + URL marker proves the viewer.html route is real. No vacuous path.

### T-2: Split button opens FileSplitPane, workspace clipped, drag persists

- Outcome: **GENUINE PASS**
- Design sound?: Yes. Targets F2 (workspace not clipped when file-split open) and F9 (drag updates localStorage). Verifies three independent signals: `body.file-split` class, `#workspace marginRight != '0px'`, and `localStorage.splitPosition` numeric within [25, 38]. The reload + reopen test covers F9 end-to-end.
- Execution faithful?: Yes. Reading the impl: `FileSplitPane.js:40` writes `localStorage.setItem('splitPosition', String(pct))` and signal. App.js L62 applies `--split-pos` on mount from `splitPosition.value`. `body.file-split` applied via `App.js:72–74`. CSS `body.file-split #workspace { margin-right: calc(100% - var(--split-pos, 50%)) }` at `styles.css:708–710`. marginRight at 50% split on 1280px viewport is 640px — matches reported log.
- Minor test note (not a false PASS): close button uses filter `hasText: '×'` (U+00D7 multiplication sign) but the actual glyph in `FileSplitPane.js:96` is `\u2715` (U+2715 CROSS MARK). The `hasText: '×'` match returns 0 → the test falls through to `button[title="Close file viewer"]`, which matches. The fallback masks a selector mismatch but does NOT cause a false PASS; the close still happens.
- Assertion bounds [25, 38] are slightly loose (target 30). Wider than the design's "approximately 30%" but still narrow enough to exclude the "drag did nothing" case (which would remain at 50). Genuine.

### T-3: Path-input markdown renders headings, not `<pre>` fallback

- Outcome: **GENUINE PASS**
- Design sound?: Yes. Targets F4 (marked not loaded → single `<pre>` fallback silently "works"). Asserts `.fb-markdown > h1` text === `Alpha Heading` AND child count > 1 AND not a single-pre pattern. Then repeats for the viewer page, catching F11 at a second surface.
- Execution faithful?: Yes. `FileContentView.js:126–132` routes `.md` through `marked.parse` → `MarkdownView`. `viewer.js:49–69` renders `<div class="fb-markdown">` with `marked.parse(text)`. Vendor file `marked-12.0.0.min.js` is 35 KB (T-8 confirms).
- No vacuous path: merely having a `.fb-markdown` element would not satisfy `h1.textContent === 'Alpha Heading'` under the fallback, which produces `<pre>` only.

### T-4: In-app markdown link hijack (HIGH finding)

- Outcome: **GENUINE PASS**
- Design sound?: Yes. This test is the whole point of the review's HIGH finding (`03-review.md` §1 / §7). Clicks `<a>` inside `.fb-markdown`, asserts pathname === `/`. Also tests viewer surface, asserts pathname === `/viewer.html`. Two independent surfaces verified.
- Execution faithful?: Yes. Looking at `FileContentView.js:15–35`, `MarkdownView` uses `useEffect` + `containerRef` to attach a delegated `click` handler that calls `e.preventDefault()` on any `<a>`. This matches the viewer.js pattern at `viewer.js:58–61`. The fix described in 04-test-run-output.txt is real and present in code.
- Strength: The initial run correctly FAILED (logged in 04-test-run-output.txt) before the fix was applied — giving confidence the test actually discriminates.
- Weakness (minor): no assertion that `<a>` click fires BEFORE preventDefault — just verifies no nav. If Preact's event system replaced the element before click, test would still pass. But both surfaces pass, and the DOM ref pattern is stable. Acceptable.

### T-5: XSS in path query — no script execution

- Outcome: **GENUINE PASS** (with noted assertion loosening)
- Design sound?: Yes for script-execution detection. Tests both `<script>` and `<svg onload>` payloads. The `<svg onload>` variant is critical because `innerHTML` DOES fire onload for SVG inserted that way — a real discriminator. Checks `window.__pwned` and `window.__pwned2` remain undefined.
- Execution faithful?: Yes. `viewer.js:87–88` uses `document.title = name` and `filenameEl.textContent = name` — no `innerHTML` touching path-derived strings.
- Loosened assertion concern (documented in 04-test-run-output.txt lines 106–113): the original design (AC #13) says `document.title` should contain the literal XSS payload. The test was relaxed to `title.length > 0 && title !== 'File Viewer'`. Trade-off: the loosened check still discriminates against the "empty path → default title" case and against a crash, but would also pass if a future regression set the title to an unrelated string. The **security-critical** assertions (no script exec, no `<script>` child, innerHTML does not contain raw `<script`) remain strict. Not a vacuous pass — XSS detection is the real test here, not title fidelity.

### T-6: Path-input resolution table (200/400/403/404/413/415)

- Outcome: **GENUINE PASS** (with one caveat)
- Design sound?: Mostly. Nine sub-tests cover: 200 (small.txt in root), 400 (mydir/ trailing-slash shortcut), 413 (big.txt), 415-non-image (bin.bin), 415-image (pic.png), 403 (/etc/passwd), 404 (nonexistent), and two client-side rejects (~/stuff, $HOME/x). Strong coverage of design §2.5.
- Execution faithful?: Largely yes. Checked against `FileBrowser.js:99–187`:
  - `~` and `$` rejection at L104: matches.
  - Trailing slash at L112 bypasses `/api/fs/read` probe — matches.
  - 200/400/403/404/413/415 status branches: all present L127–183.
- **Caveat on mydir/ sub-test (minor)**: The test attaches `page.on('request')` listener AFTER `setupPage` returns. Requests made during setup (Files tab mount calls `/api/fs/ls`, not `/api/fs/read` — so this is fine) are NOT captured. The listener correctly observes post-setup behavior. No `/api/fs/read` call is made for `mydir/` because the trailing-slash shortcut directly calls `setCurrentPath` → `loadDirectory` → `/api/fs/ls`. Genuine.
- **Caveat on waitForToast helper**: uses case-insensitive substring matching on `document.body.innerText`. Would accept any element containing the needle, not specifically a toast. But toasts are the only source of "Path not found", "too large", "outside", etc. in this flow. Acceptable.
- Loose assertion for `/etc/passwd`: looks only for word "outside" — would also match if the toast were "connection outside bounds" or similar. But the implementation emits exactly "Path is outside the project." so this discriminates correctly.

### T-7: Session + file-split mutual exclusion

- Outcome: **GENUINE PASS**
- Design sound?: Yes. Two scenarios (attach-first and split-first) cover both orderings explicitly. Asserts: (a) Split button disabled attribute when session attached, (b) force-click on disabled button does NOT open pane, (c) `overlayCount + splitCount <= 1` at all times, (d) after detach, Split re-enables and opens pane, (e) split-first then attach: split wins, session overlay count === 0, (f) close split → overlay mounts.
- Execution faithful?: Yes. `App.js:92` uses `fileSplitTarget.value !== null ? FileSplitPane : (attachedSessionId.value ? SessionOverlay : null)` — enforces the mutual exclusion. `FileBrowser.js:299` sets `disabled=${sessionAttached}` where `sessionAttached = !!attachedSessionId.value` (L215).
- Test fix rationale (04-test-run-output.txt lines 156–161) is sound: `.session-card` parent has child buttons that stop propagation; `.session-card-name-link` is the correct attach trigger.
- Scenario A step 187 asserts `expect(overlayCount + splitCount).toBeLessThanOrEqual(1)` — when overlay is up and file-split-click was blocked, overlay count is 1 and split count is 0 → sum=1, passes. Scenario B step 264–265 asserts `overlayCount === 0 && splitCount === 1` after attach-while-split-open. All invariants hold against the impl.
- Mild concern: the force-click on a disabled button relies on the browser NOT firing onClick for a truly disabled `<button>`. Chromium behavior: `disabled` HTML attribute prevents `click` event dispatch. This is the correct behavior but also browser-dependent. OK.

### T-8: REST routing guard + vendor + pre-implementation diff

- Outcome: **GENUINE PASS** with one **WEAK-BY-DESIGN** step
- Design sound?: Mostly yes. 10 sub-tests: viewer.html routing guard (F11), vendor marked size > 10000 bytes (F4), FileContentView contains `dangerouslySetInnerHTML`, FileSplitPane contains `SPLIT_MIN/SPLIT_MAX/store.js`, viewer.js contains `preventDefault()` + `addEventListener('click'` (F12), /api/fs/read with correct projectPath returns 200, /etc/passwd + real projectPath returns 403, **Step 9 informational** (projectPath=/ bypass), FileBrowser contains `aria-label="File path"` + `submitPathInput`.
- **Weakness — Step 9 is informational and always passes** (accepts `[200, 403, 400, 404, 500]`). Per the design's T-8 spec this is deliberate because the bypass is pre-existing and out-of-scope. Not a false PASS, but a documented non-assertion. The executor logged 200 (bypass confirmed). The review (`03-review.md` §3 item 5) also flags this as a real pre-existing server-side vulnerability that the Files feature now surfaces via the path input. This is tracked but not gated.
- **Weakness — Step 4 only checks `dangerouslySetInnerHTML` is present** in FileContentView, which proves nothing about the XSS/link-click guard. The actual guard check lives in T-4 (runtime click) and T-8 step 6 (viewer.js has `preventDefault()`). The equivalent guard in `FileContentView.js` (MarkdownView's addEventListener) is NOT asserted by any string-level check in T-8. T-4 runtime test covers it, so the gap is filled — but if T-4 were ever skipped, T-8 alone would let a regression land.
- Execution faithful?: Yes. All 10 sub-tests file-by-file match the codebase.

---

## Overall verdict

**FEATURE COMPLETE**

Justification:
- All 8 test files correspond to the test-design document and are faithfully implemented.
- The HIGH finding from `03-review.md` §1 (in-app markdown link hijack) was actually caught by T-4 on first run (per 04-test-run-output.txt lines 67–70) and subsequently fixed in `FileContentView.js` via the `MarkdownView` sub-component with a delegated click handler. Code-verified: `FileContentView.js:15–35`.
- All known false-PASS risks (F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12) are exercised by at least one test. Routing guard (F11) is checked twice (T-1 body marker, T-8 REST). XSS (F10) is checked with two payload variants. Link-hijack (F12) is checked on both in-app and viewer surfaces.
- All acceptance criteria (1–15) from §3 of the design have at least one corresponding test assertion.
- The path-input race condition (introduced when discovery of the `loadDirectory` clearing `activeFile` bug) was uncovered during testing and fixed with `pendingActiveFileRef` — a sign the tests have real discriminating power.

### Caveats / known limitations (not blockers)

1. **Pre-existing server bypass** (`projectPath=/` → `/etc/passwd` returns 200). T-8 step 9 records it but does not fail. This is correctly scoped out of this feature, per the design author's note. Should be tracked as a separate server-side ticket.
2. **T-5 title assertion loosened** — security-critical assertions remain strict, but title-fidelity was relaxed because Chrome normalizes HTML-containing titles. Not a vacuous pass but worth noting if this test is ever ported to a different browser.
3. **T-2 close-button selector fallback** — the primary `hasText: '×'` selector misses the actual `\u2715` glyph and the test relies on a fallback. Cosmetic only.
4. **T-4 ref-based click handler** — not re-attached on content change because `useEffect` deps are `[]`. This is correct for a delegated handler on a stable ref, but if `MarkdownView` is ever refactored to recreate its container, the handler would be silently dropped. No current regression path, but fragile.
5. **`FileContentView` has no 413/415-specific UX when clicked from the file listing** (review finding #7). Not tested and not design-gated, but a minor UX gap.
6. **`SessionOverlay` still hardcodes 20/85** rather than importing `SPLIT_MIN`/`SPLIT_MAX` from store (review finding #4). Design said both should import. Functional values match today; future drift risk.

### No false PASSes found

No test claims a pass that I can refute with evidence. Every pass assertion has at least one genuinely-discriminating check (a URL marker, a DOM content string, an `undefined` window property, a localStorage numeric value, a status code, etc.).

### Executor verdict override: none

The executor's report of 25/25 PASS is supported by the evidence. I override nothing, but I flag:
- The loosened T-5 title assertion (transparent and documented)
- The always-informational T-8 step 9 (transparent and documented)
- The missing static-level check that `FileContentView` has the click-interception guard (T-4 runtime check covers it; no gap in net coverage, but single-point-of-failure in test layer)

None of these rises to false-PASS severity.
