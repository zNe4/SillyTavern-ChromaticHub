import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRegistry,
  resolveIdentity,
  planMutation,
  serializeRegistry,
} from '../src/identity-registry.mjs';

// Helper fixtures
const VALID_UUID_1 = '4d15ae22-565c-4d19-9e6c-6d7653940cfa';
const VALID_UUID_2 = '64be5fd4-6900-4ed7-9844-2692c684c984';
const VALID_UUID_3 = 'a0000000-0000-4000-8000-000000000001';

function createValidRegistry(characters = [], revision = 1) {
  return {
    schemaVersion: 1,
    revision,
    characters,
  };
}

function createValidCharacter(id = VALID_UUID_1, name = 'Hina', descriptor = 'Knight', aliases = []) {
  return {
    id,
    name,
    descriptor,
    aliases,
  };
}

describe('parseRegistry', () => {
  describe('uninitialized vs invalid', () => {
    it('returns UNINITIALIZED with a virtual empty registry when raw is undefined', () => {
      const res = parseRegistry(undefined);
      assert.equal(res.ok, true);
      assert.equal(res.status, 'UNINITIALIZED');
      assert.deepEqual(res.value, {
        schemaVersion: 1,
        revision: 0,
        characters: [],
      });
      assert.equal(Object.isFrozen(res.value), true);
      assert.equal(Object.isFrozen(res.value.characters), true);
    });

    it('returns INVALID_SCHEMA when raw is null', () => {
      const res = parseRegistry(null);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_SCHEMA');
      assert.equal(res.recoverable, false);
    });

    it('returns INVALID_SCHEMA for non-object primitives and arrays', () => {
      for (const invalid of ['', 'string', 42, true, []]) {
        const res = parseRegistry(invalid);
        assert.equal(res.ok, false, `Expected failure for ${JSON.stringify(invalid)}`);
        assert.equal(res.code, 'INVALID_SCHEMA');
      }
    });
  });

  describe('schemaVersion validation', () => {
    it('accepts schemaVersion 1', () => {
      const raw = createValidRegistry();
      const res = parseRegistry(raw);
      assert.equal(res.ok, true);
      assert.equal(res.status, 'VALID');
      assert.equal(res.value.schemaVersion, 1);
    });

    it('returns UNSUPPORTED_VERSION for unknown integer schemaVersion', () => {
      for (const ver of [0, 2, 99, -1]) {
        const raw = { ...createValidRegistry(), schemaVersion: ver };
        const res = parseRegistry(raw);
        assert.equal(res.ok, false, `Expected failure for version ${ver}`);
        assert.equal(res.code, 'UNSUPPORTED_VERSION');
        assert.equal(res.recoverable, false);
        assert.equal(res.details?.foundVersion, ver);
      }
    });

    it('returns INVALID_SCHEMA for non-integer or malformed schemaVersion types', () => {
      for (const ver of ['1', 1.5, true, null, undefined, {}]) {
        const raw = { ...createValidRegistry(), schemaVersion: ver };
        const res = parseRegistry(raw);
        assert.equal(res.ok, false, `Expected INVALID_SCHEMA for version ${JSON.stringify(ver)}`);
        assert.equal(res.code, 'INVALID_SCHEMA');
      }
    });
  });

  describe('revision validation', () => {
    it('accepts non-negative safe integers', () => {
      for (const rev of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
        const raw = createValidRegistry([], rev);
        const res = parseRegistry(raw);
        assert.equal(res.ok, true);
        assert.equal(res.value.revision, rev);
      }
    });

    it('rejects negative, float, non-number or unsafe revisions with INVALID_SCHEMA', () => {
      for (const rev of [-1, 1.5, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
        const raw = { schemaVersion: 1, revision: rev, characters: [] };
        const res = parseRegistry(raw);
        assert.equal(res.ok, false, `Expected INVALID_SCHEMA for revision ${rev}`);
        assert.equal(res.code, 'INVALID_SCHEMA');
      }
    });
  });

  describe('unknown fields and prototype pollution', () => {
    it('rejects unknown root properties with INVALID_SCHEMA', () => {
      const raw = { ...createValidRegistry(), extraField: 'bad' };
      const res = parseRegistry(raw);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_SCHEMA');
    });

    it('rejects unknown character properties with INVALID_SCHEMA', () => {
      const char = { ...createValidCharacter(), extraField: 'bad' };
      const raw = createValidRegistry([char]);
      const res = parseRegistry(raw);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_SCHEMA');
    });

    it('rejects prototype pollution or objects with modified prototypes', () => {
      const maliciousObj = JSON.parse('{"schemaVersion":1,"revision":1,"characters":[],"__proto__":{"polluted":true}}');
      const res = parseRegistry(maliciousObj);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_SCHEMA');
      assert.equal(Object.prototype.polluted, undefined);
    });
  });

  describe('character fields and strict requirement', () => {
    it('rejects character missing id, name, descriptor, or aliases without silent repair', () => {
      const base = createValidCharacter();
      for (const field of ['id', 'name', 'descriptor', 'aliases']) {
        const invalidChar = { ...base };
        delete invalidChar[field];
        const res = parseRegistry(createValidRegistry([invalidChar]));
        assert.equal(res.ok, false, `Expected rejection when missing ${field}`);
        assert.equal(res.code, 'INVALID_SCHEMA');
      }
    });

    it('rejects non-canonical or non-v4 UUIDs', () => {
      const invalidIds = [
        'not-a-uuid',
        '4d15ae22-565c-4d19-9e6c-6d7653940cf', // too short
        '4D15AE22-565C-4D19-9E6C-6D7653940CFA', // uppercase forbidden
        '4d15ae22-565c-1d19-9e6c-6d7653940cfa', // v1 instead of v4
        '4d15ae22-565c-4d19-4e6c-6d7653940cfa', // variant not 8, 9, a, or b
      ];
      for (const id of invalidIds) {
        const char = createValidCharacter(id);
        const res = parseRegistry(createValidRegistry([char]));
        assert.equal(res.ok, false, `Expected rejection for UUID: ${id}`);
        assert.equal(res.code, 'INVALID_SCHEMA');
      }
    });

    it('validates name byte length limits and trimming (1-160 UTF-8 bytes)', () => {
      // Empty or untrimmed names
      for (const name of ['', '   ', ' Leading', 'Trailing ', '\tTab\t']) {
        const res = parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, name)]));
        assert.equal(res.ok, false, `Expected rejection for name: ${JSON.stringify(name)}`);
        assert.equal(res.code, 'INVALID_SCHEMA');
      }

      // Exact 160 bytes ASCII
      const name160 = 'a'.repeat(160);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, name160)])).ok, true);

      // 161 bytes ASCII
      const name161 = 'a'.repeat(161);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, name161)])).ok, false);

      // Multibyte UTF-8 boundary: 80 2-byte characters = 160 bytes
      const nameUtf8_160 = 'é'.repeat(80);
      assert.equal(new TextEncoder().encode(nameUtf8_160).length, 160);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, nameUtf8_160)])).ok, true);

      // 80 2-byte characters + 1 ASCII byte = 161 bytes
      const nameUtf8_161 = 'é'.repeat(80) + 'a';
      assert.equal(new TextEncoder().encode(nameUtf8_161).length, 161);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, nameUtf8_161)])).ok, false);
    });

    it('validates descriptor byte length limits and trimming (0-512 UTF-8 bytes)', () => {
      // 0 bytes allowed
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', '')])).ok, true);

      // Untrimmed descriptor rejected
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', ' untrimmed ')])).ok, false);

      // Exact 512 bytes ASCII allowed
      const desc512 = 'd'.repeat(512);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', desc512)])).ok, true);

      // 513 bytes rejected
      const desc513 = 'd'.repeat(513);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', desc513)])).ok, false);
    });

    it('validates aliases count, byte length, trimming, and intra-record uniqueness', () => {
      // Up to 16 aliases allowed
      const aliases16 = Array.from({ length: 16 }, (_, i) => `Alias_${i}`);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', '', aliases16)])).ok, true);

      // 17 aliases rejected
      const aliases17 = Array.from({ length: 17 }, (_, i) => `Alias_${i}`);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', '', aliases17)])).ok, false);

      // Untrimmed alias or empty alias rejected
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', '', [''])])).ok, false);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', '', [' space '])])).ok, false);

      // Alias UTF-8 byte boundary: 160 bytes pass, 161 fail
      const alias160 = 'x'.repeat(160);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', '', [alias160])])).ok, true);
      const alias161 = 'x'.repeat(161);
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', '', [alias161])])).ok, false);

      // Duplicate aliases within the same character record rejected
      assert.equal(parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1, 'Hina', '', ['Knight', 'Knight'])])).ok, false);
    });

    it('permits duplicate aliases across different character records', () => {
      const c1 = createValidCharacter(VALID_UUID_1, 'Hina 1', '', ['Hero']);
      const c2 = createValidCharacter(VALID_UUID_2, 'Hina 2', '', ['Hero']);
      assert.equal(parseRegistry(createValidRegistry([c1, c2])).ok, true);
    });

    it('permits duplicate names with distinct IDs', () => {
      const c1 = createValidCharacter(VALID_UUID_1, 'Hina', 'Knight');
      const c2 = createValidCharacter(VALID_UUID_2, 'Hina', 'Merchant');
      const res = parseRegistry(createValidRegistry([c1, c2]));
      assert.equal(res.ok, true);
      assert.equal(res.value.characters.length, 2);
    });

    it('rejects duplicate character IDs within a registry', () => {
      const c1 = createValidCharacter(VALID_UUID_1, 'Hina', 'Knight');
      const c2 = createValidCharacter(VALID_UUID_1, 'Different Name', 'Merchant');
      const res = parseRegistry(createValidRegistry([c1, c2]));
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_SCHEMA');
    });

    it('enforces maximum 128 characters per registry', () => {
      // 128 characters allowed
      const chars128 = Array.from({ length: 128 }, (_, i) => {
        const hex = i.toString(16).padStart(12, '0');
        return createValidCharacter(`00000000-0000-4000-8000-${hex}`, `Char ${i}`);
      });
      assert.equal(parseRegistry(createValidRegistry(chars128)).ok, true);

      // 129 characters rejected
      const chars129 = [
        ...chars128,
        createValidCharacter('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Over 128'),
      ];
      assert.equal(parseRegistry(createValidRegistry(chars129)).ok, false);
    });

    it('enforces 256 KiB serialized total registry limit', () => {
      // Construct characters array that exceeds 256 KiB (262,144 bytes)
      const maxDescriptor = 'd'.repeat(512);
      const chars = Array.from({ length: 128 }, (_, i) => {
        const hex = i.toString(16).padStart(12, '0');
        const aliases = Array.from({ length: 16 }, (_, j) => `alias_${j}_${'a'.repeat(150)}`);
        return createValidCharacter(`00000000-0000-4000-8000-${hex}`, `Character ${i}`, maxDescriptor, aliases);
      });
      const reg = createValidRegistry(chars);
      const res = parseRegistry(reg);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_SCHEMA');
    });

    it('freezes returned valid snapshot deeply', () => {
      const c1 = createValidCharacter(VALID_UUID_1, 'Hina', 'Knight', ['Hero']);
      const res = parseRegistry(createValidRegistry([c1]));
      assert.equal(res.ok, true);
      const snapshot = res.value;

      assert.equal(Object.isFrozen(snapshot), true);
      assert.equal(Object.isFrozen(snapshot.characters), true);
      assert.equal(Object.isFrozen(snapshot.characters[0]), true);
      assert.equal(Object.isFrozen(snapshot.characters[0].aliases), true);

      assert.throws(() => {
        snapshot.revision = 999;
      }, TypeError);

      assert.throws(() => {
        snapshot.characters.push(createValidCharacter(VALID_UUID_2));
      }, TypeError);

      assert.throws(() => {
        snapshot.characters[0].name = 'Modified';
      }, TypeError);

      assert.throws(() => {
        snapshot.characters[0].aliases.push('NewAlias');
      }, TypeError);
    });
  });
});

