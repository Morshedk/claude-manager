# Plan Review: Session Card Portrait Preview

Date: 2026-04-09
Reviewer role: Independent adversarial plan reviewer (did not write this design)

## Verdict: QUESTIONS_FOR_USER

The design is internally consistent, well-grounded in the codebase, and thorough. However, it deviates from the user's stated requirement in a way that requires explicit validation before implementation proceeds.

---

## 1. Completeness

All 5 required sections are present and substantive:

| Section | Present | Substantive |
|---------|---------|-------------|
| Problem & Context | Yes | Thorough -- identifies current card layout, what data exists, what needs building |
| Design Decision | Yes | Detailed layout spec, data flow, scope boundary, "what NOT to build" list |
| Acceptance Criteria | Yes | 10 observable criteria with Given/When/Then structure |
| User Lifecycle Stories | Yes | 5 stories covering first use, new session, stuck detection, cleanup, settings |
| Risks & False-PASS | Yes | 7 risks including cost analysis, ANSI edge cases, performance, layout, memory, staleness, test false-PASS |

**No gaps in section coverage.**

---

## 2. Specificity

### File:line citations -- verified

| Design claim | Actual code | Verdict |
|---|---|---|
| SessionCard.js lines 63-168: card component | Lines 64-169 (`export function SessionCard`) | CORRECT (off by 1 on end -- the closing brace is line 169, not 168. Trivial.) |
| SessionCard.js line 100: `onClick` calls `attachSession` | Line 101: `onClick=${() => attachSession(session.id)}` | CORRECT (off by 1) |
| SessionCard.js lines 129-153: action buttons | Lines 130-155: Edit/Stop/Refresh/Delete buttons | CORRECT (the design says "Open" button at line 130-134, but lines 131-135 are actually the Edit button, not Open. See Issue A below.) |
| WatchdogManager.js line 99: `_tickInterval = 30_000` | Line 99: `this._tickInterval = 30_000;` | EXACT MATCH |
| WatchdogManager.js line 588: `summarizeSession()` | Line 588: `async summarizeSession(sessName)` | EXACT MATCH |
| WatchdogManager.js line 56: summarization prompt | Line 53-59: `SUMMARIZE_PROMPT` constant | OFF -- the prompt starts at line 53, not 56. Minor. |
| DirectSession.js line 192: `_wirePty` data handler | Line 188: `_wirePty(gen)` method definition | OFF by 4 -- method starts at 188, data handler inside it is around 210. |
| DirectSession.js line 31: `_lastLineBuffer` | Line 30: `this._lastLineBuffer = '';` | OFF by 1 |
| DirectSession.js line 251: `_updateLastLine` | Line 251: `_updateLastLine(data)` | EXACT MATCH |
| routes.js line 103: scrollback endpoint | Line 103: `router.get('/api/sessions/:id/scrollback/raw', ...)` | EXACT MATCH |
| SessionManager.js: no `getScrollback()` method | Confirmed -- grep returns zero matches in SessionManager.js | CORRECT |
| sessionState.js line 48: `upsertSession()` | Line 49: `export function upsertSession(session)` | OFF by 1 |

**Overall citation quality: GOOD.** Most are exact or off by 1. No fabricated references.

### Issue A: "Open" button does not exist

The design repeatedly references removing the "Open" button (Section 2: "The 'Open' button (SessionCard.js line 130-134)"). However, in the actual code at lines 130-135, the button is labeled **"Edit"**, not "Open". There is no "Open" button in the current SessionCard component. The card itself is clickable (line 101), but there is no dedicated "Open" button to remove.

This means:
- The problem statement about "Open" being redundant (Section 1, point 4) describes a button that does not exist.
- Acceptance criterion 6 ("there is no Open button") is trivially satisfied -- there is no Open button today.
- The design decision to "remove the Open button" is a no-op.

**Impact: Low.** This is a factual error in the design but does not affect implementation. The designer may have been working from an older version of the code. The real question is whether the "Edit" button should be kept, moved, or removed in the new layout -- the design is silent on this.

### Data flow completeness

The design traces two data flows end-to-end:

1. **Preview lines:** PTY data -> `_previewBuffer` (ring buffer on DirectSession) or `tmux capture-pane` (TmuxSession) -> 20-second interval on SessionManager -> `stripAnsi()` -> `session.meta.previewLines` (string array) -> WebSocket broadcast via `sessions:list` -> client `upsertSession()` -> SessionCard `<pre>` element. **Complete.**

2. **Card summary:** Scrollback delta > `MIN_DELTA_FOR_SUMMARY` (500 chars) -> WatchdogManager 30-second tick -> `summarizeSession()` + extended prompt -> Claude API -> `{ summary, keyActions, state, cardLabel }` -> `session.meta.cardSummary` -> WebSocket broadcast -> client `upsertSession()` -> SessionCard title bar. **Complete.**

