/**
 * SillyTavern-ChromaticHub: Pure Editor-Safety Evaluator (H01-B3-B / R1)
 *
 * Evaluates a strict, explicit set of editor-safety observations and decides
 * whether a card mutation could proceed. This module is pure: no DOM, no
 * network, no timers, no imports.
 *
 * R1 corrections enforced here:
 * - Own-property validation: inherited values never count as observations
 *   (envelope, owner, and nested status/value records are all own-checked).
 * - Strict shapes: unexpected own properties — including non-enumerable and
 *   symbol properties — are rejected on the envelope, owner, and records.
 * - Controlled diagnostics: error messages never interpolate unknown
 *   property names or untrusted values.
 * - Approved precedence: envelope → availability/types → editorVisible →
 *   editorDirty → saveScheduled → saveInFlight → hiddenJsonConflicts →
 *   activeCardMismatch → externalWriterSuspected → safe.
 * - Owner validation matches the mutation controller's installed-card
 *   locator restrictions (including "." and ".." avatar stems).
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

// Evaluation order for the observation fields.
const OBSERVATION_FIELDS = Object.freeze([
  'editorVisible',
  'editorDirty',
  'saveScheduled',
  'saveInFlight',
  'hiddenJsonConflicts',
  'activeCardAvatar',
  'externalWriterSuspected',
]);

const ENVELOPE_ALLOWED_KEYS = Object.freeze([
  'schemaVersion',
  'owner',
  ...OBSERVATION_FIELDS,
]);

const OWNER_ALLOWED_KEYS = Object.freeze(['kind', 'avatar']);
const RECORD_ALLOWED_KEYS = Object.freeze(['status', 'value']);

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
    typeof safeGet(val, 'then') === 'function'
  );
}

// Unique sentinel for property access that threw (hostile getter or proxy
// trap). Identity-compared only; never shape-inspected, so it can never be
// mistaken for a valid envelope, owner, or observation record.
const ACCESS_THROWING = Symbol('editorSafetyAccessThrowing');
const ACCESS_THREW = Object.freeze({ [ACCESS_THROWING]: true });

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
    return ACCESS_THREW;
  }
}

function accessThrew(val) {
  return val === ACCESS_THREW;
}

/**
 * Own-property key inventory (string names and symbols). Returns null when
 * inspection throws (e.g., a hostile proxy trap), which callers treat as a
 * strict-shape failure.
 */
function safeOwnKeysAll(obj) {
  try {
    return [...Object.getOwnPropertyNames(obj), ...Object.getOwnPropertySymbols(obj)];
  } catch (_err) {
    return null;
  }
}

/**
 * True only when every own key is a permitted string name. Any symbol key
 * or unexpected name (enumerable or not) fails the strict shape.
 */
function keysAreAllowed(keys, allowed) {
  if (keys === null) {
    return false;
  }
  for (const key of keys) {
    if (typeof key === 'symbol') {
      return false;
    }
    if (!allowed.includes(key)) {
      return false;
    }
  }
  return true;
}

