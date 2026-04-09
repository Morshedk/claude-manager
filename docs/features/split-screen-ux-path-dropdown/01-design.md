# Split Screen UX + Path Dropdown -- Design Document

## Section 1: Problem & Context

### What user problem this solves

Four distinct UX friction points exist in the current v2 app:

**1. Project path retyping.** When creating a new project via NewProjectModal, the user must type the full absolute path from scratch every time. There is no memory of previously used paths. Users who manage multiple projects in the same parent directories (e.g., `/home/user/apps/X`, `/home/user/apps/Y`) must retype the common prefix each time.

**2. No default split screen.** When a new session is created, `handleSessionCreated` in `/home/claude-runner/apps/claude-web-app-v2/public/js/state/actions.js` (line 196-199) calls `attachSession()`, which sets `attachedSessionId`. The SessionOverlay then renders. But `splitView` in `/home/claude-runner/apps/claude-web-app-v2/public/js/state/store.js` (line 57) is initialized as `signal(false)`, meaning every new session opens in full-screen overlay mode. The user must click "Split" in the overlay header every time. In v1 (`/home/claude-runner/apps/claude-web-app/public/app.js`, line 881), split mode was persisted via `localStorage.getItem('session-split')` and defaulted to split if the key was not `'0'`. V2 has no persistence and no default-to-split behavior.

**3. Terminal pane does not fill available space in split mode.** The SessionOverlay in `/home/claude-runner/apps/claude-web-app-v2/public/js/components/SessionOverlay.js` (line 53) uses `left: 50%` as a hardcoded percentage when `isSplit` is true. There is no CSS variable for split position, no resize handle, and no way to adjust the split ratio. The workspace behind the overlay is not clipped, so the session list is not visible in a usable way. Unlike v1, which used `--split-pos` CSS variable (defaulting to `50%`) and applied `margin-right: calc(100% - var(--split-pos, 50%))` to the workspace, v2 just stacks the overlay on the right half with no coordination with the workspace layout.

**4. Missing scroll handles and resize handles.** V1 had styled scrollbar rules for the terminal viewport at `/home/claude-runner/apps/claude-web-app/public/css/styles.css` (lines 1410-1430): thin scrollbars that appear on hover with a translucent thumb. V2's `styles.css` has no `.xterm-viewport` scrollbar rules at all -- the terminal uses browser-default hidden scrollbars. V1 also had a split-view resize handle (`#split-resize-handle` at `/home/claude-runner/apps/claude-web-app/public/css/styles.css` lines 793-811) that let users drag to reposition the split boundary. V2 has resize handles for the sidebar and sessions area (lines 345-369 of v2 `styles.css`) but nothing for the split overlay boundary. The sidebar resize handle (`#sidebar-resize`) is rendered in `App.js` (line 61) but has no JavaScript wired to it -- it is a dead element.

### What currently exists

- **NewProjectModal** (`/home/claude-runner/apps/claude-web-app-v2/public/js/components/NewProjectModal.js`): plain text input for path, no dropdown, no autocomplete.
- **Store signals** (`/home/claude-runner/apps/claude-web-app-v2/public/js/state/store.js`): `splitView` signal at line 57, `projects` signal at line 12 (array of `{ id, name, path }` objects).
- **SessionOverlay** (`/home/claude-runner/apps/claude-web-app-v2/public/js/components/SessionOverlay.js`): hardcoded `left: 50%` for split mode, no resize handle, no split-position variable.
- **CSS resize handles** (`/home/claude-runner/apps/claude-web-app-v2/public/css/styles.css`, lines 345-369): generic `.resize-handle`, `.resize-handle-h`, `.resize-handle-v` classes exist with hover/drag styling. No JavaScript initializes them.
- **TerminalPane** (`/home/claude-runner/apps/claude-web-app-v2/public/js/components/TerminalPane.js`): has a `ResizeObserver` (line 169) that refits the terminal when the container resizes. This means that if we correctly size the container, the terminal will auto-fit.

