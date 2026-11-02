/**
 * SillyTavern-ChromaticHub: Filesystem-Backed Sidecar FileStore (H01-B3-D2-C1)
 *
 * Implements strict per-user containment, complete bounded store scan,
 * exclusive card creation, two-phase CAS state replacement, and fault-classified durability.
 *
 * Conforms to:
 * - ChromaticHub-H01-B3-D2-A-approved.md (Sidecar Storage and API Contract)
 * - ChromaticHub-H01-B3-D2-B-approved.md (State Machine and Storage Controller Plan)
 * - ChromaticHub-H01-B3-D2-C1-research-and-design.md
 * - ChromaticHub-H01-B3-D2-C1-plan-R2.md (Authoritative G1-R2 Specification)
 * - Binding G2 Guardrails A-E (Independent Review 2026-10-30)
 *
 * Invariants:
 * - Single-process, per-user trusted-root model with defense-in-depth against TOCTOU.
 * - Private 0700 directories and 0600 files.
 * - Absolute rename commit dividing line: failures during/after rename are strictly WRITE_UNCERTAIN.
 * - Zero automatic cleanup or repair of forensic residues in production code.
 * - Dependency-free ES module.
 */

import fsPromises from 'node:fs/promises';
import fsConstants from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  parseSidecarState,
  serializeSidecarState,
  validateEvidence,
  MAX_AVATAR_BYTES,
  SIDECAR_ERROR_CODES,
} from './sidecar-state.mjs';

// --- Constants & RegExps ---

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG_EXTENSION_REGEX = /\.[pP][nN][gG]$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;

export const FILE_STORE_LIMITS = Object.freeze({
  MAX_CARD_DIRECTORIES: 512,
  MAX_AGGREGATE_BYTES: 33554432, // 32 MiB
  MAX_STATE_BYTES: 307200,       // 300 KiB
  MAX_ENTRIES_PER_CARD_DIR: 1,
  MAX_CARDS_DIR_ENTRIES: 513,
  MAX_OBSERVED_AVATARS: 512,
});

export const FILE_STORE_ERROR_CODES = Object.freeze({
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  STATE_NOT_FOUND: 'STATE_NOT_FOUND',
  READ_FAILED: 'READ_FAILED',
  WRITE_FAILED: 'WRITE_FAILED',
  WRITE_UNCERTAIN: 'WRITE_UNCERTAIN',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  ALREADY_BOUND: 'ALREADY_BOUND',
  INVALID_CARD_ID: 'INVALID_CARD_ID',
  INVALID_AVATAR: 'INVALID_AVATAR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  BYTE_LIMIT_EXCEEDED: 'BYTE_LIMIT_EXCEEDED',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
});

export const DIAGNOSTIC_REASONS = Object.freeze({
  INCOMPLETE_STORE: 'INCOMPLETE_STORE',
  MISSING_STATE_JSON: 'MISSING_STATE_JSON',
  DIR_RESIDUE_DETECTED: 'DIR_RESIDUE_DETECTED',
  UNEXPECTED_ENTRY: 'UNEXPECTED_ENTRY',
  UNEXPECTED_FILE_TYPE: 'UNEXPECTED_FILE_TYPE',
  SYMLINK_DETECTED: 'SYMLINK_DETECTED',
  HARDLINK_DETECTED: 'HARDLINK_DETECTED',
  DEV_INO_MISMATCH: 'DEV_INO_MISMATCH',
  BYTE_LIMIT_EXCEEDED: 'BYTE_LIMIT_EXCEEDED',
  SCAN_BUDGET_EXCEEDED: 'SCAN_BUDGET_EXCEEDED',
  DIRECTORY_EXISTS: 'DIRECTORY_EXISTS',
  STATE_NOT_FOUND: 'STATE_NOT_FOUND',
  CARD_DIRECTORY_MISSING: 'CARD_DIRECTORY_MISSING',
  CARD_ID_MISMATCH: 'CARD_ID_MISMATCH',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  CAS_MISMATCH: 'CAS_MISMATCH',
  CAS_MISMATCH_PRE_RENAME: 'CAS_MISMATCH_PRE_RENAME',
  MKDIR_FAILED: 'MKDIR_FAILED',
  DIRSYNC_FAILED: 'DIRSYNC_FAILED',
  TEMP_OPEN_FAILED: 'TEMP_OPEN_FAILED',
  TEMP_WRITE_FAILED: 'TEMP_WRITE_FAILED',
  TEMP_SYNC_FAILED: 'TEMP_SYNC_FAILED',
  TEMP_CLOSE_FAILED: 'TEMP_CLOSE_FAILED',
  PRE_RENAME_VERIFY_FAILED: 'PRE_RENAME_VERIFY_FAILED',
  RENAME_FAILED: 'RENAME_FAILED',
  READBACK_FAILED: 'READBACK_FAILED',
  READBACK_MISMATCH: 'READBACK_MISMATCH',
  CHARACTERS_ROOT_UNAVAILABLE: 'CHARACTERS_ROOT_UNAVAILABLE',
  FILE_OBSERVATION_FAILED: 'FILE_OBSERVATION_FAILED',
  FAULT_INJECTED_PRE_RENAME: 'FAULT_INJECTED_PRE_RENAME',
  FAULT_INJECTED_POST_RENAME: 'FAULT_INJECTED_POST_RENAME',
  IO_ERROR: 'IO_ERROR',
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

/**
 * Local C1 avatar-basename predicate with exact parity to C0 accepted rules (Guardrail A).
 * C0 keeps isValidAvatar private; this implements identical validation without importing private symbols.
 *
 * @param {unknown} avatar
 * @returns {boolean}
 */
export function isValidAvatar(avatar) {
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

const defaultFsOps = Object.freeze({
  lstat: (p) => fsPromises.lstat(p),
  stat: (p) => fsPromises.stat(p),
  realpath: (p) => fsPromises.realpath(p),
  opendir: (p, opts) => fsPromises.opendir(p, opts),
  mkdir: (p, opts) => fsPromises.mkdir(p, opts),
  open: (p, flags, mode) => fsPromises.open(p, flags, mode),
  rename: (oldP, newP) => fsPromises.rename(oldP, newP),
});

// --- Internal Helper Functions ---

async function syncDirectory(fsOps, dirPath) {
  let handle;
  try {
    const flags = fsConstants.constants.O_RDONLY | fsConstants.constants.O_DIRECTORY;
    handle = await fsOps.open(dirPath, flags);
    await handle.sync();
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_closeErr) {
        // preserve primary error
      }
    }
  }
}

async function readBoundedFile(handle, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  const bufferSize = 16384;
  const buf = Buffer.alloc(bufferSize);

  while (true) {
    const { bytesRead } = await handle.read(buf, 0, bufferSize, null);
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      return { ok: false, code: FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED, bytesRead: totalBytes };
    }
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }

  const rawBytes = Buffer.concat(chunks).toString('utf8');
  return { ok: true, rawBytes, bytesRead: totalBytes };
}

/**
 * Bounded full-write loop accounting for bytesWritten, write offsets, zero progress, and post-write size check.
 * (Blocking Finding A)
 */
