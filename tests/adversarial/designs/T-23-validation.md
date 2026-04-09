# T-23 Validation: Telegram Toggle — Unconfigured State Is Disabled and Explains Why

**Date:** 2026-04-08
**Status:** PASS
**Score:** L=3 S=2 D=3 (Total: 8)

## Test Run Summary

| Test | Result | Notes |
|------|--------|-------|
| T-23.1 — API returns configured: false | PASS | `/api/telegram/status` → `{ configured: false, hasToken: false }` |
| T-23.2 — Button disabled + help text | PASS | `disabled` attr set, `opacity: 0.4`, help text "Telegram not configured..." |
| T-23.3 — Click disabled button has no effect | PASS | Button text unchanged after force-click; still disabled |
| T-23.4 — session:create not sent with telegram:true | PASS | WS spy captured `telegram: false` in the create payload |

**Total: 4/4 passed in 24.6s**

## Assertions Verified

1. `GET /api/telegram/status` returns `{ configured: false, hasToken: false }` when no `~/.claude/channels/telegram/.env` exists.
2. The "Enable Telegram" button has the HTML `disabled` attribute when `telegramConfigured === false`.
3. Button computed `opacity` is `0.4` (≤ 0.5).
4. Button `cursor` is `not-allowed`.
5. Help text contains "Telegram not configured" (warning color).
6. Force-clicking the disabled button does not change button text from "Enable Telegram" to "Telegram On".
7. Button remains disabled after click attempt.
8. Zero console JS errors during all interactions.
9. `session:create` WS message has `telegram: false` even after force-click on the disabled button.

## Fixes Made to Test

- `playwright.config.js`: Added T-23 to `testMatch` allowlist.
- Updated all 3 browser tests to use `button:has-text("New Claude Session")` (v2 button text) and `text=T23-TestProject` project selector.
- T-23.4: Added session name `t23-flag-test` and command `bash`; used `.modal-footer button:has-text("Start Session")` to prevent ambiguous btn-primary match.

## App Behavior Confirmed

The `NewSessionModal` correctly:
- Fetches `/api/telegram/status` on open and sets `telegramConfigured = false`
- Renders the toggle with `disabled={!telegramConfigured || checkingTelegram}`
- Guards the `onClick` with `telegramConfigured && setTelegramEnabled(...)`
- Shows the unconfigured help text in warning color

No regressions. The Telegram toggle is safe from accidental activation when unconfigured.
