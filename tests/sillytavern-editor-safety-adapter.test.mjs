/**
 * SillyTavern-ChromaticHub: Deny-Only Editor-Safety Adapter Tests (H01-B3-B / R1 / R2 / R3)
 *
 * Synthetic unit tests covering:
 * - Exhaustive deny-only boolean grid (all 64 combinations + avatar cases)
 * - Constructor strictness (unknown options, the former `posture`, probe names)
 * - Guarded probe access/invocation, throwing probes, thenable/async returns
 * - R1-F2: constructor diagnostic privacy (secret probe/option names and
 *   symbol keys never appear in thrown messages)
 * - R1-F5: frozen adapter object; rejected native Promise probes create no
 *   unhandled rejection; arbitrary thenable `.then` is never invoked
 * - R2-F1: strict option keys incl. symbol-keyed and non-enumerable extras
 *   and throwing key-enumeration traps, all with controlled diagnostics
 * - R2-F2: suppression cannot be spoofed via Symbol.toStringTag; a genuine
 *   Promise with overridden or throwing `.then` is still suppressed; async
 *   probes remain invalid; arbitrary thenable `.then` is never invoked
 * - R3-F1: constructor exception containment (prototype traps, throwing
 *   accessors on options.probes, descriptor traps) with controlled,
 *   non-leaking diagnostics
 * - R3-F2: suppression support boundary — ordinary native promises of this
 *   realm only; hostile constructor getters never execute; subclass,
 *   custom-species, and other exotic receivers are skipped by design and
 *   their rejections left to the host
 * - Invalid owner rejection without probe consultation
 * - Fresh probe evaluation per invocation; sanitized diagnostics; immutability
 * - Controller composition: checkpoint counts, queue-wait and pre-POST safety
 *   flips, independent per-avatar queues, no quarantine on pre-dispatch
 *   refusal, production adapter never authorizing, stub compatibility
 *
 * Network assertions use endpoint-specific counters. SillyTavern's
 * /api/characters/get is transported via HTTP POST but is read-only; requests
 * are classified by endpoint and semantics, not by HTTP verb.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSillyTavernEditorSafetyAdapter,
  EDITOR_SAFETY_NOT_CERTIFIABLE,
} from '../src/sillytavern-editor-safety-adapter.mjs';
import { evaluateEditorSafety, EDITOR_SAFETY_REASONS } from '../src/editor-safety.mjs';
import { mutateCard } from '../src/card-mutation-controller.mjs';

const SECRET = 'SECRET-TOKEN-do-not-leak-9f1c';

const PROBE_FIELDS = [
  'editorVisible',
  'editorDirty',
  'saveScheduled',
  'saveInFlight',
  'hiddenJsonConflicts',
  'externalWriterSuspected',
];

function makeProbes(overrides = {}) {
  const base = {
    editorVisible: false,
    editorDirty: false,
    saveScheduled: false,
    saveInFlight: false,
    hiddenJsonConflicts: false,
    activeCardAvatar: 'Target.png',
    externalWriterSuspected: false,
  };
  const values = { ...base, ...overrides };
  const probes = {};
  for (const name of Object.keys(values)) {
    probes[name] = () => values[name];
  }
  return probes;
}

/**
 * Wraps probes with an invocation counter that lives OUTSIDE the probes
 * object (the adapter strictly rejects any extra own property on probes).
 */
function counting(probes) {
  let calls = 0;
  const wrapped = {};
  for (const name of Object.keys(probes)) {
    const inner = probes[name];
    wrapped[name] = (...args) => {
      calls++;
      return inner(...args);
    };
  }
  return { probes: wrapped, getCallCount: () => calls };
}

/**
 * Endpoint-specific counting fetch. Classifies by URL semantics:
 * /api/characters/get counts as a read (despite HTTP POST transport);
 * /api/characters/merge-attributes counts as a mutation.
 */
function createEndpointCountingFetch(handler) {
  const counters = { get: 0, merge: 0, other: 0 };
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    if (url === '/api/characters/get') counters.get++;
    else if (url === '/api/characters/merge-attributes') counters.merge++;
    else counters.other++;
    calls.push({ url, options });
    return handler(url, options, calls.length - 1);
  };
  fetchFn.counters = counters;
  fetchFn.calls = calls;
  fetchFn.getTotal = () => counters.get + counters.merge + counters.other;
  return fetchFn;
}

function cardResponse(avatar, registry) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      avatar,
      data: { extensions: registry === undefined ? {} : { chromaticHub: registry } },
    }),
  };
}

const VALID_UUID = '4d15ae22-565c-4d19-9e6c-6d7653940cfa';

function validRegistry() {
  return {
    schemaVersion: 1,
    revision: 1,
    characters: [{ id: VALID_UUID, name: 'Hina', descriptor: 'Knight', aliases: [] }],
  };
}

