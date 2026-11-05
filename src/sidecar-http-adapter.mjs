/**
 * SillyTavern-ChromaticHub: Sidecar HTTP Adapter (H01-B3-D2-D)
 *
 * Implements versioned HTTP transport (/api/plugins/chromatic-hub/v1) delegating
 * exclusively to the C2 transaction controller (createSidecarController).
 *
 * Invariants:
 * - Single-process, per-user trusted-root model strictly derived from req.user.directories.
 * - Single active mutator per userRoot with monotonic lockout on abnormal settlement.
 * - Bounded request inspection (depth <= 32, node budget <= 2048, post-parse <= 384 KiB).
 * - Exact allowlisted C2 success envelope projection with C0 registry verification.
 * - Own-key safe error specification mapping with zero path/trace reflection.
 * - Native writes disabled by default (writeEnabled: false).
 * - Dependency-free ES module.
 */

import path from 'node:path';
import { parseRegistry } from './identity-registry.mjs';
import { isValidAvatar } from './sidecar-file-store.mjs';

// --- Constants & RegExps ---

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;

const MAX_ALLOWED_DEPTH = 32;
const MAX_NODE_BUDGET = 2048;
const MAX_BODY_BYTES = 393216; // 384 KiB

// --- Error Specifications & Allowlist ---

export const C2_ERROR_SPECIFICATIONS = Object.freeze(Object.assign(Object.create(null), {
  INVALID_REQUEST: Object.freeze({ status: 400, message: 'Invalid request parameters', recoverable: false }),
  INVALID_CONTEXT: Object.freeze({ status: 503, message: 'Invalid context directories', recoverable: false }),
  INVALID_AVATAR: Object.freeze({ status: 400, message: 'Invalid avatar filename', recoverable: false }),
  INVALID_CARD_ID: Object.freeze({ status: 400, message: 'Invalid cardId UUID v4', recoverable: false }),
  CARD_NOT_FOUND: Object.freeze({ status: 404, message: 'Target avatar file not found', recoverable: false }),
  STATE_NOT_FOUND: Object.freeze({ status: 404, message: 'Sidecar state not found in <userRoot>/chromaticHub/cards/<cardId>/state.json', recoverable: false }),
  ALREADY_BOUND: Object.freeze({ status: 409, message: 'Card avatar is already bound', recoverable: false }),
  ASSOCIATION_CONFLICT: Object.freeze({ status: 409, message: 'Conflicting association claims detected', recoverable: false }),
  REVISION_CONFLICT: Object.freeze({ status: 409, message: 'Storage revision conflict', recoverable: true }),
  STALE_CARD_LOCATOR: Object.freeze({ status: 409, message: 'Card avatar locator is stale', recoverable: false }),
  DUPLICATE_NOT_RENAME: Object.freeze({ status: 409, message: 'Duplicate avatar detected; operation is not a rename', recoverable: false }),
  STORAGE_UNAVAILABLE: Object.freeze({ status: 503, message: 'Sidecar storage is unavailable', recoverable: false }),
  WRITE_FAILED: Object.freeze({ status: 500, message: 'Sidecar write failed', recoverable: false }),
  WRITE_UNCERTAIN: Object.freeze({ status: 503, message: 'Sidecar write outcome is uncertain; card quarantined', recoverable: false }),
  OPERATION_CANCELLED: Object.freeze({ status: 409, message: 'Operation was cancelled', recoverable: true }),
  INVALID_SCHEMA: Object.freeze({ status: 422, message: 'Invalid schema or unparseable state', recoverable: false }),
  BYTE_LIMIT_EXCEEDED: Object.freeze({ status: 413, message: 'Sidecar byte limit exceeded', recoverable: false }),
  UNSUPPORTED_VERSION: Object.freeze({ status: 409, message: 'Unsupported sidecar schema version', recoverable: false }),
}));

export const ADAPTER_ERROR_SPECIFICATIONS = Object.freeze(Object.assign(Object.create(null), {
  WRITES_DISABLED: Object.freeze({ status: 403, message: 'Sidecar mutations are disabled by policy', recoverable: false }),
  HTTP_DISABLED: Object.freeze({ status: 503, message: 'ChromaticHub HTTP API is disabled', recoverable: false }),
  SERVICE_CLOSING: Object.freeze({ status: 503, message: 'ChromaticHub plugin is shutting down', recoverable: false }),
  SERVICE_BUSY: Object.freeze({ status: 503, message: 'Service is busy; concurrency limit reached', recoverable: false }),
  UNSUPPORTED_MEDIA_TYPE: Object.freeze({ status: 415, message: 'Content-Type must be application/json', recoverable: false }),
  MUTATIONS_LOCKED: Object.freeze({ status: 503, message: 'Mutations locked due to prior unhandled write outcome', recoverable: false }),
  INTERNAL_ERROR: Object.freeze({ status: 500, message: 'Internal server error', recoverable: false }),
}));

const INTERNAL_DIAGNOSTIC_ALLOWLIST = new Set([
  'QUARANTINE_ACTIVE',
  'UNHANDLED_WRITE_ERROR',
  'MALFORMED_WRITE_RESULT',
  'READBACK_FAILED',
  'READBACK_MISMATCH',
  'CAS_MISMATCH',
  'INCOMPLETE_STORE',
  'OPERATION_CANCELLED',
  'INVALID_PARAMETERS',
  'INVALID_CONTEXT_PATH',
  'TARGET_ALREADY_BOUND',
  'ASSOCIATION_CONFLICT',
  'DUPLICATE_NOT_RENAME',
  'STALE_LOCATOR',
  'STORAGE_UNAVAILABLE',
  'IO_ERROR',
  'TARGET_FILE_MISSING',
]);

// Exported public allowlist is a frozen Array, preventing internal Set slot mutations
export const OUTWARD_DIAGNOSTIC_ALLOWLIST = Object.freeze(Array.from(INTERNAL_DIAGNOSTIC_ALLOWLIST));

// --- Property & Content-Type Helpers ---

export function getOwnDataProperty(obj, prop) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { present: false };
  }
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(obj, prop);
  } catch (_err) {
    return { present: false, error: true };
  }
  if (!desc || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
    return { present: false };
  }
  return { present: true, value: desc.value };
}

export function isValidJsonContentType(header) {
  if (typeof header !== 'string') return false;
  const parts = header.split(';').map((p) => p.trim());
  if (parts.length === 0) return false;
  if (parts[0].toLowerCase() !== 'application/json') {
    return false;
  }
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i];
    if (!param) continue;
    const eqIdx = param.indexOf('=');
    if (eqIdx === -1) return false;
    const key = param.slice(0, eqIdx).trim().toLowerCase();
    const val = param.slice(eqIdx + 1).trim().toLowerCase().replace(/^"|"$/g, '');
    if (key === 'charset') {
      if (val !== 'utf-8') return false;
    } else {
      return false;
    }
  }
  return true;
}

