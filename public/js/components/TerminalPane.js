import { html } from 'htm/preact';
import { useRef, useEffect } from 'preact/hooks';
import { on, off, send } from '../ws/connection.js';
import { SERVER, CLIENT } from '../ws/protocol.js';

// ── Full theme matching v1 XTERM_THEME ────────────────────────────────────────
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
 * useScrollControl — attaches scroll tracking to an xterm instance.
 * Auto-scrolls to bottom on new output only when the user is already at bottom.
 * Ports v1 attachScrollControl() as a Preact hook.
 *
 * @param {object} xtermRef - ref whose .current = { xterm, fitAddon } | null
 * @param {HTMLElement} containerEl - the DOM element xterm was opened into
 */
function useScrollControl(xtermRef, containerEl) {
  useEffect(() => {
    if (!containerEl || !xtermRef.current) return;

    const { xterm } = xtermRef.current;

    // xterm renders into a nested .xterm-viewport element
    const vp = containerEl.querySelector('.xterm-viewport');
    if (!vp) return;

    let userScrolledUp = false;

    // Use 'scroll' (fires after scrollTop updates), NOT 'wheel' — wheel fires before
    // xterm updates scrollTop, so at-bottom reads would be stale.
    const onScroll = () => {
      const atBottom = Math.abs(vp.scrollTop - (vp.scrollHeight - vp.clientHeight)) < 5;
      userScrolledUp = !atBottom;
    };
    vp.addEventListener('scroll', onScroll, { passive: true });

    // Auto-scroll after each write, but only if user hasn't scrolled up
    const disposable = xterm.onWriteParsed(() => {
      if (!userScrolledUp) {
        vp.scrollTop = vp.scrollHeight;
      }
    });

    // Playwright test hooks on viewport element (kept for parity with v1)
    vp._scrollState = () => ({
      userScrolledUp,
      scrollTop: vp.scrollTop,
      scrollMax: Math.max(0, vp.scrollHeight - vp.clientHeight),
      bufferLength: xterm.buffer?.active?.length ?? 0,
      viewportY: xterm.buffer?.active?.viewportY ?? 0,
    });
    vp._scrollUp = (lines = 10) => xterm.scrollLines(-lines);
    vp._scrollToBottom = () => xterm.scrollToBottom();

    return () => {
      vp.removeEventListener('scroll', onScroll);
      disposable.dispose();
    };
  }, [containerEl, xtermRef.current]);
}

/**
 * TerminalPane — mounts and manages a full xterm.js terminal for a session.
 *
 * Key design:
 * - Unicode11 addon loads BEFORE xterm.open() to prevent glyph-width corruption
 * - WebGL → Canvas → DOM renderer fallback (VS Code parity)
 * - On session:snapshot → xterm.reset() then write clean rendered state (no dot artifacts)
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

  useEffect(() => {
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
      fastScrollSensitivity: 5,
      scrollSensitivity: 1,
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

    // ── 3. Open into container, then load GPU renderer ────────────────────────
    // GPU renderers must load AFTER open()
    xterm.open(container);

    let gpuRenderer = false;
    try { xterm.loadAddon(new WebglAddon.WebglAddon()); gpuRenderer = true; } catch {}
    if (!gpuRenderer) {
      try { xterm.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
    }

    try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

    fitAddon.fit();
    xtermRef.current = { xterm, fitAddon };

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
        if (/^\x1b\[[\?]?\d+[;\d]*[cn]$/.test(data)) return;
        send({ type: CLIENT.SESSION_INPUT, id: sessionId, data });
      });
    }

    // ── 6. WebSocket message handlers ─────────────────────────────────────────

    // session:snapshot → THE KEY DIFFERENCE FROM v1
    // xterm.reset() clears state cleanly, then we write the server-rendered snapshot.
    // No \x1bc hack needed — reset() is more reliable and avoids the dot artifact.
    const handleSnapshot = (msg) => {
      if (msg.id !== sessionId) return;
      xterm.reset();
      if (msg.data) xterm.write(msg.data);
    };

    // session:output → live PTY stream after snapshot
    const handleOutput = (msg) => {
      if (msg.id !== sessionId) return;
      if (msg.data) xterm.write(msg.data);
    };

    on(SERVER.SESSION_SNAPSHOT, handleSnapshot);
    on(SERVER.SESSION_OUTPUT, handleOutput);

    // ── 7. Subscribe — server sends snapshot first, then live output ──────────
    send({ type: CLIENT.SESSION_SUBSCRIBE, id: sessionId, cols, rows });

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
      off(SERVER.SESSION_SNAPSHOT, handleSnapshot);
      off(SERVER.SESSION_OUTPUT, handleOutput);
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
