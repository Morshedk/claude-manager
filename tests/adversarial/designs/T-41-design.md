# T-41 Design: Reload Browser During Active File Operation (Upload in Progress)

**Score:** 9  
**Test type:** Playwright browser + server-level  
**Port:** 3138  
**Date:** 2026-04-08

---

## 1. What This Test Covers

The test asks: "Does a mid-upload browser reload leave the server in an inconsistent state?"

The app has a real file upload endpoint: `POST /api/upload/image` (routes.js line 244). It:
1. Reads `{ data, ext }` from JSON body (base64-encoded image data + file extension).
2. Creates an upload directory at `os.tmpdir()/claude-uploads/`.
3. Writes `Buffer.from(data, 'base64')` to a timestamped file.
4. Returns `{ path: filepath }`.

The write is **synchronous** (`fs.writeFileSync`). This means the request either completes fully or the server processes the body up to disconnect — there is no partial-write path because Express reads the full body before calling the handler. The real risk scenarios are:

- **Scenario A (upload not yet started):** Browser sends POST but aborts before server reads body. Server never calls the handler. No file written. Clean.
- **Scenario B (body partially sent, connection dropped):** Express's JSON body parser buffers the body. If the connection is closed mid-transfer, the body parser emits an error. The handler is never called. No file written. Clean.
- **Scenario C (write completes, browser reloads before response):** File IS written. Browser never gets the `{ path }` response. File is orphaned in `/tmp/claude-uploads/` but server is in a clean state (no dangling file handle, no reference in any session record).

The test must verify:
1. No server crash from aborted upload.
2. Session records remain intact after reload.
3. App loads cleanly after reload and is fully functional.
4. If any partial file was written, it doesn't corrupt subsequent requests.

---

## 2. Source Analysis

### File upload endpoint (routes.js:244–254)

```js
router.post('/api/upload/image', express.json({ limit: '20mb' }), (req, res) => {
  const { data, ext } = req.body;
  if (!data || !ext) return res.status(400).json({ error: 'Missing data or ext' });
  const uploadDir = path.join(os.tmpdir(), 'claude-uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `img-${Date.now()}.${ext}`;
  const filepath = path.join(uploadDir, filename);
  fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
  res.json({ path: filepath });
});
```

**Key findings:**
- Uses `express.json({ limit: '20mb' })` — body is buffered before handler runs.
- Write is synchronous — atomic from handler's perspective.
- No session record updated by this endpoint — files are standalone temp files.
- No file handle kept open after `writeFileSync` returns.

**Risk:** None for partial writes at the handler level. The risk is at the body-parser level if the connection is dropped before the body is fully sent.

### No UI for image upload in FileBrowser.js or SessionOverlay.js
The image upload is used via `FileBrowser.js` which has an `<input type="file">`. However, to test the mid-upload interrupt we can:
1. Use Playwright to navigate to the app, create a project/session.
2. Use `page.evaluate()` to fire a large fetch() upload.
3. While the fetch is in-flight, trigger a hard reload with `page.reload()`.

This tests the interruption at the network layer.

---

## 3. Exact Test Steps

### Infrastructure Setup
1. Start server on port 3138 with fresh tmp DATA_DIR.
2. Seed a project via WS: `project:create` with a valid path.
3. Create a session in that project.
4. Wait for server ready (poll `GET /`).

### Phase 1: Interrupted Upload via Playwright

**Step 1:** Navigate to `http://127.0.0.1:3138` in Chromium with `waitUntil: 'domcontentloaded'`.

**Step 2:** In the browser context, inject a large fetch POST to `/api/upload/image`. The payload should be ~15MB base64 data (large enough that it takes >200ms to upload over localhost). Use `page.evaluate()`:

```js
// Generate ~15MB of base64 data
const largeData = btoa('x'.repeat(11 * 1024 * 1024)); // ~15MB base64

// Start fetch in background (don't await)
const fetchPromise = fetch('/api/upload/image', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ data: largeData, ext: 'png' })
});
// Return immediately so Playwright can proceed
window.__uploadStarted = true;
```

**Step 3:** Within 50ms of starting the fetch, trigger a hard browser reload: `await page.reload({ waitUntil: 'domcontentloaded' })`. This aborts the in-flight request.

**Step 4:** Wait 2 seconds after reload for server to settle.

### Phase 2: Second Reload (as specified)

**Step 5:** Reload again: `await page.reload({ waitUntil: 'domcontentloaded' })`.

**Step 6:** Wait 1 second for page to stabilize.

### Phase 3: Server State Verification

**Step 7:** Check server is still responding: `GET /api/sessions` must return 200.

**Step 8:** Check session list is intact: the session created in setup must still exist in the response.

**Step 9:** Check the crash log file — must be empty (no server crash).

**Step 10:** Check that the app loaded cleanly by looking for the project name in the DOM: `page.locator('.project-item-name')` must be visible.

**Step 11:** Make a normal API call to `/api/upload/image` with a small valid payload (100 bytes). Must return 200 with a path. This confirms the endpoint still works after the interrupted upload.

**Step 12:** Check that no dangling file handles exist by making 3 more rapid upload calls in succession. All must succeed.

---

## 4. Pass/Fail Criteria

### PASS
- Server responds to `GET /api/sessions` after both reloads (server alive).
- Session created in setup is still present in session list (session record intact).
- Crash log is empty during the test window.
- App loads cleanly: project name visible in sidebar after both reloads.
- A fresh upload call after the interrupted upload succeeds with HTTP 200.

### FAIL
- Server returns non-200 or times out after the interrupted upload.
- Session record is missing or corrupted.
- Crash log has entries during the test window.
- Subsequent upload returns 5xx.
- App shows error state or blank page after reload.

---

## 5. False-PASS Risks

### Risk 1: Upload never actually interrupted
If the upload completes before `page.reload()` fires (localhost is fast), we haven't tested the interruption scenario. 
**Mitigation:** Use a payload large enough that it can't complete within 50ms (15MB should take >300ms even on localhost). Also verify with a timing check: `page.evaluate()` should return immediately, not after 300ms+.

### Risk 2: Server handles the abort gracefully by design, making the test trivially passing
This is actually the desired behavior — we're confirming the expected design holds under adversarial conditions. We need to make the test meaningful by:
- Using a large enough payload that Express's body parser receives some data before the connection drops.
- Checking the upload directory for orphaned partial files.

### Risk 3: Crash log check is vacuous
The crash log file may not exist if no crash has ever occurred. The check `crashLog === ''` would vacuously pass if the file isn't created.
**Mitigation:** Check file existence separately; if file doesn't exist, that's also PASS (no crash). If it exists, check its size or entries dated during the test window.

### Risk 4: App "loads cleanly" check is too loose
Just checking `domcontentloaded` doesn't mean the app is functional.
**Mitigation:** Wait for the project name to appear in the sidebar (requires WS connection to establish and sessions:list to be received). This proves the full connection cycle works.

---

## 6. Notes on Implementation

- Use `Promise.race()` with a short timeout to attempt the page.reload immediately after starting the fetch, without waiting for page.evaluate() to resolve (since the fetch is async in the browser).
- The test should NOT use Playwright's file upload API (`page.setInputFiles`) because we need to test the raw HTTP endpoint interruption, not a UI file chooser flow.
- Log the upload start time and reload time to confirm the reload happened before the fetch could complete.
- After the test, clean up: kill the server process, remove tmpDir.
