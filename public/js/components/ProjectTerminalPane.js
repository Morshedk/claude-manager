import { html } from 'htm/preact';
import { useRef, useLayoutEffect } from 'preact/hooks';
import { on, off, send } from '../ws/connection.js';
import { SERVER, CLIENT } from '../ws/protocol.js';
import { showToast } from '../state/actions.js';

// ── Full theme matching TerminalPane ──────────────────────────────────────────
const XTERM_THEME = {
  background:          '#0c1117',
  foreground:          '#d0d8e0',
  cursor:              '#00d4aa',
  cursorAccent:        '#0c1117',
  selectionBackground: 'rgba(0,212,170,0.25)',
  black:   '#1a2332', red:     '#f04848', green:  '#34c759', yellow: '#e8a020',
  blue:    '#4080ff', magenta: '#c060d0', cyan:   '#00c4aa', white:  '#c8d4e0',
  brightBlack:   '#253448', brightRed:     '#ff6060', brightGreen:  '#44d769',
  brightYellow:  '#ffc030', brightBlue:    '#60a0ff', brightMagenta:'#d080e0',
  brightCyan:    '#20d4c0', brightWhite:   '#eef1f5',
};

/**
 * ProjectTerminalPane — raw shell terminal for a project (not a Claude session).
 *
 * Differences from TerminalPane:
 * - Uses terminal:* message types instead of session:*
 * - No snapshot: project terminals are fresh PTY instances (no scrollback replay needed)
 * - Subscribes via terminal:attach (the terminal was already created server-side)
 *
 * @param {string} terminalId  - the terminal ID (matches server-side TerminalManager key)
 * @param {string} [cwd]       - working directory (used in terminal:create if creating)
 * @param {string} [projectId] - project this terminal belongs to
 * @param {boolean} [create=false] - if true, send terminal:create instead of terminal:attach
 */
