# File Manager — Plan Review (Round 2)

Reviewer role: independent adversarial reviewer (did not author the design).
Design reviewed: `/home/claude-runner/apps/claude-web-app-v2/docs/features/file-manager/01-design.md`
App directory: `/home/claude-runner/apps/claude-web-app-v2`
Previous review: `/home/claude-runner/apps/claude-web-app-v2/docs/features/file-manager/01-plan-review.md` (round 1, now overwritten)

---

## Verdict: APPROVED

Every one of the 11 items flagged in round 1 has been resolved in the design. The design is substantive across all 5 required sections, every file:line citation I spot-checked is accurate against the v2 codebase, acceptance criteria are observable, lifecycle stories read as user journeys, and failure-mode / false-PASS coverage is comprehensive (13 risks + false-PASS items between Sections 2.6 and 5). An implementer can take this design and ship it without needing additional clarification.

---

## 1. Regression check — were the 11 round-1 items fixed?

| # | Round-1 issue | Resolution in design | Status |
|---|---|---|---|
| B1 | `/viewer` routing would fall through to `app.get('*')` catch-all | Section 2.3 item 7 pins URL to `/viewer.html` (served by `express.static` before the catch-all); Section 2.5 "Open in new tab" step 2 and AC #3 both use `/viewer.html`; documents the alternative (add `app.get('/viewer', …)`) for future revision; false-PASS **F11** explicitly tests a body marker unique to `viewer.html` vs `index.html` | FIXED |
| B2 | Path probe ambiguous for 500 / network error / 400-then-what | Section 2.5 steps 7, 11, 12, 13 cover: 400 → just `setCurrentPath` (no extra `/ls` round-trip), 500 → toast, network failure → toast, other statuses → generic toast with status code; AC #15 asserts this | FIXED |
| G1 | "Disabled or hidden" ambiguity on Split button | Section 2.3 item 2 + AC #11 both commit to **disabled with tooltip** "Close the session overlay to use split-file view" — discoverable, testable | FIXED |
| G2 | `FilePanel.js` — new or optional? | Section 2.2 final paragraph: **"Decision: do NOT build `FilePanel.js`."** `FileBrowser.js` gets the path input + action buttons directly; `ProjectDetail.js` imports `FileBrowser`. Section 2.7 item 11 restates for scope | FIXED |
| G3 | Right-pane render logic duplicated between FileBrowser + FileSplitPane | Section 2.2 item 3 creates **`FileContentView.js`** as a required shared component consumed by both `FileBrowser.js` (right pane) and `FileSplitPane.js` (body). Explicitly non-optional | FIXED |
| G4 | Path-input blur / Escape / Tab behavior unspecified | Section 2.8 adds a dedicated "Path-input keyboard behavior (explicit spec)" sub-section: Enter submits, Escape clears + keeps focus, Blur does not clear, Tab default, `aria-label="File path"` | FIXED |
| G5 | Viewer XSS via `path` query param | Section 2.5 "Open in new tab" step 5 pins `textContent` + `document.title` for all path-derived writes; identifies the only `innerHTML` call site (`.fb-markdown` with server content, not URL); AC #13 tests `<script>` injection; false-PASS **F10** tests `<script>` and `<svg onload>` payloads | FIXED |
| G6 | `marked` version not pinned | Section 2.3 item 8 pins `marked@12.0.2` at `public/vendor/marked-12.0.2.min.js`; risk #4 documents the named-export regression that could silently break the `typeof marked` guard | FIXED |
| G7 | Keyboard accessibility for path input | Section 2.8 covers Enter / Escape / Tab / blur and `aria-label` | FIXED |
| +risks | Markdown internal links, XSS false-PASS, `splitPosition` sharing between modes | Risk #7 (internal-link prevention + `event.preventDefault` in `.fb-markdown`); Risk #8 (viewer XSS); Risk #9 (`splitPosition` shared intentionally, documented as deliberate product decision, not oversight); Risk #10 (reminder against reintroducing two-signals-for-one-state); false-PASS **F10** and **F11** | FIXED |
| cleanup | `fileBrowserOpen` silent deletion + redundant `fileSplitOpen` + `fileSplitTarget` | Section 2.3 item 3 explicitly lists `fileBrowserOpen` (store.js line 100) for deletion; collapses to a single `fileSplitTarget` signal (`null` = closed, non-null = open); shared `SPLIT_MIN` / `SPLIT_MAX` constants in `store.js` extracted so clamp bounds cannot drift between `SessionOverlay.js` and `FileSplitPane.js` | FIXED |

