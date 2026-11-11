// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. Every handler is registered
// before connect(). Read-only: no command handler, nothing is ever commanded.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the MaLos and Intelligent devices already read, never a request.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onDeviceDeleted((device) => app.onDeviceDeleted(device));

  // Delegated energy contracts: priced from what is held, never a request.
  gladys.onEnergyPrice((request) => app.energyPrice(request));
  gladys.onEnergyCurrent((request) => app.energyCurrent(request));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.start(config));

  // Every connection (the first one and each reconnection): the config is
  // read again (retried for ever), the status and Discovery sent again, the
  // reads when due (never sooner than their interval).
  gladys.on('connected', async () => {
    try {
      await app.connected();
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
}