/**
 * Installed-card locator restrictions, matching the mutation controller's
 * validateOwner contract exactly (including "." and ".." avatar stems).
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

// Controlled diagnostics: message strings are fixed or interpolate only
// internal field names drawn from OBSERVATION_FIELDS. Unknown property
// names and untrusted values are never interpolated.
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
 *   owner echo, and every required observation field; own properties only).
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
  // Phase 1: envelope validity.
  if (!isPlainObject(observations) || safeHasOwn(observations, '__proto__')) {
    return invalid('observations must be a plain object');
  }

  if (safeHasOwn(observations, 'posture')) {
    return invalid('observations must not contain a posture field');
  }

  if (!keysAreAllowed(safeOwnKeysAll(observations), ENVELOPE_ALLOWED_KEYS)) {
    return invalid('Observation envelope contains an unexpected own property');
  }

  if (!safeHasOwn(observations, 'schemaVersion')) {
    return invalid('observations.schemaVersion must be exactly 1');
  }
  const schemaVersion = safeGet(observations, 'schemaVersion');
  if (accessThrew(schemaVersion) || schemaVersion !== 1) {
    return invalid('observations.schemaVersion must be exactly 1');
  }

  if (!safeHasOwn(observations, 'owner')) {
    return invalid('observations.owner must be a plain object');
  }
  const owner = safeGet(observations, 'owner');
  if (
    accessThrew(owner) ||
    !isPlainObject(owner) ||
    safeHasOwn(owner, '__proto__')
  ) {
    return invalid('observations.owner must be a plain object');
  }
  if (!keysAreAllowed(safeOwnKeysAll(owner), OWNER_ALLOWED_KEYS)) {
    return invalid('Observation owner contains an unexpected own property');
  }
  if (!safeHasOwn(owner, 'kind')) {
    return invalid('observations.owner.kind must be "installed-card"');
  }
  const ownerKind = safeGet(owner, 'kind');
  if (accessThrew(ownerKind) || ownerKind !== 'installed-card') {
    return invalid('observations.owner.kind must be "installed-card"');
  }
  if (!safeHasOwn(owner, 'avatar')) {
    return invalid('observations.owner.avatar must be a valid installed-card avatar');
  }
  const ownerAvatar = safeGet(owner, 'avatar');
  if (accessThrew(ownerAvatar) || !isValidOwnerAvatar(ownerAvatar)) {
    return invalid('observations.owner.avatar must be a valid installed-card avatar');
  }

  // Phase 2: observation availability and types, in fixed field order.
  const values = {};
  for (const field of OBSERVATION_FIELDS) {
    if (!safeHasOwn(observations, field)) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.MISSING_OBSERVATION,
        field,
        `Required observation missing: ${field}`,
      );
    }

    const record = safeGet(observations, field);
    if (accessThrew(record)) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation could not be read: ${field}`,
      );
    }
    if (
      record === null ||
      typeof record !== 'object' ||
      isThenable(record) ||
      !isPlainObject(record)
    ) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation must be a plain object: ${field}`,
      );
    }

    // Strict record shape: only own "status" and "value" are permitted.
    // Inherited status/value (prototype lookup) cannot contribute.
    if (!keysAreAllowed(safeOwnKeysAll(record), RECORD_ALLOWED_KEYS)) {
      return invalid('Observation record contains an unexpected own property', field);
    }

    if (!safeHasOwn(record, 'status')) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.MISSING_OBSERVATION,
        field,
        `Observation status missing: ${field}`,
      );
    }
    const status = safeGet(record, 'status');
    if (accessThrew(status)) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation status could not be read: ${field}`,
      );
    }
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

    if (!safeHasOwn(record, 'value')) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation value missing: ${field}`,
      );
    }
    const value = safeGet(record, 'value');
    if (accessThrew(value)) {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation value could not be read: ${field}`,
      );
    }
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
    } else if (typeof value !== 'boolean') {
      return fieldFailure(
        EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION,
        field,
        `Observation value must be a real boolean: ${field}`,
      );
    }

    values[field] = value;
  }

  // Phases 3–9: approved danger precedence.
  if (values.editorVisible === true) {
    return danger(EDITOR_SAFETY_REASONS.EDITOR_OPEN, 'editorVisible');
  }
  if (values.editorDirty === true) {
    return danger(EDITOR_SAFETY_REASONS.EDITOR_DIRTY, 'editorDirty');
  }
  if (values.saveScheduled === true) {
    return danger(EDITOR_SAFETY_REASONS.SAVE_PENDING, 'saveScheduled');
  }
  if (values.saveInFlight === true) {
    return danger(EDITOR_SAFETY_REASONS.SAVE_IN_FLIGHT, 'saveInFlight');
  }
  if (values.hiddenJsonConflicts === true) {
    return danger(EDITOR_SAFETY_REASONS.HIDDEN_JSON_STALE, 'hiddenJsonConflicts');
  }
  if (values.activeCardAvatar === null || values.activeCardAvatar !== ownerAvatar) {
    return Object.freeze({
      safe: false,
      reason: EDITOR_SAFETY_REASONS.ACTIVE_CARD_MISMATCH,
      message: 'Active card avatar does not match the target owner avatar',
      details: Object.freeze({ field: 'activeCardAvatar' }),
    });
  }
  if (values.externalWriterSuspected === true) {
    return danger(EDITOR_SAFETY_REASONS.EXTERNAL_WRITER_SUSPECTED, 'externalWriterSuspected');
  }

  // Phase 10: complete and clean synthetic observations permit safe: true.
  return Object.freeze({ safe: true });
}