### Scope boundary

Explicit "what NOT to build" list with 7 items. Clear.

---

## 3. Testability

All 10 acceptance criteria are observable from the running app:

- Criteria 1-3, 6, 8-10: Visual/structural -- verifiable via Playwright DOM assertions.
- Criterion 4: Requires waiting for watchdog tick + sufficient scrollback delta. Testable but timing-sensitive.
- Criterion 5: Negative test (no API call made). Harder to observe directly -- would need to mock or count API calls.
- Criterion 7: Settings change -> observable preview line count change.

**Issue B: Criterion 5 is hard to verify without instrumentation.** "No additional Claude API call is made" is not observable from the UI alone. The design should specify how this is tested (e.g., a counter exposed in the watchdog status endpoint, or a log message).

---

## 4. Risk Coverage

7 risks identified, including:
- Cost analysis with concrete numbers (Risk 1) -- thorough.
- ANSI stripping edge cases with false-PASS warning (Risk 2) -- good.
- Performance scaling (Risk 3) -- addressed with mitigations.
- Layout overflow (Risk 4) -- specific mitigation (raise min height to 200px).
- Memory (Risk 5) -- bounded.
- Staleness (Risk 6) -- mitigation with timestamp + idle indicator.
- Playwright false-PASS (Risk 7) -- actionable test strategy.

**Missing risk: Edit button fate.** The design removes a non-existent "Open" button but does not address what happens to the existing "Edit" button in the new compact action bar layout.

**Missing risk: WebSocket payload growth.** The design acknowledges ~2KB per session for preview data piggybacking on `sessions:list`, but does not address the interaction with the existing broadcast frequency. If `sessions:list` is broadcast more often than every 20 seconds (e.g., on every state change), the preview data inflates every broadcast, not just the 20-second interval ones.

---

## 5. Critical Question: API Cost Deviation

The user stated: "The last 20 lines are maintained by a job that runs every 20secs and **does need a claude api.**"

The design interprets this differently:
- The 20-line preview: pure local buffer read, NO Claude API. Runs every 20 seconds.
- The 5-7 word summary: uses Claude API, but only on meaningful scrollback delta (not every 20 seconds).

### Is the design's rationale sound?

**Yes.** The cost table in Risk 1 is accurate. Calling Claude API every 20 seconds per session is genuinely expensive (~1,800 calls/hour for 10 sessions) and provides minimal incremental value over delta-gated summaries. The 20-line preview achieves the visual goal without any API call. The summary achieves the comprehension goal with dramatically fewer API calls.

### Does the design satisfy the user's actual intent?

**Probably, but not certainly.** The user may have:
- (a) Wanted the 20-line capture + API summary bundled as one 20-second job (the design separates them but achieves both goals).
- (b) Specifically wanted always-fresh summaries every 20 seconds, accepting the cost.
- (c) Misspoken or not considered the cost implications.

The design correctly identifies (a) and (c) as likely but cannot rule out (b).

### Should this be surfaced to the user?

**Yes.** This is not a minor optimization -- it is a fundamental architectural decision about API call volume that changes the cost profile by 60-180x. A good engineer surfaces this tradeoff before building, even if the cheaper option is almost certainly correct.

---

## Questions for User

1. **API call frequency for summaries:** The design separates the 20-second preview capture (free, local buffer read) from the summary generation (Claude API, only on meaningful change). You said the job "does need a claude api" -- did you mean the summary should update every 20 seconds regardless of whether output has changed, or is delta-gated summarization (only when substantial new output appears) acceptable? The cost difference is ~1,800 vs ~10-30 API calls per hour for 10 sessions.

2. **Edit button disposition:** The design mentions removing the "Open" button, but the current code has an "Edit" button (not "Open") in the card actions. Should the Edit button be kept in the new compact action bar, moved elsewhere, or removed?

3. **Option A availability:** The design recommends Option B (delta-gated) but mentions Option A (always-fresh, every 20 seconds) could be offered as an opt-in setting. Do you want Option A built as a toggle in this phase, or is Option B sufficient with Option A deferred?

---

## Minor Issues (not blocking)

- Line number citations are off by 1-4 in several places (see table above). Not a problem for implementation but suggests the designer may have been working from a slightly stale line count.
- The summarization prompt extension (adding `cardLabel` to the JSON schema) is described but the exact prompt text change is not specified. The implementer will need to decide on the prompt wording.
- Acceptance criterion 5 (no API call when idle) needs a testable observation mechanism.
- The "Open" button discussion is a factual error -- the button does not exist in the current codebase.

## Cycle 3 -- User Answers Incorporated

Design updated to: confirm delta-gated summarization (no new API calls, Option A dropped), correct "Open" -> "Edit" button (kept as wrench icon in action bar), and mark Risk 1 (API cost) as resolved.