**All 11 items closed.** No carry-over from round 1.

---

## 2. Independent verification — codebase grounding

I re-verified the cited anchors against the v2 codebase (every path absolute below):

| Claim in design | Source of truth | Verified? |
|---|---|---|
| `FileBrowser.js` is 231 lines, inline styles throughout | `/home/claude-runner/apps/claude-web-app-v2/public/js/components/FileBrowser.js` | YES — 231 lines |
| `fileBrowserOpen` at `store.js:100`, unread | `/home/claude-runner/apps/claude-web-app-v2/public/js/state/store.js:100` (`export const fileBrowserOpen = signal(false);`) | YES |
| `/api/fs/ls` @ `routes.js:165`, `/api/fs/read` @ 203, `/api/fs/image` @ 223, section comment @ 142, closing bracket @ 240 | `/home/claude-runner/apps/claude-web-app-v2/lib/api/routes.js` lines 142–240 | YES — all four endpoints verified; "Not a file" at `routes.js:212` confirmed |
| `splitView` at `store.js:63`, `splitPosition` at `76` | `store.js` | YES |
| `body.session-split` toggled by `App.js:65–68` | `/home/claude-runner/apps/claude-web-app-v2/public/js/components/App.js` | YES (`document.body.classList.toggle('session-split', inSplit)`) |
| `--split-pos` set at `App.js:60–62` | `App.js` | YES |
| Workspace clip rule at `styles.css:702–705` | `/home/claude-runner/apps/claude-web-app-v2/public/css/styles.css` | YES (`body.session-split #workspace { margin-right: calc(100% - var(--split-pos, 50%)) }` — verbatim at 703–705) |
| `.split-resize-handle` CSS at `styles.css:707–735` | `styles.css` | YES |
| SessionOverlay drag logic at `SessionOverlay.js:28–54`, clamp 20/85 at lines 38 and 47 | `/home/claude-runner/apps/claude-web-app-v2/public/js/components/SessionOverlay.js` | YES — `Math.min(85, Math.max(20, …))` at both lines |
| Tab bar at `ProjectDetail.js:73–91` | `/home/claude-runner/apps/claude-web-app-v2/public/js/components/ProjectDetail.js` | YES — Sessions/Watchdog/TODOs buttons |
| `activeTab` state at `ProjectDetail.js:20` | `ProjectDetail.js` | YES (`const [activeTab, setActiveTab] = useState('sessions');`) |
| `initResize(handle, 'v', ..., { min: 60, max: 800 })` at `ProjectDetail.js:28` | `ProjectDetail.js` | YES |
| `initResize` with axis `'h'`/`'v'` at `dom.js:54–90` | `/home/claude-runner/apps/claude-web-app-v2/public/js/utils/dom.js` | YES |
| `App.js:86` renders SessionOverlay only when `attachedSessionId.value` truthy | `App.js` | YES (the design proposes adding a sibling expression for `FileSplitPane`) |
| `marked` referenced at `FileBrowser.js:210`, NOT loaded in `index.html` | `/home/claude-runner/apps/claude-web-app-v2/public/index.html` (41 lines total — only `xterm` vendor scripts + importmap) | YES — `marked` is absent from `index.html`; `public/vendor/` has only xterm assets |
| `isImageFile` at `FileBrowser.js:75` | `FileBrowser.js:75` | YES (inside `loadFile`, before setting `imageUrl`) |
| `server.js` `express.static` at line 43, catch-all at line 49 | `/home/claude-runner/apps/claude-web-app-v2/server.js` | YES |
| `actions.js` already exists and is the natural home for `openFileSplit` / `closeFileSplit` | `/home/claude-runner/apps/claude-web-app-v2/public/js/state/actions.js` (has `attachSession`/`detachSession` at lines 105–115 as the precedent pattern) | YES |

**Citation accuracy is unusually high.** Every spot-check passed. The design does not invent anchors.

---

## 3. Completeness — all 5 sections present and substantive?

- **Section 1 (Problem & Context)** — 3 concrete user frictions + 7-item inventory of existing code assets + 6 gaps. Substantive.
- **Section 2 (Design Decision)** — 8 sub-sections (2.1 overview, 2.2 files to create, 2.3 files to modify, 2.4 split-pane handle, 2.5 data flow, 2.6 edge cases, 2.7 scope non-goals, 2.8 keyboard spec). Substantive.
- **Section 3 (Acceptance Criteria)** — 15 numbered criteria, each given/when/then structured, observable. Substantive.
- **Section 4 (User Lifecycle Stories)** — 5 stories covering distinct user journeys (screenshot review, side-by-side terminal, power-user path paste, multi-file investigation, image browsing). Substantive, and these *are* real user journeys — not a feature dump.
- **Section 5 (Risks & False-PASS)** — 10 risks + 11 false-PASS risks. Substantive.