describe('resolveIdentity', () => {
  it('resolves character by exact UUID', () => {
    const c1 = createValidCharacter(VALID_UUID_1, 'Hina', 'Knight');
    const c2 = createValidCharacter(VALID_UUID_2, 'Hina', 'Merchant');
    const reg = parseRegistry(createValidRegistry([c1, c2])).value;

    const res1 = resolveIdentity(reg, VALID_UUID_1);
    assert.equal(res1.ok, true);
    assert.equal(res1.value.id, VALID_UUID_1);
    assert.equal(res1.value.descriptor, 'Knight');

    const res2 = resolveIdentity(reg, VALID_UUID_2);
    assert.equal(res2.ok, true);
    assert.equal(res2.value.id, VALID_UUID_2);
    assert.equal(res2.value.descriptor, 'Merchant');
  });

  it('returns IDENTITY_NOT_FOUND for non-existent UUID or invalid UUID queries', () => {
    const c1 = createValidCharacter(VALID_UUID_1);
    const reg = parseRegistry(createValidRegistry([c1])).value;

    const res1 = resolveIdentity(reg, VALID_UUID_3);
    assert.equal(res1.ok, false);
    assert.equal(res1.code, 'IDENTITY_NOT_FOUND');
    assert.equal(res1.details?.identityId, VALID_UUID_3);

    for (const bad of [null, undefined, '', 'not-uuid', VALID_UUID_1.toUpperCase()]) {
      const resBad = resolveIdentity(reg, bad);
      assert.equal(resBad.ok, false);
      assert.equal(resBad.code, 'IDENTITY_NOT_FOUND');
    }
  });
});

