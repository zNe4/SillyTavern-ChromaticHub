/**
 * SillyTavern-ChromaticHub: Pure Editor-Safety Evaluator (H01-B3-B)
 *
 * Evaluates a strict, explicit set of editor-safety observations and decides
 * whether a card mutation could proceed. This module is pure: no DOM, no
 * network, no timers, no imports.
 *
 * `safe: true` is a statement about the supplied synthetic facts ONLY.
 * Nothing here claims that any runtime can produce such facts, and no
 * probe- or user-supplied boolean proves native editor safety. The runtime
 * adapter (sillytavern-editor-safety-adapter.mjs) is unconditionally
 * deny-only and never consults this module for authorization.
 */

const PNG_EXTENSION_REGEX = /\.[pP][nN][gG]$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;

export const EDITOR_SAFETY_REASONS = Object.freeze({
  INVALID_OBSERVATIONS: 'INVALID_OBSERVATIONS',
  MISSING_OBSERVATION: 'MISSING_OBSERVATION',
  UNKNOWN_OBSERVATION: 'UNKNOWN_OBSERVATION',
  EDITOR_OPEN: 'EDITOR_OPEN',
  EDITOR_DIRTY: 'EDITOR_DIRTY',
  SAVE_PENDING: 'SAVE_PENDING',
  SAVE_IN_FLIGHT: 'SAVE_IN_FLIGHT',
  HIDDEN_JSON_STALE: 'HIDDEN_JSON_STALE',
  ACTIVE_CARD_MISMATCH: 'ACTIVE_CARD_MISMATCH',
  EXTERNAL_WRITER_SUSPECTED: 'EXTERNAL_WRITER_SUSPECTED',
});

const OBSERVATION_FIELDS = Object.freeze([
  'editorVisible',
  'editorDirty',
  'saveScheduled',
  'saveInFlight',
  'hiddenJsonConflicts',
  'activeCardAvatar',
  'externalWriterSuspected',
]);

// Danger precedence order follows OBSERVATION_FIELDS order exactly.
const BOOLEAN_FIELDS = Object.freeze([
  'editorVisible',
  'editorDirty',
  'saveScheduled',
  'saveInFlight',
  'hiddenJsonConflicts',
  'externalWriterSuspected',
]);

const DANGER_REASON_BY_FIELD = Object.freeze({
  editorVisible: EDITOR_SAFETY_REASONS.EDITOR_OPEN,
  editorDirty: EDITOR_SAFETY_REASONS.EDITOR_DIRTY,
  saveScheduled: EDITOR_SAFETY_REASONS.SAVE_PENDING,
  saveInFlight: EDITOR_SAFETY_REASONS.SAVE_IN_FLIGHT,
  hiddenJsonConflicts: EDITOR_SAFETY_REASONS.HIDDEN_JSON_STALE,
  externalWriterSuspected: EDITOR_SAFETY_REASONS.EXTERNAL_WRITER_SUSPECTED,
});

