/**
 * SillyTavern-ChromaticHub: Guarded Mutation Controller Tests (H01-B2-I / H01-B2-R1)
 *
 * Synthetic unit tests covering:
 * - Parameter and mandatory context validation
 * - Group chat rejection and context drift
 * - Fail-closed editor safety
 * - Per-avatar mutex queue and quarantine race
 * - Pre-read conflict detection and no-op short-circuit
 * - SillyTavern wire protocol formatting
 * - Post-dispatch readback persistence verification
 * - Two-phase cancellation and bounded timeouts
 * - Three-way decision table coverage
 * - Immutability, privacy, and memory safety
 * - H01-B2-R1: Hard deadlines, malformed responses, diagnostic privacy
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mutateCard } from '../src/card-mutation-controller.mjs';

let avatarCounter = 0;
function uniqueAvatar(prefix = 'TestCard') {
  return `${prefix}_${++avatarCounter}.png`;
}

function createMockCard(avatar, registry) {
  return {
    avatar,
    data: {
      extensions: registry === undefined ? {} : { chromaticHub: registry },
    },
  };
}

function createMockFetch(responses) {
  let callCount = 0;
  const calls = [];

  const fetchFn = async (url, options = {}) => {
    const callIndex = callCount++;
    calls.push({ url, options });

    if (options.signal?.aborted) {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    }

    const responder = responses[callIndex] ?? responses[url] ?? responses.default;
    if (!responder) {
      throw new Error(`Unexpected fetch call #${callIndex} to ${url}`);
    }

    if (typeof responder === 'function') {
      if (options.signal) {
        let onAbort;
        const abortPromise = new Promise((_, reject) => {
          onAbort = () => {
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            reject(err);
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
        });

        try {
          return await Promise.race([responder(url, options, callIndex), abortPromise]);
        } finally {
          options.signal.removeEventListener('abort', onAbort);
        }
      }
      return await responder(url, options, callIndex);
    }

    if (responder.throws) {
      throw responder.throws;
    }

    return {
      ok: responder.ok ?? (responder.status >= 200 && responder.status < 300),
      status: responder.status ?? 200,
      json: async () => responder.body,
    };
  };

  fetchFn.getCalls = () => calls;
  fetchFn.getCallCount = () => callCount;
  return fetchFn;
}

const VALID_UUID_1 = '4d15ae22-565c-4d19-9e6c-6d7653940cfa';
const VALID_UUID_2 = '64be5fd4-6900-4ed7-9844-2692c684c984';

function getValidInitialRegistry() {
  return {
    schemaVersion: 1,
    revision: 1,
    characters: [
      {
        id: VALID_UUID_1,
        name: 'Hina',
        descriptor: 'Knight',
        aliases: ['Captain'],
      },
    ],
  };
}

function createValidDependencies(overrides = {}) {
  const avatar = overrides.avatar ?? uniqueAvatar('DefaultCard');
  const defaultHeaders = { 'X-CSRF-Token': 'test-token-123' };

  return {
    getRequestHeaders: () => ({ ...defaultHeaders }),
    checkEditorSafety: () => ({ safe: true }),
    getContext: () => ({
      characterId: 0,
      avatar,
      chatId: 'chat_001',
    }),
    expectedContext: {
      characterId: 0,
      avatar,
      chatId: 'chat_001',
    },
    ...overrides,
  };
}

test('mutateCard - Parameter & Dependency Validation', async (t) => {
  await t.test('rejects missing or non-object owner with INVALID_OWNER', async () => {
    const deps = createValidDependencies();
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };

    const r1 = await mutateCard(null, cmd, exp, deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'INVALID_OWNER');

    const r2 = await mutateCard('not-an-object', cmd, exp, deps);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'INVALID_OWNER');
  });

  await t.test('rejects invalid avatar filename (traversal, separators, non-PNG, control chars)', async () => {
    const deps = createValidDependencies();
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };

    const badAvatars = [
      '../test.png',
      '/var/data/char.png',
      'test.jpg',
      'test\x00.png',
      '..png',
      '.png',
      '',
    ];

    for (const bad of badAvatars) {
      const res = await mutateCard({ kind: 'installed-card', avatar: bad }, cmd, exp, deps);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_OWNER');
    }
  });

  await t.test('rejects malformed command or caller-supplied id on add', async () => {
    const avatar = uniqueAvatar('ParamVal_Cmd');
    const deps = createValidDependencies({ avatar });
    const owner = { kind: 'installed-card', avatar };
    const exp = { status: 'UNINITIALIZED' };

    const r1 = await mutateCard(owner, { type: 'unknown_cmd' }, exp, deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'INVALID_COMMAND');

    const r2 = await mutateCard(owner, { type: 'add', character: { id: VALID_UUID_1, name: 'Hina' } }, exp, deps);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'INVALID_COMMAND');
  });

  await t.test('rejects missing getRequestHeaders or non-function fetch', async () => {
    const avatar = uniqueAvatar('ParamVal_Deps');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };

    const deps1 = createValidDependencies({ avatar });
    delete deps1.getRequestHeaders;
    const r1 = await mutateCard(owner, cmd, exp, deps1);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'INVALID_DEPENDENCY');

    const deps2 = createValidDependencies({ avatar, fetch: 'not-a-func' });
    const r2 = await mutateCard(owner, cmd, exp, deps2);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'INVALID_DEPENDENCY');
  });

  await t.test('rejects missing or non-function getContext', async () => {
    const avatar = uniqueAvatar('ParamVal_Context');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };

    const deps = createValidDependencies({ avatar });
    delete deps.getContext;
    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'INVALID_DEPENDENCY');
  });

  await t.test('rejects missing, empty ({}), or incomplete expectedContext', async () => {
    const avatar = uniqueAvatar('ParamVal_ContextExp');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };

    const deps1 = createValidDependencies({ avatar });
    delete deps1.expectedContext;
    const r1 = await mutateCard(owner, cmd, exp, deps1);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'INVALID_OPTIONS');

    const deps2 = createValidDependencies({ avatar, expectedContext: {} });
    const r2 = await mutateCard(owner, cmd, exp, deps2);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'INVALID_OPTIONS');

    const deps3 = createValidDependencies({ avatar, expectedContext: { chatId: 'c1' } });
    const r3 = await mutateCard(owner, cmd, exp, deps3);
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'INVALID_OPTIONS');
  });

  await t.test('rejects invalid expectedSnapshot structure', async () => {
    const avatar = uniqueAvatar('ParamVal_Snapshot');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const deps = createValidDependencies({ avatar });

    const r1 = await mutateCard(owner, cmd, null, deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'INVALID_OPTIONS');

    const r2 = await mutateCard(owner, cmd, { status: 'INVALID_STATUS' }, deps);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'INVALID_OPTIONS');

    const r3 = await mutateCard(owner, cmd, { status: 'VALID' }, deps);
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'INVALID_OPTIONS');
  });
});

test('mutateCard - Context Enforcement & Group Chat Exclusion', async (t) => {
  await t.test('rejects mutation when groupId is present in expectedContext', async () => {
    const avatar = uniqueAvatar('Context_Group1');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };
    const deps = createValidDependencies({
      avatar,
      expectedContext: { avatar, characterId: 0, groupId: 'group_999' },
    });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'UNSUPPORTED_CONTEXT');
  });

  await t.test('rejects mutation when groupId is present in live getContext', async () => {
    const avatar = uniqueAvatar('Context_Group2');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };
    const deps = createValidDependencies({
      avatar,
      getContext: () => ({ avatar, characterId: 0, groupId: 'group_live' }),
    });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'UNSUPPORTED_CONTEXT');
  });

  await t.test('rejects mutation when expectedContext avatar does not match owner.avatar', async () => {
    const owner = { kind: 'installed-card', avatar: uniqueAvatar('TargetCard') };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };
    const deps = createValidDependencies({
      avatar: uniqueAvatar('DifferentCard'),
    });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STALE_CARD_LOCATOR');
  });

  await t.test('rejects mutation when live context avatar does not match owner.avatar', async () => {
    const avatar = uniqueAvatar('Context_AvatarDrift');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };
    const deps = createValidDependencies({
      avatar,
      getContext: () => ({ avatar: uniqueAvatar('OtherAvatar'), characterId: 0 }),
    });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STALE_CARD_LOCATOR');
  });

  await t.test('resolves selected avatar from characters[characterId] when context.avatar is missing', async () => {
    const avatar = uniqueAvatar('Context_ResolvedAvatar');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Alice' } };
    const exp = { status: 'UNINITIALIZED' };

    let plannedUuid;
    const mockFetch = createMockFetch([
      // Pre-read
      { status: 200, body: createMockCard(avatar, undefined) },
      // POST merge
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      },
      // Readback
      () => ({
        ok: true,
        status: 200,
        json: async () =>
          createMockCard(avatar, {
            schemaVersion: 1,
            revision: 1,
            characters: [{ id: plannedUuid, name: 'Alice', descriptor: '', aliases: [] }],
          }),
      }),
    ]);

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      getContext: () => ({
        characterId: 2,
        characters: [{ avatar: 'C0.png' }, { avatar: 'C1.png' }, { avatar }],
      }),
      expectedContext: {
        characterId: 2,
        characters: [{ avatar: 'C0.png' }, { avatar: 'C1.png' }, { avatar }],
      },
    });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, true);
    assert.equal(res.avatar, avatar);
  });

  await t.test('fails safely with STALE_CARD_LOCATOR when getContext throws', async () => {
    const avatar = uniqueAvatar('Context_Throw');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };
    const deps = createValidDependencies({
      avatar,
      getContext: () => { throw new Error('DOM detached'); },
    });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STALE_CARD_LOCATOR');
  });
});

test('mutateCard - Fail-Closed Editor Safety Gate', async (t) => {
  await t.test('rejects mutation when checkEditorSafety is missing or not a function', async () => {
    const avatar = uniqueAvatar('Editor_Missing');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };
    const deps = createValidDependencies({ avatar });
    delete deps.checkEditorSafety;

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'INVALID_DEPENDENCY');
  });

  await t.test('rejects mutation with WRITE_REJECTED when checkEditorSafety returns safe: false', async () => {
    const avatar = uniqueAvatar('Editor_Unsafe');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };
    const deps = createValidDependencies({
      avatar,
      checkEditorSafety: () => ({ safe: false, reason: 'POPUP_OPEN' }),
    });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
  });

  await t.test('rejects mutation with WRITE_REJECTED when checkEditorSafety throws', async () => {
    const avatar = uniqueAvatar('Editor_Throw');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'Bob' } };
    const exp = { status: 'UNINITIALIZED' };
    const deps = createValidDependencies({
      avatar,
      checkEditorSafety: () => { throw new Error('DOM query error'); },
    });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
  });
});

test('mutateCard - Mutex Queue & Uncertainty Quarantine Race', async (t) => {
  await t.test('serializes concurrent mutations on the same avatar in strict FIFO order', async () => {
    const avatar = uniqueAvatar('Queue_Fifo');
    const owner = { kind: 'installed-card', avatar };

    let activeOperations = 0;
    let maxConcurrent = 0;

    const mockFetch = createMockFetch({
      default: async (url) => {
        activeOperations++;
        maxConcurrent = Math.max(maxConcurrent, activeOperations);
        await new Promise((r) => setTimeout(r, 20));
        activeOperations--;

        if (url === '/api/characters/get') {
          return {
            ok: true,
            status: 200,
            json: async () => createMockCard(avatar, undefined),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      },
    });

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const cmd1 = { type: 'add', character: { name: 'Op1' } };
    const cmd2 = { type: 'add', character: { name: 'Op2' } };
    const exp = { status: 'UNINITIALIZED' };

    await Promise.all([
      mutateCard(owner, cmd1, exp, deps),
      mutateCard(owner, cmd2, exp, deps),
    ]);

    assert.equal(maxConcurrent, 1, 'Same avatar operations must never overlap');
  });

  await t.test('different avatars run concurrently without blocking', async () => {
    const avatarA = uniqueAvatar('Queue_A');
    const avatarB = uniqueAvatar('Queue_B');

    let activeOperations = 0;
    let maxConcurrent = 0;

    const mockFetch = createMockFetch({
      default: async (url, options) => {
        activeOperations++;
        maxConcurrent = Math.max(maxConcurrent, activeOperations);
        await new Promise((r) => setTimeout(r, 30));
        activeOperations--;

        const targetAvatar = url.includes('merge')
          ? JSON.parse(options.body).avatar
          : JSON.parse(options.body).avatar_url;

        return {
          ok: true,
          status: 200,
          json: async () => createMockCard(targetAvatar, undefined),
        };
      },
    });

    const depsA = createValidDependencies({ avatar: avatarA, fetch: mockFetch });
    const depsB = createValidDependencies({ avatar: avatarB, fetch: mockFetch });

    await Promise.all([
      mutateCard({ kind: 'installed-card', avatar: avatarA }, { type: 'add', character: { name: 'A' } }, { status: 'UNINITIALIZED' }, depsA),
      mutateCard({ kind: 'installed-card', avatar: avatarB }, { type: 'add', character: { name: 'B' } }, { status: 'UNINITIALIZED' }, depsB),
    ]);

    assert.equal(maxConcurrent > 1, true, 'Different avatars should be able to execute concurrently');
  });

  await t.test('quarantine established while another operation waits in the queue', async () => {
    const avatar = uniqueAvatar('Queue_QuarantineRace');
    const owner = { kind: 'installed-card', avatar };

    let postAttemptCount = 0;

    const mockFetch = createMockFetch({
      default: async (url) => {
        if (url === '/api/characters/merge-attributes') {
          postAttemptCount++;
          throw new TypeError('Network connection reset');
        }
        return {
          ok: true,
          status: 200,
          json: async () => createMockCard(avatar, undefined),
        };
      },
    });

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const cmd1 = { type: 'add', character: { name: 'First' } };
    const cmd2 = { type: 'add', character: { name: 'Second' } };
    const exp = { status: 'UNINITIALIZED' };

    const p1 = mutateCard(owner, cmd1, exp, deps);
    const p2 = mutateCard(owner, cmd2, exp, deps);

    const [res1, res2] = await Promise.all([p1, p2]);

    assert.equal(res1.ok, false);
    assert.equal(res1.code, 'WRITE_UNCERTAIN');

    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
    assert.equal(postAttemptCount, 1, 'Second operation must NOT dispatch any POST');
  });

  await t.test('different-avatar mutation unaffected while one avatar is quarantined', async () => {
    const avatarQuarantined = uniqueAvatar('Quarantined_One');
    const avatarClean = uniqueAvatar('Unrelated_Clean');

    // 1. Force avatarQuarantined to become quarantined
    const mockFetchBad = createMockFetch({
      default: async (url) => {
        if (url === '/api/characters/merge-attributes') {
          throw new TypeError('Simulated POST network drop');
        }
        return {
          ok: true,
          status: 200,
          json: async () => createMockCard(avatarQuarantined, undefined),
        };
      },
    });

    const depsBad = createValidDependencies({ avatar: avatarQuarantined, fetch: mockFetchBad });
    const resBad = await mutateCard(
      { kind: 'installed-card', avatar: avatarQuarantined },
      { type: 'add', character: { name: 'Bad' } },
      { status: 'UNINITIALIZED' },
      depsBad
    );
    assert.equal(resBad.ok, false);
    assert.equal(resBad.code, 'WRITE_UNCERTAIN');

    // 2. Op on unrelated avatar proceeds normally
    let plannedUuid;
    const mockFetchClean = createMockFetch([
      { status: 200, body: createMockCard(avatarClean, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      () => ({
        ok: true,
        status: 200,
        json: async () =>
          createMockCard(avatarClean, {
            schemaVersion: 1,
            revision: 1,
            characters: [{ id: plannedUuid, name: 'Clean', descriptor: '', aliases: [] }],
          }),
      }),
    ]);

    const depsClean = createValidDependencies({ avatar: avatarClean, fetch: mockFetchClean });
    const resClean = await mutateCard(
      { kind: 'installed-card', avatar: avatarClean },
      { type: 'add', character: { name: 'Clean' } },
      { status: 'UNINITIALIZED' },
      depsClean
    );

    assert.equal(resClean.ok, true);
    assert.equal(resClean.avatar, avatarClean);
  });
});

test('mutateCard - Pre-Write Card Read & Conflict Detection', async (t) => {
  await t.test('fails with CARD_NOT_FOUND when pre-read returns 404', async () => {
    const avatar = uniqueAvatar('Conflict_404');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch([
      { status: 404, body: { message: 'Not found' } },
    ]);
    const deps = createValidDependencies({ avatar, fetch: mockFetch });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'A' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CARD_NOT_FOUND');
  });

  await t.test('detects conflict when expecting UNINITIALIZED but card has valid registry', async () => {
    const avatar = uniqueAvatar('Conflict_UninitVsValid');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, getValidInitialRegistry()) },
    ]);
    const deps = createValidDependencies({ avatar, fetch: mockFetch });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'A' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CONFLICT_DETECTED');
  });

  await t.test('detects conflict when expecting VALID but card is UNINITIALIZED', async () => {
    const avatar = uniqueAvatar('Conflict_ValidVsUninit');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
    ]);
    const deps = createValidDependencies({ avatar, fetch: mockFetch });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'A' } },
      { status: 'VALID', value: getValidInitialRegistry() },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CONFLICT_DETECTED');
  });

  await t.test('detects conflict when card revision differs from expected revision', async () => {
    const avatar = uniqueAvatar('Conflict_RevMismatch');
    const owner = { kind: 'installed-card', avatar };
    const cardRegistry = { ...getValidInitialRegistry(), revision: 5 };
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, cardRegistry) },
    ]);
    const deps = createValidDependencies({ avatar, fetch: mockFetch });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'A' } },
      { status: 'VALID', value: { ...getValidInitialRegistry(), revision: 4 } },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CONFLICT_DETECTED');
  });

  await t.test('detects conflict when canonical serialized content differs from expected snapshot', async () => {
    const avatar = uniqueAvatar('Conflict_ContentMismatch');
    const owner = { kind: 'installed-card', avatar };
    const cardRegistry = getValidInitialRegistry();
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, cardRegistry) },
    ]);
    const deps = createValidDependencies({ avatar, fetch: mockFetch });

    const expectedValue = {
      ...getValidInitialRegistry(),
      characters: [
        {
          id: VALID_UUID_1,
          name: 'Hina Altered',
          descriptor: 'Knight',
          aliases: ['Captain'],
        },
      ],
    };

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'A' } },
      { status: 'VALID', value: expectedValue },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CONFLICT_DETECTED');
  });
});

test('mutateCard - Core Mutation Delegation & No-Op Short-Circuit', async (t) => {
  await t.test('valid update no-op performs no POST and preserves status and revision', async () => {
    const avatar = uniqueAvatar('NoOp_Update');
    const owner = { kind: 'installed-card', avatar };
    const initialReg = getValidInitialRegistry();

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, initialReg) },
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const cmd = {
      type: 'update',
      character: {
        id: VALID_UUID_1,
        name: 'Hina',
        descriptor: 'Knight',
        aliases: ['Captain'],
      },
    };

    const res = await mutateCard(owner, cmd, { status: 'VALID', value: initialReg }, deps);

    assert.equal(res.ok, true);
    assert.equal(res.noop, true);
    assert.equal(res.status, 'VALID');
    assert.equal(res.value.revision, initialReg.revision);
    assert.equal(mockFetch.getCallCount(), 1, 'Only pre-read should have been called; NO POST');
  });

  await t.test('verified add mutation materializes UNINITIALIZED card to revision 1', async () => {
    const avatar = uniqueAvatar('Verified_Add');
    const owner = { kind: 'installed-card', avatar };

    let plannedUuid;
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      },
      () => ({
        ok: true,
        status: 200,
        json: async () =>
          createMockCard(avatar, {
            schemaVersion: 1,
            revision: 1,
            characters: [
              {
                id: plannedUuid,
                name: 'Arthur',
                descriptor: 'King',
                aliases: [],
              },
            ],
          }),
      }),
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const cmd = { type: 'add', character: { name: 'Arthur', descriptor: 'King' } };

    const res = await mutateCard(owner, cmd, { status: 'UNINITIALIZED' }, deps);

    assert.equal(res.ok, true);
    assert.equal(res.status, 'VALID');
    assert.equal(res.value.revision, 1);
    assert.equal(res.value.characters[0].name, 'Arthur');
    assert.equal(mockFetch.getCallCount(), 3);
  });

  await t.test('verified remove mutation decrements characters and bumps revision', async () => {
    const avatar = uniqueAvatar('Verified_Remove');
    const owner = { kind: 'installed-card', avatar };
    const initialReg = getValidInitialRegistry();

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, initialReg) },
      { status: 200, body: { ok: true } },
      {
        status: 200,
        body: createMockCard(avatar, {
          schemaVersion: 1,
          revision: 2,
          characters: [],
        }),
      },
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const cmd = { type: 'remove', identityId: VALID_UUID_1 };

    const res = await mutateCard(owner, cmd, { status: 'VALID', value: initialReg }, deps);

    assert.equal(res.ok, true);
    assert.equal(res.status, 'VALID');
    assert.equal(res.value.revision, 2);
    assert.equal(res.value.characters.length, 0);
  });
});

test('mutateCard - SillyTavern Wire Protocol Formatting', async (t) => {
  await t.test('sends POST to /api/characters/merge-attributes with avatar and namespaced data', async () => {
    const avatar = uniqueAvatar('Wire_Format');
    const owner = { kind: 'installed-card', avatar };

    let mergeCall;
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      (url, options) => {
        mergeCall = { url, options };
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      },
      () => {
        const body = JSON.parse(mergeCall.options.body);
        return {
          ok: true,
          status: 200,
          json: async () => createMockCard(avatar, body.data.extensions.chromaticHub),
        };
      },
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'WireCheck' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, true);
    assert.equal(mergeCall.url, '/api/characters/merge-attributes');
    assert.equal(mergeCall.options.method, 'POST');

    const parsedBody = JSON.parse(mergeCall.options.body);
    assert.equal(parsedBody.avatar, avatar, 'Must send "avatar", NOT "avatar_url"');
    assert.equal(parsedBody.avatar_url, undefined);
    assert.deepEqual(Object.keys(parsedBody), ['avatar', 'data']);
    assert.deepEqual(Object.keys(parsedBody.data), ['extensions']);
    assert.deepEqual(Object.keys(parsedBody.data.extensions), ['chromaticHub']);
    assert.equal(mergeCall.options.headers['X-CSRF-Token'], 'test-token-123');
  });
});

test('mutateCard - Post-Dispatch Readback & Decision Table', async (t) => {
  await t.test('detects silent write failure: HTTP 200 with unchanged registry -> READBACK_MISMATCH', async () => {
    const avatar = uniqueAvatar('Decision_SilentFailure');
    const owner = { kind: 'installed-card', avatar };

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      { status: 200, body: { ok: true } },
      { status: 200, body: createMockCard(avatar, undefined) },
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Ghost' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'READBACK_MISMATCH');
    assert.equal(res.details?.reason, 'UNPERSISTED_200');
  });

  await t.test('detects concurrent write: HTTP 200 with unexpected registry -> READBACK_MISMATCH', async () => {
    const avatar = uniqueAvatar('Decision_ConcurrentWrite');
    const owner = { kind: 'installed-card', avatar };

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      { status: 200, body: { ok: true } },
      {
        status: 200,
        body: createMockCard(avatar, {
          schemaVersion: 1,
          revision: 99,
          characters: [{ id: VALID_UUID_2, name: 'Alien', descriptor: '', aliases: [] }],
        }),
      },
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Local' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'READBACK_MISMATCH');
  });

  await t.test('HTTP 200 + readback failed -> WRITE_UNCERTAIN & avatar quarantined', async () => {
    const avatar = uniqueAvatar('Decision_200_ReadFailed');
    const owner = { kind: 'installed-card', avatar };

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      { status: 200, body: { ok: true } },
      { status: 500, body: { message: 'Disk read error' } },
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res1 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Mystery' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res1.ok, false);
    assert.equal(res1.code, 'WRITE_UNCERTAIN');

    // Subsequent call must fail with CARD_QUARANTINED
    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Mystery2' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
  });

  await t.test('HTTP 400 + readback unchanged -> WRITE_REJECTED (recoverable: false)', async () => {
    const avatar = uniqueAvatar('Decision_400_Unchanged');
    const owner = { kind: 'installed-card', avatar };

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      { status: 400, body: { message: 'Bad request' } },
      { status: 200, body: createMockCard(avatar, undefined) },
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Fail' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
    assert.equal(res.recoverable, false);
  });

  await t.test('HTTP 500 + readback equals next registry -> WRITE_UNCERTAIN & quarantined', async () => {
    const avatar = uniqueAvatar('Decision_500_Persisted');
    const owner = { kind: 'installed-card', avatar };

    let plannedUuid;
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: 'Server crash after write' }),
        };
      },
      () => ({
        ok: true,
        status: 200,
        json: async () =>
          createMockCard(avatar, {
            schemaVersion: 1,
            revision: 1,
            characters: [{ id: plannedUuid, name: 'Surprise', descriptor: '', aliases: [] }],
          }),
      }),
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Surprise' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(res.details?.persistedObserved, true);
  });
});

test('mutateCard - Two-Phase Cancellation & Unknown POST Outcomes', async (t) => {
  await t.test('pre-dispatch cancellation aborts cleanly with OPERATION_CANCELLED', async () => {
    const avatar = uniqueAvatar('Cancel_PreDispatch');
    const owner = { kind: 'installed-card', avatar };

    const abortController = new AbortController();
    abortController.abort();

    const mockFetch = createMockFetch([]);
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      signal: abortController.signal,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Never' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'OPERATION_CANCELLED');
    assert.equal(mockFetch.getCallCount(), 0);
  });

  await t.test('in-flight abort during POST triggers independent readback with fresh signal', async () => {
    const avatar = uniqueAvatar('Cancel_InFlight');
    const owner = { kind: 'installed-card', avatar };
    const userController = new AbortController();

    let readbackSignalAborted = null;

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      async () => {
        userController.abort();
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      },
      (url, options) => {
        readbackSignalAborted = options.signal?.aborted;
        return {
          ok: true,
          status: 200,
          json: async () => createMockCard(avatar, undefined),
        };
      },
    ]);

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      signal: userController.signal,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'AbortedPost' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(readbackSignalAborted, false, 'Readback MUST use a fresh signal, not the user aborted signal');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(res.details?.postOutcome, 'UNKNOWN');
  });

  await t.test('context drift after dispatch does not suppress independent persistence readback', async () => {
    const avatar = uniqueAvatar('Cancel_ContextDrift');
    const owner = { kind: 'installed-card', avatar };

    let readbackExecuted = false;
    let liveAvatar = avatar;
    let plannedUuid;

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      () => {
        readbackExecuted = true;
        liveAvatar = uniqueAvatar('NavigatedAway');
        return {
          ok: true,
          status: 200,
          json: async () =>
            createMockCard(avatar, {
              schemaVersion: 1,
              revision: 1,
              characters: [{ id: plannedUuid, name: 'Drift', descriptor: '', aliases: [] }],
            }),
        };
      },
    ]);

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      getContext: () => ({ avatar: liveAvatar, characterId: 0, chatId: 'chat_001' }),
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Drift' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(readbackExecuted, true, 'Readback probe must execute regardless of UI context drift');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STALE_CARD_LOCATOR');
    assert.equal(res.details?.persisted, true);
  });
});

test('mutateCard - Bounded Network Operations & Timeout Deadlines', async (t) => {
  await t.test('POST exceeding deadline triggers timeout, readback, and quarantine', async () => {
    const avatar = uniqueAvatar('Timeout_Post');
    const owner = { kind: 'installed-card', avatar };

    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { ok: true, status: 200, json: async () => ({}) };
      },
      { status: 200, body: createMockCard(avatar, undefined) },
    ]);

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      postTimeoutMs: 50,
      verifyTimeoutMs: 100,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'HangingPost' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(res.details?.postOutcome, 'UNKNOWN');
  });
});

test('mutateCard - Immutability, Privacy & Memory Safety', async (t) => {
  await t.test('leaves caller-owned input objects unmodified and unfrozen', async () => {
    const avatar = uniqueAvatar('Immutable_Inputs');
    const owner = { kind: 'installed-card', avatar };
    const cmd = { type: 'add', character: { name: 'FreeMe', aliases: ['F'] } };
    const exp = { status: 'UNINITIALIZED' };

    let plannedUuid;
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      () => ({
        ok: true,
        status: 200,
        json: async () =>
          createMockCard(avatar, {
            schemaVersion: 1,
            revision: 1,
            characters: [{ id: plannedUuid, name: 'FreeMe', descriptor: '', aliases: ['F'] }],
          }),
      }),
    ]);

    const deps = createValidDependencies({ avatar, fetch: mockFetch });

    const res = await mutateCard(owner, cmd, exp, deps);
    assert.equal(res.ok, true);

    assert.equal(Object.isFrozen(owner), false, 'owner must not be frozen');
    assert.equal(Object.isFrozen(cmd), false, 'cmd must not be frozen');
    assert.equal(Object.isFrozen(cmd.character), false, 'cmd.character must not be frozen');
    assert.equal(Object.isFrozen(cmd.character.aliases), false, 'aliases must not be frozen');

    assert.equal(Object.isFrozen(res.value), true);
    assert.equal(Object.isFrozen(res.value.characters), true);
    assert.equal(Object.isFrozen(res.value.characters[0]), true);
  });

  await t.test('never leaks headers or auth secrets in error messages or details', async () => {
    const avatar = uniqueAvatar('Privacy_LeakTest');
    const owner = { kind: 'installed-card', avatar };
    const secretToken = 'SECRET_BEARER_KEY_TOP_SECRET';

    const mockFetch = createMockFetch([
      { status: 500, body: { message: 'Internal server error' } },
      { status: 500, body: { message: 'Readback fail' } },
    ]);

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      getRequestHeaders: () => ({ Authorization: `Bearer ${secretToken}` }),
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Privacy' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(secretToken), false, 'Must never leak authorization secrets');
  });
});

test('mutateCard - H01-B2-R1 Regression Suite (Deadlines, Malformed Responses, Privacy)', async (t) => {
  await t.test('POST fetch never settles and ignores abort', async () => {
    const avatar = uniqueAvatar('R1_HangingFetch');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => new Promise(() => {}),
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      postTimeoutMs: 30,
      verifyTimeoutMs: 50,
    });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Hanging' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(res.details?.postOutcome, 'UNKNOWN');

    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Hanging2' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
  });

  await t.test('Verification read never settles and ignores abort', async () => {
    const avatar = uniqueAvatar('R1_HangingVerify');
    const owner = { kind: 'installed-card', avatar };
    let readCount = 0;
    const mockFetch = createMockFetch({
      '/api/characters/get': () => {
        readCount++;
        if (readCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => createMockCard(avatar, undefined),
          };
        }
        return new Promise(() => {});
      },
      '/api/characters/merge-attributes': () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      postTimeoutMs: 50,
      verifyTimeoutMs: 30,
    });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'HangingVerify' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');

    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Blocked' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
  });

  await t.test('A late HTTP 200 arrives after the POST deadline', async () => {
    const avatar = uniqueAvatar('R1_Late200');
    const owner = { kind: 'installed-card', avatar };
    let lateSettled = false;
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': async () => {
        await new Promise((r) => setTimeout(r, 80));
        lateSettled = true;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      postTimeoutMs: 25,
      verifyTimeoutMs: 40,
    });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Late200' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lateSettled, true);

    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'StillBlocked' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
  });

  await t.test('A late HTTP rejection arrives after the POST deadline', async () => {
    const avatar = uniqueAvatar('R1_Late500');
    const owner = { kind: 'installed-card', avatar };
    let lateSettled = false;
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': async () => {
        await new Promise((r) => setTimeout(r, 80));
        lateSettled = true;
        throw new Error('Late network error');
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      postTimeoutMs: 25,
      verifyTimeoutMs: 40,
    });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Late500' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lateSettled, true);

    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'StillBlocked' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
  });

  await t.test('POST fetch resolves null', async () => {
    const avatar = uniqueAvatar('R1_NullPost');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => null,
    });
    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Null' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');

    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'QuarantinedAfterNull' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
  });

  await t.test('POST fetch resolves undefined', async () => {
    const avatar = uniqueAvatar('R1_UndefPost');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => undefined,
    });
    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Undef' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');

    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'QuarantinedAfterUndef' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
  });

  await t.test('POST fetch resolves a malformed response object', async () => {
    const avatar = uniqueAvatar('R1_MalformedPost');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => ({ status: 'not-a-number' }),
    });
    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Malformed' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');

    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'QuarantinedAfterMalformed' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
  });

  await t.test('Editor safety returns { safe: false, secret: "PRIVATE_TOKEN" }', async () => {
    const avatar = uniqueAvatar('R1_PrivacyEditorResult');
    const owner = { kind: 'installed-card', avatar };
    const secretToken = 'SECRET_TOKEN_IN_EDITOR_RESULT_123';
    const deps = createValidDependencies({
      avatar,
      checkEditorSafety: () => ({ safe: false, secret: secretToken }),
    });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Sec' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
    assert.equal(res.details?.reason, 'EDITOR_UNSAFE');
    assert.equal(res.details?.status, undefined);
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(secretToken), false, 'Must not leak secret from editor result');
  });

  await t.test('Editor safety throws an exception containing a secret', async () => {
    const avatar = uniqueAvatar('R1_PrivacyEditorThrow');
    const owner = { kind: 'installed-card', avatar };
    const secretError = 'SECRET_INTERNAL_DB_PASSWORD_456';
    const deps = createValidDependencies({
      avatar,
      checkEditorSafety: () => {
        throw new Error(`Failed with ${secretError}`);
      },
    });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Sec2' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
    assert.equal(res.details?.reason, 'EDITOR_CHECK_THREW');
    assert.equal(res.details?.error, undefined);
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(secretError), false, 'Must not leak secret from thrown editor error');
  });

  await t.test('Header supplier throws before dispatch', async () => {
    const avatar = uniqueAvatar('R1_HeaderThrow');
    const owner = { kind: 'installed-card', avatar };
    const secretKey = 'SECRET_HEADER_KEY_789';
    let postAttempted = false;
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => {
        postAttempted = true;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });

    let headerCallCount = 0;
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      getRequestHeaders: () => {
        headerCallCount++;
        if (headerCallCount === 1) {
          return { 'X-CSRF-Token': 'ok-token' };
        }
        throw new Error(`Auth failed with ${secretKey}`);
      },
    });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'HeaderFail' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
    assert.equal(res.details?.reason, 'HEADERS_FAILED');
    assert.equal(postAttempted, false, 'Must not attempt POST when headers throw');
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(secretKey), false);
  });

  await t.test('Invalid timeout options cause zero write requests', async () => {
    const avatar = uniqueAvatar('R1_InvalidTimeouts');
    const owner = { kind: 'installed-card', avatar };
    let callsCount = 0;
    const mockFetch = () => { callsCount++; return {}; };

    const invalidCases = [
      { postTimeoutMs: -10 },
      { postTimeoutMs: 0 },
      { postTimeoutMs: 'fast' },
      { postTimeoutMs: NaN },
      { verifyTimeoutMs: -5 },
      { verifyTimeoutMs: 0 },
      { verifyTimeoutMs: 3.14 },
    ];

    for (const badOption of invalidCases) {
      const deps = createValidDependencies({
        avatar,
        fetch: mockFetch,
        ...badOption,
      });
      const res = await mutateCard(
        owner,
        { type: 'add', character: { name: 'BadTimeout' } },
        { status: 'UNINITIALIZED' },
        deps
      );
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_OPTIONS');
    }
    assert.equal(callsCount, 0, 'Zero network calls must be made on invalid timeout options');
  });

  await t.test('No duplicate POST or automatic retry is performed', async () => {
    const avatar = uniqueAvatar('R1_NoRetry');
    const owner = { kind: 'installed-card', avatar };
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: false, status: 500, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'RetryCheck' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res.ok, false);
    assert.equal(mergeCalls, 1, 'Exactly one POST must be attempted, zero retries');
  });
});