async function writeBufferFully(handle, buffer, maxBytes) {
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
      reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED,
    };
  }

  let offset = 0;
  const length = buffer.length;
  let iterations = 0;
  const maxIterations = 2000;

  while (offset < length) {
    iterations++;
    if (iterations > maxIterations) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        reason: DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED,
      };
    }

    const toWrite = length - offset;
    let writeResult;
    try {
      writeResult = await handle.write(buffer, offset, toWrite, offset);
    } catch (_wErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        reason: DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED,
      };
    }

    const bytesWritten = typeof writeResult === 'number' ? writeResult : writeResult?.bytesWritten;

    if (typeof bytesWritten !== 'number' || bytesWritten <= 0 || !Number.isInteger(bytesWritten)) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        reason: DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED,
      };
    }

    offset += bytesWritten;
    if (offset > length) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        reason: DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED,
      };
    }
  }

  // Verify file size matches buffer length
  try {
    const postStat = await handle.stat();
    if (postStat.size !== length) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        reason: DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED,
      };
    }
  } catch (_statErr) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
      reason: DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED,
    };
  }

  return { ok: true, bytesWritten: offset };
}

/**
 * Fresh independent pre-rename verification of the staged temporary file.
 * Verifies tempPath identity (dev/ino), regular file type, link count,
 * fstat parity, bounded size, and byte-for-byte exact equality before rename dispatch.
 * (Finding G4-R2)
 */
async function verifyStagedTempFile(fsOps, tempPath, expectedDev, expectedIno, expectedSerializedBytes, maxBytes) {
  if (
    typeof expectedDev === 'undefined' ||
    typeof expectedIno === 'undefined' ||
    typeof expectedSerializedBytes !== 'string'
  ) {
    return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
  }

  const oNoFollow = fsConstants?.constants?.O_NOFOLLOW;
  if (typeof oNoFollow !== 'number') {
    return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
  }

  let lstat;
  try {
    lstat = await fsOps.lstat(tempPath);
  } catch (_err) {
    return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
  }

  if (
    typeof lstat.isSymbolicLink !== 'function' ||
    lstat.isSymbolicLink() ||
    typeof lstat.isFile !== 'function' ||
    !lstat.isFile() ||
    lstat.nlink !== 1 ||
    lstat.dev !== expectedDev ||
    lstat.ino !== expectedIno
  ) {
    return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
  }

  let readHandle;
  let closeError = null;
  let verificationOk = false;

  try {
    const openFlags = fsConstants.constants.O_RDONLY | oNoFollow;
    readHandle = await fsOps.open(tempPath, openFlags);

    const fstat = await readHandle.stat();
    if (
      typeof fstat.isFile !== 'function' ||
      !fstat.isFile() ||
      fstat.nlink !== 1 ||
      fstat.dev !== expectedDev ||
      fstat.ino !== expectedIno ||
      fstat.dev !== lstat.dev ||
      fstat.ino !== lstat.ino
    ) {
      return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
    }

    const expectedLength = Buffer.byteLength(expectedSerializedBytes, 'utf8');
    if (fstat.size !== expectedLength) {
      return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
    }

    const readResult = await readBoundedFile(readHandle, maxBytes);
    if (
      !readResult.ok ||
      readResult.bytesRead !== expectedLength ||
      readResult.rawBytes !== expectedSerializedBytes
    ) {
      return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
    }

    verificationOk = true;
  } catch (_err) {
    return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
  } finally {
    if (readHandle) {
      try {
        await readHandle.close();
      } catch (cErr) {
        closeError = cErr;
      }
    }
  }

  if (closeError || !verificationOk) {
    return { ok: false, reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED };
  }

  return { ok: true };
}

/**
 * Shared ancestor and path-chain validator.
 * Validates userRoot, chromaticHub, cards, rejecting symlinks and unexpected hub siblings.
 * (Blocking Findings C and D)
 */
async function validatePathChain(fsOps, userRoot, cardId = null) {
  let userRootStat;
  try {
    userRootStat = await fsOps.lstat(userRoot);
  } catch (_err) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'userRoot unavailable',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
    };
  }

  if (userRootStat.isSymbolicLink()) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'Symlink detected for userRoot',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
    };
  }

  if (!userRootStat.isDirectory()) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'userRoot must be a regular directory',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY },
    };
  }

  const hubDir = path.join(userRoot, 'chromaticHub');
  let hubStat;
  try {
    hubStat = await fsOps.lstat(hubDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, status: 'ABSENT_HUB', userRootStat };
    }
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'Failed to access chromaticHub directory',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
    };
  }

  if (hubStat.isSymbolicLink()) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'Symlink detected for chromaticHub ancestor',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
    };
  }

  if (!hubStat.isDirectory()) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'chromaticHub must be a regular directory',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY },
    };
  }

  // Blocking Finding D: Inspect chromaticHub entries: must contain ONLY 'cards'
  let cardsFound = false;
  let hubHasUnexpected = false;
  try {
    const hubDirHandle = await fsOps.opendir(hubDir);
    for await (const entry of hubDirHandle) {
      if (entry.name === 'cards') {
        cardsFound = true;
      } else {
        hubHasUnexpected = true;
      }
    }
  } catch (_hubDirErr) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'Failed to inspect chromaticHub directory entries',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
    };
  }

  if (hubHasUnexpected) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'Unexpected entry in chromaticHub directory',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY },
    };
  }

  if (!cardsFound) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'Missing cards directory under chromaticHub',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
    };
  }

  const cardsDir = path.join(hubDir, 'cards');
  let cardsStat;
  try {
    cardsStat = await fsOps.lstat(cardsDir);
  } catch (_cardsErr) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'Missing cards directory under chromaticHub',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
    };
  }

  if (cardsStat.isSymbolicLink()) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'Symlink detected for cards ancestor',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
    };
  }

  if (!cardsStat.isDirectory()) {
    return {
      ok: false,
      code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'cards must be a regular directory',
      recoverable: false,
      details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY },
    };
  }

  if (cardId !== null) {
    const resolvedCardsDir = path.resolve(cardsDir);
    const resolvedCardDir = path.resolve(resolvedCardsDir, cardId);
    if (!resolvedCardDir.startsWith(resolvedCardsDir + path.sep)) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_CARD_ID,
        message: 'Invalid cardId path traversal',
        recoverable: false,
      };
    }
  }

  return {
    ok: true,
    status: 'PRESENT_CARDS',
    userRootStat,
    hubStat,
    cardsStat,
    hubDir,
    cardsDir,
  };
}

async function safeInvokeHook(faultHook, point) {
  if (!faultHook) {
    return;
  }
  const context = Object.freeze({ point });
  await faultHook(point, context);
}

// --- Factory Function ---

/**
 * Creates an immutable, frozen SidecarFileStore instance.
 *
 * @param {object} [options]
 * @returns {Readonly<object>}
 */
