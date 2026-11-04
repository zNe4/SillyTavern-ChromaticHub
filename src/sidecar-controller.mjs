/**
 * SillyTavern-ChromaticHub: Single-Process Per-User Sidecar Controller (H01-B3-D2-C2)
 *
 * Implements strict per-user FIFO queue mutual exclusion, fresh in-queue store scanning,
 * C0/C1 adaptation, total write-outcome classification, uncertainty quarantine,
 * minimal orphan recovery, and constant privacy-preserving diagnostics.
 *
 * Conforms to:
 * - ChromaticHub-H01-B3-D2-A-approved.md (Storage and API Contract)
 * - ChromaticHub-H01-B3-D2-B-approved.md (State Machine and Storage Controller Plan)
 * - ChromaticHub-H01-B3-D2-C2-implementation-plan.md (G1-R1 Approved Specification)
 * - Binding G2 Guardrails G2-A through G2-E (ChatGPT Independent Review 2026-11-02)
 * - G4-R1 Independent Review Corrections (Findings A, B, C, D 2026-11-02)
 *
 * Invariants:
 * - Zero SillyTavern card PNG mutations, editor updates, or HTTP network calls.
 * - Single-process, per-user FIFO queue serialization across all avatars and cards.
 * - Immutable local primitive snapshot capture of context roots before queue entry.
 * - Single write-dispatched uncertainty boundary: all post-dispatch throws/malformed responses are WRITE_UNCERTAIN.
 * - In-memory quarantine blocks mutating operations; diagnostic reads remain read-only.
 * - Constant static error messages and allowlisted diagnostic reasons (zero secret/avatar leakage).
 * - Dependency-free ES module.
 */

import path from 'node:path';
import crypto from 'node:crypto';

import {
  parseSidecarState,
  classifyAssociations,
  planCreateSidecar,
  planMutateSidecar,
  planRebindSidecar,
  planCloneSidecar,
  serializeSidecarState,
  SIDECAR_ERROR_CODES,
} from './sidecar-state.mjs';

import {
  isValidAvatar,
  FILE_STORE_ERROR_CODES,
  DIAGNOSTIC_REASONS,
} from './sidecar-file-store.mjs';

// --- Constants & RegExps ---

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;

const ALLOWED_C1_DIAGNOSTIC_REASONS = Object.freeze(new Set(Object.values(DIAGNOSTIC_REASONS)));

const COMMIT_UNCERTAIN_REASONS = Object.freeze(new Set([
  DIAGNOSTIC_REASONS.RENAME_FAILED,
  DIAGNOSTIC_REASONS.DIRSYNC_FAILED,
  DIAGNOSTIC_REASONS.READBACK_FAILED,
  DIAGNOSTIC_REASONS.READBACK_MISMATCH,
  DIAGNOSTIC_REASONS.FAULT_INJECTED_POST_RENAME,
]));

export const CONTROLLER_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_CONTEXT: 'INVALID_CONTEXT',
  INVALID_AVATAR: 'INVALID_AVATAR',
  INVALID_CARD_ID: 'INVALID_CARD_ID',
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  STATE_NOT_FOUND: 'STATE_NOT_FOUND',
  ALREADY_BOUND: 'ALREADY_BOUND',
  ASSOCIATION_CONFLICT: 'ASSOCIATION_CONFLICT',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  STALE_CARD_LOCATOR: 'STALE_CARD_LOCATOR',
  DUPLICATE_NOT_RENAME: 'DUPLICATE_NOT_RENAME',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  WRITE_FAILED: 'WRITE_FAILED',
  WRITE_UNCERTAIN: 'WRITE_UNCERTAIN',
  OPERATION_CANCELLED: 'OPERATION_CANCELLED',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  BYTE_LIMIT_EXCEEDED: 'BYTE_LIMIT_EXCEEDED',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
});

export const CONTROLLER_DIAGNOSTIC_REASONS = Object.freeze({
  QUARANTINE_ACTIVE: 'QUARANTINE_ACTIVE',
  UNHANDLED_WRITE_ERROR: 'UNHANDLED_WRITE_ERROR',
  MALFORMED_WRITE_RESULT: 'MALFORMED_WRITE_RESULT',
  READBACK_FAILED: 'READBACK_FAILED',
  READBACK_MISMATCH: 'READBACK_MISMATCH',
  CAS_MISMATCH: 'CAS_MISMATCH',
  INCOMPLETE_STORE: 'INCOMPLETE_STORE',
  OPERATION_CANCELLED: 'OPERATION_CANCELLED',
  INVALID_PARAMETERS: 'INVALID_PARAMETERS',
  INVALID_CONTEXT_PATH: 'INVALID_CONTEXT_PATH',
  TARGET_ALREADY_BOUND: 'TARGET_ALREADY_BOUND',
  ASSOCIATION_CONFLICT: 'ASSOCIATION_CONFLICT',
  DUPLICATE_NOT_RENAME: 'DUPLICATE_NOT_RENAME',
  STALE_LOCATOR: 'STALE_LOCATOR',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  IO_ERROR: 'IO_ERROR',
  TARGET_FILE_MISSING: 'TARGET_FILE_MISSING',
});

const STATIC_ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Invalid request parameters',
  INVALID_CONTEXT: 'Invalid context directories',
  INVALID_AVATAR: 'Invalid avatar filename',
  INVALID_CARD_ID: 'Invalid cardId UUID v4',
  CARD_NOT_FOUND: 'Target avatar file not found',
  STATE_NOT_FOUND: 'Sidecar state not found',
  ALREADY_BOUND: 'Card avatar is already bound',
  ASSOCIATION_CONFLICT: 'Conflicting association claims detected',
  REVISION_CONFLICT: 'Storage revision conflict',
  STALE_CARD_LOCATOR: 'Stale card locator or missing claim',
  DUPLICATE_NOT_RENAME: 'Both old and new avatars exist; duplicate must use clone',
  STORAGE_UNAVAILABLE: 'Sidecar storage is unavailable',
  WRITE_FAILED: 'Sidecar write operation failed',
  WRITE_UNCERTAIN: 'Sidecar write outcome is uncertain',
  OPERATION_CANCELLED: 'Operation cancelled',
  INVALID_SCHEMA: 'Invalid sidecar schema',
  BYTE_LIMIT_EXCEEDED: 'Sidecar byte limit exceeded',
  UNSUPPORTED_VERSION: 'Unsupported schema version',
});

