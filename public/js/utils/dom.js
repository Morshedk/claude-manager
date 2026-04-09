/**
 * dom.js — lightweight DOM utility helpers.
 */

/**
 * Query a single element, throwing if not found.
 * @param {string} selector
 * @param {Element|Document} [root]
 * @returns {Element}
 */
export function qs(selector, root = document) {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
}

/**
 * Query all matching elements.
 * @param {string} selector
 * @param {Element|Document} [root]
 * @returns {Element[]}
 */
export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

/**
 * Set multiple CSS properties on an element.
 * @param {HTMLElement} el
 * @param {CSSStyleDeclaration|object} styles
 */
export function css(el, styles) {
  Object.assign(el.style, styles);
}

/**
 * Toggle a class on an element.
 * @param {HTMLElement} el
 * @param {string} className
 * @param {boolean} [force]
 */
export function toggleClass(el, className, force) {
  el.classList.toggle(className, force);
}

/**
 * Attach a drag-to-resize behavior to a resize handle element.
 * @param {HTMLElement} handle  The drag handle element.
 * @param {'h'|'v'} axis       'h' for horizontal (width), 'v' for vertical (height).
 * @param {HTMLElement} target  The element to resize.
 * @param {{ min: number, max: number }} opts  Min/max size in pixels.
 * @returns {() => void}  Cleanup function that removes all listeners.
 */
export function initResize(handle, axis, target, opts = {}) {
  const { min = 0, max = Infinity } = opts;
  let startPos = 0;
  let startSize = 0;

  function onMouseDown(e) {
    e.preventDefault();
    startPos = axis === 'h' ? e.clientX : e.clientY;
    startSize = axis === 'h' ? target.offsetWidth : target.offsetHeight;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    const delta = (axis === 'h' ? e.clientX : e.clientY) - startPos;
    const newSize = Math.min(max, Math.max(min, startSize + delta));
    if (axis === 'h') {
      target.style.width = newSize + 'px';
    } else {
      target.style.height = newSize + 'px';
    }
  }

  function onMouseUp() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  handle.addEventListener('mousedown', onMouseDown);
  return () => {
    handle.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}

/**
 * Create a DOM element with optional attributes and children.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...(string|Node)} [children]
 * @returns {HTMLElement}
 */
export function createElement(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      el.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child) el.appendChild(child);
  }
  return el;
}
