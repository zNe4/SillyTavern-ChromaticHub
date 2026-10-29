/**
 * SillyTavern-ChromaticHub: Deny-Only Editor-Safety Adapter (H01-B3-B / R1 / R2 / R3 / R4)
 *
 * createSillyTavernEditorSafetyAdapter({ probes }) returns a frozen adapter
 * whose checkEditorSafety(owner) is UNCONDITIONALLY deny-only: every
 * invocation returns { safe: false } with reason
 * EDITOR_SAFETY_NOT_CERTIFIABLE, regardless of what the injected probes
 * report.
 *
 * There is no configuration option, exported override, or alternative
 * execution path that can make this adapter authorize a runtime write.
 * Probes are consulted only to produce sanitized refusal diagnostics; they
 * can never influence the safety verdict. (The former `posture` option is
 * rejected at construction.)
 *
 * Probes must be synchronous and network-free by contract. All probe
 * property access, invocation, and result inspection are guarded so that
 * hostile probes cannot leak exception details or card contents. A Promise
 * returned by a probe is detected and refused synchronously; it is never
 * awaited and never treated as a valid observation.
 *
 * Unhandled-rejection suppression (R3-F2/R4-F2) covers ORDINARY native
 * promises of this realm only: receivers whose [[Prototype]] is the
 * intrinsic Promise.prototype, with no own "constructor" property, AND
 * only while the global Promise intrinsics that SpeciesConstructor
 * consults (Promise.prototype.constructor, Promise[Symbol.species])
 * remain byte-identical to their module-load descriptors. For that
 * narrowed receiver, the intrinsic Promise.prototype.then attaches
 * no-op handlers through engine data without reading the receiver's own
 * "then", "constructor", or Symbol.species surfaces, and without
 * consulting any spoofable tag. Subclass instances, custom species,
 * cross-realm promises, proxies, receivers carrying an own
 * "constructor", and ANY modified global Promise intrinsic are
 * explicitly NOT suppressed; suppressing them is impossible without
 * executing user-controlled hooks, so their rejections are left to the
 * host. All suppression-path exceptions are contained.
 *
 * Constructor failures (R3-F1/R4-F1) are fully contained: prototype
 * inspection, property access, own-key enumeration, hasOwnProperty
 * descriptor lookups, revoked proxies, and applicable proxy traps are
 * guarded or bounded by a top-level validation catch, and every thrown
 * diagnostic is a fixed message that never interpolates property names
 * or exception contents.
 */

import { evaluateEditorSafety, EDITOR_SAFETY_REASONS } from './editor-safety.mjs';

export const EDITOR_SAFETY_NOT_CERTIFIABLE = 'EDITOR_SAFETY_NOT_CERTIFIABLE';

const PNG_EXTENSION_REGEX = /\.[pP][nN][gG]$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;

const PROBE_NAMES = Object.freeze([
  'editorVisible',
  'editorDirty',
  'saveScheduled',
  'saveInFlight',
  'hiddenJsonConflicts',
  'activeCardAvatar',
  'externalWriterSuspected',
]);

// R4-F1: hasOwnProperty on a hostile receiver reads its
// getOwnPropertyDescriptor trap (or dies on a revoked proxy). Guarded:
// trap-throw and revoked receivers both report "has own", and the
// subsequent strict validation rejects them with controlled errors.
function safeHasOwnProp(obj, key) {
  try {
    return Object.prototype.hasOwnProperty.call(obj, key);
  } catch (_err) {
    return true;
  }
}

function isPlainObject(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  let proto;
  try {
    proto = Object.getPrototypeOf(val);
  } catch (_err) {
    // Hostile getPrototypeOf trap (R3-F1): fail closed, no leak.
    return false;
  }
  return proto === Object.prototype || proto === null;
}

// Guarded prototype lookup used for the ordinary-promise precheck (R3-F2).
// Returns null on any failure or trap; callers treat null as unsupported.
function safeGetPrototypeOf(val) {
  try {
    return Object.getPrototypeOf(val);
  } catch (_err) {
    return null;
  }
}

// Guarded own-property lookup used for the ordinary-promise precheck
// (R3-F2). Returns the sentinel on any failure or trap.
const LOOKUP_FAILED = Symbol('adapterLookupFailed');
function safeLookupOwn(obj, key) {
  try {
    return Object.getOwnPropertyDescriptor(obj, key);
  } catch (_err) {
    return LOOKUP_FAILED;
  }
}

function safeGet(obj, key) {
  try {
    return obj[key];
  } catch (_err) {
    return { __throwingAccessor: true };
  }
}

