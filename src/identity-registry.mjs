/**
 * SillyTavern-ChromaticHub: Pure Identity Core (v0.1)
 *
 * Minimal, dependency-free card-scoped identity registry module.
 * Conforms to H01-A identity contract v0.1.
 */

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CHARACTERS = 128;
const MAX_ALIASES_PER_CHARACTER = 16;
const MAX_NAME_BYTES = 160;
const MAX_DESCRIPTOR_BYTES = 512;
const MAX_ALIAS_BYTES = 160;
const MAX_REGISTRY_BYTES = 262144; // 256 KiB UTF-8

const ALLOWED_ROOT_KEYS = ['characters', 'revision', 'schemaVersion'];
const ALLOWED_CHARACTER_KEYS = ['aliases', 'descriptor', 'id', 'name'];

const textEncoder = new TextEncoder();

function getUtf8ByteLength(str) {
  return textEncoder.encode(str).length;
}

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

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function generateUuidV4() {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Cryptographic RNG is unavailable');
  }
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 v4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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

function createVirtualEmptyRegistry() {
  return deepFreeze({
    schemaVersion: 1,
    revision: 0,
    characters: [],
  });
}

function validateCharacterRecord(char) {
  if (!isPlainObject(char) || hasOwnForbiddenPrototypeKeys(char)) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'Character must be a plain object', recoverable: false };
  }

  const keys = Object.keys(char);
  if (keys.length !== ALLOWED_CHARACTER_KEYS.length) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'Invalid character keys', recoverable: false };
  }
  for (const key of ALLOWED_CHARACTER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(char, key)) {
      return { ok: false, code: 'INVALID_SCHEMA', message: `Missing required character key: ${key}`, recoverable: false };
    }
  }

  // id
  if (typeof char.id !== 'string' || !UUID_V4_REGEX.test(char.id)) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'Character id must be a canonical lowercase RFC 4122 v4 UUID', recoverable: false };
  }

  // name
  if (typeof char.name !== 'string' || char.name.trim() !== char.name || char.name.length === 0) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'Character name must be a trimmed non-empty string', recoverable: false };
  }
  const nameBytes = getUtf8ByteLength(char.name);
  if (nameBytes < 1 || nameBytes > MAX_NAME_BYTES) {
    return { ok: false, code: 'INVALID_SCHEMA', message: `Character name UTF-8 byte length (${nameBytes}) out of bounds (1-${MAX_NAME_BYTES})`, recoverable: false };
  }

  // descriptor
  if (typeof char.descriptor !== 'string' || char.descriptor.trim() !== char.descriptor) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'Character descriptor must be a trimmed string', recoverable: false };
  }
  const descBytes = getUtf8ByteLength(char.descriptor);
  if (descBytes > MAX_DESCRIPTOR_BYTES) {
    return { ok: false, code: 'INVALID_SCHEMA', message: `Character descriptor UTF-8 byte length (${descBytes}) exceeds maximum (${MAX_DESCRIPTOR_BYTES})`, recoverable: false };
  }

  // aliases
  if (!Array.isArray(char.aliases) || char.aliases.length > MAX_ALIASES_PER_CHARACTER) {
    return { ok: false, code: 'INVALID_SCHEMA', message: `Character aliases must be an array of at most ${MAX_ALIASES_PER_CHARACTER} entries`, recoverable: false };
  }

  const seenAliases = new Set();
  for (const alias of char.aliases) {
    if (typeof alias !== 'string' || alias.trim() !== alias || alias.length === 0) {
      return { ok: false, code: 'INVALID_SCHEMA', message: 'Each alias must be a trimmed non-empty string', recoverable: false };
    }
    const aliasBytes = getUtf8ByteLength(alias);
    if (aliasBytes < 1 || aliasBytes > MAX_ALIAS_BYTES) {
      return { ok: false, code: 'INVALID_SCHEMA', message: `Alias UTF-8 byte length (${aliasBytes}) out of bounds (1-${MAX_ALIAS_BYTES})`, recoverable: false };
    }
    if (seenAliases.has(alias)) {
      return { ok: false, code: 'INVALID_SCHEMA', message: `Duplicate alias within character record: "${alias}"`, recoverable: false };
    }
    seenAliases.add(alias);
  }

  return { ok: true };
}

