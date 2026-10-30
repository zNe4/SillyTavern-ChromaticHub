/**
 * SillyTavern-ChromaticHub: Pure Sidecar State Validator and Transition Planner (H01-B3-D2-C0)
 *
 * Implements pure state validation, canonical serialization, association classification,
 * and transition planning for card-scoped sidecar metadata.
 *
 * Conforms to:
 * - ChromaticHub-H01-B3-D2-A-approved.md (Storage & API contract)
 * - ChromaticHub-H01-B3-D2-B-approved.md (State machine & storage controller plan)
 * - H01-B3-D2-C0 G1-R2 Implementation Plan
 * - Binding Amendment A (State/evidence consistency & canonical equality)
 * - Binding Amendment B (Complete file observations & fail-closed evidence)
 * - G4-R1 Corrections (Guarded strict own-key/descriptor validation & exception containment)
 *
 * Purity Invariants:
 * - Zero Node filesystem API usage (no node:fs).
 * - Zero network/fetch calls.
 * - Zero browser DOM access.
 * - Zero SillyTavern runtime or card PNG modifications.
 * - Dependency-free ES module.
 */

import {
  parseRegistry,
  resolveIdentity,
  planMutation,
  serializeRegistry,
} from './identity-registry.mjs';

// --- Constants & RegExps ---

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG_EXTENSION_REGEX = /\.[pP][nN][gG]$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;

const MAX_REGISTRY_BYTES = 262144; // 256 KiB inner registry cap
const MAX_SIDECAR_BYTES = 307200;  // 300 KiB outer state.json cap
export const MAX_AVATAR_BYTES = 255; // 255 UTF-8 bytes cap including .png

const ALLOWED_STATE_KEYS = Object.freeze([
  'avatar',
  'cardId',
  'registry',
  'schemaVersion',
  'storageRevision',
]);

const ALLOWED_EVIDENCE_KEYS = Object.freeze([
  'claims',
  'files',
  'scanStatus',
  'schemaVersion',
]);

const ALLOWED_FILE_KEYS = Object.freeze(['avatar', 'status']);
const ALLOWED_CLAIM_KEYS = Object.freeze(['avatar', 'cardId', 'state']);

export const SIDECAR_ERROR_CODES = Object.freeze({
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  INVALID_AVATAR: 'INVALID_AVATAR',
  INVALID_CARD_ID: 'INVALID_CARD_ID',
  CARD_ID_MISMATCH: 'CARD_ID_MISMATCH',
  INVALID_EVIDENCE: 'INVALID_EVIDENCE',
  INVALID_COMMAND: 'INVALID_COMMAND',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  ALREADY_BOUND: 'ALREADY_BOUND',
  ASSOCIATION_CONFLICT: 'ASSOCIATION_CONFLICT',
  STALE_CARD_LOCATOR: 'STALE_CARD_LOCATOR',
  DUPLICATE_NOT_RENAME: 'DUPLICATE_NOT_RENAME',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  BYTE_LIMIT_EXCEEDED: 'BYTE_LIMIT_EXCEEDED',
  REVISION_OVERFLOW: 'REVISION_OVERFLOW',
  ID_GENERATION_FAILED: 'ID_GENERATION_FAILED',
  CARD_CAPACITY_EXCEEDED: 'CARD_CAPACITY_EXCEEDED',
  IDENTITY_NOT_FOUND: 'IDENTITY_NOT_FOUND',
});

const textEncoder = new TextEncoder();

function getUtf8ByteLength(str) {
  return textEncoder.encode(str).length;
}

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
    // Contain any freeze exceptions
  }
  return obj;
}

function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

