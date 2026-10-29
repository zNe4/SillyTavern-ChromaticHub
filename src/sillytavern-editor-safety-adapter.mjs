/**
 * SillyTavern-ChromaticHub: Deny-Only Editor-Safety Adapter (H01-B3-B / R1 / R2)
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
 * awaited and never treated as a valid observation. To keep a rejected
 * genuine native Promise from surfacing later as an unhandled process
 * rejection, the intrinsic Promise.prototype.then is invoked with two
 * no-op handlers: the engine gates that call behind an unspoofable
 * internal-slot (IsPromise) check, and it never looks up — and therefore
 * never invokes — the receiver's own "then", nor Symbol.toStringTag. Fake
 * promises and arbitrary thenables are never touched; exceptions during
 * suppression are fully contained (R2-F2).
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

function isPlainObject(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
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

/**
 * Suppresses unhandled-rejection fallout for genuine native promises only
 * (R2-F2). The engine gates Promise.prototype.then behind an unspoofable
 * internal-slot check (IsPromise: [[PromiseState]]); a fake promise or an
 * arbitrary thenable throws TypeError from that check BEFORE any property
 * of the receiver is read, so hostile code never runs. Symbol.toStringTag
 * is not consulted and cannot spoof identity. The receiver's own "then"
 * (overridden, throwing, or absent) is never looked up. Both handlers must
 * be the no-op: passing undefined as onFulfilled would let the settled
 * value pass through and would assimilate a hostile thenable fulfillment
 * value by invoking its "then".
 *
 * Species analysis: the derived promise is constructed through the
 * receiver's constructor/Symbol.species chain. For ordinary native
 * promises (Promise.reject/resolve results, async-function returns),
 * subclasses that inherit the default species, and cross-realm promises,
 * that chain is genuine engine code and runs no probe-authored code. A
 * deliberately booby-trapped receiver (hostile own "constructor" or
 * species) can substitute its own constructor, executing code with
 * exactly the privileges the probe already had when it created the value;
 * every exception on that path is contained here, the verdict is never
 * consulted, and no diagnostic reflects it. The observation is refused
 * regardless.
 */
function suppressNativePromiseRejection(value) {
  try {
    INTRINSIC_PROMISE_THEN.call(value, suppressRejection, suppressRejection);
  } catch (_err) {
    // The observation is refused regardless.
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

/**
 * Creates an unconditionally deny-only editor-safety checker.
 *
 * @param {object} options - { probes } with one synchronous probe per
 *   observation field. Unknown option keys (including "posture") throw
 *   with controlled messages.
 * @returns {Readonly<{ checkEditorSafety: (owner: object) => object }>} frozen adapter
 */
export function createSillyTavernEditorSafetyAdapter(options) {
  if (!isPlainObject(options) || Object.prototype.hasOwnProperty.call(options, '__proto__')) {
    throw new Error('Adapter options must be a plain object with a single "probes" key');
  }

  if (!keysAreExactlyAllowed(safeOwnKeysAll(options), OPTIONS_ALLOWED_KEYS)) {
    throw new Error('Unknown adapter option; only { probes } is accepted');
  }

  const probes = options.probes;
  if (!isPlainObject(probes) || Object.prototype.hasOwnProperty.call(probes, '__proto__')) {
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
    if (!isPlainObject(owner) || Object.prototype.hasOwnProperty.call(owner, '__proto__')) {
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
      // R2-F2: attempt rejection suppression for every object-shaped result.
      // The engine's IsPromise gate throws for non-promises BEFORE any
      // property of the receiver is read, so arbitrary objects are never
      // touched. This also covers genuine promises whose own "then" is
      // hostile or absent, which thenable detection alone cannot classify.
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