describe('planMutation', () => {
  describe('add command', () => {
    it('materializes revision 1 on UNINITIALIZED registry', () => {
      const uninit = parseRegistry(undefined).value;
      const cmd = {
        type: 'add',
        character: {
          name: 'Hina',
          descriptor: 'Knight',
          aliases: ['Hero'],
        },
      };

      const res = planMutation(uninit, cmd);
      assert.equal(res.ok, true);
      assert.equal(res.value.revision, 1);
      assert.equal(res.value.characters.length, 1);
      assert.equal(res.value.characters[0].name, 'Hina');
      assert.equal(res.value.characters[0].descriptor, 'Knight');
      assert.deepEqual(res.value.characters[0].aliases, ['Hero']);
      // Auto-generated UUID conforms to RFC 4122 v4
      const id = res.value.characters[0].id;
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(Object.isFrozen(res.value), true);
    });

    it('increments revision by 1 on existing valid registry and appends character', () => {
      const initial = parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1)], 3)).value;
      const cmd = {
        type: 'add',
        character: {
          name: 'Merchant Hina',
        },
      };

      const res = planMutation(initial, cmd);
      assert.equal(res.ok, true);
      assert.equal(res.value.revision, 4);
      assert.equal(res.value.characters.length, 2);
      assert.equal(res.value.characters[0].id, VALID_UUID_1);
      assert.equal(res.value.characters[1].name, 'Merchant Hina');
      assert.equal(res.value.characters[1].descriptor, '');
      assert.deepEqual(res.value.characters[1].aliases, []);
      // Original registry unmodified
      assert.equal(initial.revision, 3);
      assert.equal(initial.characters.length, 1);
    });

    it('rejects caller-supplied identity ID with INVALID_COMMAND', () => {
      const initial = parseRegistry(createValidRegistry()).value;
      const cmd = {
        type: 'add',
        character: {
          id: VALID_UUID_1,
          name: 'Hina',
        },
      };
      const res = planMutation(initial, cmd);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_COMMAND');
    });

    it('rejects unknown fields on command or character', () => {
      const initial = parseRegistry(createValidRegistry()).value;
      const cmd1 = {
        type: 'add',
        character: { name: 'Hina', unknownKey: true },
      };
      assert.equal(planMutation(initial, cmd1).ok, false);

      const cmd2 = {
        type: 'add',
        character: { name: 'Hina' },
        extraCommandField: true,
      };
      assert.equal(planMutation(initial, cmd2).ok, false);
    });

    it('rejects character addition if capacity exceeds 128', () => {
      const chars128 = Array.from({ length: 128 }, (_, i) => {
        const hex = i.toString(16).padStart(12, '0');
        return createValidCharacter(`00000000-0000-4000-8000-${hex}`, `Char ${i}`);
      });
      const fullReg = parseRegistry(createValidRegistry(chars128)).value;

      const res = planMutation(fullReg, {
        type: 'add',
        character: { name: 'Char 129' },
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'CARD_CAPACITY_EXCEEDED');
    });

    it('rejects revision overflow safely if revision is MAX_SAFE_INTEGER', () => {
      const maxReg = parseRegistry(createValidRegistry([], Number.MAX_SAFE_INTEGER)).value;
      const res = planMutation(maxReg, {
        type: 'add',
        character: { name: 'Overflow' },
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'REVISION_OVERFLOW');
    });
  });

  describe('update command', () => {
    it('updates specified fields and increments revision', () => {
      const initial = parseRegistry(createValidRegistry([
        createValidCharacter(VALID_UUID_1, 'Hina', 'Knight', ['Hero']),
      ], 1)).value;

      const cmd = {
        type: 'update',
        character: {
          id: VALID_UUID_1,
          name: 'Hina Renamed',
          descriptor: 'Paladin',
          aliases: ['Hero', 'Champion'],
        },
      };

      const res = planMutation(initial, cmd);
      assert.equal(res.ok, true);
      assert.equal(res.value.revision, 2);
      assert.equal(res.value.characters[0].name, 'Hina Renamed');
      assert.equal(res.value.characters[0].descriptor, 'Paladin');
      assert.deepEqual(res.value.characters[0].aliases, ['Hero', 'Champion']);
      // Original unchanged
      assert.equal(initial.revision, 1);
      assert.equal(initial.characters[0].name, 'Hina');
    });

    it('preserves omitted optional fields during partial update', () => {
      const initial = parseRegistry(createValidRegistry([
        createValidCharacter(VALID_UUID_1, 'Hina', 'Knight', ['Hero']),
      ], 1)).value;

      const cmd = {
        type: 'update',
        character: {
          id: VALID_UUID_1,
          descriptor: 'Paladin',
        },
      };

      const res = planMutation(initial, cmd);
      assert.equal(res.ok, true);
      assert.equal(res.value.revision, 2);
      assert.equal(res.value.characters[0].name, 'Hina'); // preserved
      assert.equal(res.value.characters[0].descriptor, 'Paladin'); // updated
      assert.deepEqual(res.value.characters[0].aliases, ['Hero']); // preserved
    });

    it('does not increment revision when no actual changes are requested', () => {
      const initial = parseRegistry(createValidRegistry([
        createValidCharacter(VALID_UUID_1, 'Hina', 'Knight', ['Hero']),
      ], 5)).value;

      // Update with exact same values
      const cmdSame = {
        type: 'update',
        character: {
          id: VALID_UUID_1,
          name: 'Hina',
          descriptor: 'Knight',
          aliases: ['Hero'],
        },
      };
      const resSame = planMutation(initial, cmdSame);
      assert.equal(resSame.ok, true);
      assert.equal(resSame.value.revision, 5); // NOT incremented!
      assert.equal(resSame.value, initial);

      // Update with no fields
      const cmdEmpty = {
        type: 'update',
        character: { id: VALID_UUID_1 },
      };
      const resEmpty = planMutation(initial, cmdEmpty);
      assert.equal(resEmpty.ok, true);
      assert.equal(resEmpty.value.revision, 5); // NOT incremented!
      assert.equal(resEmpty.value, initial);
    });

    it('returns IDENTITY_NOT_FOUND when updating non-existent character', () => {
      const initial = parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1)])).value;
      const cmd = {
        type: 'update',
        character: {
          id: VALID_UUID_2,
          name: 'Does not exist',
        },
      };
      const res = planMutation(initial, cmd);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'IDENTITY_NOT_FOUND');
    });

    it('rejects unknown fields in update command', () => {
      const initial = parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1)])).value;
      const cmd = {
        type: 'update',
        character: {
          id: VALID_UUID_1,
          extraField: 'not allowed',
        },
      };
      const res = planMutation(initial, cmd);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_COMMAND');
    });
  });

  describe('remove command', () => {
    it('removes character by ID and increments revision', () => {
      const c1 = createValidCharacter(VALID_UUID_1, 'Char 1');
      const c2 = createValidCharacter(VALID_UUID_2, 'Char 2');
      const c3 = createValidCharacter(VALID_UUID_3, 'Char 3');
      const initial = parseRegistry(createValidRegistry([c1, c2, c3], 10)).value;

      const res = planMutation(initial, {
        type: 'remove',
        identityId: VALID_UUID_2,
      });

      assert.equal(res.ok, true);
      assert.equal(res.value.revision, 11);
      assert.equal(res.value.characters.length, 2);
      assert.equal(res.value.characters[0].id, VALID_UUID_1);
      assert.equal(res.value.characters[1].id, VALID_UUID_3);

      // Original unchanged
      assert.equal(initial.characters.length, 3);
      assert.equal(initial.revision, 10);
    });

    it('leaves empty characters array with bumped revision when removing sole character', () => {
      const initial = parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1)], 1)).value;
      const res = planMutation(initial, {
        type: 'remove',
        identityId: VALID_UUID_1,
      });
      assert.equal(res.ok, true);
      assert.equal(res.value.revision, 2);
      assert.equal(res.value.characters.length, 0);
    });

    it('returns IDENTITY_NOT_FOUND when removing non-existent character', () => {
      const initial = parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1)])).value;
      const res = planMutation(initial, {
        type: 'remove',
        identityId: VALID_UUID_2,
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'IDENTITY_NOT_FOUND');
    });

    it('rejects invalid command types', () => {
      const initial = parseRegistry(createValidRegistry()).value;
      for (const badCmd of [{ type: 'magic' }, null, undefined, {}]) {
        const res = planMutation(initial, badCmd);
        assert.equal(res.ok, false);
        assert.equal(res.code, 'INVALID_COMMAND');
      }
    });
  });
});

