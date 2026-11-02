import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsConstants from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createFileStore,
  isValidAvatar,
  FILE_STORE_LIMITS,
  FILE_STORE_ERROR_CODES,
  DIAGNOSTIC_REASONS,
} from '../src/sidecar-file-store.mjs';

import {
  parseSidecarState,
  serializeSidecarState,
} from '../src/sidecar-state.mjs';

// --- Test Fixtures & Helpers ---

const VALID_CARD_ID_1 = '028923e8-f23a-45c0-84a0-1a68b0dff234';
const VALID_CARD_ID_2 = '11111111-2222-4333-8444-555555555555';
const VALID_CARD_ID_3 = '99999999-8888-4777-8666-555555555555';
const VALID_CARD_ID_4 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function createValidCharacter(id = '4d15ae22-565c-4d19-9e6c-6d7653940cfa', name = 'Alice', descriptor = 'A test character', aliases = []) {
  return {
    aliases,
    descriptor,
    id,
    name,
  };
}

function createValidState(overrides = {}) {
  const cardId = overrides.cardId !== undefined ? overrides.cardId : VALID_CARD_ID_1;
  const avatar = overrides.avatar !== undefined ? overrides.avatar : 'test_char.png';
  const storageRevision = overrides.storageRevision !== undefined ? overrides.storageRevision : 1;
  const characters = overrides.characters !== undefined ? overrides.characters : [createValidCharacter()];
  const revision = overrides.revision !== undefined ? overrides.revision : 0;

  return {
    avatar,
    cardId,
    registry: {
      characters,
      revision,
      schemaVersion: 1,
    },
    schemaVersion: 1,
    storageRevision,
  };
}

/**
 * Creates a schema-valid C0 sidecar state that serializes to ~260 KiB.
 * An inner registry is capped at 256 KiB (262,144 bytes).
 * We construct ~128 characters each with ~450 byte descriptor and 1 alias of ~150 bytes.
 */
