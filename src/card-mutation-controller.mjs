/**
 * SillyTavern-ChromaticHub: Guarded Single-Card Mutation Controller (H01-B2-R3)
 *
 * Implements guarded, single-card mutation of data.extensions.chromaticHub.
 * Reuses pure core identity contracts and read-only SillyTavern adapter.
 *
 * Enforces hard network deadlines, quarantine on uncertainty, diagnostic privacy,
 * fail-closed dependency boundaries, post-dispatch exception containment, and
 * comprehensive resource cleanup.
 */

import { planMutation, serializeRegistry } from './identity-registry.mjs';
import { readCard as defaultReadCard } from './sillytavern-adapter.mjs';

const DEFAULT_POST_TIMEOUT_MS = 10000;
const MAX_POST_TIMEOUT_MS = 60000;
const DEFAULT_VERIFY_TIMEOUT_MS = 5000;
const MAX_VERIFY_TIMEOUT_MS = 30000;

const PNG_EXTENSION_REGEX = /\.[pP][nN][gG]$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Operation-phase lifecycle states
const OP_PHASE = Object.freeze({
  PRE_DISPATCH: 'PRE_DISPATCH',
  POST_DISPATCHED: 'POST_DISPATCHED',
  POST_VERIFYING: 'POST_VERIFYING',
});

// Module-private queue and quarantine registries
const avatarQueues = new Map();
const quarantinedAvatars = new Set();

function isPlainObject(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function hasOwnForbiddenPrototypeKeys(obj) {
  if (Object.prototype.hasOwnProperty.call(obj, '__proto__')) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'constructor')) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'prototype')) {
    return true;
  }
  return false;
}

function validateOwner(owner) {
  try {
    if (!isPlainObject(owner) || hasOwnForbiddenPrototypeKeys(owner)) {
      return {
        ok: false,
        code: 'INVALID_OWNER',
        message: 'Owner must be a plain object',
        recoverable: false,
      };
    }

    if (owner.kind !== 'installed-card') {
      return {
        ok: false,
        code: 'INVALID_OWNER',
        message: 'Owner kind must be "installed-card"',
        recoverable: false,
      };
    }

    if (typeof owner.avatar !== 'string') {
      return {
        ok: false,
        code: 'INVALID_OWNER',
        message: 'Owner avatar must be a string',
        recoverable: false,
      };
    }

    const avatar = owner.avatar;
    if (avatar.trim().length === 0) {
      return {
        ok: false,
        code: 'INVALID_OWNER',
        message: 'Owner avatar cannot be empty',
        recoverable: false,
      };
    }

    if (avatar.includes('/') || avatar.includes('\\')) {
      return {
        ok: false,
        code: 'INVALID_OWNER',
        message: 'Owner avatar cannot contain path separators',
        recoverable: false,
      };
    }

    if (CONTROL_CHARS_REGEX.test(avatar)) {
      return {
        ok: false,
        code: 'INVALID_OWNER',
        message: 'Owner avatar cannot contain control characters',
        recoverable: false,
      };
    }

    if (!PNG_EXTENSION_REGEX.test(avatar)) {
      return {
        ok: false,
        code: 'INVALID_OWNER',
        message: 'Owner avatar must have a .png extension',
        recoverable: false,
      };
    }

    const stem = avatar.slice(0, -4);
    if (stem.length === 0 || stem === '.' || stem === '..' || stem.trim().length === 0) {
      return {
        ok: false,
        code: 'INVALID_OWNER',
        message: 'Owner avatar stem cannot be empty or a relative-path sequence',
        recoverable: false,
      };
    }

    return { ok: true, avatar };
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_OWNER',
      message: 'Failed to inspect owner properties',
      recoverable: false,
    };
  }
}

function validateCommand(command) {
  try {
    if (!isPlainObject(command) || hasOwnForbiddenPrototypeKeys(command)) {
      return {
        ok: false,
        code: 'INVALID_COMMAND',
        message: 'Command must be a plain object',
        recoverable: false,
      };
    }

    const type = command.type;
    if (type !== 'add' && type !== 'update' && type !== 'remove') {
      return {
        ok: false,
        code: 'INVALID_COMMAND',
        message: `Unknown command type: ${String(type)}`,
        recoverable: false,
      };
    }

    if (type === 'add') {
      if (!isPlainObject(command.character) || hasOwnForbiddenPrototypeKeys(command.character)) {
        return {
          ok: false,
          code: 'INVALID_COMMAND',
          message: 'character must be a plain object on add',
          recoverable: false,
        };
      }
      if (Object.prototype.hasOwnProperty.call(command.character, 'id')) {
        return {
          ok: false,
          code: 'INVALID_COMMAND',
          message: 'Caller-supplied identity ID is forbidden on add',
          recoverable: false,
        };
      }
    }

    if (type === 'update') {
      if (!isPlainObject(command.character) || hasOwnForbiddenPrototypeKeys(command.character)) {
        return {
          ok: false,
          code: 'INVALID_COMMAND',
          message: 'character must be a plain object on update',
          recoverable: false,
        };
      }
      if (typeof command.character.id !== 'string' || !UUID_V4_REGEX.test(command.character.id)) {
        return {
          ok: false,
          code: 'INVALID_COMMAND',
          message: 'Valid identity ID required on update character',
          recoverable: false,
        };
      }
    }

    if (type === 'remove') {
      if (typeof command.identityId !== 'string' || !UUID_V4_REGEX.test(command.identityId)) {
        return {
          ok: false,
          code: 'INVALID_COMMAND',
          message: 'Valid identityId required on remove',
          recoverable: false,
        };
      }
    }

    return { ok: true };
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_COMMAND',
      message: 'Failed to inspect command properties',
      recoverable: false,
    };
  }
}

