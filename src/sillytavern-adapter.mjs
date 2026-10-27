/**
 * SillyTavern-ChromaticHub: Read-Only SillyTavern Adapter (H01-B1)
 *
 * Minimal read-only adapter connecting ChromaticHub's pure identity core
 * to SillyTavern character cards via the native /api/characters/get endpoint.
 *
 * Strictly read-only: never writes, repairs, initializes, or modifies any card.
 */

import { parseRegistry } from './identity-registry.mjs';

const PNG_EXTENSION_REGEX = /\.[pP][nN][gG]$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;

function isPlainObject(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function validateCardOwner(owner) {
  if (!isPlainObject(owner)) {
    return {
      ok: false,
      code: 'INVALID_OWNER',
      message: 'Owner must be an object',
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

function isContextMatching(actual, expected) {
  if (!actual || typeof actual !== 'object') {
    return false;
  }
  const keys = ['groupId', 'chatId', 'characterId', 'avatar'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(expected, key) && expected[key] !== undefined) {
      const expectedVal = expected[key] ?? null;
      const actualVal = actual[key] ?? null;
      if (expectedVal !== actualVal) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Reads an installed card from SillyTavern, validates the complete server response envelope,
 * and delegates registry validation to the pure identity core.
 *
 * @param {{ kind: 'installed-card', avatar: string }} owner - Installed card locator
 * @param {object} dependencies - Injected dependencies
 * @param {() => Record<string, string>} dependencies.getRequestHeaders - Native SillyTavern header supplier (REQUIRED)
 * @param {typeof globalThis.fetch} [dependencies.fetch] - Fetch implementation (defaults to globalThis.fetch)
 * @param {object} [dependencies.expectedContext] - Expected UI context snapshot
 * @param {() => object | null | undefined} [dependencies.getContext] - Function returning current UI context
 * @param {AbortSignal} [dependencies.signal] - Cancellation signal
 * @returns {Promise<object>} Discriminated result
 */
export async function readCard(owner, dependencies) {
  // 1. Validate owner locator
  const ownerValidation = validateCardOwner(owner);
  if (!ownerValidation.ok) {
    return ownerValidation;
  }
  const targetAvatar = ownerValidation.avatar;

  // 2. Validate dependencies
  if (!isPlainObject(dependencies)) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies must be an object',
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

  let rawHeaders;
  try {
    rawHeaders = dependencies.getRequestHeaders();
  } catch (_err) {
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'Failed to retrieve request headers',
      recoverable: false,
    };
  }

  if (!isPlainObject(rawHeaders)) {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'getRequestHeaders must return a plain object',
      recoverable: false,
    };
  }

  const fetchFn = typeof dependencies.fetch === 'function' ? dependencies.fetch : globalThis.fetch;
  if (dependencies.fetch !== undefined && typeof dependencies.fetch !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'dependencies.fetch must be a function when supplied',
      recoverable: false,
    };
  }
  if (typeof fetchFn !== 'function') {
    return {
      ok: false,
      code: 'INVALID_DEPENDENCY',
      message: 'Fetch implementation is unavailable',
      recoverable: false,
    };
  }

  // 3. Validate context options
  const hasExpectedContext = dependencies.expectedContext !== undefined;
  const hasGetContext = dependencies.getContext !== undefined;

  if (hasExpectedContext !== hasGetContext) {
    return {
      ok: false,
      code: 'INVALID_OPTIONS',
      message: 'expectedContext and getContext must be provided together',
      recoverable: false,
    };
  }

  const isContextBound = hasExpectedContext && hasGetContext;
  if (isContextBound) {
    if (!isPlainObject(dependencies.expectedContext)) {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: 'expectedContext must be an object',
        recoverable: false,
      };
    }
    if (typeof dependencies.getContext !== 'function') {
      return {
        ok: false,
        code: 'INVALID_OPTIONS',
        message: 'getContext must be a function',
        recoverable: false,
      };
    }
  }

  // 4. Pre-dispatch cancellation check
  if (dependencies.signal?.aborted) {
    return {
      ok: false,
      code: 'OPERATION_CANCELLED',
      message: 'Operation cancelled',
      recoverable: false,
    };
  }

  // 5. Pre-dispatch context check
  if (isContextBound) {
    let preContext;
    try {
      preContext = dependencies.getContext();
    } catch (_err) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: 'Context evaluation failed before dispatch',
        recoverable: false,
      };
    }
    if (!isContextMatching(preContext, dependencies.expectedContext)) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: 'Context changed before dispatch',
        recoverable: false,
      };
    }
  }

  // 6. Native SillyTavern request dispatch
  const headers = {
    ...rawHeaders,
    'Content-Type': 'application/json',
  };

  let response;
  try {
    response = await fetchFn('/api/characters/get', {
      method: 'POST',
      headers,
      body: JSON.stringify({ avatar_url: targetAvatar }),
      signal: dependencies.signal,
    });
  } catch (err) {
    if (dependencies.signal?.aborted || err?.name === 'AbortError') {
      return {
        ok: false,
        code: 'OPERATION_CANCELLED',
        message: 'Operation cancelled',
        recoverable: false,
      };
    }
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'Network request failed',
      recoverable: true,
    };
  }

  // 7. Fetch response object validation
  if (
    !response ||
    typeof response !== 'object' ||
    typeof response.status !== 'number' ||
    typeof response.json !== 'function'
  ) {
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'Invalid response object received from fetch',
      recoverable: false,
    };
  }

  // 8. HTTP status evaluation
  if (response.status === 404) {
    return {
      ok: false,
      code: 'CARD_NOT_FOUND',
      message: `Card "${targetAvatar}" not found on server`,
      recoverable: false,
      details: { status: 404, avatar: targetAvatar },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: 'READ_FAILED',
      message: `HTTP error ${response.status}`,
      recoverable: response.status >= 500,
      details: { status: response.status },
    };
  }

  // 9. Body parsing
  let body;
  try {
    body = await response.json();
  } catch (_err) {
    if (dependencies.signal?.aborted) {
      return {
        ok: false,
        code: 'OPERATION_CANCELLED',
        message: 'Operation cancelled',
        recoverable: false,
      };
    }
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'Malformed JSON response from server',
      recoverable: false,
    };
  }

  // 10. Full-card response envelope validation
  if (!isPlainObject(body)) {
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'Unexpected server response shape',
      recoverable: false,
    };
  }

  if (typeof body.avatar !== 'string' || body.avatar !== targetAvatar) {
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'Card envelope avatar mismatch',
      recoverable: false,
      details: { expected: targetAvatar },
    };
  }

  if (body.shallow === true) {
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'Server returned shallow card data instead of full metadata',
      recoverable: false,
    };
  }

  if (!isPlainObject(body.data)) {
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'Missing or malformed card data container',
      recoverable: false,
    };
  }

  if (body.data.extensions !== undefined && !isPlainObject(body.data.extensions)) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      message: 'Card data.extensions must be an object',
      recoverable: false,
    };
  }

  // 11. Post-dispatch context check
  if (isContextBound) {
    let postContext;
    try {
      postContext = dependencies.getContext();
    } catch (_err) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: 'Context evaluation failed during card read',
        recoverable: false,
      };
    }
    if (!isContextMatching(postContext, dependencies.expectedContext)) {
      return {
        ok: false,
        code: 'STALE_CARD_LOCATOR',
        message: 'Context changed during card read',
        recoverable: false,
      };
    }
  }

  // 12. Post-work cancellation check
  if (dependencies.signal?.aborted) {
    return {
      ok: false,
      code: 'OPERATION_CANCELLED',
      message: 'Operation cancelled',
      recoverable: false,
    };
  }

  // 13. Delegate to pure identity core parseRegistry
  const rawRegistry = body.data.extensions?.chromaticHub;
  const parseResult = parseRegistry(rawRegistry);

  if (!parseResult.ok) {
    return parseResult;
  }

  return {
    ok: true,
    status: parseResult.status,
    value: parseResult.value,
    avatar: targetAvatar,
  };
}
