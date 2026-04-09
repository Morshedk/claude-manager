# T-40 Design: Session Name with Special Characters — No Injection or Display Break

**Score:** 10 | **Type:** Playwright browser + server-level | **Port:** 3137

---

## What This Test Proves

Session names with dangerous characters must be:
1. Accepted (not rejected) by the server
2. Displayed as plain escaped text in the browser (no XSS)
3. Not cause path traversal or server errors
4. Truncated gracefully for very long names

Test payloads:
- `<img src=x onerror=alert(1)>` — XSS via HTML injection
- `../../etc/passwd` — path traversal attempt
- 256-character name — length limit behavior

---

## Key Architecture Understanding

### How session names flow:
1. Client sends `session:create` via WS with `{ name: '<img src=x onerror=alert(1)>' }`
2. `SessionHandlers.create()` receives the name, trims it
3. `SessionManager.create()` stores it in `meta.name`
4. `SessionStore.save()` persists it to `sessions.json`
5. Server broadcasts `session:created` with the name
6. Client receives `sessions:list` update with the name
7. `SessionCard.js` renders: `${sessionName}` — this is Preact's `htm` template literal
8. `SessionOverlay.js` renders: `${displayName}` in the header

### XSS risk analysis:
- Preact with htm: Template literals in htm are automatically escaped because Preact creates VNodes, not raw innerHTML. `${name}` in `html\`<span>${name}</span>\`` creates a text node, not raw HTML.
- The risk is ONLY if somewhere the code does `innerHTML = name` or `dangerouslySetInnerHTML`
- Search required: scan SessionCard.js and SessionOverlay.js for `innerHTML` or `dangerouslySetInnerHTML`

### Path traversal analysis:
- Session name `../../etc/passwd` is stored as a string in `sessions.json`
- Is it used as a filesystem path anywhere? Check if session name is used in file operations
- `SessionManager.create()` → sets `cwd: project.path` (not using name as path)
- `DirectSession.js` — check if `meta.name` is used in any `spawn()` path
- `SessionStore.save()` — stores name in JSON, not as filename
- Risk is LOW but must verify: name should never be interpolated into shell commands or filesystem paths

### Length analysis:
- `SessionHandlers.create()`: `const name = (msg.name || '').trim()` — no length limit enforced
- A 256-char name will be stored, persisted, and displayed
- CSS: `.session-card-name` must have overflow handling, else it will cause layout overflow
- `displayName` in SessionOverlay: `session.name || ...` with no truncation

---

## Infrastructure

- Port: 3137
- Sessions created via WS (not Playwright UI clicks — more reliable for special chars)
- Browser check for XSS: Playwright console monitoring + DOM inspection

---

## Exact Test Flow

### Step 1: Server setup
- Kill port 3137
- Create tmpDir, project directory
- Write valid projects.json
- Start server, wait for readiness

### Step 2: Create sessions with dangerous names via WS
- Open WS connection, wait for `init`
- Create session 1: name = `<img src=x onerror=alert(1)>`
- Wait for `session:created` for session 1, capture `id1`
- Create session 2: name = `../../etc/passwd`
- Wait for `session:created` for session 2, capture `id2`
- Create session 3: name = `A` * 256 (256 A's)
- Wait for `session:created` for session 3, capture `id3`
- Close WS

### Step 3: Verify server didn't crash
- GET /api/sessions — expect HTTP 200 and 3 sessions in list
- Verify each session ID is present in the list
- Verify session 1 name in API response is the literal string `<img src=x onerror=alert(1)>` (stored as-is)
- Verify session 2 name is `../../etc/passwd`
- Verify session 3 name length is 256 (or truncated to server's limit if any)

### Step 4: Open browser and check for XSS
- Navigate to `http://127.0.0.1:3137` with `waitUntil: 'domcontentloaded'`
- Set up console error listener: `page.on('console', ...)` to capture any `alert()` calls or JS errors
- Wait 2s for session list to render
- Click on the project to see sessions

### Step 5: XSS detection
- Check browser console for any `alert` dialogs: `page.on('dialog', ...)` — if a dialog fires, XSS succeeded (FAIL)
- Evaluate DOM: `document.querySelector('.session-card-name')?.textContent` — should be the literal string including `<` and `>` characters, NOT rendered as HTML
- Evaluate: `document.querySelector('.session-card-name img')` — should be null (img tag was not parsed as HTML)
- Take screenshot

### Step 6: HTML escaping verification
- Find the session card for session 1
- Evaluate `textContent` (plain text) vs `innerHTML` of the name element
- `textContent` should equal `<img src=x onerror=alert(1)>` (literal)
- `innerHTML` should equal `&lt;img src=x onerror=alert(1)&gt;` (escaped)
- If `innerHTML` equals `<img ...>` (unescaped), that's a stored XSS vulnerability (FAIL)

### Step 7: Path traversal check
- Click on session 2 card (name: `../../etc/passwd`)
- Verify no server error appears (no "Internal Server Error" toast or HTTP 500)
- Verify session opens in terminal overlay normally
- Verify display name in overlay header shows `../../etc/passwd` as text, not a file path
- GET /api/sessions — server still responds normally (didn't crash)

### Step 8: 256-char name check
- Find session 3 card
- Evaluate the displayed name text length
- Verify UI doesn't break (no layout overflow visible)
- Check: `.session-card-name` has `overflow: hidden` or `text-overflow: ellipsis` in computed style
- If the name is shown in a fixed-width container, verify it's truncated correctly
- Click on session 3 — verify overlay opens with truncated or full name shown cleanly

### Step 9: Final verification
- Page has no JS errors in console (except expected framework warnings)
- All 3 sessions still exist in API response
- Server is still running (HTTP 200 on root)

---

## False-PASS Risks

1. **XSS alert fires but test doesn't detect it**: If `page.on('dialog', ...)` is set up AFTER navigation, it might miss an alert that fires during page load. Mitigation: set up dialog handler BEFORE navigate.

2. **Checking `textContent` of wrong element**: If the session name is displayed in multiple places (card name + overlay header), checking only one might miss injection in the other. Must check both.

3. **innerHTML check wrong element**: If we evaluate `.session-card-name` but the rendered HTML uses a span wrapper, the `innerHTML` of the outer element includes the span's HTML. Must target the innermost text node.

4. **Path traversal test is vacuous**: `../../etc/passwd` as a session NAME is not the same as using it as a PATH. The real path traversal risk would be if the name is used in a file operation. Verify by checking if any server log shows `etc/passwd` being accessed.

5. **256-char name — PASS because truncated before storage**: If the server truncates the name server-side before storage, the 256-char name might only store as e.g. 100 chars. Not necessarily a bug, but must document what behavior was observed.

6. **Session created for wrong project**: If `projectId` in the WS message doesn't match any project, `session:create` will fail with error. Must verify `session:created` was received (not `session:error`).

---

## Pass / Fail Criteria

**PASS:**
- All 3 sessions created successfully (3 `session:created` received)
- Browser shows session names as plain text (XSS payload not executed — no dialog)
- `<img>` tag NOT present in DOM (not rendered as HTML element)
- Path traversal name causes no server error
- 256-char name displayed/truncated gracefully (no layout break)

**FAIL:**
- `alert(1)` dialog fires in browser (XSS successful)
- `document.querySelector('.session-card-name img')` returns non-null (img rendered as HTML)
- `../../etc/passwd` name causes server error or reveals filesystem paths
- 256-char name crashes session card rendering or record parser

**INCONCLUSIVE:**
- Sessions fail to create (server rejects names with special chars — could be intentional validation, not a bug)
- Browser fails to load or render session list
