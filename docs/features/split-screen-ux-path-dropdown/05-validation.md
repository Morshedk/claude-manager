# Validation Report: Split Screen UX + Path Dropdown

Validator: TEST VALIDATOR agent
Date: 2026-04-09
Codebase: /home/claude-runner/apps/claude-web-app-v2

---

## T-1: Path dropdown shows existing project paths

### 1. Outcome valid? GENUINE PASS

The test creates two real projects via REST API (with real directories on disk), opens the NewProjectModal, and asserts that `#project-paths-datalist` exists, contains at least 3 options (both full paths + parent directory), and survives typing a prefix into the input. I verified the implementation in `NewProjectModal.js` (lines 55-60, 110-118): the datalist is sourced from `projects.value`, deduplicates paths, and includes parent directories via `lastIndexOf('/')`. The assertions match the actual DOM structure.

### 2. Design sound? Yes

The test checks datalist existence, option count, specific path values, and parent directory inclusion. It would catch: missing datalist element, empty options, failure to include parent dirs, and stale options after typing. The test correctly discovered that the server validates paths exist on disk (initial attempt with fake paths returned 400), which is a genuine infrastructure finding.

### 3. Execution faithful? Yes

The test code matches the design spec exactly: creates 2 projects, opens modal, checks datalist options for both paths + parent, types prefix and re-checks. The executor's fix (using real directories under tmpDir) was necessary and correct.

---

## T-2: New session opens in split view by default

### 1. Outcome valid? GENUINE PASS

The test clears localStorage, reloads, creates a session, and verifies: (a) `#session-overlay` left position is ~50% of viewport (not 0), (b) `body.session-split` class is present, (c) `#workspace` margin-right > 0. I verified the implementation in `store.js` line 57-62: `readSplitView()` returns `true` when localStorage key is absent (`v === null || v === 'true'`). The App.js useEffect at lines 64-67 toggles `body.session-split` based on `splitView.value && !!attachedSessionId.value`. The CSS at line 623-624 applies `margin-right: calc(100% - var(--split-pos, 50%))` to `#workspace`.

The test output confirms: overlay.left = 640px (50% of 1280), body.session-split present, workspace margin-right = 640px. These values are internally consistent and correct.

### 2. Design sound? Yes

The test checks three independent signals of split mode: overlay position, body class, and workspace clipping. This is robust -- checking only overlay position could yield a false pass if the workspace wasn't clipped (the exact false-PASS risk #1 identified in the design doc). The 15% tolerance on overlay left is generous but acceptable since the exact value depends on CSS variable computation.

### 3. Execution faithful? Yes

The test follows the design flow: clear localStorage, reload, create session via UI, wait for overlay, read computed styles. The executor discovered that the project path must exist on disk (same as T-1) and that session overlay auto-opens after creation (no card click needed). Both are genuine infrastructure findings. The command override to `bash` (instead of `claude`) ensures fast startup.

---

## T-3: Split position drag and persist across reload

### 1. Outcome valid? GENUINE PASS

The test drags the `.split-resize-handle` from ~50% to 30% of viewport, then verifies: `--split-pos` CSS variable, localStorage value, overlay left position, and workspace margin-right. After reload, it re-opens the session and verifies the position persisted. I verified the implementation:

- `SessionOverlay.js` lines 30-53: drag handler clamps to 20-85%, sets `--split-pos` directly during drag, updates signal + localStorage on mouseup.
- `App.js` lines 59-61: useEffect sets `--split-pos` from `splitPosition.value` on mount.
- `styles.css` line 628-630: `.split-resize-handle` positioned at `left: var(--split-pos, 50%)`.

The test output confirms: post-drag `--split-pos` = "30%", localStorage = 30, overlay.left = 384px (30% of 1280), after reload `--split-pos` still "30%". All internally consistent.

### 2. Design sound? Yes

The test verifies four dimensions of correctness: CSS variable, localStorage, overlay position, workspace margin. It then verifies persistence across reload -- this catches false-PASS risk #4 from the design doc (position persists but not applied on load). The tolerance values (5% of viewport for position, 3% for reload comparison) are reasonable.