// --- Admission & Lockout Gates ---

export class ConcurrencyAdmissionGate {
  constructor({ maxGlobal = 32, maxPerUser = 4 } = {}) {
    if (typeof maxGlobal !== 'number' || !Number.isSafeInteger(maxGlobal) || maxGlobal < 1 || maxGlobal > 32) {
      throw new TypeError('maxGlobal must be a safe integer between 1 and 32');
    }
    if (typeof maxPerUser !== 'number' || !Number.isSafeInteger(maxPerUser) || maxPerUser < 1 || maxPerUser > Math.min(4, maxGlobal)) {
      throw new TypeError('maxPerUser must be a safe integer between 1 and Math.min(4, maxGlobal)');
    }
    this.maxGlobal = maxGlobal;
    this.maxPerUser = maxPerUser;
    this.globalInFlight = 0;
    this.userInFlight = new Map();
    this.activeMutatorUsers = new Set();
  }

  tryAcquire(userRoot, isMutator) {
    if (this.globalInFlight >= this.maxGlobal) {
      return { allowed: false, status: 503, code: 'SERVICE_BUSY', reason: 'GLOBAL_SATURATED' };
    }
    const current = this.userInFlight.get(userRoot) || 0;
    if (current >= this.maxPerUser) {
      return { allowed: false, status: 503, code: 'SERVICE_BUSY', reason: 'USER_SATURATED' };
    }

    if (isMutator) {
      if (this.activeMutatorUsers.has(userRoot)) {
        return { allowed: false, status: 503, code: 'SERVICE_BUSY', reason: 'USER_MUTATOR_ACTIVE' };
      }
      this.activeMutatorUsers.add(userRoot);
    }

    this.globalInFlight++;
    this.userInFlight.set(userRoot, current + 1);
    return { allowed: true };
  }

  release(userRoot, isMutator) {
    if (isMutator) {
      this.activeMutatorUsers.delete(userRoot);
    }

    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    const current = this.userInFlight.get(userRoot) || 1;
    if (current <= 1) {
      this.userInFlight.delete(userRoot);
    } else {
      this.userInFlight.set(userRoot, current - 1);
    }
  }
}

export class MutatorLockoutGate {
  constructor() {
    this.lockedUsers = new Set();
  }

  lock(userRoot) {
    this.lockedUsers.add(userRoot);
  }

  isLocked(userRoot) {
    return this.lockedUsers.has(userRoot);
  }
}

// --- Context & Request Inspection ---

export function extractTrustedContext(req) {
  try {
    if (!req || typeof req !== 'object') {
      return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'Invalid request object' };
    }
    const user = req.user;
    if (!user || typeof user !== 'object') {
      return { ok: false, status: 403, code: 'INVALID_REQUEST', message: 'Authentication required' };
    }
    const directories = user.directories;
    if (!directories || typeof directories !== 'object') {
      return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'User directories missing' };
    }
    const userRoot = directories.root;
    const charactersRoot = directories.characters;
    if (typeof userRoot !== 'string' || typeof charactersRoot !== 'string') {
      return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'Directory paths must be strings' };
    }
    if (userRoot.trim().length === 0 || charactersRoot.trim().length === 0) {
      return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'Directory paths cannot be empty' };
    }
    if (CONTROL_CHARS_REGEX.test(userRoot) || userRoot.includes('\0') || CONTROL_CHARS_REGEX.test(charactersRoot) || charactersRoot.includes('\0')) {
      return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'Control characters forbidden in paths' };
    }
    if (!path.isAbsolute(userRoot) || !path.isAbsolute(charactersRoot)) {
      return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'Directory paths must be absolute' };
    }
    const rawUserSegments = userRoot.split(/[/\\]+/);
    const rawCharSegments = charactersRoot.split(/[/\\]+/);
    if (rawUserSegments.includes('..') || rawCharSegments.includes('..')) {
      return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'Traversal segments forbidden in paths' };
    }
    const resolvedUserRoot = path.resolve(userRoot);
    const resolvedCharRoot = path.resolve(charactersRoot);
    const relativePath = path.relative(resolvedUserRoot, resolvedCharRoot);
    if (!relativePath || relativePath === '.' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'Characters directory must be nested in user root' };
    }
    return {
      ok: true,
      context: Object.freeze({
        userRoot: resolvedUserRoot,
        charactersRoot: resolvedCharRoot,
      }),
    };
  } catch (_err) {
    return { ok: false, status: 503, code: 'INVALID_CONTEXT', message: 'Invalid context directories' };
  }
}

