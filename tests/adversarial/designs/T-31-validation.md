# T-31 Validation: Settings Cancel Discards Changes

**Validator role:** Adversarially review design + execution. Find false PASSes.

---

## Three Questions

### 1. Did the test pass?

**YES — GENUINE PASS.**

Observable evidence:
- Initial model: "sonnet"
- Changed to "opus" in UI
- Cancel clicked
- Zero PUT requests to `/api/settings`
- Modal reopened
- Model confirmed still "sonnet"

### 2. Was the design correct?

**YES.** The design correctly identified:
- Cancel button wired to `closeSettingsModal()` (not `handleSave()`)
- `useEffect` re-syncs from `settings.value` on modal reopen — so the local state resets
- Network request monitoring as the key additional assertion
- The false-PASS risk of multiple `select.form-select` elements (only first is tested)

**Design gap (minor):** The design mentioned using `page.$eval('.settings-section:first-of-type select.form-select', ...)` but the executor used just `page.$eval('select.form-select', ...)` (first matching element overall). In the DOM, the first `select.form-select` is indeed the Session Defaults model selector. This works correctly but depends on DOM order.

### 3. Was the execution faithful?

**YES, with one enhancement.** The executor added a defensive guard: if the initial model is already "opus", it switches to "sonnet" first (then cancels) to ensure a non-trivial starting state. This is a correct precaution — tests should never assert on a starting condition that happens to match the "expected after cancel" value.

The executor correctly:
1. Tracked PUT requests via `page.on('request', ...)`
2. Selected "opus" (different from default "sonnet")
3. Clicked Cancel
4. Asserted zero PUT requests
5. Reopened modal and verified model is "sonnet"

---

## Adversarial Scrutiny

**Could this be a vacuous pass?**

Only if the test was never actually changing the model (e.g., selectOption failed silently). The test logs confirm: `Model after change (before cancel): "opus"` — the change was verified BEFORE clicking Cancel. So the assertion that it reverted to "sonnet" is non-trivial.

**Could the model show "sonnet" for a reason unrelated to Cancel?**

The `useEffect` in `SettingsModal` re-reads from `settings.value` on `settingsModalOpen.value` change. If `settings.value.session.defaultModel` is "sonnet" (never saved as "opus"), then yes, reopening will always show "sonnet". This is exactly what we want: Cancel does NOT call `handleSave`, so `settings.value` is never mutated. The reopen reflects the unmodified state.

**Could there be a bug where Cancel IS wired to save?**

Reading the source: Cancel button `onClick=${closeSettingsModal}`. `closeSettingsModal` only closes the modal (sets signal to false). No save. The test confirms no PUT was made (putRequests.length === 0). This is the belt-and-suspenders check the design required.

**What if `settings.value` was mutated client-side without a PUT?**

That would be caught by the model check on reopen (model would be "opus"). The test checks BOTH: no PUT and correct model. Both passed.

---

## Verdict

**GENUINE PASS.** The Settings Cancel button correctly discards changes. No network request was made, and the local state reset to the persisted value on modal reopen. The test is not vacuous — the model was confirmed changed to "opus" before Cancel, then confirmed back to "sonnet" after reopen.

**Score: 10. Passes.**
