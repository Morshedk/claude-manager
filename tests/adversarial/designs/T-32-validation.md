# T-32 Validation: Session List Empty State Message

**Validator role:** Adversarially review design + execution. Find false PASSes.

---

## Three Questions

### 1. Did the test pass?

**YES — GENUINE PASS.**

Observable evidence:
- Correct project name in sidebar: "T32-Project"
- `.sessions-empty` element found with exact text: "No sessions — start one with the button above"
- No error elements or spinners
- "New Claude Session" button present
- Area title correct: "Sessions — T32-Project"

### 2. Was the design correct?

**YES.** The design correctly identified:
- The exact source text from `ProjectDetail.js` line 59
- The `.sessions-empty` CSS class vs `.empty-state` (different elements, different meanings)
- The need to wait for WS connection before clicking project
- The "Select a project" empty state as a different state (no-project-view) that should NOT be confused

The design's false-PASS risk analysis was correct:
- Project not selected: caught by checking `.sessions-empty` specifically (not `.empty-state`)
- Sessions loaded async: mitigated by `page.waitForSelector('.sessions-empty', { timeout: 5000 })`
- Fresh DATA_DIR: no stale sessions possible

### 3. Was the execution faithful?

**YES.** The executor implemented all steps from the design:
1. Waited for WS `connected` status dot before clicking project
2. Clicked `.project-item` to select project
3. Waited for `#sessions-area` to be visible
4. Found `.sessions-empty` with exact text match
5. Checked absence of `.toast-error`, `.error-message`, `.spinner`
6. Verified "New Claude Session" button
7. Checked area title contains both "Sessions" and project name

---

## Adversarial Scrutiny

**Could this be a vacuous pass?**

The test hardcodes the expected text: `'No sessions — start one with the button above'`. This is read directly from the source at `ProjectDetail.js` line 59. If the source text was different, the test would fail. The test confirmed the exact string — not vacuous.

**Could the empty state appear for the wrong reason?**

Only if the sessions list somehow never loaded (defaulting to empty). But the test first selected the project (clicked `.project-item`), then waited for `#sessions-area`. The sessions are delivered via WS — if the session list never came, the project detail might not render. The explicit wait for `#sessions-area` and then `.sessions-empty` handles this.

**Was the project actually selected or was it showing the no-project view?**

The no-project view shows: `<p>Select a project</p>` and `<div id="no-project-view">`. The sessions-empty div is in `#sessions-area` which only renders when a project IS selected. The test checked for `.sessions-empty` specifically (not `.empty-state` from the no-project view). So the project WAS selected.

**Could the empty state have been pre-loaded before project selection?**

No. The empty state `<div class="sessions-empty">` is only rendered inside `#sessions-area` which only renders when `project` is non-null in the Preact component.

**Is "No sessions — start one with the button above" the right product text?**

Yes — confirmed in source: `ProjectDetail.js` line 59: `html\`<div class="sessions-empty">No sessions — start one with the button above</div>\``. The exact text is tested. The Unicode em-dash (—) is in both source and expected string.

---

## Verdict

**GENUINE PASS.** The empty state message renders correctly when a project with no sessions is selected. The exact text matches the source, the correct element class is used, no errors or spinners are present, and the action button is visible. This is the simplest of the four tests, and it is clean.

**Score: 10. Passes.**