export function inspectRequestStructure(body, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_ALLOWED_DEPTH;
  const maxNodeBudget = options.maxNodeBudget ?? MAX_NODE_BUDGET;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  try {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Body must be a plain object' };
    }
    const rootProto = Object.getPrototypeOf(body);
    if (rootProto !== Object.prototype && rootProto !== null) {
      return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Body must be a plain object' };
    }

    let nodeCount = 0;
    let accumulatedBytes = 0;
    const visited = new Set();

    function traverse(current, depth) {
      if (depth > maxDepth) {
        throw new RangeError('DEPTH_LIMIT_EXCEEDED');
      }
      nodeCount++;
      if (nodeCount > maxNodeBudget) {
        throw new RangeError('NODE_BUDGET_EXCEEDED');
      }

      if (current === null) {
        accumulatedBytes += 4;
        if (accumulatedBytes > maxBodyBytes) throw new RangeError('BYTE_LIMIT_EXCEEDED');
        return null;
      }
      const type = typeof current;
      if (type === 'boolean') {
        accumulatedBytes += current ? 4 : 5;
        if (accumulatedBytes > maxBodyBytes) throw new RangeError('BYTE_LIMIT_EXCEEDED');
        return current;
      }
      if (type === 'number') {
        if (!Number.isFinite(current)) throw new TypeError('NON_FINITE_NUMBER');
        accumulatedBytes += 25;
        if (accumulatedBytes > maxBodyBytes) throw new RangeError('BYTE_LIMIT_EXCEEDED');
        return current;
      }
      if (type === 'string') {
        accumulatedBytes += Buffer.byteLength(current, 'utf8');
        if (accumulatedBytes > maxBodyBytes) throw new RangeError('BYTE_LIMIT_EXCEEDED');
        return current;
      }
      if (type === 'function' || type === 'symbol' || type === 'bigint' || type === 'undefined') {
        throw new TypeError('FORBIDDEN_DATA_TYPE');
      }
      if (type !== 'object') {
        throw new TypeError('INVALID_DATA_TYPE');
      }

      if (visited.has(current)) {
        throw new TypeError('CIRCULAR_STRUCTURE_DETECTED');
      }
      visited.add(current);

      if (Array.isArray(current)) {
        const proto = Object.getPrototypeOf(current);
        if (proto !== Array.prototype) throw new TypeError('INVALID_ARRAY_PROTOTYPE');

        const len = current.length;
        if (!Number.isSafeInteger(len) || len < 0 || len > maxNodeBudget) {
          throw new RangeError('INVALID_ARRAY_LENGTH');
        }

        let propNames;
        let propSymbols;
        try {
          propNames = Object.getOwnPropertyNames(current);
          propSymbols = Object.getOwnPropertySymbols(current);
        } catch (_err) {
          throw new TypeError('ARRAY_INSPECTION_FAILED');
        }
        if (propSymbols.length > 0) throw new TypeError('SYMBOL_KEYS_FORBIDDEN');

        if (propNames.length !== len + 1) throw new TypeError('SPARSE_OR_EXTRANEOUS_ARRAY_PROPERTIES');

        const lenDesc = Object.getOwnPropertyDescriptor(current, 'length');
        if (!lenDesc || lenDesc.get !== undefined || lenDesc.set !== undefined || lenDesc.enumerable) {
          throw new TypeError('INVALID_LENGTH_DESCRIPTOR');
        }

        const safeArr = [];
        for (let i = 0; i < len; i++) {
          const key = String(i);
          let desc;
          try {
            desc = Object.getOwnPropertyDescriptor(current, key);
          } catch (_err) {
            throw new TypeError('ARRAY_DESCRIPTOR_FAILED');
          }
          if (!desc || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
            throw new TypeError('INVALID_ARRAY_ELEMENT_DESCRIPTOR');
          }
          safeArr.push(traverse(desc.value, depth + 1));
        }
        return safeArr;
      }

      // Plain Object
      const proto = Object.getPrototypeOf(current);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('OBJECT_MUST_BE_PLAIN');
      }

      let propNames;
      let propSymbols;
      try {
        propNames = Object.getOwnPropertyNames(current);
        propSymbols = Object.getOwnPropertySymbols(current);
      } catch (_err) {
        throw new TypeError('OBJECT_INSPECTION_FAILED');
      }
      if (propSymbols.length > 0) throw new TypeError('SYMBOL_KEYS_FORBIDDEN');

      const safeObj = proto === null ? Object.create(null) : {};
      for (const key of propNames) {
        if (key === '__proto__') {
          throw new TypeError('FORBIDDEN_KEY');
        }
        accumulatedBytes += Buffer.byteLength(key, 'utf8') + 3;
        if (accumulatedBytes > maxBodyBytes) throw new RangeError('BYTE_LIMIT_EXCEEDED');

        let desc;
        try {
          desc = Object.getOwnPropertyDescriptor(current, key);
        } catch (_err) {
          throw new TypeError('OBJECT_DESCRIPTOR_FAILED');
        }
        if (!desc || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
          throw new TypeError('ACCESSORS_OR_NON_ENUMERABLE_FORBIDDEN');
        }
        safeObj[key] = traverse(desc.value, depth + 1);
      }
      return safeObj;
    }

    const safeSnapshot = traverse(body, 1);

    // Serialization check operates strictly on the detached safe snapshot
    const serialized = JSON.stringify(safeSnapshot);
    if (Buffer.byteLength(serialized, 'utf8') > maxBodyBytes) {
      return { ok: false, status: 413, code: 'BYTE_LIMIT_EXCEEDED', message: 'Sidecar byte limit exceeded' };
    }

    return { ok: true, snapshot: safeSnapshot };
  } catch (err) {
    if (err instanceof RangeError && err.message === 'BYTE_LIMIT_EXCEEDED') {
      return { ok: false, status: 413, code: 'BYTE_LIMIT_EXCEEDED', message: 'Sidecar byte limit exceeded' };
    }
    return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Invalid request parameters' };
  }
}

// --- Request Validation & Parameter Sanitization (Pre-Admission) ---

export function validateAndSanitizeRequestBody(route, body, limits) {
  try {
    const structRes = inspectRequestStructure(body, limits);
    if (!structRes.ok) {
      return structRes;
    }
    const safeBody = structRes.snapshot;

    const keys = Object.keys(safeBody);
    for (const key of keys) {
      if (!route.allowedKeys.includes(key)) {
        return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Unexpected request parameter' };
      }
    }

    const sanitizedParams = {};

    if (route.name === 'resolve' || route.name === 'recoveryCandidates' || route.name === 'create') {
      const avatar = safeBody.avatar;
      if (typeof avatar !== 'string' || !isValidAvatar(avatar)) {
        return { ok: false, status: 400, code: 'INVALID_AVATAR', message: 'Invalid avatar filename' };
      }
      sanitizedParams.avatar = avatar;
    } else if (route.name === 'mutate') {
      const cardId = safeBody.cardId;
      if (typeof cardId !== 'string' || !UUID_V4_REGEX.test(cardId)) {
        return { ok: false, status: 400, code: 'INVALID_CARD_ID', message: 'Invalid cardId UUID v4' };
      }
      const avatar = safeBody.avatar;
      if (typeof avatar !== 'string' || !isValidAvatar(avatar)) {
        return { ok: false, status: 400, code: 'INVALID_AVATAR', message: 'Invalid avatar filename' };
      }
      const storageRev = safeBody.expectedStorageRevision;
      if (typeof storageRev !== 'number' || !Number.isSafeInteger(storageRev) || storageRev < 1) {
        return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Invalid expectedStorageRevision' };
      }
      const regRev = safeBody.expectedRegistryRevision;
      if (typeof regRev !== 'number' || !Number.isSafeInteger(regRev) || regRev < 0) {
        return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Invalid expectedRegistryRevision' };
      }
      const command = safeBody.command;
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Command must be a plain object' };
      }
      // Detached snapshot already isolates command safely without raw JSON.stringify
      sanitizedParams.cardId = cardId;
      sanitizedParams.avatar = avatar;
      sanitizedParams.expectedStorageRevision = storageRev;
      sanitizedParams.expectedRegistryRevision = regRev;
      sanitizedParams.command = command;
    } else if (route.name === 'rebind') {
      const cardId = safeBody.cardId;
      if (typeof cardId !== 'string' || !UUID_V4_REGEX.test(cardId)) {
        return { ok: false, status: 400, code: 'INVALID_CARD_ID', message: 'Invalid cardId UUID v4' };
      }
      const fromAvatar = safeBody.fromAvatar;
      if (typeof fromAvatar !== 'string' || !isValidAvatar(fromAvatar)) {
        return { ok: false, status: 400, code: 'INVALID_AVATAR', message: 'Invalid fromAvatar filename' };
      }
      const toAvatar = safeBody.toAvatar;
      if (typeof toAvatar !== 'string' || !isValidAvatar(toAvatar)) {
        return { ok: false, status: 400, code: 'INVALID_AVATAR', message: 'Invalid toAvatar filename' };
      }
      const storageRev = safeBody.expectedStorageRevision;
      if (typeof storageRev !== 'number' || !Number.isSafeInteger(storageRev) || storageRev < 1) {
        return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Invalid expectedStorageRevision' };
      }
      sanitizedParams.cardId = cardId;
      sanitizedParams.fromAvatar = fromAvatar;
      sanitizedParams.toAvatar = toAvatar;
      sanitizedParams.expectedStorageRevision = storageRev;
    } else if (route.name === 'clone') {
      const sourceCardId = safeBody.sourceCardId;
      if (typeof sourceCardId !== 'string' || !UUID_V4_REGEX.test(sourceCardId)) {
        return { ok: false, status: 400, code: 'INVALID_CARD_ID', message: 'Invalid sourceCardId UUID v4' };
      }
      const sourceAvatar = safeBody.sourceAvatar;
      if (typeof sourceAvatar !== 'string' || !isValidAvatar(sourceAvatar)) {
        return { ok: false, status: 400, code: 'INVALID_AVATAR', message: 'Invalid sourceAvatar filename' };
      }
      const targetAvatar = safeBody.targetAvatar;
      if (typeof targetAvatar !== 'string' || !isValidAvatar(targetAvatar)) {
        return { ok: false, status: 400, code: 'INVALID_AVATAR', message: 'Invalid targetAvatar filename' };
      }
      const storageRev = safeBody.expectedSourceStorageRevision;
      if (typeof storageRev !== 'number' || !Number.isSafeInteger(storageRev) || storageRev < 1) {
        return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Invalid expectedSourceStorageRevision' };
      }
      sanitizedParams.sourceCardId = sourceCardId;
      sanitizedParams.sourceAvatar = sourceAvatar;
      sanitizedParams.targetAvatar = targetAvatar;
      sanitizedParams.expectedSourceStorageRevision = storageRev;
    } else {
      return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Unknown route' };
    }

    return { ok: true, params: Object.freeze(sanitizedParams) };
  } catch (_err) {
    return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Invalid request parameters' };
  }
}