function isPlainObject(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function isThenable(val) {
  return (
    val !== null &&
    (typeof val === 'object' || typeof val === 'function') &&
    typeof val.then === 'function'
  );
}

function safeHasOwn(obj, key) {
  try {
    return Object.prototype.hasOwnProperty.call(obj, key);
  } catch (_err) {
    return false;
  }
}

function safeGet(obj, key) {
  try {
    return obj[key];
  } catch (_err) {
    return { __throwingGetter: true };
  }
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

function invalid(message, field) {
  const result = {
    safe: false,
    reason: EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS,
    message,
  };
  if (field !== undefined) {
    result.details = Object.freeze({ field });
  }
  return Object.freeze(result);
}

function fieldFailure(reason, field, message) {
  return Object.freeze({
    safe: false,
    reason,
    message,
    details: Object.freeze({ field }),
  });
}

function danger(reason, field) {
  return Object.freeze({
    safe: false,
    reason,
    message: `Refused by editor-safety observation: ${field}`,
    details: Object.freeze({ field }),
  });
}

/**
 * Validates the observations envelope and evaluates the editor-safety decision.
 *
 * @param {object} observations - Strict observation envelope (schemaVersion: 1,
 *   owner echo, and every required observation field).
 * @returns {object} Frozen decision: { safe: true } only when every synthetic
 *   observation is complete, valid, and clean; otherwise { safe: false, ... }.
 */
export function evaluateEditorSafety(observations) {
  try {
    return evaluateEditorSafetyInner(observations);
  } catch (_err) {
    return invalid('Observation evaluation failed unexpectedly');
  }
}

function evaluateEditorSafetyInner(observations) {
  if (!isPlainObject(observations) || safeHasOwn(observations, '__proto__')) {
    return invalid('observations must be a plain object');
  }

  if (safeHasOwn(observations, 'posture')) {
    return invalid('observations must not contain a posture field');
  }

  if (safeGet(observations, 'schemaVersion') !== 1) {
    return invalid('observations.schemaVersion must be exactly 1');
  }

  const owner = safeGet(observations, 'owner');
  if (!isPlainObject(owner) || safeHasOwn(owner, '__proto__')) {
    return invalid('observations.owner must be a plain object');
  }
  if (safeGet(owner, 'kind') !== 'installed-card') {
    return invalid('observations.owner.kind must be "installed-card"');
  }
  const ownerAvatar = safeGet(owner, 'avatar');
  if (!isValidAvatarString(ownerAvatar)) {
    return invalid('observations.owner.avatar must be a valid PNG card avatar');
  }

  for (const key of Object.keys(observations)) {
    if (key !== 'schemaVersion' && key !== 'owner' && !OBSERVATION_FIELDS.includes(key)) {
      return invalid(`Unknown observation key: ${JSON.stringify(key)}`);
    }
  }

  const values = {};

  // Availability & type validation in fixed field order.
  for (const field of OBSERVATION_FIELDS) {
    if (!safeHasOwn(observations, field)) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.MISSING_OBSERVATION,
        field,
        `Required observation missing: ${field}`,
      );
    }

    const observation = safeGet(observations, field);
    if (observation === null || typeof observation !== 'object' || isThenable(observation)) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation must be a plain object: ${field}`,
      );
    }
    if (!isPlainObject(observation)) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation must be a plain object: ${field}`,
      );
    }

    const status = safeGet(observation, 'status');
    if (status === 'missing') {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.MISSING_OBSERVATION,
        field,
        `Observation reported as missing: ${field}`,
      );
    }
    if (status !== 'ok') {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation status must be "ok" or "missing": ${field}`,
      );
    }

    const value = safeGet(observation, 'value');
    if (isThenable(value)) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation value must not be a thenable or Promise: ${field}`,
      );
    }

    if (field === 'activeCardAvatar') {
      if (value !== null && typeof value !== 'string') {
        return fieldFailure(
          EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
          field,
          'activeCardAvatar value must be a string or null',
        );
      }
    } else {
      if (typeof value !== 'boolean') {
        return fieldFailure(
          EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
          field,
          `Observation value must be a real boolean: ${field}`,
        );
      }
    }

    values[field] = value;
  }

  // Danger evaluation in fixed precedence order.
  for (const field of BOOLEAN_FIELDS) {
    if (values[field] === true) {
      return danger(DANGER_REASON_BY_FIELD[field], field);
    }
  }

  if (values.activeCardAvatar === null || values.activeCardAvatar !== ownerAvatar) {
    return Object.freeze({
      safe: false,
      reason: EDITOR_SAFETY_REASONS.ACTIVE_CARD_MISMATCH,
      message: 'Active card avatar does not match the target owner avatar',
      details: Object.freeze({ field: 'activeCardAvatar' }),
    });
  }

  return Object.freeze({ safe: true });
}