export function ProjectTerminalPane({ terminalId, cwd, projectId, create = false }) {
  const containerRef = useRef(null);
  const xtermRef = useRef(null); // { xterm, fitAddon }

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !terminalId) return;

    // ── 1. Create xterm instance ──────────────────────────────────────────────
    const xterm = new Terminal({
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      altClickMovesCursor: true,
      scrollOnEraseInDisplay: true,
      fastScrollSensitivity: 5,
      scrollSensitivity: 1,
      rescaleOverlappingGlyphs: true,
    });

    // ── 2. Addons — Unicode11 MUST be before open() ───────────────────────────
    const fitAddon = new FitAddon.FitAddon();
    try {
      const unicode11 = new Unicode11Addon.Unicode11Addon();
      xterm.loadAddon(unicode11);
      xterm.unicode.activeVersion = '11';
    } catch (e) {
      console.warn('[ProjectTerminalPane] Unicode11 addon failed:', e);
    }
    xterm.loadAddon(fitAddon);

    // ── 3. Open, then load WebGL renderer ────────────────────────────────────
    // Note: CanvasAddon is intentionally omitted — the vendored version has an
    // API mismatch that causes it to throw on load, leaving orphaned 300×150
    // canvases that are never connected to the renderer and never resized.
    xterm.open(container);

    try { xterm.loadAddon(new WebglAddon.WebglAddon()); } catch {}
    try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

    // Fit synchronously — useLayoutEffect fires before the browser paints,
    // so the canvas is correctly sized from the very first frame.
    try { fitAddon.fit(); } catch {}
    xtermRef.current = { xterm, fitAddon };

    // ── Copy-to-clipboard: Ctrl+C / Cmd+C / Ctrl+Shift+C ─────────────────────
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const isCtrlC = e.ctrlKey && !e.shiftKey && e.key === 'c';
      const isCmdC  = e.metaKey && !e.shiftKey && e.key === 'c';
      const isCtrlShiftC = e.ctrlKey && e.shiftKey && e.key === 'C';
      if (isCtrlC || isCmdC || isCtrlShiftC) {
        const sel = xterm.getSelection();
        if (sel.length > 0) {
          navigator.clipboard.writeText(sel).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Copy failed — check clipboard permissions', 'error'),
          );
          xterm.clearSelection();
          return false;
        }
        if (isCtrlShiftC) return false;
      }
      return true;
    });

    const handleContextMenu = (e) => {
      const sel = xterm.getSelection();
      if (sel.length > 0) {
        e.preventDefault();
        navigator.clipboard.writeText(sel).then(
          () => showToast('Copied to clipboard', 'success'),
          () => showToast('Copy failed — check clipboard permissions', 'error'),
        );
        xterm.clearSelection();
      }
    };
    container.addEventListener('contextmenu', handleContextMenu);

    const handlePaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) return;
          fetch('/api/paste-image', {
            method: 'POST',
            headers: { 'Content-Type': blob.type },
            body: blob,
          })
            .then(r => r.json())
            .then(({ path }) => {
              xterm.paste(path);
              showToast('Image saved — path pasted', 'success');
            })
            .catch(() => showToast('Image paste failed', 'error'));
          return;
        }
      }
    };
    container.addEventListener('paste', handlePaste);

    // ── 4. Scroll control ─────────────────────────────────────────────────────
    const vp = container.querySelector('.xterm-viewport');
    let userScrolledUp = false;
    let scrollDisposable = null;

    if (vp) {
      const onScroll = () => {
        const atBottom = Math.abs(vp.scrollTop - (vp.scrollHeight - vp.clientHeight)) < 5;
        userScrolledUp = !atBottom;
      };
      vp.addEventListener('scroll', onScroll, { passive: true });

      scrollDisposable = xterm.onWriteParsed(() => {
        if (!userScrolledUp) vp.scrollTop = vp.scrollHeight;
      });

      vp._scrollState = () => ({
        userScrolledUp,
        scrollTop: vp.scrollTop,
        scrollMax: Math.max(0, vp.scrollHeight - vp.clientHeight),
        bufferLength: xterm.buffer?.active?.length ?? 0,
        viewportY: xterm.buffer?.active?.viewportY ?? 0,
      });
      vp._scrollUp = (lines = 10) => xterm.scrollLines(-lines);
      vp._scrollToBottom = () => xterm.scrollToBottom();
    }

    // ── 5. Input handler ──────────────────────────────────────────────────────
    const inputDisposable = xterm.onData((data) => {
      send({ type: CLIENT.TERMINAL_INPUT, id: terminalId, data });
    });

    // ── 6. Output handler — no snapshot for project terminals ─────────────────
    const handleOutput = (msg) => {
      if (msg.id !== terminalId) return;
      if (msg.data) xterm.write(msg.data);
    };

    const handleClosed = (msg) => {
      if (msg.id !== terminalId) return;
      xterm.write('\r\n\x1b[33m[terminal closed]\x1b[0m\r\n');
    };

    const handleError = (msg) => {
      if (msg.id !== terminalId) return;
      xterm.write(`\r\n\x1b[31m[error: ${msg.error || 'unknown'}]\x1b[0m\r\n`);
    };

    on(SERVER.TERMINAL_OUTPUT, handleOutput);
    on(SERVER.TERMINAL_CLOSED, handleClosed);
    on(SERVER.TERMINAL_ERROR, handleError);

    // ── 7. Attach or create the server-side terminal ──────────────────────────
    if (create && cwd) {
      send({ type: CLIENT.TERMINAL_CREATE, id: terminalId, cwd, projectId });
    } else {
      // terminal:attach is not in the CLIENT protocol constants — send raw type
      send({ type: 'terminal:attach', id: terminalId });
    }

    // ── 8. ResizeObserver ─────────────────────────────────────────────────────
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch {}
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        send({ type: CLIENT.TERMINAL_RESIZE, id: terminalId, cols: dims.cols, rows: dims.rows });
      }
    });
    resizeObserver.observe(container);

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      off(SERVER.TERMINAL_OUTPUT, handleOutput);
      off(SERVER.TERMINAL_CLOSED, handleClosed);
      off(SERVER.TERMINAL_ERROR, handleError);
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('paste', handlePaste);
      resizeObserver.disconnect();
      if (scrollDisposable) scrollDisposable.dispose();
      inputDisposable.dispose();
      xterm.dispose();
      xtermRef.current = null;
    };
  }, [terminalId]);

  return html`<div ref=${containerRef} class="terminal-container" style="height:100%;width:100%;overflow:hidden;" />`;
}
