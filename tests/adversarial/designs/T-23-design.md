# T-23 Design: Telegram Toggle — Unconfigured State Is Disabled and Explains Why

**Score:** L=3 S=2 D=3 (Total: 8)
**Test type:** Playwright browser
**Port:** 3120

---

## What We Are Testing

When Telegram is NOT configured on the server (no bot token file exists), the "Enable Telegram" button in the New Session modal must be:
1. Visually disabled (opacity ~0.4)
2. Have the `disabled` HTML attribute set
3. Show help text: "Telegram not configured — run /telegram:configure first"
4. Be unclickable (no state change on click)
5. Produce no JS errors

---

## Server-Side Mechanism

**Endpoint:** `GET /api/telegram/status`
**File:** `/home/claude-runner/apps/claude-web-app-v2/lib/api/routes.js` (lines 352–371)

The endpoint checks for the existence of a `.env` file at:
```
~/.claude/channels/telegram/.env
```

If the file does not exist, the response is:
```json
{ "configured": false, "hasToken": false, "hasAccessPolicy": false, "pending": {}, "allowFrom": [] }
```

A fresh test server will NOT have this file (no env var set, no file created). This is the natural state for `configured: false`.

---

## Client-Side Mechanism

**File:** `/home/claude-runner/apps/claude-web-app-v2/public/js/components/NewSessionModal.js`

Key state variables:
- `telegramConfigured` — initialized to `true` (line 53), then overwritten by fetch result on modal open
- `checkingTelegram` — true while fetching, prevents interaction during load

On modal open (useEffect, line 57–72):
1. `setCheckingTelegram(true)` 
2. `fetch('/api/telegram/status')` → `.then(status => setTelegramConfigured(!!status.configured))`
3. If fetch fails → `setTelegramConfigured(false)`
4. `setCheckingTelegram(false)` in `.finally()`

**Button attributes (line 187–189):**
```js
disabled=${!telegramConfigured || checkingTelegram}
style=`...opacity:${telegramConfigured ? 1 : 0.4};cursor:${telegramConfigured ? 'pointer' : 'not-allowed'};`
```

**Click guard (line 186):**
```js
onClick=${() => telegramConfigured && setTelegramEnabled(v => !v)}
```

**Help text (lines 191–195):**
- When unconfigured: `"Telegram not configured — run /telegram:configure first"` in warning color
- When configured: `"Connect this session to Telegram for remote messaging"` in muted color

---

## Failure Modes

| Failure | Root Cause | Detection |
|---------|-----------|-----------|
| Button appears enabled | `telegramConfigured` stays `true` (fetch failed silently or returned wrong shape) | Check `disabled` attr + opacity < 0.5 |
| Clicking enables flag | `onClick` guard not working; `telegramConfigured` is truthy despite no config | Click button, check text stays "Enable Telegram" |
| Wrong/missing help text | Template conditional incorrect | Check element text content |
| JS error on click | No guard; toggle called unconditionally | Listen for `console.error` events |
| Race: button briefly enabled | `telegramConfigured` starts as `true` before fetch resolves | Observe state at modal open + after delay |

---

## Critical Race: `telegramConfigured` initialized as `true`

**Line 53:** `const [telegramConfigured, setTelegramConfigured] = useState(true);`

This means there is a brief window between modal open and fetch resolution where the button appears ENABLED. If the test clicks too fast, it may catch the button in the enabled state. However:
- `checkingTelegram` starts as `false`, so `disabled` is only `!telegramConfigured` during check
- Wait: `setCheckingTelegram(true)` runs first, which sets `disabled=true` immediately
- So the sequence is: `disabled=true` (checking) → fetch resolves → `disabled=false` (configured) or `disabled=true` (unconfigured)

**Test must wait for `checkingTelegram` to settle** (i.e., `disabled` attr to reflect final state, not the loading state). Use `waitForFunction` or `waitFor` with appropriate selector.

---

## Test Strategy

1. Confirm `/api/telegram/status` returns `{ configured: false }` on fresh server
2. Open the New Session modal via UI (click project + "New Session" button)
3. Wait for Telegram fetch to settle (button `disabled` stabilizes)
4. Assert button has `disabled` attribute
5. Assert button opacity is ~0.4 (computed style or inline style check)
6. Assert help text contains "Telegram not configured"
7. Attempt to click the button
8. Assert button text still reads "Enable Telegram" (not "Telegram On")
9. Assert no console errors were thrown

---

## Test Setup

- Seed `data/projects.json` with a minimal project so modal can open
- ProjectStore format: `{ "projects": [{ "id": "test-project", "name": "Test Project", "path": "/tmp/T23-project" }], "scratchpad": [] }`
- No Telegram `.env` file should exist (fresh server, natural state)
- Navigate to app, select project, open New Session modal
- Use `waitUntil: 'domcontentloaded'` on navigation

## Execution Summary

**Date:** 2026-04-08
**Result:** PASS — 4/4 tests passed (24.6s)
**Port:** 3120

### Fixes applied during validation

1. **playwright.config.js** — Added T-23 to `testMatch` allowlist (was missing).
2. **Selector fix** — The "New Session" button is actually "New Claude Session" in v2. Updated all 3 browser tests to use `button:has-text("New Claude Session")` and click project by name (`text=T23-TestProject`).
3. **T-23.4 modal fix** — Added session name `t23-flag-test` and command `bash` to prevent server-side rejection that caused a 2-minute hang. Used scoped `.modal-footer button:has-text("Start Session")` locator.

### Key findings

- `/api/telegram/status` returns `{ configured: false, hasToken: false }` on fresh server with no `~/.claude/channels/telegram/.env` (confirmed via HOME isolation).
- The Telegram toggle button renders with `disabled` attribute and `opacity: 0.4` when unconfigured.
- Help text reads "Telegram not configured — run /telegram:configure first" (in `--warning` color).
- Force-clicking the disabled button does NOT change state (guard: `telegramConfigured && setTelegramEnabled(...)`).
- `session:create` WS message has `telegram: false` even after a force-click attempt on the disabled button.
- No JS console errors were produced.
