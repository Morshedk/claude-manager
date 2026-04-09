# T-29 Validation: Telegram Badge Persists After Browser Reload

**Validator role:** Adversarially review design + execution. Find false PASSes.

---

## Three Questions

### 1. Did the test pass?

**YES — GENUINE PASS.**

The test produced observable evidence at each step:
- Badge text "TG" confirmed before reload (step 3): `Badge before reload: "TG"`
- Browser reloaded, WS reconnected
- Badge text "TG" confirmed after reload (step 5): `Badge after reload: "TG"`

The test ran clean — no crash log entries, no errors.

### 2. Was the design correct?

**YES, mostly.** The design correctly identified:
- The persistence path: `telegramEnabled` in `DirectSession.meta` → `toJSON()` → `SessionStore` → WS `sessions:list`
- The false-PASS risk of in-memory vs disk persistence (noted but correctly scoped: this test covers browser reload with server alive)
- The need to re-click the project after reload
- The `session:subscribed` xterm.reset() non-risk (terminal buffer, not badges)

**Design gap:** The design noted "this test does NOT test disk persistence" (server restart). This is a known limitation. A future test (T-??) should cover server restart + reload. For the stated scope, the design is complete.

**Design gap 2:** The design did not explicitly note that `session:create` auto-subscribes the creating WS. The executor correctly used two separate WS connections (one for browser, one for WS API) and the test still worked. Not a correctness issue.

### 3. Was the execution faithful?

**YES.** The executor followed the design:
1. Browser opened and project selected before session creation
2. Session created via separate WS connection with `telegram: true`
3. TG badge verified before reload
4. Hard reload via `page.evaluate(() => location.reload())`
5. Re-clicked project after reload
6. TG badge verified after reload

**Notable deviation:** The executor opened the browser first and selected the project BEFORE creating the session via WS (correct order to avoid the `session:subscribed` xterm.reset() trap). The design suggested this order.

---

## Adversarial Scrutiny

**Could this be a vacuous pass?**

The only vacuous pass risk would be if `.badge-telegram` was visible for some reason unrelated to `telegramEnabled` (e.g., a hardcoded badge). This is not plausible given the source code path `${session.telegramEnabled ? html\`<span class="badge badge-telegram">TG</span>\` : null}`.

**Could the badge persist without `telegramEnabled` being persisted?**

Yes — if the server keeps the session in memory and never saves to disk. The test does NOT restart the server, so this is in-memory persistence. The badge is served from the WS `sessions:list` message which includes `telegramEnabled` from the in-memory session object. This is the correct behavior to test for a browser reload (no server restart).

**Is `telegramEnabled` actually in the WS message?**

`DirectSession.toJSON()` returns `{ ...this.meta }` — flat object. `meta` includes `telegramEnabled: !!telegram` set at creation. `SessionManager.list()` calls `toJSON()` on each session. The WS `sessions:list` includes this. CONFIRMED correct by test passing.

---

## Verdict

**GENUINE PASS.** The TG badge correctly persists after browser reload. The `telegramEnabled` flag is maintained in server-side session memory and delivered via `sessions:list` WS message on reconnect. The test assertion chain is valid and not vacuous.

**Coverage gap noted:** This test does not cover the case where the SERVER restarts between the session creation and the browser reload. That would require `telegramEnabled` to survive disk serialization/deserialization, which is a separate concern.
