import { log } from '../../logger/Logger.js';

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
            log.error('api', 'settings:get error', { error: e.message });
          }
          break;
        }

        case 'settings:update':
        case 'settings:set': {
          try {
            const newSettings = msg.settings || msg.payload || {};
            const settings = await settingsStore.update(newSettings);
            registry.broadcast({ type: 'settings:updated', settings });
            // Broadcast log level changes to all clients
            if (newSettings?.logging?.levels) {
              registry.broadcast({ type: 'log:level:changed', levels: newSettings.logging.levels });
            }
          } catch (e) {
            log.error('api', 'settings:update error', { error: e.message });
            registry.send(clientId, { type: 'settings:error', error: e.message });
          }
          break;
        }

        default:
          log.warn('router', 'unknown message type', { type: msg.type, clientId });
      }
    },
  };
}
