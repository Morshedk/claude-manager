# Move Session Between Projects

## Section 1: Problem & Context

### What the user cannot do today

There is no way to reassign a session from one project to another. Once a session is created under a project (via `NewSessionModal.js`, line 83: `createSession(project.id, ...)`), its `projectId` is permanently baked into the session metadata (see `SessionManager.js`, lines 154-166 for direct mode, lines 188-200 for tmux mode). The only workaround is to delete the session and recreate it under the correct project, which loses the Claude conversation history link (`claudeSessionId`) and any accumulated context.

Sessions are grouped by project in the UI via a computed signal in `store.js` (line 30-34):

```
export const projectSessions = computed(() => {
  const pid = selectedProjectId.value;
  if (!pid) return [];
  return sessions.value.filter(s => s.projectId === pid);
});
```

This filtering means a session only appears under one project at a time, and changing its `projectId` is the only thing needed to move it.

### What exists today: Session cards

Each session is rendered as a `SessionCard` component (`public/js/components/SessionCard.js`). The card displays:
- Session name (line 64, falls back to truncated ID)
- Status badge (running/stopped/etc.)
- Telegram badge (if enabled)
- Mode badge (direct/tmux)
- Claude session ID snippet (first 8 chars, click to copy)
- Timestamp (time ago)
- Action buttons: **Open**, **Stop**/**Refresh**, **Delete** (lines 129-154)

The session cards are listed inside `ProjectDetail.js` (line 97) under the Sessions tab for the currently selected project.

### The confusing "Open" button

The "Open" button (`SessionCard.js`, lines 131-135) calls `handleAttach`, which calls `attachSession(session.id)` -- the exact same action as clicking the session card itself (line 100) or clicking the session name (lines 103-105). All three do the same thing: set `attachedSessionId` in the store, which causes the `SessionOverlay`/`TerminalPane` to render and subscribe to the session's live PTY output.

The "Open" button is therefore fully redundant with clicking the card. The user's confusion ("I don't know what the open button is for") confirms this redundancy. The button should be **replaced** by an "Edit" button, not augmented.

### What is stored in the data model

Session metadata is persisted to `data/sessions.json` via `SessionStore` (`lib/sessions/SessionStore.js`). Each session record contains (from actual data on disk):

- `id` -- UUID, primary key
- `projectId` -- UUID, foreign key to project
- `projectName` -- denormalized project name (convenience field)
- `name` -- user-given session name (nullable)
- `command` -- the claude CLI command
- `cwd` -- working directory (derived from project path at creation time)
- `mode` -- "direct" or "tmux"
- `claudeSessionId` -- Claude conversation UUID
- `tmuxName` -- tmux session name (for tmux mode)
- `telegramEnabled` -- boolean
- `status` -- running/stopped/error/etc.
- Timestamps: `createdAt`, `startedAt`, `exitedAt`

The association between a session and a project is stored in two fields: `projectId` and `projectName`. The `cwd` field is also derived from the project path at creation time (`SessionManager.js` line 129: `const cwd = project.path`).

---

## Section 2: Design Decision

### Where the Edit button appears

Replace the existing "Open" button on `SessionCard` (lines 131-135) with an "Edit" button. The "Open" action is already achieved by clicking the card itself, so nothing is lost.

The Edit button should use a pencil icon or the text "Edit" in a `btn-ghost btn-sm` style, consistent with the existing card action buttons. It should call `e.stopPropagation()` to prevent triggering the card's `onClick` (which attaches the session).

### What the Edit UI looks like

A modal dialog, consistent with the existing `EditProjectModal` and `NewSessionModal` patterns. The component should be called `EditSessionModal` and follow the same structure:

- Overlay backdrop with click-to-close
- Modal card with header ("Edit Session"), body (form fields), and footer (Cancel + Save)
- Escape to close, Ctrl/Cmd+Enter to save

This is preferable to an inline edit or dropdown because:
1. It matches the existing UI language (EditProjectModal already exists)
2. A dropdown is too cramped for a project picker with potentially many projects
3. Inline editing on the card would be visually messy given the card's compact layout

### What fields are editable

1. **Session name** -- text input, pre-filled with current `session.name`. This is the most common edit users will want.
2. **Project assignment** -- a `<select>` dropdown listing all projects by name, pre-selected to the current `projectId`. This is the core of this feature.

Fields that should NOT be editable in this modal:
- `command` -- changing the claude command mid-session is dangerous and semantically different from "editing" a session
- `mode` -- switching direct/tmux requires killing and restarting the PTY
- `telegramEnabled` -- changing this requires restarting with different flags

### What happens when a session is moved (client side)

1. User clicks Edit on a session card
2. Modal opens with session name and project dropdown pre-filled
3. User selects a different project from the dropdown and/or renames the session
4. User clicks Save
5. Client sends a `session:update` WebSocket message: `{ type: 'session:update', id: sessionId, name: newName, projectId: newProjectId }`
6. Server processes the update (see below), persists it, and broadcasts an updated `sessions:list`
7. The `sessions` signal updates, `projectSessions` recomputes, and the session disappears from the current project's list and appears under the target project's list
8. If the user is currently viewing the target project, the session appears immediately. If not, the session simply vanishes from the current view (expected behavior -- it moved).
9. A toast confirms: "Session moved to [project name]" or "Session updated"

### Server-side: new WebSocket handler

**No new REST endpoint is needed.** The WebSocket message router already dispatches `session:*` messages to `SessionHandlers` by extracting the action suffix (`MessageRouter.js`, line 43). Adding a new `update` method to `SessionHandlers` will automatically be routable as `session:update`.

New handler in `SessionHandlers` (`lib/ws/handlers/sessionHandlers.js`):

```
async update(clientId, msg) { ... }
```

This handler should:
1. Validate that the session exists
2. Validate that the target `projectId` exists (via `projectStore.get()`)
3. Update `session.meta.projectId`, `session.meta.projectName`, and optionally `session.meta.name`
4. **Important**: also update `session.meta.cwd` to match the new project's path, since `cwd` is derived from the project path. This matters for tmux sessions and session file discovery (`_discoverClaudeSessionId` and `_claudeSessionFileExists` both use `cwd`).
5. Persist via `SessionStore.save()`
6. Broadcast `sessions:list` to all clients
7. Send confirmation to the requesting client: `{ type: 'session:updated', id, session }`

The `SessionManager` needs a new `update(sessionId, updates)` method that the handler delegates to, following the same pattern as `stop`, `refresh`, and `delete`.

### New protocol messages

Add to `protocol.js`:
- Client: `SESSION_UPDATE: 'session:update'`
- Server: `SESSION_UPDATED: 'session:updated'`

### New client-side state and actions

Add to `store.js`:
- `editSessionModalOpen` signal (boolean)
- `editSessionTarget` signal (session object or null)

Add to `actions.js`:
- `openEditSessionModal(session)` -- sets both signals
- `closeEditSessionModal()` -- clears both signals
- `updateSession(sessionId, updates)` -- sends the `session:update` WS message

### What about the "Open" button

**Remove it entirely.** Replace it with the "Edit" button in the same position. The card itself is already clickable to attach/open the session (line 100), and the session name is also clickable (lines 103-105). The "Open" button is pure redundancy and its removal reduces confusion.

### Note on cwd implications

When moving a session to a different project, the `cwd` field changes to the new project's path. This has the following implications:

- **For stopped sessions**: no impact, the new `cwd` will be used on next start/refresh
- **For running sessions**: the live PTY process is already running in the old `cwd`. The move only changes metadata; the running process continues in its original directory. On next restart/refresh, it will use the new `cwd`. This is acceptable and expected -- moving a running session is a metadata reassignment, not a process migration.
- **Claude session file discovery**: `_discoverClaudeSessionId` and `_claudeSessionFileExists` use `cwd` to find `.jsonl` files. After a move, the Claude conversation file is still in the old project's `.claude/projects/` directory. This means `--resume` after a move may not find the conversation. This is an acceptable trade-off for v1 of this feature; a warning in the modal ("Note: moving a session may affect conversation resume") would be prudent.

---

## Section 3: Acceptance Criteria

1. **Given** a session card in the project detail view, **when** the user looks at the card actions, **then** there is an "Edit" button where "Open" used to be, and no "Open" button exists.

2. **Given** a session card, **when** the user clicks "Edit", **then** a modal opens with the session's current name pre-filled in a text input and the session's current project pre-selected in a project dropdown.

3. **Given** the Edit Session modal is open, **when** the user selects a different project from the dropdown and clicks Save, **then** the session disappears from the current project's session list and appears under the target project's session list.

4. **Given** the Edit Session modal is open, **when** the user changes the session name and clicks Save, **then** the session card updates to show the new name.

5. **Given** a session is moved to a different project, **when** the server processes the update, **then** `sessions.json` on disk reflects the new `projectId`, `projectName`, and `cwd`.

6. **Given** the Edit Session modal is open, **when** the user presses Escape, **then** the modal closes without saving changes.

7. **Given** the Edit Session modal is open, **when** the user presses Ctrl+Enter (or Cmd+Enter), **then** the form submits (same as clicking Save).

8. **Given** a session is moved while another client is connected, **when** the server broadcasts `sessions:list`, **then** the other client's UI also reflects the session under its new project.

9. **Given** a running session, **when** the user moves it to a different project, **then** the running PTY process is not interrupted -- only metadata changes. A subsequent refresh/restart uses the new project's working directory.

10. **Given** the Edit Session modal, **when** the user does not change any field and clicks Save, **then** no unnecessary update is sent (or the server handles it idempotently without error).

---

## Section 4: User Lifecycle Stories

### Story 1: Correcting a misplaced session

The user creates a new Claude session under "Project A" by accident -- they meant to put it under "Project B". They notice immediately. They click the "Edit" button on the session card. The Edit Session modal opens. They select "Project B" from the project dropdown and click Save. The session disappears from Project A's list. They click on Project B in the sidebar and see the session listed there. They click the session card to attach and continue working.

### Story 2: Reorganizing after adding a new project

The user has been working with a single project ("Monorepo") and has 6 sessions. They decide to split into two projects: "Monorepo - Frontend" and "Monorepo - Backend". They create the new projects. Then they go through each session, click Edit, and reassign 3 sessions to "Frontend" and 3 to "Backend". Each time they save, the session moves out of the current project view. When done, each project has its 3 sessions.

### Story 3: Renaming a session

The user created a session with a vague name. They click Edit on the session card, change the name from "Session d2d8a7" to "auth refactor", and click Save. The card immediately updates with the new name. No project change was needed.

### Story 4: Editing a running session

The user has a running session under the wrong project. They click Edit, change the project, and Save. The terminal continues streaming output without interruption. The session is now listed under the new project. When the user eventually refreshes/restarts the session, it will start in the new project's working directory.

### Story 5: Multi-client synchronization

Two browser tabs are open. In tab 1, the user moves a session from "Project A" to "Project B". Tab 2, which is viewing Project A, sees the session disappear from the list in real time (via the broadcasted `sessions:list` message). If tab 2 switches to Project B, the session is there.

---

## Section 5: Risks & False-PASS Risks

### Risk 1: cwd mismatch after move

**Risk**: After moving a session to a different project, the `cwd` changes but any running PTY is still in the old directory. Claude's `--resume` flag uses `cwd` to find conversation files. If the conversation `.jsonl` file is keyed to the old project path, resume will fail silently (Claude starts a new conversation instead of resuming).

**Mitigation**: Display a brief note in the modal when the user selects a different project: "Session will use the new project's directory on next restart." For v1, this is acceptable. A future enhancement could offer to keep the original `cwd` or copy the conversation file.

### Risk 2: False-PASS on broadcast

**Risk**: The `_broadcastSessionsList()` call after update appears to work in single-client testing. A false-PASS occurs if the test never checks a second connected client. The session list could be stale on other clients if the broadcast message is malformed or the sessions signal merge logic drops moved sessions.

**Mitigation**: Acceptance criterion 8 explicitly requires multi-client verification. Test with two browser tabs.

### Risk 3: Race condition with concurrent updates

**Risk**: Two clients edit the same session simultaneously. Both read the old `projectId`, both send `session:update`. The server processes them sequentially via the single-threaded event loop, so the last writer wins. No data corruption, but one user's change is silently overwritten.

**Mitigation**: Acceptable for v1 -- this is a single-user app in practice. The broadcasted `sessions:list` will converge both clients to the final state.

### Risk 4: Edit button on running session stops output

**Risk**: If the Edit button's `stopPropagation()` somehow interferes with the card's click handler in a way that causes an unsubscribe, the user might lose their live terminal view.

**Mitigation**: The Edit button must only call `stopPropagation()` and open the modal. It must not call `attachSession` or interact with the session subscription. Test: click Edit on a session while attached to it -- the terminal should remain visible behind the modal.

### Risk 5: projectName denormalization goes stale

**Risk**: The session stores `projectName` as a denormalized convenience field (from `sessions.json`). When moving a session, the handler must update `projectName` to match the new project's name. If this is forgotten, the session card or other UI elements might show the old project name.

**Mitigation**: The `update` handler must read the target project's name from `projectStore.get(newProjectId).name` and set it on the session meta. Add a test case that verifies `projectName` changes after a move.

### Risk 6: Dropdown shows no projects or only one

**Risk**: If there is only one project, the project dropdown is useless (the user cannot move the session anywhere). The modal should handle this gracefully -- either disable the dropdown or show a helpful message.

**Mitigation**: If `projects.value.length <= 1`, the project dropdown should be disabled with a note: "Create another project to move sessions between them."