function validateExpectedSnapshot(expectedSnapshot) {
  try {
    if (!isPlainObject(expectedSnapshot) || hasOwnForbiddenPrototypeKeys(expectedSnapshot)) {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: 'expectedSnapshot must be a plain object',
        recoverable: false,
      };
    }

    const status = expectedSnapshot.status;
    if (status !== 'UNINITIALIZED' && status !== 'VALID') {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: 'expectedSnapshot.status must be "UNINITIALIZED" or "VALID"',
        recoverable: false,
      };
    }

    if (status === 'VALID') {
      if (!isPlainObject(expectedSnapshot.value)) {
        return {
          ok: false,
          code: 'INVALID_OPTIONS',
          message: 'expectedSnapshot.value must be a valid registry object when status is "VALID"',
          recoverable: false,
        };
      }
    }

    return { ok: true };
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'Failed to inspect expectedSnapshot properties',
      recoverable: false,
    };
  }
}

function validateDependencies(dependencies) {
  try {
    if (!isPlainObject(dependencies) || hasOwnForbiddenPrototypeKeys(dependencies)) {
      return {
        ok: false,
        code: 'INVALID_DEPENDENCY',
        message: 'dependencies must be a plain object',
        recoverable: false,
      };
    }
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies must be a plain object',
      recoverable: false,
    };
  }

  let getRequestHeaders;
  try {
    getRequestHeaders = dependencies.getRequestHeaders;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'Failed to access getRequestHeaders dependency',
      recoverable: false,
    };
  }
  if (typeof getRequestHeaders !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.getRequestHeaders must be a function',
      recoverable: false,
    };
  }

  let checkEditorSafety;
  try {
    checkEditorSafety = dependencies.checkEditorSafety;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'Failed to access checkEditorSafety dependency',
      recoverable: false,
    };
  }
  if (typeof checkEditorSafety !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.checkEditorSafety must be a function',
      recoverable: false,
    };
  }

  let getContext;
  try {
    getContext = dependencies.getContext;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'Failed to access getContext dependency',
      recoverable: false,
    };
  }
  if (typeof getContext !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.getContext must be a function',
      recoverable: false,
    };
  }

  let expectedContext;
  try {
    expectedContext = dependencies.expectedContext;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'Failed to access expectedContext dependency',
      recoverable: false,
    };
  }

  try {
    if (!isPlainObject(expectedContext) || hasOwnForbiddenPrototypeKeys(expectedContext)) {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: 'dependencies.expectedContext must be a plain object',
        recoverable: false,
      };
    }
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'dependencies.expectedContext must be a plain object',
      recoverable: false,
    };
  }

  let keys;
  try {
    keys = Object.keys(expectedContext);
  } catch (_err) {
    return {
      ok: false,
      code: 'STALE_CARD_LOCATOR',
      message: 'Failed to inspect expectedContext keys',
      recoverable: false,
      details: { reason: 'CONTEXT_EVALUATION_FAILED' },
    };
  }

  if (keys.length === 0) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'dependencies.expectedContext cannot be an empty object',
      recoverable: false,
    };
  }

  let hasDirectAvatar = false;
  let hasCharAvatar = false;
  try {
    hasDirectAvatar =
      typeof expectedContext.avatar === 'string' &&
      expectedContext.avatar.trim().length > 0;
    hasCharAvatar =
      Array.isArray(expectedContext.characters) &&
      typeof expectedContext.characterId === 'number';
  } catch (_err) {
    return {
      ok: false,
      code: 'STALE_CARD_LOCATOR',
      message: 'Failed to evaluate context properties',
      recoverable: false,
      details: { reason: 'CONTEXT_EVALUATION_FAILED' },
    };
  }
  if (!hasDirectAvatar && !hasCharAvatar) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'dependencies.expectedContext must contain identifying avatar or characters[characterId]',
      recoverable: false,
    };
  }

  let fetchFn;
  try {
    fetchFn = dependencies.fetch;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'Failed to access fetch dependency',
      recoverable: false,
    };
  }
  if (fetchFn !== undefined && typeof fetchFn !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.fetch must be a function when supplied',
      recoverable: false,
    };
  }

  let readCardFn;
  try {
    readCardFn = dependencies.readCard;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'Failed to access readCard dependency',
      recoverable: false,
    };
  }
  if (readCardFn !== undefined && typeof readCardFn !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.readCard must be a function when supplied',
      recoverable: false,
    };
  }

  let signal;
  try {
    signal = dependencies.signal;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'Failed to access signal option',
      recoverable: false,
    };
  }
  if (signal !== undefined) {
    try {
      if (signal === null || typeof signal !== 'object' || typeof signal.aborted !== 'boolean') {
        return {
          ok: false,
          code: 'INVALID_OPTIONS',
          message: 'dependencies.signal must be an AbortSignal instance',
          recoverable: false,
        };
      }
    } catch (_err) {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: 'dependencies.signal property evaluation threw',
        recoverable: false,
      };
    }
  }

  let postTimeoutMs;
  try {
    postTimeoutMs = dependencies.postTimeoutMs;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'Failed to access postTimeoutMs option',
      recoverable: false,
    };
  }
  if (postTimeoutMs !== undefined) {
    if (
      typeof postTimeoutMs !== 'number' ||
      !Number.isSafeInteger(postTimeoutMs) ||
      postTimeoutMs <= 0 ||
      postTimeoutMs > MAX_POST_TIMEOUT_MS
    ) {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: `postTimeoutMs must be a positive safe integer <= ${MAX_POST_TIMEOUT_MS}`,
        recoverable: false,
      };
    }
  }

  let verifyTimeoutMs;
  try {
    verifyTimeoutMs = dependencies.verifyTimeoutMs;
  } catch (_err) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'Failed to access verifyTimeoutMs option',
      recoverable: false,
    };
  }
  if (verifyTimeoutMs !== undefined) {
    if (
      typeof verifyTimeoutMs !== 'number' ||
      !Number.isSafeInteger(verifyTimeoutMs) ||
      verifyTimeoutMs <= 0 ||
      verifyTimeoutMs > MAX_VERIFY_TIMEOUT_MS
    ) {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: `verifyTimeoutMs must be a positive safe integer <= ${MAX_VERIFY_TIMEOUT_MS}`,
        recoverable: false,
      };
    }
  }

  return { ok: true };
}

