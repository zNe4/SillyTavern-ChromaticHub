/**
 * SillyTavern-ChromaticHub: Pure Editor-Safety Evaluator Tests (H01-B3-B / R1)
 *
 * Synthetic unit tests covering the strict observation contract:
 * - Danger denials (editor open/dirty, pending/in-flight save, stale JSON,
 *   active-card mismatch, external writer)
 * - Missing, unknown-status, wrong-type, thenable, and hostile observations
 * - R1-F1: inherited values (envelope, owner, nested status/value) never count
 * - R1-F2: strict shapes incl. non-enumerable and symbol own properties;
 *   controlled diagnostics that never leak secret property names
 * - R1-F3: approved precedence incl. active-card mismatch before external writer
 * - R1-F4: owner validation matching the mutation controller locator rules
 * - The single allow path: complete, strictly valid, clean synthetic observations
 * - Sanitized diagnostics and deep immutability
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEditorSafety, EDITOR_SAFETY_REASONS } from '../src/editor-safety.mjs';

const TARGET_AVATAR = 'TargetCard.png';
const SECRET = 'SECRET-PROPERTY-NAME-7c3f';

function makeObservations(overrides = {}) {
  return {
    schemaVersion: 1,
    owner: { kind: 'installed-card', avatar: TARGET_AVATAR },
    editorVisible: { status: 'ok', value: false },
    editorDirty: { status: 'ok', value: false },
    saveScheduled: { status: 'ok', value: false },
    saveInFlight: { status: 'ok', value: false },
    hiddenJsonConflicts: { status: 'ok', value: false },
    activeCardAvatar: { status: 'ok', value: TARGET_AVATAR },
    externalWriterSuspected: { status: 'ok', value: false },
    ...overrides,
  };
}

function hostileField(observations, field) {
  return Object.defineProperty({ ...observations }, field, {
    get() {
      throw new Error('hostile getter');
    },
    configurable: true,
  });
}

const THENABLE = { then() {} };

test('editor-safety evaluator - danger denials', async (t) => {
  await t.test('A1: editor open', () => {
    const res = evaluateEditorSafety(makeObservations({ editorVisible: { status: 'ok', value: true } }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.EDITOR_OPEN);
    assert.equal(res.details.field, 'editorVisible');
  });

  await t.test('A2: dirty editor', () => {
    const res = evaluateEditorSafety(makeObservations({ editorDirty: { status: 'ok', value: true } }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.EDITOR_DIRTY);
    assert.equal(res.details.field, 'editorDirty');
  });

  await t.test('A3: pending (debounced) save', () => {
    const res = evaluateEditorSafety(makeObservations({ saveScheduled: { status: 'ok', value: true } }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.SAVE_PENDING);
    assert.equal(res.details.field, 'saveScheduled');
  });

  await t.test('A4: in-flight save', () => {
    const res = evaluateEditorSafety(makeObservations({ saveInFlight: { status: 'ok', value: true } }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.SAVE_IN_FLIGHT);
    assert.equal(res.details.field, 'saveInFlight');
  });

  await t.test('A5: stale hidden JSON', () => {
    const res = evaluateEditorSafety(makeObservations({ hiddenJsonConflicts: { status: 'ok', value: true } }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.HIDDEN_JSON_STALE);
    assert.equal(res.details.field, 'hiddenJsonConflicts');
  });

  await t.test('A9: activeCardAvatar null', () => {
    const res = evaluateEditorSafety(makeObservations({ activeCardAvatar: { status: 'ok', value: null } }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.ACTIVE_CARD_MISMATCH);
    assert.equal(res.details.field, 'activeCardAvatar');
  });

  await t.test('A9: activeCardAvatar differs from owner avatar', () => {
    const res = evaluateEditorSafety(
      makeObservations({ activeCardAvatar: { status: 'ok', value: 'OtherCard.png' } }),
    );
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.ACTIVE_CARD_MISMATCH);
  });

  await t.test('A10: external writer suspected', () => {
    const res = evaluateEditorSafety(
      makeObservations({ externalWriterSuspected: { status: 'ok', value: true } }),
    );
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.EXTERNAL_WRITER_SUSPECTED);
    assert.equal(res.details.field, 'externalWriterSuspected');
  });
});

test('editor-safety evaluator - availability failures', async (t) => {
  const ALL_FIELDS = [
    'editorVisible',
    'editorDirty',
    'saveScheduled',
    'saveInFlight',
    'hiddenJsonConflicts',
    'activeCardAvatar',
    'externalWriterSuspected',
  ];

  await t.test('A6: field absent', () => {
    for (const field of ALL_FIELDS) {
      const observations = makeObservations();
      delete observations[field];
      const res = evaluateEditorSafety(observations);
      assert.equal(res.safe, false);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.MISSING_OBSERVATION);
      assert.equal(res.details.field, field);
    }
  });

  await t.test('A6: field reports status "missing"', () => {
    for (const field of ALL_FIELDS) {
      const res = evaluateEditorSafety(makeObservations({ [field]: { status: 'missing' } }));
      assert.equal(res.safe, false);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.MISSING_OBSERVATION);
      assert.equal(res.details.field, field);
    }
  });

  await t.test('A8: field reports status "unknown"', () => {
    for (const field of ALL_FIELDS) {
      const res = evaluateEditorSafety(makeObservations({ [field]: { status: 'unknown' } }));
      assert.equal(res.safe, false);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
      assert.equal(res.details.field, field);
    }
  });

  await t.test('A8: wrong value type (boolean fields)', () => {
    for (const field of ALL_FIELDS.filter((f) => f !== 'activeCardAvatar')) {
      for (const bad of ['false', 0, 1, null, undefined, THENABLE]) {
        const res = evaluateEditorSafety(makeObservations({ [field]: { status: 'ok', value: bad } }));
        assert.equal(res.safe, false, `${field} with ${String(bad)} must be unsafe`);
        assert.equal(res.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
        assert.equal(res.details.field, field);
      }
    }
  });

  await t.test('A8: wrong value type (activeCardAvatar)', () => {
    for (const bad of [123, true, {}, THENABLE]) {
      const res = evaluateEditorSafety(makeObservations({ activeCardAvatar: { status: 'ok', value: bad } }));
      assert.equal(res.safe, false);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
      assert.equal(res.details.field, 'activeCardAvatar');
    }
  });

  await t.test('A8: Promise-typed value never counts as an observation', () => {
    const res = evaluateEditorSafety(
      makeObservations({ editorVisible: { status: 'ok', value: Promise.resolve(false) } }),
    );
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
    assert.equal(res.details.field, 'editorVisible');
  });

  await t.test('A7: throwing getter on any observation field', () => {
    for (const field of ALL_FIELDS) {
      const res = evaluateEditorSafety(hostileField(makeObservations(), field));
      assert.equal(res.safe, false, `${field} throwing getter must be unsafe`);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
      assert.equal(res.details.field, field);
    }
  });

  await t.test('A7: throwing getter on owner fields', () => {
    for (const ownerField of ['kind', 'avatar']) {
      const observations = makeObservations();
      observations.owner = { ...observations.owner };
      Object.defineProperty(observations.owner, ownerField, {
        get() {
          throw new Error('hostile owner getter');
        },
        configurable: true,
      });
      const res = evaluateEditorSafety(observations);
      assert.equal(res.safe, false);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    }
  });

  await t.test('A7: hostile observation object survives containment', () => {
    const hostile = makeObservations();
    Object.defineProperty(hostile, 'editorVisible', {
      get() {
        throw new Error('boom');
      },
      configurable: true,
    });
    Object.defineProperty(hostile, 'saveScheduled', {
      get() {
        throw new Error('boom-2');
      },
      configurable: true,
    });
    const res = evaluateEditorSafety(hostile);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
    assert.equal(res.details.field, 'editorVisible');
  });

  await t.test('R1-F1: inherited observation record (status/value via prototype) never authorizes', () => {
    // A record with NO own status/value, inheriting clean-looking values
    // through a non-ordinary prototype. The strict shape rejects it before
    // any inherited value can contribute; the own-property rules would also
    // reject it were the prototype ordinary.
    const observations = makeObservations();
    observations.editorVisible = Object.create({ status: 'ok', value: false });
    const res = evaluateEditorSafety(observations);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
    assert.equal(res.details.field, 'editorVisible');

    // Inherited status 'ok' with own value: still a non-plain record and
    // status is not an own property.
    const inheritedStatus = Object.create({ status: 'ok' });
    inheritedStatus.value = false;
    const res2 = evaluateEditorSafety(makeObservations({ editorDirty: inheritedStatus }));
    assert.equal(res2.safe, false);
    assert.equal(res2.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
    assert.equal(res2.details.field, 'editorDirty');

    // Own status with inherited value: value is not an own property.
    const inheritedValue = { status: 'ok' };
    Object.setPrototypeOf(inheritedValue, { value: false });
    const res3 = evaluateEditorSafety(makeObservations({ saveScheduled: inheritedValue }));
    assert.equal(res3.safe, false);
    assert.equal(res3.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
    assert.equal(res3.details.field, 'saveScheduled');
  });

  await t.test('R1-F1: inherited envelope field never counts as supplied', () => {
    const observations = Object.create(makeObservations());
    // All keys inherited; nothing is an own property.
    const res = evaluateEditorSafety(observations);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);

    // A plain envelope whose only source for a field is Object.prototype
    // (simulated pollution, immediately removed) still lacks the own
    // property and must fail closed.
    Object.prototype.externalWriterSuspected = { status: 'ok', value: false };
    try {
      const polluted = makeObservations();
      delete polluted.externalWriterSuspected;
      const res2 = evaluateEditorSafety(polluted);
      assert.equal(res2.safe, false);
      assert.equal(res2.reason, EDITOR_SAFETY_REASONS.MISSING_OBSERVATION);
      assert.equal(res2.details.field, 'externalWriterSuspected');
    } finally {
      delete Object.prototype.externalWriterSuspected;
    }
  });

  await t.test('R1-F1: inherited owner fields cannot establish validity', () => {
    const observations = makeObservations();
    observations.owner = Object.create({ kind: 'installed-card', avatar: TARGET_AVATAR });
    const res = evaluateEditorSafety(observations);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);

    // Own avatar with inherited kind is still invalid.
    const owner2 = { avatar: TARGET_AVATAR };
    Object.setPrototypeOf(owner2, { kind: 'installed-card' });
    const res2 = evaluateEditorSafety(makeObservations({ owner: owner2 }));
    assert.equal(res2.safe, false);
    assert.equal(res2.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });

  await t.test('R1-F1: hostile proxy observations fail closed', () => {
    const observations = new Proxy(makeObservations(), {
      ownKeys() {
        throw new Error('hostile ownKeys trap');
      },
    });
    const res = evaluateEditorSafety(observations);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);

    const observations2 = new Proxy(makeObservations(), {
      get(target, prop) {
        if (prop === 'editorVisible') {
          throw new Error('hostile get trap');
        }
        return target[prop];
      },
    });
    const res2 = evaluateEditorSafety(observations2);
    assert.equal(res2.safe, false);
    assert.equal(res2.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
    assert.equal(res2.details.field, 'editorVisible');
  });
});

test('editor-safety evaluator - strict shapes and diagnostic privacy', async (t) => {
  await t.test('R1-F2: unexpected own property on envelope (secret-bearing name)', () => {
    const observations = makeObservations();
    observations[SECRET] = { status: 'ok', value: false };
    const res = evaluateEditorSafety(observations);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    assert.equal(JSON.stringify(res).includes(SECRET), false, 'diagnostics must not echo the secret name');
  });

  await t.test('R1-F2: non-enumerable unexpected own property on envelope', () => {
    const observations = makeObservations();
    Object.defineProperty(observations, 'hiddenExtra', {
      value: { status: 'ok', value: false },
      enumerable: false,
      configurable: true,
    });
    const res = evaluateEditorSafety(observations);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });

  await t.test('R1-F2: symbol own property on envelope', () => {
    const observations = makeObservations();
    observations[Symbol(SECRET)] = { status: 'ok', value: false };
    const res = evaluateEditorSafety(observations);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    assert.equal(JSON.stringify(res).includes(SECRET), false);
  });

  await t.test('R1-F2: unexpected own property on nested record (secret-bearing name)', () => {
    const record = { status: 'ok', value: false };
    record[SECRET] = true;
    const res = evaluateEditorSafety(makeObservations({ editorDirty: record }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    assert.equal(res.details.field, 'editorDirty');
    assert.equal(JSON.stringify(res).includes(SECRET), false);
  });

  await t.test('R1-F2: symbol own property on nested record', () => {
    const record = { status: 'ok', value: false };
    record[Symbol(SECRET)] = true;
    const res = evaluateEditorSafety(makeObservations({ saveInFlight: record }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    assert.equal(JSON.stringify(res).includes(SECRET), false);
  });

  await t.test('R1-F2: unexpected own property on owner (secret-bearing name)', () => {
    const owner = { kind: 'installed-card', avatar: TARGET_AVATAR };
    owner[SECRET] = 1;
    const res = evaluateEditorSafety(makeObservations({ owner }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    assert.equal(JSON.stringify(res).includes(SECRET), false);
  });

  await t.test('R1-F2: non-enumerable unexpected own property on nested record', () => {
    const record = { status: 'ok', value: false };
    Object.defineProperty(record, 'hiddenExtra', {
      value: true,
      enumerable: false,
      configurable: true,
    });
    const res = evaluateEditorSafety(makeObservations({ hiddenJsonConflicts: record }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });
});

test('editor-safety evaluator - envelope validation', async (t) => {
  await t.test('A12: non-plain object', () => {
    for (const bad of [null, undefined, 42, 'obs', [], () => {}]) {
      const res = evaluateEditorSafety(bad);
      assert.equal(res.safe, false);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    }
  });

  await t.test('A12: wrong schemaVersion', () => {
    for (const bad of [0, 2, '1', null, undefined, 1.5]) {
      const res = evaluateEditorSafety(makeObservations({ schemaVersion: bad }));
      assert.equal(res.safe, false, `schemaVersion ${String(bad)} must be rejected`);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    }
  });

  await t.test('A12: schemaVersion supplied through inheritance is missing', () => {
    const observations = makeObservations();
    delete observations.schemaVersion;
    Object.setPrototypeOf(observations, { schemaVersion: 1 });
    const res = evaluateEditorSafety(observations);
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });

  await t.test('A12: unknown top-level keys', () => {
    const res = evaluateEditorSafety(makeObservations({ surprise: { status: 'ok', value: false } }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });

  await t.test('A12: posture field is rejected', () => {
    const res = evaluateEditorSafety(makeObservations({ posture: 'certifying' }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });

  await t.test('A12: invalid owner kind', () => {
    const res = evaluateEditorSafety(
      makeObservations({ owner: { kind: 'chat-local', avatar: TARGET_AVATAR } }),
    );
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });

  await t.test('R1-F4: owner avatar follows controller locator restrictions', () => {
    const badAvatars = [
      '',
      '   ',
      42,
      null,
      undefined,
      '../up.png',
      'a/b.png',
      'a\\b.png',
      'card.jpg',
      'car\0d.png',
      '.png',
      '..png',
      ' .png',
      '\t.png',
      '...png',
    ];
    for (const bad of badAvatars) {
      const res = evaluateEditorSafety(makeObservations({ owner: { kind: 'installed-card', avatar: bad } }));
      assert.equal(res.safe, false, `avatar ${JSON.stringify(bad)} must be rejected`);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    }
  });

  await t.test('R1-F4: "." and ".." avatar stems are explicitly rejected', () => {
    for (const bad of ['..png', '...png']) {
      const res = evaluateEditorSafety(
        makeObservations({ owner: { kind: 'installed-card', avatar: bad } }),
      );
      assert.equal(res.safe, false, `avatar ${bad} (stem "." or "..") must be rejected`);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
    }
    // Valid-shaped stems that remain acceptable, confirming the rule is stem-exact.
    for (const good of ['Card.png', 'A.B.png']) {
      const res = evaluateEditorSafety(
        makeObservations({ owner: { kind: 'installed-card', avatar: good }, activeCardAvatar: { status: 'ok', value: good } }),
      );
      assert.equal(res.safe, true, `avatar ${good} must remain valid`);
    }
  });

  await t.test('A12: non-object owner', () => {
    const res = evaluateEditorSafety(makeObservations({ owner: 'installed-card' }));
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });
});

test('editor-safety evaluator - the single allow path', async (t) => {
  await t.test('A11: complete, valid, clean synthetic observations allow', () => {
    const res = evaluateEditorSafety(makeObservations());
    assert.deepEqual(res, { safe: true });
    assert.equal(Object.isFrozen(res), true);
  });

  await t.test('A11: matching activeCardAvatar from a different valid name is still a mismatch', () => {
    const res = evaluateEditorSafety(
      makeObservations({ activeCardAvatar: { status: 'ok', value: 'Another.png' } }),
    );
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.ACTIVE_CARD_MISMATCH);
  });

  await t.test('A11: any single missing/unknown field blocks the allow path', () => {
    const fields = [
      'editorVisible',
      'editorDirty',
      'saveScheduled',
      'saveInFlight',
      'hiddenJsonConflicts',
      'activeCardAvatar',
      'externalWriterSuspected',
    ];
    for (const field of fields) {
      const missing = makeObservations();
      delete missing[field];
      assert.equal(evaluateEditorSafety(missing).safe, false);
      const unknown = makeObservations({ [field]: { status: 'unknown' } });
      assert.equal(evaluateEditorSafety(unknown).safe, false);
    }
  });
});

test('editor-safety evaluator - deterministic precedence (R1-F3)', async (t) => {
  await t.test('A13: envelope failures precede everything', () => {
    const res = evaluateEditorSafety(
      makeObservations({ schemaVersion: 2, editorVisible: { status: 'ok', value: true } }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });

  await t.test('A13: availability failures precede danger booleans', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        editorDirty: { status: 'ok', value: true },
        saveScheduled: { status: 'unknown' },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.UNKNOWN_OBSERVATION);
    assert.equal(res.details.field, 'saveScheduled');
  });

  await t.test('A13: editorVisible precedes editorDirty', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        editorVisible: { status: 'ok', value: true },
        editorDirty: { status: 'ok', value: true },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.EDITOR_OPEN);
  });

  await t.test('A13: editorDirty precedes saveScheduled', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        editorDirty: { status: 'ok', value: true },
        saveScheduled: { status: 'ok', value: true },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.EDITOR_DIRTY);
  });

  await t.test('A13: saveScheduled precedes saveInFlight', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        saveScheduled: { status: 'ok', value: true },
        saveInFlight: { status: 'ok', value: true },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.SAVE_PENDING);
  });

  await t.test('A13: saveInFlight precedes hiddenJsonConflicts', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        saveInFlight: { status: 'ok', value: true },
        hiddenJsonConflicts: { status: 'ok', value: true },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.SAVE_IN_FLIGHT);
  });

  await t.test('A13: hiddenJsonConflicts precedes active-card mismatch', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        hiddenJsonConflicts: { status: 'ok', value: true },
        activeCardAvatar: { status: 'ok', value: null },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.HIDDEN_JSON_STALE);
  });

  await t.test('R1-F3 regression: active-card mismatch precedes external writer', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        activeCardAvatar: { status: 'ok', value: 'Other.png' },
        externalWriterSuspected: { status: 'ok', value: true },
      }),
    );
    assert.equal(res.safe, false);
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.ACTIVE_CARD_MISMATCH);
  });

  await t.test('R1-F3: full ladder collapses to the first danger', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        editorVisible: { status: 'ok', value: true },
        editorDirty: { status: 'ok', value: true },
        saveScheduled: { status: 'ok', value: true },
        saveInFlight: { status: 'ok', value: true },
        hiddenJsonConflicts: { status: 'ok', value: true },
        activeCardAvatar: { status: 'ok', value: null },
        externalWriterSuspected: { status: 'ok', value: true },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.EDITOR_OPEN);
  });
});

test('editor-safety evaluator - immutability and sanitized diagnostics', async (t) => {
  await t.test('A14: reason enum is frozen', () => {
    assert.equal(Object.isFrozen(EDITOR_SAFETY_REASONS), true);
    assert.throws(() => {
      'use strict';
      EDITOR_SAFETY_REASONS.EDITOR_OPEN = 'x';
    });
  });

  await t.test('A14: decision objects are deeply frozen', () => {
    const res = evaluateEditorSafety(makeObservations({ editorVisible: { status: 'ok', value: true } }));
    assert.equal(Object.isFrozen(res), true);
    assert.equal(Object.isFrozen(res.details), true);
    assert.throws(() => {
      'use strict';
      res.safe = true;
    });
    assert.throws(() => {
      'use strict';
      res.details.field = 'other';
    });
  });

  await t.test('A14: diagnostics contain only the field name, never card content', () => {
    const observations = makeObservations({
      editorDirty: { status: 'ok', value: true },
      activeCardAvatar: { status: 'ok', value: 'SecretCardWithPrivateContent.png' },
      owner: { kind: 'installed-card', avatar: 'SecretCardWithPrivateContent.png' },
    });
    const res = evaluateEditorSafety(observations);
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes('SecretCardWithPrivateContent'), false);
    assert.deepEqual(Object.keys(res.details), ['field']);
  });
});
