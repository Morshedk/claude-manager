/**
 * Regression test: session:subscribe must resize PTY BEFORE capturing scrollback.
 *
 * Bug: scrollback was captured at the old PTY column count, then the PTY was
 * resized to the client's actual width. This caused scrollback to render with
 * wrong line wrapping (e.g. captured at 133 cols, displayed in a 79-col terminal).
 *
 * Fix: resize() must be called before subscribe() (which triggers getScrollback()).
 */

import { jest } from '@jest/globals';
import { SessionHandlers } from '../../lib/ws/handlers/sessionHandlers.js';

function makeRegistry() {
  return {
    get: jest.fn().mockReturnValue({ id: 'client1' }),
    send: jest.fn(),
    broadcast: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    broadcastToSession: jest.fn(),
  };
}

function makeSessionManager(sessionMeta = {}) {
  const callOrder = [];
  const mgr = {
    _callOrder: callOrder,
    exists: jest.fn().mockReturnValue(true),
    get: jest.fn().mockReturnValue({ id: 'sess1', cols: 133, rows: 30, ...sessionMeta }),
    subscribe: jest.fn().mockImplementation(async () => {
      callOrder.push('subscribe');
      return null; // no scrollback
    }),
    resize: jest.fn().mockImplementation((id, cols, rows) => {
      callOrder.push('resize');
    }),
    list: jest.fn().mockReturnValue([]),
    on: jest.fn(),
    startPreviewInterval: jest.fn(),
  };
  return mgr;
}

describe('SessionHandlers.subscribe — resize-before-scrollback ordering', () => {
  let registry;
  let sessionMgr;
  let handlers;

  beforeEach(() => {
    registry = makeRegistry();
    sessionMgr = makeSessionManager();
    handlers = new SessionHandlers(sessionMgr, registry);
  });

  test('resize() is called BEFORE subscribe() when cols and rows are provided', async () => {
    await handlers.subscribe('client1', {
      type: 'session:subscribe',
      id: 'sess1',
      cols: 79,
      rows: 41,
    });

    expect(sessionMgr._callOrder).toEqual(['resize', 'subscribe']);
  });

  test('scrollback is captured AFTER PTY is resized to client dimensions', async () => {
    let colsAtSubscribeTime = null;

    // Capture what cols the PTY is at when subscribe (getScrollback) is called
    sessionMgr.resize.mockImplementation((id, cols, rows) => {
      sessionMgr._callOrder.push('resize');
      // Simulate PTY updating its cols after resize
      sessionMgr.get.mockReturnValue({ id: 'sess1', cols, rows });
    });

    sessionMgr.subscribe.mockImplementation(async () => {
      const session = sessionMgr.get('sess1');
      colsAtSubscribeTime = session.cols;
      sessionMgr._callOrder.push('subscribe');
      return null;
    });

    await handlers.subscribe('client1', {
      type: 'session:subscribe',
      id: 'sess1',
      cols: 79,
      rows: 41,
    });

    // Scrollback must be captured at the CLIENT's column count (79), not the old PTY width (133)
    expect(colsAtSubscribeTime).toBe(79);
  });
});