function createLargeValidState(cardId = VALID_CARD_ID_1, avatar = 'large_char.png') {
  const characters = [];
  const padDesc = 'D'.repeat(450);
  const aliases = [];
  for (let a = 0; a < 10; a++) {
    aliases.push(`alias_${a}_` + 'A'.repeat(120));
  }

  for (let i = 0; i < 128; i++) {
    const charUuid = `10000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    characters.push({
      aliases,
      descriptor: padDesc,
      id: charUuid,
      name: `Char_${i}`,
    });
  }

  return {
    avatar,
    cardId,
    registry: {
      characters,
      revision: 0,
      schemaVersion: 1,
    },
    schemaVersion: 1,
    storageRevision: 1,
  };
}

describe('SidecarFileStore (H01-B3-D2-C1)', () => {
  let tempBaseDir;
  let userRoot;
  let charactersRoot;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chromatic-test-'));
    userRoot = path.join(tempBaseDir, 'user');
    charactersRoot = path.join(tempBaseDir, 'characters');
    await fs.mkdir(userRoot, { mode: 0o700 });
    await fs.mkdir(charactersRoot, { mode: 0o700 });
  });

  afterEach(async () => {
    if (tempBaseDir) {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  // --- Guardrail A: Avatar Validation Parity ---
  describe('Guardrail A: Local isValidAvatar C0 Parity', () => {
    it('accepts valid PNG filenames with Unicode and case preservation', () => {
      assert.strictEqual(isValidAvatar('Example_Character.png'), true);
      assert.strictEqual(isValidAvatar('Hero.PNG'), true);
      assert.strictEqual(isValidAvatar('Character-2.png'), true);
      assert.strictEqual(isValidAvatar('日本語キャラ.png'), true);
    });

    it('rejects non-PNG extensions, slashes, control chars, empty or stem-only names', () => {
      assert.strictEqual(isValidAvatar('char.jpg'), false);
      assert.strictEqual(isValidAvatar('char.png.txt'), false);
      assert.strictEqual(isValidAvatar('subdir/char.png'), false);
      assert.strictEqual(isValidAvatar('..\\char.png'), false);
      assert.strictEqual(isValidAvatar('char\0.png'), false);
      assert.strictEqual(isValidAvatar('.png'), false);
      assert.strictEqual(isValidAvatar('..png'), false);
      assert.strictEqual(isValidAvatar('   .png'), false);
      assert.strictEqual(isValidAvatar(''), false);
      assert.strictEqual(isValidAvatar(null), false);
      assert.strictEqual(isValidAvatar(123), false);
    });

    it('has exact parity with parseSidecarState avatar rejection', () => {
      const invalidAvatars = [
        'bad.jpg',
        'dir/bad.png',
        '..\\bad.png',
        '.png',
        '..png',
        '   .png',
        'a'.repeat(252) + '.png', // 256 bytes total > 255
      ];
      for (const badAv of invalidAvatars) {
        assert.strictEqual(isValidAvatar(badAv), false);
        const testState = createValidState({ avatar: badAv });
        const c0Result = parseSidecarState(testState);
        assert.strictEqual(c0Result.ok, false);
      }
    });
  });

  // --- Suite 1: Construction & Options Validation ---
  describe('Suite 1: Construction & Options Validation', () => {
    it('T01: accepts valid options and returns frozen instance', () => {
      const store = createFileStore();
      assert.strictEqual(typeof store.scanStore, 'function');
      assert.strictEqual(typeof store.readState, 'function');
      assert.strictEqual(typeof store.createState, 'function');
      assert.strictEqual(typeof store.replaceState, 'function');
      assert.strictEqual(typeof store.observeAvatar, 'function');
      assert.strictEqual(Object.isFrozen(store), true);
    });

    it('T01-B: rejects non-plain object or invalid options properties', () => {
      assert.throws(() => createFileStore(null), TypeError);
      assert.throws(() => createFileStore('invalid'), TypeError);
      assert.throws(() => createFileStore([]), TypeError);
      assert.throws(() => createFileStore({ unknownProp: 123 }), TypeError);
      const symbolKey = Symbol('sym');
      assert.throws(() => createFileStore({ [symbolKey]: 123 }), TypeError);
    });

    it('T01-C: G4-R3: factory rejects unknown option properties with constant message without reflecting secret or untrusted keys', () => {
      const secretKey = 'PRIVATE_OPTION_TOKEN_SECRET_987';
      const longKey = 'A'.repeat(5000);
      const unusualKey = '<script>alert("xss")</script>\x00\r\n';

      for (const key of [secretKey, longKey, unusualKey]) {
        assert.throws(
          () => createFileStore({ [key]: true }),
          (err) => {
            assert.strictEqual(err instanceof TypeError, true);
            assert.strictEqual(err.message, 'Unknown option property');
            assert.strictEqual(err.message.includes(key), false, 'error message must not reflect untrusted key');
            return true;
          }
        );
      }
    });

    it('T02: enforces limit bounds at construction', () => {
      assert.throws(() => createFileStore({ limits: { maxCardDirectories: 513 } }), RangeError);
      assert.throws(() => createFileStore({ limits: { maxCardDirectories: 0 } }), RangeError);
      assert.throws(() => createFileStore({ limits: { maxAggregateBytes: 33554433 } }), RangeError);
      assert.throws(() => createFileStore({ limits: { maxStateBytes: 307201 } }), RangeError);
      assert.throws(() => createFileStore({ limits: { maxObservedAvatars: 513 } }), RangeError);
    });
  });

  // --- Suite 2: Scan Store — Clean Absent Store ---
  describe('Suite 2: Scan Store — Clean Absent Store', () => {
    it('T03: returns complete empty evidence with ZERO filesystem writes', async () => {
      const store = createFileStore();
      const res = await store.scanStore({ userRoot, charactersRoot });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.value.scanStatus, 'COMPLETE');
      assert.strictEqual(res.value.schemaVersion, 1);
      assert.strictEqual(res.value.claims.length, 0);
      assert.strictEqual(res.value.files.length, 0);

      // Verify zero writes: chromaticHub directory must still not exist
      await assert.rejects(async () => {
        await fs.lstat(path.join(userRoot, 'chromaticHub'));
      }, { code: 'ENOENT' });
    });

    it('T04: observes requested avatars under clean absent store', async () => {
      // Put a character in charactersRoot
      await fs.writeFile(path.join(charactersRoot, 'present.png'), 'fake-png-content');

      const store = createFileStore();
      const res = await store.scanStore({
        userRoot,
        charactersRoot,
        observedAvatars: ['present.png', 'missing.png'],
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.value.claims.length, 0);
      assert.strictEqual(res.value.files.length, 2);

      const presentFile = res.value.files.find((f) => f.avatar === 'present.png');
      const missingFile = res.value.files.find((f) => f.avatar === 'missing.png');
      assert.deepStrictEqual(presentFile, { avatar: 'present.png', status: 'EXISTS' });
      assert.deepStrictEqual(missingFile, { avatar: 'missing.png', status: 'MISSING' });

      // chromaticHub must remain absent
      await assert.rejects(async () => {
        await fs.lstat(path.join(userRoot, 'chromaticHub'));
      }, { code: 'ENOENT' });
    });
  });

  // --- Suite 3: Scan Store — Complete Valid Stores ---
  describe('Suite 3: Scan Store — Complete Valid Stores', () => {
    it('T08-A: scans valid cards and sorts claims strictly lexicographically', async () => {
      const store = createFileStore();
      await fs.writeFile(path.join(charactersRoot, 'charA.png'), 'png1');
      await fs.writeFile(path.join(charactersRoot, 'charB.png'), 'png2');

      // Create card with VALID_CARD_ID_2 (starts with 1)
      const state2 = createValidState({ cardId: VALID_CARD_ID_2, avatar: 'charB.png' });
      await store.createState({ userRoot, state: state2 });

      // Create card with VALID_CARD_ID_1 (starts with 0)
      const state1 = createValidState({ cardId: VALID_CARD_ID_1, avatar: 'charA.png' });
      await store.createState({ userRoot, state: state1 });

      const scanRes = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(scanRes.ok, true);
      assert.strictEqual(scanRes.value.claims.length, 2);

      // Verify lexicographical order: VALID_CARD_ID_1 (0289...) comes before VALID_CARD_ID_2 (1111...)
      assert.strictEqual(scanRes.value.claims[0].cardId, VALID_CARD_ID_1);
      assert.strictEqual(scanRes.value.claims[1].cardId, VALID_CARD_ID_2);
    });

    it('T21: preserves competing claims with identical avatar', async () => {
      const store = createFileStore();
      await fs.writeFile(path.join(charactersRoot, 'shared.png'), 'png');

      const state1 = createValidState({ cardId: VALID_CARD_ID_1, avatar: 'shared.png' });
      const state2 = createValidState({ cardId: VALID_CARD_ID_2, avatar: 'shared.png' });
      await store.createState({ userRoot, state: state1 });
      await store.createState({ userRoot, state: state2 });

      const scanRes = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(scanRes.ok, true);
      assert.strictEqual(scanRes.value.claims.length, 2);
      assert.strictEqual(scanRes.value.claims[0].avatar, 'shared.png');
      assert.strictEqual(scanRes.value.claims[1].avatar, 'shared.png');
      assert.strictEqual(scanRes.value.files.length, 1);
      assert.strictEqual(scanRes.value.files[0].status, 'EXISTS');
    });

    it('T22: preserves valid orphan claim with MISSING file observation', async () => {
      const store = createFileStore();
      // 'orphan.png' is NOT written to charactersRoot
      const state = createValidState({ cardId: VALID_CARD_ID_1, avatar: 'orphan.png' });
      await store.createState({ userRoot, state });

      const scanRes = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(scanRes.ok, true);
      assert.strictEqual(scanRes.value.claims.length, 1);
      assert.strictEqual(scanRes.value.claims[0].avatar, 'orphan.png');
      assert.strictEqual(scanRes.value.files.length, 1);
      assert.strictEqual(scanRes.value.files[0].status, 'MISSING');
    });
  });

  // --- Suite 4: Scan Store — Incomplete / Damaged Store Detection ---
  describe('Suite 4: Scan Store — Incomplete / Damaged Store Detection', () => {
    it('T05: fails with STORAGE_UNAVAILABLE if chromaticHub exists but cards/ missing', async () => {
      await fs.mkdir(path.join(userRoot, 'chromaticHub'), { mode: 0o700 });
      const store = createFileStore();
      const res = await store.scanStore({ userRoot, charactersRoot });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.INCOMPLETE_STORE);
    });

    it('T06: fails with STORAGE_UNAVAILABLE on non-directory entry in cards/', async () => {
      const cardsDir = path.join(userRoot, 'chromaticHub', 'cards');
      await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(cardsDir, 'stray-file.txt'), 'stray');

      const store = createFileStore();
      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY);
    });

    it('T07: fails with STORAGE_UNAVAILABLE on non-UUID folder in cards/', async () => {
      const cardsDir = path.join(userRoot, 'chromaticHub', 'cards');
      await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(cardsDir, 'not-a-uuid'), { mode: 0o700 });

      const store = createFileStore();
      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY);
    });

    it('T10: fails with DIR_RESIDUE_DETECTED if secondary file exists alongside state.json', async () => {
      const store = createFileStore();
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      await store.createState({ userRoot, state });

      // Add unexpected file
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.writeFile(path.join(cardDir, 'notes.txt'), 'extra');

      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.DIR_RESIDUE_DETECTED);
    });

    it('T11: fails with DIR_RESIDUE_DETECTED if leftover .tmp file exists', async () => {
      const store = createFileStore();
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      await store.createState({ userRoot, state });

      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.writeFile(path.join(cardDir, '.tmp-residue.tmp'), 'residue');

      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.DIR_RESIDUE_DETECTED);
    });

    it('T12: fails with MISSING_STATE_JSON if card directory has no state.json', async () => {
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.mkdir(cardDir, { recursive: true, mode: 0o700 });

      const store = createFileStore();
      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.MISSING_STATE_JSON);
    });

    it('T19: fails with CARD_ID_MISMATCH if folder UUID does not match inner cardId', async () => {
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.mkdir(cardDir, { recursive: true, mode: 0o700 });
      // State contains VALID_CARD_ID_2
      const mismatchedState = createValidState({ cardId: VALID_CARD_ID_2 });
      await fs.writeFile(path.join(cardDir, 'state.json'), JSON.stringify(mismatchedState));

      const store = createFileStore();
      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, 'CARD_ID_MISMATCH');
    });

    it('T20: fails with INVALID_SCHEMA if state.json is malformed JSON', async () => {
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.mkdir(cardDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(cardDir, 'state.json'), '{ malformed json: true');

      const store = createFileStore();
      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.INVALID_SCHEMA);
    });

    it('Finding D: hub residue — chromaticHub containing unexpected file fails with UNEXPECTED_ENTRY', async () => {
      const hubDir = path.join(userRoot, 'chromaticHub');
      const cardsDir = path.join(hubDir, 'cards');
      await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(hubDir, 'unexpected.txt'), 'bad');

      const store = createFileStore();
      const scanRes = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(scanRes.ok, false);
      assert.strictEqual(scanRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(scanRes.details?.reason, DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY);

      const readRes = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(readRes.ok, false);
      assert.strictEqual(readRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(readRes.details?.reason, DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY);

      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const createRes = await store.createState({ userRoot, state });
      assert.strictEqual(createRes.ok, false);
      assert.strictEqual(createRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(createRes.details?.reason, DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY);

      const replaceRes = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes: serializeSidecarState(state).value,
        nextState: state,
      });
      assert.strictEqual(replaceRes.ok, false);
      assert.strictEqual(replaceRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(replaceRes.details?.reason, DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY);
    });

    it('Finding D: hub residue — chromaticHub containing unexpected directory fails with UNEXPECTED_ENTRY', async () => {
      const hubDir = path.join(userRoot, 'chromaticHub');
      const cardsDir = path.join(hubDir, 'cards');
      await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(hubDir, 'unexpected-dir'), { mode: 0o700 });

      const store = createFileStore();
      const scanRes = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(scanRes.ok, false);
      assert.strictEqual(scanRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(scanRes.details?.reason, DIAGNOSTIC_REASONS.UNEXPECTED_ENTRY);
    });

    it('Finding C: symlinked ancestor — chromaticHub as symlink fails with SYMLINK_DETECTED', async () => {
      const realHub = path.join(tempBaseDir, 'realHub');
      await fs.mkdir(path.join(realHub, 'cards'), { recursive: true, mode: 0o700 });
      await fs.symlink(realHub, path.join(userRoot, 'chromaticHub'));

      const store = createFileStore();
      const scanRes = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(scanRes.ok, false);
      assert.strictEqual(scanRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(scanRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);

      const readRes = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(readRes.ok, false);
      assert.strictEqual(readRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(readRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);

      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const createRes = await store.createState({ userRoot, state });
      assert.strictEqual(createRes.ok, false);
      assert.strictEqual(createRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(createRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);

      const replaceRes = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes: serializeSidecarState(state).value,
        nextState: state,
      });
      assert.strictEqual(replaceRes.ok, false);
      assert.strictEqual(replaceRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(replaceRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);
    });

    it('Finding C: symlinked ancestor — cards as symlink fails with SYMLINK_DETECTED', async () => {
      const hubDir = path.join(userRoot, 'chromaticHub');
      await fs.mkdir(hubDir, { mode: 0o700 });
      const realCards = path.join(tempBaseDir, 'realCards');
      await fs.mkdir(realCards, { mode: 0o700 });
      await fs.symlink(realCards, path.join(hubDir, 'cards'));

      const store = createFileStore();
      const scanRes = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(scanRes.ok, false);
      assert.strictEqual(scanRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(scanRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);

      const readRes = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(readRes.ok, false);
      assert.strictEqual(readRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(readRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);

      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const createRes = await store.createState({ userRoot, state });
      assert.strictEqual(createRes.ok, false);
      assert.strictEqual(createRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(createRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);

      const replaceRes = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes: serializeSidecarState(state).value,
        nextState: state,
      });
      assert.strictEqual(replaceRes.ok, false);
      assert.strictEqual(replaceRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(replaceRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);
    });

    it('Finding C: symlinked card directory fails with SYMLINK_DETECTED', async () => {
      const hubDir = path.join(userRoot, 'chromaticHub');
      const cardsDir = path.join(hubDir, 'cards');
      await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });
      const realCardDir = path.join(tempBaseDir, 'realCard');
      await fs.mkdir(realCardDir, { mode: 0o700 });
      await fs.symlink(realCardDir, path.join(cardsDir, VALID_CARD_ID_1));

      const store = createFileStore();
      const readRes = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(readRes.ok, false);
      assert.strictEqual(readRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(readRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);

      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const replaceRes = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes: serializeSidecarState(state).value,
        nextState: state,
      });
      assert.strictEqual(replaceRes.ok, false);
      assert.strictEqual(replaceRes.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(replaceRes.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);
    });
  });

  // --- Suite 5: Resource Bounds & Caps ---
  describe('Suite 5: Resource Bounds & Caps', () => {
    it('T09: boundary probe on the 513th entry terminates scan immediately with SCAN_BUDGET_EXCEEDED', async () => {
      // Configure a small limit store with maxCardDirectories: 3 to test the N+1 boundary probe deterministically
      const store = createFileStore({ limits: { maxCardDirectories: 3 } });
      const cardsDir = path.join(userRoot, 'chromaticHub', 'cards');
      await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });

      // Create 4 card directories
      for (let i = 0; i < 4; i++) {
        const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
        const dir = path.join(cardsDir, id);
        await fs.mkdir(dir, { mode: 0o700 });
        const st = createValidState({ cardId: id, avatar: `c_${i}.png` });
        await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(st));
      }

      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.SCAN_BUDGET_EXCEEDED);
    });

    it('T16: fails with BYTE_LIMIT_EXCEEDED if single state file exceeds 300 KiB', async () => {
      const store = createFileStore();
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.mkdir(cardDir, { recursive: true, mode: 0o700 });
      // Create a file > 307200 bytes
      const bigFile = Buffer.alloc(307201, 32); // spaces
      await fs.writeFile(path.join(cardDir, 'state.json'), bigFile);

      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED);
    });

    it('T17: fails with BYTE_LIMIT_EXCEEDED if file grows during bounded read loop past 300 KiB', async () => {
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.mkdir(cardDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(cardDir, 'state.json'), '{"small":true}');
      const realStat = await fs.lstat(path.join(cardDir, 'state.json'));

      // Mock fsOps.open where handle.stat() reports small size, but read() returns > 307200 bytes
      const customFsOps = {
        open: async (p, flags, mode) => {
          if (p.endsWith('state.json')) {
            let offset = 0;
            const totalToDeliver = 310000;
            return {
              stat: async () => ({
                isFile: () => true,
                isSymbolicLink: () => false,
                nlink: 1,
                size: 100, // deceptive stat!
                dev: realStat.dev,
                ino: realStat.ino,
              }),
              read: async (buf, bufOffset, length) => {
                if (offset >= totalToDeliver) {
                  return { bytesRead: 0 };
                }
                const toRead = Math.min(length, totalToDeliver - offset);
                buf.fill(32, bufOffset, bufOffset + toRead);
                offset += toRead;
                return { bytesRead: toRead };
              },
              close: async () => {},
            };
          }
          return fs.open(p, flags, mode);
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const res = await store.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED);
    });

    it('T18: Guardrail E: aggregate 32-MiB crossing test with 130 schema-valid C0 states', async () => {
      // To test the aggregate limit deterministically without writing 33 MiB to disk on every test run,
      // we test with a configured smaller aggregate limit (e.g. 500 KiB) with 5 valid ~220 KiB states,
      // verifying that each state individually passes C0 validation and the aggregate budget triggers.
      const storeWithSmallCap = createFileStore({ limits: { maxAggregateBytes: 500000 } });
      const cardsDir = path.join(userRoot, 'chromaticHub', 'cards');
      await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });

      // Create 5 large schema-valid states (~220 KiB each -> 1.1 MiB total > 500 KiB)
      for (let i = 0; i < 5; i++) {
        const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
        const dir = path.join(cardsDir, id);
        await fs.mkdir(dir, { mode: 0o700 });
        const largeState = createLargeValidState(id, `c_${i}.png`);

        // Verify it individually passes C0 parseSidecarState
        const parsed = parseSidecarState(largeState);
        assert.strictEqual(parsed.ok, true);

        const serialized = serializeSidecarState(parsed.value).value;
        assert.strictEqual(Buffer.byteLength(serialized, 'utf8') > 200000, true);
        await fs.writeFile(path.join(dir, 'state.json'), serialized);
      }

      const res = await storeWithSmallCap.scanStore({ userRoot, charactersRoot });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.BYTE_LIMIT_EXCEEDED);
    });

    it('T27: fails with SCAN_BUDGET_EXCEEDED if deduplicated avatar union exceeds 512', async () => {
      const storeWithAvatarCap = createFileStore({ limits: { maxObservedAvatars: 5 } });
      const requestedAvatars = ['a1.png', 'a2.png', 'a3.png', 'a4.png', 'a5.png', 'a6.png'];

      const res = await storeWithAvatarCap.scanStore({
        userRoot,
        charactersRoot,
        observedAvatars: requestedAvatars,
      });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.SCAN_BUDGET_EXCEEDED);
    });
  });

  // --- Suite 6: Avatar Observation ---
  describe('Suite 6: Avatar Observation', () => {
    it('T23: returns SYMLINK_DETECTED if avatar is a symlink (never MISSING)', async () => {
      const realFile = path.join(tempBaseDir, 'real.png');
      await fs.writeFile(realFile, 'png-content');
      await fs.symlink(realFile, path.join(charactersRoot, 'symlink.png'));

      const store = createFileStore();
      const res = await store.observeAvatar({ charactersRoot, avatar: 'symlink.png' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.SYMLINK_DETECTED);
    });

    it('T24: returns HARDLINK_DETECTED if avatar has hardlink (nlink > 1)', async () => {
      const targetPath = path.join(charactersRoot, 'orig.png');
      await fs.writeFile(targetPath, 'png-content');
      await fs.link(targetPath, path.join(charactersRoot, 'hardlink.png'));

      const store = createFileStore();
      const res = await store.observeAvatar({ charactersRoot, avatar: 'hardlink.png' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.HARDLINK_DETECTED);
    });

    it('T25: returns UNEXPECTED_FILE_TYPE if avatar is a directory', async () => {
      await fs.mkdir(path.join(charactersRoot, 'dir.png'), { mode: 0o700 });

      const store = createFileStore();
      const res = await store.observeAvatar({ charactersRoot, avatar: 'dir.png' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.UNEXPECTED_FILE_TYPE);
    });

    it('T26: returns CHARACTERS_ROOT_UNAVAILABLE if charactersRoot does not exist', async () => {
      const store = createFileStore();
      const res = await store.observeAvatar({
        charactersRoot: path.join(tempBaseDir, 'non-existent-root'),
        avatar: 'char.png',
      });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.CHARACTERS_ROOT_UNAVAILABLE);
    });
  });

  // --- Suite 7: State Creation (createState) ---
  describe('Suite 7: State Creation (createState)', () => {
    it('T30: successfully creates state with full sync sequence, 0700 dirs, 0600 file', async () => {
      const store = createFileStore();
      const state = createValidState({ cardId: VALID_CARD_ID_1, avatar: 'new_char.png' });

      const res = await store.createState({ userRoot, state });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changed, true);
      assert.strictEqual(res.value.cardId, VALID_CARD_ID_1);

      // Verify file and directory permissions
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const cardDirStat = await fs.stat(cardDir);
      assert.strictEqual((cardDirStat.mode & 0o777).toString(8), '700');

      const statePath = path.join(cardDir, 'state.json');
      const stateStat = await fs.stat(statePath);
      assert.strictEqual((stateStat.mode & 0o777).toString(8), '600');

      // Verify content
      const content = await fs.readFile(statePath, 'utf8');
      assert.strictEqual(content, serializeSidecarState(state).value);
    });

    it('T28: refuses creation with ALREADY_BOUND if card directory already exists', async () => {
      const store = createFileStore();
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      await store.createState({ userRoot, state });

      // Second attempt must fail with ALREADY_BOUND
      const res = await store.createState({ userRoot, state });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.ALREADY_BOUND);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.DIRECTORY_EXISTS);
    });

    it('T29: refuses creation with ALREADY_BOUND if card directory exists empty or incomplete', async () => {
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.mkdir(cardDir, { recursive: true, mode: 0o700 });

      const store = createFileStore();
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.ALREADY_BOUND);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.DIRECTORY_EXISTS);
    });

    it('Guardrail C: fails closed with INCOMPLETE_STORE and does NOT repair if chromaticHub exists but cards/ missing', async () => {
      await fs.mkdir(path.join(userRoot, 'chromaticHub'), { mode: 0o700 });

      const store = createFileStore();
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.INCOMPLETE_STORE);

      // Verify cards/ was NOT created
      await assert.rejects(async () => {
        await fs.lstat(path.join(userRoot, 'chromaticHub', 'cards'));
      }, { code: 'ENOENT' });
    });

    it('T30-A: Finding A: createState handles chunked writes via bounded writeBufferFully loop', async () => {
      const realOpen = fs.open.bind(fs);
      let chunksWritten = 0;
      const chunkedFsOps = {
        open: async (filePath, flags, mode) => {
          const handle = await realOpen(filePath, flags, mode);
          if (typeof filePath === 'string' && filePath.endsWith('.tmp')) {
            const origWrite = handle.write.bind(handle);
            handle.write = async (buf, offset = 0, length = buf.length, position = null) => {
              const chunkLen = Math.min(48, length);
              chunksWritten++;
              return origWrite(buf, offset, chunkLen, position);
            };
          }
          return handle;
        },
      };

      const store = createFileStore({ fsOps: chunkedFsOps });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changed, true);
      assert.ok(chunksWritten > 1, `Expected multiple chunk writes, got ${chunksWritten}`);

      const statePath = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1, 'state.json');
      const content = await fs.readFile(statePath, 'utf8');
      assert.strictEqual(content, serializeSidecarState(state).value);
    });

    it('T30-B: Finding A: createState fails with TEMP_WRITE_FAILED on zero progress and preserves temp residue', async () => {
      const realOpen = fs.open.bind(fs);
      const zeroProgressFsOps = {
        open: async (filePath, flags, mode) => {
          const handle = await realOpen(filePath, flags, mode);
          if (typeof filePath === 'string' && filePath.endsWith('.tmp')) {
            handle.write = async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
          }
          return handle;
        },
      };

      const store = createFileStore({ fsOps: zeroProgressFsOps });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED);

      // Verify canonical state.json was NOT created
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await assert.rejects(async () => {
        await fs.lstat(path.join(cardDir, 'state.json'));
      }, { code: 'ENOENT' });

      // Verify temp file was preserved as forensic residue
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T30-C: Finding B: createState catches late state.json injected at create:before-rename', async () => {
      const hook = async (point) => {
        if (point === 'create:before-rename') {
          const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
          const statePath = path.join(cardDir, 'state.json');
          await fs.writeFile(statePath, '{"injected":true}', { mode: 0o600 });
        }
      };

      const store = createFileStore({ faultHook: hook });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);

      // Verify canonical state.json was NOT overwritten
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const stateContent = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      assert.strictEqual(stateContent, '{"injected":true}');

      // Verify staged temp file was preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T30-D: Finding B: createState catches late foreign residue injected at create:before-rename', async () => {
      const hook = async (point) => {
        if (point === 'create:before-rename') {
          const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
          await fs.writeFile(path.join(cardDir, 'late-intruder.txt'), 'intruder');
        }
      };

      const store = createFileStore({ faultHook: hook });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);

      // Verify canonical state.json was NOT created
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await assert.rejects(async () => {
        await fs.lstat(path.join(cardDir, 'state.json'));
      }, { code: 'ENOENT' });

      // Verify staged temp file was preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T30-E: G4-R2: createState rejects same-length content tampering injected at create:before-rename', async () => {
      let renameCalls = 0;
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);

      const hook = async (point) => {
        if (point === 'create:before-rename') {
          const entries = await fs.readdir(cardDir);
          const tempFileName = entries.find((e) => e.startsWith('.tmp-'));
          assert.ok(tempFileName, 'temp file must exist at create:before-rename');
          const tempFilePath = path.join(cardDir, tempFileName);

          const originalContent = await fs.readFile(tempFilePath, 'utf8');
          // Tamper with valid JSON of exact same byte length
          const tamperedContent = originalContent.includes('"storageRevision":1')
            ? originalContent.replace('"storageRevision":1', '"storageRevision":2')
            : originalContent.replace('"schemaVersion":1', '"schemaVersion":2');
          assert.strictEqual(
            Buffer.byteLength(tamperedContent, 'utf8'),
            Buffer.byteLength(originalContent, 'utf8')
          );
          assert.notStrictEqual(tamperedContent, originalContent);
          await fs.writeFile(tempFilePath, tamperedContent, 'utf8');
        }
      };

      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ faultHook: hook, fsOps: customFsOps });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);
      assert.strictEqual(renameCalls, 0, 'rename must not be dispatched on same-length tamper');

      // Canonical state.json must be strictly absent
      await assert.rejects(async () => {
        await fs.lstat(path.join(cardDir, 'state.json'));
      }, { code: 'ENOENT' });

      // Forensic temp file must be preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T30-F: G4-R2: createState rejects temp pathname inode substitution injected at create:before-rename', async () => {
      let renameCalls = 0;
      let heldHandle = null;
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);

      const hook = async (point) => {
        if (point === 'create:before-rename') {
          const entries = await fs.readdir(cardDir);
          const tempFileName = entries.find((e) => e.startsWith('.tmp-'));
          assert.ok(tempFileName, 'temp file must exist at create:before-rename');
          const tempFilePath = path.join(cardDir, tempFileName);

          // 1. Keep original staged inode allocated
          heldHandle = await fs.open(tempFilePath, 'r');
          const originalStat = await heldHandle.stat();

          // 2. Prepare second regular file outside cardDir with identical bytes
          const originalBytes = await fs.readFile(tempFilePath);
          const secondFilePath = path.join(userRoot, 'substitution-source.tmp');
          await fs.writeFile(secondFilePath, originalBytes, { mode: 0o600 });
          const secondStat = await fs.lstat(secondFilePath);
          assert.notStrictEqual(secondStat.ino, originalStat.ino, 'second file must have a distinct inode');
          assert.strictEqual(secondStat.nlink, 1);

          // 3. Atomically substitute tempFilePath with second file
          await fs.rename(secondFilePath, tempFilePath);

          const substitutedStat = await fs.lstat(tempFilePath);
          assert.strictEqual(substitutedStat.ino, secondStat.ino);
          assert.notStrictEqual(substitutedStat.ino, originalStat.ino);
          assert.strictEqual(substitutedStat.nlink, 1);
        }
      };

      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      try {
        const store = createFileStore({ faultHook: hook, fsOps: customFsOps });
        const state = createValidState({ cardId: VALID_CARD_ID_1 });
        const res = await store.createState({ userRoot, state });

        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
        assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);
        assert.strictEqual(renameCalls, 0, 'rename must not be dispatched on inode substitution');

        // Canonical state.json must be strictly absent
        await assert.rejects(async () => {
          await fs.lstat(path.join(cardDir, 'state.json'));
        }, { code: 'ENOENT' });

        // Staged temp file (substituted inode) must be preserved
        const entries = await fs.readdir(cardDir);
        const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
        assert.strictEqual(tempEntries.length, 1);
      } finally {
        if (heldHandle) {
          await heldHandle.close();
        }
      }
    });

    it('T30-G: G4-R2: createState untampered success regression with durability and readback verification', async () => {
      let renameCalls = 0;
      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changed, true);
      assert.strictEqual(renameCalls, 1, 'rename must be dispatched exactly once on success');

      // Canonical state.json must exist with valid serialized content
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const stateContent = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      const expectedBytes = serializeSidecarState(state).value;
      assert.strictEqual(stateContent, expectedBytes);

      // Card directory must contain only state.json
      const entries = await fs.readdir(cardDir);
      assert.deepStrictEqual(entries, ['state.json']);
    });

    it('T30-H: G4-R2: createState fails before rename if temp verification handle close throws', async () => {
      let renameCalls = 0;
      let interceptedVerification = false;

      const customFsOps = {
        open: async (p, flags, mode) => {
          const handle = await fs.open(p, flags, mode);
          // Intercept read-only open on temp file during pre-rename verification
          if (
            typeof p === 'string' &&
            p.includes('.tmp-') &&
            !(flags & fsConstants.constants.O_CREAT) &&
            !(flags & fsConstants.constants.O_WRONLY)
          ) {
            interceptedVerification = true;
            const originalClose = handle.close.bind(handle);
            handle.close = async () => {
              try {
                await originalClose();
              } catch (_e) {}
              throw new Error('EIO: injected handle close failure during pre-rename verification');
            };
          }
          return handle;
        },
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(interceptedVerification, true, 'must intercept pre-rename verification handle');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);
      assert.strictEqual(renameCalls, 0, 'rename must not be dispatched when close throws');

      // Canonical state.json must remain absent
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await assert.rejects(async () => {
        await fs.lstat(path.join(cardDir, 'state.json'));
      }, { code: 'ENOENT' });

      // Forensic temp file preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T30-I: G4-R2: createState fails before rename if temp verification read or open fails', async () => {
      let renameCalls = 0;
      let interceptedOpen = false;

      const customFsOps = {
        open: async (p, flags, mode) => {
          if (
            typeof p === 'string' &&
            p.includes('.tmp-') &&
            !(flags & fsConstants.constants.O_CREAT) &&
            !(flags & fsConstants.constants.O_WRONLY)
          ) {
            interceptedOpen = true;
            throw new Error('EIO: injected open failure during pre-rename verification');
          }
          return fs.open(p, flags, mode);
        },
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      const res = await store.createState({ userRoot, state });

      assert.strictEqual(interceptedOpen, true);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);
      assert.strictEqual(renameCalls, 0);

      // Canonical state.json must remain absent
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await assert.rejects(async () => {
        await fs.lstat(path.join(cardDir, 'state.json'));
      }, { code: 'ENOENT' });

      // Forensic temp preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });
  });

  // --- Suite 8: Guarded State Replacement (replaceState) ---
  describe('Suite 8: Guarded State Replacement (replaceState)', () => {
    it('T45: successfully updates state with two-phase CAS checks and readback', async () => {
      const store = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await store.createState({ userRoot, state: initialState });

      const expectedBytes = serializeSidecarState(initialState).value;
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });

      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changed, true);
      assert.strictEqual(res.value.storageRevision, 2);

      // Verify content on disk
      const statePath = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1, 'state.json');
      const content = await fs.readFile(statePath, 'utf8');
      assert.strictEqual(content, serializeSidecarState(nextState).value);
    });

    it('T38: fails with STATE_NOT_FOUND if target card directory does not exist', async () => {
      const store = createFileStore();
      const validState = createValidState({ cardId: VALID_CARD_ID_1 });
      const expectedBytes = serializeSidecarState(validState).value;

      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState: validState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STATE_NOT_FOUND);
    });

    it('T39: refuses with REVISION_CONFLICT (CAS_MISMATCH) if initial expectedBytes does not match current state', async () => {
      const store = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2 });
      await store.createState({ userRoot, state: initialState });

      // Stale expected bytes (storageRevision: 1)
      const staleState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1 });
      const staleBytes = serializeSidecarState(staleState).value;
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 3 });

      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes: staleBytes,
        nextState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.REVISION_CONFLICT);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.CAS_MISMATCH);
    });

    it('Guardrail B: fails closed with INVALID_SCHEMA if existing state on disk is corrupted JSON', async () => {
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.mkdir(cardDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(cardDir, 'state.json'), 'corrupt { not json');

      const store = createFileStore();
      const validState = createValidState({ cardId: VALID_CARD_ID_1 });
      const expectedBytes = serializeSidecarState(validState).value;

      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState: validState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.INVALID_SCHEMA);
    });

    it('T40: Guardrail B: second pre-rename CAS check catches content drift during staging', async () => {
      const store = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1 });
      await store.createState({ userRoot, state: initialState });

      const expectedBytes = serializeSidecarState(initialState).value;
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2 });

      // Hook modifies state.json right before second CAS read
      const driftHook = async (point) => {
        if (point === 'replace:before-cas-read-2') {
          const statePath = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1, 'state.json');
          const driftedState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 99 });
          await fs.writeFile(statePath, serializeSidecarState(driftedState).value);
        }
      };

      const driftStore = createFileStore({ faultHook: driftHook });
      const res = await driftStore.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.REVISION_CONFLICT);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.CAS_MISMATCH_PRE_RENAME);
    });

    it('T41: Guardrail B: second pre-rename CAS check catches inode/device drift during staging', async () => {
      const store = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1 });
      await store.createState({ userRoot, state: initialState });

      const expectedBytes = serializeSidecarState(initialState).value;
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2 });

      let oldIno;
      let newIno;
      // Hook moves state.json to backup outside cardDir (retaining original inode) and creates new file (new inode)
      const inodeDriftHook = async (point) => {
        if (point === 'replace:before-cas-read-2') {
          const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
          const statePath = path.join(cardDir, 'state.json');
          const backupPath = path.join(tempBaseDir, 'backup-state.json');

          const oldStat = await fs.lstat(statePath);
          oldIno = oldStat.ino;

          // Rename to backup outside cardDir so old inode is held and not reused
          await fs.rename(statePath, backupPath);

          // Write new file at statePath with identical content
          await fs.writeFile(statePath, expectedBytes, { mode: 0o600 });
          const newStat = await fs.lstat(statePath);
          newIno = newStat.ino;
        }
      };

      const driftStore = createFileStore({ faultHook: inodeDriftHook });
      const res = await driftStore.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.notStrictEqual(oldIno, newIno, 'Old and new inodes must differ for deterministic test');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.DEV_INO_MISMATCH);
    });

    it('T45-A: Finding A: replaceState fails with TEMP_WRITE_FAILED on zero progress and preserves canonical state', async () => {
      const realOpen = fs.open.bind(fs);
      const zeroProgressFsOps = {
        open: async (filePath, flags, mode) => {
          const handle = await realOpen(filePath, flags, mode);
          if (typeof filePath === 'string' && filePath.endsWith('.tmp')) {
            handle.write = async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
          }
          return handle;
        },
      };

      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1 });
      await setupStore.createState({ userRoot, state: initialState });

      const store = createFileStore({ fsOps: zeroProgressFsOps });
      const expectedBytes = serializeSidecarState(initialState).value;
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.TEMP_WRITE_FAILED);

      // Verify canonical state.json was NOT overwritten
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const current = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      assert.strictEqual(current, expectedBytes);

      // Verify temp file was preserved as forensic residue
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T45-B: Finding E Check 1: replaceState fails with DIR_RESIDUE_DETECTED if cardDir contains residue before staging', async () => {
      const store = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1 });
      await store.createState({ userRoot, state: initialState });

      // Put foreign residue into cardDir before replace
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.writeFile(path.join(cardDir, '.tmp-old-foreign.tmp'), 'residue');

      const expectedBytes = serializeSidecarState(initialState).value;
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.DIR_RESIDUE_DETECTED);

      // Verify state.json was NOT modified
      const current = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      assert.strictEqual(current, expectedBytes);

      // Verify no new temp files were created (only the pre-existing residue and state.json exist)
      const entries = await fs.readdir(cardDir);
      assert.strictEqual(entries.length, 2);
    });

    it('T45-C: Finding E Check 2: replaceState catches late residue injected at replace:before-rename', async () => {
      const hook = async (point) => {
        if (point === 'replace:before-rename') {
          const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
          await fs.writeFile(path.join(cardDir, 'intruder.txt'), 'intruder');
        }
      };

      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1 });
      await setupStore.createState({ userRoot, state: initialState });

      const store = createFileStore({ faultHook: hook });
      const expectedBytes = serializeSidecarState(initialState).value;
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);

      // Verify canonical state.json was NOT modified
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const current = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      assert.strictEqual(current, expectedBytes);

      // Verify staged temp file was preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T45-D: G4-R2: replaceState rejects same-length content tampering injected at replace:before-rename', async () => {
      let renameCalls = 0;
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);

      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await setupStore.createState({ userRoot, state: initialState });
      const expectedBytes = serializeSidecarState(initialState).value;

      const hook = async (point) => {
        if (point === 'replace:before-rename') {
          const entries = await fs.readdir(cardDir);
          const tempFileName = entries.find((e) => e.startsWith('.tmp-'));
          assert.ok(tempFileName, 'temp file must exist at replace:before-rename');
          const tempFilePath = path.join(cardDir, tempFileName);

          const originalContent = await fs.readFile(tempFilePath, 'utf8');
          // Tamper in-place with exact same byte length
          const tamperedContent = originalContent.includes('"storageRevision":2')
            ? originalContent.replace('"storageRevision":2', '"storageRevision":3')
            : originalContent.replace('"schemaVersion":1', '"schemaVersion":2');
          assert.strictEqual(
            Buffer.byteLength(tamperedContent, 'utf8'),
            Buffer.byteLength(originalContent, 'utf8')
          );
          assert.notStrictEqual(tamperedContent, originalContent);
          await fs.writeFile(tempFilePath, tamperedContent, 'utf8');
        }
      };

      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ faultHook: hook, fsOps: customFsOps });
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);
      assert.strictEqual(renameCalls, 0, 'rename must not be dispatched on same-length tamper');

      // Canonical state.json must remain completely untouched
      const afterContent = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      assert.strictEqual(afterContent, expectedBytes);

      // Forensic temp file must be preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T45-E: G4-R2: replaceState rejects temp pathname inode substitution injected at replace:before-rename', async () => {
      let renameCalls = 0;
      let heldHandle = null;
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);

      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await setupStore.createState({ userRoot, state: initialState });
      const expectedBytes = serializeSidecarState(initialState).value;

      const hook = async (point) => {
        if (point === 'replace:before-rename') {
          const entries = await fs.readdir(cardDir);
          const tempFileName = entries.find((e) => e.startsWith('.tmp-'));
          assert.ok(tempFileName, 'temp file must exist at replace:before-rename');
          const tempFilePath = path.join(cardDir, tempFileName);

          // 1. Keep original staged inode allocated
          heldHandle = await fs.open(tempFilePath, 'r');
          const originalStat = await heldHandle.stat();

          // 2. Prepare second regular file outside cardDir with identical bytes
          const originalBytes = await fs.readFile(tempFilePath);
          const secondFilePath = path.join(userRoot, 'substitution-source.tmp');
          await fs.writeFile(secondFilePath, originalBytes, { mode: 0o600 });
          const secondStat = await fs.lstat(secondFilePath);
          assert.notStrictEqual(secondStat.ino, originalStat.ino);
          assert.strictEqual(secondStat.nlink, 1);

          // 3. Atomically substitute tempFilePath with second file
          await fs.rename(secondFilePath, tempFilePath);

          const substitutedStat = await fs.lstat(tempFilePath);
          assert.strictEqual(substitutedStat.ino, secondStat.ino);
          assert.notStrictEqual(substitutedStat.ino, originalStat.ino);
          assert.strictEqual(substitutedStat.nlink, 1);
        }
      };

      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      try {
        const store = createFileStore({ faultHook: hook, fsOps: customFsOps });
        const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });
        const res = await store.replaceState({
          userRoot,
          cardId: VALID_CARD_ID_1,
          expectedBytes,
          nextState,
        });

        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
        assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);
        assert.strictEqual(renameCalls, 0, 'rename must not be dispatched on inode substitution');

        // Canonical state.json must remain completely untouched
        const afterContent = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
        assert.strictEqual(afterContent, expectedBytes);

        // Forensic temp file must be preserved
        const entries = await fs.readdir(cardDir);
        const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
        assert.strictEqual(tempEntries.length, 1);
      } finally {
        if (heldHandle) {
          await heldHandle.close();
        }
      }
    });

    it('T45-F: G4-R2: replaceState untampered success regression with durability and readback verification', async () => {
      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await setupStore.createState({ userRoot, state: initialState });
      const expectedBytes = serializeSidecarState(initialState).value;

      let renameCalls = 0;
      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changed, true);
      assert.strictEqual(renameCalls, 1, 'rename must be dispatched exactly once on success');

      // Canonical state.json must have nextState content
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const afterContent = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      const nextExpectedBytes = serializeSidecarState(nextState).value;
      assert.strictEqual(afterContent, nextExpectedBytes);

      // Card directory must contain only state.json
      const entries = await fs.readdir(cardDir);
      assert.deepStrictEqual(entries, ['state.json']);
    });

    it('T45-G: G4-R2: replaceState fails before rename if temp verification handle close throws', async () => {
      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await setupStore.createState({ userRoot, state: initialState });
      const expectedBytes = serializeSidecarState(initialState).value;

      let renameCalls = 0;
      let interceptedVerification = false;

      const customFsOps = {
        open: async (p, flags, mode) => {
          const handle = await fs.open(p, flags, mode);
          if (
            typeof p === 'string' &&
            p.includes('.tmp-') &&
            !(flags & fsConstants.constants.O_CREAT) &&
            !(flags & fsConstants.constants.O_WRONLY)
          ) {
            interceptedVerification = true;
            const originalClose = handle.close.bind(handle);
            handle.close = async () => {
              try {
                await originalClose();
              } catch (_e) {}
              throw new Error('EIO: injected handle close failure during pre-rename verification in replaceState');
            };
          }
          return handle;
        },
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(interceptedVerification, true, 'must intercept pre-rename verification handle');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);
      assert.strictEqual(renameCalls, 0, 'rename must not be dispatched when close throws');

      // Canonical state.json must remain completely untouched
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const afterContent = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      assert.strictEqual(afterContent, expectedBytes);

      // Forensic temp file preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T45-H: G4-R2: replaceState fails before rename if temp verification open or stat fails', async () => {
      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await setupStore.createState({ userRoot, state: initialState });
      const expectedBytes = serializeSidecarState(initialState).value;

      let renameCalls = 0;
      let interceptedOpen = false;

      const customFsOps = {
        open: async (p, flags, mode) => {
          if (
            typeof p === 'string' &&
            p.includes('.tmp-') &&
            !(flags & fsConstants.constants.O_CREAT) &&
            !(flags & fsConstants.constants.O_WRONLY)
          ) {
            interceptedOpen = true;
            throw new Error('EIO: injected open failure during pre-rename verification in replaceState');
          }
          return fs.open(p, flags, mode);
        },
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(interceptedOpen, true);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.PRE_RENAME_VERIFY_FAILED);
      assert.strictEqual(renameCalls, 0);

      // Canonical state.json must remain completely untouched
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const afterContent = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      assert.strictEqual(afterContent, expectedBytes);

      // Forensic temp preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T45-I: G4-R3: replaceState catches late in-place canonical state rewrite injected at replace:before-rename', async () => {
      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await setupStore.createState({ userRoot, state: initialState });
      const expectedBytes = serializeSidecarState(initialState).value;

      let renameCalls = 0;
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const rivalState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 8, revision: 0 });
      const rivalBytes = serializeSidecarState(rivalState).value;

      const hook = async (point) => {
        if (point === 'replace:before-rename') {
          // Late in-place overwrite of canonical state.json with valid rival revision 8 state
          await fs.writeFile(path.join(cardDir, 'state.json'), rivalBytes, 'utf8');
        }
      };

      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ faultHook: hook, fsOps: customFsOps });
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.REVISION_CONFLICT);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.CAS_MISMATCH_PRE_RENAME);
      assert.strictEqual(renameCalls, 0, 'rename must not be dispatched when canonical state drifted');

      // Rival canonical state must survive untouched
      const current = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      assert.strictEqual(current, rivalBytes);

      // Staged temp file must be preserved
      const entries = await fs.readdir(cardDir);
      const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
      assert.strictEqual(tempEntries.length, 1);
    });

    it('T45-J: G4-R3: replaceState catches late canonical pathname inode substitution injected at replace:before-rename', async () => {
      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await setupStore.createState({ userRoot, state: initialState });
      const expectedBytes = serializeSidecarState(initialState).value;

      let renameCalls = 0;
      let heldHandle = null;
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const statePath = path.join(cardDir, 'state.json');

      const hook = async (point) => {
        if (point === 'replace:before-rename') {
          // 1. Keep original canonical inode allocated
          heldHandle = await fs.open(statePath, 'r');
          const originalStat = await heldHandle.stat();

          // 2. Prepare second regular file outside cardDir with identical valid expected bytes
          const secondFilePath = path.join(userRoot, 'rival-canonical.tmp');
          await fs.writeFile(secondFilePath, expectedBytes, { mode: 0o600 });
          const secondStat = await fs.lstat(secondFilePath);
          assert.notStrictEqual(secondStat.ino, originalStat.ino, 'second file must have a distinct inode');
          assert.strictEqual(secondStat.nlink, 1);

          // 3. Atomically substitute statePath with second file
          await fs.rename(secondFilePath, statePath);

          const substitutedStat = await fs.lstat(statePath);
          assert.strictEqual(substitutedStat.ino, secondStat.ino);
          assert.notStrictEqual(substitutedStat.ino, originalStat.ino);
          assert.strictEqual(substitutedStat.nlink, 1);
        }
      };

      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      try {
        const store = createFileStore({ faultHook: hook, fsOps: customFsOps });
        const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });
        const res = await store.replaceState({
          userRoot,
          cardId: VALID_CARD_ID_1,
          expectedBytes,
          nextState,
        });

        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
        assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.DEV_INO_MISMATCH);
        assert.strictEqual(renameCalls, 0, 'rename must not be dispatched when canonical inode was substituted');

        // Staged temp file must be preserved
        const entries = await fs.readdir(cardDir);
        const tempEntries = entries.filter((e) => e.startsWith('.tmp-'));
        assert.strictEqual(tempEntries.length, 1);
      } finally {
        if (heldHandle) {
          await heldHandle.close();
        }
      }
    });

    it('T45-K: G4-R3: replaceState baseline unchanged state succeeds with exactly one rename and clean directory', async () => {
      const setupStore = createFileStore();
      const initialState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 1, revision: 0 });
      await setupStore.createState({ userRoot, state: initialState });
      const expectedBytes = serializeSidecarState(initialState).value;

      let renameCalls = 0;
      const customFsOps = {
        rename: async (...args) => {
          renameCalls++;
          return fs.rename(...args);
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const nextState = createValidState({ cardId: VALID_CARD_ID_1, storageRevision: 2, revision: 1 });
      const res = await store.replaceState({
        userRoot,
        cardId: VALID_CARD_ID_1,
        expectedBytes,
        nextState,
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changed, true);
      assert.strictEqual(renameCalls, 1, 'rename must be dispatched exactly once on success');

      // Canonical state.json must have nextState content
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const afterContent = await fs.readFile(path.join(cardDir, 'state.json'), 'utf8');
      const nextExpectedBytes = serializeSidecarState(nextState).value;
      assert.strictEqual(afterContent, nextExpectedBytes);

      // Card directory must contain only state.json (no temp residue)
      const entries = await fs.readdir(cardDir);
      assert.deepStrictEqual(entries, ['state.json']);
    });
  });

  // --- Suite 9: State Read (readState) ---
  describe('Suite 9: State Read (readState)', () => {
    it('T49: reads valid targeted state and returns frozen snapshot', async () => {
      const store = createFileStore();
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      await store.createState({ userRoot, state });

      const res = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.value.cardId, VALID_CARD_ID_1);
      assert.strictEqual(Object.isFrozen(res.value), true);
    });

    it('T46: returns STATE_NOT_FOUND if card directory does not exist', async () => {
      const store = createFileStore();
      const res = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STATE_NOT_FOUND);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.CARD_DIRECTORY_MISSING);
    });

    it('T47: returns STORAGE_UNAVAILABLE if state.json is missing in card directory', async () => {
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.mkdir(cardDir, { recursive: true, mode: 0o700 });

      const store = createFileStore();
      const res = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.MISSING_STATE_JSON);
    });

    it('Guardrail C: returns STORAGE_UNAVAILABLE (DIR_RESIDUE_DETECTED) if targeted folder contains residue', async () => {
      const store = createFileStore();
      const state = createValidState({ cardId: VALID_CARD_ID_1 });
      await store.createState({ userRoot, state });

      // Add residue to card folder
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      await fs.writeFile(path.join(cardDir, '.tmp-unresolved.tmp'), 'residue');

      const res = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.DIR_RESIDUE_DETECTED);
    });
  });

  // --- Suite 10: Deterministic Fault Injection & Outcome Classification ---
  describe('Suite 10: Deterministic Fault Injection & Outcome Classification', () => {
    it('T31: fault before temp write classified as WRITE_FAILED with canonical state untouched', async () => {
      const hook = async (point) => {
        if (point === 'create:before-temp-open') {
          throw new Error('create:before-temp-open fault');
        }
      };
      const store = createFileStore({ faultHook: hook });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });

      const res = await store.createState({ userRoot, state });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME);

      // Verify state.json was NOT created
      const statePath = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1, 'state.json');
      await assert.rejects(async () => await fs.lstat(statePath), { code: 'ENOENT' });
    });

    it('T33: fault after temp write preserves partial temp file as forensic evidence', async () => {
      const hook = async (point) => {
        if (point === 'create:after-temp-write') {
          throw new Error('create:after-temp-write fault');
        }
      };
      const store = createFileStore({ faultHook: hook });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });

      const res = await store.createState({ userRoot, state });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);

      // Forensic verification: temp file must be preserved in card directory
      const cardDir = path.join(userRoot, 'chromaticHub', 'cards', VALID_CARD_ID_1);
      const entries = await fs.readdir(cardDir);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].startsWith('.tmp-'), true);
    });

    it('T34: fault before rename classified as WRITE_FAILED; target state.json untouched', async () => {
      const hook = async (point) => {
        if (point === 'create:before-rename') {
          throw new Error('create:before-rename fault');
        }
      };
      const store = createFileStore({ faultHook: hook });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });

      const res = await store.createState({ userRoot, state });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_FAILED);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.FAULT_INJECTED_PRE_RENAME);
    });

    it('T35: Guardrail D: fault after rename classified as WRITE_UNCERTAIN (commit dividing line)', async () => {
      const hook = async (point) => {
        if (point === 'create:after-rename') {
          throw new Error('create:after-rename fault');
        }
      };
      const store = createFileStore({ faultHook: hook });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });

      const res = await store.createState({ userRoot, state });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.FAULT_INJECTED_POST_RENAME);
    });

    it('T36: Guardrail D: failure during directory sync classified as WRITE_UNCERTAIN', async () => {
      const hook = async (point) => {
        if (point === 'create:before-dir-sync') {
          throw new Error('create:before-dir-sync fault');
        }
      };
      const store = createFileStore({ faultHook: hook });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });

      const res = await store.createState({ userRoot, state });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.FAULT_INJECTED_POST_RENAME);
    });

    it('T37: Guardrail D: readback byte mismatch classified as WRITE_UNCERTAIN (READBACK_MISMATCH)', async () => {
      // Custom fsOps modifying content between rename and readback
      let renamed = false;
      const customFsOps = {
        rename: async (oldP, newP) => {
          await fs.rename(oldP, newP);
          renamed = true;
          // Tamper with newP to cause readback byte mismatch
          await fs.writeFile(newP, '{"tampered":true}');
        },
      };

      const store = createFileStore({ fsOps: customFsOps });
      const state = createValidState({ cardId: VALID_CARD_ID_1 });

      const res = await store.createState({ userRoot, state });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN);
      assert.strictEqual(res.details?.reason, DIAGNOSTIC_REASONS.READBACK_MISMATCH);
    });
  });

  // --- Suite 11: Security & Containment Defense ---
  describe('Suite 11: Security & Containment Defense', () => {
    it('T50: rejects path traversal in cardId before filesystem access', async () => {
      const store = createFileStore();
      const badCardId = '../../etc';
      const res = await store.readState({ userRoot, cardId: badCardId });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.INVALID_CARD_ID);
    });

    it('T51: rejects path traversal in avatar before filesystem access', async () => {
      const store = createFileStore();
      const res = await store.observeAvatar({ charactersRoot, avatar: '../secret.png' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, FILE_STORE_ERROR_CODES.INVALID_AVATAR);
    });

    it('Strict privacy invariant: error details contain no raw paths or user metadata', async () => {
      const store = createFileStore();
      const res = await store.readState({ userRoot, cardId: VALID_CARD_ID_1 });
      assert.strictEqual(res.ok, false);
      if (res.details) {
        // Must contain only { reason }
        const keys = Object.keys(res.details);
        assert.deepStrictEqual(keys, ['reason']);
        assert.strictEqual(typeof res.details.reason, 'string');
      }
    });
  });

  // --- Suite 12: Multi-User Isolation ---
  describe('Suite 12: Multi-User Isolation', () => {
    it('T52: completely isolates UserA and UserB roots with identical cardId and avatar names', async () => {
      const userA = path.join(tempBaseDir, 'userA');
      const userB = path.join(tempBaseDir, 'userB');
      await fs.mkdir(userA, { mode: 0o700 });
      await fs.mkdir(userB, { mode: 0o700 });

      const store = createFileStore();

      // User A creates state with revision 1
      const stateA = createValidState({ cardId: VALID_CARD_ID_1, avatar: 'same.png', storageRevision: 1 });
      await store.createState({ userRoot: userA, state: stateA });

      // User B creates state with revision 2
      const stateB = createValidState({ cardId: VALID_CARD_ID_1, avatar: 'same.png', storageRevision: 2 });
      await store.createState({ userRoot: userB, state: stateB });

      const readA = await store.readState({ userRoot: userA, cardId: VALID_CARD_ID_1 });
      const readB = await store.readState({ userRoot: userB, cardId: VALID_CARD_ID_1 });

      assert.strictEqual(readA.ok, true);
      assert.strictEqual(readA.value.storageRevision, 1);

      assert.strictEqual(readB.ok, true);
      assert.strictEqual(readB.value.storageRevision, 2);
    });

    it('T53: store failure or corruption in UserA does not block or impair UserB', async () => {
      const userA = path.join(tempBaseDir, 'userA');
      const userB = path.join(tempBaseDir, 'userB');
      await fs.mkdir(userA, { mode: 0o700 });
      await fs.mkdir(userB, { mode: 0o700 });

      const store = createFileStore();

      // Create corrupted store in UserA (cardsDir with extra non-UUID folder)
      const userACards = path.join(userA, 'chromaticHub', 'cards');
      await fs.mkdir(userACards, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(userACards, 'corrupt-folder'), { mode: 0o700 });

      // Create healthy card in UserB
      const stateB = createValidState({ cardId: VALID_CARD_ID_1, avatar: 'b.png' });
      await store.createState({ userRoot: userB, state: stateB });

      const scanA = await store.scanStore({ userRoot: userA, charactersRoot });
      assert.strictEqual(scanA.ok, false);
      assert.strictEqual(scanA.code, FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE);

      const scanB = await store.scanStore({ userRoot: userB, charactersRoot });
      assert.strictEqual(scanB.ok, true);
      assert.strictEqual(scanB.value.claims.length, 1);
    });
  });
});
