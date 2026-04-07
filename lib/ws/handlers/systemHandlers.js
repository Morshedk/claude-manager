/**
 * makeSystemHandlers — factory that binds SettingsStore and clientRegistry.
 * Returns a plain object compatible with MessageRouter's catch-all dispatch:
 *   systemHandlers.handle(clientId, msg, registry)
 *
 * @param {{ settingsStore: import('../../settings/SettingsStore.js').SettingsStore, registry: import('../clientRegistry.js').clientRegistry }} deps
 * @returns {object}
 */
export function makeSystemHandlers({ settingsStore, registry }) {
  return {
    /**
     * Dispatch any non-session, non-terminal message.
     */
    async handle(clientId, msg) {
      switch (msg.type) {
        case 'settings:get': {
          try {
            const settings = await settingsStore.getAll();
            registry.send(clientId, { type: 'settings:updated', settings });
          } catch (e) {
            console.error('[systemHandlers] settings:get error:', e.message);
          }
          break;
        }

        case 'settings:update':
        case 'settings:set': {
          try {
            const settings = await settingsStore.update(msg.settings || msg.payload || {});
            registry.broadcast({ type: 'settings:updated', settings });
          } catch (e) {
            console.error('[systemHandlers] settings:update error:', e.message);
            registry.send(clientId, { type: 'settings:error', error: e.message });
          }
          break;
        }

        default:
          console.warn(`[ws] Unknown message type: ${msg.type} from client: ${clientId}`);
      }
    },
  };
}