// --- Internal Helper Functions ---

function isPlainObject(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  try {
    const proto = Object.getPrototypeOf(val);
    return proto === Object.prototype || proto === null;
  } catch (_err) {
    return false;
  }
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  try {
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
      const val = obj[key];
      if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
  } catch (_err) {
    // Contain any freeze exceptions defensively
  }
  return obj;
}

function makeFailure(code, reason = null) {
  const message = STATIC_ERROR_MESSAGES[code] || 'Operation failed';
  const envelope = {
    ok: false,
    code,
    message,
    recoverable: code === CONTROLLER_ERROR_CODES.OPERATION_CANCELLED || code === CONTROLLER_ERROR_CODES.REVISION_CONFLICT,
  };
  if (reason) {
    envelope.details = { reason };
  }
  return Object.freeze(envelope);
}

/**
 * Validates context and captures immutable, local, primitive string snapshots of both roots.
 * Rejects raw '..' directory segments before any normalization (Finding D).
 * Defends against mutable context property tampering (Finding A).
 *
 * @param {unknown} context
 * @returns {Readonly<{ userRoot: string, charactersRoot: string }> | null}
 */
function extractValidContext(context) {
  if (!isPlainObject(context)) {
    return null;
  }
  let propNames;
  let propSymbols;
  try {
    propNames = Object.getOwnPropertyNames(context);
    propSymbols = Object.getOwnPropertySymbols(context);
  } catch (_err) {
    return null;
  }
  if (propSymbols.length > 0 || propNames.length !== 2) {
    return null;
  }
  if (!propNames.includes('userRoot') || !propNames.includes('charactersRoot')) {
    return null;
  }

  let capturedUserRoot = null;
  let capturedCharactersRoot = null;

  for (const key of ['userRoot', 'charactersRoot']) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(context, key);
    } catch (_err) {
      return null;
    }
    if (!desc || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
      return null;
    }
    const val = desc.value;
    if (typeof val !== 'string' || val.trim().length === 0) {
      return null;
    }
    if (CONTROL_CHARS_REGEX.test(val) || val.includes('\0')) {
      return null;
    }
    if (!path.isAbsolute(val)) {
      return null;
    }
    // Finding D: Reject raw directory components equal to '..' BEFORE any normalization
    const rawSegments = val.split(/[/\\]+/);
    if (rawSegments.includes('..')) {
      return null;
    }

    if (key === 'userRoot') {
      capturedUserRoot = path.resolve(val);
    } else {
      capturedCharactersRoot = path.resolve(val);
    }
  }

  if (capturedUserRoot === null || capturedCharactersRoot === null) {
    return null;
  }

  return Object.freeze({
    userRoot: capturedUserRoot,
    charactersRoot: capturedCharactersRoot,
  });
}

/**
 * Evaluates signal state at every checkpoint.
 * Returns failure envelope if aborted (OPERATION_CANCELLED) or if getter throws/is invalid (INVALID_REQUEST).
 * Conforms to Finding C.
 *
 * @param {unknown} signal
 * @returns {Readonly<object> | null}
 */
function evaluateSignal(signal) {
  if (signal === undefined || signal === null) {
    return null; // OK, no signal provided
  }
  if (typeof signal !== 'object') {
    return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
  }
  let aborted;
  try {
    aborted = signal.aborted;
  } catch (_err) {
    // Finding C: Throwing getter on signal.aborted must fail closed with INVALID_REQUEST
    return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
  }
  if (typeof aborted !== 'boolean') {
    return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
  }
  if (aborted === true) {
    return makeFailure(CONTROLLER_ERROR_CODES.OPERATION_CANCELLED, CONTROLLER_DIAGNOSTIC_REASONS.OPERATION_CANCELLED);
  }
  return null; // OK to proceed
}

function validateStrictObject(obj, allowedKeys) {
  if (!isPlainObject(obj)) {
    return false;
  }
  let propNames;
  let propSymbols;
  try {
    propNames = Object.getOwnPropertyNames(obj);
    propSymbols = Object.getOwnPropertySymbols(obj);
  } catch (_err) {
    return false;
  }
  if (propSymbols.length > 0) {
    return false;
  }
  for (const name of propNames) {
    if (!allowedKeys.includes(name)) {
      return false;
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(obj, name);
    } catch (_err) {
      return false;
    }
    if (!desc || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
      return false;
    }
  }
  return true;
}

/**
 * Structurally validates the C1 write response envelope according to G2-A / G4-R4 requirements.
 *
 * For ok === true:
 * - Own properties must be EXACTLY: 'ok', 'changed', 'value'. Zero extra properties.
 * - Zero symbol-keyed properties.
 * - All properties must be non-accessor data properties (desc.get === undefined && desc.set === undefined).
 * - ok === true, changed === true, isPlainObject(value) === true.
 * - Any 'code', 'message', 'recoverable', 'details', or unknown field causes validation failure.
 *
 * For ok === false:
 * - Mandatory own properties: 'ok', 'code', 'message', 'recoverable'.
 * - Optional own property: 'details' (if present, must be plain object with data properties only).
 * - Zero symbol-keyed properties.
 * - All properties must be non-accessor data properties.
 * - 'changed' and 'value' are strictly forbidden (presence check: propNames).
 * - ok === false, typeof code === 'string', typeof message === 'string' && message.length > 0, typeof recoverable === 'boolean'.
 *
 * @param {unknown} writeRes
 * @returns {{ valid: true, isSuccess: true, value: object } | { valid: true, isSuccess: false, code: string, message: string, recoverable: boolean, details?: object } | { valid: false }}
 */