// Thenable detection reads the property once, guarded; no handler is
// invoked, so no arbitrary thenable code runs and no rejection hook is
// installed on a native Promise.
function isThenable(val) {
  return (
    val !== null &&
    (typeof val === 'object' || typeof val === 'function') &&
    typeof safeGet(val, 'then') === 'function'
  );
}

// Intrinsic then, captured at module load. Invoked with .call(), never
// through a looked-up property, so the receiver's own "then" — genuine,
// overridden, or hostile — is never consulted during suppression.
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;

// R4-F2: snapshot of the global Promise intrinsics that SpeciesConstructor
// consults, taken at module load. If either descriptor changes at runtime
// (Promise.prototype.constructor or Promise[Symbol.species] reassigned or
// reconfigured), suppression is disabled globally: the modified chain can
// no longer be assumed engine-owned, and we refuse to run it. Own-ness of
// both properties is part of the snapshot: moving the property to the
// prototype chain (deleting an own data property) changes lookup behavior
// in ways the snapshot comparison catches.
const PROMISE_INTRINSIC_SNAPSHOT = Object.freeze(
  snapshotPromiseIntrinsics('module-load'),
);

function snapshotPromiseIntrinsics() {
  const freezeDescriptor = (obj, key) => {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(obj, key);
    } catch (_err) {
      return null;
    }
    if (descriptor === undefined) {
      return null;
    }
    return Object.freeze({
      ...descriptor,
      value: descriptor.get === undefined ? descriptor.value : undefined,
    });
  };
  return Object.freeze({
    protoConstructor: freezeDescriptor(Promise.prototype, 'constructor'),
    species: freezeDescriptor(Promise, Symbol.species),
  });
}

// True only while both consulted intrinsics are byte-identical to the
// module-load snapshot (value/writability/enumerability/configurability
// and accessor shape). Any drift disables suppression entirely.
function promiseIntrinsicsArePristine() {
  const current = snapshotPromiseIntrinsics();
  const same = (a, b) => {
    if (a === b) {
      return true;
    }
    if (!a || !b) {
      return false;
    }
    return (
      a.value === b.value &&
      a.writable === b.writable &&
      a.enumerable === b.enumerable &&
      a.configurable === b.configurable &&
      a.get === b.get &&
      a.set === b.set
    );
  };
  return (
    same(current.protoConstructor, PROMISE_INTRINSIC_SNAPSHOT.protoConstructor) &&
    same(current.species, PROMISE_INTRINSIC_SNAPSHOT.species)
  );
}

// Ordinary-promise support boundary (R3-F2/R4-F2): exactly the receiver
// shape whose species chain is engine-owned data and therefore runs no
// user-controlled code inside Promise.prototype.then, AND only while the
// consulted global intrinsics remain identical to the module-load
// snapshot. Everything else (subclasses, custom species, cross-realm,
// proxies, own "constructor", modified global intrinsics) is deliberately
// unsupported — see suppressNativePromiseRejection.
const IS_ORDINARY_PROMISE_RECEIVER = (value) => {
  if (safeGetPrototypeOf(value) !== Promise.prototype) {
    return false;
  }
  // Own "constructor" would be read by SpeciesConstructor (user hook).
  const ownCtor = safeLookupOwn(value, 'constructor');
  if (ownCtor !== undefined) {
    return false;
  }
  // R4-F2: a modified Promise.prototype.constructor or
  // Promise[Symbol.species] means SpeciesConstructor would execute
  // user-controlled code even for an unmodified ordinary receiver.
  if (!promiseIntrinsicsArePristine()) {
    return false;
  }
  return true;
};

/**
 * Suppresses unhandled-rejection fallout for ordinary native promises of
 * this realm only (R3-F2/R4-F2). Supported receiver: [[Prototype]] is the
 * intrinsic Promise.prototype, no own "constructor" property, and the
 * global Promise intrinsics SpeciesConstructor consults are identical to
 * the module-load snapshot. For that receiver, SpeciesConstructor
 * resolves to Promise[Symbol.species] without reading any
 * receiver-controlled value, and Promise.prototype.then:
 * - gates on the unspoofable IsPromise internal-slot check;
 * - never reads the receiver's own "then" (overridden/throwing/absent);
 * - consults no spoofable tag (Symbol.toStringTag is irrelevant);
 * - attaches BOTH no-op handlers, so the settled value is never passed
 *   through and never assimilates a hostile thenable fulfillment value.
 *
 * Deliberate limitation, not a missed case: subclass instances, custom
 * species, cross-realm promises, proxies, receivers with an own
 * "constructor", and any state where Promise.prototype.constructor or
 * Promise[Symbol.species] has been modified are NOT suppressed, because
 * suppressing them requires executing user-controlled
 * constructor/species hooks. Their rejections are left to the host
 * process. The adapter never relies on suppression: every decision
 * remains safe: false regardless, and no diagnostic reflects any
 * suppression-path exception.
 */
