import { html } from 'htm/preact';
import { useRef, useLayoutEffect } from 'preact/hooks';
import { on, off, send } from '../ws/connection.js';
import { SERVER, CLIENT } from '../ws/protocol.js';
import { showToast, openFileInThirdSpace } from '../state/actions.js';
import { copyText } from '../utils/clipboard.js';

// ── Full theme matching v1 XTERM_THEME ────────────────────────────────────────
const XTERM_THEME = {
  background:          '#0c1117',
  foreground:          '#d0d8e0',
  cursor:              '#00d4aa',
  cursorAccent:        '#0c1117',
  selectionBackground: 'rgba(0,212,170,0.4)',
  black:   '#1a2332', red:     '#f04848', green:  '#34c759', yellow: '#e8a020',
  blue:    '#4080ff', magenta: '#c060d0', cyan:   '#00c4aa', white:  '#c8d4e0',
  brightBlack:   '#253448', brightRed:     '#ff6060', brightGreen:  '#44d769',
  brightYellow:  '#ffc030', brightBlue:    '#60a0ff', brightMagenta:'#d080e0',
  brightCyan:    '#20d4c0', brightWhite:   '#eef1f5',
};

/**
 * TerminalPane — mounts and manages a full xterm.js terminal for a session.
 *
 * Key design:
 * - Unicode11 addon loads BEFORE xterm.open() to prevent glyph-width corruption
 * - WebGL renderer only (CanvasAddon version is incompatible — loads orphaned canvases)
 * - useLayoutEffect fires before browser paint: fit() runs synchronously so the
 *   canvas is correctly sized from the very first frame (no black-box flash)
 * - On session:subscribed -> xterm.reset() clears buffer before live output
 * - On session:output → write live PTY stream
 * - DA/DA2 responses from xterm replaying scrollback are filtered before forwarding
 *
 * @param {string}  sessionId  - session to attach to
 * @param {number}  [cols=120] - initial column count hint
 * @param {number}  [rows=30]  - initial row count hint
 * @param {boolean} [readOnly=false] - disable keyboard input (mobile / view-only)
 */
