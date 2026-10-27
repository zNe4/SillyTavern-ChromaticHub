/**
 * SillyTavern-ChromaticHub: Guarded Single-Card Mutation Controller (H01-B2-R1)
 *
 * Implements guarded, single-card mutation of data.extensions.chromaticHub.
 * Reuses pure core identity contracts and read-only SillyTavern adapter.
 *
 * Enforces hard network deadlines, quarantine on uncertainty, diagnostic privacy,
 * and comprehensive resource cleanup.
 */

import { planMutation, serializeRegistry } from './identity-registry.mjs';
import { readCard as defaultReadCard } from './sillytavern-adapter.mjs';

const DEFAULT_POST_TIMEOUT_MS = 10000;
const DEFAULT_VERIFY_TIMEOUT_MS = 5000;

const PNG_EXTENSION_REGEX = /\.[pP][nN][gG]$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
}

function validateCommand(command) {
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
}

function validateExpectedSnapshot(expectedSnapshot) {
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
}

function validateDependencies(dependencies) {
  if (!isPlainObject(dependencies) || hasOwnForbiddenPrototypeKeys(dependencies)) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies must be a plain object',
      recoverable: false,
    };
  }

  if (typeof dependencies.getRequestHeaders !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.getRequestHeaders must be a function',
      recoverable: false,
    };
  }

  if (typeof dependencies.checkEditorSafety !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.checkEditorSafety must be a function',
      recoverable: false,
    };
  }

  if (typeof dependencies.getContext !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.getContext must be a function',
      recoverable: false,
    };
  }

  if (!isPlainObject(dependencies.expectedContext) || hasOwnForbiddenPrototypeKeys(dependencies.expectedContext)) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'dependencies.expectedContext must be a plain object',
      recoverable: false,
    };
  }

  const keys = Object.keys(dependencies.expectedContext);
  if (keys.length === 0) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'dependencies.expectedContext cannot be an empty object',
      recoverable: false,
    };
  }

  const hasDirectAvatar =
    typeof dependencies.expectedContext.avatar === 'string' &&
    dependencies.expectedContext.avatar.trim().length > 0;
  const hasCharAvatar =
    Array.isArray(dependencies.expectedContext.characters) &&
    typeof dependencies.expectedContext.characterId === 'number';
  if (!hasDirectAvatar && !hasCharAvatar) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'dependencies.expectedContext must contain identifying avatar or characters[characterId]',
      recoverable: false,
    };
  }

  if (dependencies.fetch !== undefined && typeof dependencies.fetch !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.fetch must be a function when supplied',
      recoverable: false,
    };
  }

  if (dependencies.readCard !== undefined && typeof dependencies.readCard !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.readCard must be a function when supplied',
      recoverable: false,
    };
  }

  if (
    dependencies.signal !== undefined &&
    (dependencies.signal === null ||
      typeof dependencies.signal !== 'object' ||
      typeof dependencies.signal.aborted !== 'boolean')
  ) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'dependencies.signal must be an AbortSignal instance',
      recoverable: false,
    };
  }

  if (dependencies.postTimeoutMs !== undefined) {
    if (
      typeof dependencies.postTimeoutMs !== 'number' ||
      !Number.isSafeInteger(dependencies.postTimeoutMs) ||
      dependencies.postTimeoutMs <= 0
    ) {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: 'postTimeoutMs must be a positive safe integer',
        recoverable: false,
      };
    }
  }

  if (dependencies.verifyTimeoutMs !== undefined) {
    if (
      typeof dependencies.verifyTimeoutMs !== 'number' ||
      !Number.isSafeInteger(dependencies.verifyTimeoutMs) ||
      dependencies.verifyTimeoutMs <= 0
    ) {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: 'verifyTimeoutMs must be a positive safe integer',
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

  if (!result || typeof result !== 'object' || result.safe !== true) {
    return {
      ok: false,
      code: 'WRITE_REJECTED',
      message: 'Editor safety cannot be established',
      recoverable: false,
      details: { reason: 'EDITOR_UNSAFE' },
    };
  }

  return { ok: true };
}

async function acquireQueueLock(avatar, userSignal) {
  if (userSignal?.aborted) {
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
  // 1. Parameter & Dependency Validations
  const ownerVal = validateOwner(owner);
  if (!ownerVal.ok) return ownerVal;

  const cmdVal = validateCommand(command);
  if (!cmdVal.ok) return cmdVal;

  const expVal = validateExpectedSnapshot(expectedSnapshot);
  if (!expVal.ok) return expVal;

  const depsVal = validateDependencies(dependencies);
  if (!depsVal.ok) return depsVal;

  const avatar = owner.avatar;

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
  if (dependencies.signal?.aborted) {
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
  const releaseQueue = lockResult.release;

  try {
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
    if (dependencies.signal?.aborted) {
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
    const preRead = await readCardFn(owner, {
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
    const planResult = planMutation(preRead.value, command);
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
    if (dependencies.signal?.aborted) {
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

    const headers = {
      ...rawHeaders,
      'Content-Type': 'application/json',
    };

    const payload = {
      avatar,
      data: {
        extensions: {
          chromaticHub: planResult.value,
        },
      },
    };

    // 17. Hard-Bounded POST Dispatch
    const postTimeoutMs = dependencies.postTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS;
    const postController = new AbortController();

    let postTimer = null;
    let onUserPostAbort = null;
    let postResponse = null;
    let postOutcome = 'COMPLETED';

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
        body: JSON.stringify(payload),
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

    // Validate POST Response structure when completed
    if (postOutcome === 'COMPLETED') {
      const isValidResponse =
        postResponse &&
        typeof postResponse === 'object' &&
        typeof postResponse.status === 'number';

      if (!isValidResponse) {
        postOutcome = 'UNKNOWN';
      }
    }

    // 18. Hard-Bounded Independent Verification Readback
    const verifyTimeoutMs = dependencies.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    const verifyController = new AbortController();

    let verifyTimer = null;
    let readback = null;
    let readbackFailed = false;

    try {
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
      if (!readback || !readback.ok) {
        readbackFailed = true;
      }
    } catch (_err) {
      readbackFailed = true;
    } finally {
      if (verifyTimer !== null) {
        clearTimeout(verifyTimer);
        verifyTimer = null;
      }
    }

    const readbackMatchesNext =
      !readbackFailed &&
      readback.status === 'VALID' &&
      readback.value?.revision === planResult.value.revision &&
      serializeRegistry(readback.value).value === serializeRegistry(planResult.value).value;

    let readbackMatchesOld = false;
    if (!readbackFailed) {
      if (preRead.status === 'UNINITIALIZED') {
        readbackMatchesOld = readback.status === 'UNINITIALIZED';
      } else {
        readbackMatchesOld =
          readback.status === 'VALID' &&
          readback.value?.revision === preRead.value.revision &&
          serializeRegistry(readback.value).value === serializeRegistry(preRead.value).value;
      }
    }

    // 19. Decision Table Evaluation

    // Category C: POST Completion Unknown (Timeout, Abort, Network Loss, Malformed Response)
    if (postOutcome === 'UNKNOWN') {
      quarantinedAvatars.add(avatar);
      if (readbackMatchesNext) {
        return {
          ok: false,
          code: 'WRITE_UNCERTAIN',
          message: 'POST completion was unknown but planned registry was observed on disk',
          recoverable: false,
          details: { persistedObserved: true, postOutcome: 'UNKNOWN' },
        };
      }
      if (readbackMatchesOld) {
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

    // Category B: POST completed with an HTTP response
    if (postResponse.status === 200) {
      if (readbackMatchesNext) {
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
          value: readback.value,
          avatar,
        };
      }

      if (readbackMatchesOld) {
        return {
          ok: false,
          code: 'READBACK_MISMATCH',
          message: 'Server reported HTTP 200 but registry was not persisted',
          recoverable: false,
          details: { reason: 'UNPERSISTED_200' },
        };
      }

      if (readbackFailed) {
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
    const httpStatus = postResponse.status;
    if (readbackMatchesOld) {
      return {
        ok: false,
        code: 'WRITE_REJECTED',
        message: `Server rejected write with HTTP ${httpStatus}`,
        recoverable: httpStatus >= 500,
        details: { httpStatus },
      };
    }

    if (readbackMatchesNext) {
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
  } finally {
    releaseQueue();
  }
}