function internalValidateRegistry(registry) {
  if (!isPlainObject(registry) || hasOwnForbiddenPrototypeKeys(registry)) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'Registry must be a plain object', recoverable: false };
  }

  // schemaVersion
  if (typeof registry.schemaVersion !== 'number' || !Number.isInteger(registry.schemaVersion)) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'schemaVersion must be an integer', recoverable: false };
  }
  if (registry.schemaVersion !== 1) {
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      message: `Unsupported schema version: ${registry.schemaVersion}`,
      recoverable: false,
      details: { foundVersion: registry.schemaVersion },
    };
  }

  // revision
  if (
    typeof registry.revision !== 'number' ||
    !Number.isSafeInteger(registry.revision) ||
    registry.revision < 0
  ) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'revision must be a non-negative safe integer', recoverable: false };
  }

  // unknown root keys
  const rootKeys = Object.keys(registry);
  if (rootKeys.length !== ALLOWED_ROOT_KEYS.length) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'Unknown properties detected on registry object', recoverable: false };
  }
  for (const key of ALLOWED_ROOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(registry, key)) {
      return { ok: false, code: 'INVALID_SCHEMA', message: `Missing required registry key: ${key}`, recoverable: false };
    }
  }

  // characters
  if (!Array.isArray(registry.characters)) {
    return { ok: false, code: 'INVALID_SCHEMA', message: 'characters must be an array', recoverable: false };
  }
  if (registry.characters.length > MAX_CHARACTERS) {
    return { ok: false, code: 'INVALID_SCHEMA', message: `Characters count (${registry.characters.length}) exceeds maximum (${MAX_CHARACTERS})`, recoverable: false };
  }

  const seenIds = new Set();
  for (let i = 0; i < registry.characters.length; i++) {
    const char = registry.characters[i];
    const charValidation = validateCharacterRecord(char);
    if (!charValidation.ok) {
      return charValidation;
    }
    if (seenIds.has(char.id)) {
      return { ok: false, code: 'INVALID_SCHEMA', message: `Duplicate identity ID detected: ${char.id}`, recoverable: false };
    }
    seenIds.add(char.id);
  }

  // Total serialized byte size limit
  const serialized = canonicalStringify(registry);
  const totalBytes = getUtf8ByteLength(serialized);
  if (totalBytes > MAX_REGISTRY_BYTES) {
    return { ok: false, code: 'INVALID_SCHEMA', message: `Registry serialized size (${totalBytes} bytes) exceeds 256 KiB limit`, recoverable: false };
  }

  return { ok: true };
}

function cloneAndSnapshot(registry) {
  const characters = registry.characters.map((c) => ({
    aliases: [...c.aliases],
    descriptor: c.descriptor,
    id: c.id,
    name: c.name,
  }));
  return deepFreeze({
    characters,
    revision: registry.revision,
    schemaVersion: 1,
  });
}

/**
 * Parses and validates raw card registry data into an immutable snapshot.
 *
 * @param {unknown} raw - Raw card registry object or undefined
 * @returns {HubResult<Readonly<RegistrySnapshot>>}
 */
export function parseRegistry(raw) {
  if (raw === undefined) {
    return {
      ok: true,
      status: 'UNINITIALIZED',
      value: createVirtualEmptyRegistry(),
    };
  }

  if (raw === null) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      message: 'Registry cannot be null',
      recoverable: false,
    };
  }

  const validation = internalValidateRegistry(raw);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    status: 'VALID',
    value: cloneAndSnapshot(raw),
  };
}

/**
 * Resolves a character identity from a registry snapshot by local UUID.
 *
 * @param {Readonly<RegistrySnapshot>} registry
 * @param {string} identityId
 * @returns {HubResult<Readonly<CharacterRecord>>}
 */
export function resolveIdentity(registry, identityId) {
  if (typeof identityId !== 'string' || !UUID_V4_REGEX.test(identityId)) {
    return {
      ok: false,
      code: 'IDENTITY_NOT_FOUND',
      message: 'Identity not found',
      recoverable: false,
      details: { identityId },
    };
  }

  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.characters)) {
    return {
      ok: false,
      code: 'IDENTITY_NOT_FOUND',
      message: 'Identity not found',
      recoverable: false,
      details: { identityId },
    };
  }

  const character = registry.characters.find((c) => c.id === identityId);
  if (!character) {
    return {
      ok: false,
      code: 'IDENTITY_NOT_FOUND',
      message: `Identity ${identityId} not found`,
      recoverable: false,
      details: { identityId },
    };
  }

  return {
    ok: true,
    value: character,
  };
}

/**
 * Plans an immutable mutation ('add', 'update', or 'remove') against a registry snapshot.
 *
 * @param {Readonly<RegistrySnapshot>} registry
 * @param {object} command
 * @returns {HubResult<Readonly<RegistrySnapshot>>}
 */
