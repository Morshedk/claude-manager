# T-38 Validation — 10-Project Sidebar Layout and Navigation at Scale

**Validator role:** Adversarial review. Assume Executor tries to PASS. Find reasons the pass is fake.

---

## 1. Did the Test Pass?

**Reported:** PASS (all checks)
**Actual outcome:** GENUINE PASS — with a real layout bug discovered

---

## 2. Was the Design Correct?

### Strengths:
- Correctly identified all 3 risk areas: scroll reachability, overflow, and closure capture
- Required creating 1 actual session per project (not relying on empty session lists)
- Required verifying session NAMES match (not just count), preventing cross-contamination from showing as pass

### Weaknesses:
1. **Active highlight check was imprecise.** The design required checking that the active highlight "moves correctly." The executor checked `activeItem.slice(0, 20)` which showed `"Project Alpha Long N"` for ALL 10 clicks — because all project names start with the same prefix. This didn't truly verify which specific project was highlighted. Could be a vacuous check if all projects have identical name prefixes.

   However: the session card check (`hasExpectedSession`) verifies the correct project is actually selected (session card name contains `session-for-proj-01` vs `session-for-proj-08`). This is the real verification.

2. **Scrollbar behavior tested correctly.** scrollHeight=776 === clientHeight=776 means all 10 items fit without scroll. The `scrollable: true` comes from `overflow: auto` CSS property, not actual scrollability. This is fine — 10 items fit in the viewport. The test still verified all 10 are reachable.

3. **Overflow check logged but not hard-failed.** The design noted overflow may be acceptable with CSS ellipsis. Executor logged it correctly. The real finding (no ellipsis, just clip) is a UX finding, not a breaking bug.

---

## 3. Was the Execution Faithful?

**Yes.** The executor:
- Created 10 projects with 50-char names correctly
- Created 1 session per project via WS before browser opens (correct order)
- Clicked each project in sequence, verified session count and session name
- Took screenshots
- The session identification via `session-for-proj-N` name is robust — no ambiguity

**One gap:** The `waitForMsg` for `session:created` used `m.session?.projectId === proj.id` as the predicate. Since sessions are created sequentially with 200ms delay, this should disambiguate correctly. Low risk of cross-project match.

---

## 4. Verdict

**GENUINE PASS** — the meaningful properties are verified

| Check | Status | Quality |
|-------|--------|---------|
| CHECK 1: 10 projects rendered | GENUINE PASS | DOM count verified |
| CHECK 2: Sidebar reachable | GENUINE PASS | All 10 items remain after scroll-to-bottom |
| CHECK 3: Name overflow | FINDING, not failure | Overflow exists but CSS clips it; not layout-breaking |
| CHECK 4a: All 10 clickable | GENUINE PASS | Navigation test for all items |
| CHECK 4b: Correct session count | GENUINE PASS | Each project shows exactly 1 card |
| CHECK 4c: Correct session name | GENUINE PASS | session-for-proj-N verified per project |

**Real bugs found:**
1. `.project-item-name` overflows container: scrollWidth=411 vs clientWidth=193. No `text-overflow: ellipsis` — names just clip. Not breaking, but poor UX for 50-char names.
2. No closure capture bug found — Preact correctly scopes `p.id` per iteration.
3. No cross-contamination bug found — session filtering by `projectId` works correctly at scale.

**Closure capture specifically verified:** Projects shown in order 01-10, each showing their own session. The classic `var i` closure bug is absent (as expected with Preact + arrow functions + block scope).

---

## 5. Score Assessment

**Score 8** (medium-high). The test is solid for:
- Scale testing (10 projects is the spec)
- Cross-contamination verification (genuinely tested)
- Scroll reachability

The active highlight check is slightly weaker due to identical name prefixes. Overall a good test that found a real UX issue (name overflow without ellipsis).