export function TerminalPane({ sessionId, cols = 120, rows = 30, readOnly = false }) {
  const containerRef = useRef(null);
  const xtermRef = useRef(null); // { xterm, fitAddon }

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !sessionId) return;

    // ── 1. Create xterm instance ──────────────────────────────────────────────
    const xterm = new Terminal({
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      fontSize: 13,
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      altClickMovesCursor: true,
      scrollOnEraseInDisplay: true,
      fastScrollSensitivity: 10,
      scrollSensitivity: 3,
      rescaleOverlappingGlyphs: true,
    });

    // ── 2. Load addons — Unicode11 MUST be before open() ─────────────────────
    const fitAddon = new FitAddon.FitAddon();
    try {
      const unicode11 = new Unicode11Addon.Unicode11Addon();
      xterm.loadAddon(unicode11);
      xterm.unicode.activeVersion = '11';
    } catch (e) {
      console.warn('[TerminalPane] Unicode11 addon failed:', e);
    }
    xterm.loadAddon(fitAddon);

    // ── 3. Open into container, then load WebGL renderer ─────────────────────
    // Note: CanvasAddon is intentionally omitted — the vendored version has an
    // API mismatch that causes it to throw on load, leaving orphaned 300×150
    // canvases that are never connected to the renderer and never resized.
    xterm.open(container);

    try {
      const webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => { webglAddon.dispose(); });
      xterm.loadAddon(webglAddon);
    } catch {}

    try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

    // Register file path link provider — clicks open the file in the third space
    try {
      xterm.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const line = xterm.buffer.active.getLine(bufferLineNumber);
          if (!line) { callback(undefined); return; }
          const text = line.translateToString(true);
          const re = /((?:\/|~\/)[\w.\-/]+\.\w[\w]*)/g;
          const links = [];
          let m;
          while ((m = re.exec(text)) !== null) {
            const filePath = m[0];
            const x1 = m.index + 1; // xterm columns are 1-based
            const x2 = m.index + filePath.length;
            links.push({
              range: {
                start: { x: x1, y: bufferLineNumber },
                end: { x: x2, y: bufferLineNumber },
              },
              text: filePath,
              activate(_e, _text) { openFileInThirdSpace(filePath); },
            });
          }
          callback(links);
        },
      });
    } catch (e) {
      console.warn('[TerminalPane] link provider failed:', e);
    }

    // Fit synchronously — useLayoutEffect fires before the browser paints, and
    // the container already has its resolved flex dimensions at this point.
    // The canvas is correctly sized from the very first frame; no black-box flash.
    try { fitAddon.fit(); } catch {}

    // Microtask re-fit: xterm's scrollBarWidth is only measured after the viewport
    // DOM element syncs for the first time (on the first data write or scroll).
    // The sync fit() above may see scrollBarWidth=0, calculating 1-2 extra cols.
    // A microtask runs after the current synchronous block, giving xterm enough
    // time to measure the real scrollbar width from the live DOM.
    Promise.resolve().then(() => { try { fitAddon.fit(); } catch {} });

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
          copyText(sel).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Copy failed', 'error'),
          );
          xterm.clearSelection();
          return false;
        }
        // No selection: Ctrl+Shift+C does nothing; Ctrl+C / Cmd+C passes through as SIGINT
        if (isCtrlShiftC) return false;
      }
      // Ctrl+V / Cmd+V: handle image paste ourselves before xterm can intercept
      const isCtrlV = e.ctrlKey && !e.metaKey && e.key === 'v';
      const isCmdV  = e.metaKey && !e.ctrlKey && e.key === 'v';
      if ((isCtrlV || isCmdV) && e.type === 'keydown') {
        navigator.clipboard.read().then((items) => {
          for (const item of items) {
            const imageType = item.types.find(t => t.startsWith('image/'));
            if (imageType) {
              item.getType(imageType).then((blob) => {
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
              });
              return;
            }
          }
          // No image — paste text normally
          navigator.clipboard.readText().then(text => { if (text) xterm.paste(text); }).catch(() => {});
        }).catch(() => {
          // clipboard.read() not permitted — fall back to text paste
          navigator.clipboard.readText().then(text => { if (text) xterm.paste(text); }).catch(() => {});
        });
        return false; // block xterm's default Ctrl+V handling
      }
      return true;
    });

    // Right-click: copy selection if any, else allow native context menu
    const handleContextMenu = (e) => {
      const sel = xterm.getSelection();
      if (sel.length > 0) {
        e.preventDefault();
        copyText(sel).then(
          () => showToast('Copied to clipboard', 'success'),
          () => showToast('Copy failed', 'error'),
        );
        xterm.clearSelection();
      }
    };
    container.addEventListener('contextmenu', handleContextMenu);

    // Right-click: copy selection if any, else allow native context menu

    // ── 4. Scroll control — auto-scroll only when user is at bottom ───────────
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

      // Playwright test hooks (parity with v1)
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
    let inputDisposable = null;
    if (!readOnly) {
      inputDisposable = xterm.onData((data) => {
        // Filter DA/DA2 responses that xterm auto-generates when replaying scrollback.
        // Forwarding these causes literal '?1;2c' to appear as text in bash/Claude.
        if (/^\x1b\[[\?>\d][;\d]*[cn]$/.test(data)) return;   // DA / DA2
        if (/^\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)$/.test(data)) return;  // OSC
        if (/^\x1b\[<[\d;]+[Mm]$/.test(data)) return;           // mouse events
        send({ type: CLIENT.SESSION_INPUT, id: sessionId, data });
      });
    }

    // ── 6. WebSocket message handlers ─────────────────────────────────────────

    // session:subscribed → server finished sending scrollback; re-fit and sync PTY dims.
    // Note: reset() is intentionally NOT called here. The server streams scrollback as
    // session:output events before sending subscribed, so reset() would erase the
    // scrollback the user just received. On reconnect, handleReconnect already resets
    // before re-subscribing, so there is no stale content to clear here.
    const handleSubscribed = (msg) => {
      if (msg.id !== sessionId) return;
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch {}
        xterm.focus();
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          send({ type: CLIENT.SESSION_RESIZE, id: sessionId, cols: dims.cols, rows: dims.rows });
        }
      });
    };

    // session:output → live PTY stream
    const handleOutput = (msg) => {
      if (msg.id !== sessionId) return;
      if (msg.data) xterm.write(msg.data);
    };

    // session:refreshed → session was restarted; re-focus xterm so user can type
    // without having to click the terminal (Refresh button retains focus otherwise).
    const handleRefreshed = (msg) => {
      if (msg.session && msg.session.id !== sessionId) return;
      requestAnimationFrame(() => {
        try { xterm.focus(); } catch {}
      });
    };

    on(SERVER.SESSION_SUBSCRIBED, handleSubscribed);
    on(SERVER.SESSION_OUTPUT, handleOutput);
    on('session:refreshed', handleRefreshed);

    // ── 7. Subscribe — rAF defers to after layout so PTY gets fitted dimensions ─
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch {}
      xterm.focus();
      const initDims = fitAddon.proposeDimensions();
      send({ type: CLIENT.SESSION_SUBSCRIBE, id: sessionId,
        cols: initDims?.cols || cols,
        rows: initDims?.rows || rows,
      });
    });

    // ── 7b. Re-subscribe on WS reconnect ────────────────────────────────────
    // When the WebSocket drops and reconnects, TerminalPane is still mounted
    // but the server has lost our subscription. Re-subscribe to get a fresh
    // snapshot and resume live output.
    const handleReconnect = () => {
      xterm.reset();
      try { fitAddon.fit(); } catch {}
      const dims = fitAddon.proposeDimensions();
      send({
        type: CLIENT.SESSION_SUBSCRIBE,
        id: sessionId,
        cols: dims?.cols || cols,
        rows: dims?.rows || rows,
      });
    };
    on('connection:open', handleReconnect);

    // ── 8. ResizeObserver — keep terminal fitted to container ─────────────────
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch {}
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        send({ type: CLIENT.SESSION_RESIZE, id: sessionId, cols: dims.cols, rows: dims.rows });
      }
    });
    resizeObserver.observe(container);

    // ── Cleanup on unmount or sessionId change ────────────────────────────────
    return () => {
      off(SERVER.SESSION_SUBSCRIBED, handleSubscribed);
      off(SERVER.SESSION_OUTPUT, handleOutput);
      off('session:refreshed', handleRefreshed);
      off('connection:open', handleReconnect);
      container.removeEventListener('contextmenu', handleContextMenu);
      resizeObserver.disconnect();
      if (scrollDisposable) scrollDisposable.dispose();
      if (inputDisposable) inputDisposable.dispose();
      send({ type: CLIENT.SESSION_UNSUBSCRIBE, id: sessionId });
      xterm.dispose();
      xtermRef.current = null;
    };
  }, [sessionId]); // Re-run if sessionId changes

  return html`<div ref=${containerRef} class="terminal-container" style="height:100%;width:100%;overflow:hidden;" />`;
}
