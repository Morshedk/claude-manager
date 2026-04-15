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
 * TerminalPane — mounts and manages a full xterm.js terminal for a session.
 *
 * Key design:
 * - Unicode11 addon loads BEFORE xterm.open() to prevent glyph-width corruption
 * - WebGL → Canvas → DOM renderer fallback (VS Code parity)
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
    try {
      const webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
        try { xterm.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
      });
      xterm.loadAddon(webglAddon);
      gpuRenderer = true;
    } catch {}
    if (!gpuRenderer) {
      try { xterm.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
    }

    try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

    // Call fit() synchronously so the canvas is correctly sized from the first
    // paint. The container has resolved dimensions at useEffect time (Preact
    // fires effects after the browser has painted and laid out the DOM).
    try { fitAddon.fit(); } catch {}

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
        if (/^\x1b\[[\?>\d][;\d]*[cn]$/.test(data)) return;   // DA / DA2
        if (/^\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)$/.test(data)) return;  // OSC
        if (/^\x1b\[<[\d;]+[Mm]$/.test(data)) return;           // mouse events
        send({ type: CLIENT.SESSION_INPUT, id: sessionId, data });
      });
    }

    // ── 6. WebSocket message handlers ─────────────────────────────────────────

    // session:subscribed -> client clears xterm buffer before live output begins.
    // This prevents buffer accumulation across reconnects/restarts.
    const handleSubscribed = (msg) => {
      if (msg.id !== sessionId) return;
      xterm.reset();
      // Re-fit terminal and sync dimensions with PTY after refresh/reconnect.
      // Without this, the PTY may be at stale dimensions after restart.
      // Mirrors the logic in the connection:open reconnect handler.
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

    // ── 7. Subscribe — server sends session:subscribed, then live output ──────
    // A single rAF lets any pending layout pass complete before subscribing.
    // fit() was already called synchronously above, so the canvas is correctly
    // sized from the very first paint (no black-box flash).
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch {}
      xterm.focus();
      // Use actual fitted dimensions so PTY starts at the right width, not hardcoded defaults
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
