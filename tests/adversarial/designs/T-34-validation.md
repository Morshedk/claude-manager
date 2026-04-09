# T-34 Validation: TODO Filters — High Priority Filter Hides Medium Items

**Validator role:** Adversarial review — find reasons the PASS is fake or the test is weaker than it appears.

---

## Verdict: GENUINE PASS

**Did the test pass?** Yes.
**Was the design correct?** Yes, with one adaptation needed (two "all" buttons).
**Was the execution faithful?** Yes.

---

## Question 1: Did the test actually pass?

Yes. The test logged:
- Initial state: 3 items visible (confirmed non-vacuous precondition).
- "high" filter: 1 item visible, Task H present, Task M and Task L absent from DOM.
- "medium" filter: 1 item, Task M present, others absent.
- "low" filter: 1 item, Task L present, others absent.
- "all" filter: 3 items restored.
- "active" class confirmed on selected button.

All assertions passed.

---

## Question 2: Was the design correct?

**Strong design:** The initial count check `if (initialCount < 3) { throw new Error(...) }` is a genuine pre-condition guard. If the seeded TODOs weren't present (wrong API, wrong projectId, wrong filter), the test would hard-fail rather than silently pass with wrong data.

**Design gap (resolved):** Two "all" buttons exist — one for priority filter, one for status filter. The filter texts found were `["all","high","medium","low","pending","completed","all"]`. The test used `.first()` to click the priority "all" button. This worked correctly.

**Design finding:** The test uses `textContent()` on `.todo-list` to verify presence/absence of items. This is correct — items not in `visibleItems` are NOT rendered at all (Preact conditional rendering), so they genuinely don't exist in the DOM.

---

## Question 3: Was the execution faithful?

Yes. All 4 filter states were tested (high, medium, low, all). The status filter was not changed (default `pending` — all seeded items are pending). This is correct behavior — the test is specifically about priority filters.

---

## Potential False-PASS Scenarios (evaluated)

1. **Default status filter hides items.** If items were somehow `completed`, the status filter `pending` would hide them, and the initial count of 3 wouldn't be reached. The `waitForFunction` waits for 3 items — if only 0 showed, it would timeout. This is a genuine gate.

2. **Filter buttons CSS change but DOM not updated.** The test checks `.todo-item` count (not CSS visibility). If Preact re-renders but items are CSS-hidden rather than absent, the count check would still pass (wrong). However, looking at the source: filtering changes `visibleItems` array, which is used in the render. Items not in `visibleItems` are not passed to `TodoItem` component → not rendered → not in DOM. Count is accurate.

3. **Test clicks wrong "all" button.** Two "all" buttons exist. Used `.first()` which targets the priority "all". The restored count of 3 confirms it worked (if the status "all" was clicked instead, count would still be 3 since all items are pending and the status filter would then include completed items too — actually this would still show 3 since all items are pending). In this case the final count of 3 is not discriminating. However, the "active" class check on the priority "all" button confirms it's selected.

---

## Adversarial Finding

The "all" filter restoration test (`all` → 3 items) would pass even if the wrong "all" button was clicked, because all seeded items are pending regardless of status filter. This is a minor weakness. However, the pre-condition (3 items visible initially) is set with the default priority="all" state, so the restoration is genuine.

**A stronger test would:** After clicking "high" filter, navigate away and come back, then verify filter is still "high" (T-34 spec note: "Filter resets when navigating away" is a fail condition, but the test doesn't cover this). This is a design gap.

**Overall verdict:** GENUINE PASS. The filtering logic (client-side `visibleItems` array manipulation) works correctly. Items are not rendered (not CSS-hidden) when filtered. Filter is reversible. Test is non-vacuous due to the precondition guard.

---

## Bug Report

None. Filters work correctly. This is a PASS.