### What is missing

1. A datalist or dropdown component in NewProjectModal sourced from existing project paths.
2. localStorage persistence of split-view preference, and defaulting to split.
3. A CSS custom property `--split-pos` that controls split boundary, plus JavaScript to update it.
4. A draggable resize handle element for the split boundary.
5. Terminal scrollbar CSS rules for `.xterm-viewport`.
6. JavaScript initialization for the existing sidebar resize handle and sessions-area resize handle.

---

## Section 2: Design Decision

### Feature 1: Project path dropdown

**What to build.** Add an HTML5 `<datalist>` element to the path input in NewProjectModal. The datalist options are derived from the `projects` signal, which already holds all project objects with their `.path` fields. This requires no server changes.

**Files to modify:**
- `/home/claude-runner/apps/claude-web-app-v2/public/js/components/NewProjectModal.js`: Import `projects` from `store.js`. Compute `uniquePaths` as a deduplicated array of `projects.value.map(p => p.path)`. Add `list="project-paths-datalist"` attribute to the path `<input>` (line 99-106). Render a `<datalist id="project-paths-datalist">` with `<option>` elements for each unique path. Additionally, extract parent directories (path up to last `/`) and include those as suggestions so the user can pick a sibling directory.

**Data flow:** `projects` signal (already loaded at app startup by `loadProjects()` in `sessionState.js` or `actions.js`) provides `[{ path: "/home/..." }, ...]`. The component reads `.value` reactively. No new API calls needed.

**Edge cases:**
- Zero projects: datalist is empty, input behaves as a normal text field.
- Duplicate paths across projects: deduplicate before rendering options.
- Very long paths: the datalist dropdown truncates naturally; no special handling needed.

**What NOT to build:** No server-side filesystem browsing or autocomplete API. No custom dropdown component -- HTML5 datalist is sufficient and accessible.

### Feature 2: Default split screen on new session

**What to build.** Persist the user's split-view preference in `localStorage` and default to `true` (split) when no preference is stored.

**Files to modify:**
- `/home/claude-runner/apps/claude-web-app-v2/public/js/state/store.js`: Change `splitView` initialization (line 57) from `signal(false)` to read from `localStorage.getItem('splitView')`. If the key is absent or `'true'`, default to `true`. If `'false'`, default to `false`.
- `/home/claude-runner/apps/claude-web-app-v2/public/js/components/SessionOverlay.js`: In `toggleSplit` (line 21), after toggling the signal, write the new value to `localStorage.setItem('splitView', String(splitView.value))`.

**Data flow:** On page load, `store.js` reads `localStorage`. On toggle, `SessionOverlay` writes to `localStorage`. The signal drives rendering.

**Edge cases:**
- localStorage unavailable (incognito/security): wrap in try/catch, default to `true`.
- Mobile viewport (narrow screen): Split mode on narrow screens may be unusable. This is out of scope for now but should be noted as a future concern.

**What NOT to build:** No per-project split preference. No settings modal integration for this -- it is purely a toggle in the overlay header that remembers its state.

### Feature 3: Split screen terminal resize with draggable split handle

**What to build.** A draggable vertical resize handle on the split boundary, and CSS-variable-driven split positioning so both the workspace and the overlay respond to the split ratio.

**Files to modify:**

- `/home/claude-runner/apps/claude-web-app-v2/public/js/state/store.js`: Add a new signal `splitPosition` initialized from `localStorage.getItem('splitPosition')`, defaulting to `50` (percent).

- `/home/claude-runner/apps/claude-web-app-v2/public/js/components/App.js`: Set `document.documentElement.style.setProperty('--split-pos', splitPosition.value + '%')` in an effect that watches `splitPosition`. When `splitView` is true and a session is attached, add class `session-split` to `document.body`. Remove it when not in split mode.