/** Test-owned synthetic checker backed by the pure evaluator (never src). */
function createSyntheticChecker(avatar, initial = {}) {
  const state = {
    editorVisible: false,
    editorDirty: false,
    saveScheduled: false,
    saveInFlight: false,
    hiddenJsonConflicts: false,
    externalWriterSuspected: false,
    activeCardAvatar: avatar,
    ...initial,
  };
  const checker = (owner) => {
    checker.callCount++;
    return evaluateEditorSafety({
      schemaVersion: 1,
      owner: { kind: 'installed-card', avatar: owner.avatar },
      editorVisible: { status: 'ok', value: state.editorVisible },
      editorDirty: { status: 'ok', value: state.editorDirty },
      saveScheduled: { status: 'ok', value: state.saveScheduled },
      saveInFlight: { status: 'ok', value: state.saveInFlight },
      hiddenJsonConflicts: { status: 'ok', value: state.hiddenJsonConflicts },
      activeCardAvatar: { status: 'ok', value: state.activeCardAvatar },
      externalWriterSuspected: { status: 'ok', value: state.externalWriterSuspected },
    });
  };
  checker.callCount = 0;
  checker.flip = (patch) => Object.assign(state, patch);
  return checker;
}

test('adapter - exhaustive deny-only grid', async (t) => {
  await t.test('B1: all 64 boolean combinations always deny', () => {
    for (let mask = 0; mask < 64; mask++) {
      const overrides = {};
      PROBE_FIELDS.forEach((field, index) => {
        overrides[field] = Boolean((mask >> index) & 1);
      });
      const probes = makeProbes(overrides);
      const adapter = createSillyTavernEditorSafetyAdapter({ probes });
      const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
      assert.equal(decision.safe, false, `mask ${mask} must deny`);
      assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE, `mask ${mask} reason`);
    }
  });

  await t.test('B1: avatar cases (match, null, other) always deny', () => {
    for (const activeCardAvatar of ['Target.png', null, 'Other.png']) {
      const adapter = createSillyTavernEditorSafetyAdapter({
        probes: makeProbes({ activeCardAvatar }),
      });
      const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
      assert.equal(decision.safe, false);
      assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
    }
  });

  await t.test('B1: decision shape is constant and frozen', () => {
    const adapter = createSillyTavernEditorSafetyAdapter({ probes: makeProbes() });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(Object.isFrozen(decision), true);
    assert.equal(Object.isFrozen(decision.details), true);
    assert.equal(Object.isFrozen(decision.details.observedReasons), true);
    assert.equal(typeof decision.message, 'string');
    assert.throws(() => {
      'use strict';
      decision.safe = true;
    });
  });

  await t.test('B1: sanitized observedReasons carry enum values only', () => {
    const adapter = createSillyTavernEditorSafetyAdapter({
      probes: makeProbes({ editorDirty: true, saveInFlight: true }),
    });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.EDITOR_DIRTY]);
    for (const reason of decision.details.observedReasons) {
      assert.equal(Object.prototype.hasOwnProperty.call(EDITOR_SAFETY_REASONS, reason), true);
    }
  });
});

