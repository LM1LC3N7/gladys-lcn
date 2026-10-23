// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: "Scan" scans the bus again (at most once a minute).
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceChanged(device));
  gladys.onDeviceUpdated((device) => app.deviceChanged(device));

  // Outputs and relays (lights, switches, "turn on" / "turn off" buttons).
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Scene action: activate an LCN scene (off by default).
  gladys.onSceneAction(SCENE_ACTIONS.ACTIVATE_SCENE, (fields) => app.sceneAction(fields));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle: the first connection starts, a reconnection resends.
  gladys.on('connected', async () => {
    try {
      await app.connected(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
