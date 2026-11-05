/**
 * SillyTavern-ChromaticHub: Sidecar HTTP Adapter Unit & Security Tests (H01-B3-D2-D)
 *
 * Comprehensive synthetic unit tests exercising:
 * - Route registration and parameter validation
 * - Bounded request inspection (depth <= 32, node budget <= 2048, safe arrays, post-parse <= 384 KiB)
 * - Single-active mutator per userRoot and concurrency admission gates
 * - Exact C2 success envelope projection and locator revision transitions
 * - Monotonic mutator lockout on abnormal delegated throws or malformed results
 * - Pre-dispatch vs post-dispatch socket disconnects and cancellation
 * - Zero information leakage and strict static error specifications
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createSidecarHttpAdapter,
  inspectRequestStructure,
  validateAndProjectSuccess,
  classifyAndSanitizeC2Failure,
  extractTrustedContext,
  ConcurrencyAdmissionGate,
  MutatorLockoutGate,
  C2_ERROR_SPECIFICATIONS,
  ADAPTER_ERROR_SPECIFICATIONS,
  OUTWARD_DIAGNOSTIC_ALLOWLIST,
  isValidJsonContentType,
} from '../src/sidecar-http-adapter.mjs';

// --- Test Fixtures & Mock Helpers ---

const CANONICAL_REGISTRY = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  characters: [],
});

function createMockRouter() {
  const routes = new Map();
  return {
    post(routePath, handler) {
      routes.set(routePath, handler);
    },
    async dispatch(routePath, req, res) {
      const handler = routes.get(routePath);
      if (!handler) {
        res.statusCode = 404;
        res.end();
        return;
      }
      return await handler(req, res);
    },
    has(routePath) {
      return routes.has(routePath);
    },
  };
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = Object.create(null);
    this.writableEnded = false;
    this.destroyed = false;
    this._chunks = [];
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = String(value);
  }

  getHeader(name) {
    return this.headers[name.toLowerCase()];
  }

  end(chunk) {
    if (this.writableEnded) return;
    if (chunk !== undefined) {
      this._chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    }
    this.writableEnded = true;
    this.emit('finish');
  }

  get bodyText() {
    return this._chunks.join('');
  }

  get jsonBody() {
    const text = this.bodyText;
    if (!text) return null;
    return JSON.parse(text);
  }
}

function createMockReqRes({
  body = {},
  headers = { 'content-type': 'application/json' },
  user = {
    directories: {
      root: '/mock/user/data',
      characters: '/mock/user/data/characters',
    },
  },
} = {}) {
  const req = {
    headers: { ...headers },
    body,
    user,
  };
  const res = new MockResponse();
  return { req, res };
}

function createStubController(overrides = {}) {
  return {
    resolve: async () => ({
      ok: true,
      value: {
        status: 'BOUND',
        cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
        avatar: 'hero.png',
        storageRevision: 1,
        registry: CANONICAL_REGISTRY,
      },
    }),
    recoveryCandidates: async () => ({
      ok: true,
      value: {
        candidates: [{ avatar: 'orphan.png', cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d', storageRevision: 1 }],
      },
    }),
    create: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
        avatar: 'hero.png',
        storageRevision: 1,
        registry: CANONICAL_REGISTRY,
      },
    }),
    mutate: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
        avatar: 'hero.png',
        storageRevision: 2,
        registry: { schemaVersion: 1, revision: 1, characters: [] },
      },
    }),
    rebind: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
        avatar: 'new-hero.png',
        storageRevision: 2,
        registry: CANONICAL_REGISTRY,
      },
    }),
    clone: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e',
        avatar: 'clone.png',
        storageRevision: 1,
        registry: CANONICAL_REGISTRY,
      },
    }),
    ...overrides,
  };
}

// --- Test Suites ---

test('createSidecarHttpAdapter - Factory Option Validation', async () => {
  assert.throws(() => createSidecarHttpAdapter(null), /Options must be a plain object/);
  assert.throws(() => createSidecarHttpAdapter({}), /controller is required/);
  assert.throws(() => createSidecarHttpAdapter({ controller: {} }), /controller must implement resolve/);

  const stub = createStubController();
  const adapter = createSidecarHttpAdapter({ controller: stub });
  assert.strictEqual(adapter.isHttpEnabled(), false);
  assert.strictEqual(adapter.isWriteEnabled(), false);
  assert.strictEqual(adapter.isClosing(), false);
});

test('extractTrustedContext - Path & Directory Security', async () => {
  // Missing req.user
  const r1 = extractTrustedContext({});
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.status, 403);

  // Missing directories
  const r2 = extractTrustedContext({ user: {} });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.status, 503);

  // Traversal in root
  const r3 = extractTrustedContext({
    user: { directories: { root: '/var/../etc', characters: '/var/../etc/chars' } },
  });
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.status, 503);

  // Control character / NUL in root
  const r4 = extractTrustedContext({
    user: { directories: { root: '/var/user\0', characters: '/var/user\0/chars' } },
  });
  assert.strictEqual(r4.ok, false);
  assert.strictEqual(r4.status, 503);

  // Characters not nested under root
  const r5 = extractTrustedContext({
    user: { directories: { root: '/var/user1', characters: '/var/user2/characters' } },
  });
  assert.strictEqual(r5.ok, false);
  assert.strictEqual(r5.status, 503);

  // Valid nested directories
  const r6 = extractTrustedContext({
    user: { directories: { root: '/var/user1', characters: '/var/user1/characters' } },
  });
  assert.strictEqual(r6.ok, true);
  assert.strictEqual(r6.context.userRoot, '/var/user1');
  assert.strictEqual(r6.context.charactersRoot, '/var/user1/characters');
  assert.strictEqual(Object.isFrozen(r6.context), true);
});

test('inspectRequestStructure - Bounded Request Inspection & Arrays (R3-A, G2-A, G2-C)', async () => {
  // Valid plain object with dense nested arrays
  const validBody = {
    avatar: 'test.png',
    command: {
      type: 'add',
      character: {
        name: 'Hero',
        aliases: ['Champion', 'Warrior'],
      },
    },
  };
  const r1 = inspectRequestStructure(validBody);
  assert.strictEqual(r1.ok, true);

  // Empty array passes
  assert.strictEqual(inspectRequestStructure({ items: [] }).ok, true);

  // Sparse array fails
  const sparseArr = [1];
  sparseArr[3] = 4;
  assert.strictEqual(inspectRequestStructure({ arr: sparseArr }).ok, false);

  // Array with extra string property fails
  const extraPropArr = [1, 2];
  extraPropArr.custom = 'evil';
  assert.strictEqual(inspectRequestStructure({ arr: extraPropArr }).ok, false);

  // Object with accessor property fails
  const accessorObj = {};
  Object.defineProperty(accessorObj, 'evil', { get: () => 'malicious', enumerable: true });
  assert.strictEqual(inspectRequestStructure(accessorObj).ok, false);

  // Function property fails
  assert.strictEqual(inspectRequestStructure({ fn: () => {} }).ok, false);

  // Non-finite number fails
  assert.strictEqual(inspectRequestStructure({ num: NaN }).ok, false);
  assert.strictEqual(inspectRequestStructure({ num: Infinity }).ok, false);

  // Circular reference fails
  const circ = {};
  circ.self = circ;
  assert.strictEqual(inspectRequestStructure(circ).ok, false);

  // Nesting depth > 32 fails
  let deepObj = { val: 1 };
  for (let i = 0; i < 35; i++) {
    deepObj = { nested: deepObj };
  }
  const rDeep = inspectRequestStructure(deepObj);
  assert.strictEqual(rDeep.ok, false);
  assert.strictEqual(rDeep.status, 400);

  // Total nodes > 2048 fails
  const wideArr = new Array(2100).fill(1);
  const rWide = inspectRequestStructure({ arr: wideArr });
  assert.strictEqual(rWide.ok, false);
  assert.strictEqual(rWide.status, 400);

  // Single oversized string (> 384 KiB) fails with 413 BEFORE JSON.stringify (G2-A)
  const hugeString = 'A'.repeat(400 * 1024);
  const rHuge = inspectRequestStructure({ big: hugeString });
  assert.strictEqual(rHuge.ok, false);
  assert.strictEqual(rHuge.status, 413);
  assert.strictEqual(rHuge.code, 'BYTE_LIMIT_EXCEEDED');

  // Throwing proxy fails closed with 400 without crashing (G2-C)
  const throwingProxy = new Proxy({}, {
    get() { throw new Error('Proxy trap bomb'); },
    getPrototypeOf() { throw new Error('Proto trap bomb'); },
    getOwnPropertyDescriptor() { throw new Error('Descriptor bomb'); },
  });
  const rProxy = inspectRequestStructure(throwingProxy);
  assert.strictEqual(rProxy.ok, false);
  assert.strictEqual(rProxy.status, 400);
});

test('Admission Gates - Disabled HTTP & Disabled Writes', async () => {
  const router = createMockRouter();
  const controller = createStubController();
  const adapter = createSidecarHttpAdapter({
    controller,
    httpEnabled: false,
    writeEnabled: false,
  });
  adapter.registerRoutes(router);

  // HTTP disabled returns 503
  const { req, res } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/resolve', req, res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.jsonBody.code, 'HTTP_DISABLED');

  // Enable HTTP, test write gate
  const router2 = createMockRouter();
  let mutateCalled = false;
  const writeSpyController = createStubController({
    mutate: async () => {
      mutateCalled = true;
      return { ok: true, changed: true, value: {} };
    },
  });
  const adapter2 = createSidecarHttpAdapter({
    controller: writeSpyController,
    httpEnabled: true,
    writeEnabled: false,
  });
  adapter2.registerRoutes(router2);

  // Mutate with writeEnabled: false returns 403 WRITES_DISABLED without calling controller
  const { req: mReq, res: mRes } = createMockReqRes({
    body: {
      cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'noop' },
    },
  });
  await router2.dispatch('/v1/mutate', mReq, mRes);
  assert.strictEqual(mRes.statusCode, 403);
  assert.strictEqual(mRes.jsonBody.code, 'WRITES_DISABLED');
  assert.strictEqual(mutateCalled, false);

  // Read endpoint works when HTTP is enabled
  const { req: rReq, res: rRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router2.dispatch('/v1/resolve', rReq, rRes);
  assert.strictEqual(rRes.statusCode, 200);
  assert.strictEqual(rRes.jsonBody.ok, true);
  assert.strictEqual(rRes.jsonBody.value.status, 'BOUND');
});

test('ConcurrencyAdmissionGate - Global & Per-User Bounds (R1-B)', () => {
  const gate = new ConcurrencyAdmissionGate({ maxGlobal: 3, maxPerUser: 2 });
  const rootA = '/data/userA';
  const rootB = '/data/userB';

  // Acquire user A
  assert.strictEqual(gate.tryAcquire(rootA, false).allowed, true);
  assert.strictEqual(gate.tryAcquire(rootA, false).allowed, true);
  // User A hit per-user cap of 2
  const rUserSat = gate.tryAcquire(rootA, false);
  assert.strictEqual(rUserSat.allowed, false);
  assert.strictEqual(rUserSat.reason, 'USER_SATURATED');

  // User B can still acquire up to global cap
  assert.strictEqual(gate.tryAcquire(rootB, false).allowed, true);
  // Global cap of 3 reached
  const rGlobSat = gate.tryAcquire(rootB, false);
  assert.strictEqual(rGlobSat.allowed, false);
  assert.strictEqual(rGlobSat.reason, 'GLOBAL_SATURATED');

  // Release user A slot
  gate.release(rootA, false);
  assert.strictEqual(gate.tryAcquire(rootB, false).allowed, true);
});

test('Single-Active-Mutator Race & Lockout Gate (R3-B, R2-C)', async () => {
  const gate = new ConcurrencyAdmissionGate({ maxGlobal: 32, maxPerUser: 4 });
  const root = '/data/user1';

  // First mutator acquires
  assert.strictEqual(gate.tryAcquire(root, true).allowed, true);

  // Second mutator for same root rejected immediately with USER_MUTATOR_ACTIVE
  const rMut2 = gate.tryAcquire(root, true);
  assert.strictEqual(rMut2.allowed, false);
  assert.strictEqual(rMut2.reason, 'USER_MUTATOR_ACTIVE');
  assert.strictEqual(rMut2.code, 'SERVICE_BUSY');

  // Concurrent read for same root still allowed up to per-user quota
  assert.strictEqual(gate.tryAcquire(root, false).allowed, true);

  // Concurrent mutator for DIFFERENT user allowed
  assert.strictEqual(gate.tryAcquire('/data/user2', true).allowed, true);

  // Release mutator
  gate.release(root, true);

  // Lockout gate test
  const lockout = new MutatorLockoutGate();
  assert.strictEqual(lockout.isLocked(root), false);
  lockout.lock(root);
  assert.strictEqual(lockout.isLocked(root), true);
  assert.strictEqual(lockout.isLocked('/data/user2'), false);
});

test('Exact C2 Success Envelope Projections & Revisions (G2-B, R3-D, R3-E)', async () => {
  const router = createMockRouter();
  const cardId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

  // 1. Resolve: BOUND has no 'changed' property; UNBOUND has recoveryAvailable
  const controller = createStubController({
    resolve: async () => ({
      ok: true,
      value: {
        status: 'BOUND',
        cardId,
        avatar: 'hero.png',
        storageRevision: 1,
        registry: CANONICAL_REGISTRY,
      },
    }),
  });
  const adapter = createSidecarHttpAdapter({ controller, httpEnabled: true, writeEnabled: true });
  adapter.registerRoutes(router);

  const { req: resReq, res: resRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/resolve', resReq, resRes);
  assert.strictEqual(resRes.statusCode, 200);
  assert.strictEqual(resRes.jsonBody.ok, true);
  assert.strictEqual(Object.hasOwn(resRes.jsonBody, 'changed'), false);
  assert.strictEqual(resRes.jsonBody.value.avatar, 'hero.png');

  // 2. Mutate with changed: false (exact CAS no-op preservation)
  const noopController = createStubController({
    mutate: async () => ({
      ok: true,
      changed: false,
      value: {
        status: 'BOUND',
        cardId,
        avatar: 'hero.png',
        storageRevision: 5,
        registry: { schemaVersion: 1, revision: 3, characters: [] },
      },
    }),
  });
  const noopAdapter = createSidecarHttpAdapter({ controller: noopController, httpEnabled: true, writeEnabled: true });
  const noopRouter = createMockRouter();
  noopAdapter.registerRoutes(noopRouter);

  const { req: noopReq, res: noopRes } = createMockReqRes({
    body: {
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 5,
      expectedRegistryRevision: 3,
      command: { type: 'noop' },
    },
  });
  await noopRouter.dispatch('/v1/mutate', noopReq, noopRes);
  assert.strictEqual(noopRes.statusCode, 200);
  assert.strictEqual(noopRes.jsonBody.changed, false);
  assert.strictEqual(noopRes.jsonBody.value.storageRevision, 5);

  // 3. Mutate with changed: true (increments expected revisions by exactly +1)
  const mutateIncController = createStubController({
    mutate: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId,
        avatar: 'hero.png',
        storageRevision: 6,
        registry: { schemaVersion: 1, revision: 4, characters: [] },
      },
    }),
  });
  const incAdapter = createSidecarHttpAdapter({ controller: mutateIncController, httpEnabled: true, writeEnabled: true });
  const incRouter = createMockRouter();
  incAdapter.registerRoutes(incRouter);

  const { req: incReq, res: incRes } = createMockReqRes({
    body: {
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 5,
      expectedRegistryRevision: 3,
      command: { type: 'add' },
    },
  });
  await incRouter.dispatch('/v1/mutate', incReq, incRes);
  assert.strictEqual(incRes.statusCode, 200);
  assert.strictEqual(incRes.jsonBody.changed, true);
  assert.strictEqual(incRes.jsonBody.value.storageRevision, 6);

  // 4. Mutate with forged / mismatched revision increment triggers 500 & mutator lockout (G2-B, R2-C)
  const forgedController = createStubController({
    mutate: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId,
        avatar: 'hero.png',
        storageRevision: 999, // Mismatched! Expected 5 + 1 = 6
        registry: { schemaVersion: 1, revision: 4, characters: [] },
      },
    }),
  });
  const forgedAdapter = createSidecarHttpAdapter({ controller: forgedController, httpEnabled: true, writeEnabled: true });
  const forgedRouter = createMockRouter();
  forgedAdapter.registerRoutes(forgedRouter);

  const { req: fReq, res: fRes } = createMockReqRes({
    body: {
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 5,
      expectedRegistryRevision: 3,
      command: { type: 'add' },
    },
  });
  await forgedRouter.dispatch('/v1/mutate', fReq, fRes);
  assert.strictEqual(fRes.statusCode, 500);
  assert.strictEqual(fRes.jsonBody.code, 'INTERNAL_ERROR');

  // Verify mutator lockout is now active for this user
  const { req: lockedReq, res: lockedRes } = createMockReqRes({
    body: {
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 5,
      expectedRegistryRevision: 3,
      command: { type: 'add' },
    },
  });
  await forgedRouter.dispatch('/v1/mutate', lockedReq, lockedRes);
  assert.strictEqual(lockedRes.statusCode, 503);
  assert.strictEqual(lockedRes.jsonBody.code, 'MUTATIONS_LOCKED');

  // Verify reads for that user still work
  const { req: readReq, res: readRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await forgedRouter.dispatch('/v1/resolve', readReq, readRes);
  assert.strictEqual(readRes.statusCode, 200);
});

test('Rebind Revision Invariants - Same-Avatar No-Op vs True Rename (G2-B, R3-D)', async () => {
  const cardId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

  // Same-avatar no-op: requires changed === false and storageRevision preserved
  const noopRebind = validateAndProjectSuccess('rebind', {
    cardId,
    fromAvatar: 'hero.png',
    toAvatar: 'hero.png',
    expectedStorageRevision: 4,
  }, {
    ok: true,
    changed: false,
    value: {
      status: 'BOUND',
      cardId,
      avatar: 'hero.png',
      storageRevision: 4,
      registry: CANONICAL_REGISTRY,
    },
  });
  assert.strictEqual(noopRebind.classified, true);
  assert.strictEqual(noopRebind.envelope.changed, false);
  assert.strictEqual(noopRebind.envelope.value.storageRevision, 4);

  // Same-avatar returning changed: true fails validation
  const invalidNoop = validateAndProjectSuccess('rebind', {
    cardId,
    fromAvatar: 'hero.png',
    toAvatar: 'hero.png',
    expectedStorageRevision: 4,
  }, {
    ok: true,
    changed: true,
    value: {
      status: 'BOUND',
      cardId,
      avatar: 'hero.png',
      storageRevision: 5,
      registry: CANONICAL_REGISTRY,
    },
  });
  assert.strictEqual(invalidNoop.classified, false);

  // Rename: requires changed === true and storageRevision === expected + 1
  const renameRebind = validateAndProjectSuccess('rebind', {
    cardId,
    fromAvatar: 'hero.png',
    toAvatar: 'new-hero.png',
    expectedStorageRevision: 4,
  }, {
    ok: true,
    changed: true,
    value: {
      status: 'BOUND',
      cardId,
      avatar: 'new-hero.png',
      storageRevision: 5,
      registry: CANONICAL_REGISTRY,
    },
  });
  assert.strictEqual(renameRebind.classified, true);
  assert.strictEqual(renameRebind.envelope.changed, true);
  assert.strictEqual(renameRebind.envelope.value.storageRevision, 5);
});

test('Error Mapping & Zero Information Leakage (R2-A, R3-C)', async () => {
  // Test all 18 C2 codes
  for (const [code, spec] of Object.entries(C2_ERROR_SPECIFICATIONS)) {
    const raw = {
      ok: false,
      code,
      message: 'Sensitive internal message /home/user/secret.png',
      recoverable: spec.recoverable,
    };
    const res = classifyAndSanitizeC2Failure(raw);
    assert.strictEqual(res.classified, true, `Code ${code} must classify`);
    assert.strictEqual(res.status, spec.status);
    assert.strictEqual(res.envelope.code, code);
    assert.strictEqual(res.envelope.message, spec.message, 'Message must be static from spec');
    assert.strictEqual(res.envelope.message.includes('secret.png'), false);
    assert.strictEqual(res.envelope.recoverable, spec.recoverable);
  }

  // Inherited prototype properties (constructor, toString, __proto__) fail closed to 500
  for (const hostileKey of ['constructor', 'toString', '__proto__']) {
    const r = classifyAndSanitizeC2Failure({ ok: false, code: hostileKey, recoverable: false });
    assert.strictEqual(r.classified, false);
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.envelope.code, 'INTERNAL_ERROR');
  }

  // Unknown error code fails closed to 500
  const rUnknown = classifyAndSanitizeC2Failure({ ok: false, code: 'UNKNOWN_CODE', recoverable: false });
  assert.strictEqual(rUnknown.classified, false);
  assert.strictEqual(rUnknown.status, 500);

  // Mismatched recoverable fails closed to 500
  const rMismatch = classifyAndSanitizeC2Failure({ ok: false, code: 'REVISION_CONFLICT', recoverable: false });
  assert.strictEqual(rMismatch.classified, false);
  assert.strictEqual(rMismatch.status, 500);

  // C1 diagnostic reason TEMP_OPEN_FAILED on WRITE_FAILED: classified: true, omitted from response
  const rTempOpen = classifyAndSanitizeC2Failure({
    ok: false,
    code: 'WRITE_FAILED',
    recoverable: false,
    details: { reason: 'TEMP_OPEN_FAILED' },
  });
  assert.strictEqual(rTempOpen.classified, true);
  assert.strictEqual(rTempOpen.status, 500);
  assert.strictEqual(Object.hasOwn(rTempOpen.envelope, 'details'), false);

  // Allowlisted reason READBACK_MISMATCH on WRITE_UNCERTAIN: exposed in details
  const rUncertain = classifyAndSanitizeC2Failure({
    ok: false,
    code: 'WRITE_UNCERTAIN',
    recoverable: false,
    details: { reason: 'READBACK_MISMATCH' },
  });
  assert.strictEqual(rUncertain.classified, true);
  assert.strictEqual(rUncertain.status, 503);
  assert.strictEqual(rUncertain.envelope.details?.reason, 'READBACK_MISMATCH');
});

test('Cancellation & Disconnect Semantics (R1-D, R3-F, G2-D)', async () => {
  const router = createMockRouter();
  let receivedSignal = null;
  let settleResolve;
  const settlePromise = new Promise((resolve) => {
    settleResolve = resolve;
  });

  const slowController = createStubController({
    resolve: async ({ signal }) => {
      receivedSignal = signal;
      await settlePromise;
      return {
        ok: true,
        value: {
          status: 'BOUND',
          cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
          avatar: 'hero.png',
          storageRevision: 1,
          registry: CANONICAL_REGISTRY,
        },
      };
    },
  });

  const adapter = createSidecarHttpAdapter({ controller: slowController, httpEnabled: true, writeEnabled: true });
  adapter.registerRoutes(router);

  const { req, res } = createMockReqRes({ body: { avatar: 'hero.png' } });
  const dispatchPromise = router.dispatch('/v1/resolve', req, res);

  // Yield to allow dispatch into handler
  await new Promise((r) => setTimeout(r, 10));

  // Verify in-flight count incremented
  assert.strictEqual(adapter.getMetrics().globalInFlight, 1);

  // Client disconnects before controller settles
  res.emit('close');
  assert.strictEqual(receivedSignal.aborted, true);

  // Settle controller
  settleResolve();
  await dispatchPromise;

  // After settlement: in-flight count decremented, response write suppressed
  assert.strictEqual(adapter.getMetrics().globalInFlight, 0);
  assert.strictEqual(res.bodyText, '');
});

test('Adapter Shutdown Drain & Early Settlement (G2-D, R1-G)', async () => {
  const controller = createStubController();
  const adapter = createSidecarHttpAdapter({
    controller,
    httpEnabled: true,
    writeEnabled: true,
    drainTimeoutMs: 500,
  });

  // Close with zero in-flight promises settles immediately
  const t0 = Date.now();
  await adapter.close();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, 'Empty drain must resolve immediately');
  assert.strictEqual(adapter.isClosing(), true);
});

test('G2-A - Bounded Request Inspection with Escaped Characters', () => {
  // Object with many escaped characters exceeding 384 KiB fails with 413
  const escapedChunk = '\\"\\n\\r\\t'.repeat(50);
  const manyKeysObj = {};
  for (let i = 0; i < 1500; i++) {
    manyKeysObj[`key_${i}`] = escapedChunk;
  }
  const rEscaped = inspectRequestStructure(manyKeysObj);
  assert.strictEqual(rEscaped.ok, false);
  assert.strictEqual(rEscaped.status, 413);
  assert.strictEqual(rEscaped.code, 'BYTE_LIMIT_EXCEEDED');
});

test('G2-B - Mutator Success Invariants & Revision Forgery Lockouts', async () => {
  const router = createMockRouter();
  const sourceCardId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

  // 1. Clone returns same cardId as source -> fails validation & locks mutators
  const sameCardCloneController = createStubController({
    clone: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: sourceCardId, // Forged! Must be a new cardId
        avatar: 'target.png',
        storageRevision: 1,
        registry: CANONICAL_REGISTRY,
      },
    }),
  });
  const cloneAdapter = createSidecarHttpAdapter({ controller: sameCardCloneController, httpEnabled: true, writeEnabled: true });
  cloneAdapter.registerRoutes(router);

  const { req: cReq, res: cRes } = createMockReqRes({
    body: {
      sourceCardId,
      sourceAvatar: 'source.png',
      targetAvatar: 'target.png',
      expectedSourceStorageRevision: 1,
    },
  });
  await router.dispatch('/v1/clone', cReq, cRes);
  assert.strictEqual(cRes.statusCode, 500);
  assert.strictEqual(cRes.jsonBody.code, 'INTERNAL_ERROR');

  // Verify mutator is locked for this user
  const { req: cReq2, res: cRes2 } = createMockReqRes({
    body: {
      sourceCardId,
      sourceAvatar: 'source.png',
      targetAvatar: 'target.png',
      expectedSourceStorageRevision: 1,
    },
  });
  await router.dispatch('/v1/clone', cReq2, cRes2);
  assert.strictEqual(cRes2.statusCode, 503);
  assert.strictEqual(cRes2.jsonBody.code, 'MUTATIONS_LOCKED');
});

test('G2-C - Malicious C2 Result Traps & Fail-Closed Handling', async () => {
  // C2 result with throwing getter property
  const hostileC2Result = {
    ok: false,
    recoverable: false,
  };
  Object.defineProperty(hostileC2Result, 'code', {
    get() {
      throw new Error('Hostile getter detonation');
    },
  });

  const res = classifyAndSanitizeC2Failure(hostileC2Result);
  assert.strictEqual(res.classified, false);
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.envelope.code, 'INTERNAL_ERROR');

  // C2 result with non-boolean ok
  const nonBoolOk = {
    ok: 'false',
    code: 'CARD_NOT_FOUND',
    recoverable: false,
  };
  const resNonBool = classifyAndSanitizeC2Failure(nonBoolOk);
  assert.strictEqual(resNonBool.classified, false);
  assert.strictEqual(resNonBool.status, 500);
});

test('G2-D - Timed Drain with Saturated Operation Timeout', async () => {
  let finishSettle;
  const longRunningPromise = new Promise((resolve) => {
    finishSettle = resolve;
  });

  const slowController = createStubController({
    resolve: async () => {
      await longRunningPromise;
      return { ok: true, value: { status: 'BOUND', cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d', avatar: 'hero.png', storageRevision: 1, registry: CANONICAL_REGISTRY } };
    },
  });

  const adapter = createSidecarHttpAdapter({
    controller: slowController,
    httpEnabled: true,
    writeEnabled: true,
    drainTimeoutMs: 50, // Short drain timeout
  });
  const router = createMockRouter();
  adapter.registerRoutes(router);

  const { req, res } = createMockReqRes({ body: { avatar: 'hero.png' } });
  const dispatchPromise = router.dispatch('/v1/resolve', req, res);

  // Yield to enter dispatch
  await new Promise((r) => setTimeout(r, 10));

  // Trigger close while operation is still in flight: must wait up to timeout and not crash
  const t0 = Date.now();
  await adapter.close(50);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 40, 'Must wait approximately drainTimeoutMs');
  assert.strictEqual(adapter.isClosing(), true);

  // Subsequent requests are rejected with 503 SERVICE_CLOSING
  const { req: closeReq, res: closeRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/resolve', closeReq, closeRes);
  assert.strictEqual(closeRes.statusCode, 503);
  assert.strictEqual(closeRes.jsonBody.code, 'SERVICE_CLOSING');

  // Finish controller to cleanly exit
  finishSettle();
  await dispatchPromise;
});

test('G2-E - Content-Type & Route Safety Enforcement', async () => {
  const router = createMockRouter();
  const controller = createStubController();
  const adapter = createSidecarHttpAdapter({ controller, httpEnabled: true, writeEnabled: true });
  adapter.registerRoutes(router);

  // 1. Missing Content-Type returns 415
  const { req: noCtReq, res: noCtRes } = createMockReqRes({
    headers: {},
    body: { avatar: 'hero.png' },
  });
  await router.dispatch('/v1/resolve', noCtReq, noCtRes);
  assert.strictEqual(noCtRes.statusCode, 415);
  assert.strictEqual(noCtRes.jsonBody.code, 'UNSUPPORTED_MEDIA_TYPE');

  // 2. Non-JSON Content-Type returns 415
  const { req: textCtReq, res: textCtRes } = createMockReqRes({
    headers: { 'content-type': 'text/plain' },
    body: { avatar: 'hero.png' },
  });
  await router.dispatch('/v1/resolve', textCtReq, textCtRes);
  assert.strictEqual(textCtRes.statusCode, 415);

  // 3. application/json; charset=utf-8 succeeds
  const { req: charsetReq, res: charsetRes } = createMockReqRes({
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: { avatar: 'hero.png' },
  });
  await router.dispatch('/v1/resolve', charsetReq, charsetRes);
  assert.strictEqual(charsetRes.statusCode, 200);

  // 4. Non-existent metrics or admin endpoints are NOT exposed
  assert.strictEqual(router.has('/v1/metrics'), false);
  assert.strictEqual(router.has('/metrics'), false);
  assert.strictEqual(router.has('/v1/reset'), false);
  assert.strictEqual(router.has('/v1/clear-quarantine'), false);
});

test('G4-R1-A - Abnormal Post-Delegation Classification Mutator Lockout', async () => {
  // 1. Throwing own ok getter on C2 result during mutate
  const throwingOkController = createStubController({
    mutate: async () => {
      const hostile = {};
      Object.defineProperty(hostile, 'ok', {
        get() {
          throw new Error('Hostile ok getter detonation');
        },
      });
      return hostile;
    },
  });

  const adapter = createSidecarHttpAdapter({
    controller: throwingOkController,
    httpEnabled: true,
    writeEnabled: true,
  });
  const router = createMockRouter();
  adapter.registerRoutes(router);

  const cardId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
  const { req, res } = createMockReqRes({
    body: {
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'set', key: 'test', value: 123 },
    },
  });

  await router.dispatch('/v1/mutate', req, res);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.jsonBody.code, 'INTERNAL_ERROR');

  // Assert user root is monotonically locked
  const metrics = adapter.getMetrics();
  assert.strictEqual(metrics.lockedUsers.has('/mock/user/data'), true);
  assert.strictEqual(metrics.activeMutatorUsers.size, 0);
  assert.strictEqual(metrics.globalInFlight, 0);

  // Subsequent mutation is refused with 503 MUTATIONS_LOCKED
  const { req: req2, res: res2 } = createMockReqRes({
    body: {
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'set', key: 'test', value: 123 },
    },
  });
  await router.dispatch('/v1/mutate', req2, res2);
  assert.strictEqual(res2.statusCode, 503);
  assert.strictEqual(res2.jsonBody.code, 'MUTATIONS_LOCKED');

  // Read operations (resolve) still function safely and independently
  const { req: readReq, res: readRes } = createMockReqRes({
    body: { avatar: 'hero.png' },
  });
  await router.dispatch('/v1/resolve', readReq, readRes);
  assert.strictEqual(readRes.statusCode, 200);

  // 2. Throwing getter on value during create
  const throwingValueController = createStubController({
    create: async () => {
      const hostile = { ok: true, changed: true };
      Object.defineProperty(hostile, 'value', {
        get() {
          throw new Error('Hostile value getter detonation');
        },
      });
      return hostile;
    },
  });
  const adapter2 = createSidecarHttpAdapter({
    controller: throwingValueController,
    httpEnabled: true,
    writeEnabled: true,
  });
  const router2 = createMockRouter();
  adapter2.registerRoutes(router2);

  const { req: cReq, res: cRes } = createMockReqRes({
    body: { avatar: 'hero.png' },
  });
  await router2.dispatch('/v1/create', cReq, cRes);
  assert.strictEqual(cRes.statusCode, 500);
  assert.strictEqual(adapter2.getMetrics().lockedUsers.has('/mock/user/data'), true);

  // 3. Socket write error during response delivery after valid classification does NOT trigger lockout
  const adapter3 = createSidecarHttpAdapter({
    controller: createStubController(),
    httpEnabled: true,
    writeEnabled: true,
  });
  const router3 = createMockRouter();
  adapter3.registerRoutes(router3);

  const { req: okReq, res: okRes } = createMockReqRes({
    body: { avatar: 'hero.png' },
  });
  okRes.end = () => {
    throw new Error('EPIPE socket write error');
  };
  await router3.dispatch('/v1/create', okReq, okRes);
  assert.strictEqual(adapter3.getMetrics().lockedUsers.has('/mock/user/data'), false);
});

test('G4-R1-B - Stateful Throwing Proxy Requests & Zero Reservation Leakage', async () => {
  const router = createMockRouter();
  const controller = createStubController();
  const adapter = createSidecarHttpAdapter({
    controller,
    httpEnabled: true,
    writeEnabled: true,
    maxGlobalInFlight: 1, // Cap at 1 to immediately detect leaks
  });
  adapter.registerRoutes(router);

  // 1. Stateful Proxy throwing on property access (read route)
  const throwingAvatarBody = new Proxy({ avatar: 'hero.png' }, {
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'avatar') {
        throw new Error('Proxy descriptor detonation on access');
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

  const { req: readReq, res: readRes } = createMockReqRes({ body: throwingAvatarBody });
  await router.dispatch('/v1/resolve', readReq, readRes);
  assert.strictEqual(readRes.statusCode, 400);
  assert.strictEqual(readRes.jsonBody.code, 'INVALID_REQUEST');

  // Verify ZERO leaked counters
  let metrics = adapter.getMetrics();
  assert.strictEqual(metrics.globalInFlight, 0);
  assert.strictEqual(metrics.activePromisesCount, 0);
  assert.strictEqual(metrics.lockedUsers.size, 0);

  // Subsequent legitimate read succeeds
  const { req: goodReadReq, res: goodReadRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/resolve', goodReadReq, goodReadRes);
  assert.strictEqual(goodReadRes.statusCode, 200);

  // 2. Stateful Proxy throwing on mutator route
  const throwingMutBody = new Proxy({ avatar: 'hero.png' }, {
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'avatar') {
        throw new Error('Proxy descriptor detonation in mutator');
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

  const { req: mutReq, res: mutRes } = createMockReqRes({ body: throwingMutBody });
  await router.dispatch('/v1/create', mutReq, mutRes);
  assert.strictEqual(mutRes.statusCode, 400);

  metrics = adapter.getMetrics();
  assert.strictEqual(metrics.globalInFlight, 0);
  assert.strictEqual(metrics.activeMutatorUsers.size, 0);
  assert.strictEqual(metrics.lockedUsers.size, 0);

  // 3. Stateful Proxy throwing on ownKeys trap
  const throwingKeysBody = new Proxy({ avatar: 'hero.png' }, {
    ownKeys() {
      throw new Error('Proxy ownKeys trap detonation');
    },
  });
  const { req: keysReq, res: keysRes } = createMockReqRes({ body: throwingKeysBody });
  await router.dispatch('/v1/resolve', keysReq, keysRes);
  assert.strictEqual(keysRes.statusCode, 400);

  metrics = adapter.getMetrics();
  assert.strictEqual(metrics.globalInFlight, 0);
  assert.strictEqual(metrics.activeMutatorUsers.size, 0);

  // Subsequent legitimate mutator request succeeds (not blocked by leaked activeMutator or locked status)
  const { req: goodMutReq, res: goodMutRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/create', goodMutReq, goodMutRes);
  assert.strictEqual(goodMutRes.statusCode, 200);
});

test('G4-R1-C - Inherited Properties & Accessors Rejection on Success Envelopes', async () => {
  // 1. validateAndProjectSuccess rejects prototype-inherited ok, changed, and value
  const validBoundValue = {
    status: 'BOUND',
    cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    avatar: 'hero.png',
    storageRevision: 1,
    registry: CANONICAL_REGISTRY,
  };

  const inheritedResult = Object.create({
    ok: true,
    changed: true,
    value: validBoundValue,
  });

  const resInherited = validateAndProjectSuccess('create', { avatar: 'hero.png' }, inheritedResult);
  assert.strictEqual(resInherited.classified, false);

  // 2. Reject inherited value properties
  const inheritedValueResult = {
    ok: true,
    changed: true,
    value: Object.create(validBoundValue),
  };
  const resInheritedValue = validateAndProjectSuccess('create', { avatar: 'hero.png' }, inheritedValueResult);
  assert.strictEqual(resInheritedValue.classified, false);

  // 3. Route dispatch with inherited result locks the mutator root
  const controller = createStubController({
    create: async () => inheritedResult,
  });
  const adapter = createSidecarHttpAdapter({
    controller,
    httpEnabled: true,
    writeEnabled: true,
  });
  const router = createMockRouter();
  adapter.registerRoutes(router);

  const { req, res } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/create', req, res);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.jsonBody.code, 'INTERNAL_ERROR');
  assert.strictEqual(adapter.getMetrics().lockedUsers.has('/mock/user/data'), true);
});

test('G4-R1-D - Strict Options Validation & Bounded Configuration', () => {
  const controller = createStubController();

  // Boolean string coercion rejected
  assert.throws(() => createSidecarHttpAdapter({ controller, httpEnabled: 'false' }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, writeEnabled: 'true' }), TypeError);

  // Non-safe or out of bound integers rejected
  assert.throws(() => createSidecarHttpAdapter({ controller, maxGlobalInFlight: Infinity }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxGlobalInFlight: NaN }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxGlobalInFlight: 0 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxGlobalInFlight: -1 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxGlobalInFlight: 33 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxPerUserInFlight: Infinity }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxPerUserInFlight: 5 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxPerUserInFlight: 50, maxGlobalInFlight: 32 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxBodyBytes: 393217 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxDepth: 33 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, maxNodeBudget: 2049 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, drainTimeoutMs: -1 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, drainTimeoutMs: Infinity }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, drainTimeoutMs: 30001 }), TypeError);
  assert.throws(() => createSidecarHttpAdapter({ controller, onWarning: 'not-a-func' }), TypeError);

  // Accessors or symbol properties on options rejected
  const accessorOptions = { controller };
  Object.defineProperty(accessorOptions, 'httpEnabled', {
    get() { return true; },
  });
  assert.throws(() => createSidecarHttpAdapter(accessorOptions), TypeError);

  const symOptions = { controller, [Symbol('evil')]: true };
  assert.throws(() => createSidecarHttpAdapter(symOptions), TypeError);

  // ConcurrencyAdmissionGate constructor limits
  assert.throws(() => new ConcurrencyAdmissionGate({ maxGlobal: Infinity }), TypeError);
  assert.throws(() => new ConcurrencyAdmissionGate({ maxGlobal: 33 }), TypeError);
  assert.throws(() => new ConcurrencyAdmissionGate({ maxPerUser: 0 }), TypeError);
  assert.throws(() => new ConcurrencyAdmissionGate({ maxGlobal: 32, maxPerUser: 5 }), TypeError);
  assert.throws(() => new ConcurrencyAdmissionGate({ maxGlobal: 10, maxPerUser: 20 }), TypeError);
});

test('G4-R1-E - Diagnostic Allowlist True Immutability', () => {
  // Exported allowlist is a frozen array
  assert.strictEqual(Array.isArray(OUTWARD_DIAGNOSTIC_ALLOWLIST), true);
  assert.strictEqual(Object.isFrozen(OUTWARD_DIAGNOSTIC_ALLOWLIST), true);

  // Calling Set.prototype.add or mutating methods throws
  assert.throws(() => Set.prototype.add.call(OUTWARD_DIAGNOSTIC_ALLOWLIST, 'FORGED_REASON'), TypeError);
  assert.throws(() => OUTWARD_DIAGNOSTIC_ALLOWLIST.push('FORGED_REASON'), TypeError);

  // C2 failure with unallowlisted reason is never reflected
  const forgedResult = {
    ok: false,
    code: 'WRITE_UNCERTAIN',
    recoverable: false,
    details: { reason: 'FORGED_REASON' },
  };
  const res = classifyAndSanitizeC2Failure(forgedResult);
  assert.strictEqual(res.classified, true);
  assert.strictEqual(res.envelope.details, undefined);
});

test('G4-R1-F - Lookalike Media Types Rejection', async () => {
  const router = createMockRouter();
  const controller = createStubController();
  const adapter = createSidecarHttpAdapter({ controller, httpEnabled: true, writeEnabled: true });
  adapter.registerRoutes(router);

  // isValidJsonContentType helper unit checks
  assert.strictEqual(isValidJsonContentType('application/json'), true);
  assert.strictEqual(isValidJsonContentType('application/json; charset=utf-8'), true);
  assert.strictEqual(isValidJsonContentType('application/json; charset="utf-8"'), true);
  assert.strictEqual(isValidJsonContentType('Application/JSON; CHARSET=UTF-8'), true);
  assert.strictEqual(isValidJsonContentType('application/jsonp'), false);
  assert.strictEqual(isValidJsonContentType('application/json-wrong'), false);
  assert.strictEqual(isValidJsonContentType('application/json; charset=iso-8859-1'), false);
  assert.strictEqual(isValidJsonContentType('application/json; foo=bar'), false);
  assert.strictEqual(isValidJsonContentType('text/html'), false);

  // Route rejection of lookalike Content-Type with 415
  for (const badCt of ['application/jsonp', 'application/json-wrong', 'application/json; charset=iso-8859-1']) {
    const { req, res } = createMockReqRes({
      headers: { 'content-type': badCt },
      body: { avatar: 'hero.png' },
    });
    await router.dispatch('/v1/resolve', req, res);
    assert.strictEqual(res.statusCode, 415);
    assert.strictEqual(res.jsonBody.code, 'UNSUPPORTED_MEDIA_TYPE');
  }
});

test('G4-R1-G - Timed Drain Indicator, Safe Incomplete Warning & Dispatched Safety', async () => {
  const warnings = [];
  let finishMutate;
  const mutatePromise = new Promise((resolve) => {
    finishMutate = resolve;
  });

  const slowController = createStubController({
    mutate: async () => {
      await mutatePromise;
      return {
        ok: true,
        changed: true,
        value: {
          status: 'BOUND',
          cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
          avatar: 'hero.png',
          storageRevision: 2,
          registry: { schemaVersion: 1, revision: 1, characters: [] },
        },
      };
    },
  });

  const adapter = createSidecarHttpAdapter({
    controller: slowController,
    httpEnabled: true,
    writeEnabled: true,
    drainTimeoutMs: 25,
    onWarning: (w) => warnings.push(w),
  });
  const router = createMockRouter();
  adapter.registerRoutes(router);

  // 1. Idle close returns drained: true immediately
  const idleClose = await adapter.close(25);
  assert.deepStrictEqual(idleClose, { drained: true, pendingCount: 0 });

  // Reset closing flag via fresh adapter
  const liveAdapter = createSidecarHttpAdapter({
    controller: slowController,
    httpEnabled: true,
    writeEnabled: true,
    drainTimeoutMs: 25,
    onWarning: (w) => warnings.push(w),
  });
  const liveRouter = createMockRouter();
  liveAdapter.registerRoutes(liveRouter);

  const { req, res } = createMockReqRes({
    body: {
      cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'set', key: 'x', value: 1 },
    },
  });

  const dispatchPromise = liveRouter.dispatch('/v1/mutate', req, res);
  await new Promise((r) => setTimeout(r, 10));

  // Close during in-flight write: must timeout and report incomplete drain
  const closeResult = await liveAdapter.close(25);
  assert.strictEqual(closeResult.drained, false);
  assert.strictEqual(closeResult.pendingCount, 1);
  assert.deepStrictEqual(liveAdapter.getDrainStatus(), { closed: true, drained: false, pendingCount: 1 });

  // Verified safe privacy-preserving warning emitted
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].event, 'INCOMPLETE_DRAIN');
  assert.strictEqual(warnings[0].code, 'DRAIN_TIMEOUT_EXCEEDED');
  assert.strictEqual(warnings[0].pendingCount, 1);
  assert.strictEqual(Object.hasOwn(warnings[0], 'path'), false);
  assert.strictEqual(Object.hasOwn(warnings[0], 'body'), false);

  // Finish write operation: verify dispatched write was NOT aborted on timed drain
  finishMutate();
  await dispatchPromise;
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(liveAdapter.getMetrics().activePromisesCount, 0);
  assert.strictEqual(liveAdapter.getMetrics().lockedUsers.size, 0);
});

test('G4-R2-A - Admission Slot Release on Response Close Listener Failure', async () => {
  const router = createMockRouter();
  const controller = createStubController();
  const adapter = createSidecarHttpAdapter({
    controller,
    httpEnabled: true,
    writeEnabled: true,
    maxGlobalInFlight: 1, // Cap at 1 to immediately detect slot leakage
  });
  adapter.registerRoutes(router);

  // 1. Synthetic response whose on('close') throws
  const { req, res } = createMockReqRes({ body: { avatar: 'hero.png' } });
  res.on = (event, listener) => {
    if (event === 'close') {
      throw new Error('Hostile res.on registration failure');
    }
    return EventEmitter.prototype.on.call(res, event, listener);
  };

  await router.dispatch('/v1/resolve', req, res);
  assert.strictEqual(res.statusCode, 500);

  // Verify zero slot leakage and zero mutator lockout (pre-delegation failure)
  let metrics = adapter.getMetrics();
  assert.strictEqual(metrics.globalInFlight, 0);
  assert.strictEqual(metrics.activePromisesCount, 0);
  assert.strictEqual(metrics.activeMutatorUsers.size, 0);
  assert.strictEqual(metrics.lockedUsers.size, 0);

  // Subsequent request succeeds
  const { req: nextReq, res: nextRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/resolve', nextReq, nextRes);
  assert.strictEqual(nextRes.statusCode, 200);

  // 2. Pre-delegation mutator attempt with res.on throwing
  const { req: mutReq, res: mutRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  mutRes.on = (event, listener) => {
    if (event === 'close') {
      throw new Error('Hostile res.on in mutator');
    }
    return EventEmitter.prototype.on.call(mutRes, event, listener);
  };
  await router.dispatch('/v1/create', mutReq, mutRes);
  assert.strictEqual(mutRes.statusCode, 500);

  metrics = adapter.getMetrics();
  assert.strictEqual(metrics.globalInFlight, 0);
  assert.strictEqual(metrics.activeMutatorUsers.size, 0);
  assert.strictEqual(metrics.lockedUsers.size, 0); // Must NOT lock mutator on pre-delegation failure

  // Subsequent mutator request succeeds
  const { req: nextMutReq, res: nextMutRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/create', nextMutReq, nextMutRes);
  assert.strictEqual(nextMutRes.statusCode, 200);

  // 3. Pre-delegation socket close guard
  const { req: closedReq, res: closedRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  closedRes.destroyed = true;
  await router.dispatch('/v1/resolve', closedReq, closedRes);
  assert.strictEqual(adapter.getMetrics().globalInFlight, 0);
});

test('G4-R2-B - Create Requires Canonical C0 Empty Registry & Clone Nonzero Revision', async () => {
  const router = createMockRouter();

  // 1. Positive: create returning canonical empty registry { schemaVersion: 1, revision: 0, characters: [] }
  const canonicalCreateController = createStubController({
    create: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
        avatar: 'hero.png',
        storageRevision: 1,
        registry: { schemaVersion: 1, revision: 0, characters: [] },
      },
    }),
  });
  const adapter1 = createSidecarHttpAdapter({
    controller: canonicalCreateController,
    httpEnabled: true,
    writeEnabled: true,
  });
  adapter1.registerRoutes(router);

  const { req: okReq, res: okRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router.dispatch('/v1/create', okReq, okRes);
  assert.strictEqual(okRes.statusCode, 200);
  assert.strictEqual(okRes.jsonBody.value.registry.revision, 0);
  assert.strictEqual(adapter1.getMetrics().lockedUsers.size, 0);

  // 2. Negative: create returning non-zero revision (e.g. revision 9) -> classified: false, locks user root
  const nonZeroRevController = createStubController({
    create: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
        avatar: 'hero.png',
        storageRevision: 1,
        registry: { schemaVersion: 1, revision: 9, characters: [] },
      },
    }),
  });
  const adapter2 = createSidecarHttpAdapter({
    controller: nonZeroRevController,
    httpEnabled: true,
    writeEnabled: true,
  });
  const router2 = createMockRouter();
  adapter2.registerRoutes(router2);

  const { req: badReq, res: badRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router2.dispatch('/v1/create', badReq, badRes);
  assert.strictEqual(badRes.statusCode, 500);
  assert.strictEqual(badRes.jsonBody.code, 'INTERNAL_ERROR');
  assert.strictEqual(adapter2.getMetrics().lockedUsers.has('/mock/user/data'), true);

  // 3. Negative: create returning non-empty characters array -> classified: false, locks user root
  const nonEmptyCharsController = createStubController({
    create: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
        avatar: 'hero.png',
        storageRevision: 1,
        registry: { schemaVersion: 1, revision: 0, characters: [{ id: 'hero' }] },
      },
    }),
  });
  const adapter3 = createSidecarHttpAdapter({
    controller: nonEmptyCharsController,
    httpEnabled: true,
    writeEnabled: true,
  });
  const router3 = createMockRouter();
  adapter3.registerRoutes(router3);

  const { req: badCharsReq, res: badCharsRes } = createMockReqRes({ body: { avatar: 'hero.png' } });
  await router3.dispatch('/v1/create', badCharsReq, badCharsRes);
  assert.strictEqual(badCharsRes.statusCode, 500);
  assert.strictEqual(adapter3.getMetrics().lockedUsers.has('/mock/user/data'), true);

  // 4. Positive: clone returns valid registry with nonzero revision (permitted for clone)
  const cloneNonzeroRevController = createStubController({
    clone: async () => ({
      ok: true,
      changed: true,
      value: {
        status: 'BOUND',
        cardId: 'b2c3d4e5-f6a1-4b2c-8d3e-4f5a6b7c8d9e',
        avatar: 'target.png',
        storageRevision: 1,
        registry: { schemaVersion: 1, revision: 5, characters: [] },
      },
    }),
  });
  const adapter4 = createSidecarHttpAdapter({
    controller: cloneNonzeroRevController,
    httpEnabled: true,
    writeEnabled: true,
  });
  const router4 = createMockRouter();
  adapter4.registerRoutes(router4);

  const { req: cloneReq, res: cloneRes } = createMockReqRes({
    body: {
      sourceCardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
      sourceAvatar: 'source.png',
      targetAvatar: 'target.png',
      expectedSourceStorageRevision: 1,
    },
  });
  await router4.dispatch('/v1/clone', cloneReq, cloneRes);
  assert.strictEqual(cloneRes.statusCode, 200);
  assert.strictEqual(cloneRes.jsonBody.value.registry.revision, 5);
  assert.strictEqual(adapter4.getMetrics().lockedUsers.size, 0);
});

test('G4-R2-C - Safe Detached Snapshot Assembly & No toJSON Invocation', async () => {
  const router = createMockRouter();
  let receivedCommand = null;
  const controller = createStubController({
    mutate: async ({ command }) => {
      receivedCommand = command;
      return {
        ok: true,
        changed: true,
        value: {
          status: 'BOUND',
          cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
          avatar: 'hero.png',
          storageRevision: 2,
          registry: { schemaVersion: 1, revision: 1, characters: [] },
        },
      };
    },
  });
  const adapter = createSidecarHttpAdapter({
    controller,
    httpEnabled: true,
    writeEnabled: true,
  });
  adapter.registerRoutes(router);

  // 1. Proxy with toJSON trap on root body
  let bodyToJSONCalled = false;
  const proxyBody = new Proxy({ avatar: 'hero.png' }, {
    get(target, prop, receiver) {
      if (prop === 'toJSON') {
        bodyToJSONCalled = true;
        return () => 'A'.repeat(1024 * 1024); // 1 MiB huge string
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const { req: bodyReq, res: bodyRes } = createMockReqRes({ body: proxyBody });
  await router.dispatch('/v1/resolve', bodyReq, bodyRes);
  assert.strictEqual(bodyRes.statusCode, 200);
  assert.strictEqual(bodyToJSONCalled, false, 'toJSON on body must never be invoked');

  // 2. Proxy with toJSON trap on command object
  let commandToJSONCalled = false;
  const proxyCommand = new Proxy({ type: 'set', key: 'title', value: 'Hero' }, {
    get(target, prop, receiver) {
      if (prop === 'toJSON') {
        commandToJSONCalled = true;
        return () => 'B'.repeat(1024 * 1024);
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const { req: mutReq, res: mutRes } = createMockReqRes({
    body: {
      cardId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: proxyCommand,
    },
  });

  await router.dispatch('/v1/mutate', mutReq, mutRes);
  assert.strictEqual(mutRes.statusCode, 200);
  assert.strictEqual(commandToJSONCalled, false, 'toJSON on command must never be invoked');
  assert.deepStrictEqual(receivedCommand, { type: 'set', key: 'title', value: 'Hero' });
});

test('G4-R2-D - Trusted Request Context Exception Fails Closed', async () => {
  const router = createMockRouter();
  let controllerCalled = false;
  const controller = createStubController({
    resolve: async () => {
      controllerCalled = true;
      return { ok: true, value: { status: 'UNBOUND', avatar: 'hero.png', recoveryAvailable: false } };
    },
  });
  const adapter = createSidecarHttpAdapter({
    controller,
    httpEnabled: true,
    writeEnabled: true,
  });
  adapter.registerRoutes(router);

  const throwingContextReq = {
    headers: { 'content-type': 'application/json' },
    body: { avatar: 'hero.png' },
    user: {
      get directories() {
        throw new Error('Hostile directories getter detonation');
      },
    },
  };
  const res = new MockResponse();

  await router.dispatch('/v1/resolve', throwingContextReq, res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.jsonBody.code, 'INVALID_CONTEXT');
  assert.strictEqual(res.jsonBody.message, 'Invalid context directories');
  assert.strictEqual(controllerCalled, false);
  assert.strictEqual(adapter.getMetrics().globalInFlight, 0);
});