test('adapter - constructor strictness', async (t) => {
  await t.test('B4: unknown option keys throw (including the former posture)', () => {
    assert.throws(() => createSillyTavernEditorSafetyAdapter({ probes: makeProbes(), posture: 'certifying' }));
    assert.throws(() => createSillyTavernEditorSafetyAdapter({ probes: makeProbes(), extra: 1 }));
    assert.throws(() => createSillyTavernEditorSafetyAdapter({}));
    assert.throws(() => createSillyTavernEditorSafetyAdapter(null));
    assert.throws(() => createSillyTavernEditorSafetyAdapter());
  });

  await t.test('B4: unknown probe names throw', () => {
    assert.throws(() =>
      createSillyTavernEditorSafetyAdapter({
        probes: { ...makeProbes(), editorVisibleX: () => false },
      }),
    );
  });

  await t.test('B4: probes must be a plain object', () => {
    assert.throws(() => createSillyTavernEditorSafetyAdapter({ probes: null }));
    assert.throws(() => createSillyTavernEditorSafetyAdapter({ probes: 'probes' }));
  });

  await t.test('R1-F2: secret-bearing probe name throws without leaking the secret', () => {
    assert.throws(
      () =>
        createSillyTavernEditorSafetyAdapter({
          probes: { ...makeProbes(), [SECRET]: () => false },
        }),
      (err) => !String(err.message).includes(SECRET),
    );
  });

  await t.test('R1-F2: secret-bearing option key throws without leaking the secret', () => {
    assert.throws(
      () => createSillyTavernEditorSafetyAdapter({ probes: makeProbes(), [SECRET]: 1 }),
      (err) => !String(err.message).includes(SECRET),
    );
  });

  await t.test('R1-F2: symbol-keyed probe property throws', () => {
    assert.throws(() =>
      createSillyTavernEditorSafetyAdapter({
        probes: { ...makeProbes(), [Symbol(SECRET)]: () => false },
      }),
    );
    assert.throws(() =>
      createSillyTavernEditorSafetyAdapter({
        probes: { ...makeProbes(), [Symbol('extra')]: () => false },
      }),
    );
  });

  await t.test('R1-F2: non-enumerable extra probe property throws', () => {
    const probes = makeProbes();
    Object.defineProperty(probes, 'hiddenExtra', {
      value: () => false,
      enumerable: false,
      configurable: true,
    });
    assert.throws(() => createSillyTavernEditorSafetyAdapter({ probes }));
  });

  await t.test('R2-F1: symbol-keyed option property throws without leaking the symbol', () => {
    assert.throws(
      () => createSillyTavernEditorSafetyAdapter({ probes: makeProbes(), [Symbol(SECRET)]: 1 }),
      (err) => !String(err.message).includes(SECRET),
    );
  });

  await t.test('R2-F1: non-enumerable extra option property throws', () => {
    const options = { probes: makeProbes() };
    Object.defineProperty(options, 'hiddenExtra', {
      value: 1,
      enumerable: false,
      configurable: true,
    });
    assert.throws(() => createSillyTavernEditorSafetyAdapter(options));
  });

  await t.test('R2-F1: hostile options ownKeys proxy trap throws a controlled error', () => {
    const options = new Proxy({ probes: makeProbes() }, {
      ownKeys() {
        throw new Error(SECRET);
      },
    });
    // isPlainObject passes the proxy (prototype lookup is unaffected);
    // the guarded key enumeration must fail closed with a fixed message.
    assert.throws(
      () => createSillyTavernEditorSafetyAdapter(options),
      (err) => err instanceof Error && !String(err.message).includes(SECRET),
    );
  });

  await t.test('R2-F1: hostile probes ownKeys proxy trap throws a controlled error', () => {
    const probes = new Proxy(makeProbes(), {
      ownKeys() {
        throw new Error(SECRET);
      },
    });
    assert.throws(
      () => createSillyTavernEditorSafetyAdapter({ probes }),
      (err) => err instanceof Error && !String(err.message).includes(SECRET),
    );
  });

  await t.test('R2-F1: valid minimal options object is still accepted', () => {
    const adapter = createSillyTavernEditorSafetyAdapter({ probes: makeProbes() });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
  });

  await t.test('R3-F1: getPrototypeOf trap on options throws controlled, non-leaking error', () => {
    const options = new Proxy({ probes: {} }, {
      getPrototypeOf() {
        throw new Error(SECRET);
      },
    });
    assert.throws(
      () => createSillyTavernEditorSafetyAdapter(options),
      (err) => err instanceof Error && !String(err.message).includes(SECRET),
    );
  });

  await t.test('R3-F1: throwing accessor on options.probes throws controlled, non-leaking error', () => {
    const options = {};
    Object.defineProperty(options, 'probes', {
      get() {
        throw new Error(SECRET);
      },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => createSillyTavernEditorSafetyAdapter(options),
      (err) => err instanceof Error && !String(err.message).includes(SECRET),
    );
  });

  await t.test('R3-F1: getPrototypeOf trap on probes throws controlled, non-leaking error', () => {
    const probes = new Proxy(makeProbes(), {
      getPrototypeOf() {
        throw new Error(SECRET);
      },
    });
    assert.throws(
      () => createSillyTavernEditorSafetyAdapter({ probes }),
      (err) => err instanceof Error && !String(err.message).includes(SECRET),
    );
  });

  await t.test('R3-F1: hostile descriptor trap on options.probes lookup is contained', () => {
    // A proxy getOwnPropertyDescriptor trap that throws must not leak.
    const options = new Proxy({ probes: makeProbes() }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'probes') {
          throw new Error(SECRET);
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    assert.throws(
      () => createSillyTavernEditorSafetyAdapter(options),
      (err) => err instanceof Error && !String(err.message).includes(SECRET),
    );
  });

  await t.test('R3-F1: probes accessor returning a value is still usable', () => {
    // Non-throwing accessor delivering the probes object must construct.
    const options = {};
    Object.defineProperty(options, 'probes', {
      get() {
        return makeProbes();
      },
      enumerable: true,
      configurable: true,
    });
    const adapter = createSillyTavernEditorSafetyAdapter(options);
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
  });
});

test('adapter - guarded probe evaluation', async (t) => {
  await t.test('B2: throwing probes cannot change the verdict or leak details', () => {
    const probes = makeProbes();
    probes.editorDirty = () => {
      throw new Error(SECRET);
    };
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
    assert.equal(JSON.stringify(decision).includes(SECRET), false);
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
  });

  await t.test('B2: hostile probe-property getters cannot escape or leak', () => {
    const probes = makeProbes();
    Object.defineProperty(probes, 'saveInFlight', {
      get() {
        throw new Error(SECRET);
      },
      configurable: true,
    });
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(JSON.stringify(decision).includes(SECRET), false);
  });

  await t.test('B3: missing or undefined-returning probes fail closed', () => {
    const probes = makeProbes();
    delete probes.editorVisible;
    let adapter = createSillyTavernEditorSafetyAdapter({ probes });
    let decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);

    const probes2 = makeProbes();
    probes2.hiddenJsonConflicts = () => undefined;
    adapter = createSillyTavernEditorSafetyAdapter({ probes: probes2 });
    decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
  });

  await t.test('B3: Promise-returning (including async) probes never count as observations', () => {
    const probes = makeProbes();
    probes.saveScheduled = () => Promise.resolve(false);
    probes.externalWriterSuspected = async () => false;
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
  });

  await t.test('B3: wrong-typed probe results fail closed', () => {
    for (const bad of ['false', 0, 1, null, {}]) {
      const probes = makeProbes();
      probes.editorDirty = () => bad;
      const adapter = createSillyTavernEditorSafetyAdapter({ probes });
      const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
      assert.equal(decision.safe, false, `probe returning ${String(bad)} must deny`);
      assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
    }
  });

  await t.test('B5: invalid owner rejects without consulting probes', () => {
    const { probes, getCallCount } = counting(makeProbes());
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const badOwners = [
      null,
      'owner',
      { kind: 'chat-local', avatar: 'Target.png' },
      { kind: 'installed-card', avatar: '' },
      { kind: 'installed-card', avatar: '../up.png' },
      { kind: 'installed-card', avatar: 'card.jpg' },
      { kind: 'installed-card', avatar: 42 },
      { kind: 'installed-card', avatar: '..png' },
      { kind: 'installed-card', avatar: '.png' },
    ];
    for (const owner of badOwners) {
      const before = getCallCount();
      const decision = adapter.checkEditorSafety(owner);
      assert.equal(decision.safe, false, `owner ${JSON.stringify(owner)} must deny`);
      assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
      assert.equal(getCallCount(), before, 'probes must not be consulted for invalid owners');
    }
  });

  await t.test('B6: probes are re-invoked fresh on every call (no caching)', () => {
    const { probes, getCallCount } = counting(makeProbes());
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    const afterFirst = getCallCount();
    assert.equal(afterFirst, 7);
    adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(getCallCount(), afterFirst + 7);
  });

  await t.test('B7: hostile probes cannot leak secrets, exceptions, or DOM strings', () => {
    const probes = makeProbes();
    probes.activeCardAvatar = () => SECRET;
    probes.editorVisible = () => {
      throw new Error(`<div>${SECRET}</div>`);
    };
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    const serialized = JSON.stringify(decision);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes('<div>'), false);
    assert.equal(decision.safe, false);
  });
});

