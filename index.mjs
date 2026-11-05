/**
 * SillyTavern-ChromaticHub: Server Plugin Entry Point (H01-B3-D2-D)
 *
 * SillyTavern standard directory plugin entry point.
 * Exposes plugin info, single-instance initialization (init), and graceful shutdown (exit).
 *
 * Invariants:
 * - Exactly one FileStore and one SidecarController singleton per process.
 * - HTTP API disabled by default (process.env.CHROMATIC_HUB_HTTP_ENABLED === '1').
 * - Native writes strictly hardcoded false (writeEnabled: false).
 * - One-shot lifecycle: cannot be re-initialized or re-armed.
 * - Dependency-free ES module; zero imports from SillyTavern internal modules.
 */

import { createFileStore } from './src/sidecar-file-store.mjs';
import { createSidecarController } from './src/sidecar-controller.mjs';
import { createSidecarHttpAdapter } from './src/sidecar-http-adapter.mjs';

export const info = Object.freeze({
  id: 'chromatic-hub',
  name: 'ChromaticHub',
  description: 'Sidecar character identity registry and minimal identity API',
});

let lifecycleState = 'UNINITIALIZED';
let activeAdapter = null;

export async function init(router) {
  if (lifecycleState !== 'UNINITIALIZED') {
    throw new TypeError(`Plugin already initialized or closed (state: ${lifecycleState})`);
  }

  if (!router || typeof router.post !== 'function') {
    throw new TypeError('A valid router with a post() method must be supplied to init()');
  }

  lifecycleState = 'INITIALIZING';

  try {
    const fileStore = createFileStore();
    const controller = createSidecarController({ fileStore });

    const httpEnabled = process.env.CHROMATIC_HUB_HTTP_ENABLED === '1';
    const writeEnabled = false; // Strictly locked false for native deployments

    activeAdapter = createSidecarHttpAdapter({
      controller,
      httpEnabled,
      writeEnabled,
    });

    activeAdapter.registerRoutes(router);
    lifecycleState = 'INITIALIZED';
  } catch (err) {
    lifecycleState = 'CLOSED';
    activeAdapter = null;
    throw err;
  }
}

export async function exit() {
  if (lifecycleState === 'CLOSED') {
    return;
  }

  lifecycleState = 'CLOSING';

  if (activeAdapter) {
    try {
      await activeAdapter.close();
    } finally {
      activeAdapter = null;
      lifecycleState = 'CLOSED';
    }
  } else {
    lifecycleState = 'CLOSED';
  }
}