function resolveContextAvatar(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }
  if (typeof ctx.avatar === 'string' && ctx.avatar.trim().length > 0) {
    return ctx.avatar;
  }
  if (Array.isArray(ctx.characters) && typeof ctx.characterId === 'number') {
    const char = ctx.characters[ctx.characterId];
    if (char && typeof char.avatar === 'string' && char.avatar.trim().length > 0) {
      return char.avatar;
    }
  }
  return null;
}

function evaluateContext(owner, expectedContext, getContext) {
  try {
    if (expectedContext.groupId) {
      return {
        ok: false,
        code: 'UNSUPPORTED_CONTEXT',
        message: 'Group chat card mutations are unsupported',
        recoverable: false,
      };
    }

    const expectedAvatar = resolveContextAvatar(expectedContext);
    if (!expectedAvatar || expectedAvatar !== owner.avatar) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: `Expected context avatar (${expectedAvatar ?? 'none'}) does not match target owner avatar (${owner.avatar})`,
        recoverable: false,
      };
    }

    let liveCtx;
    try {
      liveCtx = getContext();
    } catch (_err) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: 'Context evaluation threw an exception',
        recoverable: false,
        details: { reason: 'CONTEXT_EVALUATION_FAILED' },
      };
    }

    if (!liveCtx || typeof liveCtx !== 'object') {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: 'getContext returned null or non-object',
        recoverable: false,
        details: { reason: 'INVALID_CONTEXT_OBJECT' },
      };
    }

    if (liveCtx.groupId) {
      return {
        ok: false,
        code: 'UNSUPPORTED_CONTEXT',
        message: 'Group chat card mutations are unsupported',
        recoverable: false,
      };
    }

    const liveAvatar = resolveContextAvatar(liveCtx);
    if (!liveAvatar || liveAvatar !== owner.avatar) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: `Live context avatar (${liveAvatar ?? 'none'}) does not match target owner avatar (${owner.avatar})`,
        recoverable: false,
      };
    }

    if (expectedContext.characterId !== undefined && liveCtx.characterId !== expectedContext.characterId) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: 'Live context characterId does not match expected context',
        recoverable: false,
      };
    }

    if (
      expectedContext.chatId !== undefined &&
      expectedContext.chatId !== null &&
      liveCtx.chatId !== expectedContext.chatId
    ) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: 'Live context chatId does not match expected context',
        recoverable: false,
      };
    }

    return { ok: true, context: liveCtx };
  } catch (_err) {
    return {
      ok: false,
      code: 'STALE_CARD_LOCATOR',
      message: 'Context evaluation threw an exception',
      recoverable: false,
      details: { reason: 'CONTEXT_EVALUATION_FAILED' },
    };
  }
}

function evaluateEditorSafety(owner, checkEditorSafety) {
  let result;
  try {
    result = checkEditorSafety(owner);
  } catch (_err) {
    return {
      ok: false,
      code: 'WRITE_REJECTED',
      message: 'Editor safety check failed with an exception',
      recoverable: false,
      details: { reason: 'EDITOR_CHECK_THREW' },
    };
  }

  try {
    if (!result || typeof result !== 'object' || result.safe !== true) {
      return {
        ok: false,
        code: 'WRITE_REJECTED',
        message: 'Editor safety cannot be established',
        recoverable: false,
        details: { reason: 'EDITOR_UNSAFE' },
      };
    }
  } catch (_err) {
    return {
      ok: false,
      code: 'WRITE_REJECTED',
      message: 'Editor safety check failed with an exception',
      recoverable: false,
      details: { reason: 'EDITOR_CHECK_THREW' },
    };
  }

  return { ok: true };
}

