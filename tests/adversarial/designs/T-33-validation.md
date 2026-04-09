# T-33 Validation: TODO Empty Title Blocked

**Validator role:** Adversarial review — find reasons the PASS is fake or the test is weaker than it appears.

---

## Verdict: GENUINE PASS

**Did the test pass?** Yes.
**Was the design correct?** Mostly — one design error (inline validation error expected but code shows none). Correctly identified and adapted.
**Was the execution faithful?** Yes, with necessary deviations.

---

## Question 1: Did the test actually pass?

Yes. The test logged:
- API-level rejection: 400 `{"error":"Title is required"}` — confirmed.
- Form still visible after empty submit — confirmed via `isVisible()`.
- No POSTs intercepted from browser — `interceptedPosts.length === 0`.
- Form closed after valid submit — confirmed.
- 1 `.todo-item` with correct title — confirmed.
- POST intercepted for valid title — `interceptedPosts.length === 1`.

All 7 assertions passed. This is not a vacuous pass.

---

## Question 2: Was the design correct?

**Design error found and corrected:** The original task spec said "Inline validation error near title." The design correctly identified this was wrong — `addTodo()` does `if (!title) return` with no error message rendered. The design adapted the pass criteria to match reality.

**Design strength:** Including the positive-path step (type real title → submit → assert 1 item) was essential to avoid vacuousness. Without it, the test would only prove that clicking "Add" with empty title does nothing — it couldn't prove the submit path was working at all.

**Design gap:** The design noted "The component is NOT mounted in the main App.js UI" — this is correct and was handled by writing a test harness HTML page. Good catch.

---

## Question 3: Was the execution faithful?

Yes, with one important observation: the test harness page serves the component via esm.sh CDN imports (`preact`, `htm`). In a production test environment without internet access, this would fail. The test is currently internet-dependent.

**Is the PASS real?** Yes. The network interception was set up before clicking "Add" (via `page.route()` before the click sequence). The positive-path confirmation (step 6) uses the same interception and confirms it was capturing real POSTs.

---

## Potential False-PASS Scenarios (evaluated)

1. **Test harness never mounts the component.** The test throws `waitForSelector('.todo-header', { timeout: 15000 })` which would fail if the component didn't mount. A pass proves the component was rendered.

2. **Network interception set up after the POST fires.** `page.route()` is set up BEFORE any button clicks. Any POST during the empty-title test would be captured.

3. **The form was never shown (Add button clicked wrong element).** The test logs "Add form opened" after `waitForSelector('.todo-add-form')` — the form was visibly present before clicking "Add."

4. **Title input had content the test didn't know about.** The test explicitly asserts `titleValue === ''` via `inputValue()` — confirmed empty before clicking "Add."

---

## Adversarial Finding

One minor weakness: the test asserts `interceptedPosts.length === 0` but uses `page.route()` which intercepts requests from the page's fetch calls. If `addTodo()` used XMLHttpRequest instead of `fetch()`, the route interception might not capture it. However, looking at `TodoPanel.js` line 80, it uses `fetch()` — so the interception is correct.

**Verdict:** GENUINE PASS. Both the client-side guard and server-side guard are confirmed working. The positive path is non-vacuous. The test is meaningful and would catch a regression if `addTodo()` removed the `if (!title) return` guard.

---

## Bug Report

None. The empty-title blocking works correctly at both layers. This is a PASS.