// --- Validation & Envelope Projection ---

function validateQuarantineActive(value) {
  if (!Object.hasOwn(value, 'quarantineActive')) {
    return { ok: true, active: false };
  }
  const qProp = getOwnDataProperty(value, 'quarantineActive');
  if (!qProp.present) return { ok: false };
  if (qProp.value === true) {
    return { ok: true, active: true };
  }
  return { ok: false };
}

export function validateAndProjectSuccess(route, requestParams, c2Result) {
  try {
    if (!c2Result || typeof c2Result !== 'object' || Array.isArray(c2Result)) {
      return { classified: false, error: 'MALFORMED_SUCCESS_STRUCTURE' };
    }

    const okProp = getOwnDataProperty(c2Result, 'ok');
    if (!okProp.present || okProp.value !== true) {
      return { classified: false, error: 'MALFORMED_OK_PROPERTY' };
    }

    const valueProp = getOwnDataProperty(c2Result, 'value');
    if (!valueProp.present || !valueProp.value || typeof valueProp.value !== 'object' || Array.isArray(valueProp.value)) {
      return { classified: false, error: 'MALFORMED_VALUE_PROPERTY' };
    }
    const value = valueProp.value;

    const isMutatorRoute = ['create', 'mutate', 'rebind', 'clone'].includes(route);
    const changedProp = getOwnDataProperty(c2Result, 'changed');

    if (isMutatorRoute) {
      if (!changedProp.present || typeof changedProp.value !== 'boolean') {
        return { classified: false, error: 'MUTATOR_CHANGED_PROPERTY_REQUIRED' };
      }
    } else {
      if (changedProp.present || Object.hasOwn(c2Result, 'changed')) {
        return { classified: false, error: 'READ_OPERATION_CANNOT_HAVE_CHANGED' };
      }
    }

    if (route === 'resolve') {
      const pAvatar = getOwnDataProperty(value, 'avatar');
      if (!pAvatar.present || pAvatar.value !== requestParams.avatar || !isValidAvatar(pAvatar.value)) {
        return { classified: false, error: 'AVATAR_LOCATOR_MISMATCH' };
      }

      const qCheck = validateQuarantineActive(value);
      if (!qCheck.ok) return { classified: false, error: 'MALFORMED_QUARANTINE_FLAG' };

      const pStatus = getOwnDataProperty(value, 'status');
      if (!pStatus.present) return { classified: false, error: 'MISSING_STATUS' };

      if (pStatus.value === 'BOUND') {
        const pCardId = getOwnDataProperty(value, 'cardId');
        if (!pCardId.present || typeof pCardId.value !== 'string' || !UUID_V4_REGEX.test(pCardId.value)) {
          return { classified: false, error: 'INVALID_CARD_ID' };
        }
        const pRev = getOwnDataProperty(value, 'storageRevision');
        if (!pRev.present || typeof pRev.value !== 'number' || !Number.isSafeInteger(pRev.value) || pRev.value < 1) {
          return { classified: false, error: 'INVALID_STORAGE_REVISION' };
        }
        const pReg = getOwnDataProperty(value, 'registry');
        if (!pReg.present) return { classified: false, error: 'MISSING_REGISTRY' };
        const regCheck = parseRegistry(pReg.value);
        if (!regCheck.ok || regCheck.status !== 'VALID') return { classified: false, error: 'INVALID_REGISTRY_PAYLOAD' };

        const projected = {
          status: 'BOUND',
          cardId: pCardId.value,
          avatar: pAvatar.value,
          storageRevision: pRev.value,
          registry: regCheck.value,
        };
        if (qCheck.active) projected.quarantineActive = true;
        return { classified: true, envelope: { ok: true, value: projected } };
      }

      if (pStatus.value === 'UNBOUND') {
        const pRec = getOwnDataProperty(value, 'recoveryAvailable');
        if (!pRec.present || typeof pRec.value !== 'boolean') return { classified: false, error: 'INVALID_RECOVERY_FLAG' };

        const projected = {
          status: 'UNBOUND',
          avatar: pAvatar.value,
          recoveryAvailable: pRec.value,
        };
        if (qCheck.active) projected.quarantineActive = true;
        return { classified: true, envelope: { ok: true, value: projected } };
      }

      return { classified: false, error: 'INVALID_RESOLVE_STATUS' };
    }

    if (route === 'recoveryCandidates') {
      const pCandidates = getOwnDataProperty(value, 'candidates');
      if (!pCandidates.present || !Array.isArray(pCandidates.value) || pCandidates.value.length > 512) {
        return { classified: false, error: 'INVALID_CANDIDATES_LIST' };
      }

      const qCheck = validateQuarantineActive(value);
      if (!qCheck.ok) return { classified: false, error: 'MALFORMED_QUARANTINE_FLAG' };

      const cleanCandidates = [];
      for (const cand of pCandidates.value) {
        if (!cand || typeof cand !== 'object' || Array.isArray(cand)) return { classified: false, error: 'MALFORMED_CANDIDATE' };
        const cAvatar = getOwnDataProperty(cand, 'avatar');
        if (!cAvatar.present || !isValidAvatar(cAvatar.value)) return { classified: false, error: 'INVALID_CANDIDATE_AVATAR' };
        const cCardId = getOwnDataProperty(cand, 'cardId');
        if (!cCardId.present || typeof cCardId.value !== 'string' || !UUID_V4_REGEX.test(cCardId.value)) return { classified: false, error: 'INVALID_CANDIDATE_CARD_ID' };
        const cRev = getOwnDataProperty(cand, 'storageRevision');
        if (!cRev.present || typeof cRev.value !== 'number' || !Number.isSafeInteger(cRev.value) || cRev.value < 1) {
          return { classified: false, error: 'INVALID_CANDIDATE_REVISION' };
        }
        cleanCandidates.push({
          avatar: cAvatar.value,
          cardId: cCardId.value,
          storageRevision: cRev.value,
        });
      }

      const projected = { candidates: cleanCandidates };
      if (qCheck.active) projected.quarantineActive = true;
      return { classified: true, envelope: { ok: true, value: projected } };
    }

    if (route === 'create') {
      if (changedProp.value !== true) return { classified: false, error: 'CREATE_MUST_HAVE_CHANGED_TRUE' };
      const pStatus = getOwnDataProperty(value, 'status');
      if (!pStatus.present || pStatus.value !== 'BOUND') return { classified: false, error: 'CREATE_MUST_BE_BOUND' };
      const pAvatar = getOwnDataProperty(value, 'avatar');
      if (!pAvatar.present || pAvatar.value !== requestParams.avatar || !isValidAvatar(pAvatar.value)) return { classified: false, error: 'AVATAR_LOCATOR_MISMATCH' };
      const pCardId = getOwnDataProperty(value, 'cardId');
      if (!pCardId.present || typeof pCardId.value !== 'string' || !UUID_V4_REGEX.test(pCardId.value)) return { classified: false, error: 'INVALID_CARD_ID' };
      const pRev = getOwnDataProperty(value, 'storageRevision');
      if (!pRev.present || pRev.value !== 1) return { classified: false, error: 'CREATE_REVISION_MUST_BE_1' };

      const pReg = getOwnDataProperty(value, 'registry');
      if (!pReg.present) return { classified: false, error: 'MISSING_REGISTRY' };
      const regCheck = parseRegistry(pReg.value);
      if (!regCheck.ok || regCheck.status !== 'VALID') return { classified: false, error: 'INVALID_REGISTRY_PAYLOAD' };

      // G4-R2-B: Canonical C0 empty registry requirement for create
      const regVal = regCheck.value;
      if (regVal.schemaVersion !== 1 || regVal.revision !== 0 || !Array.isArray(regVal.characters) || regVal.characters.length !== 0) {
        return { classified: false, error: 'CREATE_MUST_HAVE_CANONICAL_EMPTY_REGISTRY' };
      }

      return {
        classified: true,
        envelope: {
          ok: true,
          changed: true,
          value: {
            status: 'BOUND',
            cardId: pCardId.value,
            avatar: pAvatar.value,
            storageRevision: 1,
            registry: regVal,
          },
        },
      };
    }

    if (route === 'mutate') {
      const pStatus = getOwnDataProperty(value, 'status');
      if (!pStatus.present || pStatus.value !== 'BOUND') return { classified: false, error: 'MUTATE_MUST_BE_BOUND' };
      const pCardId = getOwnDataProperty(value, 'cardId');
      if (!pCardId.present || pCardId.value !== requestParams.cardId) return { classified: false, error: 'CARD_ID_LOCATOR_MISMATCH' };
      const pAvatar = getOwnDataProperty(value, 'avatar');
      if (!pAvatar.present || pAvatar.value !== requestParams.avatar || !isValidAvatar(pAvatar.value)) return { classified: false, error: 'AVATAR_LOCATOR_MISMATCH' };

      const pReg = getOwnDataProperty(value, 'registry');
      if (!pReg.present) return { classified: false, error: 'MISSING_REGISTRY' };
      const regCheck = parseRegistry(pReg.value);
      if (!regCheck.ok || regCheck.status !== 'VALID') return { classified: false, error: 'INVALID_REGISTRY_PAYLOAD' };

      const pRev = getOwnDataProperty(value, 'storageRevision');
      if (!pRev.present || typeof pRev.value !== 'number' || !Number.isSafeInteger(pRev.value)) return { classified: false, error: 'INVALID_STORAGE_REVISION' };

      const expectedStorageRev = requestParams.expectedStorageRevision;
      const expectedRegRev = requestParams.expectedRegistryRevision;

      if (changedProp.value === false) {
        if (pRev.value !== expectedStorageRev) return { classified: false, error: 'NOOP_STORAGE_REVISION_MISMATCH' };
        if (regCheck.value.revision !== expectedRegRev) return { classified: false, error: 'NOOP_REGISTRY_REVISION_MISMATCH' };
      } else {
        const nextStorageRev = expectedStorageRev + 1;
        const nextRegRev = expectedRegRev + 1;
        if (!Number.isSafeInteger(nextStorageRev) || !Number.isSafeInteger(nextRegRev)) {
          return { classified: false, error: 'REVISION_OVERFLOW' };
        }
        if (pRev.value !== nextStorageRev) return { classified: false, error: 'MUTATE_STORAGE_REVISION_INCREMENT_MISMATCH' };
        if (regCheck.value.revision !== nextRegRev) return { classified: false, error: 'MUTATE_REGISTRY_REVISION_INCREMENT_MISMATCH' };
      }

      return {
        classified: true,
        envelope: {
          ok: true,
          changed: changedProp.value,
          value: {
            status: 'BOUND',
            cardId: pCardId.value,
            avatar: pAvatar.value,
            storageRevision: pRev.value,
            registry: regCheck.value,
          },
        },
      };
    }

    if (route === 'rebind') {
      const pStatus = getOwnDataProperty(value, 'status');
      if (!pStatus.present || pStatus.value !== 'BOUND') return { classified: false, error: 'REBIND_MUST_BE_BOUND' };
      const pCardId = getOwnDataProperty(value, 'cardId');
      if (!pCardId.present || pCardId.value !== requestParams.cardId) return { classified: false, error: 'CARD_ID_LOCATOR_MISMATCH' };
      const pAvatar = getOwnDataProperty(value, 'avatar');
      if (!pAvatar.present || pAvatar.value !== requestParams.toAvatar || !isValidAvatar(pAvatar.value)) return { classified: false, error: 'TO_AVATAR_LOCATOR_MISMATCH' };

      const pReg = getOwnDataProperty(value, 'registry');
      if (!pReg.present) return { classified: false, error: 'MISSING_REGISTRY' };
      const regCheck = parseRegistry(pReg.value);
      if (!regCheck.ok || regCheck.status !== 'VALID') return { classified: false, error: 'INVALID_REGISTRY_PAYLOAD' };

      const pRev = getOwnDataProperty(value, 'storageRevision');
      if (!pRev.present || typeof pRev.value !== 'number' || !Number.isSafeInteger(pRev.value)) return { classified: false, error: 'INVALID_STORAGE_REVISION' };

      const expectedStorageRev = requestParams.expectedStorageRevision;
      const isNoOp = requestParams.fromAvatar === requestParams.toAvatar;

      if (isNoOp) {
        if (changedProp.value !== false) return { classified: false, error: 'REBIND_NOOP_MUST_HAVE_CHANGED_FALSE' };
        if (pRev.value !== expectedStorageRev) return { classified: false, error: 'REBIND_NOOP_STORAGE_REVISION_MISMATCH' };
      } else {
        if (changedProp.value !== true) return { classified: false, error: 'REBIND_RENAME_MUST_HAVE_CHANGED_TRUE' };
        const nextStorageRev = expectedStorageRev + 1;
        if (!Number.isSafeInteger(nextStorageRev)) return { classified: false, error: 'REVISION_OVERFLOW' };
        if (pRev.value !== nextStorageRev) return { classified: false, error: 'REBIND_STORAGE_REVISION_INCREMENT_MISMATCH' };
      }

      return {
        classified: true,
        envelope: {
          ok: true,
          changed: changedProp.value,
          value: {
            status: 'BOUND',
            cardId: pCardId.value,
            avatar: pAvatar.value,
            storageRevision: pRev.value,
            registry: regCheck.value,
          },
        },
      };
    }

    if (route === 'clone') {
      if (changedProp.value !== true) return { classified: false, error: 'CLONE_MUST_HAVE_CHANGED_TRUE' };
      const pStatus = getOwnDataProperty(value, 'status');
      if (!pStatus.present || pStatus.value !== 'BOUND') return { classified: false, error: 'CLONE_MUST_BE_BOUND' };
      const pAvatar = getOwnDataProperty(value, 'avatar');
      if (!pAvatar.present || pAvatar.value !== requestParams.targetAvatar || !isValidAvatar(pAvatar.value)) return { classified: false, error: 'TARGET_AVATAR_LOCATOR_MISMATCH' };
      const pCardId = getOwnDataProperty(value, 'cardId');
      if (!pCardId.present || typeof pCardId.value !== 'string' || !UUID_V4_REGEX.test(pCardId.value)) return { classified: false, error: 'INVALID_CARD_ID' };
      if (pCardId.value === requestParams.sourceCardId) return { classified: false, error: 'CLONE_CARD_ID_MUST_BE_NEW' };
      const pRev = getOwnDataProperty(value, 'storageRevision');
      if (!pRev.present || pRev.value !== 1) return { classified: false, error: 'CLONE_REVISION_MUST_BE_1' };

      const pReg = getOwnDataProperty(value, 'registry');
      if (!pReg.present) return { classified: false, error: 'MISSING_REGISTRY' };
      const regCheck = parseRegistry(pReg.value);
      if (!regCheck.ok || regCheck.status !== 'VALID') return { classified: false, error: 'INVALID_REGISTRY_PAYLOAD' };

      return {
        classified: true,
        envelope: {
          ok: true,
          changed: true,
          value: {
            status: 'BOUND',
            cardId: pCardId.value,
            avatar: pAvatar.value,
            storageRevision: 1,
            registry: regCheck.value,
          },
        },
      };
    }

    return { classified: false, error: 'UNKNOWN_ROUTE' };
  } catch (_err) {
    return { classified: false, error: 'CLASSIFICATION_EXCEPTION' };
  }
}

