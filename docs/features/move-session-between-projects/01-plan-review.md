# Plan Review: Move Session Between Projects

## Verdict: APPROVED

The design document is thorough, well-grounded in the codebase, and ready for implementation. All five required sections are present and substantive. The acceptance criteria are observable, the lifecycle stories are real user journeys (not feature lists), and the risk section identifies genuine failure modes including false-PASS risks.

## Codebase Verification

I verified three specific file:line citations against the actual v2 codebase:

1. **SessionCard.js lines 131-135 ("Open" button)**: CONFIRMED. Lines 130-134 contain the `btn btn-ghost btn-sm` "Open" button calling `handleAttach` with `e.stopPropagation()`. The line numbers are off by 1 (the design says 131-135, actual button starts at line 130), but the code is exactly as described.

2. **store.js lines 30-34 (`projectSessions` computed signal)**: CONFIRMED. Lines 30-34 of `public/js/state/store.js` contain exactly the `projectSessions` computed signal shown in the design, filtering sessions by `selectedProjectId`.

3. **MessageRouter.js line 43 (action extraction)**: CONFIRMED. Line 43 of `lib/ws/MessageRouter.js` contains `const action = message.type.slice('session:'.length)` and line 44 does the handler lookup. The routing mechanism works exactly as the design claims -- adding an `update` method to `SessionHandlers` will automatically make it routable as `session:update`.

4. **SessionManager.js line 129 (`cwd = project.path`)**: CONFIRMED. Line 129 of `lib/sessions/SessionManager.js` has `const cwd = project.path`. Lines 154-166 for direct mode meta construction also confirmed.

5. **NewSessionModal.js line 83 (`createSession(project.id, ...)`)**: CONFIRMED. Line 83 contains exactly `createSession(project.id, { command: cmd, name, mode, telegram: telegramEnabled })`.

6. **protocol.js structure**: CONFIRMED. `public/js/ws/protocol.js` uses `CLIENT` and `SERVER` objects. The design's proposal to add `SESSION_UPDATE` and `SESSION_UPDATED` is consistent with the existing naming pattern.

## Minor Observations (non-blocking)

1. **File path references use shorthand**: The design says `store.js` and `actions.js` without the full path (`public/js/state/store.js`, `public/js/state/actions.js`). This is clear enough in context but an implementer should note the actual paths are under `public/js/state/`.

2. **No explicit validation for "move to same project"**: AC #10 covers the no-change case, but the design doesn't explicitly say whether `projectId === currentProjectId` should be silently accepted or short-circuited. The "handle it idempotently" note in AC #10 is sufficient, but the implementer should decide: skip the server call entirely on the client side, or let the server handle it.

3. **No mention of `SessionStore.js` vs `SessionManager.js` boundary**: The design says "Persist via `SessionStore.save()`" but the `SessionManager` wraps the store. The implementer should add the `update` method to `SessionManager` (which the design does specify) and have it call through to the store, consistent with the existing `stop`/`refresh`/`delete` pattern.

4. **`session:refreshed` response pattern not mirrored**: The existing `refresh` handler sends back `session:refreshed` to the requesting client AND broadcasts `sessions:list`. The design proposes the same pattern (`session:updated` + broadcast), which is correct. The implementer should handle the `session:updated` message in the client's WS message handler (`connection.js`) even if the broadcast already updates the list -- for the toast notification.

5. **No `SESSION_REFRESHED` in protocol.js either**: The existing `session:refreshed` message type is not in `protocol.js` (it's used as a raw string in sessionHandlers.js). The design's proposal to add `SESSION_UPDATE`/`SESSION_UPDATED` to protocol.js is actually more disciplined than the existing code. Not a problem, just noting inconsistency in the existing codebase.