function validateC1WriteEnvelope(writeRes) {
  if (!isPlainObject(writeRes)) {
    return { valid: false };
  }

  let propNames;
  let propSymbols;
  try {
    propNames = Object.getOwnPropertyNames(writeRes);
    propSymbols = Object.getOwnPropertySymbols(writeRes);
  } catch (_err) {
    return { valid: false };
  }

  // Symbol properties are strictly forbidden
  if (propSymbols.length > 0) {
    return { valid: false };
  }

  // All own properties must be enumerable data properties (no accessor getters/setters)
  for (const name of propNames) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(writeRes, name);
    } catch (_err) {
      return { valid: false };
    }
    if (!desc || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
      return { valid: false };
    }
  }

  if (!propNames.includes('ok')) {
    return { valid: false };
  }

  const okVal = writeRes.ok;
  if (typeof okVal !== 'boolean') {
    return { valid: false };
  }

  // --- CASE 1: SUCCESS ENVELOPE (ok === true) ---
  if (okVal === true) {
    // Contract: exactly own 'ok', 'changed', 'value'. Zero extra properties.
    if (propNames.length !== 3 || !propNames.includes('changed') || !propNames.includes('value')) {
      return { valid: false };
    }
    if (writeRes.changed !== true) {
      return { valid: false };
    }
    if (!isPlainObject(writeRes.value)) {
      return { valid: false };
    }
    return {
      valid: true,
      isSuccess: true,
      value: writeRes.value,
    };
  }

  // --- CASE 2: FAILURE ENVELOPE (ok === false) ---
  // Allowed keys: 'ok', 'code', 'message', 'recoverable', and optional 'details'.
  // Strictly forbidden: 'changed', 'value' (even if undefined), and any unrecognized key.
  for (const name of propNames) {
    if (name !== 'ok' && name !== 'code' && name !== 'message' && name !== 'recoverable' && name !== 'details') {
      return { valid: false };
    }
  }

  if (!propNames.includes('code') || !propNames.includes('message') || !propNames.includes('recoverable')) {
    return { valid: false };
  }

  if (typeof writeRes.code !== 'string') {
    return { valid: false };
  }
  if (typeof writeRes.message !== 'string' || writeRes.message.length === 0) {
    return { valid: false };
  }
  if (typeof writeRes.recoverable !== 'boolean') {
    return { valid: false };
  }

  let detailsObj = undefined;
  if (propNames.includes('details')) {
    if (!isPlainObject(writeRes.details)) {
      return { valid: false };
    }
    let detNames;
    let detSymbols;
    try {
      detNames = Object.getOwnPropertyNames(writeRes.details);
      detSymbols = Object.getOwnPropertySymbols(writeRes.details);
    } catch (_err) {
      return { valid: false };
    }
    // G4-R5: details must contain EXACTLY one own property 'reason', with zero symbol properties
    if (detSymbols.length > 0 || detNames.length !== 1 || detNames[0] !== 'reason') {
      return { valid: false };
    }
    let dDesc;
    try {
      dDesc = Object.getOwnPropertyDescriptor(writeRes.details, 'reason');
    } catch (_err) {
      return { valid: false };
    }
    if (!dDesc || dDesc.get !== undefined || dDesc.set !== undefined || !dDesc.enumerable) {
      return { valid: false };
    }
    const reasonVal = writeRes.details.reason;
    if (typeof reasonVal !== 'string' || !ALLOWED_C1_DIAGNOSTIC_REASONS.has(reasonVal)) {
      return { valid: false };
    }
    detailsObj = Object.freeze({ reason: reasonVal });
  }

  return {
    valid: true,
    isSuccess: false,
    code: writeRes.code,
    message: writeRes.message,
    recoverable: writeRes.recoverable,
    details: detailsObj,
  };
}

/**
 * Structurally validates the C1 readState response envelope.
 * Contract on success: exactly own 'ok' (true) and own 'value' (plain object).
 *
 * @param {unknown} readRes
 * @returns {object | null}
 */
function validateC1ReadEnvelope(readRes) {
  if (!isPlainObject(readRes)) {
    return null;
  }

  let propNames;
  let propSymbols;
  try {
    propNames = Object.getOwnPropertyNames(readRes);
    propSymbols = Object.getOwnPropertySymbols(readRes);
  } catch (_err) {
    return null;
  }

  if (propSymbols.length > 0 || propNames.length !== 2) {
    return null;
  }

  if (!propNames.includes('ok') || !propNames.includes('value')) {
    return null;
  }

  for (const name of propNames) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(readRes, name);
    } catch (_err) {
      return null;
    }
    if (!desc || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
      return null;
    }
  }

  if (readRes.ok !== true || !isPlainObject(readRes.value)) {
    return null;
  }

  return readRes.value;
}

// --- Factory Function ---

/**
 * Creates an immutable SidecarController instance.
 *
 * Encapsulates its own per-user FIFO queue map and quarantine set.
 * D2-D must instantiate exactly one singleton controller per SillyTavern server process.
 *
 * @param {object} [options]
 * @returns {Readonly<object>}
 */