export function classifyAndSanitizeC2Failure(c2Result) {
  try {
    if (!c2Result || typeof c2Result !== 'object' || Array.isArray(c2Result)) {
      return makeInternalError();
    }
    const okProp = getOwnDataProperty(c2Result, 'ok');
    if (!okProp.present || okProp.value !== false) {
      return makeInternalError();
    }
    const codeProp = getOwnDataProperty(c2Result, 'code');
    if (!codeProp.present || typeof codeProp.value !== 'string') {
      return makeInternalError();
    }
    const code = codeProp.value;
    if (!Object.hasOwn(C2_ERROR_SPECIFICATIONS, code)) {
      return makeInternalError();
    }
    const spec = C2_ERROR_SPECIFICATIONS[code];
    const recProp = getOwnDataProperty(c2Result, 'recoverable');
    if (!recProp.present || recProp.value !== spec.recoverable) {
      return makeInternalError();
    }

    const envelope = {
      ok: false,
      code,
      message: spec.message,
      recoverable: spec.recoverable,
    };

    if (Object.hasOwn(c2Result, 'details')) {
      const detailsProp = getOwnDataProperty(c2Result, 'details');
      if (detailsProp.present && detailsProp.value && typeof detailsProp.value === 'object' && !Array.isArray(detailsProp.value)) {
        const detailsObj = detailsProp.value;
        if (Object.hasOwn(detailsObj, 'reason')) {
          const reasonProp = getOwnDataProperty(detailsObj, 'reason');
          if (reasonProp.present && typeof reasonProp.value === 'string') {
            const reason = reasonProp.value;
            if (INTERNAL_DIAGNOSTIC_ALLOWLIST.has(reason)) {
              envelope.details = { reason };
            }
          }
        }
      }
    }

    return {
      classified: true,
      status: spec.status,
      envelope,
    };
  } catch (_err) {
    return makeInternalError();
  }
}

