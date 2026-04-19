// public/js/utils/clipboard.js

/**
 * Copy text to clipboard. Tries navigator.clipboard first; falls back to
 * execCommand('copy') via a temporary textarea for non-HTTPS contexts.
 * @param {string} text
 * @returns {Promise<void>} resolves on success, rejects on failure
 */
export async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand fallback
    }
  }
  // execCommand fallback — works in non-secure contexts
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand copy failed');
}
