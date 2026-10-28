/**
 * SillyTavern-ChromaticHub: Deny-Only Editor-Safety Adapter (H01-B3-B)
 *
 * createSillyTavernEditorSafetyAdapter({ probes }) returns a checkEditorSafety(owner)
 * function that is UNCONDITIONALLY deny-only: every invocation returns
 * { safe: false } with reason EDITOR_SAFETY_NOT_CERTIFIABLE, regardless of
 * what the injected probes report.
 *
 * There is no configuration option, exported override, or alternative
 * execution path that can make this adapter authorize a runtime write.
 * Probes are consulted only to produce sanitized refusal diagnostics; they
 * can never influence the safety verdict. (The former `posture` option is
 * rejected at construction.)
 *
 * Probes must be synchronous and network-free by contract. All probe
 * property access, invocation, and result inspection are guarded so that
 * hostile probes cannot leak exception details or card contents, and a
 * Promise returned by a probe is never treated as a valid observation.
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

function isThenable(val) {
  return (
    val !== null &&
    (typeof val === 'object' || typeof val === 'function') &&
    typeof safeGet(val, 'then') === 'function'
  );
}

function isValidAvatarString(avatar) {
  return (
    typeof avatar === 'string' &&
    avatar.trim().length > 0 &&
    !avatar.includes('/') &&
    !avatar.includes('\\') &&
    !CONTROL_CHARS_REGEX.test(avatar) &&
    PNG_EXTENSION_REGEX.test(avatar) &&
    avatar.slice(0, -4).trim().length > 0
  );
}

function refusable() {
  // Enum values only; never probe payloads, exception text, or DOM strings.
  return { status: 'unknown' };
}

/**
 * Creates an unconditionally deny-only editor-safety checker.
 *
 * @param {object} options - { probes } with one synchronous probe per
 *   observation field. Unknown option keys (including "posture") throw.
 * @returns {{ checkEditorSafety: (owner: object) => object }}
 */
export function createSillyTavernEditorSafetyAdapter(options) {
  if (!isPlainObject(options) || Object.prototype.hasOwnProperty.call(options, '__proto__')) {
    throw new Error('Adapter options must be a plain object with a single "probes" key');
  }

  const optionKeys = Object.keys(options);
  if (optionKeys.length !== 1 || optionKeys[0] !== 'probes') {
    throw new Error('Unknown adapter option; only { probes } is accepted');
  }

  const probes = options.probes;
  if (!isPlainObject(probes) || Object.prototype.hasOwnProperty.call(probes, '__proto__')) {
    throw new Error('options.probes must be a plain object');
  }

  for (const name of Object.keys(probes)) {
    if (!PROBE_NAMES.includes(name)) {
      throw new Error(`Unknown probe name: ${JSON.stringify(name)}`);
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
    if (safeGet(owner, 'kind') !== 'installed-card') {
      return { ownerValid: false, avatar: null };
    }
    const avatar = safeGet(owner, 'avatar');
    if (!isValidAvatarString(avatar)) {
      return { ownerValid: false, avatar: null };
    }
    return { ownerValid: true, avatar };
  }

  function runProbe(probesObj, name) {
    // Guards: hostile property access, invocation, inspection, thenables.
    const fn = safeGet(probesObj, name);
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
      const raw = runProbe(probes, name);
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

  return {
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
  };
}
