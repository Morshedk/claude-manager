# T-47 Design: Session Cards Render Without Layout Break for 10+ Cards

**Port:** 3144  
**Score:** 7  
**Type:** Playwright browser

---

## Test Goal

Verify that when a project has 10 or more sessions, all session cards are visible and accessible. No card overflows its container, no buttons are clipped, and the layout does not collapse.

---

## Code Path Analysis

### Session card rendering

`ProjectDetail.js` renders all `projectSessions` via:
```js
sessions.map(s => html`<${SessionCard} key=${s.id} session=${s} />`)
```

The container `#project-sessions-list` must scroll when sessions overflow it. CSS on the container governs this. If `overflow: hidden` is set without `overflow-y: auto/scroll`, cards below the fold would be invisibly clipped.

### SessionCard structure

`SessionCard.js` renders `.session-card` with `.session-card-header` and `.session-card-actions`. Actions contain "Open" + either "Stop" or "Refresh"+"Delete". Card is a flexbox row with `session-card-name-link` + badges + actions.

### Potential failure modes

1. **`#project-sessions-list` overflow hidden:** If CSS sets `overflow: hidden` on the sessions list container, cards beyond the visible height are invisible with no scrollbar. Test must check that the last card is reachable.

2. **Fixed height without scroll:** If `#sessions-area` or `#project-sessions-list` has a fixed height too small for 10 cards, without scroll, they'd be clipped.

3. **Card min-width > container width:** If session names are long or badges accumulate, cards might overflow horizontally, wrapping buttons to a new line or hiding them behind other elements.

4. **Flexbox column collapse:** If the card container uses flexbox without `flex-shrink: 0` on child cards, cards might squish to zero height.

5. **Absolute/fixed positioned elements from overlay clipping cards:** The session overlay uses `position: fixed; z-index: 100`. When no overlay is open, this is irrelevant. But test must ensure no overlay is open when checking cards.

---

## Infrastructure Setup

### Server startup
```js
serverProc = spawn('node', ['server-with-crash-log.mjs'], {
  cwd: APP_DIR,
  env: { ...process.env, DATA_DIR: tmpDir, PORT: '3144', CRASH_LOG: crashLogPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Poll `GET /api/sessions` until 200.

### Project seed
```json
{
  "projects": [
    { "id": "proj-t47", "name": "T47-Project", "path": "/tmp", "createdAt": "2026-01-01T00:00:00Z" }
  ],
  "scratchpad": []
}
```

### Session creation strategy

Create 10 sessions via the WS `session:create` message through a headless WS client (not the browser) for speed, then refresh the browser. Alternatively, create via the REST/WS API in a setup loop.

**Preferred approach:** Use Node.js `ws` library in `beforeAll` to send 10 `session:create` messages — one per session, each using `bash` as the command for fast startup. Wait for each to appear in `GET /api/sessions`. This avoids Playwright UI interaction for session creation (which is slow and tested elsewhere).

Sessions should use `bash` command to start quickly. Names: "session-01" through "session-10".

Creation via WebSocket:
```js
const WebSocket = (await import('ws')).default;
const wsClient = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise(r => wsClient.once('open', r));

// Wait for init message to get clientId
const initMsg = await new Promise(r => wsClient.once('message', d => r(JSON.parse(d))));

for (let i = 1; i <= 10; i++) {
  wsClient.send(JSON.stringify({
    type: 'session:create',
    projectId: 'proj-t47',
    name: `session-${String(i).padStart(2, '0')}`,
    command: 'bash',
    mode: 'direct',
  }));
  await sleep(300); // brief pause to avoid flooding
}

wsClient.close();

// Wait until API shows >= 10 sessions
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  const r = await fetch(`${BASE_URL}/api/sessions`);
  const body = await r.json();
  const managed = Array.isArray(body.managed) ? body.managed : [];
  if (managed.length >= 10) break;
  await sleep(500);
}
```

---

## Exact Test Execution Steps

### Step 1: Navigate
- `goto(BASE_URL, { waitUntil: 'domcontentloaded' })`
- Wait for `.status-dot.connected` (up to 8s)

### Step 2: Select project
- Click `.project-item` containing "T47-Project"
- Wait for project to be active

### Step 3: Verify session count via API
- `GET /api/sessions`
- Assert `managed.length >= 10`
- Record all session IDs

### Step 4: Wait for session cards to render
- Wait for `#project-sessions-list .session-card` count >= 10 (using `waitForFunction`, up to 10s)