test('adapter - R1-F5 robustness', async (t) => {
  await t.test('R1-F5: returned adapter object is frozen', () => {
    const adapter = createSillyTavernEditorSafetyAdapter({ probes: makeProbes() });
    assert.equal(Object.isFrozen(adapter), true);
    assert.throws(() => {
      'use strict';
      adapter.checkEditorSafety = () => ({ safe: true });
    });
    assert.throws(() => {
      'use strict';
      adapter.extra = 1;
    });
    // The original verdict function is untouched by the failed assignment.
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
  });

  await t.test('R1-F5: rejected native Promise probe creates no unhandled rejection', async () => {
    const rejections = [];
    const onUnhandled = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const probes = makeProbes();
      probes.editorVisible = () => Promise.reject(new Error('probe rejected'));
      const adapter = createSillyTavernEditorSafetyAdapter({ probes });
      const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
      assert.equal(decision.safe, false);
      assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
      assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);

      // Give the microtask/macrotask queue a chance to surface an unhandled
      // rejection; the adapter's no-op handlers must have suppressed it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(rejections.length, 0, 'no unhandled rejection may escape the adapter');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await t.test('R1-F5: async rejected probe creates no unhandled rejection', async () => {
    const rejections = [];
    const onUnhandled = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const probes = makeProbes();
      probes.saveScheduled = async () => {
        throw new Error('async probe rejected');
      };
      const adapter = createSillyTavernEditorSafetyAdapter({ probes });
      const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
      assert.equal(decision.safe, false);
      assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(rejections.length, 0, 'async probe rejection must be suppressed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await t.test('R1-F5: arbitrary thenable .then is never invoked', () => {
    const probes = makeProbes();
    let thenCalled = 0;
    let catchAttached = false;
    const thenable = {
      then(onFulfilled, onRejected) {
        thenCalled++;
        catchAttached = typeof onRejected === 'function';
        return thenable;
      },
    };
    probes.externalWriterSuspected = () => thenable;
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
    assert.equal(thenCalled, 0, 'the adapter must never invoke arbitrary thenable behavior');
    assert.equal(catchAttached, false);
  });

  await t.test('R1-F5: impostor thenable with hostile .then getter is contained', () => {
    const probes = makeProbes();
    probes.hiddenJsonConflicts = () => {
      const hostile = {};
      Object.defineProperty(hostile, 'then', {
        get() {
          throw new Error(SECRET);
        },
        configurable: true,
      });
      return hostile;
    };
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(JSON.stringify(decision).includes(SECRET), false);
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
  });

  await t.test('R1-F5: resolved native Promise probe is still refused, never awaited', async () => {
    const probes = makeProbes();
    let observedResolution = null;
    probes.activeCardAvatar = () =>
      Promise.resolve('Target.png').then((v) => {
        observedResolution = v;
        return v;
      });
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
    // Let the promise settle; its resolution must never become an observation.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.notEqual(observedResolution, null); // the promise itself did settle...
    const again = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(again.safe, false, '...but the adapter still refuses on every call');
    assert.equal(again.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
  });
});

// R2-F2 regressions 4–6 (rejected ordinary native Promise, async rejecting
// probe, arbitrary thenable) are the R1-F5 tests above; they exercise the
// suppression mechanism unchanged. The suite below covers the spoofing and
// hostile-receiver cases, and the R3-F2 support boundary: only ordinary
// native promises of this realm are suppressed; subclasses, custom species,
// cross-realm values, proxies, and receivers with an own "constructor" are
// skipped by design and left to the host.
test('adapter - R2-F2 promise suppression hardening', async (t) => {
  await t.test('R2-F2: fake Promise spoofing Symbol.toStringTag never has .then invoked', async () => {
    const rejections = [];
    const onUnhandled = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let fakeThenCalled = 0;
      const fake = {
        [Symbol.toStringTag]: 'Promise',
        then(onFulfilled, onRejected) {
          fakeThenCalled++;
          return fake;
        },
      };
      const probes = makeProbes();
      probes.editorVisible = () => fake;
      const adapter = createSillyTavernEditorSafetyAdapter({ probes });
      const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
      assert.equal(decision.safe, false);
      assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
      assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(fakeThenCalled, 0, 'a spoofed-identity fake promise must never have .then invoked');
      assert.equal(rejections.length, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await t.test('R2-F2: genuine Promise with overridden own .then is suppressed without invoking it', async () => {
    const rejections = [];
    const onUnhandled = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const p = Promise.reject(new Error('ordinary rejection'));
      let overrideCalled = 0;
      p.then = function () {
        overrideCalled++;
        return p;
      };
      const probes = makeProbes();
      probes.editorDirty = () => p;
      const adapter = createSillyTavernEditorSafetyAdapter({ probes });
      const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
      assert.equal(decision.safe, false);
      assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(overrideCalled, 0, 'the overridden .then must never be invoked by suppression');
      assert.equal(rejections.length, 0, 'the rejection must be suppressed despite the override');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await t.test('R2-F2: genuine Promise with throwing .then getter stays suppressed and contained', async () => {
    const rejections = [];
    const onUnhandled = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const p = Promise.reject(new Error('ordinary rejection'));
      Object.defineProperty(p, 'then', {
        get() {
          throw new Error(SECRET);
        },
        configurable: true,
      });
      const probes = makeProbes();
      probes.saveInFlight = () => p;
      const adapter = createSillyTavernEditorSafetyAdapter({ probes });
      const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
      assert.equal(decision.safe, false);
      assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
      assert.equal(JSON.stringify(decision).includes(SECRET), false, 'the getter error must not leak');
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(rejections.length, 0, 'the rejection must be suppressed without reading .then');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await t.test('R3-F2: subclass rejection is deliberately NOT suppressed (documented limit)', async () => {
    // The subclass receiver is outside the ordinary-promise support
    // boundary: suppressing it would consult its constructor/species
    // chain. The adapter must skip it (species hooks never run) while
    // still refusing the observation. The rejection is the host's
    // responsibility; this test cleans it up synchronously so no
    // unhandled rejection occurs during the run.
    let speciesRuns = 0;
    class SpeciesCounting extends Promise {
      static get [Symbol.species]() {
        speciesRuns++;
        return Promise;
      }
    }
    const p = SpeciesCounting.reject(new Error('subclass rejection'));
    const probes = makeProbes();
    probes.externalWriterSuspected = () => p;
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, EDITOR_SAFETY_NOT_CERTIFIABLE);
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
    // No suppression attempt: the adapter never consulted the species chain.
    assert.equal(speciesRuns, 0, 'species hooks must never run for a skipped receiver');
    // Test-owned cleanup in the same tick: no unhandled rejection event.
    p.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(speciesRuns >= 0); // cleanup may consult species; harmless
  });

  await t.test('R3-F2: hostile own constructor getter is never executed', async () => {
    const p = Promise.reject(new Error('booby-trapped rejection'));
    let getterRuns = 0;
    Object.defineProperty(p, 'constructor', {
      get() {
        getterRuns++;
        throw new Error(SECRET);
      },
      configurable: true,
    });
    const probes = makeProbes();
    probes.saveScheduled = () => p;
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.deepEqual(decision.details.observedReasons, [EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION]);
    assert.equal(JSON.stringify(decision).includes(SECRET), false, 'the getter error must not leak');
    // The receiver is outside the support boundary (own "constructor"), so
    // the getter must never have executed during the adapter call.
    assert.equal(getterRuns, 0, 'the hostile constructor getter must never execute');
    // Test-owned cleanup: remove the trap, then settle the rejection here.
    delete p.constructor;
    p.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(getterRuns, 0, 'cleanup must not re-arm the trap either');
  });

  await t.test('R3-F2: custom species getter on a subclass is never consulted by the adapter', async () => {
    let armed = true;
    let speciesRuns = 0;
    class HostileSpecies extends Promise {
      static get [Symbol.species]() {
        speciesRuns++;
        if (armed) {
          throw new Error(SECRET);
        }
        return Promise;
      }
    }
    const p = HostileSpecies.reject(new Error('species rejection'));
    const probes = makeProbes();
    probes.editorVisible = () => p;
    const adapter = createSillyTavernEditorSafetyAdapter({ probes });
    const decision = adapter.checkEditorSafety({ kind: 'installed-card', avatar: 'Target.png' });
    assert.equal(decision.safe, false);
    assert.equal(JSON.stringify(decision).includes(SECRET), false);
    assert.equal(speciesRuns, 0, 'the hostile species getter must never be consulted by the adapter');

    // Test-owned cleanup: disarm the trap, then attach no-op handlers via
    // the intrinsic then. Only this cleanup may consult the species chain.
    armed = false;
    Promise.prototype.then.call(p, () => {}, () => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(speciesRuns, 1, 'only the test-owned cleanup consulted species (disarmed)');
  });
});

test('controller composition - preflight refusals (zero network)', async (t) => {
  const DANGER_FLIPS = [
    ['editor open', { editorVisible: true }],
    ['dirty editor', { editorDirty: true }],
    ['pending save', { saveScheduled: true }],
    ['in-flight save', { saveInFlight: true }],
    ['stale hidden JSON', { hiddenJsonConflicts: true }],
    ['active card mismatch', { activeCardAvatar: 'Other.png' }],
    ['external writer', { externalWriterSuspected: true }],
  ];

  await t.test('C1: every danger reason refuses preflight with zero total network calls', async () => {
    for (const [label, flip] of DANGER_FLIPS) {
      const avatar = 'Gate.png';
      const owner = { kind: 'installed-card', avatar };
      const checker = createSyntheticChecker(avatar, flip);
      const fetchFn = createEndpointCountingFetch(() => cardResponse(avatar, undefined));
      const deps = {
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token-123' }),
        checkEditorSafety: checker,
        getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
        expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
        fetch: fetchFn,
      };

      const res = await mutateCard(owner, { type: 'add', character: { name: 'Bob' } }, { status: 'UNINITIALIZED' }, deps);
      assert.equal(res.ok, false, `${label} must refuse`);
      assert.equal(res.code, 'WRITE_REJECTED', `${label} code`);
      assert.equal(fetchFn.getTotal(), 0, `${label} must issue zero network calls`);
      assert.equal(fetchFn.counters.get, 0);
      assert.equal(fetchFn.counters.merge, 0);
      assert.equal(checker.callCount, 1);
    }
  });

  await t.test('C8: production adapter denies before any network traffic', async () => {
    const avatar = 'Prod.png';
    const owner = { kind: 'installed-card', avatar };
    const adapter = createSillyTavernEditorSafetyAdapter({ probes: makeProbes({ activeCardAvatar: avatar }) });
    const fetchFn = createEndpointCountingFetch(() => cardResponse(avatar, undefined));
    const deps = {
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token-123' }),
      checkEditorSafety: adapter.checkEditorSafety,
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchFn,
    };

    const res = await mutateCard(owner, { type: 'add', character: { name: 'Bob' } }, { status: 'UNINITIALIZED' }, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
    assert.equal(fetchFn.getTotal(), 0);
    assert.equal(fetchFn.counters.get, 0);
    assert.equal(fetchFn.counters.merge, 0);
  });

  await t.test('C2: pre-dispatch safety refusal never quarantines the card', async () => {
    const avatar = 'NoQuarantine.png';
    const owner = { kind: 'installed-card', avatar };
    const checker = createSyntheticChecker(avatar, { editorDirty: true });
    const fetchFn = createEndpointCountingFetch(() => cardResponse(avatar, undefined));
    const deps = {
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token-123' }),
      checkEditorSafety: checker,
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchFn,
    };

    const refused = await mutateCard(owner, { type: 'add', character: { name: 'Bob' } }, { status: 'UNINITIALIZED' }, deps);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'WRITE_REJECTED');
    assert.equal(fetchFn.getTotal(), 0);

    checker.flip({ editorDirty: false });
    const registry = validRegistry();
    let merged = null;
    const fetchFn2 = createEndpointCountingFetch((url, options) => {
      if (url === '/api/characters/get') {
        return cardResponse(avatar, merged === null ? registry : merged.data.extensions.chromaticHub);
      }
      merged = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
    });
    const deps2 = { ...deps, fetch: fetchFn2 };
    const retry = await mutateCard(owner, { type: 'add', character: { name: 'Bob' } }, { status: 'VALID', value: registry }, deps2);
    assert.notEqual(retry.code, 'CARD_QUARANTINED');
    assert.equal(retry.ok, true, 'retry after clean refusal must succeed');
    assert.equal(fetchFn2.counters.merge, 1);
  });
});

test('controller composition - successful synthetic mutation', async (t) => {
  await t.test('C3: success invokes the checker exactly 3 times; one merge, two reads', async () => {
    const avatar = 'Success.png';
    const owner = { kind: 'installed-card', avatar };
    const checker = createSyntheticChecker(avatar);
    const registry = validRegistry();
    let merged = null;
    const fetchFn = createEndpointCountingFetch((url, options) => {
      if (url === '/api/characters/merge-attributes') {
        merged = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return cardResponse(
        avatar,
        merged === null
          ? registry
          : { ...merged.data.extensions.chromaticHub },
      );
    });
    const deps = {
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token-123' }),
      checkEditorSafety: checker,
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchFn,
    };

    const res = await mutateCard(owner, { type: 'add', character: { name: 'Bob' } }, { status: 'VALID', value: registry }, deps);
    assert.equal(res.ok, true);
    assert.equal(checker.callCount, 3, 'preflight + post-queue + pre-POST');
    assert.equal(fetchFn.counters.merge, 1);
    assert.equal(fetchFn.counters.get, 2, 'pre-read + readback');
    assert.equal(fetchFn.getTotal(), 3);
  });

  await t.test('C4: no-op path invokes the checker exactly 3 times; no merge, one read', async () => {
    const avatar = 'Noop.png';
    const owner = { kind: 'installed-card', avatar };
    const checker = createSyntheticChecker(avatar);
    const registry = validRegistry();
    const fetchFn = createEndpointCountingFetch((url) =>
      url === '/api/characters/get' ? cardResponse(avatar, registry) : { ok: true, status: 200, json: async () => ({}) },
    );
    const deps = {
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token-123' }),
      checkEditorSafety: checker,
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchFn,
    };

    // An update that changes nothing relative to the expected snapshot.
    const res = await mutateCard(
      owner,
      { type: 'update', character: { id: VALID_UUID, name: 'Hina', descriptor: 'Knight', aliases: [] } },
      { status: 'VALID', value: registry },
      deps,
    );
    assert.equal(res.ok, true);
    assert.equal(res.noop, true);
    assert.equal(checker.callCount, 3, 'preflight + post-queue + no-op checkpoint');
    assert.equal(fetchFn.counters.merge, 0);
    assert.equal(fetchFn.counters.get, 1, 'pre-read only');
    assert.equal(fetchFn.getTotal(), 1);
  });

  await t.test('C6: safety flip after preliminary read refuses before POST (read permitted)', async () => {
    const avatar = 'FlipPrePost.png';
    const owner = { kind: 'installed-card', avatar };
    const checker = createSyntheticChecker(avatar);
    const registry = validRegistry();
    const fetchFn = createEndpointCountingFetch(async (url) => {
      if (url === '/api/characters/get') {
        // The pre-read completes, then the state changes before the pre-POST checkpoint.
        checker.flip({ saveScheduled: true });
        return cardResponse(avatar, registry);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const deps = {
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token-123' }),
      checkEditorSafety: checker,
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchFn,
    };

    const res = await mutateCard(owner, { type: 'add', character: { name: 'Bob' } }, { status: 'VALID', value: registry }, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
    assert.equal(fetchFn.counters.merge, 0, 'no mutation POST may be dispatched');
    assert.equal(fetchFn.counters.get, 1, 'the preliminary read already happened and is permitted');
    assert.equal(checker.callCount, 3, 'preflight + post-queue + pre-POST');
  });
});

test('controller composition - queue behavior', async (t) => {
  await t.test('C5: safety flips while another mutation holds the avatar queue', async () => {
    const avatar = 'Queued.png';
    const owner = { kind: 'installed-card', avatar };
    const registry = validRegistry();

    let releaseFirst = () => {};
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const checkerA = createSyntheticChecker(avatar);
    const checkerB = createSyntheticChecker(avatar);
    let merged = null;
    const fetchA = createEndpointCountingFetch(async (url) => {
      if (url === '/api/characters/get') return cardResponse(avatar, registry);
      await gate; // hold the queue
      merged = { result: 'ok' };
      return { ok: true, status: 200, json: async () => merged };
    });
    const fetchB = createEndpointCountingFetch(() => {
      throw new Error('B must never issue network calls');
    });

    const depsA = {
      getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }),
      checkEditorSafety: checkerA,
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchA,
    };

    // First mutation completes successfully after write/readback with the
    // exact planned registry captured from the merge payload; second
    // operation waits in the queue meanwhile.
    let planned = null;
    const fetchAHolding = createEndpointCountingFetch(async (url, options) => {
      if (url === '/api/characters/merge-attributes') {
        planned = JSON.parse(options.body).data.extensions.chromaticHub;
        await gate;
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return cardResponse(avatar, planned === null ? registry : planned);
    });

    const promiseA = mutateCard(
      owner,
      { type: 'add', character: { name: 'Bob' } },
      { status: 'VALID', value: registry },
      { ...depsA, fetch: fetchAHolding },
    );

    // Let A reach its merge (queue held), then enqueue B and flip unsafe.
    await new Promise((r) => setTimeout(r, 25));
    const depsB = {
      getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }),
      checkEditorSafety: checkerB,
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchB,
    };
    // B passes its synchronous preflight while clean, then waits in the
    // avatar queue behind A. The state change happens while B is queued.
    const promiseB = mutateCard(
      owner,
      { type: 'add', character: { name: 'Cara' } },
      { status: 'VALID', value: registry },
      depsB,
    );
    assert.equal(checkerB.callCount, 1, 'B passed its preflight while clean');

    // Safety state changes while B is waiting in the queue.
    checkerB.flip({ editorVisible: true });

    // While B waits, A finishes; B then acquires the queue and is refused
    // at the post-queue safety checkpoint.
    releaseFirst();
    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    assert.equal(resA.ok, true, 'first mutation completes');
    assert.equal(resB.ok, false, 'queued mutation must be refused');
    assert.equal(resB.code, 'WRITE_REJECTED');
    assert.equal(fetchB.getTotal(), 0, 'rejected operation issues zero network calls');
    assert.equal(fetchB.counters.merge, 0);
    assert.equal(checkerB.callCount, 2, 'preflight + post-queue');
    void fetchA;
    void merged;
  });

  await t.test('C7: independent per-avatar queues stay isolated', async () => {
    const avatarA = 'Isolated_A.png';
    const avatarB = 'Isolated_B.png';
    const ownerA = { kind: 'installed-card', avatar: avatarA };
    const ownerB = { kind: 'installed-card', avatar: avatarB };
    const registryA = validRegistry();
    const registryB = validRegistry();

    const checkerA = createSyntheticChecker(avatarA, { editorDirty: true }); // A refused
    const checkerB = createSyntheticChecker(avatarB); // B proceeds

    const fetchA = createEndpointCountingFetch(() => {
      throw new Error('A must never issue network calls');
    });
    let mergedB = null;
    const fetchB = createEndpointCountingFetch((url, options) => {
      if (url === '/api/characters/merge-attributes') {
        mergedB = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return cardResponse(avatarB, mergedB === null ? registryB : mergedB.data.extensions.chromaticHub);
    });

    const base = (avatar, checker, fetchFn) => ({
      getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }),
      checkEditorSafety: checker,
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchFn,
    });

    const [resA, resB] = await Promise.all([
      mutateCard(ownerA, { type: 'add', character: { name: 'X' } }, { status: 'VALID', value: registryA }, base(avatarA, checkerA, fetchA)),
      mutateCard(ownerB, { type: 'add', character: { name: 'Y' } }, { status: 'VALID', value: registryB }, base(avatarB, checkerB, fetchB)),
    ]);

    assert.equal(resA.ok, false);
    assert.equal(resA.code, 'WRITE_REJECTED');
    assert.equal(fetchA.getTotal(), 0);

    assert.equal(resB.ok, true, 'avatar B completes despite avatar A being refused');
    assert.equal(fetchB.counters.merge, 1);
    assert.notEqual(resB.code, 'CARD_QUARANTINED');

    // A's refusal did not quarantine A either: a later clean attempt succeeds.
    const checkerA2 = createSyntheticChecker(avatarA);
    let mergedA2 = null;
    const fetchA2 = createEndpointCountingFetch((url, options) => {
      if (url === '/api/characters/get') {
        return cardResponse(avatarA, mergedA2 === null ? registryA : mergedA2.data.extensions.chromaticHub);
      }
      mergedA2 = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
    });
    const resA2 = await mutateCard(ownerA, { type: 'add', character: { name: 'X' } }, { status: 'VALID', value: registryA }, base(avatarA, checkerA2, fetchA2));
    assert.equal(resA2.ok, true);
    assert.notEqual(resA2.code, 'CARD_QUARANTINED');
  });

  await t.test('C9: existing controller stub shapes remain compatible', async () => {
    const avatar = 'Stub.png';
    const owner = { kind: 'installed-card', avatar };
    const registry = validRegistry();
    let merged = null;
    const fetchFn = createEndpointCountingFetch((url, options) => {
      if (url === '/api/characters/merge-attributes') {
        merged = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return cardResponse(avatar, merged === null ? registry : merged.data.extensions.chromaticHub);
    });
    const deps = {
      getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }),
      checkEditorSafety: () => ({ safe: true }), // minimal legacy stub
      getContext: () => ({ characterId: 0, avatar, chatId: 'chat_001' }),
      expectedContext: { characterId: 0, avatar, chatId: 'chat_001' },
      fetch: fetchFn,
    };

    const ok = await mutateCard(owner, { type: 'add', character: { name: 'Bob' } }, { status: 'VALID', value: registry }, deps);
    assert.equal(ok.ok, true);

    const unsafe = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Bob' } },
      { status: 'VALID', value: registry },
      { ...deps, checkEditorSafety: () => ({ safe: false, reason: 'POPUP_OPEN' }) },
    );
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.code, 'WRITE_REJECTED');

    const throwing = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Bob' } },
      { status: 'VALID', value: registry },
      { ...deps, checkEditorSafety: () => { throw new Error('DOM query error'); } },
    );
    assert.equal(throwing.ok, false);
    assert.equal(throwing.code, 'WRITE_REJECTED');
  });
});
