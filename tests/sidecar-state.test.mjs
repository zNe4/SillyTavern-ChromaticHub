import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSidecarState,
  validateEvidence,
  classifyAssociations,
  resolveSidecarIdentity,
  planCreateSidecar,
  planMutateSidecar,
  planRebindSidecar,
  planCloneSidecar,
  serializeSidecarState,
  SIDECAR_ERROR_CODES,
} from '../src/sidecar-state.mjs';

// --- Test Fixtures & Helpers ---

const VALID_CARD_ID_1 = '028923e8-f23a-45c0-84a0-1a68b0dff234';
const VALID_CARD_ID_2 = '11111111-2222-4333-8444-555555555555';
const VALID_CARD_ID_3 = '99999999-8888-4777-8666-555555555555';

const VALID_IDENTITY_ID_1 = '4d15ae22-565c-4d19-9e6c-6d7653940cfa';
const VALID_IDENTITY_ID_2 = '64be5fd4-6900-4ed7-9844-2692c684c984';

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

function createValidCharacter(id = VALID_IDENTITY_ID_1, name = 'Hina', descriptor = 'Knight', aliases = []) {
  return {
    aliases,
    descriptor,
    id,
    name,
  };
}

function createValidRegistry(characters = [], revision = 0) {
  return {
    characters,
    revision,
    schemaVersion: 1,
  };
}

function createValidState(overrides = {}) {
  const cardId = overrides.cardId !== undefined ? overrides.cardId : VALID_CARD_ID_1;
  const avatar = overrides.avatar !== undefined ? overrides.avatar : 'Example_Character.png';
  const storageRevision = overrides.storageRevision !== undefined ? overrides.storageRevision : 1;
  const registry = overrides.registry !== undefined ? overrides.registry : createValidRegistry();

  return {
    avatar,
    cardId,
    registry,
    schemaVersion: overrides.schemaVersion !== undefined ? overrides.schemaVersion : 1,
    storageRevision,
  };
}

function createValidEvidence(files = [], claims = [], scanStatus = 'COMPLETE') {
  return {
    claims,
    files,
    scanStatus,
    schemaVersion: 1,
  };
}

// --- Suite 1: parseSidecarState ---

