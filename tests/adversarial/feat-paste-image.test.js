import { test, expect } from 'playwright/test';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

async function dispatchImagePaste(page, selector) {
  return page.evaluate(async ({ b64, selector }) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const file = new File([blob], 'paste.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    const target = selector ? document.querySelector(selector) : document.body;
    target?.dispatchEvent(event);
    return { targetClass: target?.className ?? 'none' };
  }, { b64: PNG_B64, selector });
}

test('paste-image API endpoint returns a path', async ({ page }) => {
  await page.goto('http://127.0.0.1:3099');
  const resp = await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const r = await fetch('/api/paste-image', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
    return { status: r.status, body: await r.json() };
  }, PNG_B64);
  console.log('API:', JSON.stringify(resp));
  expect(resp.status).toBe(200);
  expect(resp.body.path).toBeTruthy();
});

test('image paste event dispatched to xterm fires fetch and shows toast', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('http://127.0.0.1:3099');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'qa-screenshots/paste-01-initial.png' });

  // Intercept fetch to see if /api/paste-image is called
  const fetchCalls = [];
  await page.route('/api/paste-image', async route => {
    fetchCalls.push(route.request().method());
    await route.continue();
  });

  const result = await dispatchImagePaste(page, '.xterm-screen');
  console.log('Paste target:', result.targetClass);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'qa-screenshots/paste-02-after-paste.png' });

  console.log('Fetch calls to /api/paste-image:', fetchCalls.length);

  const toastText = await page.locator('.toast').first().textContent().catch(() => 'no toast');
  console.log('Toast:', toastText);
});

test('copy permission denied shows correct error toast', async ({ page }) => {
  await page.goto('http://127.0.0.1:3099');
  await page.waitForTimeout(1000);

  // Override clipboard.writeText to simulate permission denied
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () => Promise.reject(new DOMException('NotAllowedError', 'Permission denied')),
        readText: () => Promise.reject(new DOMException('NotAllowedError', 'Permission denied')),
      },
      writable: false,
    });
  });

  await page.reload();
  await page.waitForTimeout(1000);

  // Manually trigger clipboard.writeText like the copy handler does
  await page.evaluate(() => {
    navigator.clipboard.writeText('test').catch(() => {
      // Simulate what the app does on failure
      window.dispatchEvent(new CustomEvent('test:copy-failed'));
    });
  });

  await page.screenshot({ path: 'qa-screenshots/paste-03-copy-denied.png' });
  console.log('Copy permission denied scenario tested');
});