function makeInternalError() {
  const fallback = ADAPTER_ERROR_SPECIFICATIONS.INTERNAL_ERROR;
  return {
    classified: false,
    status: fallback.status,
    envelope: {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: fallback.message,
      recoverable: false,
    },
  };
}

// --- Route Definitions ---

const ROUTE_DEFINITIONS = [
  {
    path: '/v1/resolve',
    name: 'resolve',
    isMutator: false,
    allowedKeys: ['avatar'],
    delegate: (controller, context, params, signal) => controller.resolve({ context, avatar: params.avatar, signal }),
  },
  {
    path: '/v1/recovery-candidates',
    name: 'recoveryCandidates',
    isMutator: false,
    allowedKeys: ['avatar'],
    delegate: (controller, context, params, signal) => controller.recoveryCandidates({ context, avatar: params.avatar, signal }),
  },
  {
    path: '/v1/create',
    name: 'create',
    isMutator: true,
    allowedKeys: ['avatar'],
    delegate: (controller, context, params, signal) => controller.create({ context, avatar: params.avatar, signal }),
  },
  {
    path: '/v1/mutate',
    name: 'mutate',
    isMutator: true,
    allowedKeys: ['cardId', 'avatar', 'expectedStorageRevision', 'expectedRegistryRevision', 'command'],
    delegate: (controller, context, params, signal) => controller.mutate({
      context,
      cardId: params.cardId,
      avatar: params.avatar,
      expectedStorageRevision: params.expectedStorageRevision,
      expectedRegistryRevision: params.expectedRegistryRevision,
      command: params.command,
      signal,
    }),
  },
  {
    path: '/v1/rebind',
    name: 'rebind',
    isMutator: true,
    allowedKeys: ['cardId', 'fromAvatar', 'toAvatar', 'expectedStorageRevision'],
    delegate: (controller, context, params, signal) => controller.rebind({
      context,
      cardId: params.cardId,
      fromAvatar: params.fromAvatar,
      toAvatar: params.toAvatar,
      expectedStorageRevision: params.expectedStorageRevision,
      signal,
    }),
  },
  {
    path: '/v1/clone',
    name: 'clone',
    isMutator: true,
    allowedKeys: ['sourceCardId', 'sourceAvatar', 'targetAvatar', 'expectedSourceStorageRevision'],
    delegate: (controller, context, params, signal) => controller.clone({
      context,
      sourceCardId: params.sourceCardId,
      sourceAvatar: params.sourceAvatar,
      targetAvatar: params.targetAvatar,
      expectedSourceStorageRevision: params.expectedSourceStorageRevision,
      signal,
    }),
  },
];

