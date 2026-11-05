/**
 * SillyTavern-ChromaticHub: Server Plugin Entry Lifecycle Tests (H01-B3-D2-D)
 *
 * Synthetic unit tests exercising:
 * - SillyTavern plugin info contract
 * - One-shot initialization and route registration
 * - Prevention of repeated or concurrent init (no rearming)
 * - Safe exit and permanent closure (no re-init after exit)
 * - Module isolation via cache-busting query strings
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import url from 'node:url';

function createMockRouter() {
  const routes = new Map();
  return {
    post(routePath, handler) {
      routes.set(routePath, handler);
    },
    has(routePath) {
      return routes.has(routePath);
    },
    get size() {
      return routes.size;
    },
    getRoutes() {
      return Array.from(routes.keys());
    },
  };
}

async function loadFreshPluginModule(testId) {
  const fileUrl = url.pathToFileURL('./index.mjs').href + `?test=${testId}_${Date.now()}_${Math.random()}`;
  return await import(fileUrl);
}

test('index.mjs - Plugin Info Contract', async () => {
  const plugin = await loadFreshPluginModule('info');
  assert.ok(plugin.info, 'Plugin info must exist');
  assert.strictEqual(plugin.info.id, 'chromatic-hub');
  assert.strictEqual(plugin.info.name, 'ChromaticHub');
  assert.strictEqual(typeof plugin.info.description, 'string');
  assert.ok(plugin.info.description.length > 0);
  assert.strictEqual(Object.isFrozen(plugin.info), true);
});

test('index.mjs - One-Shot init() and Route Registration', async () => {
  const plugin = await loadFreshPluginModule('init');
  const router = createMockRouter();

  await plugin.init(router);

  // Verifies all 6 routes registered
  assert.strictEqual(router.has('/v1/resolve'), true);
  assert.strictEqual(router.has('/v1/recovery-candidates'), true);
  assert.strictEqual(router.has('/v1/create'), true);
  assert.strictEqual(router.has('/v1/mutate'), true);
  assert.strictEqual(router.has('/v1/rebind'), true);
  assert.strictEqual(router.has('/v1/clone'), true);
  assert.strictEqual(router.size, 6);

  // Repeated init throws TypeError and preserves existing router
  await assert.rejects(
    async () => plugin.init(router),
    /Plugin already initialized or closed/
  );
});

test('index.mjs - Invalid Router Rejection', async () => {
  const plugin = await loadFreshPluginModule('invalid_router');
  await assert.rejects(async () => plugin.init(null), /A valid router with a post\(\) method must be supplied/);
  await assert.rejects(async () => plugin.init({}), /A valid router with a post\(\) method must be supplied/);
});

test('index.mjs - exit() Idempotency & Permanent Closure (No Re-init)', async () => {
  const plugin = await loadFreshPluginModule('exit');
  const router = createMockRouter();

  await plugin.init(router);

  // First exit shuts down cleanly
  await plugin.exit();

  // Subsequent exit calls are idempotent and do not throw
  await plugin.exit();
  await plugin.exit();

  // Attempt to re-initialize after exit MUST fail closed
  await assert.rejects(
    async () => plugin.init(router),
    /Plugin already initialized or closed/
  );
});

test('index.mjs - Concurrent init() Rejection', async () => {
  const plugin = await loadFreshPluginModule('concurrent');
  const router1 = createMockRouter();
  const router2 = createMockRouter();

  // Fire two init calls concurrently
  const p1 = plugin.init(router1);
  const p2 = plugin.init(router2);

  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.strictEqual(fulfilled.length, 1, 'Exactly one init should succeed');
  assert.strictEqual(rejected.length, 1, 'The concurrent init must reject');
  assert.ok(/Plugin already initialized or closed/.test(rejected[0].reason.message));
});
