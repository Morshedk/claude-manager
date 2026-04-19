// public/js/utils/clipboard.js

/**
 * Copy text to clipboard.
 *
 * execCommand runs FIRST and synchronously — it must complete before any
 * await, otherwise the browser's user-activation window expires and the
 * copy silently fails (the bug when navigator.clipboard is tried first on
 * an HTTP connection: the async await consumes the activation, then
 * execCommand falls back too late).
 *
 * @param {string} text
 * @returns {Promise<void>} resolves on success, rejects on failure
 */
export async function copyText(text) {
  // Try execCommand synchronously first — works inside user-gesture handlers
  // on any origin (HTTP or HTTPS). Must happen before any await.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return;
  } catch {}

  // Fallback: async Clipboard API (requires HTTPS / localhost)
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  throw new Error('Copy failed');
}