async function acquireQueueLock(avatar, userSignal) {
  let isAborted = false;
  try {
    isAborted = Boolean(userSignal?.aborted);
  } catch (_err) {
    return {
      ok: false,
      code: 'OPERATION_CANCELLED',
      message: 'Operation cancelled',
      recoverable: false,
    };
  }

  if (isAborted) {
    return {
      ok: false,
      code: 'OPERATION_CANCELLED',
      message: 'Operation cancelled',
      recoverable: false,
    };
  }

  let releaseCurrentLock;
  const currentTurnPromise = new Promise((resolve) => {
    releaseCurrentLock = resolve;
  });

  const previousTurnPromise = avatarQueues.get(avatar) || Promise.resolve();
  avatarQueues.set(avatar, currentTurnPromise);

  let onAbort;
  try {
    if (userSignal) {
      const abortPromise = new Promise((_, reject) => {
        onAbort = () => {
          const err = new Error('Operation cancelled');
          err.name = 'AbortError';
          reject(err);
        };
        if (userSignal.aborted) {
          onAbort();
        } else {
          userSignal.addEventListener('abort', onAbort, { once: true });
        }
      });
      await Promise.race([previousTurnPromise, abortPromise]);
    } else {
      await previousTurnPromise;
    }
  } catch (_err) {
    previousTurnPromise.finally(() => {
      releaseCurrentLock();
      if (avatarQueues.get(avatar) === currentTurnPromise) {
        avatarQueues.delete(avatar);
      }
    });

    if (userSignal && onAbort) {
      userSignal.removeEventListener('abort', onAbort);
    }

    return {
      ok: false,
      code: 'OPERATION_CANCELLED',
      message: 'Operation cancelled while waiting in queue',
      recoverable: false,
    };
  } finally {
    if (userSignal && onAbort) {
      userSignal.removeEventListener('abort', onAbort);
    }
  }

  const release = () => {
    releaseCurrentLock();
    if (avatarQueues.get(avatar) === currentTurnPromise) {
      avatarQueues.delete(avatar);
    }
  };

  return { ok: true, release };
}

function inspectReadback(readback, rawReadbackFailed, preRead, planResult) {
  if (rawReadbackFailed) {
    return {
      readbackFailed: true,
      inspectionFailed: false,
      readbackMatchesNext: false,
      readbackMatchesOld: false,
    };
  }

  let isOk = false;
  try {
    if (!readback || typeof readback !== 'object') {
      return {
        readbackFailed: true,
        inspectionFailed: false,
        readbackMatchesNext: false,
        readbackMatchesOld: false,
      };
    }
    isOk = readback.ok === true;
  } catch (_err) {
    return {
      readbackFailed: true,
      inspectionFailed: true,
      readbackMatchesNext: false,
      readbackMatchesOld: false,
    };
  }

  if (!isOk) {
    return {
      readbackFailed: true,
      inspectionFailed: false,
      readbackMatchesNext: false,
      readbackMatchesOld: false,
    };
  }

  let status;
  try {
    status = readback.status;
  } catch (_err) {
    return {
      readbackFailed: true,
      inspectionFailed: true,
      readbackMatchesNext: false,
      readbackMatchesOld: false,
    };
  }

  let value;
  try {
    value = readback.value;
  } catch (_err) {
    return {
      readbackFailed: true,
      inspectionFailed: true,
      readbackMatchesNext: false,
      readbackMatchesOld: false,
    };
  }

  if (status !== 'VALID' && status !== 'UNINITIALIZED') {
    return {
      readbackFailed: true,
      inspectionFailed: true,
      readbackMatchesNext: false,
      readbackMatchesOld: false,
    };
  }

  let readbackMatchesNext = false;
  let readbackMatchesOld = false;

  if (status === 'VALID') {
    if (!isPlainObject(value) || hasOwnForbiddenPrototypeKeys(value)) {
      return {
        readbackFailed: true,
        inspectionFailed: true,
        readbackMatchesNext: false,
        readbackMatchesOld: false,
      };
    }

    // Check match next
    try {
      if (planResult && planResult.value) {
        const planSer = serializeRegistry(planResult.value);
        if (!planSer.ok) {
          return {
            readbackFailed: true,
            inspectionFailed: true,
            readbackMatchesNext: false,
            readbackMatchesOld: false,
          };
        }
        const valSer = serializeRegistry(value);
        if (!valSer.ok) {
          return {
            readbackFailed: true,
            inspectionFailed: true,
            readbackMatchesNext: false,
            readbackMatchesOld: false,
          };
        }
        if (value.revision === planResult.value.revision && valSer.value === planSer.value) {
          readbackMatchesNext = true;
        }
      }
    } catch (_err) {
      return {
        readbackFailed: true,
        inspectionFailed: true,
        readbackMatchesNext: false,
        readbackMatchesOld: false,
      };
    }

    // Check match old
    if (!readbackMatchesNext && preRead) {
      if (preRead.status === 'VALID') {
        try {
          const preSer = serializeRegistry(preRead.value);
          if (!preSer.ok) {
            return {
              readbackFailed: true,
              inspectionFailed: true,
              readbackMatchesNext: false,
              readbackMatchesOld: false,
            };
          }
          const valSer = serializeRegistry(value);
          if (!valSer.ok) {
            return {
              readbackFailed: true,
              inspectionFailed: true,
              readbackMatchesNext: false,
              readbackMatchesOld: false,
            };
          }
          if (value.revision === preRead.value.revision && valSer.value === preSer.value) {
            readbackMatchesOld = true;
          }
        } catch (_err) {
          return {
            readbackFailed: true,
            inspectionFailed: true,
            readbackMatchesNext: false,
            readbackMatchesOld: false,
          };
        }
      }
    }
  } else if (status === 'UNINITIALIZED') {
    if (preRead && preRead.status === 'UNINITIALIZED') {
      readbackMatchesOld = true;
    }
  }

  return {
    readbackFailed: false,
    inspectionFailed: false,
    readbackMatchesNext,
    readbackMatchesOld,
    value,
    status,
  };
}

