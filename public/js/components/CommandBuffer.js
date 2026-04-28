import { html } from 'htm/preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { send, on, off } from '../ws/connection.js';
import { CLIENT } from '../ws/protocol.js';
import { connected } from '../state/store.js';

/**
 * CommandBuffer — a local text input area below the terminal for composing
 * commands without network latency. Supports queuing when disconnected.
 *
 * @param {string} targetId   - session or terminal ID to send input to
 * @param {string} inputType  - 'session' or 'terminal'
 */
export function CommandBuffer({ targetId, inputType }) {
  const [text, setText] = useState('');
  const [queue, setQueue] = useState([]);
  const textareaRef = useRef(null);

  const isConnected = connected.value;

  // Determine the correct CLIENT message type
  const msgType = inputType === 'terminal' ? CLIENT.TERMINAL_INPUT : CLIENT.SESSION_INPUT;

  // ── Send or queue the current text ──────────────────────────────────────────
  const handleSend = useCallback(() => {
    const content = text;
    if (!content) return;

    if (connected.value) {
      send({ type: msgType, id: targetId, data: content + '\r' });
    } else {
      // Queue for later
      setQueue(prev => [...prev, {
        id: crypto.randomUUID(),
        text: content,
        status: 'pending',
      }]);
    }

    setText('');
    // Re-focus textarea so user can keep typing
    if (textareaRef.current) textareaRef.current.focus();
  }, [text, msgType, targetId]);

  // ── Cancel a queued message ─────────────────────────────────────────────────
  const handleCancel = useCallback((queueId) => {
    setQueue(prev => prev.filter(q => q.id !== queueId));
  }, []);

  // ── Drain queue on reconnect ────────────────────────────────────────────────
  useEffect(() => {
    const drainQueue = () => {
      setQueue(prev => {
        if (prev.length === 0) return prev;

        // Start draining: send each message with a staggered delay
        const updated = prev.map(q => ({ ...q }));
        let delay = 0;

        for (const item of updated) {
          if (item.status !== 'pending') continue;
          item.status = 'sending';

          ((currentItem, currentDelay) => {
            setTimeout(() => {
              send({ type: msgType, id: targetId, data: currentItem.text + '\r' });

              // Mark as sent
              setQueue(prev2 => prev2.map(q =>
                q.id === currentItem.id ? { ...q, status: 'sent' } : q
              ));

              // Remove after visual confirmation delay
              setTimeout(() => {
                setQueue(prev2 => prev2.filter(q => q.id !== currentItem.id));
              }, 1500);
            }, currentDelay);
          })(item, delay);

          delay += 100;
        }

        return updated;
      });
    };

    on('connection:open', drainQueue);
    return () => {
      off('connection:open', drainQueue);
    };
  }, [msgType, targetId]);

  // ── Keyboard handler ────────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e) => {
    // Ctrl+Enter or Cmd+Enter: send
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
      return;
    }

    // Escape: clear textarea
    if (e.key === 'Escape') {
      e.preventDefault();
      setText('');
      return;
    }

    // Tab: insert tab character instead of changing focus
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const newVal = val.substring(0, start) + '\t' + val.substring(end);
      setText(newVal);
      // Restore cursor position after the tab
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
      });
      return;
    }
  }, [handleSend]);

  // ── Queue display ───────────────────────────────────────────────────────────
  const hasQueue = queue.length > 0;

  const statusColors = {
    pending: { bg: 'rgba(232, 160, 32, 0.15)', color: '#e8a020', label: 'Queued' },
    sending: { bg: 'rgba(64, 128, 255, 0.15)', color: '#4080ff', label: 'Sending...' },
    sent:    { bg: 'rgba(52, 199, 89, 0.15)',  color: '#34c759', label: 'Sent' },
  };

  return html`
    <div
      class="command-buffer"
      style="
        flex-shrink: 0;
        border-top: 1px solid var(--border);
        background: #0f1419;
      "
    >
      ${!isConnected ? html`
        <div style="
          padding: 3px 10px;
          background: rgba(232, 160, 32, 0.1);
          color: #e8a020;
          font-size: 11px;
          font-family: var(--font-sans);
          border-bottom: 1px solid rgba(232, 160, 32, 0.2);
        ">
          Disconnected — messages will queue
        </div>
      ` : null}

      ${hasQueue ? html`
        <div
          class="command-buffer-queue"
          style="
            max-height: 120px;
            overflow-y: auto;
            border-bottom: 1px solid var(--border);
          "
        >
          ${queue.map(item => {
            const st = statusColors[item.status] || statusColors.pending;
            const preview = item.text.length > 60
              ? item.text.substring(0, 60) + '...'
              : item.text;
            return html`
              <div
                key=${item.id}
                style="
                  display: flex;
                  align-items: center;
                  gap: 8px;
                  padding: 4px 10px;
                  font-size: 11px;
                  font-family: var(--font-mono);
                  background: ${st.bg};
                  border-bottom: 1px solid rgba(255,255,255,0.04);
                "
              >
                <span style="
                  padding: 1px 6px;
                  border-radius: 3px;
                  background: ${st.bg};
                  color: ${st.color};
                  font-size: 10px;
                  font-family: var(--font-sans);
                  font-weight: 600;
                  white-space: nowrap;
                  flex-shrink: 0;
                ">${st.label}</span>
                <span style="
                  flex: 1;
                  color: var(--text-secondary);
                  overflow: hidden;
                  text-overflow: ellipsis;
                  white-space: nowrap;
                ">${preview}</span>
                ${item.status === 'pending' ? html`
                  <button
                    onClick=${() => handleCancel(item.id)}
                    title="Cancel queued message"
                    style="
                      width: 18px;
                      height: 18px;
                      border-radius: 3px;
                      background: rgba(240, 72, 72, 0.15);
                      color: #f04848;
                      border: none;
                      font-size: 11px;
                      line-height: 1;
                      cursor: pointer;
                      flex-shrink: 0;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                    "
                  >✕</button>
                ` : null}
              </div>
            `;
          })}
        </div>
      ` : null}

      <div style="
        display: flex;
        align-items: flex-end;
        gap: 6px;
        padding: 6px 8px;
      ">
        <textarea
          ref=${textareaRef}
          value=${text}
          onInput=${(e) => setText(e.target.value)}
          onKeyDown=${handleKeyDown}
          placeholder="Type command here... (Ctrl+Enter to send)"
          rows="2"
          style="
            flex: 1;
            min-height: 36px;
            max-height: 160px;
            resize: vertical;
            background: #141a22;
            color: #d0d8e0;
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 6px 8px;
            font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
            font-size: 12px;
            line-height: 1.4;
            outline: none;
            tab-size: 4;
          "
          onfocus=${(e) => { e.target.style.borderColor = 'var(--accent)'; }}
          onblur=${(e) => { e.target.style.borderColor = 'var(--border)'; }}
        />
        <button
          onClick=${handleSend}
          disabled=${!text}
          title=${isConnected ? 'Send to terminal (Ctrl+Enter)' : 'Queue message (Ctrl+Enter)'}
          style="
            padding: 6px 14px;
            height: 36px;
            border-radius: var(--radius-sm);
            border: 1px solid ${isConnected ? 'var(--accent)' : '#e8a020'};
            background: ${isConnected ? 'rgba(0, 212, 170, 0.15)' : 'rgba(232, 160, 32, 0.15)'};
            color: ${!text ? 'var(--text-muted)' : (isConnected ? 'var(--accent)' : '#e8a020')};
            font-size: 12px;
            font-family: var(--font-sans);
            font-weight: 600;
            cursor: ${text ? 'pointer' : 'default'};
            white-space: nowrap;
            flex-shrink: 0;
            opacity: ${text ? '1' : '0.5'};
            transition: opacity 0.15s, background 0.15s;
          "
        >${isConnected ? 'Send' : 'Queue'}</button>
      </div>
    </div>
  `;
}