- `/home/claude-runner/apps/claude-web-app-v2/public/js/components/SessionOverlay.js`:
  - Replace hardcoded `left: 50%` (line 53) with `left: var(--split-pos, 50%)`.
  - Add a split resize handle element as the first child of the overlay div, positioned at the left edge, visible only when `isSplit` is true.
  - Implement `onMouseDown` on the handle that tracks mouse movement, updates `splitPosition` signal (as a percentage of `window.innerWidth`), clamped between 20% and 85%.
  - On `mouseup`, persist the new position to `localStorage.setItem('splitPosition', ...)`.

- `/home/claude-runner/apps/claude-web-app-v2/public/css/styles.css`:
  - Add a CSS rule so that when `body.session-split` is present, `#workspace` gets `margin-right: calc(100% - var(--split-pos, 50%))` to push the workspace content left of the split boundary. This mirrors v1 behavior (v1 `styles.css` line 789-791).
  - Style the split resize handle: fixed position, `left: var(--split-pos, 50%)`, `top: var(--topbar-h)`, `bottom: 0`, `width: 7px`, `margin-left: -3px`, `z-index: 105` (above overlay z-index 100), cursor `col-resize`. Use the existing `.resize-handle::after` pattern for the visible drag indicator.

**Data flow:** `splitPosition` signal drives the `--split-pos` CSS variable. The CSS variable controls both the overlay `left` property and the workspace `margin-right`. The resize handle's mousedown/mousemove updates the signal, which triggers the effect, which updates the CSS variable.

**Edge cases:**
- Window resize while in split mode: The percentage-based approach handles this naturally.
- Resize below 20% or above 85%: Clamp to prevent either pane from being unusable.
- Rapid dragging: Use `requestAnimationFrame` or direct style updates (not signal updates on every mousemove) to avoid jank. Update the signal only on mouseup.
- TerminalPane resize: The existing `ResizeObserver` in TerminalPane (line 169) will detect the container size change and call `fitAddon.fit()` automatically. No additional wiring needed.

**What NOT to build:** No vertical split (top/bottom). No multi-pane tiling. No session-in-session split.

### Feature 4: Scroll handles and resize handles

**What to build.** Two things: (a) terminal scrollbar styling, and (b) wiring up the existing dead resize handles.

**(a) Terminal scrollbar styling.**

**Files to modify:**
- `/home/claude-runner/apps/claude-web-app-v2/public/css/styles.css`: Add scrollbar rules after the existing terminal styles (after line 434). Add the same scrollbar rules from v1 (`/home/claude-runner/apps/claude-web-app/public/css/styles.css` lines 1404-1430):
  - Global scrollbar: thin, 5px width, `var(--bg-active)` thumb on transparent track.
  - `.xterm-viewport`: `scrollbar-width: thin`, transparent by default, visible on `.xterm:hover` with `scrollbar-color: rgba(255,255,255,0.15) transparent`.
  - WebKit pseudo-elements for `.xterm-viewport::-webkit-scrollbar` with 4px width, transparent track, thumb that appears on hover.

**(b) Activating dead resize handles.**

**Files to modify:**
- `/home/claude-runner/apps/claude-web-app-v2/public/js/utils/dom.js` (or create a new `resize.js` util): Add an `initResize(handle, axis, target, opts)` function, ported from v1 (`/home/claude-runner/apps/claude-web-app/public/app.js` lines 2376-2427). The function attaches mousedown/mousemove/mouseup listeners that track drag delta and set `width` or `height` on the target element, clamped between `opts.min` and `opts.max`. On mouseup, trigger `fitAddon.fit()` for any visible terminals.

- `/home/claude-runner/apps/claude-web-app-v2/public/js/components/App.js`: Import `initResize`. In a `useEffect` with empty deps, query `#sidebar-resize` and `#project-sidebar`, call `initResize(handle, 'h', sidebar, { min: 140, max: 500 })`. Query `#resize-sessions` and `#sessions-area`, call `initResize(handle, 'v', area, { min: 60, max: 800 })`. Return cleanup functions that remove the listeners.