function isValidAvatar(avatar) {
  if (typeof avatar !== 'string') {
    return false;
  }
  if (avatar.trim().length === 0) {
    return false;
  }
  if (getUtf8ByteLength(avatar) > MAX_AVATAR_BYTES) {
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

function generateSecureUuidV4() {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    return null;
  }
  try {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 v4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex = '';
    for (let i = 0; i < 16; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  } catch (_err) {
    return null;
  }
}

function cloneCharacter(c) {
  return {
    aliases: Array.isArray(c.aliases) ? [...c.aliases] : [],
    descriptor: c.descriptor,
    id: c.id,
    name: c.name,
  };
}

function cloneRegistry(reg) {
  return {
    characters: Array.isArray(reg.characters) ? reg.characters.map(cloneCharacter) : [],
    revision: reg.revision,
    schemaVersion: 1,
  };
}

/**
 * Strict own-key and descriptor validation.
 * Enforces:
 * - isPlainObject
 * - Exactly the allowedKeys
 * - Rejects non-enumerable properties (extras or unpermitted visibility)
 * - Rejects symbol-keyed properties
 * - Rejects accessor properties (getters/setters)
 * - Fully contains proxy trap exceptions
 *
 * @param {unknown} obj
 * @param {readonly string[]} allowedKeys
 * @param {string} errorCode
 * @param {string} label
 * @returns {HubResult<true>}
 */
function validateStrictShape(obj, allowedKeys, errorCode, label) {
  if (!isPlainObject(obj)) {
    return {
      ok: false,
      code: errorCode,
      message: `${label} must be a plain object`,
      recoverable: false,
    };
  }

  let propNames;
  let propSymbols;
  try {
    propNames = Object.getOwnPropertyNames(obj);
    propSymbols = Object.getOwnPropertySymbols(obj);
  } catch (_err) {
    return {
      ok: false,
      code: errorCode,
      message: `${label} property inspection threw an error`,
      recoverable: false,
    };
  }

  if (propSymbols.length > 0) {
    return {
      ok: false,
      code: errorCode,
      message: `${label} cannot contain symbol-keyed properties`,
      recoverable: false,
    };
  }

  if (propNames.length !== allowedKeys.length) {
    return {
      ok: false,
      code: errorCode,
      message: `Invalid property count on ${label}: expected ${allowedKeys.length}, found ${propNames.length}`,
      recoverable: false,
    };
  }

  for (const key of allowedKeys) {
    let hasOwn = false;
    let desc;
    try {
      hasOwn = Object.prototype.hasOwnProperty.call(obj, key);
      desc = Object.getOwnPropertyDescriptor(obj, key);
    } catch (_err) {
      return {
        ok: false,
        code: errorCode,
        message: `${label} descriptor inspection threw on key: ${key}`,
        recoverable: false,
      };
    }

    if (!hasOwn || !desc) {
      return {
        ok: false,
        code: errorCode,
        message: `Missing required key on ${label}: ${key}`,
        recoverable: false,
      };
    }

    // Must be an enumerable data property (not getter/setter, not non-enumerable)
    if (desc.get !== undefined || desc.set !== undefined) {
      return {
        ok: false,
        code: errorCode,
        message: `Accessor properties (getters/setters) are forbidden on ${label}: ${key}`,
        recoverable: false,
      };
    }

    if (!desc.enumerable) {
      return {
        ok: false,
        code: errorCode,
        message: `Non-enumerable properties are forbidden on ${label}: ${key}`,
        recoverable: false,
      };
    }
  }

  // Ensure every property present is an allowed key
  for (const name of propNames) {
    if (!allowedKeys.includes(name)) {
      return {
        ok: false,
        code: errorCode,
        message: `Unknown property on ${label}`,
        recoverable: false,
      };
    }
  }

  return { ok: true };
}

// --- Public Core API ---

/**
 * Parses and validates raw state.json into a deeply frozen snapshot.
 *
 * @param {unknown} raw - Raw JSON object of state.json
 * @param {{ expectedCardId?: string }} [options]
 * @returns {HubResult<Readonly<SidecarSnapshot>>}
 */
export function parseSidecarState(raw, options = {}) {
  try {
    const shapeValidation = validateStrictShape(
      raw,
      ALLOWED_STATE_KEYS,
      SIDECAR_ERROR_CODES.INVALID_SCHEMA,
      'Sidecar state'
    );
    if (!shapeValidation.ok) {
      return shapeValidation;
    }

    // schemaVersion
    if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
        message: 'schemaVersion must be an integer',
        recoverable: false,
      };
    }
    if (raw.schemaVersion !== 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.UNSUPPORTED_VERSION,
        message: `Unsupported schema version: ${raw.schemaVersion}`,
        recoverable: false,
        details: { foundVersion: raw.schemaVersion },
      };
    }

    // cardId
    if (typeof raw.cardId !== 'string' || !UUID_V4_REGEX.test(raw.cardId)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_CARD_ID,
        message: 'cardId must be a canonical lowercase RFC 4122 v4 UUID',
        recoverable: false,
      };
    }

    // expectedCardId check if provided in options
    let expectedCardId = null;
    if (options !== undefined) {
      if (!isPlainObject(options)) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
          message: 'Options must be a plain object',
          recoverable: false,
        };
      }
      let optNames;
      let optSymbols;
      try {
        optNames = Object.getOwnPropertyNames(options);
        optSymbols = Object.getOwnPropertySymbols(options);
      } catch (_err) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
          message: 'Failed to inspect options properties',
          recoverable: false,
        };
      }
      if (optSymbols.length > 0) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
          message: 'Options cannot contain symbol-keyed properties',
          recoverable: false,
        };
      }
      for (const name of optNames) {
        if (name !== 'expectedCardId') {
          return {
            ok: false,
            code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
            message: 'Unknown option property',
            recoverable: false,
          };
        }
      }
      if (optNames.includes('expectedCardId')) {
        let desc;
        try {
          desc = Object.getOwnPropertyDescriptor(options, 'expectedCardId');
        } catch (_err) {
          return {
            ok: false,
            code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
            message: 'Failed to get expectedCardId descriptor',
            recoverable: false,
          };
        }
        if (!desc || desc.get !== undefined || desc.set !== undefined) {
          return {
            ok: false,
            code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
            message: 'Accessor options are forbidden',
            recoverable: false,
          };
        }
        const val = desc.value;
        if (typeof val !== 'string' || !UUID_V4_REGEX.test(val)) {
          return {
            ok: false,
            code: SIDECAR_ERROR_CODES.INVALID_CARD_ID,
            message: 'expectedCardId must be a canonical lowercase RFC 4122 v4 UUID',
            recoverable: false,
          };
        }
        expectedCardId = val;
      }
    }

    if (expectedCardId !== null && raw.cardId !== expectedCardId) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.CARD_ID_MISMATCH,
        message: 'cardId does not match expectedCardId',
        recoverable: false,
        details: { foundCardId: raw.cardId, expectedCardId },
      };
    }

    // avatar
    if (!isValidAvatar(raw.avatar)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_AVATAR,
        message: 'Invalid avatar filename',
        recoverable: false,
      };
    }

    // storageRevision
    if (
      typeof raw.storageRevision !== 'number' ||
      !Number.isSafeInteger(raw.storageRevision) ||
      raw.storageRevision < 1
    ) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
        message: 'storageRevision must be a positive safe integer (>= 1)',
        recoverable: false,
      };
    }

    // inner registry validation via H01-B0
    if (!isPlainObject(raw.registry)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
        message: 'registry must be a plain object',
        recoverable: false,
      };
    }
    const regParsed = parseRegistry(raw.registry);
    if (!regParsed.ok) {
      return regParsed;
    }
    if (regParsed.status === 'UNINITIALIZED') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
        message: 'Sidecar registry cannot be uninitialized',
        recoverable: false,
      };
    }

    // Byte size enforcement
    const serializedOuter = canonicalStringify({
      avatar: raw.avatar,
      cardId: raw.cardId,
      registry: regParsed.value,
      schemaVersion: 1,
      storageRevision: raw.storageRevision,
    });
    const outerBytes = getUtf8ByteLength(serializedOuter);
    if (outerBytes > MAX_SIDECAR_BYTES) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
        message: `Outer sidecar state serialized size (${outerBytes} bytes) exceeds 300 KiB limit`,
        recoverable: false,
      };
    }

    const snapshot = deepFreeze({
      avatar: raw.avatar,
      cardId: raw.cardId,
      registry: regParsed.value,
      schemaVersion: 1,
      storageRevision: raw.storageRevision,
    });

    return {
      ok: true,
      value: snapshot,
    };
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
      message: 'Failed to parse sidecar state: malformed input',
      recoverable: false,
    };
  }
}