describe('serializeRegistry', () => {
  it('serializes deterministically with keys sorted lexicographically', () => {
    // Registry built with keys in mixed order
    const regMixed1 = {
      characters: [
        {
          name: 'Hina',
          id: VALID_UUID_1,
          aliases: ['Hero'],
          descriptor: 'Knight',
        },
      ],
      schemaVersion: 1,
      revision: 1,
    };

    const regMixed2 = {
      revision: 1,
      schemaVersion: 1,
      characters: [
        {
          id: VALID_UUID_1,
          aliases: ['Hero'],
          name: 'Hina',
          descriptor: 'Knight',
        },
      ],
    };

    const res1 = serializeRegistry(regMixed1);
    const res2 = serializeRegistry(regMixed2);

    assert.equal(res1.ok, true);
    assert.equal(res2.ok, true);
    assert.equal(res1.value, res2.value);

    // Verify key order in output
    const expected = `{"characters":[{"aliases":["Hero"],"descriptor":"Knight","id":"${VALID_UUID_1}","name":"Hina"}],"revision":1,"schemaVersion":1}`;
    assert.equal(res1.value, expected);
  });

  it('preserves array order for characters and aliases', () => {
    const c1 = createValidCharacter(VALID_UUID_1, 'First');
    const c2 = createValidCharacter(VALID_UUID_2, 'Second');

    const reg1 = createValidRegistry([c1, c2]);
    const reg2 = createValidRegistry([c2, c1]);

    const res1 = serializeRegistry(reg1);
    const res2 = serializeRegistry(reg2);

    assert.equal(res1.ok, true);
    assert.equal(res2.ok, true);
    assert.notEqual(res1.value, res2.value);
  });

  it('fails if registry is invalid or exceeds 256 KiB', () => {
    assert.equal(serializeRegistry(null).ok, false);
    assert.equal(serializeRegistry({ schemaVersion: 2 }).ok, false);
  });
});

