/**
 * SillyTavern-ChromaticHub: Guarded Mutation Controller Tests (H01-B2-I / H01-B2-R1 / H01-B2-R2 / H01-B2-R3)
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
 * - H01-B2-R2: Fail-closed dependency boundaries & response normalization
 * - H01-B2-R3: Post-dispatch exception containment & fail-closed inspection
 * - H01-B2-F1: Bounded, cancellable preliminary read (deadline race, queue liveness)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import { mutateCard } from '../src/card-mutation-controller.mjs';

function countSignalEvents(signal) {
  return getEventListeners(signal, 'abort').length;
}

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

test('mutateCard - H01-B2-R2 Regression Suite (Fail-Closed Boundaries)', async (t) => {
  await t.test('POST response whose status getter throws', async () => {
    const avatar = uniqueAvatar('R2_StatusGetterThrow');
    const owner = { kind: 'installed-card', avatar };
    const secretErr = 'STATUS_GETTER_SECRET_111';
    let getCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/get': () => {
        getCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => createMockCard(avatar, undefined),
        };
      },
      '/api/characters/merge-attributes': () => ({
        get status() {
          throw new Error(`Explosion ${secretErr}`);
        },
        ok: true,
        json: async () => ({}),
      }),
    });

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'TrapChar' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(res.recoverable, false);
    assert.equal(res.details?.postOutcome, 'UNKNOWN');
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(secretErr), false, 'Must not leak exception secret');
    assert.equal(getCalls, 2, 'Must perform independent persistence verification readback');
  });

  await t.test('Second mutation after status getter throw failure is blocked by CARD_QUARANTINED', async () => {
    const avatar = uniqueAvatar('R2_QuarantineBlock');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => ({
        get status() {
          throw new Error('STATUS_EXPLODE');
        },
        ok: true,
        json: async () => ({}),
      }),
    });

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res1 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'FirstFail' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(res1.ok, false);
    assert.equal(res1.code, 'WRITE_UNCERTAIN');

    // Second mutation attempt on the same avatar
    let secondFetchCalls = 0;
    const mockFetch2 = () => {
      secondFetchCalls++;
      return {};
    };
    const deps2 = createValidDependencies({ avatar, fetch: mockFetch2 });
    const res2 = await mutateCard(
      owner,
      { type: 'add', character: { name: 'BlockedSecond' } },
      { status: 'UNINITIALIZED' },
      deps2
    );

    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'CARD_QUARANTINED');
    assert.equal(res2.recoverable, false);
    assert.equal(res2.details?.avatar, avatar);
    assert.equal(secondFetchCalls, 0, 'Blocked immediately without network requests');
  });

  await t.test('POST response with status: NaN', async () => {
    const avatar = uniqueAvatar('R2_StatusNaN');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => ({
        status: NaN,
        ok: false,
        json: async () => ({}),
      }),
    });

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'NaNChar' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(res.recoverable, false);
    assert.equal(res.details?.postOutcome, 'UNKNOWN');

    // Verify avatar quarantined
    const resBlocked = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Blocked' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(resBlocked.code, 'CARD_QUARANTINED');
  });

  await t.test('POST response with fractional status', async () => {
    const avatar = uniqueAvatar('R2_StatusFractional');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => ({
        status: 200.5,
        ok: true,
        json: async () => ({}),
      }),
    });

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'FractionalChar' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(res.recoverable, false);
    assert.equal(res.details?.postOutcome, 'UNKNOWN');

    // Verify quarantined
    const resBlocked = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Blocked' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(resBlocked.code, 'CARD_QUARANTINED');
  });

  await t.test('POST response with status: 200, ok: false', async () => {
    const avatar = uniqueAvatar('R2_Status200OkFalse');
    const owner = { kind: 'installed-card', avatar };
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => ({
        status: 200,
        ok: false,
        json: async () => ({}),
      }),
    });

    const deps = createValidDependencies({ avatar, fetch: mockFetch });
    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'InconsistentOk' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(res.recoverable, false);
    assert.equal(res.details?.postOutcome, 'UNKNOWN');

    // Verify quarantined
    const resBlocked = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Blocked' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    assert.equal(resBlocked.code, 'CARD_QUARANTINED');
  });

  await t.test('POST response with a missing or invalid ok property', async () => {
    const invalidCases = [
      { name: 'missing ok', resp: { status: 200 } },
      { name: 'string ok', resp: { status: 200, ok: 'true' } },
      { name: 'null ok', resp: { status: 200, ok: null } },
      { name: '500 with ok: true', resp: { status: 500, ok: true } },
      {
        name: 'throwing ok getter',
        resp: {
          status: 200,
          get ok() {
            throw new Error('OK_TRAP');
          },
        },
      },
    ];

    for (const testCase of invalidCases) {
      const avatar = uniqueAvatar('R2_InvalidOk');
      const owner = { kind: 'installed-card', avatar };
      const mockFetch = createMockFetch({
        '/api/characters/get': () => ({
          ok: true,
          status: 200,
          json: async () => createMockCard(avatar, undefined),
        }),
        '/api/characters/merge-attributes': () => ({
          ...testCase.resp,
          json: async () => ({}),
        }),
      });

      const deps = createValidDependencies({ avatar, fetch: mockFetch });
      const res = await mutateCard(
        owner,
        { type: 'add', character: { name: 'TestOk' } },
        { status: 'UNINITIALIZED' },
        deps
      );

      assert.equal(res.ok, false, `Failed for case: ${testCase.name}`);
      assert.equal(res.code, 'WRITE_UNCERTAIN', `Failed for case: ${testCase.name}`);
      assert.equal(res.recoverable, false);
      assert.equal(res.details?.postOutcome, 'UNKNOWN');

      // Verify quarantined
      const resBlocked = await mutateCard(
        owner,
        { type: 'add', character: { name: 'Blocked' } },
        { status: 'UNINITIALIZED' },
        deps
      );
      assert.equal(resBlocked.code, 'CARD_QUARANTINED');
    }
  });

  await t.test('Header object containing an enumerable getter that throws', async () => {
    const avatar = uniqueAvatar('R2_HeaderGetterThrow');
    const owner = { kind: 'installed-card', avatar };
    const secretToken = 'SECRET_HEADER_PROP_GETTER_999';
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(avatar, undefined),
      }),
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });

    let headerCalls = 0;
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      getRequestHeaders: () => {
        headerCalls++;
        if (headerCalls === 1) {
          // pre-read call
          return { 'X-CSRF-Token': 'ok-token' };
        }
        // pre-dispatch call: return object with throwing enumerable getter
        const headersObj = {};
        Object.defineProperty(headersObj, 'X-Trap-Header', {
          enumerable: true,
          get() {
            throw new Error(`Trap secret: ${secretToken}`);
          },
        });
        return headersObj;
      },
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'HeaderTrap' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_REJECTED');
    assert.equal(res.details?.reason, 'INVALID_HEADERS');
    assert.equal(mergeCalls, 0, 'Zero POST calls must be attempted');
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(secretToken), false, 'Must not leak secret from header getter');

    // Confirm avatar is NOT quarantined since failure occurred before POST dispatch
    const cleanDeps = createValidDependencies({
      avatar,
      fetch: createMockFetch({
        '/api/characters/get': () => ({
          ok: true,
          status: 200,
          json: async () => createMockCard(avatar, undefined),
        }),
      }),
    });
    const preflightRes = await mutateCard(
      owner,
      { type: 'add', character: { name: 'CleanCheck' } },
      { status: 'VALID' },
      cleanDeps
    );
    assert.notEqual(preflightRes.code, 'CARD_QUARANTINED', 'Avatar must not be quarantined');
  });

  await t.test('Context object containing a property getter that throws', async () => {
    // 8a. expectedContext property getter throws
    const avatarA = uniqueAvatar('R2_ExpCtxGetter');
    const ownerA = { kind: 'installed-card', avatar: avatarA };
    const secretA = 'SECRET_EXP_CTX_TRAP_111';
    let mergeCallsA = 0;
    const mockFetchA = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCallsA++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });

    const throwingExpContext = {
      avatar: avatarA,
      get groupId() {
        throw new Error(`Trap secret: ${secretA}`);
      },
    };

    const depsA = createValidDependencies({
      avatar: avatarA,
      fetch: mockFetchA,
      expectedContext: throwingExpContext,
    });

    const resA = await mutateCard(
      ownerA,
      { type: 'add', character: { name: 'ExpCtxTrap' } },
      { status: 'UNINITIALIZED' },
      depsA
    );

    assert.equal(resA.ok, false);
    assert.equal(resA.code, 'STALE_CARD_LOCATOR');
    assert.equal(resA.details?.reason, 'CONTEXT_EVALUATION_FAILED');
    assert.equal(mergeCallsA, 0, 'Zero POST calls made');
    assert.equal(JSON.stringify(resA).includes(secretA), false);

    // 8b. getContext() returned object property getter throws
    const avatarB = uniqueAvatar('R2_LiveCtxGetter');
    const ownerB = { kind: 'installed-card', avatar: avatarB };
    const secretB = 'SECRET_LIVE_CTX_TRAP_222';
    let mergeCallsB = 0;
    const mockFetchB = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCallsB++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });

    const depsB = createValidDependencies({
      avatar: avatarB,
      fetch: mockFetchB,
      getContext: () => ({
        avatar: avatarB,
        get groupId() {
          throw new Error(`Trap secret: ${secretB}`);
        },
      }),
    });

    const resB = await mutateCard(
      ownerB,
      { type: 'add', character: { name: 'LiveCtxTrap' } },
      { status: 'UNINITIALIZED' },
      depsB
    );

    assert.equal(resB.ok, false);
    assert.equal(resB.code, 'STALE_CARD_LOCATOR');
    assert.equal(resB.details?.reason, 'CONTEXT_EVALUATION_FAILED');
    assert.equal(mergeCallsB, 0, 'Zero POST calls made');
    assert.equal(JSON.stringify(resB).includes(secretB), false);
  });

  await t.test('Above-maximum timeout values rejected without network requests', async () => {
    const avatar = uniqueAvatar('R2_MaxTimeouts');
    const owner = { kind: 'installed-card', avatar };
    let callsCount = 0;
    const mockFetch = () => {
      callsCount++;
      return {};
    };

    const invalidCases = [
      { postTimeoutMs: 60001 },
      { postTimeoutMs: 100000 },
      { postTimeoutMs: Infinity },
      { verifyTimeoutMs: 30001 },
      { verifyTimeoutMs: 50000 },
      { verifyTimeoutMs: Infinity },
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
    assert.equal(callsCount, 0, 'Zero network calls must be made on above-maximum timeout values');
  });

  await t.test(
    'Normal native-compatible { status: 200, ok: true } remains accepted when independent readback matches',
    async () => {
      const avatar = uniqueAvatar('R2_NormalSuccess');
      const owner = { kind: 'installed-card', avatar };
      let postBody = null;
      let persistedRegistry = null;

      const mockFetch = createMockFetch({
        '/api/characters/get': () => {
          if (!persistedRegistry) {
            // Pre-read: uninitialized
            return {
              ok: true,
              status: 200,
              json: async () => createMockCard(avatar, undefined),
            };
          }
          // Verification readback: card with updated registry from POST
          return {
            ok: true,
            status: 200,
            json: async () => createMockCard(avatar, persistedRegistry),
          };
        },
        '/api/characters/merge-attributes': (_url, options) => {
          postBody = JSON.parse(options.body);
          persistedRegistry = postBody.data.extensions.chromaticHub;
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
          };
        },
      });

      const deps = createValidDependencies({ avatar, fetch: mockFetch });
      const res = await mutateCard(
        owner,
        { type: 'add', character: { name: 'StandardChar' } },
        { status: 'UNINITIALIZED' },
        deps
      );

      assert.equal(res.ok, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.value.revision, 1);
      assert.equal(res.value.characters.length, 1);
      assert.equal(res.value.characters[0].name, 'StandardChar');
      assert.ok(postBody);
      assert.equal(postBody.avatar, avatar);
      assert.equal(postBody.data.extensions.chromaticHub.revision, 1);

      // Verify avatar is NOT quarantined
      const cleanDeps = createValidDependencies({ avatar, fetch: mockFetch });
      const checkRes = await mutateCard(
        owner,
        { type: 'add', character: { name: 'Another' } },
        { status: 'UNINITIALIZED' },
        cleanDeps
      );
      assert.notEqual(checkRes.code, 'CARD_QUARANTINED', 'Avatar must not be quarantined after success');
    }
  );
});

test('mutateCard - Post-Dispatch Exception Containment & Invariant Boundary (H01-B2-R3)', async (t) => {
  await t.test('Readback status getter throws after HTTP 200 -> WRITE_UNCERTAIN & quarantine', async () => {
    const avatar = uniqueAvatar('R3_StatusThrows');
    const otherAvatar = uniqueAvatar('R3_OtherCard1');
    const secret = 'SUPER_SECRET_STATUS_ERROR_LEAK_TOKEN';
    const owner = { kind: 'installed-card', avatar };
    let postCalls = 0;

    let readCallCount = 0;
    const mockReadCard = async () => {
      readCallCount++;
      if (readCallCount === 1) {
        return { ok: true, status: 'UNINITIALIZED' };
      }
      return {
        get ok() {
          return true;
        },
        get status() {
          throw new Error(`Trap secret: ${secret}`);
        },
        value: { schemaVersion: 1, revision: 1, characters: [] },
      };
    };

    const mockFetch = async (url) => {
      if (url === '/api/characters/merge-attributes') {
        postCalls++;
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    };

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: mockReadCard,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'TrapChar' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    // 5. Each failure returns WRITE_UNCERTAIN, not a rejected Promise
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(postCalls, 1, 'Exactly 1 POST dispatch must have occurred');

    // 10. No raw exception messages or secrets appear in returned diagnostics
    assert.equal(JSON.stringify(res).includes(secret), false, 'Must not leak secret in diagnostics');

    // 6 & 7. A subsequent mutation on the same avatar returns CARD_QUARANTINED and performs zero POSTs
    let retryPostCalls = 0;
    const retryFetch = async () => {
      retryPostCalls++;
      return { status: 200, ok: true };
    };
    const retryDeps = createValidDependencies({ avatar, fetch: retryFetch });
    const retryRes = await mutateCard(
      owner,
      { type: 'add', character: { name: 'RetryAfterQuarantine' } },
      { status: 'UNINITIALIZED' },
      retryDeps
    );
    assert.equal(retryRes.ok, false);
    assert.equal(retryRes.code, 'CARD_QUARANTINED');
    assert.equal(retryPostCalls, 0, 'Quarantined avatar must result in zero POST calls');

    // 8. A different avatar remains writable
    let otherPostCalls = 0;
    let otherPersisted = null;
    const otherFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(otherAvatar, otherPersisted ?? undefined),
      }),
      '/api/characters/merge-attributes': (_url, options) => {
        otherPostCalls++;
        otherPersisted = JSON.parse(options.body).data.extensions.chromaticHub;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    const otherOwner = { kind: 'installed-card', avatar: otherAvatar };
    const otherDeps = createValidDependencies({ avatar: otherAvatar, fetch: otherFetch });
    const otherRes = await mutateCard(
      otherOwner,
      { type: 'add', character: { name: 'OtherChar' } },
      { status: 'UNINITIALIZED' },
      otherDeps
    );
    assert.equal(otherRes.ok, true);
    assert.equal(otherRes.status, 'VALID');
    assert.equal(otherPostCalls, 1);
  });

  await t.test('Readback value getter throws after HTTP 200 -> WRITE_UNCERTAIN & quarantine', async () => {
    const avatar = uniqueAvatar('R3_ValueThrows');
    const otherAvatar = uniqueAvatar('R3_OtherCard2');
    const secret = 'SUPER_SECRET_VALUE_ERROR_LEAK_TOKEN';
    const owner = { kind: 'installed-card', avatar };
    let postCalls = 0;

    let readCallCount = 0;
    const mockReadCard = async () => {
      readCallCount++;
      if (readCallCount === 1) {
        return { ok: true, status: 'UNINITIALIZED' };
      }
      return {
        ok: true,
        status: 'VALID',
        get value() {
          throw new Error(`Trap secret: ${secret}`);
        },
      };
    };

    const mockFetch = async (url) => {
      if (url === '/api/characters/merge-attributes') {
        postCalls++;
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    };

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: mockReadCard,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'TrapChar' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(postCalls, 1);
    assert.equal(JSON.stringify(res).includes(secret), false);

    // Verify quarantine
    const retryRes = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Retry' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({ avatar })
    );
    assert.equal(retryRes.ok, false);
    assert.equal(retryRes.code, 'CARD_QUARANTINED');

    // A different avatar remains writable
    let otherPostCalls = 0;
    let otherPersisted = null;
    const otherFetch = createMockFetch({
      '/api/characters/get': () => ({
        ok: true,
        status: 200,
        json: async () => createMockCard(otherAvatar, otherPersisted ?? undefined),
      }),
      '/api/characters/merge-attributes': (_url, options) => {
        otherPostCalls++;
        otherPersisted = JSON.parse(options.body).data.extensions.chromaticHub;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    const otherOwner = { kind: 'installed-card', avatar: otherAvatar };
    const otherDeps = createValidDependencies({ avatar: otherAvatar, fetch: otherFetch });
    const otherRes = await mutateCard(
      otherOwner,
      { type: 'add', character: { name: 'OtherChar' } },
      { status: 'UNINITIALIZED' },
      otherDeps
    );
    assert.equal(otherRes.ok, true);
    assert.equal(otherRes.status, 'VALID');
    assert.equal(otherPostCalls, 1);
  });

  await t.test('Readback nested snapshot property access throws -> WRITE_UNCERTAIN & quarantine', async () => {
    const avatar = uniqueAvatar('R3_NestedThrows');
    const secret = 'SUPER_SECRET_NESTED_ERROR_LEAK_TOKEN';
    const owner = { kind: 'installed-card', avatar };
    let postCalls = 0;

    let readCallCount = 0;
    const mockReadCard = async () => {
      readCallCount++;
      if (readCallCount === 1) {
        return { ok: true, status: 'UNINITIALIZED' };
      }
      return {
        ok: true,
        status: 'VALID',
        value: {
          schemaVersion: 1,
          get revision() {
            throw new Error(`Trap secret: ${secret}`);
          },
          characters: [],
        },
      };
    };

    const mockFetch = async (url) => {
      if (url === '/api/characters/merge-attributes') {
        postCalls++;
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    };

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: mockReadCard,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'TrapChar' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(postCalls, 1);
    assert.equal(JSON.stringify(res).includes(secret), false);

    // Verify quarantine
    const retryRes = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Retry' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({ avatar })
    );
    assert.equal(retryRes.ok, false);
    assert.equal(retryRes.code, 'CARD_QUARANTINED');
  });

  await t.test('Canonical comparison cannot complete -> WRITE_UNCERTAIN & quarantine', async () => {
    const avatar = uniqueAvatar('R3_CanonicalThrows');
    const secret = 'SUPER_SECRET_CANONICAL_ERROR_LEAK_TOKEN';
    const owner = { kind: 'installed-card', avatar };
    let postCalls = 0;

    let readCallCount = 0;
    const mockReadCard = async () => {
      readCallCount++;
      if (readCallCount === 1) {
        return { ok: true, status: 'UNINITIALIZED' };
      }
      return {
        ok: true,
        status: 'VALID',
        value: {
          schemaVersion: 1,
          revision: 1,
          characters: [
            {
              get id() {
                throw new Error(`Trap secret: ${secret}`);
              },
              name: 'TrapId',
            },
          ],
        },
      };
    };

    const mockFetch = async (url) => {
      if (url === '/api/characters/merge-attributes') {
        postCalls++;
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    };

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: mockReadCard,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'TrapChar' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(postCalls, 1);
    assert.equal(JSON.stringify(res).includes(secret), false);

    // Verify quarantine
    const retryRes = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Retry' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({ avatar })
    );
    assert.equal(retryRes.ok, false);
    assert.equal(retryRes.code, 'CARD_QUARANTINED');
  });

  await t.test('Readback ok getter throws after HTTP 200 -> WRITE_UNCERTAIN & quarantine', async () => {
    const avatar = uniqueAvatar('R3_OkThrows');
    const secret = 'SUPER_SECRET_OK_GETTER_ERROR_LEAK_TOKEN';
    const owner = { kind: 'installed-card', avatar };
    let postCalls = 0;

    let readCallCount = 0;
    const mockReadCard = async () => {
      readCallCount++;
      if (readCallCount === 1) {
        return { ok: true, status: 'UNINITIALIZED' };
      }
      return {
        get ok() {
          throw new Error(`Trap secret: ${secret}`);
        },
      };
    };

    const mockFetch = async (url) => {
      if (url === '/api/characters/merge-attributes') {
        postCalls++;
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    };

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: mockReadCard,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'TrapChar' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITE_UNCERTAIN');
    assert.equal(postCalls, 1);
    assert.equal(JSON.stringify(res).includes(secret), false);

    // Verify quarantine
    const retryRes = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Retry' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({ avatar })
    );
    assert.equal(retryRes.ok, false);
    assert.equal(retryRes.code, 'CARD_QUARANTINED');
  });

  await t.test(
    'Dependency property getters throw before dispatch resulting in zero POSTs and no quarantine',
    async () => {
      const avatar = uniqueAvatar('R3_DepThrows');
      const owner = { kind: 'installed-card', avatar };
      const secret = 'SUPER_SECRET_PRE_DISPATCH_LEAK_TOKEN';

      const testCases = [
        {
          name: 'getRequestHeaders getter throws',
          expectedCode: 'INVALID_DEPENDENCY',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'getRequestHeaders', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
        {
          name: 'checkEditorSafety getter throws',
          expectedCode: 'INVALID_DEPENDENCY',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'checkEditorSafety', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
        {
          name: 'getContext getter throws',
          expectedCode: 'INVALID_DEPENDENCY',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'getContext', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
        {
          name: 'expectedContext getter throws',
          expectedCode: 'INVALID_OPTIONS',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'expectedContext', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
        {
          name: 'fetch getter throws',
          expectedCode: 'INVALID_DEPENDENCY',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'fetch', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
        {
          name: 'readCard getter throws',
          expectedCode: 'INVALID_DEPENDENCY',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'readCard', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
        {
          name: 'signal getter throws',
          expectedCode: 'INVALID_OPTIONS',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'signal', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
        {
          name: 'postTimeoutMs getter throws',
          expectedCode: 'INVALID_OPTIONS',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'postTimeoutMs', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
        {
          name: 'verifyTimeoutMs getter throws',
          expectedCode: 'INVALID_OPTIONS',
          createDeps: () => {
            const base = createValidDependencies({ avatar });
            Object.defineProperty(base, 'verifyTimeoutMs', {
              get() {
                throw new Error(`Trap secret: ${secret}`);
              },
            });
            return base;
          },
        },
      ];

      for (const tc of testCases) {
        let postCalls = 0;
        const deps = tc.createDeps();
        let origFetch;
        try {
          origFetch = deps.fetch;
        } catch (_) {
          // If accessing deps.fetch was the throwing getter under test, do not wrap
        }
        if (typeof origFetch === 'function') {
          deps.fetch = async (...args) => {
            postCalls++;
            return origFetch(...args);
          };
        }

        const res = await mutateCard(
          owner,
          { type: 'add', character: { name: 'PreDispatchTest' } },
          { status: 'UNINITIALIZED' },
          deps
        );

        assert.equal(res.ok, false, `${tc.name} must return ok: false`);
        assert.equal(res.code, tc.expectedCode, `${tc.name} must return code ${tc.expectedCode}`);
        assert.equal(postCalls, 0, `${tc.name} must perform zero network calls`);
        assert.equal(JSON.stringify(res).includes(secret), false, `${tc.name} must not leak secret`);

        // Confirm avatar is NOT quarantined
        const cleanDeps = createValidDependencies({ avatar });
        const checkRes = await mutateCard(
          owner,
          { type: 'add', character: { name: 'CleanCheck' } },
          { status: 'UNINITIALIZED' },
          cleanDeps
        );
        assert.notEqual(
          checkRes.code,
          'CARD_QUARANTINED',
          `${tc.name} must not cause avatar to be quarantined`
        );
      }
    }
  );

  await t.test(
    'Unexpected exception after write dispatched returns WRITE_UNCERTAIN and establishes quarantine',
    async () => {
      const avatar = uniqueAvatar('R3_PostDispatchThrow');
      const secret = 'SUPER_SECRET_POST_DISPATCH_LEAK_TOKEN';
      const owner = { kind: 'installed-card', avatar };
      let postCalls = 0;

      const mockFetch = async (url) => {
        if (url === '/api/characters/merge-attributes') {
          postCalls++;
          return {
            get status() {
              throw new Error(`Trap secret: ${secret}`);
            },
            get ok() {
              throw new Error(`Trap secret: ${secret}`);
            },
          };
        }
        return { status: 200, ok: true, json: async () => ({}) };
      };

      const mockReadCard = async () => ({
        ok: true,
        status: 'UNINITIALIZED',
      });

      const deps = createValidDependencies({
        avatar,
        fetch: mockFetch,
        readCard: mockReadCard,
      });

      const res = await mutateCard(
        owner,
        { type: 'add', character: { name: 'TrapChar' } },
        { status: 'UNINITIALIZED' },
        deps
      );

      assert.equal(res.ok, false);
      assert.equal(res.code, 'WRITE_UNCERTAIN');
      assert.equal(postCalls, 1);
      assert.equal(JSON.stringify(res).includes(secret), false);

      // Verify avatar was quarantined
      const retryRes = await mutateCard(
        owner,
        { type: 'add', character: { name: 'Retry' } },
        { status: 'UNINITIALIZED' },
        createValidDependencies({ avatar })
      );
      assert.equal(retryRes.ok, false);
      assert.equal(retryRes.code, 'CARD_QUARANTINED');
    }
  );
});

test('mutateCard - H01-B2-F1 Bounded Preliminary Read', async (t) => {
  await t.test('permanently hanging reader ignoring abort -> READ_FAILED PRE_READ_TIMEOUT', async () => {
    const avatar = uniqueAvatar('F1_HangingPreRead');
    const owner = { kind: 'installed-card', avatar };
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: () => new Promise(() => {}),
      preReadTimeoutMs: 30,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'NeverSettles' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'READ_FAILED');
    assert.equal(res.recoverable, false);
    assert.equal(res.details?.reason, 'PRE_READ_TIMEOUT');
    assert.equal(mergeCalls, 0, 'Zero POSTs after pre-read deadline');
  });

  await t.test('reader rejecting before the deadline -> READ_FAILED PRE_READ_THROWN', async () => {
    const avatar = uniqueAvatar('F1_RejectingPreRead');
    const owner = { kind: 'installed-card', avatar };
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: async () => {
        throw new TypeError('Network failure');
      },
      preReadTimeoutMs: 5000,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Rejects' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'READ_FAILED');
    assert.equal(res.recoverable, false);
    assert.equal(res.details?.reason, 'PRE_READ_THROWN');
    assert.equal(mergeCalls, 0);
  });

  await t.test('reader throwing synchronously -> READ_FAILED PRE_READ_THROWN', async () => {
    const avatar = uniqueAvatar('F1_SyncThrowPreRead');
    const owner = { kind: 'installed-card', avatar };
    const secret = 'SECRET_SYNC_THROW_PRE_READ_123';
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: () => {
        throw new Error(`Explosion ${secret}`);
      },
      preReadTimeoutMs: 5000,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'SyncThrow' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'READ_FAILED');
    assert.equal(res.details?.reason, 'PRE_READ_THROWN');
    assert.equal(mergeCalls, 0);
    assert.equal(JSON.stringify(res).includes(secret), false, 'Must not leak reader exception details');
  });

  await t.test('reader settling an ordinary { ok: false } result preserves it unchanged', async () => {
    const avatar = uniqueAvatar('F1_OkFalsePreRead');
    const owner = { kind: 'installed-card', avatar };
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const ordinaryFailure = {
      ok: false,
      code: 'CARD_NOT_FOUND',
      message: 'Card not on server',
      recoverable: false,
      details: { status: 404, avatar },
    };
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: async () => ({ ...ordinaryFailure }),
      preReadTimeoutMs: 5000,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Missing' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'CARD_NOT_FOUND');
    assert.equal(res.recoverable, false);
    assert.equal(res.details?.status, 404);
    assert.equal(mergeCalls, 0);
  });

  await t.test('successful slow reader within the deadline completes the full mutation', async () => {
    const avatar = uniqueAvatar('F1_SlowReaderOk');
    const owner = { kind: 'installed-card', avatar };
    let plannedUuid = null;
    let readCallCount = 0;

    const mockFetch = createMockFetch([
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    ]);

    const injectedReadCard = async () => {
      readCallCount++;
      if (readCallCount === 1) {
        // Preliminary read: slow but within the deadline
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, status: 'UNINITIALIZED', avatar };
      }
      // Verification readback: reflect the persisted registry
      return {
        ok: true,
        status: 'VALID',
        avatar,
        value: {
          schemaVersion: 1,
          revision: 1,
          characters: [{ id: plannedUuid, name: 'Patient', descriptor: '', aliases: [] }],
        },
      };
    };

    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: injectedReadCard,
      preReadTimeoutMs: 5000,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Patient' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, true);
    assert.equal(res.status, 'VALID');
    assert.equal(res.value.revision, 1);
    assert.equal(res.value.characters[0].name, 'Patient');
    assert.equal(readCallCount, 2, 'Preliminary read + verification readback');
    assert.equal(mockFetch.getCallCount(), 1, 'Exactly one POST through fetch');
  });

  await t.test('caller cancellation while reader ignores abort settles promptly with OPERATION_CANCELLED', async () => {
    const avatar = uniqueAvatar('F1_CancelDuringPreRead');
    const owner = { kind: 'installed-card', avatar };
    const userController = new AbortController();
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: () => new Promise(() => {}),
      signal: userController.signal,
      preReadTimeoutMs: 30000,
    });

    const opPromise = mutateCard(
      owner,
      { type: 'add', character: { name: 'CancelledMidRead' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    setTimeout(() => userController.abort(), 15);

    const start = Date.now();
    const res = await opPromise;
    const elapsed = Date.now() - start;

    assert.equal(res.ok, false);
    assert.equal(res.code, 'OPERATION_CANCELLED');
    assert.equal(res.recoverable, false);
    assert.equal(mergeCalls, 0, 'Zero POSTs after cancellation');
    assert.ok(elapsed < 5000, `Cancellation must not wait for the deadline (took ${elapsed}ms)`);
  });

  await t.test('late reader settlement after the deadline never resumes the operation', async () => {
    const avatar = uniqueAvatar('F1_LateSettlement');
    const owner = { kind: 'installed-card', avatar };
    let mergeCalls = 0;
    let lateSettled = false;
    const mockFetch = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            lateSettled = true;
            resolve({ ok: true, status: 'UNINITIALIZED', avatar });
          }, 80);
        }),
      preReadTimeoutMs: 25,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'LateArrival' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'READ_FAILED');
    assert.equal(res.details?.reason, 'PRE_READ_TIMEOUT');
    assert.equal(mergeCalls, 0);

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lateSettled, true, 'Late settlement did occur');

    // A follow-up same-avatar mutation proves the queue was released and no resumption happened
    let followUpPosts = 0;
    let plannedUuid;
    const followUpFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      (url, options) => {
        followUpPosts++;
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
            characters: [{ id: plannedUuid, name: 'FollowUp', descriptor: '', aliases: [] }],
          }),
      }),
    ]);
    const followUpDeps = createValidDependencies({
      avatar,
      fetch: followUpFetch,
      preReadTimeoutMs: 5000,
    });
    const followUp = await mutateCard(
      owner,
      { type: 'add', character: { name: 'FollowUp' } },
      { status: 'UNINITIALIZED' },
      followUpDeps
    );

    assert.equal(followUp.ok, true, 'Same-avatar queue must be released after pre-read timeout');
    assert.equal(followUpPosts, 1);
    assert.equal(mergeCalls, 0, 'Original timed-out operation must never dispatch a POST');
  });

  await t.test('queue is released and follow-up succeeds after timeout and after rejection', async () => {
    const avatarTimeout = uniqueAvatar('F1_QueueRelease_Timeout');
    const avatarReject = uniqueAvatar('F1_QueueRelease_Reject');

    // Timeout variant
    const timeoutRes = await mutateCard(
      { kind: 'installed-card', avatar: avatarTimeout },
      { type: 'add', character: { name: 'A' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({
        avatar: avatarTimeout,
        readCard: () => new Promise(() => {}),
        preReadTimeoutMs: 25,
      })
    );
    assert.equal(timeoutRes.code, 'READ_FAILED');
    assert.equal(timeoutRes.details?.reason, 'PRE_READ_TIMEOUT');

    let followUpUuidTimeout = null;
    const followUpFetchTimeout = createMockFetch([
      { status: 200, body: createMockCard(avatarTimeout, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        followUpUuidTimeout = body.data.extensions.chromaticHub.characters[0].id;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      () => ({
        ok: true,
        status: 200,
        json: async () =>
          createMockCard(avatarTimeout, {
            schemaVersion: 1,
            revision: 1,
            characters: [{ id: followUpUuidTimeout, name: 'B', descriptor: '', aliases: [] }],
          }),
      }),
    ]);
    const okAfterTimeout = await mutateCard(
      { kind: 'installed-card', avatar: avatarTimeout },
      { type: 'add', character: { name: 'B' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({
        avatar: avatarTimeout,
        fetch: followUpFetchTimeout,
        preReadTimeoutMs: 5000,
      })
    );
    assert.equal(okAfterTimeout.ok, true, 'Queue must be released after pre-read timeout');

    // Rejection variant
    const rejectRes = await mutateCard(
      { kind: 'installed-card', avatar: avatarReject },
      { type: 'add', character: { name: 'A' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({
        avatar: avatarReject,
        readCard: async () => {
          throw new Error('boom');
        },
        preReadTimeoutMs: 5000,
      })
    );
    assert.equal(rejectRes.code, 'READ_FAILED');
    assert.equal(rejectRes.details?.reason, 'PRE_READ_THROWN');

    let followUpUuidReject = null;
    const followUpFetchReject = createMockFetch([
      { status: 200, body: createMockCard(avatarReject, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        followUpUuidReject = body.data.extensions.chromaticHub.characters[0].id;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      () => ({
        ok: true,
        status: 200,
        json: async () =>
          createMockCard(avatarReject, {
            schemaVersion: 1,
            revision: 1,
            characters: [{ id: followUpUuidReject, name: 'B', descriptor: '', aliases: [] }],
          }),
      }),
    ]);
    const okAfterReject = await mutateCard(
      { kind: 'installed-card', avatar: avatarReject },
      { type: 'add', character: { name: 'B' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({
        avatar: avatarReject,
        fetch: followUpFetchReject,
        preReadTimeoutMs: 5000,
      })
    );
    assert.equal(okAfterReject.ok, true, 'Queue must be released after a rejecting reader');
  });

  await t.test('different-avatar mutation proceeds while another avatar pre-read hangs', async () => {
    const avatarA = uniqueAvatar('F1_Hanging_A');
    const avatarB = uniqueAvatar('F1_Fast_B');
    const ownerB = { kind: 'installed-card', avatar: avatarB };

    let plannedUuid;
    const mockFetchB = createMockFetch([
      { status: 200, body: createMockCard(avatarB, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      () => ({
        ok: true,
        status: 200,
        json: async () =>
          createMockCard(avatarB, {
            schemaVersion: 1,
            revision: 1,
            characters: [{ id: plannedUuid, name: 'Fast', descriptor: '', aliases: [] }],
          }),
      }),
    ]);

    const hangingOp = mutateCard(
      { kind: 'installed-card', avatar: avatarA },
      { type: 'add', character: { name: 'Hangs' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({
        avatar: avatarA,
        readCard: () => new Promise(() => {}),
        preReadTimeoutMs: 300,
      })
    );

    const fastRes = await mutateCard(
      ownerB,
      { type: 'add', character: { name: 'Fast' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({ avatar: avatarB, fetch: mockFetchB, preReadTimeoutMs: 5000 })
    );

    assert.equal(fastRes.ok, true, 'A different avatar must not be blocked by a hanging pre-read');

    const hangingRes = await hangingOp;
    assert.equal(hangingRes.ok, false);
    assert.equal(hangingRes.code, 'READ_FAILED');
    assert.equal(hangingRes.details?.reason, 'PRE_READ_TIMEOUT');
  });

  await t.test('invalid preReadTimeoutMs values rejected with zero network calls', async () => {
    const avatar = uniqueAvatar('F1_InvalidPreReadTimeout');
    const owner = { kind: 'installed-card', avatar };
    let callsCount = 0;
    const mockFetch = () => {
      callsCount++;
      return {};
    };

    const invalidCases = [
      { preReadTimeoutMs: -10 },
      { preReadTimeoutMs: 0 },
      { preReadTimeoutMs: 'fast' },
      { preReadTimeoutMs: NaN },
      { preReadTimeoutMs: 3.14 },
      { preReadTimeoutMs: 30001 },
      { preReadTimeoutMs: Infinity },
      { preReadTimeoutMs: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const badOption of invalidCases) {
      const deps = createValidDependencies({
        avatar,
        fetch: mockFetch,
        ...badOption,
      });
      const res = await mutateCard(
        owner,
        { type: 'add', character: { name: 'BadPreReadTimeout' } },
        { status: 'UNINITIALIZED' },
        deps
      );
      assert.equal(res.ok, false, `Must reject ${JSON.stringify(badOption)}`);
      assert.equal(res.code, 'INVALID_OPTIONS');
    }
    assert.equal(callsCount, 0, 'Zero network calls must be made on invalid preReadTimeoutMs');
  });

  await t.test('deterministic listener cleanup on success, timeout, and cancellation', async () => {
    const avatarSuccess = uniqueAvatar('F1_Cleanup_Ok');
    const avatarTimeout = uniqueAvatar('F1_Cleanup_Timeout');
    const avatarCancel = uniqueAvatar('F1_Cleanup_Cancel');

    // Case 1: successful read path cleans up the user-signal listener
    const controllerSuccess = new AbortController();
    const successRes = await mutateCard(
      { kind: 'installed-card', avatar: avatarSuccess },
      { type: 'add', character: { name: 'CleanupOk' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({
        avatar: avatarSuccess,
        readCard: async () => ({ ok: true, status: 'UNINITIALIZED', avatar: avatarSuccess }),
        signal: controllerSuccess.signal,
        preReadTimeoutMs: 5000,
      })
    );
    assert.equal(successRes.ok, false); // expected: expectedSnapshot mismatch downstream
    assert.notEqual(successRes.code, 'CARD_QUARANTINED');
    assert.equal(countSignalEvents(controllerSuccess.signal), 0, 'Success path must leave zero listeners');

    // Case 2: timeout path cleans up the user-signal listener
    const controllerTimeout = new AbortController();
    const timeoutRes = await mutateCard(
      { kind: 'installed-card', avatar: avatarTimeout },
      { type: 'add', character: { name: 'CleanupTimeout' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({
        avatar: avatarTimeout,
        readCard: () => new Promise(() => {}),
        signal: controllerTimeout.signal,
        preReadTimeoutMs: 20,
      })
    );
    assert.equal(timeoutRes.code, 'READ_FAILED');
    assert.equal(timeoutRes.details?.reason, 'PRE_READ_TIMEOUT');
    assert.equal(countSignalEvents(controllerTimeout.signal), 0, 'Timeout path must leave zero listeners');

    // Case 3: cancellation path cleans up the user-signal listener
    const controllerCancel = new AbortController();
    const cancelOp = mutateCard(
      { kind: 'installed-card', avatar: avatarCancel },
      { type: 'add', character: { name: 'CleanupCancel' } },
      { status: 'UNINITIALIZED' },
      createValidDependencies({
        avatar: avatarCancel,
        readCard: () => new Promise(() => {}),
        signal: controllerCancel.signal,
        preReadTimeoutMs: 30000,
      })
    );
    setTimeout(() => controllerCancel.abort(), 10);
    const cancelRes = await cancelOp;
    assert.equal(cancelRes.code, 'OPERATION_CANCELLED');
    assert.equal(countSignalEvents(controllerCancel.signal), 0, 'Cancellation path must leave zero listeners');
  });

  await t.test('pre-read deadline never fires on a default fast path (regression)', async () => {
    const avatar = uniqueAvatar('F1_DefaultFastPath');
    const owner = { kind: 'installed-card', avatar };
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
            characters: [{ id: plannedUuid, name: 'Default', descriptor: '', aliases: [] }],
          }),
      }),
    ]);
    const deps = createValidDependencies({ avatar, fetch: mockFetch });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Default' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, true);
    assert.equal(res.status, 'VALID');
    assert.equal(mockFetch.getCallCount(), 3);
  });

  await t.test('near-simultaneous completion and cancellation prefers cancellation', async () => {
    const avatar = uniqueAvatar('F1_NearSimultaneous');
    const owner = { kind: 'installed-card', avatar };
    const userController = new AbortController();
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: async () => {
        userController.abort();
        return { ok: true, status: 'UNINITIALIZED', avatar };
      },
      signal: userController.signal,
      preReadTimeoutMs: 5000,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'PhotoFinish' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'OPERATION_CANCELLED');
    assert.equal(mergeCalls, 0, 'Zero POSTs when cancellation coincides with completion');
  });

  await t.test('reader aborted by user signal rejects -> OPERATION_CANCELLED not READ_FAILED', async () => {
    const avatar = uniqueAvatar('F1_ReaderRejectsOnAbort');
    const owner = { kind: 'installed-card', avatar };
    const userController = new AbortController();
    let mergeCalls = 0;
    const mockFetch = createMockFetch({
      '/api/characters/merge-attributes': () => {
        mergeCalls++;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      readCard: async (targetOwner, opts) => {
        await new Promise((r) => setTimeout(r, 20));
        if (opts.signal?.aborted) {
          const err = new Error('The user aborted a request.');
          err.name = 'AbortError';
          throw err;
        }
        return { ok: true, status: 'UNINITIALIZED', avatar };
      },
      signal: userController.signal,
      preReadTimeoutMs: 30000,
    });

    const opPromise = mutateCard(
      owner,
      { type: 'add', character: { name: 'AbortsReader' } },
      { status: 'UNINITIALIZED' },
      deps
    );
    setTimeout(() => userController.abort(), 5);

    const res = await opPromise;

    assert.equal(res.ok, false);
    assert.equal(res.code, 'OPERATION_CANCELLED');
    assert.equal(mergeCalls, 0);
  });

  await t.test('POST and readback behavior unchanged after a bounded successful pre-read', async () => {
    const avatar = uniqueAvatar('F1_UnchangedWireBehavior');
    const owner = { kind: 'installed-card', avatar };
    let plannedUuid;
    let readbackSignalAborted = null;
    const mockFetch = createMockFetch([
      { status: 200, body: createMockCard(avatar, undefined) },
      (url, options) => {
        const body = JSON.parse(options.body);
        plannedUuid = body.data.extensions.chromaticHub.characters[0].id;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      (url, options) => {
        readbackSignalAborted = options.signal?.aborted;
        return {
          ok: true,
          status: 200,
          json: async () =>
            createMockCard(avatar, {
              schemaVersion: 1,
              revision: 1,
              characters: [{ id: plannedUuid, name: 'Unchanged', descriptor: '', aliases: [] }],
            }),
        };
      },
    ]);
    const deps = createValidDependencies({
      avatar,
      fetch: mockFetch,
      preReadTimeoutMs: 5000,
    });

    const res = await mutateCard(
      owner,
      { type: 'add', character: { name: 'Unchanged' } },
      { status: 'UNINITIALIZED' },
      deps
    );

    assert.equal(res.ok, true);
    assert.equal(res.status, 'VALID');
    assert.equal(res.value.characters[0].name, 'Unchanged');
    assert.equal(readbackSignalAborted, false, 'Readback must keep using a fresh, unaborted signal');
    assert.equal(mockFetch.getCallCount(), 3);
  });
});