### Step 5: Take screenshot BEFORE scroll
- `page.screenshot({ path: 'T-47-before-scroll.png' })`

### Step 6: Assertions on all visible cards (no scroll)
For each of the first visible cards:
- Verify `.session-card` elements exist
- Count: assert 10 cards in DOM (`document.querySelectorAll('.session-card').length >= 10`)

### Step 7: Scrollability check
Using `page.evaluate`:
```js
const list = document.querySelector('#project-sessions-list');
const scrollable = list.scrollHeight > list.clientHeight;
const overflowStyle = getComputedStyle(list).overflowY;
// Return both values — test will determine pass/fail
return { scrollable, overflowStyle, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
```
If `scrollable === false` AND all 10 cards fit in the viewport — this is fine (cards are small enough).  
If `scrollable === false` AND cards are clipped (some have `clientHeight === 0`) — FAIL.

**The core assertion:** All 10 cards must have non-zero height and be reachable.

### Step 8: Check each card's bounding box
```js
const cards = document.querySelectorAll('.session-card');
const results = [];
for (const card of cards) {
  const rect = card.getBoundingClientRect();
  const listRect = document.querySelector('#project-sessions-list').getBoundingClientRect();
  results.push({
    name: card.querySelector('.session-card-name')?.textContent,
    height: rect.height,
    width: rect.width,
    top: rect.top,
    bottom: rect.bottom,
    overflowsRight: rect.right > listRect.right + 5,
  });
}
return results;
```
Assert:
- All cards have `height > 0` (not zero-height/collapsed)
- No card has `overflowsRight === true` (no horizontal overflow)

### Step 9: Scroll the list and verify hidden cards become visible
- `page.evaluate(() => { const list = document.querySelector('#project-sessions-list'); list.scrollTop = list.scrollHeight; })`
- Sleep 300ms
- Take screenshot: `T-47-after-scroll.png`
- Re-check the last card's bounding box: it must now be in the viewport OR the list must be scrolled to show it

### Step 10: Action buttons accessible
For the first visible session card:
- Assert "Open" button exists within the card (`.session-card-actions button` with text "Open")
- Assert it's not hidden (not `display:none`, not `visibility:hidden`, not clipped)
- Get button's bounding box and verify width > 0, height > 0

For a card that is scrolled into view (scroll list to bottom):
- Find the last card (last `.session-card`)
- Scroll it into view using `card.scrollIntoView()`
- Assert last card's "Open" button has width > 0, height > 0

### Step 11: Screenshot of scrolled state
- `page.screenshot({ path: 'T-47-scrolled-end.png', fullPage: false })`

### Step 12: Crash log check
- Assert no server exceptions during test window

---

## Pass / Fail Criteria

| Check | PASS | FAIL |
|-------|------|------|
| 10 cards in DOM | `querySelectorAll('.session-card').length >= 10` | < 10 cards |
| All cards have height | All `rect.height > 0` | Any card has height 0 |
| No horizontal overflow | `rect.right <= listRect.right + 5` for all | Any card overflows right |
| Scroll works (if needed) | List scrollable OR all cards visible | Cards clipped, no scrollbar |
| Buttons accessible | "Open" button width>0 height>0 on last card | Button clipped or hidden |
| No crashes | Crash log empty | Server exception during test |

---

## What a Vacuous PASS Would Look Like

If the test only counts `.session-card` elements (== 10) without checking their heights, a CSS bug that renders all cards with `height: 0` or `visibility: hidden` would still pass the count check. The height check and the button bounding-box check are essential to prove the cards are actually rendered and accessible.

Similarly, checking only the first card's button visibility misses the common bug where only the last N cards are clipped (overflow hidden below the fold). Must explicitly scroll the list and verify the final card.