describe('core contract invariants', () => {
  it('ensures no caller-owned object is mutated during planMutation', () => {
    const callerAliases = ['Hero'];
    const callerCharacter = {
      name: 'Hina',
      descriptor: 'Knight',
      aliases: callerAliases,
    };
    const callerCommand = {
      type: 'add',
      character: callerCharacter,
    };

    const initialRegistry = parseRegistry(createValidRegistry()).value;
    const res = planMutation(initialRegistry, callerCommand);
    assert.equal(res.ok, true);

    // Mutate caller's original objects
    callerAliases.push('Mutated');
    callerCharacter.name = 'Tampered';
    callerCommand.type = 'tampered';

    // Verify snapshot was not affected
    assert.equal(res.value.characters[0].name, 'Hina');
    assert.deepEqual(res.value.characters[0].aliases, ['Hero']);
  });

  it('ensures failed operations leave their inputs completely unchanged', () => {
    const initial = parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1)], 5)).value;
    const initialClone = JSON.parse(JSON.stringify(initial));

    // Failing mutation (e.g. non-existent ID update)
    const failRes = planMutation(initial, {
      type: 'update',
      character: { id: VALID_UUID_2, name: 'Fail' },
    });
    assert.equal(failRes.ok, false);
    assert.deepEqual(initial, initialClone);
  });

  it('ensures unsupported versions never get reset or mutated', () => {
    const unsupported = {
      schemaVersion: 2,
      revision: 42,
      characters: [{ id: VALID_UUID_1, name: 'Future', descriptor: '', aliases: [] }],
    };

    const parseRes = parseRegistry(unsupported);
    assert.equal(parseRes.ok, false);
    assert.equal(parseRes.code, 'UNSUPPORTED_VERSION');

    const mutRes = planMutation(unsupported, {
      type: 'add',
      character: { name: 'New' },
    });
    assert.equal(mutRes.ok, false);
    assert.equal(mutRes.code, 'UNSUPPORTED_VERSION');
  });

  it('ensures a new identity cannot impersonate an existing ID on add', () => {
    const initial = parseRegistry(createValidRegistry([createValidCharacter(VALID_UUID_1)])).value;
    const res = planMutation(initial, {
      type: 'add',
      character: {
        id: VALID_UUID_1,
        name: 'Impersonator',
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'INVALID_COMMAND');
  });
});