function suppressNativePromiseRejection(value) {
  if (!IS_ORDINARY_PROMISE_RECEIVER(value)) {
    return;
  }
  try {
    INTRINSIC_PROMISE_THEN.call(value, suppressRejection, suppressRejection);
  } catch (_err) {
    // Contained; the observation is refused regardless.
  }
}
function suppressRejection() {
  // Intentionally empty: fulfillment and rejection are both discarded.
}

/**
 * Own-property key inventory (string names AND symbols). Returns null when
 * enumeration throws (e.g., a hostile proxy trap); callers treat null as
 * a strict-shape failure.
 */
function safeOwnKeysAll(obj) {
  try {
    return [...Object.getOwnPropertyNames(obj), ...Object.getOwnPropertySymbols(obj)];
  } catch (_err) {
    return null;
  }
}

/**
 * Installed-card locator restrictions matching the mutation controller's
 * validateOwner contract (including "." and ".." avatar stems).
 */
function isValidOwnerAvatar(avatar) {
  if (typeof avatar !== 'string') {
    return false;
  }
  if (avatar.trim().length === 0) {
    return false;
  }
  if (avatar.includes('/') || avatar.includes('\\')) {
    return false;
  }
  if (CONTROL_CHARS_REGEX.test(avatar)) {
    return false;
  }
  if (!PNG_EXTENSION_REGEX.test(avatar)) {
    return false;
  }
  const stem = avatar.slice(0, -4);
  if (stem.length === 0 || stem === '.' || stem === '..' || stem.trim().length === 0) {
    return false;
  }
  return true;
}

// Controlled diagnostics: fixed messages; unknown property names and
// untrusted values are never interpolated into constructor errors.
function refusable() {
  // Enum values only; never probe payloads, exception text, or DOM strings.
  return { status: 'unknown' };
}

// Options shape: exactly one permitted own key, "probes". Symbol keys,
// non-enumerable extras, and enumeration traps all throw with controlled
// messages that never echo property names or exception contents (R2-F1).
const OPTIONS_ALLOWED_KEYS = Object.freeze(['probes']);

function keysAreExactlyAllowed(keys, allowed) {
  if (keys === null || keys.length !== allowed.length) {
    return false;
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      return false;
    }
  }
  return true;
}

// R3-F1: guarded own-descriptor lookup for the options "probes" access.
// A throwing accessor (or proxy trap) yields LOOKUP_FAILED, which is
// converted into a controlled throw — never a raw exception leak.
function safeReadProbesOption(options) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(options, 'probes');
  } catch (_err) {
    return LOOKUP_FAILED;
  }
  if (descriptor === undefined) {
    return undefined;
  }
  if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
    let value;
    try {
      value = descriptor.get.call(options);
    } catch (_err) {
      return LOOKUP_FAILED;
    }
    return { value };
  }
  return { value: descriptor.value };
}

/**
 * Creates an unconditionally deny-only editor-safety checker.
 *
 * Every synchronous failure during construction — hostile prototype,
 * descriptor, hasOwnProperty, or enumeration traps, revoked proxies,
 * throwing accessors — is converted to a controlled error with a fixed
 * message (R3-F1/R4-F1). Raw exception contents and property names are
 * never exposed.
 *
 * @param {object} options - { probes } with one synchronous probe per
 *   observation field. Unknown option keys (including "posture") throw
 *   with controlled messages.
 * @returns {Readonly<{ checkEditorSafety: (owner: object) => object }>} frozen adapter
 */
export function createSillyTavernEditorSafetyAdapter(options) {
  // R4-F1 bounded catch: any residual trap/proxy failure escaping the
  // guarded helpers below becomes a single fixed diagnostic. Successful
  // ordinary construction is unaffected.
  try {
    return validateAndCreateAdapter(options);
  } catch (_err) {
    throw new Error('Adapter construction failed validation');
  }
}