/**
 * Validates synthetic evidence structure supplied by controller.
 * Enforces Amendment B: complete file observations, uniqueness, and claim coherence.
 * Enforces strict shape on evidence envelope, files, and claims.
 *
 * @param {unknown} rawEvidence
 * @returns {HubResult<Readonly<SyntheticEvidence>>}
 */
export function validateEvidence(rawEvidence) {
  try {
    const shapeValidation = validateStrictShape(
      rawEvidence,
      ALLOWED_EVIDENCE_KEYS,
      SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
      'Evidence envelope'
    );
    if (!shapeValidation.ok) {
      return shapeValidation;
    }

    if (rawEvidence.schemaVersion !== 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
        message: 'Unsupported evidence schemaVersion',
        recoverable: false,
      };
    }

    if (
      rawEvidence.scanStatus !== 'COMPLETE' &&
      rawEvidence.scanStatus !== 'INCOMPLETE'
    ) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
        message: 'scanStatus must be "COMPLETE" or "INCOMPLETE"',
        recoverable: false,
      };
    }

    if (!Array.isArray(rawEvidence.files) || !Array.isArray(rawEvidence.claims)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
        message: 'files and claims must be arrays',
        recoverable: false,
      };
    }

    // Validate files: Amendment B Rule 1 & 2 & 3:
    // Every avatar in files must appear exactly once. Reject duplicate observations and contradictory statuses.
    const seenFiles = new Map();
    for (let i = 0; i < rawEvidence.files.length; i++) {
      const f = rawEvidence.files[i];
      const fileShape = validateStrictShape(
        f,
        ALLOWED_FILE_KEYS,
        SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
        `File entry ${i}`
      );
      if (!fileShape.ok) {
        return fileShape;
      }

      if (!isValidAvatar(f.avatar)) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Invalid avatar on file entry ${i}`,
          recoverable: false,
        };
      }
      if (f.status !== 'EXISTS' && f.status !== 'MISSING') {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Invalid status on file entry ${i}: must be "EXISTS" or "MISSING"`,
          recoverable: false,
        };
      }
      if (seenFiles.has(f.avatar)) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Duplicate file observation for avatar: ${f.avatar}`,
          recoverable: false,
        };
      }
      seenFiles.set(f.avatar, f.status);
    }

    // Validate claims:
    // Each claim must have coherent cardId, avatar, valid state, and exactly one corresponding file observation in files.
    // No duplicate cardId claims across the entire evidence structure.
    const seenClaimCardIds = new Set();
    const validatedClaims = [];

    for (let i = 0; i < rawEvidence.claims.length; i++) {
      const c = rawEvidence.claims[i];
      const claimShape = validateStrictShape(
        c,
        ALLOWED_CLAIM_KEYS,
        SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
        `Claim entry ${i}`
      );
      if (!claimShape.ok) {
        return claimShape;
      }

      if (typeof c.cardId !== 'string' || !UUID_V4_REGEX.test(c.cardId)) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Invalid cardId on claim entry ${i}`,
          recoverable: false,
        };
      }
      if (!isValidAvatar(c.avatar)) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Invalid avatar on claim entry ${i}`,
          recoverable: false,
        };
      }

      // Coherence checks
      if (c.cardId !== c.state.cardId) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Claim ${i} cardId mismatch with claim state`,
          recoverable: false,
        };
      }
      if (c.avatar !== c.state.avatar) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Claim ${i} avatar mismatch with claim state`,
          recoverable: false,
        };
      }

      const parsedState = parseSidecarState(c.state, { expectedCardId: c.cardId });
      if (!parsedState.ok) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Claim ${i} contains invalid state: ${parsedState.message}`,
          recoverable: false,
        };
      }

      // Amendment B Rule 4: Claim references an avatar that must exist in files
      if (!seenFiles.has(c.avatar)) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Claim ${i} references avatar absent from files observations: ${c.avatar}`,
          recoverable: false,
        };
      }

      // Duplicate cardId check
      if (seenClaimCardIds.has(c.cardId)) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
          message: `Duplicate claim for cardId: ${c.cardId}`,
          recoverable: false,
        };
      }
      seenClaimCardIds.add(c.cardId);

      validatedClaims.push({
        avatar: c.avatar,
        cardId: c.cardId,
        state: parsedState.value,
      });
    }

    const snapshot = deepFreeze({
      claims: validatedClaims,
      files: rawEvidence.files.map((f) => ({ avatar: f.avatar, status: f.status })),
      scanStatus: rawEvidence.scanStatus,
      schemaVersion: 1,
    });

    return {
      ok: true,
      value: snapshot,
    };
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
      message: 'Failed to validate evidence: malformed input',
      recoverable: false,
    };
  }
}

/**
 * Classifies association status of an avatar against synthetic claim snapshot.
 *
 * Success (ok: true):
 * - { ok: true, status: 'BOUND', cardId: string, state: Readonly<SidecarSnapshot> }
 * - { ok: true, status: 'UNBOUND', recoveryAvailable: boolean }
 *
 * Failures (ok: false):
 * - { ok: false, code: 'ASSOCIATION_CONFLICT', ... }
 * - { ok: false, code: 'STORAGE_UNAVAILABLE', ... }
 * - { ok: false, code: 'CARD_NOT_FOUND', ... }
 * - { ok: false, code: 'INVALID_AVATAR' | 'INVALID_EVIDENCE', ... }
 *
 * @param {string} avatar
 * @param {Readonly<SyntheticEvidence>} evidence
 * @returns {HubResult<object>}
 */
export function classifyAssociations(avatar, evidence) {
  try {
    if (!isValidAvatar(avatar)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_AVATAR,
        message: 'Invalid avatar filename',
        recoverable: false,
      };
    }

    const evVal = validateEvidence(evidence);
    if (!evVal.ok) {
      return evVal;
    }
    const validEv = evVal.value;

    if (validEv.scanStatus !== 'COMPLETE') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Storage scan status is incomplete',
        recoverable: false,
      };
    }

    // Find file observation
    const fileObs = validEv.files.find((f) => f.avatar === avatar);
    if (!fileObs || fileObs.status !== 'EXISTS') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.CARD_NOT_FOUND,
        message: `Card avatar not found or missing: ${avatar}`,
        recoverable: false,
      };
    }

    // Filter claims claiming this avatar
    const matchingClaims = validEv.claims.filter((c) => c.avatar === avatar);

    if (matchingClaims.length > 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT,
        message: `Multiple claims detected for avatar: ${avatar}`,
        recoverable: false,
      };
    }

    if (matchingClaims.length === 1) {
      const claim = matchingClaims[0];
      return {
        ok: true,
        status: 'BOUND',
        cardId: claim.cardId,
        state: claim.state,
      };
    }

    // Zero claims -> UNBOUND
    // Check if any valid orphaned claims exist in the store:
    // An orphaned claim has its claim.avatar marked with status 'MISSING' in files.
    const fileMap = new Map(validEv.files.map((f) => [f.avatar, f.status]));
    const recoveryAvailable = validEv.claims.some((c) => fileMap.get(c.avatar) === 'MISSING');

    return {
      ok: true,
      status: 'UNBOUND',
      recoveryAvailable,
    };
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
      message: 'Failed to classify associations: malformed input',
      recoverable: false,
    };
  }
}

/**
 * Pure helper to look up a specific character identity UUID in sidecar state.
 * Strictly read-only. Delegates to H01-B0 resolveIdentity.
 *
 * @param {Readonly<SidecarSnapshot>} state
 * @param {string} identityId
 * @returns {HubResult<Readonly<CharacterRecord>>}
 */
export function resolveSidecarIdentity(state, identityId) {
  try {
    const parsed = parseSidecarState(state);
    if (!parsed.ok) {
      return parsed;
    }
    return resolveIdentity(parsed.value.registry, identityId);
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
      message: 'Failed to resolve identity: malformed input',
      recoverable: false,
    };
  }
}

/**
 * Pure transition planner: creates a fresh sidecar state for an unbound installed card.
 *
 * @param {string} avatar
 * @param {Readonly<SyntheticEvidence>} evidence
 * @param {{ generateCardId?: () => string }} [options]
 * @returns {TransitionResult}
 */
export function planCreateSidecar(avatar, evidence, options = {}) {
  try {
    if (!isValidAvatar(avatar)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_AVATAR,
        message: 'Invalid avatar filename',
        recoverable: false,
      };
    }

    const evVal = validateEvidence(evidence);
    if (!evVal.ok) {
      return evVal;
    }
    const validEv = evVal.value;

    if (validEv.scanStatus !== 'COMPLETE') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Storage scan status is incomplete',
        recoverable: false,
      };
    }

    const fileObs = validEv.files.find((f) => f.avatar === avatar);
    if (!fileObs || fileObs.status !== 'EXISTS') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `Card avatar not found or missing: ${avatar}`,
        recoverable: false,
      };
    }

    const matchingClaims = validEv.claims.filter((c) => c.avatar === avatar);
    if (matchingClaims.length > 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT,
        message: `Multiple claims detected for avatar: ${avatar}`,
        recoverable: false,
      };
    }
    if (matchingClaims.length === 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ALREADY_BOUND,
        message: `Card avatar is already bound to cardId: ${matchingClaims[0].cardId}`,
        recoverable: false,
      };
    }

    // Generate cardId
    let newCardId = null;
    let customGen = null;
    try {
      if (options && typeof options.generateCardId === 'function') {
        customGen = options.generateCardId;
      }
    } catch (_err) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ID_GENERATION_FAILED,
        message: 'Failed to access generateCardId on options',
        recoverable: false,
      };
    }
    if (customGen) {
      try {
        newCardId = customGen();
      } catch (_err) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.ID_GENERATION_FAILED,
          message: 'Injected cardId generator threw an error',
          recoverable: false,
        };
      }
    } else {
      newCardId = generateSecureUuidV4();
    }

    if (typeof newCardId !== 'string' || !UUID_V4_REGEX.test(newCardId)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ID_GENERATION_FAILED,
        message: 'Failed to generate canonical lowercase RFC 4122 v4 UUID',
        recoverable: false,
      };
    }

    // Collision check against synthetic evidence (including orphans)
    if (validEv.claims.some((c) => c.cardId === newCardId)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ID_GENERATION_FAILED,
        message: `Generated cardId collides with existing claim: ${newCardId}`,
        recoverable: false,
      };
    }

    const rawNewState = {
      avatar,
      cardId: newCardId,
      registry: {
        characters: [],
        revision: 0,
        schemaVersion: 1,
      },
      schemaVersion: 1,
      storageRevision: 1,
    };

    const parsed = parseSidecarState(rawNewState);
    if (!parsed.ok) {
      return parsed;
    }

    return {
      ok: true,
      changed: true,
      nextState: parsed.value,
    };
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.INVALID_EVIDENCE,
      message: 'Failed to plan sidecar creation: malformed input',
      recoverable: false,
    };
  }
}

/**
 * Pure transition planner: mutates identity registry under dual-CAS gating.
 * Enforces Binding Amendment A (state/evidence canonical consistency) and B.
 *
 * @param {Readonly<SidecarSnapshot>} state
 * @param {string} cardId
 * @param {string} avatar
 * @param {number} expectedStorageRevision
 * @param {number} expectedRegistryRevision
 * @param {object} command
 * @param {Readonly<SyntheticEvidence>} evidence
 * @returns {TransitionResult}
 */
export function planMutateSidecar(
  state,
  cardId,
  avatar,
  expectedStorageRevision,
  expectedRegistryRevision,
  command,
  evidence
) {
  try {
    const parsedState = parseSidecarState(state);
    if (!parsedState.ok) {
      return parsedState;
    }
    const validState = parsedState.value;

    const evVal = validateEvidence(evidence);
    if (!evVal.ok) {
      return evVal;
    }
    const validEv = evVal.value;

    if (validEv.scanStatus !== 'COMPLETE') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Storage scan status is incomplete',
        recoverable: false,
      };
    }

    if (cardId !== validState.cardId) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.CARD_ID_MISMATCH,
        message: 'Supplied cardId does not match state cardId',
        recoverable: false,
      };
    }

    if (avatar !== validState.avatar) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: 'Supplied avatar does not match state avatar',
        recoverable: false,
      };
    }

    // Check for ambiguous avatar ownership (multiple claimants for source avatar)
    const avatarClaims = validEv.claims.filter((c) => c.avatar === avatar);
    if (avatarClaims.length > 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT,
        message: `Multiple claims detected for avatar: ${avatar}`,
        recoverable: false,
      };
    }

    // Binding Amendment A: Verify supplied state against evidence claim
    const matchingClaims = validEv.claims.filter((c) => c.cardId === cardId);
    if (matchingClaims.length === 0) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `No claim found in evidence for cardId: ${cardId}`,
        recoverable: false,
      };
    }
    const claim = matchingClaims[0];

    if (claim.avatar !== avatar || claim.avatar !== validState.avatar) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: 'Evidence claim avatar is not coherent with caller state',
        recoverable: false,
      };
    }

    // Canonical serialized equality check across all 5 fields
    const callerSerialized = serializeSidecarState(validState);
    const claimSerialized = serializeSidecarState(claim.state);
    if (
      !callerSerialized.ok ||
      !claimSerialized.ok ||
      callerSerialized.value !== claimSerialized.value
    ) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_CONFLICT,
        message: 'Caller state does not match evidence claim state canonical contents',
        recoverable: false,
      };
    }

    // Check file observation for avatar
    const fileObs = validEv.files.find((f) => f.avatar === avatar);
    if (!fileObs || fileObs.status !== 'EXISTS') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `Avatar file is missing or not installed: ${avatar}`,
        recoverable: false,
      };
    }

    // Dual CAS check
    if (validState.storageRevision !== expectedStorageRevision) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_CONFLICT,
        message: `Storage revision conflict: expected ${expectedStorageRevision}, found ${validState.storageRevision}`,
        recoverable: false,
      };
    }

    if (validState.registry.revision !== expectedRegistryRevision) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_CONFLICT,
        message: `Registry revision conflict: expected ${expectedRegistryRevision}, found ${validState.registry.revision}`,
        recoverable: false,
      };
    }

    // Delegate identity registry mutation to H01-B0
    const mutResult = planMutation(validState.registry, command);
    if (!mutResult.ok) {
      return mutResult;
    }

    // Check for exact no-op
    if (mutResult.value.revision === validState.registry.revision) {
      return {
        ok: true,
        changed: false,
        nextState: validState,
      };
    }

    // Genuine change: increment both revisions
    const nextStorageRevision = validState.storageRevision + 1;
    if (!Number.isSafeInteger(nextStorageRevision)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_OVERFLOW,
        message: 'storageRevision safe integer overflow',
        recoverable: false,
      };
    }

    const nextRawState = {
      avatar: validState.avatar,
      cardId: validState.cardId,
      registry: mutResult.value,
      schemaVersion: 1,
      storageRevision: nextStorageRevision,
    };

    const parsedNext = parseSidecarState(nextRawState);
    if (!parsedNext.ok) {
      return parsedNext;
    }

    return {
      ok: true,
      changed: true,
      nextState: parsedNext.value,
    };
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.INVALID_COMMAND,
      message: 'Failed to plan sidecar mutation: malformed input',
      recoverable: false,
    };
  }
}

/**
 * Pure transition planner: rebinds an existing cardId to a new avatar locator.
 * Enforces Binding Amendment A and B.
 *
 * @param {Readonly<SidecarSnapshot>} state
 * @param {string} cardId
 * @param {string} fromAvatar
 * @param {string} toAvatar
 * @param {number} expectedStorageRevision
 * @param {Readonly<SyntheticEvidence>} evidence
 * @returns {TransitionResult}
 */
export function planRebindSidecar(
  state,
  cardId,
  fromAvatar,
  toAvatar,
  expectedStorageRevision,
  evidence
) {
  try {
    const parsedState = parseSidecarState(state);
    if (!parsedState.ok) {
      return parsedState;
    }
    const validState = parsedState.value;

    if (!isValidAvatar(fromAvatar) || !isValidAvatar(toAvatar)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_AVATAR,
        message: 'Invalid fromAvatar or toAvatar filename',
        recoverable: false,
      };
    }

    const evVal = validateEvidence(evidence);
    if (!evVal.ok) {
      return evVal;
    }
    const validEv = evVal.value;

    if (validEv.scanStatus !== 'COMPLETE') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Storage scan status is incomplete',
        recoverable: false,
      };
    }

    if (cardId !== validState.cardId) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.CARD_ID_MISMATCH,
        message: 'Supplied cardId does not match state cardId',
        recoverable: false,
      };
    }

    if (validState.avatar !== fromAvatar) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: 'Supplied fromAvatar does not match state avatar',
        recoverable: false,
      };
    }

    // Check for ambiguous fromAvatar ownership (multiple claimants for fromAvatar)
    const fromClaims = validEv.claims.filter((c) => c.avatar === fromAvatar);
    if (fromClaims.length > 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT,
        message: `Multiple claims detected for fromAvatar: ${fromAvatar}`,
        recoverable: false,
      };
    }

    // Binding Amendment A: Verify supplied state against evidence claim
    const matchingClaims = validEv.claims.filter((c) => c.cardId === cardId);
    if (matchingClaims.length === 0) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `No claim found in evidence for cardId: ${cardId}`,
        recoverable: false,
      };
    }
    const claim = matchingClaims[0];

    if (claim.avatar !== fromAvatar || claim.avatar !== validState.avatar) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: 'Evidence claim avatar is not coherent with fromAvatar',
        recoverable: false,
      };
    }

    const callerSerialized = serializeSidecarState(validState);
    const claimSerialized = serializeSidecarState(claim.state);
    if (
      !callerSerialized.ok ||
      !claimSerialized.ok ||
      callerSerialized.value !== claimSerialized.value
    ) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_CONFLICT,
        message: 'Caller state does not match evidence claim state canonical contents',
        recoverable: false,
      };
    }

    // CAS check
    if (validState.storageRevision !== expectedStorageRevision) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_CONFLICT,
        message: `Storage revision conflict: expected ${expectedStorageRevision}, found ${validState.storageRevision}`,
        recoverable: false,
      };
    }

    // Amendment B: Explicit file observations required
    const fromFileObs = validEv.files.find((f) => f.avatar === fromAvatar);
    const toFileObs = validEv.files.find((f) => f.avatar === toAvatar);

    if (!fromFileObs) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `Missing file observation for fromAvatar: ${fromAvatar}`,
        recoverable: false,
      };
    }
    if (!toFileObs) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `Missing file observation for toAvatar: ${toAvatar}`,
        recoverable: false,
      };
    }

    // Coherent No-Op check: fromAvatar === toAvatar
    if (fromAvatar === toAvatar) {
      if (fromFileObs.status !== 'EXISTS') {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
          message: 'Cannot rebind no-op when avatar is missing',
          recoverable: false,
        };
      }
      return {
        ok: true,
        changed: false,
        nextState: validState,
      };
    }

    // Different avatars:
    // If fromAvatar STILL EXISTS on disk:
    if (fromFileObs.status === 'EXISTS') {
      if (toFileObs.status === 'EXISTS') {
        // Both old and new exist -> DUPLICATE_NOT_RENAME
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.DUPLICATE_NOT_RENAME,
          message: 'Both old and new avatars exist on disk; duplicate must use clone, not rebind',
          recoverable: false,
        };
      }
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `fromAvatar still exists on disk; cannot rebind non-orphaned card: ${fromAvatar}`,
        recoverable: false,
      };
    }

    // fromAvatar must be MISSING
    if (fromFileObs.status !== 'MISSING') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `fromAvatar must be observed as MISSING: ${fromAvatar}`,
        recoverable: false,
      };
    }

    // toAvatar must be EXISTS and UNCLAIMED
    if (toFileObs.status !== 'EXISTS') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `toAvatar does not exist on disk: ${toAvatar}`,
        recoverable: false,
      };
    }

    const toClaims = validEv.claims.filter((c) => c.avatar === toAvatar);
    if (toClaims.length > 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT,
        message: `Multiple claims detected for toAvatar: ${toAvatar}`,
        recoverable: false,
      };
    }
    if (toClaims.length === 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ALREADY_BOUND,
        message: `toAvatar is already claimed by cardId: ${toClaims[0].cardId}`,
        recoverable: false,
      };
    }

    // Plan rebind: bump storageRevision only; registry contents and revision UNCHANGED
    const nextStorageRevision = validState.storageRevision + 1;
    if (!Number.isSafeInteger(nextStorageRevision)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_OVERFLOW,
        message: 'storageRevision safe integer overflow',
        recoverable: false,
      };
    }

    const rawReboundState = {
      avatar: toAvatar,
      cardId: validState.cardId,
      registry: cloneRegistry(validState.registry),
      schemaVersion: 1,
      storageRevision: nextStorageRevision,
    };

    const parsed = parseSidecarState(rawReboundState);
    if (!parsed.ok) {
      return parsed;
    }

    return {
      ok: true,
      changed: true,
      nextState: parsed.value,
    };
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
      message: 'Failed to plan sidecar rebind: malformed input',
      recoverable: false,
    };
  }
}

/**
 * Pure transition planner: clones an existing sidecar to a new unbound target avatar.
 * Enforces Binding Amendment A and B. Source state retains its freeze state.
 *
 * @param {Readonly<SidecarSnapshot>} sourceState
 * @param {string} sourceCardId
 * @param {string} sourceAvatar
 * @param {string} targetAvatar
 * @param {number} expectedSourceStorageRevision
 * @param {Readonly<SyntheticEvidence>} evidence
 * @param {{ generateCardId?: () => string }} [options]
 * @returns {TransitionResult}
 */
export function planCloneSidecar(
  sourceState,
  sourceCardId,
  sourceAvatar,
  targetAvatar,
  expectedSourceStorageRevision,
  evidence,
  options = {}
) {
  try {
    const parsedSource = parseSidecarState(sourceState);
    if (!parsedSource.ok) {
      return parsedSource;
    }
    const validSource = parsedSource.value;

    if (!isValidAvatar(sourceAvatar) || !isValidAvatar(targetAvatar)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.INVALID_AVATAR,
        message: 'Invalid sourceAvatar or targetAvatar filename',
        recoverable: false,
      };
    }

    if (sourceAvatar === targetAvatar) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ALREADY_BOUND,
        message: 'targetAvatar cannot be identical to sourceAvatar on clone',
        recoverable: false,
      };
    }

    const evVal = validateEvidence(evidence);
    if (!evVal.ok) {
      return evVal;
    }
    const validEv = evVal.value;

    if (validEv.scanStatus !== 'COMPLETE') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Storage scan status is incomplete',
        recoverable: false,
      };
    }

    if (sourceCardId !== validSource.cardId) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.CARD_ID_MISMATCH,
        message: 'Supplied sourceCardId does not match sourceState cardId',
        recoverable: false,
      };
    }

    if (sourceAvatar !== validSource.avatar) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: 'Supplied sourceAvatar does not match sourceState avatar',
        recoverable: false,
      };
    }

    // Check for ambiguous source avatar ownership
    const sourceClaims = validEv.claims.filter((c) => c.avatar === sourceAvatar);
    if (sourceClaims.length > 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT,
        message: `Multiple claims detected for source avatar: ${sourceAvatar}`,
        recoverable: false,
      };
    }

    // Binding Amendment A: Verify source state against evidence claim
    const matchingClaims = validEv.claims.filter((c) => c.cardId === sourceCardId);
    if (matchingClaims.length === 0) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `No claim found in evidence for sourceCardId: ${sourceCardId}`,
        recoverable: false,
      };
    }
    const claim = matchingClaims[0];

    if (claim.avatar !== sourceAvatar || claim.avatar !== validSource.avatar) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: 'Evidence claim avatar is not coherent with sourceState',
        recoverable: false,
      };
    }

    const callerSerialized = serializeSidecarState(validSource);
    const claimSerialized = serializeSidecarState(claim.state);
    if (
      !callerSerialized.ok ||
      !claimSerialized.ok ||
      callerSerialized.value !== claimSerialized.value
    ) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_CONFLICT,
        message: 'Source state does not match evidence claim state canonical contents',
        recoverable: false,
      };
    }

    // CAS check
    if (validSource.storageRevision !== expectedSourceStorageRevision) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.REVISION_CONFLICT,
        message: `Storage revision conflict on source: expected ${expectedSourceStorageRevision}, found ${validSource.storageRevision}`,
        recoverable: false,
      };
    }

    // Amendment B: Explicit file observations required
    const sourceFileObs = validEv.files.find((f) => f.avatar === sourceAvatar);
    const targetFileObs = validEv.files.find((f) => f.avatar === targetAvatar);

    if (!sourceFileObs || sourceFileObs.status !== 'EXISTS') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `Source avatar file does not exist on disk: ${sourceAvatar}`,
        recoverable: false,
      };
    }

    if (!targetFileObs || targetFileObs.status !== 'EXISTS') {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
        message: `Target avatar file does not exist on disk: ${targetAvatar}`,
        recoverable: false,
      };
    }

    // targetAvatar must be UNCLAIMED
    const targetClaims = validEv.claims.filter((c) => c.avatar === targetAvatar);
    if (targetClaims.length > 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT,
        message: `Multiple claims detected for target avatar: ${targetAvatar}`,
        recoverable: false,
      };
    }
    if (targetClaims.length === 1) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ALREADY_BOUND,
        message: `Target avatar is already claimed by cardId: ${targetClaims[0].cardId}`,
        recoverable: false,
      };
    }

    // Generate targetCardId
    let targetCardId = null;
    let customGen = null;
    try {
      if (options && typeof options.generateCardId === 'function') {
        customGen = options.generateCardId;
      }
    } catch (_err) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ID_GENERATION_FAILED,
        message: 'Failed to access generateCardId on options',
        recoverable: false,
      };
    }
    if (customGen) {
      try {
        targetCardId = customGen();
      } catch (_err) {
        return {
          ok: false,
          code: SIDECAR_ERROR_CODES.ID_GENERATION_FAILED,
          message: 'Injected cardId generator threw an error',
          recoverable: false,
        };
      }
    } else {
      targetCardId = generateSecureUuidV4();
    }

    if (typeof targetCardId !== 'string' || !UUID_V4_REGEX.test(targetCardId)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ID_GENERATION_FAILED,
        message: 'Failed to generate canonical lowercase RFC 4122 v4 UUID for clone',
        recoverable: false,
      };
    }

    // Collision check against synthetic evidence (including orphans)
    if (validEv.claims.some((c) => c.cardId === targetCardId)) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.ID_GENERATION_FAILED,
        message: `Generated targetCardId collides with existing claim: ${targetCardId}`,
        recoverable: false,
      };
    }

    // Copy registry byte-for-byte in canonical meaning:
    // Retaining registry.revision and all character UUIDs
    const rawTargetState = {
      avatar: targetAvatar,
      cardId: targetCardId,
      registry: cloneRegistry(validSource.registry),
      schemaVersion: 1,
      storageRevision: 1,
    };

    const parsedTarget = parseSidecarState(rawTargetState);
    if (!parsedTarget.ok) {
      return parsedTarget;
    }

    return {
      ok: true,
      changed: true,
      nextState: parsedTarget.value,
    };
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR,
      message: 'Failed to plan sidecar clone: malformed input',
      recoverable: false,
    };
  }
}

/**
 * Deterministically serializes sidecar state to canonical JSON.
 * Enforces 300 KiB outer cap and 256 KiB inner registry cap.
 *
 * @param {Readonly<SidecarSnapshot>} state
 * @returns {HubResult<string>}
 */
export function serializeSidecarState(state) {
  try {
    const parsed = parseSidecarState(state);
    if (!parsed.ok) {
      return parsed;
    }
    const validState = parsed.value;

    // Validate inner registry serializability
    const innerSer = serializeRegistry(validState.registry);
    if (!innerSer.ok) {
      return innerSer;
    }

    const str = canonicalStringify({
      avatar: validState.avatar,
      cardId: validState.cardId,
      registry: validState.registry,
      schemaVersion: 1,
      storageRevision: validState.storageRevision,
    });

    const bytes = getUtf8ByteLength(str);
    if (bytes > MAX_SIDECAR_BYTES) {
      return {
        ok: false,
        code: SIDECAR_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
        message: `Serialized sidecar state (${bytes} bytes) exceeds 300 KiB limit`,
        recoverable: false,
      };
    }

    return {
      ok: true,
      value: str,
    };
  } catch (_err) {
    return {
      ok: false,
      code: SIDECAR_ERROR_CODES.INVALID_SCHEMA,
      message: 'Failed to serialize sidecar state: malformed input',
      recoverable: false,
    };
  }
}