describe('parseSidecarState', () => {
  it('parses valid minimal 5-key state into a deeply frozen snapshot', () => {
    const raw = createValidState();
    const res = parseSidecarState(raw);
    assert.equal(res.ok, true);
    assert.equal(res.value.schemaVersion, 1);
    assert.equal(res.value.cardId, VALID_CARD_ID_1);
    assert.equal(res.value.avatar, 'Example_Character.png');
    assert.equal(res.value.storageRevision, 1);
    assert.equal(res.value.registry.revision, 0);
    assert.equal(Object.isFrozen(res.value), true);
    assert.equal(Object.isFrozen(res.value.registry), true);
    assert.equal(Object.isFrozen(res.value.registry.characters), true);
  });

  it('rejects missing any of the 5 required keys', () => {
    const keys = ['avatar', 'cardId', 'registry', 'schemaVersion', 'storageRevision'];
    for (const key of keys) {
      const state = createValidState();
      delete state[key];
      const res = parseSidecarState(state);
      assert.equal(res.ok, false);
      assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
    }
  });

  it('rejects unexpected extra own keys (strict 5-key shape)', () => {
    const state = createValidState();
    state.extraKey = 'unexpected';
    const res = parseSidecarState(state);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
  });

  it('rejects symbol-keyed properties on state object', () => {
    const sym = Symbol('secret');
    const state = createValidState();
    state[sym] = 'hidden';
    const res = parseSidecarState(state);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
  });

  it('rejects prototype keys (__proto__, constructor, prototype)', () => {
    const p1 = JSON.parse('{"schemaVersion":1,"cardId":"' + VALID_CARD_ID_1 + '","avatar":"a.png","storageRevision":1,"registry":{"schemaVersion":1,"revision":0,"characters":[]},"__proto__":{}}');
    assert.equal(parseSidecarState(p1).ok, false);

    const state2 = createValidState();
    state2.constructor = () => {};
    assert.equal(parseSidecarState(state2).ok, false);
  });

  it('rejects extra non-enumerable properties on state object (G4-R1 probe)', () => {
    const state = createValidState();
    Object.defineProperty(state, 'hidden', { value: 'x', enumerable: false, configurable: true });
    const res = parseSidecarState(state);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
  });

  it('rejects non-enumerable allowed properties on state object', () => {
    const state = createValidState();
    Object.defineProperty(state, 'cardId', { value: VALID_CARD_ID_1, enumerable: false, configurable: true });
    const res = parseSidecarState(state);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
  });

  it('rejects accessor properties (getters/setters) on state object', () => {
    const state = createValidState();
    delete state.avatar;
    Object.defineProperty(state, 'avatar', {
      get() { return 'Example_Character.png'; },
      enumerable: true,
      configurable: true,
    });
    const res = parseSidecarState(state);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
  });

  it('fails closed without unhandled exception on throwing getters (G4-R1)', () => {
    const state = createValidState();
    delete state.avatar;
    Object.defineProperty(state, 'avatar', {
      get() { throw new Error('hostile getter trap'); },
      enumerable: true,
      configurable: true,
    });
    const res = parseSidecarState(state);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
  });

  it('fails closed without unhandled exception on hostile proxy traps (G4-R1)', () => {
    const state = createValidState();
    const proxyProto = new Proxy(state, {
      getPrototypeOf() { throw new Error('hostile proto trap'); },
    });
    const res1 = parseSidecarState(proxyProto);
    assert.equal(res1.ok, false);
    assert.equal(res1.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);

    const proxyOwnKeys = new Proxy(state, {
      ownKeys() { throw new Error('hostile ownKeys trap'); },
    });
    const res2 = parseSidecarState(proxyOwnKeys);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);

    const proxyDesc = new Proxy(state, {
      getOwnPropertyDescriptor() { throw new Error('hostile desc trap'); },
    });
    const res3 = parseSidecarState(proxyDesc);
    assert.equal(res3.ok, false);
    assert.equal(res3.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
  });

  it('rejects schemaVersion !== 1 with UNSUPPORTED_VERSION', () => {
    const state = createValidState({ schemaVersion: 2 });
    state.schemaVersion = 2;
    const res = parseSidecarState(state);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.UNSUPPORTED_VERSION);
    assert.equal(res.details.foundVersion, 2);
  });

  it('rejects invalid cardId format with INVALID_CARD_ID', () => {
    const invalidIds = [
      'not-a-uuid',
      '028923E8-F23A-45C0-84A0-1A68B0DFF234', // uppercase forbidden
      '028923e8-f23a-15c0-84a0-1a68b0dff234', // v1 instead of v4
      12345,
      '',
    ];
    for (const badId of invalidIds) {
      const state = createValidState({ cardId: badId });
      const res = parseSidecarState(state);
      assert.equal(res.ok, false);
      assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_CARD_ID);
    }
  });

  it('validates expectedCardId option: matches or reports CARD_ID_MISMATCH', () => {
    const state = createValidState({ cardId: VALID_CARD_ID_1 });

    // Omitted options or empty options
    assert.equal(parseSidecarState(state).ok, true);
    assert.equal(parseSidecarState(state, {}).ok, true);

    // Exact match
    const matchRes = parseSidecarState(state, { expectedCardId: VALID_CARD_ID_1 });
    assert.equal(matchRes.ok, true);

    // Mismatch
    const mismatchRes = parseSidecarState(state, { expectedCardId: VALID_CARD_ID_2 });
    assert.equal(mismatchRes.ok, false);
    assert.equal(mismatchRes.code, SIDECAR_ERROR_CODES.CARD_ID_MISMATCH);
    assert.equal(mismatchRes.details.expectedCardId, VALID_CARD_ID_2);
    assert.equal(mismatchRes.details.foundCardId, VALID_CARD_ID_1);
  });

  it('rejects invalid expectedCardId and options shapes (G4-R2 Finding B)', () => {
    const state = createValidState({ cardId: VALID_CARD_ID_1 });

    // Non-string or invalid format expectedCardId
    const badValues = [
      12345,
      null,
      undefined,
      '',
      'not-a-uuid',
      '028923E8-F23A-45C0-84A0-1A68B0DFF234', // uppercase
      '028923e8-f23a-15c0-84a0-1a68b0dff234', // v1 UUID
    ];
    for (const val of badValues) {
      const res = parseSidecarState(state, { expectedCardId: val });
      assert.equal(res.ok, false);
      assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_CARD_ID);
    }

    // Accessor expectedCardId option
    const accessorOpt = {};
    Object.defineProperty(accessorOpt, 'expectedCardId', {
      get() { return VALID_CARD_ID_1; },
      enumerable: true,
      configurable: true,
    });
    const resAccessor = parseSidecarState(state, accessorOpt);
    assert.equal(resAccessor.ok, false);
    assert.equal(resAccessor.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);

    // Throwing getter option
    const throwingOpt = {};
    Object.defineProperty(throwingOpt, 'expectedCardId', {
      get() { throw new Error('getter bomb'); },
      enumerable: true,
      configurable: true,
    });
    const resThrowing = parseSidecarState(state, throwingOpt);
    assert.equal(resThrowing.ok, false);
    assert.equal(resThrowing.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);

    // Unknown options property
    const resUnknown = parseSidecarState(state, { unexpected: true });
    assert.equal(resUnknown.ok, false);
    assert.equal(resUnknown.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);

    // Non-object options
    assert.equal(parseSidecarState(state, 'not-an-object').ok, false);
    assert.equal(parseSidecarState(state, 12345).ok, false);
    assert.equal(parseSidecarState(state, null).ok, false);
  });

  it('does not reflect unvalidated option keys into diagnostics (G4-R3)', () => {
    const state = createValidState({ cardId: VALID_CARD_ID_1 });

    // 1. Secret-looking marker never appears in returned message or serialized object
    const secretMarker = 'UNTRUSTED_RAW_FIELD_TOKEN_SECRET_123';
    const resSecret = parseSidecarState(state, { [secretMarker]: true });
    assert.equal(resSecret.ok, false);
    assert.equal(resSecret.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
    assert.equal(resSecret.message, 'Unknown option property');
    assert.equal(resSecret.message.includes(secretMarker), false);
    assert.equal(JSON.stringify(resSecret).includes(secretMarker), false);

    // 2. Very long malicious option property yields bounded-length diagnostic without reflection
    const longMarker = 'A'.repeat(5000);
    const resLong = parseSidecarState(state, { [longMarker]: true });
    assert.equal(resLong.ok, false);
    assert.equal(resLong.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
    assert.equal(resLong.message, 'Unknown option property');
    assert.equal(resLong.message.includes(longMarker), false);
    assert.ok(resLong.message.length <= 100);
    assert.equal(JSON.stringify(resLong).includes(longMarker), false);

    // 3. Unvalidated state property name also never reflected in diagnostic
    const secretStateKey = 'UNTRUSTED_STATE_KEY_SECRET_456';
    const stateWithUnknown = createValidState();
    stateWithUnknown[secretStateKey] = 'unexpected';
    const resState = parseSidecarState(stateWithUnknown);
    assert.equal(resState.ok, false);
    assert.equal(resState.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
    assert.equal(resState.message.includes(secretStateKey), false);
    assert.equal(JSON.stringify(resState).includes(secretStateKey), false);
  });

  it('rejects non-positive or non-safe-integer storageRevision', () => {
    const invalidRevs = [0, -1, 1.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 10];
    for (const rev of invalidRevs) {
      const state = createValidState({ storageRevision: rev });
      const res = parseSidecarState(state);
      assert.equal(res.ok, false);
      assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_SCHEMA);
    }
  });

  it('validates avatar: rejects path traversal, separators, control chars, non-png, relative stems', () => {
    const badAvatars = [
      '../card.png',
      '/var/card.png',
      'card\\sub.png',
      'card.jpg',
      'card.PNG2',
      '.png',
      '..png',
      '   .png',
      'card\x00.png',
      'card\x1f.png',
      '',
      123,
    ];
    for (const badAvatar of badAvatars) {
      const state = createValidState({ avatar: badAvatar });
      const res = parseSidecarState(state);
      assert.equal(res.ok, false);
      assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);
    }
  });

  it('preserves exact-case and Unicode avatar filenames', () => {
    const unicodeAvatar = 'Char_日本語_✨.png';
    const state = createValidState({ avatar: unicodeAvatar });
    const res = parseSidecarState(state);
    assert.equal(res.ok, true);
    assert.equal(res.value.avatar, unicodeAvatar);
  });

  it('enforces 255-byte UTF-8 cap on avatar filename (G4-R2 Finding C)', () => {
    // 251 ASCII chars + '.png' = 255 bytes -> valid
    const valid255 = 'a'.repeat(251) + '.png';
    const res255 = parseSidecarState(createValidState({ avatar: valid255 }));
    assert.equal(res255.ok, true);

    // 252 ASCII chars + '.png' = 256 bytes -> invalid
    const invalid256 = 'a'.repeat(252) + '.png';
    const res256 = parseSidecarState(createValidState({ avatar: invalid256 }));
    assert.equal(res256.ok, false);
    assert.equal(res256.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);

    // Multibyte UTF-8 boundary:
    // '日' is 3 bytes in UTF-8
    // 83 * 3 = 249 bytes + 'ab' (2 bytes) + '.png' (4 bytes) = 255 bytes -> valid
    const validUtf8_255 = '日'.repeat(83) + 'ab.png';
    assert.equal(parseSidecarState(createValidState({ avatar: validUtf8_255 })).ok, true);

    // 83 * 3 = 249 bytes + 'abc' (3 bytes) + '.png' (4 bytes) = 256 bytes -> invalid
    const invalidUtf8_256 = '日'.repeat(83) + 'abc.png';
    const resUtf8_256 = parseSidecarState(createValidState({ avatar: invalidUtf8_256 }));
    assert.equal(resUtf8_256.ok, false);
    assert.equal(resUtf8_256.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);

    // 84 * 3 = 252 bytes + '.png' (4 bytes) = 256 bytes -> invalid
    const invalidUtf8_84 = '日'.repeat(84) + '.png';
    assert.equal(parseSidecarState(createValidState({ avatar: invalidUtf8_84 })).ok, false);

    // 304-byte ASCII probe from review
    const ascii304 = 'a'.repeat(300) + '.png';
    assert.equal(parseSidecarState(createValidState({ avatar: ascii304 })).ok, false);
  });

  it('enforces inner registry <= 256 KiB and outer sidecar state <= 300 KiB', () => {
    const bigName = 'A'.repeat(160);
    const bigDesc = 'D'.repeat(512);
    const chars = [];
    // 128 characters with max sizes fits inside limits
    for (let i = 0; i < 128; i++) {
      chars.push(createValidCharacter(
        `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        bigName,
        bigDesc,
        ['Alias1', 'Alias2']
      ));
    }
    const state = createValidState({ registry: createValidRegistry(chars, 1) });
    const res = parseSidecarState(state);
    assert.equal(res.ok, true);
  });
});

// --- Suite 2: validateEvidence & Binding Amendment B ---

describe('validateEvidence & Binding Amendment B', () => {
  it('validates clean complete synthetic evidence', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const res = validateEvidence(ev);
    assert.equal(res.ok, true);
    assert.equal(res.value.scanStatus, 'COMPLETE');
    assert.equal(res.value.files.length, 1);
    assert.equal(res.value.claims.length, 1);
    assert.equal(Object.isFrozen(res.value), true);
  });

  it('Amendment B Regression: rejects duplicate EXISTS observations for same avatar', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [
        { avatar: state.avatar, status: 'EXISTS' },
        { avatar: state.avatar, status: 'EXISTS' },
      ],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const res = validateEvidence(ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('Amendment B Regression: rejects duplicate MISSING observations for same avatar', () => {
    const ev = createValidEvidence(
      [
        { avatar: 'Old.png', status: 'MISSING' },
        { avatar: 'Old.png', status: 'MISSING' },
      ],
      []
    );
    const res = validateEvidence(ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('Amendment B Regression: rejects contradictory EXISTS/MISSING observations for same avatar', () => {
    const ev = createValidEvidence(
      [
        { avatar: 'Card.png', status: 'EXISTS' },
        { avatar: 'Card.png', status: 'MISSING' },
      ],
      []
    );
    const res = validateEvidence(ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('Amendment B Regression: rejects claim referencing an avatar absent from files observations', () => {
    const state = createValidState({ avatar: 'Unobserved.png' });
    const ev = createValidEvidence(
      [{ avatar: 'Other.png', status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const res = validateEvidence(ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('rejects claim with incoherent cardId or avatar versus claim.state', () => {
    const state = createValidState({ avatar: 'CardA.png', cardId: VALID_CARD_ID_1 });
    const evIncoherentId = createValidEvidence(
      [{ avatar: 'CardA.png', status: 'EXISTS' }],
      [{ avatar: 'CardA.png', cardId: VALID_CARD_ID_2, state }]
    );
    assert.equal(validateEvidence(evIncoherentId).ok, false);

    const evIncoherentAvatar = createValidEvidence(
      [{ avatar: 'CardB.png', status: 'EXISTS' }],
      [{ avatar: 'CardB.png', cardId: VALID_CARD_ID_1, state }]
    );
    assert.equal(validateEvidence(evIncoherentAvatar).ok, false);
  });

  it('rejects duplicate cardId claims across claims array (same or different avatar)', () => {
    const state1 = createValidState({ avatar: 'CardA.png', cardId: VALID_CARD_ID_1 });
    const state2 = createValidState({ avatar: 'CardB.png', cardId: VALID_CARD_ID_1 });
    const ev = createValidEvidence(
      [
        { avatar: 'CardA.png', status: 'EXISTS' },
        { avatar: 'CardB.png', status: 'EXISTS' },
      ],
      [
        { avatar: 'CardA.png', cardId: VALID_CARD_ID_1, state: state1 },
        { avatar: 'CardB.png', cardId: VALID_CARD_ID_1, state: state2 },
      ]
    );
    const res = validateEvidence(ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('rejects extra non-enumerable properties on evidence envelope (G4-R1 probe)', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    Object.defineProperty(ev, 'hidden', { value: 'x', enumerable: false, configurable: true });
    const res = validateEvidence(ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('rejects accessor properties on evidence envelope (G4-R1)', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const files = ev.files;
    delete ev.files;
    Object.defineProperty(ev, 'files', {
      get() { return files; },
      enumerable: true,
      configurable: true,
    });
    const res = validateEvidence(ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('rejects extra non-enumerable properties on file and claim entries (G4-R1)', () => {
    const state = createValidState();
    const fileEntry = { avatar: state.avatar, status: 'EXISTS' };
    Object.defineProperty(fileEntry, 'hidden', { value: 'extra', enumerable: false, configurable: true });
    const ev1 = createValidEvidence([fileEntry], [{ avatar: state.avatar, cardId: state.cardId, state }]);
    const res1 = validateEvidence(ev1);
    assert.equal(res1.ok, false);
    assert.equal(res1.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);

    const claimEntry = { avatar: state.avatar, cardId: state.cardId, state };
    Object.defineProperty(claimEntry, 'hidden', { value: 'extra', enumerable: false, configurable: true });
    const ev2 = createValidEvidence([{ avatar: state.avatar, status: 'EXISTS' }], [claimEntry]);
    const res2 = validateEvidence(ev2);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('rejects accessor properties on file and claim entries (G4-R1)', () => {
    const state = createValidState();
    const fileEntry = { avatar: state.avatar };
    Object.defineProperty(fileEntry, 'status', {
      get() { return 'EXISTS'; },
      enumerable: true,
      configurable: true,
    });
    const ev1 = createValidEvidence([fileEntry], [{ avatar: state.avatar, cardId: state.cardId, state }]);
    const res1 = validateEvidence(ev1);
    assert.equal(res1.ok, false);
    assert.equal(res1.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);

    const claimEntry = { avatar: state.avatar, cardId: state.cardId };
    Object.defineProperty(claimEntry, 'state', {
      get() { return state; },
      enumerable: true,
      configurable: true,
    });
    const ev2 = createValidEvidence([{ avatar: state.avatar, status: 'EXISTS' }], [claimEntry]);
    const res2 = validateEvidence(ev2);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });

  it('fails closed without unhandled exception on hostile proxy evidence (G4-R1)', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const proxyEv = new Proxy(ev, {
      getPrototypeOf() { throw new Error('hostile proto trap in evidence'); },
    });
    const res1 = validateEvidence(proxyEv);
    assert.equal(res1.ok, false);
    assert.equal(res1.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);

    const res2 = classifyAssociations('Example_Character.png', proxyEv);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);

    const res3 = planCreateSidecar('Example_Character.png', proxyEv);
    assert.equal(res3.ok, false);
    assert.equal(res3.code, SIDECAR_ERROR_CODES.INVALID_EVIDENCE);
  });
});

// --- Suite 3: classifyAssociations & Orphan Semantics ---

describe('classifyAssociations & Orphan Semantics', () => {
  it('classifies BOUND when target exists and has exactly one valid claim', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const res = classifyAssociations(state.avatar, ev);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'BOUND');
    assert.equal(res.cardId, state.cardId);
    assert.deepEqual(res.state, state);
  });

  it('classifies UNBOUND when target exists and has zero claims', () => {
    const ev = createValidEvidence(
      [{ avatar: 'Unclaimed.png', status: 'EXISTS' }],
      []
    );
    const res = classifyAssociations('Unclaimed.png', ev);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'UNBOUND');
    assert.equal(res.recoveryAvailable, false);
  });

  it('reports recoveryAvailable: true when unrelated valid orphan claims exist', () => {
    const orphanState = createValidState({ avatar: 'OldMissing.png', cardId: VALID_CARD_ID_1 });
    const ev = createValidEvidence(
      [
        { avatar: 'Target.png', status: 'EXISTS' },
        { avatar: 'OldMissing.png', status: 'MISSING' },
      ],
      [{ avatar: 'OldMissing.png', cardId: orphanState.cardId, state: orphanState }]
    );
    const res = classifyAssociations('Target.png', ev);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'UNBOUND');
    assert.equal(res.recoveryAvailable, true);
  });

  it('returns ok: false, code: ASSOCIATION_CONFLICT when multiple claims claim the same avatar', () => {
    const state1 = createValidState({ avatar: 'Shared.png', cardId: VALID_CARD_ID_1 });
    const state2 = createValidState({ avatar: 'Shared.png', cardId: VALID_CARD_ID_2 });
    const ev = createValidEvidence(
      [{ avatar: 'Shared.png', status: 'EXISTS' }],
      [
        { avatar: 'Shared.png', cardId: VALID_CARD_ID_1, state: state1 },
        { avatar: 'Shared.png', cardId: VALID_CARD_ID_2, state: state2 },
      ]
    );
    const res = classifyAssociations('Shared.png', ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);
  });

  it('returns ok: false, code: STORAGE_UNAVAILABLE when scanStatus is INCOMPLETE', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }],
      'INCOMPLETE'
    );
    const res = classifyAssociations(state.avatar, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.STORAGE_UNAVAILABLE);
  });

  it('returns ok: false, code: CARD_NOT_FOUND when avatar is not in files or status is MISSING', () => {
    const ev = createValidEvidence(
      [{ avatar: 'Missing.png', status: 'MISSING' }],
      []
    );
    const resMissing = classifyAssociations('Missing.png', ev);
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.code, SIDECAR_ERROR_CODES.CARD_NOT_FOUND);

    const resUnobserved = classifyAssociations('NotObserved.png', ev);
    assert.equal(resUnobserved.ok, false);
    assert.equal(resUnobserved.code, SIDECAR_ERROR_CODES.CARD_NOT_FOUND);
  });
});

// --- Suite 4: resolveSidecarIdentity ---

describe('resolveSidecarIdentity', () => {
  it('resolves existing character identity from valid state', () => {
    const char = createValidCharacter(VALID_IDENTITY_ID_1, 'Hina');
    const state = createValidState({ registry: createValidRegistry([char], 1) });
    const res = resolveSidecarIdentity(state, VALID_IDENTITY_ID_1);
    assert.equal(res.ok, true);
    assert.equal(res.value.name, 'Hina');
    assert.equal(res.value.id, VALID_IDENTITY_ID_1);
    assert.equal(Object.isFrozen(res.value), true);
  });

  it('returns IDENTITY_NOT_FOUND for non-existent identity ID', () => {
    const state = createValidState();
    const res = resolveSidecarIdentity(state, VALID_IDENTITY_ID_2);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.IDENTITY_NOT_FOUND);
  });
});

// --- Suite 5: planCreateSidecar ---

describe('planCreateSidecar', () => {
  it('plans creation for unbound installed card with storageRevision=1, registry.revision=0', () => {
    const ev = createValidEvidence([{ avatar: 'NewHero.png', status: 'EXISTS' }], []);
    const res = planCreateSidecar('NewHero.png', ev, { generateCardId: () => VALID_CARD_ID_1 });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.nextState.avatar, 'NewHero.png');
    assert.equal(res.nextState.cardId, VALID_CARD_ID_1);
    assert.equal(res.nextState.storageRevision, 1);
    assert.equal(res.nextState.registry.revision, 0);
    assert.deepEqual(res.nextState.registry.characters, []);
    assert.equal(Object.isFrozen(res.nextState), true);
  });

  it('rejects creation when avatar is already bound', () => {
    const existingState = createValidState({ avatar: 'Hero.png' });
    const ev = createValidEvidence(
      [{ avatar: 'Hero.png', status: 'EXISTS' }],
      [{ avatar: 'Hero.png', cardId: existingState.cardId, state: existingState }]
    );
    const res = planCreateSidecar('Hero.png', ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ALREADY_BOUND);
  });

  it('rejects creation with ASSOCIATION_CONFLICT when target avatar has multiple claims (G4-R2 Finding A)', () => {
    const s1 = createValidState({ avatar: 'Hero.png', cardId: VALID_CARD_ID_1 });
    const s2 = createValidState({ avatar: 'Hero.png', cardId: VALID_CARD_ID_2 });
    const ev = createValidEvidence(
      [{ avatar: 'Hero.png', status: 'EXISTS' }],
      [
        { avatar: 'Hero.png', cardId: VALID_CARD_ID_1, state: s1 },
        { avatar: 'Hero.png', cardId: VALID_CARD_ID_2, state: s2 },
      ]
    );
    const res = planCreateSidecar('Hero.png', ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);
  });

  it('rejects creation when target avatar is missing on disk', () => {
    const ev = createValidEvidence([{ avatar: 'Hero.png', status: 'MISSING' }], []);
    const res = planCreateSidecar('Hero.png', ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR);
  });

  it('Collision Guard: rejects creation if generated cardId collides with existing claim (including orphan)', () => {
    const orphanState = createValidState({ avatar: 'Old.png', cardId: VALID_CARD_ID_1 });
    const ev = createValidEvidence(
      [
        { avatar: 'New.png', status: 'EXISTS' },
        { avatar: 'Old.png', status: 'MISSING' },
      ],
      [{ avatar: 'Old.png', cardId: VALID_CARD_ID_1, state: orphanState }]
    );
    const res = planCreateSidecar('New.png', ev, { generateCardId: () => VALID_CARD_ID_1 });
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ID_GENERATION_FAILED);
  });

  it('Amendment B: unrelated valid orphan does not block ordinary create', () => {
    const orphanState = createValidState({ avatar: 'Old.png', cardId: VALID_CARD_ID_1 });
    const ev = createValidEvidence(
      [
        { avatar: 'New.png', status: 'EXISTS' },
        { avatar: 'Old.png', status: 'MISSING' },
      ],
      [{ avatar: 'Old.png', cardId: VALID_CARD_ID_1, state: orphanState }]
    );
    const res = planCreateSidecar('New.png', ev, { generateCardId: () => VALID_CARD_ID_2 });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.nextState.cardId, VALID_CARD_ID_2);
  });
});

// --- Suite 6: planMutateSidecar & Binding Amendment A ---

describe('planMutateSidecar & Binding Amendment A', () => {
  it('Amendment A: exact canonical match permits mutation; increments both revisions', () => {
    const state = createValidState({ storageRevision: 3 });
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const cmd = {
      type: 'add',
      character: { name: 'Hina', descriptor: 'Knight' },
    };
    const res = planMutateSidecar(state, state.cardId, state.avatar, 3, 0, cmd, ev);
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.nextState.storageRevision, 4);
    assert.equal(res.nextState.registry.revision, 1);
    assert.equal(res.nextState.registry.characters.length, 1);
  });

  it('Amendment A: stale caller state at storageRevision 4 vs evidence claim at 5 -> rejects with REVISION_CONFLICT', () => {
    const callerState = createValidState({ storageRevision: 4 });
    const claimState = createValidState({ storageRevision: 5 });
    const ev = createValidEvidence(
      [{ avatar: callerState.avatar, status: 'EXISTS' }],
      [{ avatar: callerState.avatar, cardId: callerState.cardId, state: claimState }]
    );
    const cmd = { type: 'add', character: { name: 'Hina' } };
    const res = planMutateSidecar(callerState, callerState.cardId, callerState.avatar, 4, 0, cmd, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.REVISION_CONFLICT);
  });

  it('Amendment A: caller state and claim have equal revisions but different registry contents -> rejects with REVISION_CONFLICT', () => {
    const char = createValidCharacter(VALID_IDENTITY_ID_1, 'OldName');
    const callerState = createValidState({ storageRevision: 2, registry: createValidRegistry([], 1) });
    const claimState = createValidState({ storageRevision: 2, registry: createValidRegistry([char], 1) });

    const ev = createValidEvidence(
      [{ avatar: callerState.avatar, status: 'EXISTS' }],
      [{ avatar: callerState.avatar, cardId: callerState.cardId, state: claimState }]
    );
    const cmd = { type: 'add', character: { name: 'NewChar' } };
    const res = planMutateSidecar(callerState, callerState.cardId, callerState.avatar, 2, 1, cmd, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.REVISION_CONFLICT);
  });

  it('Amendment A: caller state and claim have equal revisions but different non-revision fields -> rejects with REVISION_CONFLICT', () => {
    const callerState = createValidState({ avatar: 'CharA.png', storageRevision: 1 });
    const claimState = createValidState({ avatar: 'CharB.png', storageRevision: 1 });

    const ev = createValidEvidence(
      [{ avatar: 'CharB.png', status: 'EXISTS' }],
      [{ avatar: 'CharB.png', cardId: callerState.cardId, state: claimState }]
    );
    const cmd = { type: 'add', character: { name: 'Hina' } };
    const res = planMutateSidecar(callerState, callerState.cardId, 'CharA.png', 1, 0, cmd, ev);
    assert.equal(res.ok, false);
    // Discrepancy caught by avatar match or canonical compare
  });

  it('Exact No-Op: identical update command returns changed: false and bumps neither revision', () => {
    const char = createValidCharacter(VALID_IDENTITY_ID_1, 'Hina', 'Knight', ['H']);
    const state = createValidState({
      storageRevision: 5,
      registry: createValidRegistry([char], 2),
    });
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );

    const noOpCmd = {
      type: 'update',
      character: { id: VALID_IDENTITY_ID_1, name: 'Hina', descriptor: 'Knight', aliases: ['H'] },
    };
    const res = planMutateSidecar(state, state.cardId, state.avatar, 5, 2, noOpCmd, ev);
    assert.equal(res.ok, true);
    assert.equal(res.changed, false);
    assert.equal(res.nextState.storageRevision, 5);
    assert.equal(res.nextState.registry.revision, 2);
  });

  it('rejects mutation with ASSOCIATION_CONFLICT when source avatar has multiple claims (including no-op) (G4-R2 Finding A)', () => {
    const s1 = createValidState({ avatar: 'Hero.png', cardId: VALID_CARD_ID_1 });
    const s2 = createValidState({ avatar: 'Hero.png', cardId: VALID_CARD_ID_2 });
    const ev = createValidEvidence(
      [{ avatar: 'Hero.png', status: 'EXISTS' }],
      [
        { avatar: 'Hero.png', cardId: VALID_CARD_ID_1, state: s1 },
        { avatar: 'Hero.png', cardId: VALID_CARD_ID_2, state: s2 },
      ]
    );

    // Genuine mutation blocked
    const addCmd = { type: 'add', character: { name: 'NewChar' } };
    const resMutate = planMutateSidecar(s1, s1.cardId, s1.avatar, 1, 0, addCmd, ev);
    assert.equal(resMutate.ok, false);
    assert.equal(resMutate.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);

    // Exact no-op blocked
    const noOpCmd = { type: 'update', character: { id: VALID_IDENTITY_ID_1, name: 'None' } };
    const resNoOp = planMutateSidecar(s1, s1.cardId, s1.avatar, 1, 0, noOpCmd, ev);
    assert.equal(resNoOp.ok, false);
    assert.equal(resNoOp.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);
  });

  it('Amendment A: stale state requesting an otherwise valid no-op is rejected', () => {
    const char = createValidCharacter(VALID_IDENTITY_ID_1, 'Hina');
    const callerState = createValidState({ storageRevision: 4, registry: createValidRegistry([char], 1) });
    const claimState = createValidState({ storageRevision: 5, registry: createValidRegistry([char], 1) });

    const ev = createValidEvidence(
      [{ avatar: callerState.avatar, status: 'EXISTS' }],
      [{ avatar: callerState.avatar, cardId: callerState.cardId, state: claimState }]
    );
    const noOpCmd = { type: 'update', character: { id: VALID_IDENTITY_ID_1, name: 'Hina' } };
    const res = planMutateSidecar(callerState, callerState.cardId, callerState.avatar, 4, 1, noOpCmd, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.REVISION_CONFLICT);
  });

  it('Amendment A: inputs remain unchanged and unfrozen after all failed checks', () => {
    const callerState = createValidState({ storageRevision: 4 });
    const claimState = createValidState({ storageRevision: 5 });
    const ev = createValidEvidence(
      [{ avatar: callerState.avatar, status: 'EXISTS' }],
      [{ avatar: callerState.avatar, cardId: callerState.cardId, state: claimState }]
    );
    const cmd = { type: 'add', character: { name: 'Hina' } };
    const originalStateSnapshot = JSON.parse(JSON.stringify(callerState));

    const res = planMutateSidecar(callerState, callerState.cardId, callerState.avatar, 4, 0, cmd, ev);
    assert.equal(res.ok, false);
    assert.deepEqual(callerState, originalStateSnapshot);
  });

  it('Dual CAS: rejects when expectedStorageRevision or expectedRegistryRevision mismatches', () => {
    const state = createValidState({ storageRevision: 2, registry: createValidRegistry([], 3) });
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const cmd = { type: 'add', character: { name: 'Hina' } };

    // Wrong storage revision
    assert.equal(planMutateSidecar(state, state.cardId, state.avatar, 1, 3, cmd, ev).code, SIDECAR_ERROR_CODES.REVISION_CONFLICT);
    // Wrong registry revision
    assert.equal(planMutateSidecar(state, state.cardId, state.avatar, 2, 2, cmd, ev).code, SIDECAR_ERROR_CODES.REVISION_CONFLICT);
  });

  it('Owner Guard: rejects caller cardId or avatar mismatch', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const cmd = { type: 'add', character: { name: 'Hina' } };

    assert.equal(planMutateSidecar(state, VALID_CARD_ID_2, state.avatar, 1, 0, cmd, ev).code, SIDECAR_ERROR_CODES.CARD_ID_MISMATCH);
    assert.equal(planMutateSidecar(state, state.cardId, 'Other.png', 1, 0, cmd, ev).code, SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR);
  });

  it('Safe integer overflow: rejects mutate when storageRevision reaches MAX_SAFE_INTEGER', () => {
    const state = createValidState({ storageRevision: Number.MAX_SAFE_INTEGER });
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const cmd = { type: 'add', character: { name: 'Hina' } };
    const res = planMutateSidecar(state, state.cardId, state.avatar, Number.MAX_SAFE_INTEGER, 0, cmd, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.REVISION_OVERFLOW);
  });
});

// --- Suite 7: planRebindSidecar & Amendments A and B ---

describe('planRebindSidecar & Amendments A and B', () => {
  it('Amendment B & Orphan Rebind: valid orphan with old MISSING and target EXISTS plans rebind', () => {
    const orphanState = createValidState({
      avatar: 'OldAvatar.png',
      cardId: VALID_CARD_ID_1,
      storageRevision: 3,
      registry: createValidRegistry([createValidCharacter()], 1),
    });
    const ev = createValidEvidence(
      [
        { avatar: 'OldAvatar.png', status: 'MISSING' },
        { avatar: 'NewAvatar.png', status: 'EXISTS' },
      ],
      [{ avatar: 'OldAvatar.png', cardId: VALID_CARD_ID_1, state: orphanState }]
    );

    const res = planRebindSidecar(orphanState, VALID_CARD_ID_1, 'OldAvatar.png', 'NewAvatar.png', 3, ev);
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.nextState.avatar, 'NewAvatar.png');
    assert.equal(res.nextState.cardId, VALID_CARD_ID_1);
    assert.equal(res.nextState.storageRevision, 4); // bumped
    assert.equal(res.nextState.registry.revision, 1); // inner revision unchanged
    assert.equal(res.nextState.registry.characters.length, 1); // characters preserved byte-for-byte
  });

  it('Amendment A: state mismatch during rebind is rejected with REVISION_CONFLICT', () => {
    const callerState = createValidState({ avatar: 'Old.png', storageRevision: 3 });
    const claimState = createValidState({ avatar: 'Old.png', storageRevision: 4 });
    const ev = createValidEvidence(
      [
        { avatar: 'Old.png', status: 'MISSING' },
        { avatar: 'New.png', status: 'EXISTS' },
      ],
      [{ avatar: 'Old.png', cardId: callerState.cardId, state: claimState }]
    );
    const res = planRebindSidecar(callerState, callerState.cardId, 'Old.png', 'New.png', 3, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.REVISION_CONFLICT);
  });

  it('DUPLICATE_NOT_RENAME Refusal: if both old and new avatars exist on disk, rebind fails', () => {
    const state = createValidState({ avatar: 'OldAvatar.png' });
    const ev = createValidEvidence(
      [
        { avatar: 'OldAvatar.png', status: 'EXISTS' },
        { avatar: 'NewAvatar.png', status: 'EXISTS' },
      ],
      [{ avatar: 'OldAvatar.png', cardId: state.cardId, state }]
    );
    const res = planRebindSidecar(state, state.cardId, 'OldAvatar.png', 'NewAvatar.png', 1, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.DUPLICATE_NOT_RENAME);
  });

  it('Amendment B: rebind lacks explicit old-avatar MISSING observation -> rejects', () => {
    const state = createValidState({ avatar: 'OldAvatar.png' });
    const ev = createValidEvidence(
      [{ avatar: 'NewAvatar.png', status: 'EXISTS' }], // old unobserved
      []
    );
    const res = planRebindSidecar(state, state.cardId, 'OldAvatar.png', 'NewAvatar.png', 1, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR);
  });

  it('Amendment B: rebind lacks explicit target-avatar EXISTS observation -> rejects', () => {
    const state = createValidState({ avatar: 'OldAvatar.png' });
    const ev = createValidEvidence(
      [{ avatar: 'OldAvatar.png', status: 'MISSING' }], // target unobserved
      [{ avatar: 'OldAvatar.png', cardId: state.cardId, state }]
    );
    const res = planRebindSidecar(state, state.cardId, 'OldAvatar.png', 'NewAvatar.png', 1, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR);
  });

  it('Coherent No-Op: fromAvatar === toAvatar permitted only if card exists on disk and is bound', () => {
    const state = createValidState({ avatar: 'Hero.png', storageRevision: 2 });
    const ev = createValidEvidence(
      [{ avatar: 'Hero.png', status: 'EXISTS' }],
      [{ avatar: 'Hero.png', cardId: state.cardId, state }]
    );
    const res = planRebindSidecar(state, state.cardId, 'Hero.png', 'Hero.png', 2, ev);
    assert.equal(res.ok, true);
    assert.equal(res.changed, false);
    assert.equal(res.nextState.storageRevision, 2);

    // If avatar is MISSING on disk, coherent no-op cannot be fabricated
    const evMissing = createValidEvidence(
      [{ avatar: 'Hero.png', status: 'MISSING' }],
      [{ avatar: 'Hero.png', cardId: state.cardId, state }]
    );
    const resMissing = planRebindSidecar(state, state.cardId, 'Hero.png', 'Hero.png', 2, evMissing);
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.code, SIDECAR_ERROR_CODES.STALE_CARD_LOCATOR);
  });

  it('rejects rebind with ASSOCIATION_CONFLICT when fromAvatar has multiple claims (G4-R2 Finding A)', () => {
    const s1 = createValidState({ avatar: 'Old.png', cardId: VALID_CARD_ID_1 });
    const s2 = createValidState({ avatar: 'Old.png', cardId: VALID_CARD_ID_2 });
    const ev = createValidEvidence(
      [
        { avatar: 'Old.png', status: 'MISSING' },
        { avatar: 'New.png', status: 'EXISTS' },
      ],
      [
        { avatar: 'Old.png', cardId: VALID_CARD_ID_1, state: s1 },
        { avatar: 'Old.png', cardId: VALID_CARD_ID_2, state: s2 },
      ]
    );
    const res = planRebindSidecar(s1, s1.cardId, 'Old.png', 'New.png', 1, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);
  });

  it('rejects rebind with ASSOCIATION_CONFLICT when toAvatar has multiple claims (G4-R2 Finding A)', () => {
    const sSource = createValidState({ avatar: 'Old.png', cardId: VALID_CARD_ID_1 });
    const sTarget1 = createValidState({ avatar: 'New.png', cardId: VALID_CARD_ID_2 });
    const sTarget2 = createValidState({ avatar: 'New.png', cardId: VALID_CARD_ID_3 });
    const ev = createValidEvidence(
      [
        { avatar: 'Old.png', status: 'MISSING' },
        { avatar: 'New.png', status: 'EXISTS' },
      ],
      [
        { avatar: 'Old.png', cardId: VALID_CARD_ID_1, state: sSource },
        { avatar: 'New.png', cardId: VALID_CARD_ID_2, state: sTarget1 },
        { avatar: 'New.png', cardId: VALID_CARD_ID_3, state: sTarget2 },
      ]
    );
    const res = planRebindSidecar(sSource, sSource.cardId, 'Old.png', 'New.png', 1, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);
  });
});

// --- Suite 8: planCloneSidecar & Source Freeze Retention ---

describe('planCloneSidecar & Source Freeze Retention', () => {
  it('clones valid source to target avatar; preserves inner revision, character UUIDs, sets storageRevision=1', () => {
    const char = createValidCharacter(VALID_IDENTITY_ID_1, 'Hina');
    const sourceState = createValidState({
      avatar: 'Source.png',
      cardId: VALID_CARD_ID_1,
      storageRevision: 7,
      registry: createValidRegistry([char], 3),
    });
    deepFreeze(sourceState);

    const ev = createValidEvidence(
      [
        { avatar: 'Source.png', status: 'EXISTS' },
        { avatar: 'Target.png', status: 'EXISTS' },
      ],
      [{ avatar: 'Source.png', cardId: VALID_CARD_ID_1, state: sourceState }]
    );

    const res = planCloneSidecar(
      sourceState,
      VALID_CARD_ID_1,
      'Source.png',
      'Target.png',
      7,
      ev,
      { generateCardId: () => VALID_CARD_ID_2 }
    );

    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.nextState.avatar, 'Target.png');
    assert.equal(res.nextState.cardId, VALID_CARD_ID_2);
    assert.equal(res.nextState.storageRevision, 1); // target starts at 1
    assert.equal(res.nextState.registry.revision, 3); // inner revision preserved
    assert.equal(res.nextState.registry.characters[0].id, VALID_IDENTITY_ID_1); // ID preserved
    assert.equal(res.nextState.registry.characters[0].name, 'Hina');

    // Canonical serialized inner-registry equality
    const serializeRegistryHelper = (reg) => JSON.stringify(reg);
    assert.deepEqual(res.nextState.registry, sourceState.registry);

    // Source state remains completely untouched and retains its prior freeze state
    assert.equal(Object.isFrozen(sourceState), true);
    assert.equal(sourceState.storageRevision, 7);
    assert.equal(sourceState.avatar, 'Source.png');
  });

  it('Amendment A: state mismatch during clone is rejected with REVISION_CONFLICT', () => {
    const callerSource = createValidState({ avatar: 'Source.png', storageRevision: 2 });
    const claimSource = createValidState({ avatar: 'Source.png', storageRevision: 3 });

    const ev = createValidEvidence(
      [
        { avatar: 'Source.png', status: 'EXISTS' },
        { avatar: 'Target.png', status: 'EXISTS' },
      ],
      [{ avatar: 'Source.png', cardId: callerSource.cardId, state: claimSource }]
    );

    const res = planCloneSidecar(callerSource, callerSource.cardId, 'Source.png', 'Target.png', 2, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.REVISION_CONFLICT);
  });

  it('Collision Guard: clone rejects if generated target cardId collides with existing claim', () => {
    const sourceState = createValidState({ avatar: 'Source.png', cardId: VALID_CARD_ID_1 });
    const ev = createValidEvidence(
      [
        { avatar: 'Source.png', status: 'EXISTS' },
        { avatar: 'Target.png', status: 'EXISTS' },
      ],
      [{ avatar: 'Source.png', cardId: VALID_CARD_ID_1, state: sourceState }]
    );

    const res = planCloneSidecar(
      sourceState,
      VALID_CARD_ID_1,
      'Source.png',
      'Target.png',
      1,
      ev,
      { generateCardId: () => VALID_CARD_ID_1 } // Collides with source
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ID_GENERATION_FAILED);
  });

  it('rejects clone if target avatar is already bound', () => {
    const sourceState = createValidState({ avatar: 'Source.png', cardId: VALID_CARD_ID_1 });
    const targetState = createValidState({ avatar: 'Target.png', cardId: VALID_CARD_ID_2 });
    const ev = createValidEvidence(
      [
        { avatar: 'Source.png', status: 'EXISTS' },
        { avatar: 'Target.png', status: 'EXISTS' },
      ],
      [
        { avatar: 'Source.png', cardId: VALID_CARD_ID_1, state: sourceState },
        { avatar: 'Target.png', cardId: VALID_CARD_ID_2, state: targetState },
      ]
    );

    const res = planCloneSidecar(sourceState, VALID_CARD_ID_1, 'Source.png', 'Target.png', 1, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ALREADY_BOUND);
  });

  it('rejects clone with ASSOCIATION_CONFLICT when source avatar has multiple claims (G4-R2 Finding A)', () => {
    const s1 = createValidState({ avatar: 'Source.png', cardId: VALID_CARD_ID_1 });
    const s2 = createValidState({ avatar: 'Source.png', cardId: VALID_CARD_ID_2 });
    const ev = createValidEvidence(
      [
        { avatar: 'Source.png', status: 'EXISTS' },
        { avatar: 'Target.png', status: 'EXISTS' },
      ],
      [
        { avatar: 'Source.png', cardId: VALID_CARD_ID_1, state: s1 },
        { avatar: 'Source.png', cardId: VALID_CARD_ID_2, state: s2 },
      ]
    );
    const res = planCloneSidecar(s1, s1.cardId, 'Source.png', 'Target.png', 1, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);
  });

  it('rejects clone with ASSOCIATION_CONFLICT when target avatar has multiple claims (G4-R2 Finding A)', () => {
    const sSource = createValidState({ avatar: 'Source.png', cardId: VALID_CARD_ID_1 });
    const sTarget1 = createValidState({ avatar: 'Target.png', cardId: VALID_CARD_ID_2 });
    const sTarget2 = createValidState({ avatar: 'Target.png', cardId: VALID_CARD_ID_3 });
    const ev = createValidEvidence(
      [
        { avatar: 'Source.png', status: 'EXISTS' },
        { avatar: 'Target.png', status: 'EXISTS' },
      ],
      [
        { avatar: 'Source.png', cardId: VALID_CARD_ID_1, state: sSource },
        { avatar: 'Target.png', cardId: VALID_CARD_ID_2, state: sTarget1 },
        { avatar: 'Target.png', cardId: VALID_CARD_ID_3, state: sTarget2 },
      ]
    );
    const res = planCloneSidecar(sSource, sSource.cardId, 'Source.png', 'Target.png', 1, ev);
    assert.equal(res.ok, false);
    assert.equal(res.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);
  });
});

// --- Suite 9: serializeSidecarState & Canonical Equality ---

describe('serializeSidecarState & Canonical Determinism', () => {
  it('serializes deterministically with sorted keys at all levels', () => {
    const char = createValidCharacter();
    const state1 = {
      storageRevision: 1,
      schemaVersion: 1,
      registry: { revision: 0, schemaVersion: 1, characters: [char] },
      cardId: VALID_CARD_ID_1,
      avatar: 'Char.png',
    };
    const state2 = {
      avatar: 'Char.png',
      cardId: VALID_CARD_ID_1,
      registry: { characters: [char], revision: 0, schemaVersion: 1 },
      schemaVersion: 1,
      storageRevision: 1,
    };

    const s1 = serializeSidecarState(state1);
    const s2 = serializeSidecarState(state2);
    assert.equal(s1.ok, true);
    assert.equal(s2.ok, true);
    assert.equal(s1.value, s2.value);
  });

  it('fails if inner registry or outer state exceeds caps', () => {
    const valid = createValidState();
    const ser = serializeSidecarState(valid);
    assert.equal(ser.ok, true);
  });
});

// --- Suite 10: Hostile Input & Exception Containment (G4-R1) ---

describe('Hostile Input & Exception Containment (G4-R1)', () => {
  it('public API boundaries fail closed when given hostile proxies or throwing getters', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: state.avatar, status: 'EXISTS' }],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );
    const hostileState = new Proxy(state, {
      getPrototypeOf() { throw new Error('hostile state proxy'); },
    });

    const resResolve = resolveSidecarIdentity(hostileState, 'some-id');
    assert.equal(resResolve.ok, false);

    const resMutate = planMutateSidecar(hostileState, state.cardId, state.avatar, 1, 0, {}, ev);
    assert.equal(resMutate.ok, false);

    const resRebind = planRebindSidecar(hostileState, state.cardId, state.avatar, 'New.png', 1, ev);
    assert.equal(resRebind.ok, false);

    const resClone = planCloneSidecar(hostileState, state.cardId, state.avatar, 'New.png', 1, ev);
    assert.equal(resClone.ok, false);

    const resSerialize = serializeSidecarState(hostileState);
    assert.equal(resSerialize.ok, false);
  });

  it('contains throwing options and generator functions safely', () => {
    const state = createValidState();
    const ev = createValidEvidence(
      [{ avatar: 'Unbound.png', status: 'EXISTS' }],
      []
    );

    const hostileOptions = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'generateCardId') {
          throw new Error('hostile generator getter');
        }
        return undefined;
      },
    });

    const resCreate = planCreateSidecar('Unbound.png', ev, hostileOptions);
    assert.equal(resCreate.ok, false);
    assert.equal(resCreate.code, SIDECAR_ERROR_CODES.ID_GENERATION_FAILED);

    const evClone = createValidEvidence(
      [
        { avatar: state.avatar, status: 'EXISTS' },
        { avatar: 'Target.png', status: 'EXISTS' },
      ],
      [{ avatar: state.avatar, cardId: state.cardId, state }]
    );

    const resClone = planCloneSidecar(
      state,
      state.cardId,
      state.avatar,
      'Target.png',
      1,
      evClone,
      hostileOptions
    );
    assert.equal(resClone.ok, false);
    assert.equal(resClone.code, SIDECAR_ERROR_CODES.ID_GENERATION_FAILED);
  });

  it('healthy unrelated card operations succeed under complete scan even when another avatar has conflicting claims (G4-R2 Finding A)', () => {
    const healthyState = createValidState({ avatar: 'Healthy.png', cardId: VALID_CARD_ID_1, storageRevision: 1 });
    const orphanState = createValidState({ avatar: 'Orphan.png', cardId: VALID_CARD_ID_2, storageRevision: 1 });
    const conflictState1 = createValidState({ avatar: 'Conflicted.png', cardId: '33333333-3333-4333-8333-333333333333' });
    const conflictState2 = createValidState({ avatar: 'Conflicted.png', cardId: '44444444-4444-4444-8444-444444444444' });

    const ev = createValidEvidence(
      [
        { avatar: 'Healthy.png', status: 'EXISTS' },
        { avatar: 'Orphan.png', status: 'MISSING' },
        { avatar: 'Recovered.png', status: 'EXISTS' },
        { avatar: 'Conflicted.png', status: 'EXISTS' },
        { avatar: 'Fresh.png', status: 'EXISTS' },
      ],
      [
        { avatar: 'Healthy.png', cardId: healthyState.cardId, state: healthyState },
        { avatar: 'Orphan.png', cardId: orphanState.cardId, state: orphanState },
        { avatar: 'Conflicted.png', cardId: conflictState1.cardId, state: conflictState1 },
        { avatar: 'Conflicted.png', cardId: conflictState2.cardId, state: conflictState2 },
      ]
    );

    // 1. Mutate healthy card succeeds
    const addCmd = { type: 'add', character: { name: 'Hina' } };
    const resMutate = planMutateSidecar(healthyState, healthyState.cardId, 'Healthy.png', 1, 0, addCmd, ev);
    assert.equal(resMutate.ok, true);
    assert.equal(resMutate.changed, true);

    // 2. Create for fresh avatar succeeds
    const resCreate = planCreateSidecar('Fresh.png', ev, { generateCardId: () => '55555555-5555-4555-8555-555555555555' });
    assert.equal(resCreate.ok, true);
    assert.equal(resCreate.changed, true);

    // 3. Single valid orphan recovery to Recovered.png succeeds
    const resRebind = planRebindSidecar(orphanState, orphanState.cardId, 'Orphan.png', 'Recovered.png', 1, ev);
    assert.equal(resRebind.ok, true);
    assert.equal(resRebind.changed, true);

    // 4. Conflicted avatar correctly diagnosed by classifyAssociations
    const resClassify = classifyAssociations('Conflicted.png', ev);
    assert.equal(resClassify.ok, false);
    assert.equal(resClassify.code, SIDECAR_ERROR_CODES.ASSOCIATION_CONFLICT);
  });

  it('rejects avatar exceeding 255-byte limit across all public sidecar APIs (G4-R2 Finding C)', () => {
    const tooLongAvatar = 'a'.repeat(252) + '.png'; // 256 bytes
    const validEv = createValidEvidence([], []);

    // 1. classifyAssociations
    const resClassify = classifyAssociations(tooLongAvatar, validEv);
    assert.equal(resClassify.ok, false);
    assert.equal(resClassify.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);

    // 2. planCreateSidecar
    const resCreate = planCreateSidecar(tooLongAvatar, validEv);
    assert.equal(resCreate.ok, false);
    assert.equal(resCreate.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);

    // 3. planRebindSidecar
    const state = createValidState();
    const resRebindFrom = planRebindSidecar(state, state.cardId, tooLongAvatar, 'Target.png', 1, validEv);
    assert.equal(resRebindFrom.ok, false);
    assert.equal(resRebindFrom.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);

    const resRebindTo = planRebindSidecar(state, state.cardId, 'Source.png', tooLongAvatar, 1, validEv);
    assert.equal(resRebindTo.ok, false);
    assert.equal(resRebindTo.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);

    // 4. planCloneSidecar
    const resCloneSource = planCloneSidecar(state, state.cardId, tooLongAvatar, 'Target.png', 1, validEv);
    assert.equal(resCloneSource.ok, false);
    assert.equal(resCloneSource.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);

    const resCloneTarget = planCloneSidecar(state, state.cardId, 'Source.png', tooLongAvatar, 1, validEv);
    assert.equal(resCloneTarget.ok, false);
    assert.equal(resCloneTarget.code, SIDECAR_ERROR_CODES.INVALID_AVATAR);
  });
});