function validateAndCreateAdapter(options) {
  if (!isPlainObject(options) || safeHasOwnProp(options, '__proto__')) {
    throw new Error('Adapter options must be a plain object with a single "probes" key');
  }

  if (!keysAreExactlyAllowed(safeOwnKeysAll(options), OPTIONS_ALLOWED_KEYS)) {
    throw new Error('Unknown adapter option; only { probes } is accepted');
  }

  // R3-F1: guarded access to the "probes" value; accessor or trap throws
  // are converted to a controlled failure.
  const probesEntry = safeReadProbesOption(options);
  if (probesEntry === LOOKUP_FAILED) {
    throw new Error('Adapter options could not be inspected');
  }
  const probes = probesEntry === undefined ? undefined : probesEntry.value;
  if (!isPlainObject(probes) || safeHasOwnProp(probes, '__proto__')) {
    throw new Error('options.probes must be a plain object');
  }

  // Only probe names are permitted; any other own key (string or symbol)
  // throws, without echoing the key's name in the message. Enumeration is
  // guarded: a throwing ownKeys trap rejects the probes object outright.
  const probeKeys = safeOwnKeysAll(probes);
  if (probeKeys === null) {
    throw new Error('Adapter probes keys could not be inspected');
  }
  for (const key of probeKeys) {
    if (typeof key !== 'string' || !PROBE_NAMES.includes(key)) {
      throw new Error('Unknown probe name in options.probes');
    }
  }

  const denyDecisionFrom = (observedReasons) =>
    Object.freeze({
      safe: false,
      reason: EDITOR_SAFETY_NOT_CERTIFIABLE,
      message: 'Runtime editor safety cannot be certified; mutation refused',
      details: Object.freeze({
        observedReasons: Object.freeze([...observedReasons]),
      }),
    });

  function collectOwner(owner) {
    if (!isPlainObject(owner) || safeHasOwnProp(owner, '__proto__')) {
      return { ownerValid: false, avatar: null };
    }
    if (!safeGet(owner, 'kind') || safeGet(owner, 'kind') !== 'installed-card') {
      return { ownerValid: false, avatar: null };
    }
    const avatar = safeGet(owner, 'avatar');
    if (!isValidOwnerAvatar(avatar)) {
      return { ownerValid: false, avatar: null };
    }
    return { ownerValid: true, avatar };
  }

  function runProbe(name) {
    // Guards: hostile property access, invocation, inspection, thenables.
    const fn = safeGet(probes, name);
    if (typeof fn !== 'function') {
      return refusable();
    }
    let raw;
    try {
      raw = fn();
    } catch (_err) {
      return refusable();
    }
    if (raw === undefined) {
      return refusable();
    }
    if (raw !== null && (typeof raw === 'object' || typeof raw === 'function')) {
      // R2-F2/R3-F2: attempt rejection suppression for every object-shaped
      // result. The ordinary-promise precheck reads only prototype and
      // own-descriptor data (guarded); the engine's IsPromise gate throws
      // for non-promises before any further receiver property is read, so
      // arbitrary objects are never touched. This covers genuine promises
      // whose own "then" is hostile or absent, which thenable detection
      // alone cannot classify. Unsupported exotic receivers are skipped
      // by design; see suppressNativePromiseRejection.
      suppressNativePromiseRejection(raw);
    }
    if (isThenable(raw)) {
      return refusable();
    }
    return raw;
  }

  function buildObservations(ownerInfo) {
    const observations = {
      schemaVersion: 1,
      owner: { kind: 'installed-card', avatar: ownerInfo.avatar },
    };
    if (!ownerInfo.ownerValid) {
      // Invalid owner: refuse immediately without consulting any probe.
      for (const name of PROBE_NAMES) {
        observations[name] = refusable();
      }
      return observations;
    }
    for (const name of PROBE_NAMES) {
      const raw = runProbe(name);
      let observation;
      if (name === 'activeCardAvatar') {
        observation =
          raw === null || typeof raw === 'string'
            ? { status: 'ok', value: raw }
            : refusable();
      } else {
        observation =
          typeof raw === 'boolean' ? { status: 'ok', value: raw } : refusable();
      }
      observations[name] = observation;
    }
    return observations;
  }

  // The adapter object is frozen so checkEditorSafety cannot be replaced.
  return Object.freeze({
    checkEditorSafety(owner) {
      let ownerInfo;
      try {
        ownerInfo = collectOwner(owner);
      } catch (_err) {
        ownerInfo = { ownerValid: false, avatar: null };
      }

      const observations = buildObservations(ownerInfo);

      // Pure evaluator is consulted ONLY for sanitized refusal diagnostics.
      // Its verdict is discarded: the adapter decision is always a refusal.
      const evaluation = evaluateEditorSafety(observations);
      const observedReasons = [];
      if (evaluation !== null && typeof evaluation === 'object' && evaluation.safe !== true) {
        const reason = safeGet(evaluation, 'reason');
        if (
          typeof reason === 'string' &&
          Object.prototype.hasOwnProperty.call(EDITOR_SAFETY_REASONS, reason)
        ) {
          observedReasons.push(reason);
        }
      }

      return denyDecisionFrom(observedReasons);
    },
  });
}