/**
 * Executes a guarded, single-card mutation against SillyTavern's card storage.
 *
 * @param {{ kind: 'installed-card', avatar: string }} owner - Target card locator
 * @param {object} command - Mutation command ({ type: 'add'|'update'|'remove', ... })
 * @param {{ status: 'UNINITIALIZED'|'VALID', value?: object }} expectedSnapshot - Expected baseline snapshot
 * @param {object} dependencies - Mandatory environment dependencies
 * @returns {Promise<object>} Discriminated result
 */
export async function mutateCard(owner, command, expectedSnapshot, dependencies) {
  let opPhase = OP_PHASE.PRE_DISPATCH;
  let avatar = null;
  let releaseQueue = null;
  let preRead = null;
  let planResult = null;
  let readbackAttempted = false;
  let normalizedStatus = null;

  try {
    // 1. Parameter & Dependency Validations
    const ownerVal = validateOwner(owner);
    if (!ownerVal.ok) return ownerVal;

    const cmdVal = validateCommand(command);
    if (!cmdVal.ok) return cmdVal;

    const expVal = validateExpectedSnapshot(expectedSnapshot);
    if (!expVal.ok) return expVal;

    const depsVal = validateDependencies(dependencies);
    if (!depsVal.ok) return depsVal;

    avatar = ownerVal.avatar ?? owner.avatar;

    // 2. Preflight Quarantine Check (Optimization)
    if (quarantinedAvatars.has(avatar)) {
      return {
        ok: false,
        code: 'CARD_QUARANTINED',
        message: `Card "${avatar}" is quarantined due to a previous unresolved write. Mutations blocked until manual recovery.`,
        recoverable: false,
        details: { avatar },
      };
    }

    // 3. Preflight Context Check
    const preCtx = evaluateContext(owner, dependencies.expectedContext, dependencies.getContext);
    if (!preCtx.ok) return preCtx;

    // 4. Preflight Editor Safety Check
    const preEditor = evaluateEditorSafety(owner, dependencies.checkEditorSafety);
    if (!preEditor.ok) return preEditor;

    // 5. Preflight Cancellation Check
    try {
      if (dependencies.signal?.aborted) {
        return {
          ok: false,
          code: 'OPERATION_CANCELLED',
          message: 'Operation cancelled',
          recoverable: false,
        };
      }
    } catch (_err) {
      return {
        ok: false,
        code: 'OPERATION_CANCELLED',
        message: 'Operation cancelled',
        recoverable: false,
      };
    }

    // 6. Acquire Queue Lock
    const lockResult = await acquireQueueLock(avatar, dependencies.signal);
    if (!lockResult.ok) {
      return lockResult;
    }
    releaseQueue = lockResult.release;

    // 7. Post-Queue Authoritative Quarantine Check
    if (quarantinedAvatars.has(avatar)) {
      return {
        ok: false,
        code: 'CARD_QUARANTINED',
        message: `Card "${avatar}" is quarantined due to a previous unresolved write. Mutations blocked until manual recovery.`,
        recoverable: false,
        details: { avatar },
      };
    }

    // 8. Post-Queue Context Recheck
    const postQueueCtx = evaluateContext(owner, dependencies.expectedContext, dependencies.getContext);
    if (!postQueueCtx.ok) return postQueueCtx;

    // 9. Post-Queue Editor Safety Recheck
    const postQueueEditor = evaluateEditorSafety(owner, dependencies.checkEditorSafety);
    if (!postQueueEditor.ok) return postQueueEditor;

    // 10. Post-Queue Cancellation Recheck
    try {
      if (dependencies.signal?.aborted) {
        return {
          ok: false,
          code: 'OPERATION_CANCELLED',
          message: 'Operation cancelled',
          recoverable: false,
        };
      }
    } catch (_err) {
      return {
        ok: false,
        code: 'OPERATION_CANCELLED',
        message: 'Operation cancelled',
        recoverable: false,
      };
    }

    // 11. Pre-Read Card
    const readCardFn = dependencies.readCard || defaultReadCard;
    const fetchFn = dependencies.fetch || globalThis.fetch;
    preRead = await readCardFn(owner, {
      getRequestHeaders: dependencies.getRequestHeaders,
      fetch: fetchFn,
      signal: dependencies.signal,
    });

    if (!preRead.ok) {
      return preRead;
    }

    // 12. Snapshot & Conflict Comparison
    if (expectedSnapshot.status === 'UNINITIALIZED') {
      if (preRead.status !== 'UNINITIALIZED') {
        return {
          ok: false,
          code: 'CONFLICT_DETECTED',
          message: 'Card registry materialized concurrently',
          recoverable: false,
        };
      }
    } else if (expectedSnapshot.status === 'VALID') {
      if (preRead.status !== 'VALID') {
        return {
          ok: false,
          code: 'CONFLICT_DETECTED',
          message: 'Card registry uninitialized concurrently',
          recoverable: false,
        };
      }

      if (preRead.value.revision !== expectedSnapshot.value.revision) {
        return {
          ok: false,
          code: 'CONFLICT_DETECTED',
          message: `Revision mismatch: expected ${expectedSnapshot.value.revision}, found ${preRead.value.revision}`,
          recoverable: false,
        };
      }

      const expCanonical = serializeRegistry(expectedSnapshot.value);
      if (!expCanonical.ok) {
        return {
          ok: false,
          code: 'INVALID_OPTIONS',
          message: 'expectedSnapshot.value failed canonical serialization',
          recoverable: false,
        };
      }

      const preCanonical = serializeRegistry(preRead.value);
      if (!preCanonical.ok || preCanonical.value !== expCanonical.value) {
        return {
          ok: false,
          code: 'CONFLICT_DETECTED',
          message: 'Registry content mismatch detected against expected snapshot',
          recoverable: false,
        };
      }
    }

    // 13. Plan Mutation with Pure Core
    planResult = planMutation(preRead.value, command);
    if (!planResult.ok) {
      return planResult;
    }

    // 14. Check No-Op
    if (preRead.status === 'VALID' && planResult.value.revision === preRead.value.revision) {
      const planSer = serializeRegistry(planResult.value);
      const preSer = serializeRegistry(preRead.value);
      if (planSer.ok && preSer.ok && planSer.value === preSer.value) {
        const noopCtx = evaluateContext(owner, dependencies.expectedContext, dependencies.getContext);
        if (!noopCtx.ok) return noopCtx;

        const noopEditor = evaluateEditorSafety(owner, dependencies.checkEditorSafety);
        if (!noopEditor.ok) return noopEditor;

        return {
          ok: true,
          status: 'VALID',
          value: preRead.value,
          avatar,
          noop: true,
        };
      }
    }

    // 15. Pre-Dispatch Rechecks
    try {
      if (dependencies.signal?.aborted) {
        return {
          ok: false,
          code: 'OPERATION_CANCELLED',
          message: 'Operation cancelled',
          recoverable: false,
        };
      }
    } catch (_err) {
      return {
        ok: false,
        code: 'OPERATION_CANCELLED',
        message: 'Operation cancelled',
        recoverable: false,
      };
    }

    const preDispatchCtx = evaluateContext(owner, dependencies.expectedContext, dependencies.getContext);
    if (!preDispatchCtx.ok) return preDispatchCtx;

    const preDispatchEditor = evaluateEditorSafety(owner, dependencies.checkEditorSafety);
    if (!preDispatchEditor.ok) return preDispatchEditor;

    // 16. Header Retrieval & Payload Preparation
    let rawHeaders;
    try {
      rawHeaders = dependencies.getRequestHeaders();
    } catch (_err) {
      return {
        ok: false,
        code: 'WRITE_REJECTED',
        message: 'Failed to retrieve request headers',
        recoverable: false,
        details: { reason: 'HEADERS_FAILED' },
      };
    }

    if (!isPlainObject(rawHeaders)) {
      return {
        ok: false,
        code: 'WRITE_REJECTED',
        message: 'getRequestHeaders must return a plain object',
        recoverable: false,
        details: { reason: 'INVALID_HEADERS' },
      };
    }

    let headers;
    try {
      headers = {
        ...rawHeaders,
        'Content-Type': 'application/json',
      };
    } catch (_err) {
      return {
        ok: false,
        code: 'WRITE_REJECTED',
        message: 'Failed to construct request headers',
        recoverable: false,
        details: { reason: 'INVALID_HEADERS' },
      };
    }

    let payload;
    let body;
    try {
      payload = {
        avatar,
        data: {
          extensions: {
            chromaticHub: planResult.value,
          },
        },
      };
      body = JSON.stringify(payload);
    } catch (_err) {
      return {
        ok: false,
        code: 'WRITE_REJECTED',
        message: 'Failed to serialize mutation payload',
        recoverable: false,
        details: { reason: 'PAYLOAD_SERIALIZATION_FAILED' },
      };
    }

    // 17. Hard-Bounded POST Dispatch
    const postTimeoutMs = dependencies.postTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS;
    const postController = new AbortController();

    let postTimer = null;
    let onUserPostAbort = null;
    let postResponse = null;
    let postOutcome = 'COMPLETED';

    // Set post-attempt state before invoking transport
    opPhase = OP_PHASE.POST_DISPATCHED;

    try {
      const postDeadlinePromise = new Promise((_, reject) => {
        postTimer = setTimeout(() => {
          postController.abort();
          const err = new Error('POST deadline exceeded');
          err.name = 'TimeoutError';
          reject(err);
        }, postTimeoutMs);
      });

      if (dependencies.signal) {
        onUserPostAbort = () => postController.abort();
        if (dependencies.signal.aborted) {
          postController.abort();
        } else {
          dependencies.signal.addEventListener('abort', onUserPostAbort, { once: true });
        }
      }

      const rawPostPromise = fetchFn('/api/characters/merge-attributes', {
        method: 'POST',
        headers,
        body,
        signal: postController.signal,
      });

      // Avoid unhandled rejection if fetch rejects after deadline
      rawPostPromise.catch(() => {});

      postResponse = await Promise.race([rawPostPromise, postDeadlinePromise]);
    } catch (_err) {
      postOutcome = 'UNKNOWN';
    } finally {
      if (postTimer !== null) {
        clearTimeout(postTimer);
        postTimer = null;
      }
      if (dependencies.signal && onUserPostAbort) {
        dependencies.signal.removeEventListener('abort', onUserPostAbort);
        onUserPostAbort = null;
      }
    }

    // Guarded POST response normalization
    if (postOutcome === 'COMPLETED') {
      try {
        if (!postResponse || typeof postResponse !== 'object') {
          postOutcome = 'UNKNOWN';
        } else {
          const rawStatus = postResponse.status;
          const rawOk = postResponse.ok;

          if (
            typeof rawStatus === 'number' &&
            Number.isInteger(rawStatus) &&
            rawStatus >= 100 &&
            rawStatus <= 599 &&
            typeof rawOk === 'boolean' &&
            rawOk === (rawStatus >= 200 && rawStatus <= 299)
          ) {
            normalizedStatus = rawStatus;
          } else {
            postOutcome = 'UNKNOWN';
          }
        }
      } catch (_err) {
        postOutcome = 'UNKNOWN';
      }
    }

    // POST completed and persistence verification is being evaluated
    opPhase = OP_PHASE.POST_VERIFYING;

    // 18. Hard-Bounded Independent Verification Readback
    const verifyTimeoutMs = dependencies.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    const verifyController = new AbortController();

    let verifyTimer = null;
    let readback = null;
    let readbackFailed = false;

    try {
      readbackAttempted = true;
      const verifyDeadlinePromise = new Promise((_, reject) => {
        verifyTimer = setTimeout(() => {
          verifyController.abort();
          const err = new Error('Verification deadline exceeded');
          err.name = 'TimeoutError';
          reject(err);
        }, verifyTimeoutMs);
      });

      const rawReadPromise = readCardFn(owner, {
        getRequestHeaders: dependencies.getRequestHeaders,
        fetch: fetchFn,
        signal: verifyController.signal,
      });

      // Avoid unhandled rejection if readCard rejects after deadline
      rawReadPromise.catch(() => {});

      readback = await Promise.race([rawReadPromise, verifyDeadlinePromise]);
    } catch (_err) {
      readbackFailed = true;
    } finally {
      if (verifyTimer !== null) {
        clearTimeout(verifyTimer);
        verifyTimer = null;
      }
    }

    // Guarded Readback Result Inspection
    const inspection = inspectReadback(readback, readbackFailed, preRead, planResult);

    if (inspection.inspectionFailed) {
      quarantinedAvatars.add(avatar);
      return {
        ok: false,
        code: 'WRITE_UNCERTAIN',
        message: 'Persistence verification failed unexpectedly after write dispatch',
        recoverable: false,
        details: normalizedStatus !== null ? { httpStatus: normalizedStatus } : { postOutcome: 'UNKNOWN' },
      };
    }

    // 19. Decision Table Evaluation

    // Category C: POST Completion Unknown (Timeout, Abort, Network Loss, Malformed Response)
    if (postOutcome === 'UNKNOWN') {
      quarantinedAvatars.add(avatar);
      if (inspection.readbackMatchesNext) {
        return {
          ok: false,
          code: 'WRITE_UNCERTAIN',
          message: 'POST completion was unknown but planned registry was observed on disk',
          recoverable: false,
          details: { persistedObserved: true, postOutcome: 'UNKNOWN' },
        };
      }
      if (inspection.readbackMatchesOld) {
        return {
          ok: false,
          code: 'WRITE_UNCERTAIN',
          message:
            'POST completion was unknown; disk currently holds old registry but server may persist asynchronously',
          recoverable: false,
          details: { persistedObserved: false, postOutcome: 'UNKNOWN' },
        };
      }
      return {
        ok: false,
        code: 'WRITE_UNCERTAIN',
        message: 'POST completion was unknown and disk state could not be verified',
        recoverable: false,
        details: { postOutcome: 'UNKNOWN' },
      };
    }

    // Category B: POST completed with a valid HTTP response
    if (normalizedStatus === 200) {
      if (inspection.readbackMatchesNext) {
        const postVerifyCtx = evaluateContext(owner, dependencies.expectedContext, dependencies.getContext);
        if (!postVerifyCtx.ok) {
          return {
            ok: false,
            code: 'STALE_CARD_LOCATOR',
            message: 'Context changed during card write verification',
            recoverable: false,
            details: { persisted: true },
          };
        }

        return {
          ok: true,
          status: 'VALID',
          value: inspection.value,
          avatar,
        };
      }

      if (inspection.readbackMatchesOld) {
        return {
          ok: false,
          code: 'READBACK_MISMATCH',
          message: 'Server reported HTTP 200 but registry was not persisted',
          recoverable: false,
          details: { reason: 'UNPERSISTED_200' },
        };
      }

      if (inspection.readbackFailed) {
        quarantinedAvatars.add(avatar);
        return {
          ok: false,
          code: 'WRITE_UNCERTAIN',
          message: 'Server reported HTTP 200 but readback verification failed',
          recoverable: false,
          details: { httpStatus: 200 },
        };
      }

      return {
        ok: false,
        code: 'READBACK_MISMATCH',
        message: 'Readback observed unexpected registry content',
        recoverable: false,
        details: { unexpected: true },
      };
    }

    // Completed with HTTP rejection (4xx / 5xx)
    const httpStatus = normalizedStatus;
    if (inspection.readbackMatchesOld) {
      return {
        ok: false,
        code: 'WRITE_REJECTED',
        message: `Server rejected write with HTTP ${httpStatus}`,
        recoverable: httpStatus >= 500,
        details: { httpStatus },
      };
    }

    if (inspection.readbackMatchesNext) {
      quarantinedAvatars.add(avatar);
      return {
        ok: false,
        code: 'WRITE_UNCERTAIN',
        message: 'Server rejected write with HTTP error but changes persisted to disk',
        recoverable: false,
        details: { persistedObserved: true, httpStatus },
      };
    }

    quarantinedAvatars.add(avatar);
    return {
      ok: false,
      code: 'WRITE_UNCERTAIN',
      message: 'Write failed with HTTP error and persistence is uncertain',
      recoverable: false,
      details: { httpStatus },
    };
  } catch (_err) {
    if (opPhase === OP_PHASE.PRE_DISPATCH) {
      return {
        ok: false,
        code: 'WRITE_REJECTED',
        message: 'Unexpected error before write dispatch',
        recoverable: false,
        details: { reason: 'PRE_DISPATCH_FAILED' },
      };
    }

    if (avatar) {
      quarantinedAvatars.add(avatar);
    }

    // Post-dispatch exception: bounded readback if not yet attempted
    if (!readbackAttempted && avatar && typeof dependencies === 'object' && dependencies !== null) {
      try {
        readbackAttempted = true;
        const readCardFn = dependencies.readCard || defaultReadCard;
        const fetchFn = dependencies.fetch || globalThis.fetch;
        const verifyTimeoutMs =
          typeof dependencies.verifyTimeoutMs === 'number' && Number.isSafeInteger(dependencies.verifyTimeoutMs)
            ? dependencies.verifyTimeoutMs
            : DEFAULT_VERIFY_TIMEOUT_MS;
        const verifyController = new AbortController();
        let verifyTimer = null;
        try {
          const verifyDeadlinePromise = new Promise((_, reject) => {
            verifyTimer = setTimeout(() => {
              verifyController.abort();
              const e = new Error('Verification deadline exceeded');
              e.name = 'TimeoutError';
              reject(e);
            }, verifyTimeoutMs);
          });
          const rawReadPromise = readCardFn(owner, {
            getRequestHeaders: dependencies.getRequestHeaders,
            fetch: fetchFn,
            signal: verifyController.signal,
          });
          rawReadPromise.catch(() => {});
          const rb = await Promise.race([rawReadPromise, verifyDeadlinePromise]);
          if (rb && preRead && planResult) {
            const insp = inspectReadback(rb, false, preRead, planResult);
            if (!insp.inspectionFailed && insp.readbackMatchesNext) {
              return {
                ok: false,
                code: 'WRITE_UNCERTAIN',
                message: 'POST completion was unknown but planned registry was observed on disk',
                recoverable: false,
                details: {
                  persistedObserved: true,
                  ...(normalizedStatus !== null ? { httpStatus: normalizedStatus } : { postOutcome: 'UNKNOWN' }),
                },
              };
            }
          }
        } finally {
          if (verifyTimer !== null) {
            clearTimeout(verifyTimer);
          }
        }
      } catch (_rbErr) {
        // readback failed
      }
    }

    return {
      ok: false,
      code: 'WRITE_UNCERTAIN',
      message: 'Write failed unexpectedly and persistence is uncertain',
      recoverable: false,
      details: normalizedStatus !== null ? { httpStatus: normalizedStatus } : { postOutcome: 'UNKNOWN' },
    };
  } finally {
    if (releaseQueue) {
      try {
        releaseQueue();
      } catch (_cleanupErr) {
        // preserve cleanup safety
      }
    }
  }
}