export function createFileStore(options = {}) {
  if (options !== undefined && !isPlainObject(options)) {
    throw new TypeError('Options must be a plain object or undefined');
  }

  if (options && typeof options === 'object') {
    const propNames = Object.getOwnPropertyNames(options);
    const propSymbols = Object.getOwnPropertySymbols(options);
    if (propSymbols.length > 0) {
      throw new TypeError('Options cannot contain symbol-keyed properties');
    }
    for (const name of propNames) {
      if (name !== 'fsOps' && name !== 'limits' && name !== 'faultHook') {
        throw new TypeError('Unknown option property');
      }
    }
  }

  const fsOps = options?.fsOps ? Object.freeze({ ...defaultFsOps, ...options.fsOps }) : defaultFsOps;
  const faultHook = options?.faultHook || null;
  if (faultHook !== null && typeof faultHook !== 'function') {
    throw new TypeError('faultHook must be a function');
  }

  const rawLimits = options?.limits;
  const limits = { ...FILE_STORE_LIMITS };

  if (rawLimits !== undefined) {
    if (!isPlainObject(rawLimits)) {
      throw new TypeError('limits must be a plain object');
    }
    if (rawLimits.maxCardDirectories !== undefined) {
      const v = rawLimits.maxCardDirectories;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > FILE_STORE_LIMITS.MAX_CARD_DIRECTORIES) {
        throw new RangeError(`maxCardDirectories must be integer between 1 and ${FILE_STORE_LIMITS.MAX_CARD_DIRECTORIES}`);
      }
      limits.MAX_CARD_DIRECTORIES = v;
    }
    if (rawLimits.maxAggregateBytes !== undefined) {
      const v = rawLimits.maxAggregateBytes;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > FILE_STORE_LIMITS.MAX_AGGREGATE_BYTES) {
        throw new RangeError(`maxAggregateBytes must be integer between 1 and ${FILE_STORE_LIMITS.MAX_AGGREGATE_BYTES}`);
      }
      limits.MAX_AGGREGATE_BYTES = v;
    }
    if (rawLimits.maxStateBytes !== undefined) {
      const v = rawLimits.maxStateBytes;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > FILE_STORE_LIMITS.MAX_STATE_BYTES) {
        throw new RangeError(`maxStateBytes must be integer between 1 and ${FILE_STORE_LIMITS.MAX_STATE_BYTES}`);
      }
      limits.MAX_STATE_BYTES = v;
    }
    if (rawLimits.maxObservedAvatars !== undefined) {
      const v = rawLimits.maxObservedAvatars;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > FILE_STORE_LIMITS.MAX_OBSERVED_AVATARS) {
        throw new RangeError(`maxObservedAvatars must be integer between 1 and ${FILE_STORE_LIMITS.MAX_OBSERVED_AVATARS}`);
      }
      limits.MAX_OBSERVED_AVATARS = v;
    }
  }

  Object.freeze(limits);

  // --- Method Implementations ---

  async function observeAvatar(params) {
    if (!params || typeof params !== 'object') {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid observeAvatar parameters',
        recoverable: false,
      };
    }

    const { charactersRoot, avatar } = params;
    if (typeof charactersRoot !== 'string' || charactersRoot.length === 0) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid charactersRoot',
        recoverable: false,
      };
    }

    if (!isValidAvatar(avatar)) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_AVATAR,
        message: 'Invalid avatar filename',
        recoverable: false,
      };
    }

    // Verify charactersRoot existence and directory type
    let charRootStat;
    try {
      charRootStat = await fsOps.lstat(charactersRoot);
      if (!charRootStat.isDirectory() || charRootStat.isSymbolicLink()) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Characters directory unavailable',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.CHARACTERS_ROOT_UNAVAILABLE },
        };
      }
    } catch (_err) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Characters directory unavailable',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.CHARACTERS_ROOT_UNAVAILABLE },
      };
    }

    const resolvedRoot = path.resolve(charactersRoot);
    const resolvedPath = path.resolve(resolvedRoot, avatar);
    if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_AVATAR,
        message: 'Invalid avatar filename path traversal',
        recoverable: false,
      };
    }

    let fileStat;
    try {
      fileStat = await fsOps.lstat(resolvedPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          ok: true,
          value: { avatar, status: 'MISSING' },
        };
      }
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'File observation failed',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.FILE_OBSERVATION_FAILED },
      };
    }

    if (fileStat.isSymbolicLink()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Symlink detected',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
      };
    }

    if (!fileStat.isFile()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Unexpected file type',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_FILE_TYPE },
      };
    }

    if (fileStat.nlink !== 1) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Hardlink detected',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.HARDLINK_DETECTED },
      };
    }

    let handle;
    try {
      const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
      handle = await fsOps.open(resolvedPath, flags);
      const fstat = await handle.stat();
      if (fstat.dev !== fileStat.dev || fstat.ino !== fileStat.ino) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Device/inode mismatch',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
        };
      }
    } catch (_openErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'File observation failed',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.FILE_OBSERVATION_FAILED },
      };
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (_cErr) {}
      }
    }

    return {
      ok: true,
      value: { avatar, status: 'EXISTS' },
    };
  }

  async function scanStore(params) {
    if (!params || typeof params !== 'object') {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid scanStore parameters',
        recoverable: false,
      };
    }

    const { userRoot, charactersRoot, observedAvatars } = params;
    if (typeof userRoot !== 'string' || userRoot.length === 0 || typeof charactersRoot !== 'string' || charactersRoot.length === 0) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid root parameters',
        recoverable: false,
      };
    }

    if (observedAvatars !== undefined) {
      if (!Array.isArray(observedAvatars)) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
          message: 'observedAvatars must be an array',
          recoverable: false,
        };
      }
      if (observedAvatars.length > limits.MAX_OBSERVED_AVATARS) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'observedAvatars exceeds limit',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.SCAN_BUDGET_EXCEEDED },
        };
      }
      for (const av of observedAvatars) {
        if (!isValidAvatar(av)) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.INVALID_AVATAR,
            message: 'Invalid avatar in observedAvatars',
            recoverable: false,
          };
        }
      }
    }

    // Verify path chain and ancestors (Blocking Findings C and D)
    const chainRes = await validatePathChain(fsOps, userRoot);
    if (!chainRes.ok) {
      return chainRes;
    }

    if (chainRes.status === 'ABSENT_HUB') {
      // Clean absent store: zero writes, observe requested avatars, return COMPLETE empty snapshot
      const observedFiles = [];
      if (observedAvatars && observedAvatars.length > 0) {
        const uniqueAvatars = Array.from(new Set(observedAvatars));
        for (const av of uniqueAvatars) {
          const obs = await observeAvatar({ charactersRoot, avatar: av });
          if (!obs.ok) {
            return {
              ok: false,
              code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
              message: 'File observation failed',
              recoverable: false,
              details: { reason: obs.details?.reason || DIAGNOSTIC_REASONS.FILE_OBSERVATION_FAILED },
            };
          }
          observedFiles.push(obs.value);
        }
      }
      const cleanSnapshot = Object.freeze({
        claims: Object.freeze([]),
        files: Object.freeze(observedFiles),
        scanStatus: 'COMPLETE',
        schemaVersion: 1,
      });
      return {
        ok: true,
        value: cleanSnapshot,
      };
    }

    const cardsDir = chainRes.cardsDir;

    // Stream entries from cardsDir
    const cardIds = [];
    let enumeratedCount = 0;
    let cardsDirHandle;
    try {
      cardsDirHandle = await fsOps.opendir(cardsDir);
      for await (const dirent of cardsDirHandle) {
        enumeratedCount++;
        if (enumeratedCount > limits.MAX_CARD_DIRECTORIES) {
          // Boundary probe on the 513th entry terminates scan immediately
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
            message: 'Scan budget exceeded: too many card directories',
            recoverable: false,
            details: { reason: DIAGNOSTIC_REASONS.SCAN_BUDGET_EXCEEDED },
          };
        }
        if (!dirent.isDirectory()) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
            message: 'Unexpected non-directory entry in cards directory',
            recoverable: false,
            details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY },
          };
        }
        if (!UUID_V4_REGEX.test(dirent.name)) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
            message: 'Invalid UUID v4 card directory name',
            recoverable: false,
            details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY },
          };
        }
        cardIds.push(dirent.name);
      }
    } catch (_dirErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Failed to stream cards directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
      };
    }

    // Sort valid UUIDs lexicographically before reading states
    cardIds.sort();

    let aggregateBytesRead = 0;
    const claims = [];

    for (const cardId of cardIds) {
      const cardDir = path.join(cardsDir, cardId);

      // Check entries in UUID folder: exactly 1 entry allowed at rest ('state.json')
      let cardEntriesCount = 0;
      let hasStateJson = false;
      let singleCardDirHandle;
      try {
        singleCardDirHandle = await fsOps.opendir(cardDir);
        for await (const entry of singleCardDirHandle) {
          cardEntriesCount++;
          if (entry.name === 'state.json') {
            hasStateJson = true;
          }
        }
      } catch (_cardOpenErr) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Failed to inspect card directory',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
        };
      }

      if (cardEntriesCount === 0 || !hasStateJson) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Missing state.json in card directory',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.MISSING_STATE_JSON },
        };
      }

      if (cardEntriesCount > 1) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Residual or unexpected files detected in card directory',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DIR_RESIDUE_DETECTED },
        };
      }

      const statePath = path.join(cardDir, 'state.json');
      let stateStat;
      try {
        stateStat = await fsOps.lstat(statePath);
      } catch (_stErr) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Failed to lstat state.json',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.MISSING_STATE_JSON },
        };
      }

      if (stateStat.isSymbolicLink()) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Symlink detected for state.json',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
        };
      }

      if (!stateStat.isFile()) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'state.json is not a regular file',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_FILE_TYPE },
        };
      }

      if (stateStat.nlink !== 1) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Hardlink detected for state.json',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.HARDLINK_DETECTED },
        };
      }

      if (stateStat.size > limits.MAX_STATE_BYTES) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'state.json exceeds byte limit',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED },
        };
      }

      let stateHandle;
      let readResult;
      try {
        const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
        stateHandle = await fsOps.open(statePath, flags);
        const fstat = await stateHandle.stat();
        if (fstat.dev !== stateStat.dev || fstat.ino !== stateStat.ino) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
            message: 'Device/inode mismatch for state.json',
            recoverable: false,
            details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
          };
        }
        readResult = await readBoundedFile(stateHandle, limits.MAX_STATE_BYTES);
      } catch (_readErr) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Failed to read state.json',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
        };
      } finally {
        if (stateHandle) {
          try {
            await stateHandle.close();
          } catch (_cErr) {}
        }
      }

      if (!readResult.ok) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'state.json stream exceeded byte limit',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED },
        };
      }

      aggregateBytesRead += readResult.bytesRead;
      if (aggregateBytesRead > limits.MAX_AGGREGATE_BYTES) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Aggregate scan byte budget exceeded',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED },
        };
      }

      let parsedJson;
      try {
        parsedJson = JSON.parse(readResult.rawBytes);
      } catch (_jsonErr) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Failed to parse JSON in state.json',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.INVALID_SCHEMA },
        };
      }

      const validatedState = parseSidecarState(parsedJson, { expectedCardId: cardId });
      if (!validatedState.ok) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Invalid sidecar state in store',
          recoverable: false,
          details: { reason: validatedState.code },
        };
      }

      claims.push({
        avatar: validatedState.value.avatar,
        cardId: validatedState.value.cardId,
        state: validatedState.value,
      });
    }

    // Deduplicated union of claim avatars + observedAvatars
    const avatarSet = new Set();
    for (const claim of claims) {
      avatarSet.add(claim.avatar);
    }
    if (observedAvatars) {
      for (const av of observedAvatars) {
        avatarSet.add(av);
      }
    }

    if (avatarSet.size > limits.MAX_OBSERVED_AVATARS) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Deduplicated avatar union exceeds limit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.SCAN_BUDGET_EXCEEDED },
      };
    }

    const files = [];
    for (const av of avatarSet) {
      const obs = await observeAvatar({ charactersRoot, avatar: av });
      if (!obs.ok) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Avatar file observation failed',
          recoverable: false,
          details: { reason: obs.details?.reason || DIAGNOSTIC_REASONS.FILE_OBSERVATION_FAILED },
        };
      }
      files.push(obs.value);
    }

    const rawEvidence = {
      claims,
      files,
      scanStatus: 'COMPLETE',
      schemaVersion: 1,
    };

    const evidenceValidation = validateEvidence(rawEvidence);
    if (!evidenceValidation.ok) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Evidence validation failed',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.INCOMPLETE_STORE },
      };
    }

    return {
      ok: true,
      value: evidenceValidation.value,
    };
  }

  async function readState(params) {
    if (!params || typeof params !== 'object') {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid readState parameters',
        recoverable: false,
      };
    }

    const { userRoot, cardId } = params;
    if (typeof userRoot !== 'string' || userRoot.length === 0) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid userRoot',
        recoverable: false,
      };
    }

    if (typeof cardId !== 'string' || !UUID_V4_REGEX.test(cardId)) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_CARD_ID,
        message: 'Invalid cardId UUID v4',
        recoverable: false,
      };
    }

    const chainRes = await validatePathChain(fsOps, userRoot, cardId);
    if (!chainRes.ok) {
      return chainRes;
    }

    if (chainRes.status === 'ABSENT_HUB') {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STATE_NOT_FOUND,
        message: 'Sidecar state not found',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.CARD_DIRECTORY_MISSING },
      };
    }

    const cardDir = path.join(chainRes.cardsDir, cardId);
    let cardDirStat;
    try {
      cardDirStat = await fsOps.lstat(cardDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STATE_NOT_FOUND,
          message: 'Sidecar state not found',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.CARD_DIRECTORY_MISSING },
        };
      }
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.READ_FAILED,
        message: 'Failed to access card directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.IO_ERROR },
      };
    }

    if (cardDirStat.isSymbolicLink()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Symlink detected for card directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
      };
    }

    if (!cardDirStat.isDirectory()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Card directory must be a regular directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY },
      };
    }

    // Check for unexpected residue in targeted folder (Guardrail C)
    let entryCount = 0;
    let hasStateJson = false;
    let dirHandle;
    try {
      dirHandle = await fsOps.opendir(cardDir);
      for await (const entry of dirHandle) {
        entryCount++;
        if (entry.name === 'state.json') {
          hasStateJson = true;
        }
      }
    } catch (_dirErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.READ_FAILED,
        message: 'Failed to inspect card directory contents',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.IO_ERROR },
      };
    }

    if (entryCount === 0 || !hasStateJson) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Missing state.json in card directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.MISSING_STATE_JSON },
      };
    }

    if (entryCount > 1) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Residual or unexpected files detected in card directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.DIR_RESIDUE_DETECTED },
      };
    }

    const statePath = path.join(cardDir, 'state.json');
    let stateStat;
    try {
      stateStat = await fsOps.lstat(statePath);
    } catch (_stErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Failed to lstat state.json',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.MISSING_STATE_JSON },
      };
    }

    if (stateStat.isSymbolicLink()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.READ_FAILED,
        message: 'Symlink detected for state.json',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
      };
    }

    if (!stateStat.isFile()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.READ_FAILED,
        message: 'state.json is not a regular file',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_FILE_TYPE },
      };
    }

    if (stateStat.nlink !== 1) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.READ_FAILED,
        message: 'Hardlink detected for state.json',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.HARDLINK_DETECTED },
      };
    }

    if (stateStat.size > limits.MAX_STATE_BYTES) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
        message: 'state.json exceeds byte limit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED },
      };
    }

    let handle;
    let readResult;
    try {
      const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
      handle = await fsOps.open(statePath, flags);
      const fstat = await handle.stat();
      if (fstat.dev !== stateStat.dev || fstat.ino !== stateStat.ino) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.READ_FAILED,
          message: 'Device/inode mismatch for state.json',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
        };
      }
      readResult = await readBoundedFile(handle, limits.MAX_STATE_BYTES);
    } catch (_readErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.READ_FAILED,
        message: 'Failed to read state.json',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.IO_ERROR },
      };
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (_cErr) {}
      }
    }

    if (!readResult.ok) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
        message: 'state.json stream exceeded byte limit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED },
      };
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(readResult.rawBytes);
    } catch (_jsonErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.READ_FAILED,
        message: 'Failed to parse JSON in state.json',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.INVALID_SCHEMA },
      };
    }

    const validatedState = parseSidecarState(parsedJson, { expectedCardId: cardId });
    if (!validatedState.ok) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.READ_FAILED,
        message: 'Invalid sidecar state',
        recoverable: false,
        details: { reason: validatedState.code },
      };
    }

    return {
      ok: true,
      value: validatedState.value,
    };
  }

  async function createState(params) {
    if (!params || typeof params !== 'object') {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid createState parameters',
        recoverable: false,
      };
    }

    const { userRoot, state } = params;
    if (typeof userRoot !== 'string' || userRoot.length === 0) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid userRoot',
        recoverable: false,
      };
    }

    const parsedState = parseSidecarState(state);
    if (!parsedState.ok) {
      return parsedState;
    }

    const cardId = parsedState.value.cardId;
    const serializedResult = serializeSidecarState(parsedState.value);
    if (!serializedResult.ok) {
      return serializedResult;
    }
    const serializedBytes = serializedResult.value;
    if (getUtf8ByteLength(serializedBytes) > limits.MAX_STATE_BYTES) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
        message: 'Serialized state exceeds byte limit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED },
      };
    }

    // Verify userRoot exists
    let userRootStat;
    try {
      userRootStat = await fsOps.lstat(userRoot);
      if (!userRootStat.isDirectory() || userRootStat.isSymbolicLink()) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
          message: 'userRoot must be a regular directory',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.MKDIR_FAILED },
        };
      }
    } catch (_err) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'userRoot unavailable',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.MKDIR_FAILED },
      };
    }

    const hubDir = path.join(userRoot, 'chromaticHub');
    const cardsDir = path.join(hubDir, 'cards');
    const cardDir = path.join(cardsDir, cardId);

    // P01: Collision check: target directory must not exist (even empty or incomplete)
    try {
      await safeInvokeHook(faultHook, 'create:before-check-collision');
      const collisionStat = await fsOps.lstat(cardDir);
      if (collisionStat) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.ALREADY_BOUND,
          message: 'Card directory already exists',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DIRECTORY_EXISTS },
        };
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        if (err.point === 'create:before-check-collision') {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
            message: 'Injected fault before collision check',
            recoverable: false,
            details: { reason: DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME },
          };
        }
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.ALREADY_BOUND,
          message: 'Card directory already exists or collision check failed',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DIRECTORY_EXISTS },
        };
      }
    }

    try {
      await safeInvokeHook(faultHook, 'create:after-check-collision');
    } catch (_err) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Injected fault after collision check',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME },
      };
    }

    // Validate path chain and store hierarchy (Blocking Findings C and D)
    const chainRes = await validatePathChain(fsOps, userRoot, cardId);
    if (!chainRes.ok) {
      return chainRes;
    }

    if (chainRes.status === 'ABSENT_HUB') {
      // Hub directory missing: cleanly create hubDir and cardsDir with ancestor syncs
      try {
        await safeInvokeHook(faultHook, 'create:before-mkdir-hub');
        await fsOps.mkdir(hubDir, { mode: 0o700 });
        await safeInvokeHook(faultHook, 'create:after-mkdir-hub');

        await safeInvokeHook(faultHook, 'create:before-sync-user-root');
        await syncDirectory(fsOps, userRoot);
        await safeInvokeHook(faultHook, 'create:after-sync-user-root');

        await safeInvokeHook(faultHook, 'create:before-mkdir-cards');
        await fsOps.mkdir(cardsDir, { mode: 0o700 });
        await safeInvokeHook(faultHook, 'create:after-mkdir-cards');

        await safeInvokeHook(faultHook, 'create:before-sync-hub');
        await syncDirectory(fsOps, hubDir);
        await safeInvokeHook(faultHook, 'create:after-sync-hub');
      } catch (err) {
        const isFaultHook = err && typeof err.message === 'string' && (err.message.includes('create:') || err.point?.startsWith('create:'));
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
          message: 'Failed to create and sync store hierarchy',
          recoverable: false,
          details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME : DIAGNOSTIC_REASONS.MKDIR_FAILED },
        };
      }
    }

    // Create target card directory and sync cardsDir
    try {
      await safeInvokeHook(faultHook, 'create:before-mkdir-card');
      await fsOps.mkdir(cardDir, { mode: 0o700 });
      await safeInvokeHook(faultHook, 'create:after-mkdir-card');

      await safeInvokeHook(faultHook, 'create:before-sync-cards');
      await syncDirectory(fsOps, cardsDir);
      await safeInvokeHook(faultHook, 'create:after-sync-cards');
    } catch (err) {
      const isFaultHook = err && typeof err.message === 'string' && err.message.includes('create:');
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Failed to create card directory',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME : DIAGNOSTIC_REASONS.MKDIR_FAILED },
      };
    }

    // Stage temp file in cardDir
    const tempFileName = `.tmp-${crypto.randomBytes(8).toString('hex')}.tmp`;
    const tempPath = path.join(cardDir, tempFileName);
    const statePath = path.join(cardDir, 'state.json');

    let stagedDev;
    let stagedIno;
    let tempHandle;
    try {
      await safeInvokeHook(faultHook, 'create:before-temp-open');
      const flags = fsConstants.constants.O_CREAT |
        fsConstants.constants.O_EXCL |
        fsConstants.constants.O_WRONLY |
        (fsConstants.constants.O_NOFOLLOW || 0);
      tempHandle = await fsOps.open(tempPath, flags, 0o600);
      await safeInvokeHook(faultHook, 'create:after-temp-open');

      const tempStat = await tempHandle.stat();
      if (!tempStat.isFile() || tempStat.nlink !== 1 || typeof tempStat.dev === 'undefined' || typeof tempStat.ino === 'undefined') {
        throw new Error('Invalid temp file attributes');
      }
      stagedDev = tempStat.dev;
      stagedIno = tempStat.ino;

      await safeInvokeHook(faultHook, 'create:before-temp-write');
      const writeResult = await writeBufferFully(tempHandle, Buffer.from(serializedBytes, 'utf8'), limits.MAX_STATE_BYTES);
      if (!writeResult.ok) {
        throw new Error(writeResult.reason || 'TEMP_WRITE_FAILED');
      }
      await safeInvokeHook(faultHook, 'create:after-temp-write');

      await safeInvokeHook(faultHook, 'create:before-temp-sync');
      await tempHandle.sync();
      await safeInvokeHook(faultHook, 'create:after-temp-sync');

      await safeInvokeHook(faultHook, 'create:before-temp-close');
      await tempHandle.close();
      tempHandle = null;
      await safeInvokeHook(faultHook, 'create:after-temp-close');
    } catch (err) {
      if (tempHandle) {
        try {
          await tempHandle.close();
        } catch (_cErr) {}
      }
      const isFaultHook = err && typeof err.message === 'string' && (err.message.includes('create:') || err.point?.startsWith('create:'));
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Failed to write temp file for createState',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME : DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED },
      };
    }

    // Pre-rename verification: verify cardDir and temp file (P13-A & Blocking Finding B)
    try {
      await safeInvokeHook(faultHook, 'create:before-pre-rename-verify');

      // 1. Verify cardDir contains ONLY tempFileName
      let cardEntriesCount = 0;
      let hasOnlyTemp = true;
      const verifyDirHandle = await fsOps.opendir(cardDir);
      for await (const entry of verifyDirHandle) {
        cardEntriesCount++;
        if (entry.name !== tempFileName) {
          hasOnlyTemp = false;
        }
      }
      if (cardEntriesCount !== 1 || !hasOnlyTemp) {
        throw new Error('PRE_RENAME_VERIFY_FAILED: unexpected files in cardDir');
      }

      // 2. Verify state.json is strictly absent (ENOENT)
      let stateExists = false;
      try {
        await fsOps.lstat(statePath);
        stateExists = true;
      } catch (stErr) {
        if (!stErr || stErr.code !== 'ENOENT') {
          throw new Error('PRE_RENAME_VERIFY_FAILED: state.json lstat non-ENOENT');
        }
      }
      if (stateExists) {
        throw new Error('PRE_RENAME_VERIFY_FAILED: state.json already exists');
      }

      // 3. Verify tempStat
      const tempStat = await fsOps.lstat(tempPath);
      if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== 1 || tempStat.dev !== stagedDev || tempStat.ino !== stagedIno) {
        throw new Error('PRE_RENAME_VERIFY_FAILED: invalid temp file');
      }

      await safeInvokeHook(faultHook, 'create:after-pre-rename-verify');
      await safeInvokeHook(faultHook, 'create:before-rename');

      // Re-verify immediately before rename (catches late state.json or residue injected in create:before-rename)
      let finalStateExists = false;
      try {
        await fsOps.lstat(statePath);
        finalStateExists = true;
      } catch (fErr) {
        if (!fErr || fErr.code !== 'ENOENT') {
          throw new Error('PRE_RENAME_VERIFY_FAILED: state.json lstat non-ENOENT');
        }
      }
      if (finalStateExists) {
        throw new Error('PRE_RENAME_VERIFY_FAILED: late state.json detected immediately before rename');
      }

      let finalCount = 0;
      let finalHasOnlyTemp = true;
      const finalDirHandle = await fsOps.opendir(cardDir);
      for await (const entry of finalDirHandle) {
        finalCount++;
        if (entry.name !== tempFileName) {
          finalHasOnlyTemp = false;
        }
      }
      if (finalCount !== 1 || !finalHasOnlyTemp) {
        throw new Error('PRE_RENAME_VERIFY_FAILED: late residue detected immediately before rename');
      }

      // Fresh independent verification of staged temp file (G4-R2)
      const verifyTempRes = await verifyStagedTempFile(
        fsOps,
        tempPath,
        stagedDev,
        stagedIno,
        serializedBytes,
        limits.MAX_STATE_BYTES
      );
      if (!verifyTempRes.ok) {
        throw new Error('PRE_RENAME_VERIFY_FAILED: staged temp file verification failed');
      }
    } catch (err) {
      const isFaultHook = err && typeof err.message === 'string' && (err.message.includes('create:') || err.point?.startsWith('create:'));
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Pre-rename verification failed',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME : DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED },
      };
    }

    // --- COMMIT DIVIDING LINE ---
    try {
      await fsOps.rename(tempPath, statePath);
    } catch (_renErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Rename failed during createState',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.RENAME_FAILED },
      };
    }

    try {
      await safeInvokeHook(faultHook, 'create:after-rename');
      await safeInvokeHook(faultHook, 'create:before-dir-sync');
      await syncDirectory(fsOps, cardDir);
      await safeInvokeHook(faultHook, 'create:after-dir-sync');
    } catch (err) {
      const isFaultHook = err && typeof err.message === 'string' && err.message.includes('create:');
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Directory sync failed after rename in createState',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_POST_RENAME : DIAGNOSTIC_REASONS.DIRSYNC_FAILED },
      };
    }

    // Fresh independent readback
    let readbackHandle;
    let readResult;
    try {
      await safeInvokeHook(faultHook, 'create:before-readback');
      const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
      readbackHandle = await fsOps.open(statePath, flags);
      readResult = await readBoundedFile(readbackHandle, limits.MAX_STATE_BYTES);
      await readbackHandle.close();
      readbackHandle = null;
      await safeInvokeHook(faultHook, 'create:after-readback');
    } catch (err) {
      if (readbackHandle) {
        try {
          await readbackHandle.close();
        } catch (_cErr) {}
      }
      const isFaultHook = err && typeof err.message === 'string' && err.message.includes('create:');
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Readback failed after createState commit',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_POST_RENAME : DIAGNOSTIC_REASONS.READBACK_FAILED },
      };
    }

    if (!readResult.ok || readResult.rawBytes !== serializedBytes) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Readback bytes mismatch after createState commit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.READBACK_MISMATCH },
      };
    }

    let parsedReadbackJson;
    try {
      parsedReadbackJson = JSON.parse(readResult.rawBytes);
    } catch (_jsonErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Readback JSON parse failed after createState commit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.READBACK_MISMATCH },
      };
    }

    const validatedReadback = parseSidecarState(parsedReadbackJson, { expectedCardId: cardId });
    if (!validatedReadback.ok) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Readback state validation failed after createState commit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.READBACK_MISMATCH },
      };
    }

    return {
      ok: true,
      changed: true,
      value: validatedReadback.value,
    };
  }

  async function replaceState(params) {
    if (!params || typeof params !== 'object') {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid replaceState parameters',
        recoverable: false,
      };
    }

    const { userRoot, cardId, expectedBytes, nextState } = params;
    if (typeof userRoot !== 'string' || userRoot.length === 0) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid userRoot',
        recoverable: false,
      };
    }

    if (typeof cardId !== 'string' || !UUID_V4_REGEX.test(cardId)) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_CARD_ID,
        message: 'Invalid cardId UUID v4',
        recoverable: false,
      };
    }

    if (typeof expectedBytes !== 'string' || expectedBytes.length === 0) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid expectedBytes',
        recoverable: false,
      };
    }

    // Validate expectedBytes is the canonical UTF-8 representation of a valid state owned by cardId (Guardrail B)
    let parsedExpectedJson;
    try {
      parsedExpectedJson = JSON.parse(expectedBytes);
    } catch (_err) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'expectedBytes must be valid JSON',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.INVALID_SCHEMA },
      };
    }

    const validatedExpected = parseSidecarState(parsedExpectedJson, { expectedCardId: cardId });
    if (!validatedExpected.ok) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'expectedBytes does not represent a valid state for cardId',
        recoverable: false,
        details: { reason: validatedExpected.code },
      };
    }

    const serializedExpectedResult = serializeSidecarState(validatedExpected.value);
    if (!serializedExpectedResult.ok || serializedExpectedResult.value !== expectedBytes) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.INVALID_REQUEST,
        message: 'expectedBytes must be canonical serialized JSON',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.INVALID_SCHEMA },
      };
    }

    // Validate nextState
    const validatedNext = parseSidecarState(nextState, { expectedCardId: cardId });
    if (!validatedNext.ok) {
      return validatedNext;
    }

    const serializedNextResult = serializeSidecarState(validatedNext.value);
    if (!serializedNextResult.ok) {
      return serializedNextResult;
    }
    const nextSerializedBytes = serializedNextResult.value;
    if (getUtf8ByteLength(nextSerializedBytes) > limits.MAX_STATE_BYTES) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
        message: 'nextState exceeds byte limit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED },
      };
    }

    // Validate path chain and store hierarchy (Blocking Findings C and D)
    const chainRes = await validatePathChain(fsOps, userRoot, cardId);
    if (!chainRes.ok) {
      return chainRes;
    }

    if (chainRes.status === 'ABSENT_HUB') {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STATE_NOT_FOUND,
        message: 'Target card directory does not exist for replaceState',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.STATE_NOT_FOUND },
      };
    }

    const cardDir = path.join(chainRes.cardsDir, cardId);
    let cardDirStat;
    try {
      cardDirStat = await fsOps.lstat(cardDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STATE_NOT_FOUND,
          message: 'Target card directory does not exist for replaceState',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.STATE_NOT_FOUND },
        };
      }
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Failed to access target card directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.IO_ERROR },
      };
    }

    if (cardDirStat.isSymbolicLink()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Symlink detected for target card directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
      };
    }

    if (!cardDirStat.isDirectory()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Target card directory must be a regular directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY },
      };
    }

    // Blocking Finding E (Check 1): Before staging, cardDir must contain exactly one file: 'state.json'
    let preStageCount = 0;
    let preStageHasState = false;
    let preStageHasResidue = false;
    try {
      const preStageDirHandle = await fsOps.opendir(cardDir);
      for await (const entry of preStageDirHandle) {
        preStageCount++;
        if (entry.name === 'state.json') {
          preStageHasState = true;
        } else {
          preStageHasResidue = true;
        }
      }
    } catch (_dirErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Failed to inspect card directory contents before replace',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.IO_ERROR },
      };
    }

    if (preStageCount === 0 || !preStageHasState) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Missing state.json in card directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.MISSING_STATE_JSON },
      };
    }

    if (preStageHasResidue || preStageCount !== 1) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Residual or unexpected files detected in card directory',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.DIR_RESIDUE_DETECTED },
      };
    }

    const statePath = path.join(cardDir, 'state.json');

    // P08: Initial CAS Pre-Read
    let initialLstat;
    try {
      await safeInvokeHook(faultHook, 'replace:before-cas-read-1');
      initialLstat = await fsOps.lstat(statePath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STATE_NOT_FOUND,
          message: 'Target state.json not found for replaceState',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.STATE_NOT_FOUND },
        };
      }
      const isFaultHook = err && typeof err.message === 'string' && err.message.includes('replace:');
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Failed to lstat state.json for initial CAS',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME : DIAGNOSTIC_REASONS.IO_ERROR },
      };
    }

    if (initialLstat.isSymbolicLink()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Symlink detected for target state.json',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.SYMLINK_DETECTED },
      };
    }

    if (!initialLstat.isFile()) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Target state.json is not a regular file',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.UNEXPECTED_FILE_TYPE },
      };
    }

    if (initialLstat.nlink !== 1) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Hardlink detected for target state.json',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.HARDLINK_DETECTED },
      };
    }

    let initialHandle;
    let initialReadResult;
    try {
      const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
      initialHandle = await fsOps.open(statePath, flags);
      const fstat = await initialHandle.stat();
      if (fstat.dev !== initialLstat.dev || fstat.ino !== initialLstat.ino) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Device/inode mismatch for target state.json',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
        };
      }
      initialReadResult = await readBoundedFile(initialHandle, limits.MAX_STATE_BYTES);
    } catch (_err) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Failed to read target state.json during initial CAS',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.IO_ERROR },
      };
    } finally {
      if (initialHandle) {
        try {
          await initialHandle.close();
        } catch (_cErr) {}
      }
    }

    try {
      await safeInvokeHook(faultHook, 'replace:after-cas-read-1');
    } catch (_err) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Fault injected after initial CAS read',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME },
      };
    }

    if (!initialReadResult.ok) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED,
        message: 'Existing state.json exceeds byte limit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED },
      };
    }

    // Parse and validate existing state to classify schema corruption vs CAS mismatch (Guardrail B)
    let parsedExistingJson;
    try {
      parsedExistingJson = JSON.parse(initialReadResult.rawBytes);
    } catch (_err) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Existing state.json is corrupted JSON',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.INVALID_SCHEMA },
      };
    }

    const validatedExisting = parseSidecarState(parsedExistingJson, { expectedCardId: cardId });
    if (!validatedExisting.ok) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: 'Existing state.json is corrupted or invalid',
        recoverable: false,
        details: { reason: validatedExisting.code },
      };
    }

    // Compare actual raw bytes with expectedBytes
    if (initialReadResult.rawBytes !== expectedBytes) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.REVISION_CONFLICT,
        message: 'Existing state content does not match expectedBytes',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.CAS_MISMATCH },
      };
    }

    const initialIno = initialLstat.ino;
    const initialDev = initialLstat.dev;

    // Stage temp file in cardDir
    const tempFileName = `.tmp-${crypto.randomBytes(8).toString('hex')}.tmp`;
    const tempPath = path.join(cardDir, tempFileName);

    let stagedDev;
    let stagedIno;
    let tempHandle;
    try {
      await safeInvokeHook(faultHook, 'replace:before-temp-open');
      const flags = fsConstants.constants.O_CREAT |
        fsConstants.constants.O_EXCL |
        fsConstants.constants.O_WRONLY |
        (fsConstants.constants.O_NOFOLLOW || 0);
      tempHandle = await fsOps.open(tempPath, flags, 0o600);
      await safeInvokeHook(faultHook, 'replace:after-temp-open');

      const tempStat = await tempHandle.stat();
      if (!tempStat.isFile() || tempStat.nlink !== 1 || typeof tempStat.dev === 'undefined' || typeof tempStat.ino === 'undefined') {
        throw new Error('Invalid temp file attributes');
      }
      stagedDev = tempStat.dev;
      stagedIno = tempStat.ino;

      await safeInvokeHook(faultHook, 'replace:before-temp-write');
      const writeResult = await writeBufferFully(tempHandle, Buffer.from(nextSerializedBytes, 'utf8'), limits.MAX_STATE_BYTES);
      if (!writeResult.ok) {
        throw new Error(writeResult.reason || 'TEMP_WRITE_FAILED');
      }
      await safeInvokeHook(faultHook, 'replace:after-temp-write');

      await safeInvokeHook(faultHook, 'replace:before-temp-sync');
      await tempHandle.sync();
      await safeInvokeHook(faultHook, 'replace:after-temp-sync');

      await safeInvokeHook(faultHook, 'replace:before-temp-close');
      await tempHandle.close();
      tempHandle = null;
      await safeInvokeHook(faultHook, 'replace:after-temp-close');
    } catch (err) {
      if (tempHandle) {
        try {
          await tempHandle.close();
        } catch (_cErr) {}
      }
      const isFaultHook = err && typeof err.message === 'string' && (err.message.includes('replace:') || err.point?.startsWith('replace:'));
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Failed to write temp file for replaceState',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME : DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED },
      };
    }

    // P13-B: Second Pre-Rename CAS Check & Residue Verification (Guardrail B & Blocking Finding E Check 2)
    let preRenameLstat;
    let preRenameReadResult;
    try {
      await safeInvokeHook(faultHook, 'replace:before-cas-read-2');
      preRenameLstat = await fsOps.lstat(statePath);
      if (preRenameLstat.isSymbolicLink() || !preRenameLstat.isFile() || preRenameLstat.nlink !== 1) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Target state.json modified or corrupted before rename',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
        };
      }
      if (preRenameLstat.dev !== initialDev || preRenameLstat.ino !== initialIno) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Device/inode drift detected before rename',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
        };
      }

      const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
      const preRenameHandle = await fsOps.open(statePath, flags);
      try {
        const fstat = await preRenameHandle.stat();
        if (fstat.dev !== initialDev || fstat.ino !== initialIno) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
            message: 'Device/inode drift detected on handle before rename',
            recoverable: false,
            details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
          };
        }
        preRenameReadResult = await readBoundedFile(preRenameHandle, limits.MAX_STATE_BYTES);
      } finally {
        await preRenameHandle.close();
      }
      await safeInvokeHook(faultHook, 'replace:after-cas-read-2');
    } catch (err) {
      const isFaultHook = err && typeof err.message === 'string' && (err.message.includes('replace:') || err.point?.startsWith('replace:'));
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Pre-rename CAS check failed',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME : DIAGNOSTIC_REASONS.IO_ERROR },
      };
    }

    if (!preRenameReadResult.ok || preRenameReadResult.rawBytes !== expectedBytes) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.REVISION_CONFLICT,
        message: 'Target state content drifted during staging',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.CAS_MISMATCH_PRE_RENAME },
      };
    }

    // Pre-rename verification: verify cardDir has exactly state.json and tempFileName (Finding E Check 2)
    try {
      await safeInvokeHook(faultHook, 'replace:before-rename');

      // Re-verify immediately before rename: cardDir must contain EXACTLY state.json and tempFileName
      let preRenameCount = 0;
      let preRenameOnlyExpected = true;
      const preRenameDirHandle = await fsOps.opendir(cardDir);
      for await (const entry of preRenameDirHandle) {
        preRenameCount++;
        if (entry.name !== 'state.json' && entry.name !== tempFileName) {
          preRenameOnlyExpected = false;
        }
      }

      if (preRenameCount !== 2 || !preRenameOnlyExpected) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
          message: 'Injected residue or unexpected entry detected before rename',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED },
        };
      }

      // Fresh independent verification of staged temp file (G4-R2)
      const verifyTempRes = await verifyStagedTempFile(
        fsOps,
        tempPath,
        stagedDev,
        stagedIno,
        nextSerializedBytes,
        limits.MAX_STATE_BYTES
      );
      if (!verifyTempRes.ok) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
          message: 'Pre-rename verification failed in replaceState',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED },
        };
      }

      // Fresh final pre-rename canonical-state check (Finding G4-R3)
      let finalCanonicalLstat;
      try {
        finalCanonicalLstat = await fsOps.lstat(statePath);
      } catch (_stErr) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Target state.json not found before rename',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.MISSING_STATE_JSON },
        };
      }

      if (
        typeof finalCanonicalLstat.isSymbolicLink !== 'function' ||
        finalCanonicalLstat.isSymbolicLink() ||
        typeof finalCanonicalLstat.isFile !== 'function' ||
        !finalCanonicalLstat.isFile() ||
        finalCanonicalLstat.nlink !== 1 ||
        finalCanonicalLstat.dev !== initialDev ||
        finalCanonicalLstat.ino !== initialIno
      ) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Target state.json identity or type integrity compromised before rename',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
        };
      }

      const oNoFollow = fsConstants?.constants?.O_NOFOLLOW;
      if (typeof oNoFollow !== 'number') {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Safe file open unsupported',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.STORAGE_UNAVAILABLE },
        };
      }

      let finalCanonicalHandle;
      let finalCanonicalReadResult;
      let finalCanonicalCloseError = null;
      try {
        const flags = fsConstants.constants.O_RDONLY | oNoFollow;
        finalCanonicalHandle = await fsOps.open(statePath, flags);

        const fstat = await finalCanonicalHandle.stat();
        if (
          typeof fstat.isFile !== 'function' ||
          !fstat.isFile() ||
          fstat.nlink !== 1 ||
          fstat.dev !== initialDev ||
          fstat.ino !== initialIno ||
          fstat.dev !== finalCanonicalLstat.dev ||
          fstat.ino !== finalCanonicalLstat.ino
        ) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
            message: 'Device/inode drift detected on canonical handle before rename',
            recoverable: false,
            details: { reason: DIAGNOSTIC_REASONS.DEV_INO_MISMATCH },
          };
        }

        finalCanonicalReadResult = await readBoundedFile(finalCanonicalHandle, limits.MAX_STATE_BYTES);
      } catch (_openErr) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Failed to access canonical state before rename',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.IO_ERROR },
        };
      } finally {
        if (finalCanonicalHandle) {
          try {
            await finalCanonicalHandle.close();
          } catch (cErr) {
            finalCanonicalCloseError = cErr;
          }
        }
      }

      if (finalCanonicalCloseError) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Failed to close canonical handle before rename',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.IO_ERROR },
        };
      }

      if (!finalCanonicalReadResult.ok) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: 'Canonical state read failed or exceeded byte limit before rename',
          recoverable: false,
          details: {
            reason: finalCanonicalReadResult.code === FILE_STORE_ERROR_CODES.BYTE_LIMIT_EXCEEDED
              ? DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED
              : DIAGNOSTIC_REASONS.IO_ERROR,
          },
        };
      }

      if (finalCanonicalReadResult.rawBytes !== expectedBytes) {
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.REVISION_CONFLICT,
          message: 'Target state content drifted during staging',
          recoverable: false,
          details: { reason: DIAGNOSTIC_REASONS.CAS_MISMATCH_PRE_RENAME },
        };
      }
    } catch (err) {
      const isFaultHook = err && typeof err.message === 'string' && (err.message.includes('replace:') || err.point?.startsWith('replace:'));
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Pre-rename verification failed in replaceState',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME : DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED },
      };
    }

    // --- COMMIT DIVIDING LINE ---
    try {
      await fsOps.rename(tempPath, statePath);
    } catch (_renErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Rename failed during replaceState',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.RENAME_FAILED },
      };
    }

    try {
      await safeInvokeHook(faultHook, 'replace:after-rename');
      await safeInvokeHook(faultHook, 'replace:before-dir-sync');
      await syncDirectory(fsOps, cardDir);
      await safeInvokeHook(faultHook, 'replace:after-dir-sync');
    } catch (err) {
      const isFaultHook = err && typeof err.message === 'string' && err.message.includes('replace:');
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Directory sync failed after rename in replaceState',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_POST_RENAME : DIAGNOSTIC_REASONS.DIRSYNC_FAILED },
      };
    }

    // Fresh independent readback
    let readbackHandle;
    let readResult;
    try {
      await safeInvokeHook(faultHook, 'replace:before-readback');
      const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
      readbackHandle = await fsOps.open(statePath, flags);
      readResult = await readBoundedFile(readbackHandle, limits.MAX_STATE_BYTES);
      await readbackHandle.close();
      readbackHandle = null;
      await safeInvokeHook(faultHook, 'replace:after-readback');
    } catch (err) {
      if (readbackHandle) {
        try {
          await readbackHandle.close();
        } catch (_cErr) {}
      }
      const isFaultHook = err && typeof err.message === 'string' && err.message.includes('replace:');
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Readback failed after replaceState commit',
        recoverable: false,
        details: { reason: isFaultHook ? DIAGNOSTIC_REASONS.FAULT_INJECTED_POST_RENAME : DIAGNOSTIC_REASONS.READBACK_FAILED },
      };
    }

    if (!readResult.ok || readResult.rawBytes !== nextSerializedBytes) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Readback bytes mismatch after replaceState commit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.READBACK_MISMATCH },
      };
    }

    let parsedReadbackJson;
    try {
      parsedReadbackJson = JSON.parse(readResult.rawBytes);
    } catch (_jsonErr) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Readback JSON parse failed after replaceState commit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.READBACK_MISMATCH },
      };
    }

    const validatedReadback = parseSidecarState(parsedReadbackJson, { expectedCardId: cardId });
    if (!validatedReadback.ok) {
      return {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Readback state validation failed after replaceState commit',
        recoverable: false,
        details: { reason: DIAGNOSTIC_REASONS.READBACK_MISMATCH },
      };
    }

    return {
      ok: true,
      changed: true,
      value: validatedReadback.value,
    };
  }

  return Object.freeze({
    observeAvatar,
    scanStore,
    readState,
    createState,
    replaceState,
  });
}