// --- Factory ---

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function sendAdapterError(res, code) {
  const spec = ADAPTER_ERROR_SPECIFICATIONS[code] || ADAPTER_ERROR_SPECIFICATIONS.INTERNAL_ERROR;
  sendJson(res, spec.status, {
    ok: false,
    code,
    message: spec.message,
    recoverable: spec.recoverable,
  });
}

function validateSafeIntegerOption(val, name, { min = 1, max = 1000000, defaultValue } = {}) {
  if (val === undefined) return defaultValue;
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < min || val > max) {
    throw new TypeError(`${name} must be a safe integer between ${min} and ${max}`);
  }
  return val;
}

export function createSidecarHttpAdapter(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Options must be a plain object');
  }
  const optProto = Object.getPrototypeOf(options);
  if (optProto !== Object.prototype && optProto !== null) {
    throw new TypeError('Options must be a plain object');
  }

  // Reject accessors or symbols on options
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError('Symbol options are forbidden');
  }
  for (const k of Object.getOwnPropertyNames(options)) {
    const desc = Object.getOwnPropertyDescriptor(options, k);
    if (!desc || desc.get !== undefined || desc.set !== undefined) {
      throw new TypeError(`Accessor option '${k}' is forbidden`);
    }
  }

  const controller = options.controller;
  if (!controller || typeof controller !== 'object' || Array.isArray(controller)) {
    throw new TypeError('controller is required and must be a valid SidecarController');
  }
  for (const m of ['resolve', 'recoveryCandidates', 'create', 'mutate', 'rebind', 'clone']) {
    if (typeof controller[m] !== 'function') {
      throw new TypeError(`controller must implement ${m}`);
    }
  }

  if (options.httpEnabled !== undefined && typeof options.httpEnabled !== 'boolean') {
    throw new TypeError('httpEnabled must be a boolean');
  }
  const httpEnabled = options.httpEnabled === true;

  if (options.writeEnabled !== undefined && typeof options.writeEnabled !== 'boolean') {
    throw new TypeError('writeEnabled must be a boolean');
  }
  const writeEnabled = options.writeEnabled === true;

  // Enforce agreed native security ceilings (at-most native bounds)
  const maxGlobalInFlight = validateSafeIntegerOption(options.maxGlobalInFlight, 'maxGlobalInFlight', { min: 1, max: 32, defaultValue: 32 });
  const maxPerUserInFlight = validateSafeIntegerOption(options.maxPerUserInFlight, 'maxPerUserInFlight', { min: 1, max: Math.min(4, maxGlobalInFlight), defaultValue: Math.min(4, maxGlobalInFlight) });
  const maxBodyBytes = validateSafeIntegerOption(options.maxBodyBytes, 'maxBodyBytes', { min: 1024, max: 393216, defaultValue: MAX_BODY_BYTES });
  const maxDepth = validateSafeIntegerOption(options.maxDepth, 'maxDepth', { min: 1, max: 32, defaultValue: MAX_ALLOWED_DEPTH });
  const maxNodeBudget = validateSafeIntegerOption(options.maxNodeBudget, 'maxNodeBudget', { min: 10, max: 2048, defaultValue: MAX_NODE_BUDGET });
  const drainTimeoutMs = validateSafeIntegerOption(options.drainTimeoutMs, 'drainTimeoutMs', { min: 10, max: 30000, defaultValue: 5000 });

  if (options.onWarning !== undefined && typeof options.onWarning !== 'function') {
    throw new TypeError('onWarning must be a function if provided');
  }
  const onWarning = options.onWarning;

  const admissionGate = new ConcurrencyAdmissionGate({
    maxGlobal: maxGlobalInFlight,
    maxPerUser: maxPerUserInFlight,
  });
  const mutatorLockoutGate = new MutatorLockoutGate();

  let closing = false;
  const activePromises = new Set();
  let drainResolve = null;
  const drainStatus = { closed: false, drained: false, pendingCount: 0 };

  async function close(timeoutMs = drainTimeoutMs) {
    closing = true;
    drainStatus.closed = true;

    if (activePromises.size === 0) {
      drainStatus.drained = true;
      drainStatus.pendingCount = 0;
      return { drained: true, pendingCount: 0 };
    }

    let drainTimer = null;
    let timedOut = false;
    const timeoutPromise = new Promise((resolve) => {
      drainTimer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    const allSettledPromise = new Promise((resolve) => {
      drainResolve = resolve;
    });

    await Promise.race([
      Promise.allSettled(Array.from(activePromises)).then(() => {
        if (drainResolve) drainResolve();
      }),
      allSettledPromise,
      timeoutPromise,
    ]);

    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }

    const drained = activePromises.size === 0 && !timedOut;
    drainStatus.drained = drained;
    drainStatus.pendingCount = activePromises.size;

    if (!drained && typeof onWarning === 'function') {
      try {
        onWarning({
          event: 'INCOMPLETE_DRAIN',
          code: 'DRAIN_TIMEOUT_EXCEEDED',
          pendingCount: activePromises.size,
        });
      } catch (_warnErr) {
        // Suppress logger error
      }
    }

    return { drained, pendingCount: activePromises.size };
  }

  function registerRoutes(router) {
    if (!router || typeof router.post !== 'function') {
      throw new TypeError('Router must have a post() method');
    }

    for (const route of ROUTE_DEFINITIONS) {
      router.post(route.path, async (req, res) => {
        // Phase 1: Pre-Dispatch Validation & Admission Gate
        if (res.writableEnded || res.destroyed) return;

        const contentType = req.headers ? req.headers['content-type'] : undefined;
        if (!isValidJsonContentType(contentType)) {
          return sendAdapterError(res, 'UNSUPPORTED_MEDIA_TYPE');
        }

        if (closing) {
          return sendAdapterError(res, 'SERVICE_CLOSING');
        }

        if (!httpEnabled) {
          return sendAdapterError(res, 'HTTP_DISABLED');
        }

        if (route.isMutator && !writeEnabled) {
          return sendAdapterError(res, 'WRITES_DISABLED');
        }

        const ctxRes = extractTrustedContext(req);
        if (!ctxRes.ok) {
          return sendJson(res, ctxRes.status, {
            ok: false,
            code: ctxRes.code,
            message: ctxRes.message,
            recoverable: false,
          });
        }
        const { userRoot } = ctxRes.context;

        if (route.isMutator && mutatorLockoutGate.isLocked(userRoot)) {
          return sendAdapterError(res, 'MUTATIONS_LOCKED');
        }

        // Validate and sanitize request parameters BEFORE acquiring any admission slot
        const sanitized = validateAndSanitizeRequestBody(route, req.body, { maxDepth, maxNodeBudget, maxBodyBytes });
        if (!sanitized.ok) {
          return sendJson(res, sanitized.status, {
            ok: false,
            code: sanitized.code,
            message: sanitized.message,
            recoverable: false,
          });
        }
        const validatedParams = sanitized.params;

        // Acquire admission slot (guaranteed release boundary from this exact line)
        const admission = admissionGate.tryAcquire(userRoot, route.isMutator);
        if (!admission.allowed) {
          return sendAdapterError(res, admission.code);
        }

        let slotReleased = false;
        const releaseSlot = () => {
          if (!slotReleased) {
            slotReleased = true;
            admissionGate.release(userRoot, route.isMutator);
          }
        };

        try {
          // Pre-delegation response state check
          if (res.writableEnded || res.destroyed) {
            releaseSlot();
            return;
          }

          let socketClosed = false;
          const abortController = new AbortController();
          const onClose = () => {
            socketClosed = true;
            if (!res.writableEnded) {
              abortController.abort();
            }
          };

          try {
            res.on('close', onClose);
          } catch (_listenerErr) {
            // Listener registration threw: release slot immediately, no mutator lockout, return 500
            releaseSlot();
            if (!res.writableEnded && !res.destroyed) {
              sendAdapterError(res, 'INTERNAL_ERROR');
            }
            return;
          }

          // Check again immediately before delegation in case close emitted synchronously during registration
          if (socketClosed || res.writableEnded || res.destroyed) {
            try { res.removeListener('close', onClose); } catch (_) {}
            releaseSlot();
            return;
          }

          let opPromise;
          opPromise = (async () => {
            let classifiedOutcome = null;

            try {
              let c2Result;
              try {
                c2Result = await route.delegate(controller, ctxRes.context, validatedParams, abortController.signal);
              } catch (_delegatedThrow) {
                if (route.isMutator) {
                  mutatorLockoutGate.lock(userRoot);
                }
                classifiedOutcome = {
                  httpStatus: 500,
                  envelope: {
                    ok: false,
                    code: 'INTERNAL_ERROR',
                    message: ADAPTER_ERROR_SPECIFICATIONS.INTERNAL_ERROR.message,
                    recoverable: false,
                  },
                  classified: false,
                };
              }

              if (classifiedOutcome === null) {
                // Inspect and classify c2Result safely inside try block
                try {
                  let isSuccess = false;
                  if (c2Result && typeof c2Result === 'object' && !Array.isArray(c2Result)) {
                    const okProp = getOwnDataProperty(c2Result, 'ok');
                    if (okProp.present && okProp.value === true) {
                      isSuccess = true;
                    }
                  }

                  if (isSuccess) {
                    const proj = validateAndProjectSuccess(route.name, validatedParams, c2Result);
                    if (!proj.classified) {
                      if (route.isMutator) mutatorLockoutGate.lock(userRoot);
                      classifiedOutcome = {
                        httpStatus: 500,
                        envelope: {
                          ok: false,
                          code: 'INTERNAL_ERROR',
                          message: ADAPTER_ERROR_SPECIFICATIONS.INTERNAL_ERROR.message,
                          recoverable: false,
                        },
                        classified: false,
                      };
                    } else {
                      classifiedOutcome = {
                        httpStatus: 200,
                        envelope: proj.envelope,
                        classified: true,
                      };
                    }
                  } else {
                    const failProj = classifyAndSanitizeC2Failure(c2Result);
                    if (!failProj.classified) {
                      if (route.isMutator) mutatorLockoutGate.lock(userRoot);
                      classifiedOutcome = {
                        httpStatus: 500,
                        envelope: {
                          ok: false,
                          code: 'INTERNAL_ERROR',
                          message: ADAPTER_ERROR_SPECIFICATIONS.INTERNAL_ERROR.message,
                          recoverable: false,
                        },
                        classified: false,
                      };
                    } else {
                      classifiedOutcome = {
                        httpStatus: failProj.status,
                        envelope: failProj.envelope,
                        classified: true,
                      };
                    }
                  }
                } catch (_postDelegationErr) {
                  if (route.isMutator) {
                    mutatorLockoutGate.lock(userRoot);
                  }
                  classifiedOutcome = {
                    httpStatus: 500,
                    envelope: {
                      ok: false,
                      code: 'INTERNAL_ERROR',
                      message: ADAPTER_ERROR_SPECIFICATIONS.INTERNAL_ERROR.message,
                      recoverable: false,
                    },
                    classified: false,
                  };
                }
              }

              // Phase 4: Response Delivery
              if (!socketClosed && !res.writableEnded && !res.destroyed) {
                try {
                  sendJson(res, classifiedOutcome.httpStatus, classifiedOutcome.envelope);
                } catch (_deliveryErr) {
                  // Socket write failure does NOT alter classified controller outcome or trigger lockout
                }
              }
            } finally {
              // Phase 5: Settlement & Cleanup
              try { res.removeListener('close', onClose); } catch (_) {}
              releaseSlot();
              activePromises.delete(opPromise);
              if (closing && activePromises.size === 0 && drainResolve) {
                drainResolve();
              }
            }
          })();

          activePromises.add(opPromise);
          await opPromise;
        } catch (_syncDispatchErr) {
          releaseSlot();
          if (!res.writableEnded && !res.destroyed) {
            sendAdapterError(res, 'INTERNAL_ERROR');
          }
        }
      });
    }
  }

  function getMetrics() {
    return {
      globalInFlight: admissionGate.globalInFlight,
      userInFlight: new Map(admissionGate.userInFlight),
      lockedUsers: new Set(mutatorLockoutGate.lockedUsers),
      activeMutatorUsers: new Set(admissionGate.activeMutatorUsers),
      activePromisesCount: activePromises.size,
    };
  }

  return Object.freeze({
    registerRoutes,
    close,
    getMetrics,
    getDrainStatus: () => ({ ...drainStatus }),
    isClosing: () => closing,
    isHttpEnabled: () => httpEnabled,
    isWriteEnabled: () => writeEnabled,
  });
}
