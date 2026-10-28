/**
 * SillyTavern-ChromaticHub: Pure Editor-Safety Evaluator Tests (H01-B3-B)
 *
 * Synthetic unit tests covering the strict observation contract:
 * - Danger denials (editor open/dirty, pending/in-flight save, stale JSON,
 *   active-card mismatch, external writer)
 * - Missing, unknown-status, wrong-type, thenable, and hostile observations
 * - Envelope validation (schemaVersion, owner echo, unknown keys, posture)
 * - Deterministic reason precedence
 * - The single allow path: complete, valid, clean synthetic observations
 * - Sanitized diagnostics and deep immutability
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEditorSafety, EDITOR_SAFETY_REASONS } from '../src/editor-safety.mjs';

const TARGET_AVATAR = 'TargetCard.png';

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

  await t.test('A12: invalid owner avatar', () => {
    const badAvatars = ['', '   ', 42, null, '../up.png', 'a/b.png', 'card.jpg', 'car\0d.png', '.png'];
    for (const bad of badAvatars) {
      const res = evaluateEditorSafety(makeObservations({ owner: { kind: 'installed-card', avatar: bad } }));
      assert.equal(res.safe, false, `avatar ${String(bad)} must be rejected`);
      assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
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

test('editor-safety evaluator - deterministic precedence', async (t) => {
  await t.test('A13: danger booleans follow the fixed field order', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        editorVisible: { status: 'ok', value: true },
        editorDirty: { status: 'ok', value: true },
        saveScheduled: { status: 'ok', value: true },
        saveInFlight: { status: 'ok', value: true },
        hiddenJsonConflicts: { status: 'ok', value: true },
        externalWriterSuspected: { status: 'ok', value: true },
        activeCardAvatar: { status: 'ok', value: null },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.EDITOR_OPEN);

    const dirtyFirst = evaluateEditorSafety(
      makeObservations({
        editorDirty: { status: 'ok', value: true },
        saveScheduled: { status: 'ok', value: true },
        saveInFlight: { status: 'ok', value: true },
        hiddenJsonConflicts: { status: 'ok', value: true },
        externalWriterSuspected: { status: 'ok', value: true },
      }),
    );
    assert.equal(dirtyFirst.reason, EDITOR_SAFETY_REASONS.EDITOR_DIRTY);

    const savePendingFirst = evaluateEditorSafety(
      makeObservations({
        saveScheduled: { status: 'ok', value: true },
        saveInFlight: { status: 'ok', value: true },
        hiddenJsonConflicts: { status: 'ok', value: true },
        externalWriterSuspected: { status: 'ok', value: true },
      }),
    );
    assert.equal(savePendingFirst.reason, EDITOR_SAFETY_REASONS.SAVE_PENDING);

    const inFlightFirst = evaluateEditorSafety(
      makeObservations({
        saveInFlight: { status: 'ok', value: true },
        hiddenJsonConflicts: { status: 'ok', value: true },
        externalWriterSuspected: { status: 'ok', value: true },
      }),
    );
    assert.equal(inFlightFirst.reason, EDITOR_SAFETY_REASONS.SAVE_IN_FLIGHT);

    const staleJsonFirst = evaluateEditorSafety(
      makeObservations({
        hiddenJsonConflicts: { status: 'ok', value: true },
        externalWriterSuspected: { status: 'ok', value: true },
      }),
    );
    assert.equal(staleJsonFirst.reason, EDITOR_SAFETY_REASONS.HIDDEN_JSON_STALE);

    const writerOnly = evaluateEditorSafety(
      makeObservations({ externalWriterSuspected: { status: 'ok', value: true } }),
    );
    assert.equal(writerOnly.reason, EDITOR_SAFETY_REASONS.EXTERNAL_WRITER_SUSPECTED);
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

  await t.test('A13: envelope failures precede everything', () => {
    const res = evaluateEditorSafety(
      makeObservations({ schemaVersion: 2, editorVisible: { status: 'ok', value: true } }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.INVALID_OBSERVATIONS);
  });

  await t.test('A13: danger booleans precede active-card mismatch', () => {
    const res = evaluateEditorSafety(
      makeObservations({
        externalWriterSuspected: { status: 'ok', value: true },
        activeCardAvatar: { status: 'ok', value: null },
      }),
    );
    assert.equal(res.reason, EDITOR_SAFETY_REASONS.EXTERNAL_WRITER_SUSPECTED);
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