export function planMutation(registry, command) {
  if (registry === undefined) {
    registry = createVirtualEmptyRegistry();
  }

  const regValidation = internalValidateRegistry(registry);
  if (!regValidation.ok) {
    return regValidation;
  }

  if (!isPlainObject(command) || hasOwnForbiddenPrototypeKeys(command)) {
    return {
      ok: false,
      code: 'INVALID_COMMAND',
      message: 'Command must be a plain object',
      recoverable: false,
    };
  }

  const cmdType = command.type;

  if (cmdType === 'add') {
    const cmdKeys = Object.keys(command);
    if (cmdKeys.length !== 2 || !cmdKeys.includes('character') || !cmdKeys.includes('type')) {
      return { ok: false, code: 'INVALID_COMMAND', message: 'Invalid keys on add command', recoverable: false };
    }

    const charInput = command.character;
    if (!isPlainObject(charInput) || hasOwnForbiddenPrototypeKeys(charInput)) {
      return { ok: false, code: 'INVALID_COMMAND', message: 'Character must be a plain object', recoverable: false };
    }

    if (Object.prototype.hasOwnProperty.call(charInput, 'id')) {
      return {
        ok: false,
        code: 'INVALID_COMMAND',
        message: 'Caller-supplied identity ID is forbidden on add',
        recoverable: false,
      };
    }

    for (const key of Object.keys(charInput)) {
      if (key !== 'name' && key !== 'descriptor' && key !== 'aliases') {
        return { ok: false, code: 'INVALID_COMMAND', message: `Unknown property on add character: ${key}`, recoverable: false };
      }
    }

    if (registry.characters.length >= MAX_CHARACTERS) {
      return {
        ok: false,
        code: 'CARD_CAPACITY_EXCEEDED',
        message: `Characters capacity limit reached (${MAX_CHARACTERS})`,
        recoverable: false,
      };
    }

    const name = charInput.name;
    const descriptor = charInput.descriptor !== undefined ? charInput.descriptor : '';
    const rawAliases = charInput.aliases !== undefined ? charInput.aliases : [];
    if (!Array.isArray(rawAliases)) {
      return { ok: false, code: 'INVALID_SCHEMA', message: 'Character aliases must be an array', recoverable: false };
    }
    const aliases = [...rawAliases];

    const newId = generateUuidV4();
    const candidateChar = {
      aliases,
      descriptor,
      id: newId,
      name,
    };

    const charValidation = validateCharacterRecord(candidateChar);
    if (!charValidation.ok) {
      return charValidation;
    }

    const nextRevision = registry.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      return {
        ok: false,
        code: 'REVISION_OVERFLOW',
        message: 'Revision safe integer overflow',
        recoverable: false,
      };
    }

    const nextSnapshot = deepFreeze({
      characters: deepFreeze([...registry.characters, deepFreeze(candidateChar)]),
      revision: nextRevision,
      schemaVersion: 1,
    });

    const serialized = canonicalStringify(nextSnapshot);
    if (getUtf8ByteLength(serialized) > MAX_REGISTRY_BYTES) {
      return {
        ok: false,
        code: 'BYTE_LIMIT_EXCEEDED',
        message: 'Registry serialized size exceeds 256 KiB limit',
        recoverable: false,
      };
    }

    return {
      ok: true,
      value: nextSnapshot,
    };
  }

  if (cmdType === 'update') {
    const cmdKeys = Object.keys(command);
    if (cmdKeys.length !== 2 || !cmdKeys.includes('character') || !cmdKeys.includes('type')) {
      return { ok: false, code: 'INVALID_COMMAND', message: 'Invalid keys on update command', recoverable: false };
    }

    const charInput = command.character;
    if (!isPlainObject(charInput) || hasOwnForbiddenPrototypeKeys(charInput)) {
      return { ok: false, code: 'INVALID_COMMAND', message: 'Character must be a plain object', recoverable: false };
    }

    const targetId = charInput.id;
    if (typeof targetId !== 'string' || !UUID_V4_REGEX.test(targetId)) {
      return { ok: false, code: 'INVALID_COMMAND', message: 'Valid identity ID required for update', recoverable: false };
    }

    for (const key of Object.keys(charInput)) {
      if (key !== 'id' && key !== 'name' && key !== 'descriptor' && key !== 'aliases') {
        return { ok: false, code: 'INVALID_COMMAND', message: `Unknown property on update character: ${key}`, recoverable: false };
      }
    }

    const targetIndex = registry.characters.findIndex((c) => c.id === targetId);
    if (targetIndex === -1) {
      return {
        ok: false,
        code: 'IDENTITY_NOT_FOUND',
        message: `Identity ${targetId} not found`,
        recoverable: false,
        details: { identityId: targetId },
      };
    }

    const existing = registry.characters[targetIndex];
    const nextName = charInput.name !== undefined ? charInput.name : existing.name;
    const nextDescriptor = charInput.descriptor !== undefined ? charInput.descriptor : existing.descriptor;
    const nextAliases = charInput.aliases !== undefined ? charInput.aliases : existing.aliases;

    // Check if actual changes were requested
    const isNameSame = nextName === existing.name;
    const isDescSame = nextDescriptor === existing.descriptor;
    const isAliasesSame =
      Array.isArray(nextAliases) &&
      nextAliases.length === existing.aliases.length &&
      nextAliases.every((a, i) => a === existing.aliases[i]);

    if (isNameSame && isDescSame && isAliasesSame) {
      // Mutation with no actual requested changes must not silently increment revision
      return {
        ok: true,
        value: registry,
      };
    }

    const updatedChar = {
      aliases: Array.isArray(nextAliases) ? [...nextAliases] : nextAliases,
      descriptor: nextDescriptor,
      id: existing.id,
      name: nextName,
    };

    const charValidation = validateCharacterRecord(updatedChar);
    if (!charValidation.ok) {
      return charValidation;
    }

    const nextRevision = registry.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      return {
        ok: false,
        code: 'REVISION_OVERFLOW',
        message: 'Revision safe integer overflow',
        recoverable: false,
      };
    }

    const nextCharacters = registry.characters.map((c, i) =>
      i === targetIndex ? deepFreeze(updatedChar) : c,
    );

    const nextSnapshot = deepFreeze({
      characters: deepFreeze(nextCharacters),
      revision: nextRevision,
      schemaVersion: 1,
    });

    const serialized = canonicalStringify(nextSnapshot);
    if (getUtf8ByteLength(serialized) > MAX_REGISTRY_BYTES) {
      return {
        ok: false,
        code: 'BYTE_LIMIT_EXCEEDED',
        message: 'Registry serialized size exceeds 256 KiB limit',
        recoverable: false,
      };
    }

    return {
      ok: true,
      value: nextSnapshot,
    };
  }

  if (cmdType === 'remove') {
    const cmdKeys = Object.keys(command);
    if (cmdKeys.length !== 2 || !cmdKeys.includes('identityId') || !cmdKeys.includes('type')) {
      return { ok: false, code: 'INVALID_COMMAND', message: 'Invalid keys on remove command', recoverable: false };
    }

    const targetId = command.identityId;
    if (typeof targetId !== 'string' || !UUID_V4_REGEX.test(targetId)) {
      return {
        ok: false,
        code: 'IDENTITY_NOT_FOUND',
        message: 'Identity not found',
        recoverable: false,
        details: { identityId: targetId },
      };
    }

    const targetIndex = registry.characters.findIndex((c) => c.id === targetId);
    if (targetIndex === -1) {
      return {
        ok: false,
        code: 'IDENTITY_NOT_FOUND',
        message: `Identity ${targetId} not found`,
        recoverable: false,
        details: { identityId: targetId },
      };
    }

    const nextRevision = registry.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      return {
        ok: false,
        code: 'REVISION_OVERFLOW',
        message: 'Revision safe integer overflow',
        recoverable: false,
      };
    }

    const nextCharacters = registry.characters.filter((_, i) => i !== targetIndex);

    const nextSnapshot = deepFreeze({
      characters: deepFreeze(nextCharacters),
      revision: nextRevision,
      schemaVersion: 1,
    });

    return {
      ok: true,
      value: nextSnapshot,
    };
  }

  return {
    ok: false,
    code: 'INVALID_COMMAND',
    message: `Unknown command type: ${cmdType}`,
    recoverable: false,
  };
}

/**
 * Deterministically serializes a registry snapshot to canonical JSON.
 *
 * @param {Readonly<RegistrySnapshot>} registry
 * @returns {HubResult<string>}
 */
export function serializeRegistry(registry) {
  const validation = internalValidateRegistry(registry);
  if (!validation.ok) {
    return validation;
  }

  const str = canonicalStringify(registry);
  const bytes = getUtf8ByteLength(str);
  if (bytes > MAX_REGISTRY_BYTES) {
    return {
      ok: false,
      code: 'BYTE_LIMIT_EXCEEDED',
      message: 'Registry serialized size exceeds 256 KiB limit',
      recoverable: false,
    };
  }

  return {
    ok: true,
    value: str,
  };
}