**Edge cases:**
- Resize handle not found in DOM (component not rendered yet): Guard with null checks.
- Sidebar collapsed to minimum: Content overflows. Use `overflow: hidden` on sidebar.
- Sessions area resized to maximum: Terminals area below becomes too small. The existing `min-height: 100px` on `#terminals-area` (line 378 of styles.css) provides a floor.

**What NOT to build:** No programmatic scrollbar position indicator overlay (the native styled scrollbar is sufficient). No touch/mobile drag support for resize handles. No keyboard-accessible resize.

---

## Section 3: Acceptance Criteria

1. **Given** the user opens the New Project modal and at least one project exists, **when** the user clicks or focuses the "Project Path" input field, **then** a dropdown appears showing the paths of all existing projects as suggestions.

2. **Given** the user has two projects at `/home/user/apps/foo` and `/home/user/apps/bar`, **when** the user types `/home/user/apps/` in the path field, **then** both paths appear as filtered suggestions in the dropdown.

3. **Given** the user has never toggled split view (fresh install/cleared localStorage), **when** the user creates a new session and it opens in the overlay, **then** the overlay renders in split-view mode (not full-screen).

4. **Given** the user toggles the overlay from split to full-screen, **when** they close and reopen a session overlay (or reload the page), **then** the overlay opens in full-screen mode (the preference was persisted).

5. **Given** the user is in split-view mode, **when** the user hovers over the left edge of the overlay (the split boundary), **then** a visible vertical resize handle/indicator appears with a `col-resize` cursor.

6. **Given** the user drags the split resize handle leftward to approximately 30% of the viewport, **when** they release the mouse, **then** the overlay's left edge is at approximately 30%, the workspace on the left fills approximately 30% of the viewport, and the terminal inside the overlay has re-fitted to its new container width.

7. **Given** the user is viewing a terminal in the overlay (split or full), **when** the terminal buffer has scrollback content and the user hovers over the terminal, **then** a thin scrollbar thumb becomes visible on the right edge of the terminal viewport.

8. **Given** the user drags the sidebar resize handle (between sidebar and detail pane), **when** they drag it rightward, **then** the sidebar width increases, and the detail pane width decreases proportionally.

9. **Given** the user drags the sessions/terminals vertical resize handle, **when** they drag it downward, **then** the sessions area height increases and the terminals area height decreases, and the "New Terminal" button remains visible.

10. **Given** the user reloads the page after adjusting the split position, **when** they open a session in split view, **then** the split position matches what they last set (persisted in localStorage).

---

## Section 4: User Lifecycle Stories

### Story 1: Repeat project creator

A developer maintains six microservices, all under `/home/dev/services/`. They open the New Project modal and start typing `/home/dev/serv` in the path field. The dropdown filters down to show all six paths. They select `/home/dev/services/auth-api` and only have to type the project name. Next week they add a seventh service -- they type the path prefix and see the existing six, then finish typing the new path manually. The dropdown helped them confirm the correct parent directory without leaving the modal.

### Story 2: First-time session launcher

A new user adds their first project and clicks "New Claude Session." The session overlay opens in split-view by default. On the left, they can see the project detail with their session card. On the right, the terminal shows Claude starting up. They do not need to know about or find the "Split" button -- the productive layout is immediate. If they want full-screen immersion, they click "Full" and the preference sticks for future sessions.

### Story 3: Multi-session monitor

A user has three sessions running. They open the first one, which appears in split view on the right. They can see the session list on the left and notice one session shows "waiting for input." They close the current overlay, open the waiting session, and respond. Between sessions, they drag the split handle to give the terminal more room -- about 65% of the screen. This ratio persists, so every subsequent session open gives them the wider terminal they prefer.

### Story 4: Terminal reader with scrollback