export function createSidecarController(options = {}) {
  if (options !== undefined && !isPlainObject(options)) {
    throw new TypeError('Options must be a plain object or undefined');
  }

  if (options && typeof options === 'object') {
    let propNames;
    let propSymbols;
    try {
      propNames = Object.getOwnPropertyNames(options);
      propSymbols = Object.getOwnPropertySymbols(options);
    } catch (_err) {
      throw new TypeError('Failed to inspect options properties');
    }
    if (propSymbols.length > 0) {
      throw new TypeError('Options cannot contain symbol-keyed properties');
    }
    for (const name of propNames) {
      if (name !== 'fileStore' && name !== 'generateCardId') {
        throw new TypeError('Unknown option property');
      }
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(options, name);
      } catch (_err) {
        throw new TypeError('Failed to inspect option descriptor');
      }
      if (!desc || desc.get !== undefined || desc.set !== undefined) {
        throw new TypeError('Accessor options are forbidden');
      }
    }
  }

  const fileStore = options?.fileStore;
  if (!fileStore || typeof fileStore !== 'object') {
    throw new TypeError('fileStore must be a valid FileStore instance');
  }
  for (const method of ['scanStore', 'observeAvatar', 'readState', 'createState', 'replaceState']) {
    let fn;
    try {
      fn = fileStore[method];
    } catch (_err) {
      throw new TypeError('Failed to access fileStore method');
    }
    if (typeof fn !== 'function') {
      throw new TypeError(`fileStore must implement ${method}`);
    }
  }

  let generateCardId = null;
  if (options?.generateCardId !== undefined) {
    if (typeof options.generateCardId !== 'function') {
      throw new TypeError('generateCardId must be a function');
    }
    generateCardId = options.generateCardId;
  } else {
    generateCardId = () => crypto.randomUUID();
  }

  // Instance-encapsulated queue and quarantine state
  const queueTails = new Map();
  const quarantinedRoots = new Set();

  /**
   * Rejection-consumed per-user FIFO queue executor.
   * Guarantees always-settled queue tail and zero unhandled rejections.
   */
  function withUserQueue(userRoot, operation) {
    const key = path.resolve(userRoot);
    const previousTail = queueTails.get(key) || Promise.resolve();

    // 1. work executes after previous tail settles, even if previous threw/rejected
    const work = previousTail.then(
      () => operation(),
      () => operation()
    );

    // 2. settledTail NEVER rejects: handles both fulfillment and rejection
    const settledTail = work.then(
      () => {},
      () => {}
    );

    // 3. Update queue map to point to settledTail
    queueTails.set(key, settledTail);

    // 4. Clean up queue entry when idle without creating unhandled rejection derivatives
    void settledTail.then(() => {
      if (queueTails.get(key) === settledTail) {
        queueTails.delete(key);
      }
    });

    // 5. Return user-facing work promise
    return work;
  }

  /**
   * Helper to perform total classification on C1 write outcomes and controller-level readback.
   * Single write-dispatched uncertainty boundary: any post-dispatch throw, malformed getter,
   * contradictory response, or unclassifiable output triggers WRITE_UNCERTAIN and quarantine.
   * Conforms to G2-A and Finding B.
   */
  async function dispatchWriteAndVerify({ isCreate, userRoot, cardId, expectedBytes, nextState }) {
    const queueKey = path.resolve(userRoot);

    try {
      // 1. Dispatch C1 write
      let writeRes;
      if (isCreate) {
        writeRes = await fileStore.createState({ userRoot, state: nextState });
      } else {
        writeRes = await fileStore.replaceState({ userRoot, cardId, expectedBytes, nextState });
      }

      // 2. Structural envelope validation (G4-R4)
      const envelope = validateC1WriteEnvelope(writeRes);
      if (!envelope.valid) {
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT
        );
      }

      // --- CASE A: FAILURE ENVELOPE (ok === false) ---
      if (!envelope.isSuccess) {
        const codeVal = envelope.code;
        const detailsReason = envelope.details?.reason;

        // G4-R5: Genuine C1 WRITE_UNCERTAIN always places root into quarantine
        if (codeVal === FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN) {
          quarantinedRoots.add(queueKey);
          return makeFailure(
            CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
            CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE
          );
        }

        // G4-R5: Contradictory envelope: pre-commit refusal code paired with rename/post-rename failure
        // Denotes a known commit-uncertain state that contradicts a clean failure; must quarantine
        if (detailsReason !== undefined && COMMIT_UNCERTAIN_REASONS.has(detailsReason)) {
          quarantinedRoots.add(queueKey);
          return makeFailure(
            CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
            CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT
          );
        }
        if (codeVal === FILE_STORE_ERROR_CODES.REVISION_CONFLICT) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.REVISION_CONFLICT,
            CONTROLLER_DIAGNOSTIC_REASONS.CAS_MISMATCH
          );
        }
        if (codeVal === FILE_STORE_ERROR_CODES.ALREADY_BOUND) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.ALREADY_BOUND,
            CONTROLLER_DIAGNOSTIC_REASONS.TARGET_ALREADY_BOUND
          );
        }
        if (codeVal === FILE_STORE_ERROR_CODES.WRITE_FAILED) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.WRITE_FAILED,
            detailsReason || CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR
          );
        }
        if (codeVal === FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE,
            CONTROLLER_DIAGNOSTIC_REASONS.STORAGE_UNAVAILABLE
          );
        }
        if (codeVal === FILE_STORE_ERROR_CODES.STATE_NOT_FOUND) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.STATE_NOT_FOUND,
            CONTROLLER_DIAGNOSTIC_REASONS.STALE_LOCATOR
          );
        }
        if (codeVal === FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
            CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR
          );
        }

        // Any unrecognized or malformed code on failure -> WRITE_UNCERTAIN & quarantine
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT
        );
      }

      // --- CASE B: SUCCESS ENVELOPE (ok === true) ---
      // Validate C1 snapshot returned
      const parsedC1Snapshot = parseSidecarState(envelope.value, { expectedCardId: nextState.cardId });
      if (!parsedC1Snapshot.ok) {
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT
        );
      }

      // G4-R3: Verify C1 success snapshot matches nextState exactly in key fields and canonical C0 serialization
      const c1Snapshot = parsedC1Snapshot.value;
      if (
        c1Snapshot.cardId !== nextState.cardId ||
        c1Snapshot.avatar !== nextState.avatar ||
        c1Snapshot.storageRevision !== nextState.storageRevision ||
        c1Snapshot.registry?.revision !== nextState.registry?.revision
      ) {
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT
        );
      }

      const expectedSer = serializeSidecarState(nextState);
      const c1Ser = serializeSidecarState(c1Snapshot);
      if (!expectedSer.ok || !c1Ser.ok || c1Ser.value !== expectedSer.value) {
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT
        );
      }

      // 3. Independent Controller Readback
      const readbackRes = await fileStore.readState({ userRoot, cardId: nextState.cardId });
      const readValue = validateC1ReadEnvelope(readbackRes);
      if (!readValue) {
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.READBACK_FAILED
        );
      }

      const parsedReadback = parseSidecarState(readValue, { expectedCardId: nextState.cardId });
      if (!parsedReadback.ok) {
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.READBACK_MISMATCH
        );
      }

      const freshSnapshot = parsedReadback.value;
      if (
        freshSnapshot.cardId !== nextState.cardId ||
        freshSnapshot.avatar !== nextState.avatar ||
        freshSnapshot.storageRevision !== nextState.storageRevision ||
        freshSnapshot.registry?.revision !== nextState.registry?.revision
      ) {
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.READBACK_MISMATCH
        );
      }

      const freshSer = serializeSidecarState(freshSnapshot);
      if (!freshSer.ok || freshSer.value !== expectedSer.value) {
        quarantinedRoots.add(queueKey);
        return makeFailure(
          CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
          CONTROLLER_DIAGNOSTIC_REASONS.READBACK_MISMATCH
        );
      }

      // 4. Response Projection
      return Object.freeze({
        ok: true,
        changed: true,
        value: deepFreeze({
          status: 'BOUND',
          cardId: freshSnapshot.cardId,
          avatar: freshSnapshot.avatar,
          storageRevision: freshSnapshot.storageRevision,
          registry: freshSnapshot.registry,
        }),
      });
    } catch (_unhandledErr) {
      // Finding B: Single write-dispatched uncertainty boundary catches ANY post-dispatch throw
      quarantinedRoots.add(queueKey);
      return makeFailure(
        CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
        CONTROLLER_DIAGNOSTIC_REASONS.UNHANDLED_WRITE_ERROR
      );
    }
  }

  // --- Public Methods ---

  async function resolve(params) {
    try {
      if (!validateStrictObject(params, ['context', 'avatar', 'signal'])) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      const { context, avatar, signal } = params;

      // Finding A & D: Extract and validate immutable primitive snapshots
      const validCtx = extractValidContext(context);
      if (!validCtx) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CONTEXT, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_CONTEXT_PATH);
      }
      const userRoot = validCtx.userRoot;
      const charactersRoot = validCtx.charactersRoot;

      if (!isValidAvatar(avatar)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_AVATAR, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }

      // Finding C: Check signal
      const sigErrPre = evaluateSignal(signal);
      if (sigErrPre) {
        return sigErrPre;
      }

      return await withUserQueue(userRoot, async () => {
        const queueKey = path.resolve(userRoot);
        const isQuarantined = quarantinedRoots.has(queueKey);

        const sigErrQueue = evaluateSignal(signal);
        if (sigErrQueue) {
          return sigErrQueue;
        }

        let scanRes;
        try {
          scanRes = await fileStore.scanStore({
            userRoot,
            charactersRoot,
            observedAvatars: [avatar],
          });
        } catch (_err) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        if (!scanRes || typeof scanRes !== 'object' || scanRes.ok !== true || !scanRes.value) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.INCOMPLETE_STORE);
        }

        const classifyRes = classifyAssociations(avatar, scanRes.value);
        if (!classifyRes.ok) {
          if (classifyRes.code === SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.ASSOCIATION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.ASSOCIATION_CONFLICT);
          }
          if (classifyRes.code === SIDECAR_ERROR_CODES.CARD_NOT_FOUND) {
            return makeFailure(CONTROLLER_ERROR_CODES.CARD_NOT_FOUND, CONTROLLER_DIAGNOSTIC_REASONS.TARGET_FILE_MISSING);
          }
          if (classifyRes.code === SIDECAR_ERROR_CODES.STORAGE_UNAVAILABLE) {
            return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.STORAGE_UNAVAILABLE);
          }
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.STORAGE_UNAVAILABLE);
        }

        let val;
        if (classifyRes.status === 'BOUND') {
          val = {
            status: 'BOUND',
            cardId: classifyRes.cardId,
            avatar: classifyRes.state.avatar,
            storageRevision: classifyRes.state.storageRevision,
            registry: classifyRes.state.registry,
          };
        } else {
          val = {
            status: 'UNBOUND',
            avatar,
            recoveryAvailable: Boolean(classifyRes.recoveryAvailable),
          };
        }

        if (isQuarantined) {
          val.quarantineActive = true;
        }

        return Object.freeze({
          ok: true,
          value: deepFreeze(val),
        });
      });
    } catch (_err) {
      return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
    }
  }

  async function recoveryCandidates(params) {
    try {
      if (!validateStrictObject(params, ['context', 'avatar', 'signal'])) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      const { context, avatar, signal } = params;

      // Finding A & D: Extract and validate immutable primitive snapshots
      const validCtx = extractValidContext(context);
      if (!validCtx) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CONTEXT, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_CONTEXT_PATH);
      }
      const userRoot = validCtx.userRoot;
      const charactersRoot = validCtx.charactersRoot;

      if (!isValidAvatar(avatar)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_AVATAR, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }

      // Finding C: Check signal
      const sigErrPre = evaluateSignal(signal);
      if (sigErrPre) {
        return sigErrPre;
      }

      return await withUserQueue(userRoot, async () => {
        const queueKey = path.resolve(userRoot);
        const isQuarantined = quarantinedRoots.has(queueKey);

        const sigErrQueue = evaluateSignal(signal);
        if (sigErrQueue) {
          return sigErrQueue;
        }

        let scanRes;
        try {
          scanRes = await fileStore.scanStore({
            userRoot,
            charactersRoot,
            observedAvatars: [avatar],
          });
        } catch (_err) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        if (!scanRes || typeof scanRes !== 'object' || scanRes.ok !== true || !scanRes.value) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.INCOMPLETE_STORE);
        }

        // G2-B: Classify target association before projecting candidates
        const classifyRes = classifyAssociations(avatar, scanRes.value);
        if (!classifyRes.ok) {
          if (classifyRes.code === SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.ASSOCIATION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.ASSOCIATION_CONFLICT);
          }
          if (classifyRes.code === SIDECAR_ERROR_CODES.CARD_NOT_FOUND) {
            return makeFailure(CONTROLLER_ERROR_CODES.CARD_NOT_FOUND, CONTROLLER_DIAGNOSTIC_REASONS.TARGET_FILE_MISSING);
          }
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.STORAGE_UNAVAILABLE);
        }

        if (classifyRes.status === 'BOUND') {
          return makeFailure(CONTROLLER_ERROR_CODES.ALREADY_BOUND, CONTROLLER_DIAGNOSTIC_REASONS.TARGET_ALREADY_BOUND);
        }

        // Target avatar is UNBOUND; project minimal orphan candidate list
        const fileStatusMap = new Map();
        for (const f of scanRes.value.files) {
          fileStatusMap.set(f.avatar, f.status);
        }

        const candidates = [];
        for (const claim of scanRes.value.claims) {
          if (fileStatusMap.get(claim.avatar) === 'MISSING') {
            candidates.push({
              avatar: claim.avatar,
              cardId: claim.cardId,
              storageRevision: claim.state.storageRevision,
            });
          }
        }

        candidates.sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));

        const val = { candidates };
        if (isQuarantined) {
          val.quarantineActive = true;
        }

        return Object.freeze({
          ok: true,
          value: deepFreeze(val),
        });
      });
    } catch (_err) {
      return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
    }
  }

  async function create(params) {
    try {
      if (!validateStrictObject(params, ['context', 'avatar', 'signal'])) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      const { context, avatar, signal } = params;

      // Finding A & D: Extract and validate immutable primitive snapshots
      const validCtx = extractValidContext(context);
      if (!validCtx) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CONTEXT, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_CONTEXT_PATH);
      }
      const userRoot = validCtx.userRoot;
      const charactersRoot = validCtx.charactersRoot;

      if (!isValidAvatar(avatar)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_AVATAR, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }

      // Finding C: Check signal
      const sigErrPre = evaluateSignal(signal);
      if (sigErrPre) {
        return sigErrPre;
      }

      return await withUserQueue(userRoot, async () => {
        const queueKey = path.resolve(userRoot);
        if (quarantinedRoots.has(queueKey)) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
            CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE
          );
        }

        const sigErrQueue = evaluateSignal(signal);
        if (sigErrQueue) {
          return sigErrQueue;
        }

        let scanRes;
        try {
          scanRes = await fileStore.scanStore({
            userRoot,
            charactersRoot,
            observedAvatars: [avatar],
          });
        } catch (_err) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        if (!scanRes || typeof scanRes !== 'object' || scanRes.ok !== true || !scanRes.value) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.INCOMPLETE_STORE);
        }

        const planRes = planCreateSidecar(avatar, scanRes.value, { generateCardId });
        if (!planRes.ok) {
          if (planRes.code === SIDECAR_ERROR_CODES.ALREADY_BOUND) {
            return makeFailure(CONTROLLER_ERROR_CODES.ALREADY_BOUND, CONTROLLER_DIAGNOSTIC_REASONS.TARGET_ALREADY_BOUND);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.ASSOCIATION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.ASSOCIATION_CONFLICT);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR) {
            return makeFailure(CONTROLLER_ERROR_CODES.CARD_NOT_FOUND, CONTROLLER_DIAGNOSTIC_REASONS.TARGET_FILE_MISSING);
          }
          return makeFailure(CONTROLLER_ERROR_CODES.WRITE_FAILED, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        // Finding C: Pre-dispatch abort check (refuses before C1 write dispatch)
        const sigErrDispatch = evaluateSignal(signal);
        if (sigErrDispatch) {
          return sigErrDispatch;
        }

        return await dispatchWriteAndVerify({
          isCreate: true,
          userRoot,
          cardId: planRes.nextState.cardId,
          nextState: planRes.nextState,
        });
      });
    } catch (_err) {
      return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
    }
  }

  async function mutate(params) {
    try {
      if (!validateStrictObject(params, [
        'context',
        'cardId',
        'avatar',
        'expectedStorageRevision',
        'expectedRegistryRevision',
        'command',
        'signal',
      ])) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      const { context, cardId, avatar, expectedStorageRevision, expectedRegistryRevision, command, signal } = params;

      // Finding A & D: Extract and validate immutable primitive snapshots
      const validCtx = extractValidContext(context);
      if (!validCtx) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CONTEXT, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_CONTEXT_PATH);
      }
      const userRoot = validCtx.userRoot;
      const charactersRoot = validCtx.charactersRoot;

      if (typeof cardId !== 'string' || !UUID_V4_REGEX.test(cardId)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CARD_ID, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      if (!isValidAvatar(avatar)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_AVATAR, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      if (typeof expectedStorageRevision !== 'number' || !Number.isSafeInteger(expectedStorageRevision) || expectedStorageRevision < 1) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      if (typeof expectedRegistryRevision !== 'number' || !Number.isSafeInteger(expectedRegistryRevision) || expectedRegistryRevision < 0) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      if (!isPlainObject(command)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }

      // Finding C: Check signal
      const sigErrPre = evaluateSignal(signal);
      if (sigErrPre) {
        return sigErrPre;
      }

      return await withUserQueue(userRoot, async () => {
        const queueKey = path.resolve(userRoot);
        if (quarantinedRoots.has(queueKey)) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
            CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE
          );
        }

        const sigErrQueue = evaluateSignal(signal);
        if (sigErrQueue) {
          return sigErrQueue;
        }

        let scanRes;
        try {
          scanRes = await fileStore.scanStore({
            userRoot,
            charactersRoot,
            observedAvatars: [avatar],
          });
        } catch (_err) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        if (!scanRes || typeof scanRes !== 'object' || scanRes.ok !== true || !scanRes.value) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.INCOMPLETE_STORE);
        }

        const claim = scanRes.value.claims.find((c) => c.cardId === cardId);
        if (!claim) {
          return makeFailure(CONTROLLER_ERROR_CODES.STALE_CARD_LOCATOR, CONTROLLER_DIAGNOSTIC_REASONS.STALE_LOCATOR);
        }

        const planRes = planMutateSidecar(
          claim.state,
          cardId,
          avatar,
          expectedStorageRevision,
          expectedRegistryRevision,
          command,
          scanRes.value
        );

        if (!planRes.ok) {
          if (planRes.code === SIDECAR_ERROR_CODES.REVISION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.REVISION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.CAS_MISMATCH);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.ASSOCIATION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.ASSOCIATION_CONFLICT);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR) {
            return makeFailure(CONTROLLER_ERROR_CODES.STALE_CARD_LOCATOR, CONTROLLER_DIAGNOSTIC_REASONS.STALE_LOCATOR);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.STORAGE_UNAVAILABLE) {
            return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.STORAGE_UNAVAILABLE);
          }
          return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
        }

        // Exact no-op short-circuit: skip all filesystem writes
        if (planRes.changed === false) {
          return Object.freeze({
            ok: true,
            changed: false,
            value: deepFreeze({
              status: 'BOUND',
              cardId: claim.state.cardId,
              avatar: claim.state.avatar,
              storageRevision: claim.state.storageRevision,
              registry: claim.state.registry,
            }),
          });
        }

        // Construct canonical expectedBytes CAS bridge from existing evidence claim
        const expectedBytesRes = serializeSidecarState(claim.state);
        if (!expectedBytesRes.ok) {
          return makeFailure(CONTROLLER_ERROR_CODES.INVALID_SCHEMA, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }
        const expectedBytes = expectedBytesRes.value;

        // Finding C: Pre-dispatch abort check (refuses before C1 write dispatch)
        const sigErrDispatch = evaluateSignal(signal);
        if (sigErrDispatch) {
          return sigErrDispatch;
        }

        return await dispatchWriteAndVerify({
          isCreate: false,
          userRoot,
          cardId,
          expectedBytes,
          nextState: planRes.nextState,
        });
      });
    } catch (_err) {
      return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
    }
  }

  async function rebind(params) {
    try {
      if (!validateStrictObject(params, [
        'context',
        'cardId',
        'fromAvatar',
        'toAvatar',
        'expectedStorageRevision',
        'signal',
      ])) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      const { context, cardId, fromAvatar, toAvatar, expectedStorageRevision, signal } = params;

      // Finding A & D: Extract and validate immutable primitive snapshots
      const validCtx = extractValidContext(context);
      if (!validCtx) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CONTEXT, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_CONTEXT_PATH);
      }
      const userRoot = validCtx.userRoot;
      const charactersRoot = validCtx.charactersRoot;

      if (typeof cardId !== 'string' || !UUID_V4_REGEX.test(cardId)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CARD_ID, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      if (!isValidAvatar(fromAvatar) || !isValidAvatar(toAvatar)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_AVATAR, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      if (typeof expectedStorageRevision !== 'number' || !Number.isSafeInteger(expectedStorageRevision) || expectedStorageRevision < 1) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }

      // Finding C: Check signal
      const sigErrPre = evaluateSignal(signal);
      if (sigErrPre) {
        return sigErrPre;
      }

      return await withUserQueue(userRoot, async () => {
        const queueKey = path.resolve(userRoot);
        if (quarantinedRoots.has(queueKey)) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
            CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE
          );
        }

        const sigErrQueue = evaluateSignal(signal);
        if (sigErrQueue) {
          return sigErrQueue;
        }

        const observedAvatars = fromAvatar === toAvatar ? [fromAvatar] : [fromAvatar, toAvatar];
        let scanRes;
        try {
          scanRes = await fileStore.scanStore({
            userRoot,
            charactersRoot,
            observedAvatars,
          });
        } catch (_err) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        if (!scanRes || typeof scanRes !== 'object' || scanRes.ok !== true || !scanRes.value) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.INCOMPLETE_STORE);
        }

        const claim = scanRes.value.claims.find((c) => c.cardId === cardId);
        if (!claim) {
          return makeFailure(CONTROLLER_ERROR_CODES.STALE_CARD_LOCATOR, CONTROLLER_DIAGNOSTIC_REASONS.STALE_LOCATOR);
        }

        const planRes = planRebindSidecar(
          claim.state,
          cardId,
          fromAvatar,
          toAvatar,
          expectedStorageRevision,
          scanRes.value
        );

        if (!planRes.ok) {
          if (planRes.code === SIDECAR_ERROR_CODES.DUPLICATE_NOT_RENAME) {
            return makeFailure(CONTROLLER_ERROR_CODES.DUPLICATE_NOT_RENAME, CONTROLLER_DIAGNOSTIC_REASONS.DUPLICATE_NOT_RENAME);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.REVISION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.REVISION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.CAS_MISMATCH);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.ALREADY_BOUND) {
            return makeFailure(CONTROLLER_ERROR_CODES.ALREADY_BOUND, CONTROLLER_DIAGNOSTIC_REASONS.TARGET_ALREADY_BOUND);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.ASSOCIATION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.ASSOCIATION_CONFLICT);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR) {
            return makeFailure(CONTROLLER_ERROR_CODES.STALE_CARD_LOCATOR, CONTROLLER_DIAGNOSTIC_REASONS.STALE_LOCATOR);
          }
          return makeFailure(CONTROLLER_ERROR_CODES.WRITE_FAILED, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        // Same-avatar no-op
        if (planRes.changed === false) {
          return Object.freeze({
            ok: true,
            changed: false,
            value: deepFreeze({
              status: 'BOUND',
              cardId: claim.state.cardId,
              avatar: claim.state.avatar,
              storageRevision: claim.state.storageRevision,
              registry: claim.state.registry,
            }),
          });
        }

        const expectedBytesRes = serializeSidecarState(claim.state);
        if (!expectedBytesRes.ok) {
          return makeFailure(CONTROLLER_ERROR_CODES.INVALID_SCHEMA, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }
        const expectedBytes = expectedBytesRes.value;

        // Finding C: Pre-dispatch abort check (refuses before C1 write dispatch)
        const sigErrDispatch = evaluateSignal(signal);
        if (sigErrDispatch) {
          return sigErrDispatch;
        }

        return await dispatchWriteAndVerify({
          isCreate: false,
          userRoot,
          cardId,
          expectedBytes,
          nextState: planRes.nextState,
        });
      });
    } catch (_err) {
      return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
    }
  }

  async function clone(params) {
    try {
      if (!validateStrictObject(params, [
        'context',
        'sourceCardId',
        'sourceAvatar',
        'targetAvatar',
        'expectedSourceStorageRevision',
        'signal',
      ])) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      const { context, sourceCardId, sourceAvatar, targetAvatar, expectedSourceStorageRevision, signal } = params;

      // Finding A & D: Extract and validate immutable primitive snapshots
      const validCtx = extractValidContext(context);
      if (!validCtx) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CONTEXT, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_CONTEXT_PATH);
      }
      const userRoot = validCtx.userRoot;
      const charactersRoot = validCtx.charactersRoot;

      if (typeof sourceCardId !== 'string' || !UUID_V4_REGEX.test(sourceCardId)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_CARD_ID, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      if (!isValidAvatar(sourceAvatar) || !isValidAvatar(targetAvatar)) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_AVATAR, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }
      if (
        typeof expectedSourceStorageRevision !== 'number' ||
        !Number.isSafeInteger(expectedSourceStorageRevision) ||
        expectedSourceStorageRevision < 1
      ) {
        return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
      }

      // Finding C: Check signal
      const sigErrPre = evaluateSignal(signal);
      if (sigErrPre) {
        return sigErrPre;
      }

      return await withUserQueue(userRoot, async () => {
        const queueKey = path.resolve(userRoot);
        if (quarantinedRoots.has(queueKey)) {
          return makeFailure(
            CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN,
            CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE
          );
        }

        const sigErrQueue = evaluateSignal(signal);
        if (sigErrQueue) {
          return sigErrQueue;
        }

        let scanRes;
        try {
          scanRes = await fileStore.scanStore({
            userRoot,
            charactersRoot,
            observedAvatars: [sourceAvatar, targetAvatar],
          });
        } catch (_err) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        if (!scanRes || typeof scanRes !== 'object' || scanRes.ok !== true || !scanRes.value) {
          return makeFailure(CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE, CONTROLLER_DIAGNOSTIC_REASONS.INCOMPLETE_STORE);
        }

        const sourceClaim = scanRes.value.claims.find((c) => c.cardId === sourceCardId);
        if (!sourceClaim) {
          return makeFailure(CONTROLLER_ERROR_CODES.STALE_CARD_LOCATOR, CONTROLLER_DIAGNOSTIC_REASONS.STALE_LOCATOR);
        }

        const planRes = planCloneSidecar(
          sourceClaim.state,
          sourceCardId,
          sourceAvatar,
          targetAvatar,
          expectedSourceStorageRevision,
          scanRes.value,
          { generateCardId }
        );

        if (!planRes.ok) {
          if (planRes.code === SIDECAR_ERROR_CODES.ALREADY_BOUND) {
            return makeFailure(CONTROLLER_ERROR_CODES.ALREADY_BOUND, CONTROLLER_DIAGNOSTIC_REASONS.TARGET_ALREADY_BOUND);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.REVISION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.REVISION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.CAS_MISMATCH);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT) {
            return makeFailure(CONTROLLER_ERROR_CODES.ASSOCIATION_CONFLICT, CONTROLLER_DIAGNOSTIC_REASONS.ASSOCIATION_CONFLICT);
          }
          if (planRes.code === SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR) {
            return makeFailure(CONTROLLER_ERROR_CODES.STALE_CARD_LOCATOR, CONTROLLER_DIAGNOSTIC_REASONS.STALE_LOCATOR);
          }
          return makeFailure(CONTROLLER_ERROR_CODES.WRITE_FAILED, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);
        }

        // Finding C: Pre-dispatch abort check (refuses before C1 write dispatch)
        const sigErrDispatch = evaluateSignal(signal);
        if (sigErrDispatch) {
          return sigErrDispatch;
        }

        return await dispatchWriteAndVerify({
          isCreate: true,
          userRoot,
          cardId: planRes.nextState.cardId,
          nextState: planRes.nextState,
        });
      });
    } catch (_err) {
      return makeFailure(CONTROLLER_ERROR_CODES.INVALID_REQUEST, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
    }
  }

  return Object.freeze({
    resolve,
    recoveryCandidates,
    create,
    mutate,
    rebind,
    clone,
  });
}