### 3. Execution faithful? Yes

The test uses Playwright mouse.move with `{ steps: 20 }` for smooth drag simulation. The executor discovered sessions must be created via WebSocket (not REST API), which is a genuine infrastructure finding. The `createSessionViaWS` helper is correctly implemented.

One minor observation: the test drags to 30% (above the 20% minimum clamp), so it does not specifically test the clamping behavior on the low end. T-6 covers that gap.

---

## T-4: Terminal scrollbar appears on hover

### 1. Outcome valid? GENUINE PASS -- with a caveat

The test checks three things: (a) `.xterm-viewport` computed `scrollbar-width: thin`, (b) CSS rule existence for `.xterm-viewport` with `scrollbar` in the rule text, (c) `.xterm:hover .xterm-viewport` rule existence. All three passed.

I verified the implementation in `styles.css`:
- Line 664: `.xterm-viewport { scrollbar-width: thin; scrollbar-color: transparent transparent; }`
- Line 669: `.xterm:hover .xterm-viewport { scrollbar-color: rgba(255,255,255,0.15) transparent; }`
- Lines 672-681: WebKit pseudo-element rules.

The **caveat**: this test does NOT verify that the scrollbar thumb actually becomes visible on hover. It only verifies that CSS rules exist and that `scrollbar-width: thin` is computed. The `scrollbar-color` change on hover (from `transparent transparent` to `rgba(255,255,255,0.15) transparent`) is verified only as a CSS rule existence check, not as a computed style change. In Chromium (Playwright's browser), `scrollbar-color` is not a standard computed property; the WebKit pseudo-elements are what actually render. The test checks rule existence but does not verify the visual effect.

This is not quite a VACUOUS PASS because the CSS rules DO exist and WOULD produce the correct behavior. But it is weaker than a visual assertion. The design doc acknowledged this limitation (Check 7 says "verify the CSS rule exists in the stylesheet").

### 2. Design sound? Adequate but limited

The test checks rule existence rather than visual effect. This is acceptable for scrollbar styling because computed style inspection of scrollbar pseudo-elements is unreliable across browsers. A visual regression test (screenshot comparison) would be stronger. The review doc (03-review.md) noted the WebKit vs Firefox discrepancy (issue #1), which this test does not catch since it runs only in Chromium.

### 3. Execution faithful? Yes

The test matches the design spec exactly, including the stylesheet-scanning `page.evaluate`. Passed on first attempt.

---

## T-5: Sidebar and sessions area resize handles functional

### 1. Outcome valid? GENUINE FAIL

The test output reports: sidebar resize PASSED (delta=80), sessions resize FAILED (delta=0). The executor's root cause analysis states that `App.js useEffect([])` fires at mount before `#resize-sessions` exists in the DOM.

**However, I found a discrepancy.** The current working tree contains a fix in `ProjectDetail.js` (lines 23-29) that wires `initResize` to `#resize-sessions` with `[selectedProjectId.value]` as the dependency. This fix was added as part of the uncommitted changes (confirmed via `git diff`). The fix correctly addresses the root cause: it runs the wiring AFTER the project is selected, when the DOM elements exist.

Two possibilities:
1. The fix was added AFTER the test was executed. The test correctly found a real bug, the executor documented the root cause accurately, and someone subsequently added the fix to ProjectDetail.js. In this case the test result is a GENUINE FAIL of the pre-fix implementation, and the fix should be re-tested.
2. The fix was in place when the test ran but has a subtle bug. This is unlikely: the `initResize` function is identical, the DOM query targets are identical, and the useEffect dependency is correct.

I believe scenario (1) is correct. The test ran, found a real bug, and the fix was applied afterward. **The fix has not been re-tested.** This is a gap.

Additionally, even with the ProjectDetail.js fix, there is redundant code in `App.js` lines 73-80 that also attempts to wire `#resize-sessions` / `#sessions-area`. This code always gets null (because it runs before any project is selected) and is effectively dead code. It should be removed to avoid confusion, but it does not cause harm.

### 2. Design sound? Yes

The test correctly tests both resize handles with drag interaction (not just CSS inspection), measures pixel deltas, and checks for `#terminals-area` minimum height. It would catch dead handles, which is exactly what it did.

### 3. Execution faithful? Yes

The test code matches the design spec. The assertion was not watered down -- the executor reported the FAIL honestly and identified the correct root cause.

---

## T-6: Adversarial -- splitPosition localStorage poisoned with out-of-range value

### 1. Outcome valid? GENUINE PASS

The test poisons localStorage with `splitPosition=5`, reloads, and verifies: (a) the poisoned value IS applied (overlay at ~5% of viewport), (b) after dragging to 50%, the drag handler clamps correctly, (c) corrected value persists after reload.

I verified the implementation:
- `store.js` `readSplitPosition()` (lines 66-75): parses float, no clamping. Value of 5 passes through.
- `SessionOverlay.js` line 38: `Math.min(85, Math.max(20, ...))` clamps during drag.
- `SessionOverlay.js` line 47-49: clamped value written to signal and localStorage on mouseup.

The test output confirms: initial overlay at 64px (5% of 1280), after drag to 50% the localStorage reads 50 and overlay at 640px, after reload still at 50%. This correctly documents the no-clamp-on-read gap identified in the review (03-review.md issue #6) and verifies the self-healing behavior.

### 2. Design sound? Yes

This is a well-designed adversarial test. It tests a specific gap identified by the reviewer and verifies both the failure mode and the recovery mechanism. The test is designed to pass regardless of whether clamping-on-read is added later (it checks the actual position rather than asserting it MUST be 5%). The self-correction verification is the key assertion.

### 3. Execution faithful? Yes

The test matches the design spec. Passed on first attempt.

---

## Overall Verdict

**FEATURE PARTIAL**

### Summary

| Test | Verdict | Notes |
|------|---------|-------|
| T-1 | GENUINE PASS | Path dropdown working correctly |
| T-2 | GENUINE PASS | Default split view working correctly |
| T-3 | GENUINE PASS | Split drag + persist working correctly |
| T-4 | GENUINE PASS | Scrollbar CSS rules present (visual effect not directly verified) |
| T-5 | GENUINE FAIL | Sessions resize handle not wired at test time; fix now in ProjectDetail.js but untested |
| T-6 | GENUINE PASS | Adversarial poisoned localStorage handled correctly |

### Findings

1. **T-5 fix exists but is untested.** The `ProjectDetail.js` useEffect fix (lines 23-29) correctly addresses the root cause. However, this fix was applied after the test run and has not been verified by re-running T-5. The fix should be re-tested before declaring the feature complete.

2. **Redundant dead code in App.js.** Lines 73-80 of `App.js` attempt to wire `#resize-sessions` / `#sessions-area` via `initResize`, but these elements never exist at mount time. This code is dead and redundant with the `ProjectDetail.js` fix. It should be removed.

3. **No `user-select: none` during drag.** Neither the split drag handler (`SessionOverlay.js`) nor the resize utility (`dom.js` `initResize`) suppress text selection during drag. This causes visual jank when dragging across text content. Low severity but a UX polish gap.

4. **No input clamping on `splitPosition` read from localStorage.** As documented by T-6, a poisoned value (e.g., 5%) is applied on load without clamping. Self-corrects on first drag interaction, but the initial render with an extreme value could confuse users.

5. **T-4 scrollbar test is CSS-rule-existence only.** The test verifies rules exist in stylesheets but does not verify visual rendering. This is the weakest of the 5 passing tests, though it is adequate for CSS-only changes where the rules themselves are the implementation.

6. **No security issues found.** All user inputs are Preact-escaped. localStorage access is try/catch wrapped. No path traversal risk (client-side datalist only).

### Recommendation

Re-run T-5 against the current working tree to verify the `ProjectDetail.js` fix. If it passes, the verdict upgrades to FEATURE COMPLETE (with the minor polish items noted above as non-blocking). If it fails, investigate whether the dual `initResize` calls (App.js + ProjectDetail.js) create a conflict.