A user is reviewing a long Claude output in the terminal. They scroll up through the buffer. A thin scrollbar thumb appears on the right edge of the terminal as they hover, showing them where they are in the buffer. They can see they are about 40% through the output. They grab the scrollbar thumb and drag it to quickly navigate to the beginning. When they stop hovering, the scrollbar fades out, keeping the terminal clean.

### Story 5: Layout customizer

A user who runs their app on a wide monitor wants the sidebar narrow and the sessions area small, so the terminal panes get maximum vertical space. They drag the sidebar handle left to about 160px -- it stops at the minimum. They drag the sessions/terminals divider upward to shrink sessions to just two card rows. The terminals area below now fills most of the vertical space, and the "New Terminal" button is visible and reachable.

---

## Section 5: Risks & False-PASS Risks

### Risks

1. **CSS variable not propagating.** If `--split-pos` is set on `document.documentElement` but a component uses inline styles that override it, the variable will be ignored. The SessionOverlay currently uses inline styles for positioning (line 53 of SessionOverlay.js). The inline `left: 50%` must be changed to use `var(--split-pos)` or the CSS variable approach will silently fail.

2. **Signal reactivity vs DOM mutation.** The resize handle updates `splitPosition` on mouseup, but the visual drag needs to update the CSS variable on every mousemove for smooth feedback. If the implementation only updates via the Preact signal (which triggers a re-render), dragging will feel laggy. The implementation must update `document.documentElement.style` directly during drag and sync the signal only on mouseup.

3. **ResizeObserver race.** The TerminalPane's ResizeObserver fires when the container resizes. If the split handle drag causes continuous container resizes, `fitAddon.fit()` will be called on every frame, which is expensive. The implementation should debounce or skip fit calls during active drag and only fit on mouseup.

4. **datalist browser support.** HTML5 `<datalist>` is supported in all modern browsers but behaves differently across them (Chrome shows a dropdown, Firefox shows a dropdown only on focus/input, Safari had spotty support until recently). If the user's browser does not support datalist, the input degrades gracefully to a plain text field. This is acceptable.

5. **Dead resize handles in App.js.** The `#sidebar-resize` div is rendered at App.js line 61, between ProjectSidebar and ProjectDetail. But Preact components re-render the entire tree -- if the App re-renders, the DOM element the resize handler was attached to may be replaced. The `useEffect` attaching the handler must run after render and re-attach if the element changes, or use refs instead of `document.querySelector`.

### False-PASS risks

1. **Split view appears to work but workspace is not clipped.** A test might verify the overlay is positioned at `left: var(--split-pos)` and declare pass. But if `body.session-split` class is not applied, the workspace behind the overlay is still full-width, causing the left side to show content that is partially obscured by the overlay. The test must verify both that the overlay is positioned correctly AND that the workspace width is reduced.

2. **Resize handle visible but not functional.** The CSS for the handle may render correctly (hover state, cursor change), but if the JavaScript mousedown listener is not attached, dragging does nothing. A visual test would pass; a drag interaction test would catch this.

3. **Scrollbar appears only in WebKit.** The CSS rules use both Firefox (`scrollbar-width`, `scrollbar-color`) and WebKit (`::-webkit-scrollbar`) approaches. A test running only in Chromium (Playwright default) would see the WebKit scrollbar and pass, but Firefox users would see no scrollbar if the Firefox rules are missing or incorrect.

4. **Split position persists but is not applied on load.** The signal might read from localStorage correctly, but if the CSS variable is only set when `toggleSplit` runs (not on initial render), the first session open after a page reload would use the default 50% despite the stored value. The test must verify that after reload, the split position matches the previously set value.

5. **datalist suggestions appear but are stale.** If the `projects` signal updates (new project created in another tab or via API) but the datalist does not re-render because the modal was already open, the dropdown would show outdated paths. Since Preact signals trigger re-renders, this is unlikely, but a test should verify that adding a project while the modal is open updates the suggestions.