All 5 sections present, all substantive.

---

## 4. File:line specificity — exact citations for every file to be modified?

Every file in Section 2.3 has line-number anchors tied to the modification:

- `ProjectDetail.js` — line 20 (state), 73–91 (tab bar), 93–108 (content switch), plus a top-of-file import
- `FileBrowser.js` — lines 126–139 (header), 174–190 (content header), ~193–224 (right-pane body)
- `store.js` — line 100 (delete `fileBrowserOpen`), new signal + constants added after
- `actions.js` — no line number (pure additions; the file is enumerated and the additions are named)
- `App.js` — line 13 (import), 65–68 (effect), 86 (render)
- `styles.css` — specific new rules named (`.fb-path-input`, `.file-split-pane`, `body.file-split #workspace`)
- `server.js` — decision tree: no modification required because URL is `.html`; if the decision is reversed, the exact location (immediately before line 49) is documented
- `index.html` — specific insertion: `<script src="/vendor/marked-12.0.2.min.js">` before the importmap

New files (`viewer.html`, `viewer.js`, `FileContentView.js`, `FileSplitPane.js`) reasonably lack line numbers because they don't exist; the design gives each a role description and (for `viewer.js`) a rough size estimate ("a single `main()` of ~60 lines with one branch per file type").

**Specificity meets the bar.**

---

## 5. Acceptance criteria — observable?

Spot-check on the trickier ones:

- **AC #3a** — "`.fb-markdown` container contains at least one `<h1>` (or `<p>`) element produced by `marked.parse` — not a single `<pre>` child" — observable via `document.querySelector('.fb-markdown > h1')`.
- **AC #3b** — "the markdown body is displayed as line-numbered monospace text inside a single `<pre>`" — observable.
- **AC #6** — "on mouseup `localStorage.setItem('splitPosition', ...)` is called (same behavior as SessionOverlay line 49)" — observable via a spy or by reading `localStorage.getItem('splitPosition')` post-drag (AC #12 exercises this directly).
- **AC #11** — "Split button is **disabled**" with specific tooltip text — observable via DOM attribute check.
- **AC #13** — XSS resistance — observable by URL-crafting + DOM inspection.
- **AC #15** — path-input error taxonomy (500, network, other) — observable by toast assertion.

All AC items are observable. No "feels right" or "renders nicely" loopholes.

---

## 6. Lifecycle stories — user journeys, not feature dumps?

- **Story 1 (Screenshot reviewer)** — external motivation (QA engineer, Playwright screenshots, visual regression). Story ties path-input + image preview + open-in-new-tab together as one user flow. User journey.
- **Story 2 (Side-by-side reviewer)** — motivated by "verify the file matches what Claude described," not "let's click the split button." User journey.
- **Story 3 (Path-is-in-my-head developer)** — central motivation is typing a known path. Verifies markdown rendering (heading + lists) incidentally. User journey.
- **Story 4 (Multi-file investigator)** — realistic API-debug workflow; ends with the user with three browser tabs and a plausible mental model. User journey.
- **Story 5 (Image-curious user)** — plot iteration loop. User journey.

One gap worth flagging as a nice-to-have (not a blocker): there's no explicit story for the **error path** — "user pastes a bad absolute path, gets a toast, recovers." This is covered at AC + risk layers (AC #9, #10, #15) but a user-facing story would reinforce that error handling is not a polish item. Not blocking since AC coverage is adequate.

---

## 7. Failure-mode + false-PASS coverage

Section 5 lists **10 risks** and **11 false-PASS risks**. I did an independent pass looking for uncovered failure modes:

Covered:
- Viewer page pulling in app bundle by accident (risk 1)
- `body.file-split` + `body.session-split` fighting (risk 2, false-PASS 5)
- Dead signal cleanup (risk 3)
- `marked` version drift (risk 4)
- Path classification mis-heuristic (risk 5)
- AbortController race (risk 6)
- Markdown internal-link navigation to catch-all (risk 7)
- Viewer page XSS from query params (risk 8, AC #13, false-PASS 10)
- `splitPosition` sharing (risk 9)
- Two-signals-for-one-state reintroduction (risk 10)
- "Open in new tab" silently pointing at raw endpoint (false-PASS 1)
- Split pane rendering without workspace clipping (false-PASS 2)
- Path input working only for `currentPath`-local entries (false-PASS 3)
- Markdown falling back to `<pre>` in offline test (false-PASS 4)
- Disabled-but-not-really Split button (false-PASS 5)
- Wiring disconnect between path submit and content pane (false-PASS 6)
- Binary file showing blank (false-PASS 7)
- Viewer page loads but fetches nothing (false-PASS 8)
- Split handle in file mode not persisting (false-PASS 9)
- XSS test only with safe paths (false-PASS 10)
- Catch-all serving `index.html` under `/viewer.html` (false-PASS 11)

Candidates I considered but found already covered or out-of-scope:
- **Encoded path like `%2E%2E%2F..`** — covered by the server-side `resolved.startsWith(resolvedProject)` guard at `routes.js:170`/`208`/`228`. Design inherits this correctly.
- **Unicode normalization in `document.title`** — accepting it as out of scope; `document.title` setter is safe HTML-wise and Unicode LTR/RTL overrides in window titles are a widely-accepted browser-layer concern, not an app XSS hole.
- **Parallel `Open in new tab` + session attachment** — single-tab scope; if the user attaches a session in the main tab after opening `/viewer.html?…` in another, the viewer tab is independent (no WS, no shared state). Correctly out of scope.
- **Concurrent Split + Open-in-new-tab on the same file** — not a conflict, they operate on orthogonal surfaces.
- **`viewer.js` loaded while offline** — covered by "graceful degrade to `<pre>`" (risk 4 + edge case 13).

Coverage is thorough. No uncovered high-priority failure modes.

---

## 8. Specificity / implementer-readiness check

- **Decision log**: the design explicitly re-documents each round-1 resolution in-line (e.g. "Decision: do NOT build `FilePanel.js`", "Decision: option (i)" for the split handle, "Decision: URL is `/viewer.html`, not `/viewer`"). An implementer does not have to guess which of two alternatives to pick.
- **Shared constants**: `SPLIT_MIN` / `SPLIT_MAX` exposed from `store.js` avoids the round-1 "20/85 copy-paste" risk.
- **Scope boundaries (Section 2.7)**: 12 items. Unusually thorough. Notably closes the round-1 `FilePanel` ambiguity (item 11) and the markdown-internal-link question (item 12) at the scope layer as well.
- **Out-of-band concerns named explicitly**: server route non-change (2.3 item 7), marked version pin (2.3 item 8), shared-constant extraction (2.3 item 3 final bullet), `FileContentView` extraction (2.2 item 3).

---

## 9. Minor (non-blocking) observations

These are style-level comments for the implementer, not blockers:

- **Files tab persistence across project switches** — design does not state whether `currentPath` survives a `selectProject()` call. Most implementations of a local `useState` inside `FileBrowser` will reset it on unmount, which is probably the intended behavior. An implementer will pick the `useState` default and move on; noting this here so a reviewer of the final test plan can confirm.
- **`fileSplitTarget.path` vs `fileSplitTarget.path` + signal equality** — because `fileSplitTarget.value = { path, projectPath }` creates a new object each time, a subsequent `openFileSplit(samePath, sameProj)` will re-trigger effects unnecessarily. Not a correctness issue. If performance matters, deduplication by string comparison could help; adding here as a note for the implementer, not as a design change.
- **No story covering the error path** (flagged in Section 6 above) — consider adding a 6th lifecycle story for symmetry with the AC #9/#10/#15 error cases. Optional.

None of these change the APPROVED verdict.

---

## 10. Summary

Round 1 flagged 2 blockers and 9 substantive gaps. All 11 are resolved with explicit, reviewable decisions. The round-2 design:

- Uses accurate file:line citations (spot-checked against the v2 codebase at every site I examined).
- Commits to single options where round 1 found ambiguities.
- Extracts a `FileContentView` shared component and `SPLIT_MIN`/`SPLIT_MAX` constants to avoid copy-paste drift.
- Covers XSS explicitly at design, AC, and false-PASS layers.
- Pins `marked` version and vendor filename.
- Documents the `server.js` routing decision and its alternative.
- Closes the `FilePanel` / `fileBrowserOpen` / two-signals ambiguities decisively.

**Verdict: APPROVED.** Hand to an implementer.
