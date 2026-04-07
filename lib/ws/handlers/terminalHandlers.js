import { v4 as uuidv4 } from 'uuid';

/**
 * makeTerminalHandlers — factory that binds TerminalManager and clientRegistry.
 * Returns a plain object whose methods match the MessageRouter calling convention:
 *   handler.method(clientId, msg, registry)
 *
 * @param {import('../../terminals/TerminalManager.js').TerminalManager} terminalManager
 * @param {import('../clientRegistry.js').clientRegistry} registry
 * @returns {object}
 */
export function makeTerminalHandlers(terminalManager, registry) {
  return {
    /**
     * terminal:create — open (or reattach to) a PTY terminal.
     * msg: { type, id?, cwd, cols, rows, projectId }
     */
    create(clientId, msg) {
      const id = msg.id || uuidv4();

      if (!terminalManager.exists(id)) {
        try {
          terminalManager.create(id, {
            cwd: msg.cwd,
            cols: msg.cols || 120,
            rows: msg.rows || 30,
            projectId: msg.projectId || null,
          });
        } catch (e) {
          registry.send(clientId, { type: 'terminal:error', id, error: e.message });
          return;
        }
      }

      // Subscribe client to live output
      terminalManager.addViewer(id, clientId, (data) => {
        registry.send(clientId, { type: 'terminal:output', id, data });
      });

      // Track subscription on the client record so cleanup works on disconnect
      const client = registry.get(clientId);
      if (client) client.subscriptions.add(id);

      // Replay existing scrollback
      const scrollback = terminalManager.getScrollback(id);
      if (scrollback) {
        registry.send(clientId, { type: 'terminal:output', id, data: scrollback });
      }

      registry.send(clientId, { type: 'terminal:created', id });
    },

    /**
     * terminal:input — forward keyboard data to the PTY.
     * msg: { type, id, data }
     */
    input(clientId, msg) {
      terminalManager.write(msg.id, msg.data);
    },

    /**
     * terminal:resize — resize the PTY window.
     * msg: { type, id, cols, rows }
     */
    resize(clientId, msg) {
      terminalManager.resize(msg.id, msg.cols, msg.rows);
    },

    /**
     * terminal:close — remove this client's viewer; destroy if last viewer.
     * msg: { type, id }
     */
    close(clientId, msg) {
      const id = msg.id;
      terminalManager.removeViewer(id, clientId);

      const client = registry.get(clientId);
      if (client) client.subscriptions.delete(id);

      // Destroy the terminal if nobody is watching it
      const term = terminalManager.get(id);
      if (term && term.viewers.size === 0) {
        terminalManager.destroy(id);
      }

      registry.send(clientId, { type: 'terminal:closed', id });
    },

    /**
     * terminal:list — send the list of all live terminals to the requester.
     * msg: { type }
     */
    list(clientId) {
      registry.send(clientId, { type: 'terminal:list', terminals: terminalManager.list() });
    },
  };
}
