import { html } from 'htm/preact';
import { useRef } from 'preact/hooks';
import { FileContentView } from './FileContentView.js';
import { fileSplitTarget, splitPosition, SPLIT_MIN, SPLIT_MAX } from '../state/store.js';
import { closeFileSplit } from '../state/actions.js';

/**
 * FileSplitPane — fixed-position right pane for split-screen file viewing.
 * Mirrors SessionOverlay.js positioning and drag logic.
 * Renders when fileSplitTarget.value is non-null.
 */
export function FileSplitPane() {
  const target = fileSplitTarget.value;
  if (!target) return null;

  const { path, projectPath } = target;
  const fileName = path ? path.split('/').pop() : '';

  const isDragging = useRef(false);

  const handleResizeMouseDown = (e) => {
    e.preventDefault();
    isDragging.current = true;
    const handle = e.currentTarget;
    handle.classList.add('dragging');

    const onMouseMove = (ev) => {
      if (!isDragging.current) return;
      const pct = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (ev.clientX / window.innerWidth) * 100));
      document.documentElement.style.setProperty('--split-pos', pct + '%');
    };

    const onMouseUp = (ev) => {
      isDragging.current = false;
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const pct = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (ev.clientX / window.innerWidth) * 100));
      splitPosition.value = pct;
      try { localStorage.setItem('splitPosition', String(pct)); } catch {}
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  return html`
    <div
      class="file-split-pane"
      style="
        position: fixed;
        left: var(--split-pos, 50%);
        right: 0;
        top: var(--topbar-h);
        bottom: 0;
        background: var(--bg-base);
        display: flex;
        flex-direction: column;
        z-index: 100;
        border-left: 1px solid var(--border);
      "
    >
      <div
        class="split-resize-handle"
        onMouseDown=${handleResizeMouseDown}
        title="Drag to resize"
      ></div>

      <!-- Header -->
      <header style="
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 12px;
        height: 40px;
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      ">
        <span style="font-size:13px;font-weight:600;color:var(--text-bright);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${fileName}
        </span>
        <button
          onClick=${closeFileSplit}
          title="Close file viewer"
          style="
            padding: 3px 10px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: var(--bg-raised);
            color: var(--text-secondary);
            font-size: 12px;
            font-family: var(--font-sans);
            cursor: pointer;
          "
        >\u2715</button>
      </header>

      <!-- Content body -->
      <div style="flex:1;overflow:auto;min-height:0;">
        <${FileContentView} path=${path} projectPath=${projectPath} />
      </div>
    </div>
  `;
}
