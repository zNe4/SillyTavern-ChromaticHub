/**
 * SillyTavern-ChromaticHub: Read-Only SillyTavern Adapter Tests (H01-B1)
 *
 * Verifies readCard, full-card envelope validation, native wire protocol,
 * owner filename rules, context invalidation, cancellation, and privacy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readCard } from '../src/sillytavern-adapter.mjs';

function createValidRegistry(characters = []) {
  return {
    schemaVersion: 1,
    revision: 1,
    characters: characters.length > 0 ? characters : [
      {
        id: '4d15ae22-565c-4d19-9e6c-6d7653940cfa',
        name: 'Hina',
        descriptor: 'Knight',
        aliases: [],
      },
      {
        id: '64be5fd4-6900-4ed7-9844-2692c684c984',
        name: 'Hina',
        descriptor: 'Merchant',
        aliases: [],
      },
    ],
  };
}

function createFullCardResponse(avatar, registry, extra = {}) {
  const cardData = {
    name: 'Test Character',
    description: 'Character description',
  };
  if (registry !== undefined) {
    cardData.extensions = {
      chromaticHub: registry,
    };
  }
  return {
    avatar,
    data: cardData,
    ...extra,
  };
}

function createMockFetch(responsePayload, status = 200, statusText = 'OK') {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (options?.signal?.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: async () => {
        if (typeof responsePayload === 'string') {
          throw new SyntaxError('Unexpected token < in JSON');
        }
        return structuredClone(responsePayload);
      },
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

test('readCard - Owner Validation & Filename Rules', async (t) => {
  const defaultDeps = {
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-csrf' }),
    fetch: createMockFetch(createFullCardResponse('Hero.png', createValidRegistry())),
  };

  await t.test('accepts valid standard PNG basename', async () => {
    const owner = { kind: 'installed-card', avatar: 'Hero.png' };
    const res = await readCard(owner, defaultDeps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.avatar, 'Hero.png');
  });

  await t.test('accepts valid Unicode, spaces, and punctuation in PNG basenames', async () => {
    const validNames = [
      'Hero (Knight) [v1].png',
      'Café & Tea #1!.png',
      '100%_power-Hero.png',
      '日本語のキャラクター.png',
      'Hero.PNG',
    ];
    for (const name of validNames) {
      const mockFetch = createMockFetch(createFullCardResponse(name, createValidRegistry()));
      const res = await readCard({ kind: 'installed-card', avatar: name }, {
        ...defaultDeps,
        fetch: mockFetch,
      });
      assert.strictEqual(res.ok, true, `Failed for valid name: ${name}`);
      assert.strictEqual(res.avatar, name);
    }
  });

  await t.test('rejects non-object or missing owner', async () => {
    for (const badOwner of [null, undefined, 'Hero.png', 42, [], {}]) {
      const res = await readCard(badOwner, defaultDeps);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_OWNER');
    }
  });

  await t.test('rejects missing or wrong owner kind', async () => {
    const badKinds = ['card', 'character', '', null, undefined, 123];
    for (const kind of badKinds) {
      const res = await readCard({ kind, avatar: 'Hero.png' }, defaultDeps);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_OWNER');
    }
  });

  await t.test('rejects missing, non-string, or empty avatar', async () => {
    for (const badAvatar of [null, undefined, 123, '', '   ', '\t\n']) {
      const res = await readCard({ kind: 'installed-card', avatar: badAvatar }, defaultDeps);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_OWNER');
    }
  });

  await t.test('rejects path separators in avatar filename', async () => {
    const badPaths = [
      '/Hero.png',
      'sub/Hero.png',
      '\\Hero.png',
      'sub\\Hero.png',
      'folder/sub/Hero.png',
    ];
    for (const avatar of badPaths) {
      const res = await readCard({ kind: 'installed-card', avatar }, defaultDeps);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_OWNER');
    }
  });

  await t.test('rejects relative path artifacts and directory traversal', async () => {
    const badSequences = [
      '../Hero.png',
      '..\\Hero.png',
      '.png',
      '..png',
      '   .png',
    ];
    for (const avatar of badSequences) {
      const res = await readCard({ kind: 'installed-card', avatar }, defaultDeps);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_OWNER');
    }
  });

  await t.test('rejects control characters and NUL bytes', async () => {
    const badControlChars = [
      'Hero\0.png',
      'Hero\x07.png',
      'Hero\x1f.png',
      'Hero\x7f.png',
      'Hero\x80.png',
    ];
    for (const avatar of badControlChars) {
      const res = await readCard({ kind: 'installed-card', avatar }, defaultDeps);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_OWNER');
    }
  });

  await t.test('rejects non-PNG extensions', async () => {
    const badExts = [
      'Hero.webp',
      'Hero.jpg',
      'Hero.jpeg',
      'Hero.png.bak',
      'Hero',
    ];
    for (const avatar of badExts) {
      const res = await readCard({ kind: 'installed-card', avatar }, defaultDeps);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_OWNER');
    }
  });
});

test('readCard - Dependencies Validation', async (t) => {
  const validOwner = { kind: 'installed-card', avatar: 'Hero.png' };

  await t.test('rejects non-object or missing dependencies', async () => {
    for (const badDeps of [null, undefined, 42, 'deps', []]) {
      const res = await readCard(validOwner, badDeps);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_DEPENDENCY');
    }
  });

  await t.test('rejects missing or non-function getRequestHeaders', async () => {
    for (const badHeaders of [undefined, null, 123, 'headers', {}]) {
      const res = await readCard(validOwner, { getRequestHeaders: badHeaders });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_DEPENDENCY');
    }
  });

  await t.test('rejects getRequestHeaders returning non-object', async () => {
    for (const badReturn of [null, undefined, 'str', 123, []]) {
      const res = await readCard(validOwner, {
        getRequestHeaders: () => badReturn,
      });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_DEPENDENCY');
    }
  });

  await t.test('rejects non-function fetch when provided', async () => {
    const res = await readCard(validOwner, {
      getRequestHeaders: () => ({}),
      fetch: 'not-a-function',
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'INVALID_DEPENDENCY');
  });

  await t.test('rejects expectedContext without getContext and vice versa', async () => {
    const res1 = await readCard(validOwner, {
      getRequestHeaders: () => ({}),
      expectedContext: { characterId: 0 },
    });
    assert.strictEqual(res1.ok, false);
    assert.strictEqual(res1.code, 'INVALID_OPTIONS');

    const res2 = await readCard(validOwner, {
      getRequestHeaders: () => ({}),
      getContext: () => ({ characterId: 0 }),
    });
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.code, 'INVALID_OPTIONS');
  });

  await t.test('rejects invalid expectedContext or getContext types', async () => {
    const res1 = await readCard(validOwner, {
      getRequestHeaders: () => ({}),
      expectedContext: 'not-an-object',
      getContext: () => ({}),
    });
    assert.strictEqual(res1.ok, false);
    assert.strictEqual(res1.code, 'INVALID_OPTIONS');

    const res2 = await readCard(validOwner, {
      getRequestHeaders: () => ({}),
      expectedContext: {},
      getContext: 'not-a-function',
    });
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.code, 'INVALID_OPTIONS');
  });
});

test('readCard - Native SillyTavern Wire Protocol', async (t) => {
  const validOwner = { kind: 'installed-card', avatar: 'Hero.png' };

  await t.test('sends exact POST request to relative /api/characters/get with avatar_url', async () => {
    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));
    const headers = { 'X-CSRF-Token': 'csrf-token-123', Authorization: 'Bearer token-abc' };

    const res = await readCard(validOwner, {
      getRequestHeaders: () => headers,
      fetch: mockFetch,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(mockFetch.calls.length, 1);
    const call = mockFetch.calls[0];

    assert.strictEqual(call.url, '/api/characters/get');
    assert.strictEqual(call.options.method, 'POST');
    assert.strictEqual(call.options.headers['Content-Type'], 'application/json');
    assert.strictEqual(call.options.headers['X-CSRF-Token'], 'csrf-token-123');
    assert.strictEqual(call.options.headers.Authorization, 'Bearer token-abc');

    const body = JSON.parse(call.options.body);
    assert.deepStrictEqual(body, { avatar_url: 'Hero.png' });
    assert.strictEqual(body.avatar, undefined); // avatar_url strictly used, not avatar
  });

  await t.test('preserves Content-Type when getRequestHeaders omits it', async () => {
    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));
    await readCard(validOwner, {
      getRequestHeaders: () => ({ Custom: '1' }),
      fetch: mockFetch,
    });
    const call = mockFetch.calls[0];
    assert.strictEqual(call.options.headers['Content-Type'], 'application/json');
    assert.strictEqual(call.options.headers.Custom, '1');
  });
});

test('readCard - Full-Card Response Envelope Validation', async (t) => {
  const validOwner = { kind: 'installed-card', avatar: 'Hero.png' };
  const getRequestHeaders = () => ({ 'X-CSRF-Token': 'csrf' });

  await t.test('succeeds on valid full card with valid v1 registry', async () => {
    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'VALID');
    assert.strictEqual(res.avatar, 'Hero.png');
    assert.strictEqual(res.value.schemaVersion, 1);
    assert.strictEqual(res.value.revision, 1);
    assert.strictEqual(res.value.characters.length, 2);
    assert.strictEqual(Object.isFrozen(res.value), true);
  });

  await t.test('succeeds with UNINITIALIZED when extensions container is absent', async () => {
    const fullCardNoExt = {
      avatar: 'Hero.png',
      data: { name: 'Hero' },
    };
    const mockFetch = createMockFetch(fullCardNoExt);
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'UNINITIALIZED');
    assert.strictEqual(res.avatar, 'Hero.png');
    assert.strictEqual(res.value.schemaVersion, 1);
    assert.strictEqual(res.value.revision, 0);
    assert.deepStrictEqual(res.value.characters, []);
    assert.strictEqual(Object.isFrozen(res.value), true);
  });

  await t.test('succeeds with UNINITIALIZED when chromaticHub key is undefined', async () => {
    const fullCardUndef = {
      avatar: 'Hero.png',
      data: {
        name: 'Hero',
        extensions: {
          otherExtension: { foo: 'bar' },
        },
      },
    };
    const mockFetch = createMockFetch(fullCardUndef);
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'UNINITIALIZED');
    assert.strictEqual(res.value.revision, 0);
  });

  await t.test('fails when data.extensions is present but malformed', async () => {
    const malformedExtensions = [null, 'extensions', 123, []];
    for (const badExt of malformedExtensions) {
      const payload = {
        avatar: 'Hero.png',
        data: { name: 'Hero', extensions: badExt },
      };
      const mockFetch = createMockFetch(payload);
      const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'INVALID_SCHEMA');
    }
  });

  await t.test('fails when response avatar is missing or does not match requested avatar', async () => {
    const mismatchedPayloads = [
      { avatar: 'Villain.png', data: { name: 'Villain' } },
      { data: { name: 'NoAvatar' } },
      { avatar: null, data: { name: 'NullAvatar' } },
    ];
    for (const payload of mismatchedPayloads) {
      const mockFetch = createMockFetch(payload);
      const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'READ_FAILED');
    }
  });

  await t.test('fails when response data container is missing or not a plain object', async () => {
    const badDataPayloads = [
      { avatar: 'Hero.png' },
      { avatar: 'Hero.png', data: null },
      { avatar: 'Hero.png', data: 'data-string' },
      { avatar: 'Hero.png', data: [1, 2, 3] },
    ];
    for (const payload of badDataPayloads) {
      const mockFetch = createMockFetch(payload);
      const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'READ_FAILED');
    }
  });

  await t.test('fails when server returns shallow: true', async () => {
    const shallowPayload = {
      avatar: 'Hero.png',
      shallow: true,
      data: { name: 'Hero' },
    };
    const mockFetch = createMockFetch(shallowPayload);
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'READ_FAILED');
  });

  await t.test('fails when root response is null, array, or primitive', async () => {
    for (const payload of [null, 'card-text', [1, 2, 3], 42]) {
      const mockFetch = createMockFetch(payload);
      const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'READ_FAILED');
    }
  });

  await t.test('fails when server returns malformed non-JSON HTML error page', async () => {
    const mockFetch = createMockFetch('<html><body>502 Bad Gateway</body></html>', 502, 'Bad Gateway');
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'READ_FAILED');
  });
});

test('readCard - HTTP & Transport Error Handling', async (t) => {
  const validOwner = { kind: 'installed-card', avatar: 'Hero.png' };
  const getRequestHeaders = () => ({ 'X-CSRF-Token': 'csrf' });

  await t.test('handles HTTP 404 as CARD_NOT_FOUND', async () => {
    const mockFetch = createMockFetch({ error: 'Character not found' }, 404, 'Not Found');
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CARD_NOT_FOUND');
    assert.strictEqual(res.recoverable, false);
    assert.strictEqual(res.details?.status, 404);
    assert.strictEqual(res.details?.avatar, 'Hero.png');
  });

  await t.test('handles HTTP 500 as recoverable READ_FAILED', async () => {
    const mockFetch = createMockFetch({ error: 'Server error' }, 500, 'Internal Server Error');
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'READ_FAILED');
    assert.strictEqual(res.recoverable, true);
    assert.strictEqual(res.details?.status, 500);
  });

  await t.test('handles HTTP 401/403 as non-recoverable READ_FAILED', async () => {
    for (const status of [401, 403]) {
      const mockFetch = createMockFetch({ error: 'Forbidden' }, status, 'Forbidden');
      const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'READ_FAILED');
      assert.strictEqual(res.recoverable, false);
    }
  });

  await t.test('handles transport failure (fetch rejects) as recoverable READ_FAILED', async () => {
    const rejectingFetch = async () => {
      throw new TypeError('fetch failed');
    };
    const res = await readCard(validOwner, { getRequestHeaders, fetch: rejectingFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'READ_FAILED');
    assert.strictEqual(res.recoverable, true);
  });

  await t.test('handles fetch resolving to null as non-recoverable READ_FAILED without rejecting', async () => {
    const nullFetch = async () => null;
    const res = await readCard(validOwner, { getRequestHeaders, fetch: nullFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'READ_FAILED');
    assert.strictEqual(res.recoverable, false);
  });

  await t.test('handles fetch resolving to undefined as non-recoverable READ_FAILED without rejecting', async () => {
    const undefinedFetch = async () => undefined;
    const res = await readCard(validOwner, { getRequestHeaders, fetch: undefinedFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'READ_FAILED');
    assert.strictEqual(res.recoverable, false);
  });

  await t.test('handles malformed Response-like objects without usable JSON handling as READ_FAILED', async () => {
    const badResponses = [
      { status: 200, ok: true }, // missing json function
      { status: 200, ok: true, json: 'not-a-function' },
      { status: '200', json: async () => ({}) }, // non-number status
    ];
    for (const badResp of badResponses) {
      const mockFetch = async () => badResp;
      const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, 'READ_FAILED');
      assert.strictEqual(res.recoverable, false);
    }
  });
});

test('readCard - Registry Content & Version Validation (Core Delegation)', async (t) => {
  const validOwner = { kind: 'installed-card', avatar: 'Hero.png' };
  const getRequestHeaders = () => ({ 'X-CSRF-Token': 'csrf' });

  await t.test('fails with INVALID_SCHEMA when chromaticHub is null', async () => {
    const payload = createFullCardResponse('Hero.png', null);
    const mockFetch = createMockFetch(payload);
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'INVALID_SCHEMA');
  });

  await t.test('fails with INVALID_SCHEMA on unknown root properties', async () => {
    const corruptRegistry = {
      schemaVersion: 1,
      revision: 1,
      characters: [],
      unknownKey: true,
    };
    const payload = createFullCardResponse('Hero.png', corruptRegistry);
    const mockFetch = createMockFetch(payload);
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'INVALID_SCHEMA');
  });

  await t.test('fails with UNSUPPORTED_VERSION on schemaVersion 2', async () => {
    const registryV2 = {
      schemaVersion: 2,
      revision: 1,
      characters: [],
    };
    const payload = createFullCardResponse('Hero.png', registryV2);
    const mockFetch = createMockFetch(payload);
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'UNSUPPORTED_VERSION');
    assert.strictEqual(res.details?.foundVersion, 2);
  });

  await t.test('fails with INVALID_SCHEMA on corrupt character records (invalid UUID)', async () => {
    const corruptChar = {
      schemaVersion: 1,
      revision: 1,
      characters: [
        {
          id: 'not-a-uuid',
          name: 'Hero',
          descriptor: '',
          aliases: [],
        },
      ],
    };
    const payload = createFullCardResponse('Hero.png', corruptChar);
    const mockFetch = createMockFetch(payload);
    const res = await readCard(validOwner, { getRequestHeaders, fetch: mockFetch });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'INVALID_SCHEMA');
  });
});

test('readCard - Context-Bound Reads & Group Chats', async (t) => {
  const memberOwner = { kind: 'installed-card', avatar: 'Member_1.png' };
  const getRequestHeaders = () => ({ 'X-CSRF-Token': 'csrf' });

  await t.test('succeeds reading explicit member card during active group chat', async () => {
    const groupContext = {
      groupId: 'group-uuid-1234',
      chatId: 'group-chat-5678',
      characterId: null,
      avatar: null, // active avatar in group chat is null or group icon
    };
    const mockFetch = createMockFetch(createFullCardResponse('Member_1.png', createValidRegistry()));

    const res = await readCard(memberOwner, {
      getRequestHeaders,
      fetch: mockFetch,
      expectedContext: groupContext,
      getContext: () => groupContext,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.avatar, 'Member_1.png');
    assert.strictEqual(res.status, 'VALID');
  });

  await t.test('detects pre-dispatch context mismatch and aborts without network call', async () => {
    const expectedContext = {
      characterId: 0,
      avatar: 'Hero.png',
      groupId: null,
      chatId: 'chat-1',
    };
    const currentContext = {
      characterId: 1, // user switched character before call
      avatar: 'Villain.png',
      groupId: null,
      chatId: 'chat-1',
    };
    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));

    const res = await readCard({ kind: 'installed-card', avatar: 'Hero.png' }, {
      getRequestHeaders,
      fetch: mockFetch,
      expectedContext,
      getContext: () => currentContext,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'STALE_CARD_LOCATOR');
    assert.strictEqual(mockFetch.calls.length, 0); // No fetch dispatched
  });

  await t.test('handles getContext throwing before dispatch without dispatching network call', async () => {
    const expectedContext = {
      characterId: 0,
      avatar: 'Hero.png',
      groupId: null,
      chatId: 'chat-1',
    };
    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));

    const res = await readCard({ kind: 'installed-card', avatar: 'Hero.png' }, {
      getRequestHeaders,
      fetch: mockFetch,
      expectedContext,
      getContext: () => {
        throw new Error('DOM UI context exploded with private data');
      },
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'STALE_CARD_LOCATOR');
    assert.strictEqual(mockFetch.calls.length, 0); // No fetch dispatched
    // Privacy: raw error not leaked
    assert.strictEqual(JSON.stringify(res).includes('private data'), false);
  });

  await t.test('handles getContext throwing during post-response verification', async () => {
    const expectedContext = {
      characterId: 0,
      avatar: 'Hero.png',
      groupId: null,
      chatId: 'chat-1',
    };
    let callCount = 0;
    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));

    const res = await readCard({ kind: 'installed-card', avatar: 'Hero.png' }, {
      getRequestHeaders,
      fetch: mockFetch,
      expectedContext,
      getContext: () => {
        callCount++;
        if (callCount === 1) {
          return expectedContext; // passes pre-dispatch
        }
        throw new Error('DOM UI context exploded post-fetch');
      },
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'STALE_CARD_LOCATOR');
    assert.strictEqual(mockFetch.calls.length, 1); // Fetch was dispatched
    assert.strictEqual(JSON.stringify(res).includes('exploded'), false);
  });

  await t.test('detects in-flight context change after network fetch completes', async () => {
    const expectedContext = {
      characterId: 0,
      avatar: 'Hero.png',
      groupId: null,
      chatId: 'chat-1',
    };
    let currentContext = { ...expectedContext };

    const mockFetch = async (url, options) => {
      // Simulate user switching character while fetch is in-flight
      currentContext = {
        characterId: 2,
        avatar: 'Other.png',
        groupId: null,
        chatId: 'chat-1',
      };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => createFullCardResponse('Hero.png', createValidRegistry()),
      };
    };

    const res = await readCard({ kind: 'installed-card', avatar: 'Hero.png' }, {
      getRequestHeaders,
      fetch: mockFetch,
      expectedContext,
      getContext: () => currentContext,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'STALE_CARD_LOCATOR');
  });

  await t.test('succeeds when context remains unchanged before and after fetch', async () => {
    const expectedContext = {
      characterId: 0,
      avatar: 'Hero.png',
      groupId: null,
      chatId: 'chat-1',
    };
    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));

    const res = await readCard({ kind: 'installed-card', avatar: 'Hero.png' }, {
      getRequestHeaders,
      fetch: mockFetch,
      expectedContext,
      getContext: () => expectedContext,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'VALID');
  });
});

test('readCard - Cancellation & AbortSignal', async (t) => {
  const validOwner = { kind: 'installed-card', avatar: 'Hero.png' };
  const getRequestHeaders = () => ({ 'X-CSRF-Token': 'csrf' });

  await t.test('returns OPERATION_CANCELLED when signal is already aborted before call', async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));
    const res = await readCard(validOwner, {
      getRequestHeaders,
      fetch: mockFetch,
      signal: controller.signal,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'OPERATION_CANCELLED');
    assert.strictEqual(mockFetch.calls.length, 0); // No fetch dispatched
  });

  await t.test('returns OPERATION_CANCELLED when signal is aborted during in-flight fetch', async () => {
    const controller = new AbortController();
    const abortingFetch = async (url, options) => {
      controller.abort();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const res = await readCard(validOwner, {
      getRequestHeaders,
      fetch: abortingFetch,
      signal: controller.signal,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'OPERATION_CANCELLED');
  });

  await t.test('returns OPERATION_CANCELLED when signal is aborted after fetch but before return', async () => {
    const controller = new AbortController();
    const mockFetch = async () => {
      // Abort right as response is ready
      controller.abort();
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => createFullCardResponse('Hero.png', createValidRegistry()),
      };
    };

    const res = await readCard(validOwner, {
      getRequestHeaders,
      fetch: mockFetch,
      signal: controller.signal,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'OPERATION_CANCELLED');
  });
});

test('readCard - Independence, Immutability & Privacy Invariants', async (t) => {
  const getRequestHeaders = () => ({
    'X-CSRF-Token': 'super-secret-csrf-token',
    Authorization: 'Bearer super-secret-jwt',
  });

  await t.test('produces independent snapshots for two cards with identical character UUIDs', async () => {
    const sharedRegistry = createValidRegistry();
    const fetchA = createMockFetch(createFullCardResponse('Card_A.png', sharedRegistry));
    const fetchB = createMockFetch(createFullCardResponse('Card_B.png', sharedRegistry));

    const resA = await readCard({ kind: 'installed-card', avatar: 'Card_A.png' }, {
      getRequestHeaders,
      fetch: fetchA,
    });
    const resB = await readCard({ kind: 'installed-card', avatar: 'Card_B.png' }, {
      getRequestHeaders,
      fetch: fetchB,
    });

    assert.strictEqual(resA.ok, true);
    assert.strictEqual(resB.ok, true);
    assert.strictEqual(resA.avatar, 'Card_A.png');
    assert.strictEqual(resB.avatar, 'Card_B.png');
    // Values have same contents but are independent cloned objects
    assert.notStrictEqual(resA.value, resB.value);
    assert.notStrictEqual(resA.value.characters, resB.value.characters);
    assert.notStrictEqual(resA.value.characters[0], resB.value.characters[0]);
  });

  await t.test('returned snapshot is deeply frozen and rejects mutations', async () => {
    const mockFetch = createMockFetch(createFullCardResponse('Hero.png', createValidRegistry()));
    const res = await readCard({ kind: 'installed-card', avatar: 'Hero.png' }, {
      getRequestHeaders,
      fetch: mockFetch,
    });

    assert.strictEqual(res.ok, true);
    assert.throws(() => {
      res.value.revision = 999;
    }, TypeError);
    assert.throws(() => {
      res.value.characters.push({});
    }, TypeError);
    assert.throws(() => {
      res.value.characters[0].name = 'Mutated';
    }, TypeError);
  });

  await t.test('privacy: error messages and details never leak headers or secrets', async () => {
    // Inject headers that should never appear in error outputs
    const secretHeaders = () => ({
      'X-CSRF-Token': 'SECRET_CSRF_12345',
      Cookie: 'session=SECRET_COOKIE_DATA',
    });
    const mockFetch = createMockFetch({ error: 'Server exploded with sensitive card details' }, 500);

    const res = await readCard({ kind: 'installed-card', avatar: 'Hero.png' }, {
      getRequestHeaders: secretHeaders,
      fetch: mockFetch,
    });

    assert.strictEqual(res.ok, false);
    const serialized = JSON.stringify(res);
    assert.strictEqual(serialized.includes('SECRET_CSRF'), false);
    assert.strictEqual(serialized.includes('SECRET_COOKIE'), false);
    assert.strictEqual(serialized.includes('sensitive card details'), false);
  });
});
