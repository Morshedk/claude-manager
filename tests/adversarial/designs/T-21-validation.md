# T-21 Validation: Low Credit Mode — new sessions use lcModel command

**Date:** 2026-04-08
**Overall result:** PASS (1/1)
**Time:** 10.7s

---

## Bug Found and Fixed

**File:** `/home/claude-runner/apps/claude-web-app-v2/lib/api/routes.js`

**Problem:** `GET /api/settings` and `PUT /api/settings` called async methods (`settings.getAll()`, `settings.update()`) without `await`. Both route handlers were synchronous (`(req, res) => {}`), so they returned Promises to `res.json()` instead of resolved values. The client received a serialized Promise object `{}` instead of actual settings data.

**Fix:** Made both route handlers `async` and added `await` to the async calls.

```js
// Before (broken):
router.get('/api/settings', (req, res) => {
  res.json(settings.getAll()); // returns Promise, not settings object
});
router.put('/api/settings', (req, res) => {
  const updated = settings.update(req.body); // returns Promise
  res.json(updated);
});

// After (fixed):
router.get('/api/settings', async (req, res) => {
  res.json(await settings.getAll());
});
router.put('/api/settings', async (req, res) => {
  const updated = await settings.update(req.body);
  res.json(updated);
});
```

---

## Test Results

| Assertion | Result | Detail |
|-----------|--------|--------|
| Settings API saves `lowCredit.enabled=true` | PASS | Confirmed via GET /api/settings |
| Settings API saves `lowCredit.active=true` | PASS | Confirmed via GET /api/settings |
| Settings API saves `lowCredit.defaultModel='haiku'` | PASS | Confirmed via GET /api/settings |
| A1: Command field = `claude --model claude-haiku-4-5-20251001` | PASS | Exact match |
| A2: "LOW CREDIT MODE ACTIVE" badge visible | PASS | found=true, visible=true, opacity=1 |
| A3: Badge color is orange/warning | PASS | `rgb(232, 160, 32)`, inline style `var(--warning)` |

---

## Full Flow Verified

1. Navigate to app (domcontentloaded)
2. Select T21-TestProject in sidebar
3. Open Settings modal (gear icon, `button[title="Settings"]`)
4. Enable "Low Credit Mode" toggle via `.toggle-slider` click
5. Set "Low Credit Model" select to 'haiku' via `select.value = 'haiku'` + change event
6. Enable "Activate Now" toggle via `.toggle-slider` click
7. Settings command preview shows `claude --model claude-haiku-4-5-20251001` in modal
8. Click "Save Settings" (`.modal-footer .btn-primary`)
9. Modal closes (save confirmed)
10. GET /api/settings returns `{ lowCredit: { enabled: true, active: true, defaultModel: 'haiku', ... } }`
11. Open "New Claude Session" modal
12. Command input pre-filled with `claude --model claude-haiku-4-5-20251001`
13. "LOW CREDIT MODE ACTIVE" badge rendered in orange

---

## Verdict

PASS. The Low Credit Mode feature works correctly end-to-end once the settings API async bug was fixed. The fix is a real production bug — any code path relying on GET /api/settings or PUT /api/settings would have received `{}` instead of actual settings before this fix.
