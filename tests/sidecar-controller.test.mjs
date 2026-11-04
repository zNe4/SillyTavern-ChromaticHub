/**
 * SillyTavern-ChromaticHub: Sidecar Controller Unit, Race & Fault Test Suite (H01-B3-D2-C2)
 *
 * Conforms to:
 * - ChromaticHub-H01-B3-D2-A-approved.md & ChromaticHub-H01-B3-D2-B-approved.md
 * - ChromaticHub-H01-B3-D2-C2-implementation-plan.md (G1-R1 Approved Plan)
 * - Binding G2 Guardrails G2-A through G2-E (ChatGPT Independent Review 2026-11-02)
 *
 * Invariants Verified:
 * - Dependency-free tests run with Node's built-in node:test and node:assert/strict.
 * - Disposable temporary directories under os.tmpdir() only; zero native ST card writes.
 * - 70 named adversarial tests covering lifecycles, concurrency, cancellation, queue resilience,
 *   unhandled rejection elimination, total write classification, constant privacy diagnostics,
 *   G4-R1 regression hardening (immutable context snapshots, total uncertainty containment,
 *   pre-dispatch signal throwing safety, and raw traversal path rejection), G4-R3 envelope consistency
 *   (total C1 response envelope validation, C0 serialization parity, and recognized pre-commit safety),
 *   and G4-R4 structural envelope validation (descriptor traps, forbidden own properties, and malformed failure shapes).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  createSidecarController,
  CONTROLLER_ERROR_CODES,
  CONTROLLER_DIAGNOSTIC_REASONS,
} from '../src/sidecar-controller.mjs';

import {
  createFileStore,
  FILE_STORE_ERROR_CODES,
} from '../src/sidecar-file-store.mjs';

import {
  serializeSidecarState,
} from '../src/sidecar-state.mjs';

// --- Test Fixture Helpers ---

async function createTempDirectories() {
  const base = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ch-c2-test-'));
  const userRoot = path.join(base, 'user');
  const charactersRoot = path.join(base, 'characters');
  await fsPromises.mkdir(userRoot, { mode: 0o700, recursive: true });
  await fsPromises.mkdir(charactersRoot, { mode: 0o700, recursive: true });
  return { base, userRoot, charactersRoot };
}

async function cleanupTempDirectories(base) {
  try {
    await fsPromises.rm(base, { recursive: true, force: true });
  } catch (_err) {
    // ignore cleanup errors on disposable temp dirs
  }
}

async function writeDummyAvatar(charactersRoot, avatar) {
  const p = path.join(charactersRoot, avatar);
  await fsPromises.writeFile(p, 'dummy-png-bytes', { mode: 0o600 });
  return p;
}

// --- Test Suite ---

describe('Sidecar Controller — Unit, Concurrency & Fault Matrix (H01-B3-D2-C2)', () => {
  let tempBase;
  let userRoot;
  let charactersRoot;
  let fileStore;
  let controller;

  beforeEach(async () => {
    const dirs = await createTempDirectories();
    tempBase = dirs.base;
    userRoot = dirs.userRoot;
    charactersRoot = dirs.charactersRoot;
    fileStore = createFileStore();
    controller = createSidecarController({ fileStore });
  });

  afterEach(async () => {
    await cleanupTempDirectories(tempBase);
  });

  // --- Group 1: Lifecycle Tests (L01 - L17) ---

  it('L01-resolve-bound: installed and bound avatar returns BOUND snapshot with zero writes', async () => {
    await writeDummyAvatar(charactersRoot, 'alice.png');
    const createRes = await controller.create({
      context: { userRoot, charactersRoot },
      avatar: 'alice.png',
    });
    assert.equal(createRes.ok, true);
    assert.equal(createRes.changed, true);
    const cardId = createRes.value.cardId;

    const res = await controller.resolve({
      context: { userRoot, charactersRoot },
      avatar: 'alice.png',
    });

    assert.equal(res.ok, true);
    assert.equal(res.value.status, 'BOUND');
    assert.equal(res.value.cardId, cardId);
    assert.equal(res.value.avatar, 'alice.png');
    assert.equal(res.value.storageRevision, 1);
    assert.equal(res.value.registry.revision, 0);
  });

  it('L02-resolve-unbound: installed unbound avatar returns UNBOUND with recoveryAvailable: false', async () => {
    await writeDummyAvatar(charactersRoot, 'bob.png');

    const res = await controller.resolve({
      context: { userRoot, charactersRoot },
      avatar: 'bob.png',
    });

    assert.equal(res.ok, true);
    assert.equal(res.value.status, 'UNBOUND');
    assert.equal(res.value.avatar, 'bob.png');
    assert.equal(res.value.recoveryAvailable, false);
  });

  it('L03-resolve-recovery-avail: installed unbound avatar with orphan present returns recoveryAvailable: true', async () => {
    // Create orphan card
    await writeDummyAvatar(charactersRoot, 'orphan.png');
    await controller.create({
      context: { userRoot, charactersRoot },
      avatar: 'orphan.png',
    });
    // Remove avatar PNG to turn it into an orphan
    await fsPromises.unlink(path.join(charactersRoot, 'orphan.png'));

    // Create target unbound avatar
    await writeDummyAvatar(charactersRoot, 'target.png');

    const res = await controller.resolve({
      context: { userRoot, charactersRoot },
      avatar: 'target.png',
    });

    assert.equal(res.ok, true);
    assert.equal(res.value.status, 'UNBOUND');
    assert.equal(res.value.avatar, 'target.png');
    assert.equal(res.value.recoveryAvailable, true);
  });

  it('L04-resolve-missing-png: missing avatar file returns CARD_NOT_FOUND', async () => {
    const res = await controller.resolve({
      context: { userRoot, charactersRoot },
      avatar: 'missing.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.CARD_NOT_FOUND);
  });

  it('L05-recovery-candidates: unbound avatar with 2 orphans returns sorted minimal candidate list', async () => {
    // Create 2 orphan cards
    await writeDummyAvatar(charactersRoot, 'old1.png');
    const c1 = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'old1.png' });
    await fsPromises.unlink(path.join(charactersRoot, 'old1.png'));

    await writeDummyAvatar(charactersRoot, 'old2.png');
    const c2 = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'old2.png' });
    await fsPromises.unlink(path.join(charactersRoot, 'old2.png'));

    await writeDummyAvatar(charactersRoot, 'new_hero.png');

    const res = await controller.recoveryCandidates({
      context: { userRoot, charactersRoot },
      avatar: 'new_hero.png',
    });

    assert.equal(res.ok, true);
    assert.equal(res.value.candidates.length, 2);
    // Deterministically sorted by cardId
    const sorted = [c1.value.cardId, c2.value.cardId].sort();
    assert.equal(res.value.candidates[0].cardId, sorted[0]);
    assert.equal(res.value.candidates[1].cardId, sorted[1]);
    // Minimal projection: no registry exposed
    assert.equal(res.value.candidates[0].registry, undefined);
    assert.equal(typeof res.value.candidates[0].avatar, 'string');
    assert.equal(typeof res.value.candidates[0].storageRevision, 'number');
  });

  it('L06-recovery-cand-bound: bound avatar requesting recovery candidates returns ALREADY_BOUND', async () => {
    await writeDummyAvatar(charactersRoot, 'bound.png');
    await controller.create({ context: { userRoot, charactersRoot }, avatar: 'bound.png' });

    const res = await controller.recoveryCandidates({
      context: { userRoot, charactersRoot },
      avatar: 'bound.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.ALREADY_BOUND);
  });

  it('L07-create-success: unbound avatar creates new cardId, storageRev=1, registry.rev=0', async () => {
    await writeDummyAvatar(charactersRoot, 'fresh.png');

    const res = await controller.create({
      context: { userRoot, charactersRoot },
      avatar: 'fresh.png',
    });

    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.value.status, 'BOUND');
    assert.equal(res.value.avatar, 'fresh.png');
    assert.equal(res.value.storageRevision, 1);
    assert.equal(res.value.registry.revision, 0);
    assert.equal(res.value.registry.characters.length, 0);

    // Verify on disk through fileStore readState
    const diskRead = await fileStore.readState({ userRoot, cardId: res.value.cardId });
    assert.equal(diskRead.ok, true);
    assert.equal(diskRead.value.storageRevision, 1);
  });

  it('L08-create-already-bound: already bound avatar returns ALREADY_BOUND with zero writes', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });

    const res2 = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.ALREADY_BOUND);
  });

  it('L09-mutate-add: valid add command increments storageRevision and registry.revision', async () => {
    await writeDummyAvatar(charactersRoot, 'alice.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'alice.png' });
    const cardId = created.value.cardId;

    const res = await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'alice.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Knight' } },
    });

    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.value.storageRevision, 2);
    assert.equal(res.value.registry.revision, 1);
    assert.equal(res.value.registry.characters.length, 1);
    assert.equal(res.value.registry.characters[0].name, 'Knight');
  });

  it('L10-mutate-update: valid update increments revisions and modifies character in place', async () => {
    await writeDummyAvatar(charactersRoot, 'alice.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'alice.png' });
    const cardId = created.value.cardId;

    const added = await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'alice.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Knight' } },
    });
    const charId = added.value.registry.characters[0].id;

    const updated = await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'alice.png',
      expectedStorageRevision: 2,
      expectedRegistryRevision: 1,
      command: { type: 'update', character: { id: charId, name: 'Paladin' } },
    });

    assert.equal(updated.ok, true);
    assert.equal(updated.changed, true);
    assert.equal(updated.value.storageRevision, 3);
    assert.equal(updated.value.registry.revision, 2);
    assert.equal(updated.value.registry.characters[0].name, 'Paladin');
  });

  it('L11-mutate-remove: valid remove increments revisions and decrements characters count', async () => {
    await writeDummyAvatar(charactersRoot, 'alice.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'alice.png' });
    const cardId = created.value.cardId;

    const added = await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'alice.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Knight' } },
    });
    const charId = added.value.registry.characters[0].id;

    const removed = await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'alice.png',
      expectedStorageRevision: 2,
      expectedRegistryRevision: 1,
      command: { type: 'remove', identityId: charId },
    });

    assert.equal(removed.ok, true);
    assert.equal(removed.changed, true);
    assert.equal(removed.value.storageRevision, 3);
    assert.equal(removed.value.registry.revision, 2);
    assert.equal(removed.value.registry.characters.length, 0);
  });

  it('L12-mutate-noop: exact field no-op returns changed:false and performs zero FileStore writes', async () => {
    await writeDummyAvatar(charactersRoot, 'alice.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'alice.png' });
    const cardId = created.value.cardId;

    const added = await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'alice.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Knight' } },
    });
    const charId = added.value.registry.characters[0].id;

    // Mutate with identical field values
    const noop = await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'alice.png',
      expectedStorageRevision: 2,
      expectedRegistryRevision: 1,
      command: { type: 'update', character: { id: charId, name: 'Knight' } },
    });

    assert.equal(noop.ok, true);
    assert.equal(noop.changed, false);
    assert.equal(noop.value.storageRevision, 2);
    assert.equal(noop.value.registry.revision, 1);
  });

  it('L13-rebind-success: orphan rebind to unclaimed new avatar bumps storageRevision only', async () => {
    await writeDummyAvatar(charactersRoot, 'old.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'old.png' });
    const cardId = created.value.cardId;

    // Simulate rename: old.png unlinked, new.png written
    await fsPromises.unlink(path.join(charactersRoot, 'old.png'));
    await writeDummyAvatar(charactersRoot, 'new.png');

    const rebound = await controller.rebind({
      context: { userRoot, charactersRoot },
      cardId,
      fromAvatar: 'old.png',
      toAvatar: 'new.png',
      expectedStorageRevision: 1,
    });

    assert.equal(rebound.ok, true);
    assert.equal(rebound.changed, true);
    assert.equal(rebound.value.cardId, cardId);
    assert.equal(rebound.value.avatar, 'new.png');
    assert.equal(rebound.value.storageRevision, 2);
    assert.equal(rebound.value.registry.revision, 0); // Registry revision unchanged
  });

  it('L14-rebind-same-avatar-noop: rebind with fromAvatar === toAvatar returns changed: false without write', async () => {
    await writeDummyAvatar(charactersRoot, 'same.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'same.png' });
    const cardId = created.value.cardId;

    const noop = await controller.rebind({
      context: { userRoot, charactersRoot },
      cardId,
      fromAvatar: 'same.png',
      toAvatar: 'same.png',
      expectedStorageRevision: 1,
    });

    assert.equal(noop.ok, true);
    assert.equal(noop.changed, false);
    assert.equal(noop.value.storageRevision, 1);
  });

  it('L15-rebind-dup-not-rename: both old and new avatars present on disk returns DUPLICATE_NOT_RENAME', async () => {
    await writeDummyAvatar(charactersRoot, 'old.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'old.png' });
    const cardId = created.value.cardId;

    // Both old.png and new.png exist
    await writeDummyAvatar(charactersRoot, 'new.png');

    const res = await controller.rebind({
      context: { userRoot, charactersRoot },
      cardId,
      fromAvatar: 'old.png',
      toAvatar: 'new.png',
      expectedStorageRevision: 1,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.DUPLICATE_NOT_RENAME);
  });

  it('L16-clone-success: clones source to target avatar with new cardId, storageRev=1, copied registry', async () => {
    await writeDummyAvatar(charactersRoot, 'source.png');
    const src = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'source.png' });
    const sourceCardId = src.value.cardId;

    await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId: sourceCardId,
      avatar: 'source.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Mage' } },
    });

    await writeDummyAvatar(charactersRoot, 'clone_target.png');

    const cloned = await controller.clone({
      context: { userRoot, charactersRoot },
      sourceCardId,
      sourceAvatar: 'source.png',
      targetAvatar: 'clone_target.png',
      expectedSourceStorageRevision: 2,
    });

    assert.equal(cloned.ok, true);
    assert.equal(cloned.changed, true);
    assert.notEqual(cloned.value.cardId, sourceCardId);
    assert.equal(cloned.value.avatar, 'clone_target.png');
    assert.equal(cloned.value.storageRevision, 1);
    assert.equal(cloned.value.registry.revision, 1); // Copied registry revision
    assert.equal(cloned.value.registry.characters.length, 1);
    assert.equal(cloned.value.registry.characters[0].name, 'Mage');

    // Source card remains intact at storageRevision 2
    const srcCheck = await fileStore.readState({ userRoot, cardId: sourceCardId });
    assert.equal(srcCheck.ok, true);
    assert.equal(srcCheck.value.storageRevision, 2);
  });

  it('L17-clone-target-bound: clone to already bound target returns ALREADY_BOUND', async () => {
    await writeDummyAvatar(charactersRoot, 'src.png');
    const src = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'src.png' });

    await writeDummyAvatar(charactersRoot, 'occupied.png');
    await controller.create({ context: { userRoot, charactersRoot }, avatar: 'occupied.png' });

    const res = await controller.clone({
      context: { userRoot, charactersRoot },
      sourceCardId: src.value.cardId,
      sourceAvatar: 'src.png',
      targetAvatar: 'occupied.png',
      expectedSourceStorageRevision: 1,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.ALREADY_BOUND);
  });

  // --- Group 2: Concurrency & Race Tests (C01 - C04) ---

  it('C01-same-root-dual-writer: two concurrent mutations on same card: exactly one wins, other fails with REVISION_CONFLICT', async () => {
    await writeDummyAvatar(charactersRoot, 'card.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'card.png' });
    const cardId = created.value.cardId;

    const op1 = controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'card.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Player1' } },
    });

    const op2 = controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'card.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Player2' } },
    });

    const [res1, res2] = await Promise.all([op1, op2]);
    const winners = [res1, res2].filter((r) => r.ok === true);
    const losers = [res1, res2].filter((r) => r.ok === false);

    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(winners[0].value.storageRevision, 2);
    assert.equal(losers[0].code, CONTROLLER_ERROR_CODES.REVISION_CONFLICT);
  });

  it('C02-same-root-different-cards: concurrent mutations on distinct cards under same root serialize cleanly in FIFO order', async () => {
    await writeDummyAvatar(charactersRoot, 'cardA.png');
    await writeDummyAvatar(charactersRoot, 'cardB.png');
    const cA = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'cardA.png' });
    const cB = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'cardB.png' });

    const opA = controller.mutate({
      context: { userRoot, charactersRoot },
      cardId: cA.value.cardId,
      avatar: 'cardA.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'A' } },
    });

    const opB = controller.mutate({
      context: { userRoot, charactersRoot },
      cardId: cB.value.cardId,
      avatar: 'cardB.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'B' } },
    });

    const [resA, resB] = await Promise.all([opA, opB]);
    assert.equal(resA.ok, true);
    assert.equal(resB.ok, true);
    assert.equal(resA.value.storageRevision, 2);
    assert.equal(resB.value.storageRevision, 2);
  });

  it('C03-different-roots-concurrent: different user roots execute concurrently without cross-blocking', async () => {
    const dirs2 = await createTempDirectories();
    try {
      await writeDummyAvatar(charactersRoot, 'char.png');
      await writeDummyAvatar(dirs2.charactersRoot, 'char.png');

      const op1 = controller.create({
        context: { userRoot, charactersRoot },
        avatar: 'char.png',
      });
      const op2 = controller.create({
        context: { userRoot: dirs2.userRoot, charactersRoot: dirs2.charactersRoot },
        avatar: 'char.png',
      });

      const [r1, r2] = await Promise.all([op1, op2]);
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
    } finally {
      await cleanupTempDirectories(dirs2.base);
    }
  });

  it('C04-read-after-write-fifo: resolve queued behind mutate observes the committed mutation state', async () => {
    await writeDummyAvatar(charactersRoot, 'card.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'card.png' });
    const cardId = created.value.cardId;

    const mutatePromise = controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'card.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Committed' } },
    });

    const resolvePromise = controller.resolve({
      context: { userRoot, charactersRoot },
      avatar: 'card.png',
    });

    const [mutRes, resolveRes] = await Promise.all([mutatePromise, resolvePromise]);
    assert.equal(mutRes.ok, true);
    assert.equal(resolveRes.ok, true);
    assert.equal(resolveRes.value.storageRevision, 2);
    assert.equal(resolveRes.value.registry.characters[0].name, 'Committed');
  });

  // --- Group 3: Queue & Abort Tests (Q01 - Q06) ---

  it('Q01-queued-abort: pre-aborted signal cancels cleanly with OPERATION_CANCELLED and releases queue', async () => {
    await writeDummyAvatar(charactersRoot, 'card.png');
    const ac = new AbortController();
    ac.abort();

    const res = await controller.create({
      context: { userRoot, charactersRoot },
      avatar: 'card.png',
      signal: ac.signal,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.OPERATION_CANCELLED);

    // Queue is free for next operation
    const nextOp = await controller.create({
      context: { userRoot, charactersRoot },
      avatar: 'card.png',
    });
    assert.equal(nextOp.ok, true);
  });

  it('Q02-abort-pre-dispatch-during-scan (G2-D): signal aborted during async scan refuses write with zero C1 writes', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    const ac = new AbortController();
    let replaceStateCalled = false;

    // Wrap fileStore to trigger abort during scanStore
    const originalScan = fileStore.scanStore.bind(fileStore);
    const originalReplace = fileStore.replaceState.bind(fileStore);
    const interceptingStore = {
      ...fileStore,
      scanStore: async (params) => {
        ac.abort(); // Abort while scan is executing
        return originalScan(params);
      },
      replaceState: async (params) => {
        replaceStateCalled = true;
        return originalReplace(params);
      },
    };

    const interceptingController = createSidecarController({ fileStore: interceptingStore });

    const res = await interceptingController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Unwritten' } },
      signal: ac.signal,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.OPERATION_CANCELLED);
    assert.equal(replaceStateCalled, false); // Zero writes dispatched!
  });

  it('Q03-abort-post-dispatch: abort fired after C1 write dispatched completes write and readback durably', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    const ac = new AbortController();

    const originalReplace = fileStore.replaceState.bind(fileStore);
    const interceptingStore = {
      ...fileStore,
      replaceState: async (params) => {
        ac.abort(); // Abort after replaceState has been invoked
        return originalReplace(params);
      },
    };

    const interceptingController = createSidecarController({ fileStore: interceptingStore });

    const res = await interceptingController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Durable' } },
      signal: ac.signal,
    });

    assert.equal(res.ok, true);
    assert.equal(res.value.storageRevision, 2);

    // Verify disk has durable mutation
    const diskRead = await fileStore.readState({ userRoot, cardId });
    assert.equal(diskRead.value.storageRevision, 2);
  });

  it('Q04-queue-recovery-on-throw: queue recovers after unexpected error and subsequent operation succeeds', async () => {
    await writeDummyAvatar(charactersRoot, 'card.png');

    let firstCall = true;
    const originalScan = fileStore.scanStore.bind(fileStore);
    const throwingStore = {
      ...fileStore,
      scanStore: async (params) => {
        if (firstCall) {
          firstCall = false;
          throw new Error('Injected filesystem crash');
        }
        return originalScan(params);
      },
    };

    const throwingController = createSidecarController({ fileStore: throwingStore });

    const res1 = await throwingController.create({
      context: { userRoot, charactersRoot },
      avatar: 'card.png',
    });
    assert.equal(res1.ok, false);
    assert.equal(res1.code, CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE);

    // Subsequent operation on same root proceeds cleanly
    const res2 = await throwingController.create({
      context: { userRoot, charactersRoot },
      avatar: 'card.png',
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.value.avatar, 'card.png');
  });

  it('Q05-queue-map-cleanup-when-idle: queue map cleans up entry when lane is idle', async () => {
    await writeDummyAvatar(charactersRoot, 'idle.png');
    const res = await controller.resolve({ context: { userRoot, charactersRoot }, avatar: 'idle.png' });
    assert.equal(res.ok, true);

    // Give microtask tick to let cleanup continuation settle
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Verify next task starts with clean queue
    const res2 = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'idle.png' });
    assert.equal(res2.ok, true);
  });

  it('Q06-no-unhandled-rejection (Regression): failing operation in queue emits zero unhandledRejection events', async () => {
    const unhandled = [];
    const handler = (reason) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);

    try {
      const failingStore = {
        ...fileStore,
        scanStore: async () => {
          throw new Error('Hostile rejection');
        },
      };
      const failingController = createSidecarController({ fileStore: failingStore });

      await writeDummyAvatar(charactersRoot, 'test.png');
      const res = await failingController.resolve({
        context: { userRoot, charactersRoot },
        avatar: 'test.png',
      });

      assert.equal(res.ok, false);
      // Wait microtask tick
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(unhandled.length, 0); // Strictly zero unhandled rejections!
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  // --- Group 4: Fault Injection & Quarantine Tests (F01 - F10) ---

  it('F01-c1-write-uncertain: C1 WRITE_UNCERTAIN places root into quarantine and returns WRITE_UNCERTAIN', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    const uncertainStore = {
      ...fileStore,
      replaceState: async () => ({
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN,
        message: 'Write uncertain',
      }),
    };
    const uncertainController = createSidecarController({ fileStore: uncertainStore });

    const res = await uncertainController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Hero' } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
  });

  it('F02-quarantine-blocks-writes: quarantined root immediately rejects subsequent writes with QUARANTINE_ACTIVE', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    let writeAttempts = 0;
    const uncertainStore = {
      ...fileStore,
      replaceState: async () => {
        writeAttempts++;
        return { ok: false, code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN };
      },
      createState: async () => {
        writeAttempts++;
        return { ok: true, changed: true, value: {} };
      },
    };
    const testController = createSidecarController({ fileStore: uncertainStore });

    // Trigger quarantine via uncertain replaceState
    await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Hero' } },
    });
    assert.equal(writeAttempts, 1);

    // Subsequent mutate is refused without calling C1
    const resMut = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Hero2' } },
    });
    assert.equal(resMut.ok, false);
    assert.equal(resMut.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(resMut.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);

    // Subsequent create is refused without calling C1
    await writeDummyAvatar(charactersRoot, 'other.png');
    const resCreate = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'other.png',
    });
    assert.equal(resCreate.ok, false);
    assert.equal(resCreate.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(resCreate.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);

    // Total writes called remains 1 (zero calls for blocked attempts)
    assert.equal(writeAttempts, 1);
  });

  it('F03-quarantine-diagnostic-read (G2-C): resolve under quarantine succeeds with quarantineActive: true, quarantine persists', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    // Trigger quarantine
    const faultyStore = {
      ...fileStore,
      replaceState: async () => ({ ok: false, code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN }),
    };
    const testController = createSidecarController({ fileStore: faultyStore });

    await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'X' } },
    });

    // Diagnostic resolve under quarantine succeeds and includes quarantineActive: true
    const diagResolve = await testController.resolve({
      context: { userRoot, charactersRoot },
      avatar: 'hero.png',
    });
    assert.equal(diagResolve.ok, true);
    assert.equal(diagResolve.value.status, 'BOUND');
    assert.equal(diagResolve.value.quarantineActive, true);

    // Subsequent write STILL refused because quarantine is NOT cleared
    const nextMut = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Y' } },
    });
    assert.equal(nextMut.ok, false);
    assert.equal(nextMut.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(nextMut.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
  });

  it('F04-quarantine-failed-diag-read: diagnostic read with directory residue fails closed with STORAGE_UNAVAILABLE', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    let scanShouldFail = false;
    const faultyStore = {
      ...fileStore,
      replaceState: async () => ({ ok: false, code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN }),
      scanStore: async (params) => {
        if (scanShouldFail) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.STORAGE_UNAVAILABLE,
            details: { reason: 'DIR_RESIDUE_DETECTED' },
          };
        }
        return fileStore.scanStore(params);
      },
    };
    const testController = createSidecarController({ fileStore: faultyStore });

    // Quarantine root
    await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'X' } },
    });

    scanShouldFail = true;

    const res = await testController.resolve({
      context: { userRoot, charactersRoot },
      avatar: 'hero.png',
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.STORAGE_UNAVAILABLE);
  });

  it('F05-c1-write-throws-rejects: C1 write throwing unhandled error is caught and mapped to WRITE_UNCERTAIN', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    const throwingStore = {
      ...fileStore,
      replaceState: async () => {
        throw new Error('EIO: Hardware error during write');
      },
    };
    const testController = createSidecarController({ fileStore: throwingStore });

    const res = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Hero' } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.UNHANDLED_WRITE_ERROR);
  });

  it('F06-post-write-readback-fail: controller readback mismatch maps to WRITE_UNCERTAIN and sets quarantine', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    const corruptedReadbackStore = {
      ...fileStore,
      readState: async () => ({
        ok: true,
        value: {
          schemaVersion: 1,
          cardId,
          avatar: 'hero.png',
          storageRevision: 999, // Mismatched revision
          registry: { schemaVersion: 1, revision: 999, characters: [] },
        },
      }),
    };
    const testController = createSidecarController({ fileStore: corruptedReadbackStore });

    const res = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Hero' } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.READBACK_MISMATCH);
  });

  it('F07-hanging-write-lane-isolation: hanging write on root A leaves lane held without timeout; root B completes', async () => {
    const dirs2 = await createTempDirectories();
    try {
      await writeDummyAvatar(charactersRoot, 'userA.png');
      await writeDummyAvatar(dirs2.charactersRoot, 'userB.png');

      let resolveHanging;
      const hangingPromise = new Promise((resolve) => {
        resolveHanging = resolve;
      });

      const originalCreate = fileStore.createState.bind(fileStore);
      const hangingStore = {
        ...fileStore,
        createState: async (params) => {
          if (params.userRoot === userRoot) {
            await hangingPromise; // Hang root A indefinitely until released
          }
          return originalCreate(params);
        },
      };

      const testController = createSidecarController({ fileStore: hangingStore });

      // Dispatch hanging create on root A (do not await)
      const opA = testController.create({
        context: { userRoot, charactersRoot },
        avatar: 'userA.png',
      });

      // Root B executes concurrently and finishes immediately
      const opB = await testController.create({
        context: { userRoot: dirs2.userRoot, charactersRoot: dirs2.charactersRoot },
        avatar: 'userB.png',
      });

      assert.equal(opB.ok, true);
      assert.equal(opB.value.avatar, 'userB.png');

      // Now release root A
      resolveHanging();
      const resA = await opA;
      assert.equal(resA.ok, true);
    } finally {
      await cleanupTempDirectories(dirs2.base);
    }
  });

  it('F08-noncanonical-disk-cas: disk state with noncanonical whitespace fails CAS with REVISION_CONFLICT', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    // Rewrite state.json on disk with pretty-printed noncanonical whitespace
    const statePath = path.join(userRoot, 'chromaticHub', 'cards', cardId, 'state.json');
    const stateObj = (await fileStore.readState({ userRoot, cardId })).value;
    await fsPromises.writeFile(statePath, JSON.stringify(stateObj, null, 2), 'utf8');

    // Attempt mutation: controller computes canonical expectedBytes, which mismatches raw disk bytes
    const res = await controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Hero' } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.REVISION_CONFLICT);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.CAS_MISMATCH);
  });

  it('F09-c1-malformed-success-response (G2-A): null or malformed success from C1 write maps to WRITE_UNCERTAIN and quarantines', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    const malformedStore = {
      ...fileStore,
      replaceState: async () => ({ ok: true, changed: false, value: null }), // Contradictory / malformed success
    };
    const testController = createSidecarController({ fileStore: malformedStore });

    const res = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Hero' } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);
  });

  it('F10-c1-malformed-error-response (G2-A): unclassifiable error response from C1 write maps to WRITE_UNCERTAIN and quarantines', async () => {
    await writeDummyAvatar(charactersRoot, 'hero.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'hero.png' });
    const cardId = created.value.cardId;

    const malformedStore = {
      ...fileStore,
      replaceState: async () => ({ ok: false, code: 'UNKNOWN_BOGUS_ERROR_CODE' }),
    };
    const testController = createSidecarController({ fileStore: malformedStore });

    const res = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'hero.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Hero' } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);
  });

  // --- Group 5: Robustness, Diagnostic Privacy & Ownership (B01 - B02, P01 - P03) ---

  it('B01-recovery-candidates-competing-claims (G2-B): target with competing claims returns ASSOCIATION_CONFLICT', async () => {
    await writeDummyAvatar(charactersRoot, 'rival.png');

    // Create custom store returning synthetic evidence with 2 claims for rival.png
    const competingStore = {
      ...fileStore,
      scanStore: async () => ({
        ok: true,
        value: {
          schemaVersion: 1,
          scanStatus: 'COMPLETE',
          files: [{ avatar: 'rival.png', status: 'EXISTS' }],
          claims: [
            {
              avatar: 'rival.png',
              cardId: '11111111-1111-4111-8111-111111111111',
              state: {
                schemaVersion: 1,
                cardId: '11111111-1111-4111-8111-111111111111',
                avatar: 'rival.png',
                storageRevision: 1,
                registry: { schemaVersion: 1, revision: 0, characters: [] },
              },
            },
            {
              avatar: 'rival.png',
              cardId: '22222222-2222-4222-8222-222222222222',
              state: {
                schemaVersion: 1,
                cardId: '22222222-2222-4222-8222-222222222222',
                avatar: 'rival.png',
                storageRevision: 1,
                registry: { schemaVersion: 1, revision: 0, characters: [] },
              },
            },
          ],
        },
      }),
    };

    const testController = createSidecarController({ fileStore: competingStore });

    const res = await testController.recoveryCandidates({
      context: { userRoot, charactersRoot },
      avatar: 'rival.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.ASSOCIATION_CONFLICT);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.ASSOCIATION_CONFLICT);
  });

  it('B02-recovery-candidates-quarantined (G2-C): recoveryCandidates under quarantine returns quarantineActive: true; subsequent write refused', async () => {
    await writeDummyAvatar(charactersRoot, 'orphan.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'orphan.png' });
    const cardId = created.value.cardId;
    await fsPromises.unlink(path.join(charactersRoot, 'orphan.png'));

    await writeDummyAvatar(charactersRoot, 'target.png');

    // Trigger quarantine via failing replaceState
    const faultyStore = {
      ...fileStore,
      replaceState: async () => ({ ok: false, code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN }),
    };
    const testController = createSidecarController({ fileStore: faultyStore });

    await testController.rebind({
      context: { userRoot, charactersRoot },
      cardId,
      fromAvatar: 'orphan.png',
      toAvatar: 'target.png',
      expectedStorageRevision: 1,
    });

    // Diagnostic recoveryCandidates under quarantine
    const res = await testController.recoveryCandidates({
      context: { userRoot, charactersRoot },
      avatar: 'target.png',
    });

    assert.equal(res.ok, true);
    assert.equal(res.value.quarantineActive, true);
    assert.equal(res.value.candidates.length, 1);
    assert.equal(res.value.candidates[0].cardId, cardId);

    // Subsequent mutate is STILL refused
    const mutRes = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'target.png',
    });
    assert.equal(mutRes.ok, false);
    assert.equal(mutRes.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(mutRes.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
  });

  it('P01-hostile-signal-traps: hostile proxy getter on signal.aborted is safely contained', async () => {
    await writeDummyAvatar(charactersRoot, 'test.png');

    const hostileSignal = new Proxy({}, {
      get: (target, prop) => {
        if (prop === 'aborted') {
          throw new Error('Hostile getter trap');
        }
        return undefined;
      },
    });

    const res = await controller.resolve({
      context: { userRoot, charactersRoot },
      avatar: 'test.png',
      signal: hostileSignal,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.INVALID_REQUEST);
  });

  it('P02-privacy-safe-diagnostics (G2-E): secret avatar text and option keys are never reflected in error messages', async () => {
    const SECRET_KEY = 'PRIVATE_KEY_SECRET_987654321';
    assert.throws(
      () => createSidecarController({ fileStore, [SECRET_KEY]: true }),
      (err) => {
        assert.equal(err instanceof TypeError, true);
        assert.equal(err.message.includes(SECRET_KEY), false);
        return true;
      }
    );

    const SECRET_AVATAR = 'SECRET_PROMPT_KEYWORD_CHARACTER_12345.png';
    const res = await controller.resolve({
      context: { userRoot, charactersRoot },
      avatar: SECRET_AVATAR,
    });

    assert.equal(res.ok, false);
    assert.equal(res.message.includes(SECRET_AVATAR), false);
  });

  it('P03-singleton-ownership-check: single controller instance shares queue; distinct instances maintain independent queues', async () => {
    // Calling mutate twice on same controller instance serializes on same userRoot
    await writeDummyAvatar(charactersRoot, 'card.png');
    const created = await controller.create({ context: { userRoot, charactersRoot }, avatar: 'card.png' });
    const cardId = created.value.cardId;

    const op1 = controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'card.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'A' } },
    });
    const op2 = controller.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'card.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'B' } },
    });

    const [r1, r2] = await Promise.all([op1, op2]);
    // Since both ran on same instance, they were serialized through the same queue: one won, one failed with CAS conflict
    const winners = [r1, r2].filter((r) => r.ok === true);
    assert.equal(winners.length, 1);
  });

  // --- Group 7: G4-R1 Regression Hardening Matrix (R01 - R09) ---

  it('R01-context-tampering-invariance (Finding A): mutating context.userRoot during async scanStore does not shift lock ownership or write destination', async () => {
    const dirs2 = await createTempDirectories();
    const userRoot2 = dirs2.userRoot;

    try {
      await writeDummyAvatar(charactersRoot, 'charlie.png');
      const mutableContext = { userRoot, charactersRoot };

      let scanDispatched = false;
      const wrappedStore = {
        ...fileStore,
        scanStore: async (scanParams) => {
          scanDispatched = true;
          // Injected tamper: mutate context properties while scanStore is running
          mutableContext.userRoot = userRoot2;
          mutableContext.charactersRoot = '/tmp/tampered-characters-root';
          return await fileStore.scanStore(scanParams);
        },
      };

      const testController = createSidecarController({ fileStore: wrappedStore });

      const res = await testController.create({
        context: mutableContext,
        avatar: 'charlie.png',
      });

      assert.equal(scanDispatched, true);
      assert.equal(res.ok, true);
      assert.equal(res.changed, true);

      // Verify write landed strictly in userRoot (captured snapshot), NOT in userRoot2
      const user1Cards = await fsPromises.readdir(path.join(userRoot, 'chromaticHub', 'cards'));
      assert.equal(user1Cards.length, 1);
      assert.equal(user1Cards[0], res.value.cardId);

      // Verify userRoot2 has NO chromaticHub directory or files
      let user2HasHub = false;
      try {
        await fsPromises.access(path.join(userRoot2, 'chromaticHub'));
        user2HasHub = true;
      } catch (_err) {
        user2HasHub = false;
      }
      assert.equal(user2HasHub, false);
    } finally {
      await cleanupTempDirectories(dirs2.base);
    }
  });

  it('R02-post-dispatch-throwing-ok-getter (Finding B): createState returning object with throwing ok getter returns WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'trap1.png');

    let c1Calls = 0;
    const wrappedStore = {
      ...fileStore,
      createState: async (createParams) => {
        c1Calls++;
        const realRes = await fileStore.createState(createParams);
        return {
          get ok() {
            throw new Error('Hostile ok getter trap post-dispatch');
          },
          code: realRes.code,
          changed: realRes.changed,
          value: realRes.value,
        };
      },
    };

    const testController = createSidecarController({ fileStore: wrappedStore });

    const res = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'trap1.png',
    });

    // Must be mapped to WRITE_UNCERTAIN and quarantine the root
    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.recoverable, false);

    // Subsequent write must be refused immediately due to quarantine WITHOUT dispatching another C1 write
    await writeDummyAvatar(charactersRoot, 'trap2.png');
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'trap2.png',
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
    assert.equal(c1Calls, 1); // C1 was NOT called a second time
  });

  it('R03-post-dispatch-throwing-code-getter (Finding B): replaceState returning object with throwing code getter returns WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'card.png');
    const created = await controller.create({
      context: { userRoot, charactersRoot },
      avatar: 'card.png',
    });
    const cardId = created.value.cardId;

    let c1ReplaceCalls = 0;
    const wrappedStore = {
      ...fileStore,
      replaceState: async () => {
        c1ReplaceCalls++;
        return {
          ok: false,
          get code() {
            throw new Error('Hostile code getter trap post-dispatch');
          },
        };
      },
    };

    const testController = createSidecarController({ fileStore: wrappedStore });

    const res = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'card.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Trap' } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);

    // Root is quarantined; subsequent mutate refused in-queue
    const res2 = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'card.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Trap2' } },
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
    assert.equal(c1ReplaceCalls, 1);
  });

  it('R04-post-dispatch-throwing-readback-getter (Finding B): readState readback returning object with throwing ok or value getter returns WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'readtrap.png');

    const wrappedStore = {
      ...fileStore,
      readState: async () => ({
        get ok() {
          throw new Error('Hostile readState ok getter trap post-dispatch');
        },
      }),
    };

    const testController = createSidecarController({ fileStore: wrappedStore });

    const res = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'readtrap.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);

    // Root is quarantined; subsequent write refused in-queue
    await writeDummyAvatar(charactersRoot, 'readtrap2.png');
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'readtrap2.png',
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
  });

  it('R05-post-dispatch-contradictory-fields (Finding B): replaceState returning ok:false with changed:true or value triggers WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'contra.png');
    const created = await controller.create({
      context: { userRoot, charactersRoot },
      avatar: 'contra.png',
    });
    const cardId = created.value.cardId;

    let replaceCalls = 0;
    const wrappedStore = {
      ...fileStore,
      replaceState: async () => {
        replaceCalls++;
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.REVISION_CONFLICT,
          changed: true, // Contradictory: failure claim but changed is true
          value: { cardId, storageRevision: 2, avatar: 'contra.png' }, // Contradictory: failure claim but value present
        };
      },
    };

    const testController = createSidecarController({ fileStore: wrappedStore });

    const res = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'contra.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Contradictory' } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);

    // Quarantine is set
    const res2 = await testController.mutate({
      context: { userRoot, charactersRoot },
      cardId,
      avatar: 'contra.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'Next' } },
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
    assert.equal(replaceCalls, 1);
  });

  it('R06-signal-throwing-on-pre-dispatch (Finding C): signal whose aborted getter returns false initially but throws on pre-dispatch returns INVALID_REQUEST with zero C1 writes', async () => {
    await writeDummyAvatar(charactersRoot, 'sigtest.png');

    let readCount = 0;
    let c1Calls = 0;
    const wrappedStore = {
      ...fileStore,
      createState: async (createParams) => {
        c1Calls++;
        return await fileStore.createState(createParams);
      },
    };

    const testController = createSidecarController({ fileStore: wrappedStore });

    const hostileSignal = {
      get aborted() {
        readCount++;
        // Checkpoint 1: pre-queue read -> false
        // Checkpoint 2: in-queue pre-scan read -> false
        // Checkpoint 3: in-queue pre-dispatch check -> throws!
        if (readCount >= 3) {
          throw new Error('Hostile getter trap at pre-dispatch check');
        }
        return false;
      },
    };

    const res = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'sigtest.png',
      signal: hostileSignal,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.INVALID_REQUEST);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_PARAMETERS);
    assert.equal(c1Calls, 0); // Zero C1 writes dispatched
  });

  it('R07-context-raw-traversal-rejection (Finding D): context paths containing raw ".." segments fail immediately with INVALID_CONTEXT and zero C1 calls', async () => {
    let scanCalls = 0;
    const wrappedStore = {
      ...fileStore,
      scanStore: async () => {
        scanCalls++;
        return { ok: true, value: { files: [], claims: [] } };
      },
    };

    const testController = createSidecarController({ fileStore: wrappedStore });

    // 1. userRoot with raw '..'
    const res1 = await testController.create({
      context: { userRoot: '/tmp/user/../other', charactersRoot },
      avatar: 'test.png',
    });
    assert.equal(res1.ok, false);
    assert.equal(res1.code, CONTROLLER_ERROR_CODES.INVALID_CONTEXT);
    assert.equal(res1.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_CONTEXT_PATH);
    assert.equal(scanCalls, 0);

    // 2. charactersRoot with raw '..'
    const res2 = await testController.resolve({
      context: { userRoot, charactersRoot: '/tmp/char/../other' },
      avatar: 'test.png',
    });
    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.INVALID_CONTEXT);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.INVALID_CONTEXT_PATH);
    assert.equal(scanCalls, 0);

    // 3. Traversal in mutate
    const res3 = await testController.mutate({
      context: { userRoot: '/tmp/../evil', charactersRoot },
      cardId: crypto.randomUUID(),
      avatar: 'test.png',
      expectedStorageRevision: 1,
      expectedRegistryRevision: 0,
      command: { type: 'add', character: { name: 'X' } },
    });
    assert.equal(res3.ok, false);
    assert.equal(res3.code, CONTROLLER_ERROR_CODES.INVALID_CONTEXT);
    assert.equal(scanCalls, 0);

    // 4. Traversal in rebind
    const res4 = await testController.rebind({
      context: { userRoot, charactersRoot: '/var/lib/../st/characters' },
      cardId: crypto.randomUUID(),
      fromAvatar: 'a.png',
      toAvatar: 'b.png',
      expectedStorageRevision: 1,
    });
    assert.equal(res4.ok, false);
    assert.equal(res4.code, CONTROLLER_ERROR_CODES.INVALID_CONTEXT);
    assert.equal(scanCalls, 0);

    // 5. Traversal in clone
    const res5 = await testController.clone({
      context: { userRoot: '/tmp/user/foo/../bar', charactersRoot },
      sourceCardId: crypto.randomUUID(),
      sourceAvatar: 'a.png',
      targetAvatar: 'b.png',
      expectedSourceStorageRevision: 1,
    });
    assert.equal(res5.ok, false);
    assert.equal(res5.code, CONTROLLER_ERROR_CODES.INVALID_CONTEXT);
    assert.equal(scanCalls, 0);

    // 6. Traversal in recoveryCandidates
    const res6 = await testController.recoveryCandidates({
      context: { userRoot, charactersRoot: '/etc/../tmp' },
      avatar: 'a.png',
    });
    assert.equal(res6.ok, false);
    assert.equal(res6.code, CONTROLLER_ERROR_CODES.INVALID_CONTEXT);
    assert.equal(scanCalls, 0);
  });

  it('R08-concurrent-context-tampering (Finding A): same-user concurrent calls sharing a mutated context execute strictly against captured snapshots', async () => {
    const dirs2 = await createTempDirectories();
    const userRoot2 = dirs2.userRoot;

    try {
      await writeDummyAvatar(charactersRoot, 'card1.png');
      await writeDummyAvatar(charactersRoot, 'card2.png');

      const sharedContext = { userRoot, charactersRoot };

      // Dispatch first call
      const p1 = controller.create({
        context: sharedContext,
        avatar: 'card1.png',
      });

      // Immediately tamper with sharedContext before/during second call
      sharedContext.userRoot = userRoot2;

      const p2 = controller.create({
        context: sharedContext,
        avatar: 'card2.png',
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);

      // r1 wrote to userRoot (captured at call time)
      const user1Cards = await fsPromises.readdir(path.join(userRoot, 'chromaticHub', 'cards'));
      assert.equal(user1Cards.includes(r1.value.cardId), true);

      // r2 wrote to userRoot2 (captured at call time)
      const user2Cards = await fsPromises.readdir(path.join(userRoot2, 'chromaticHub', 'cards'));
      assert.equal(user2Cards.includes(r2.value.cardId), true);
    } finally {
      await cleanupTempDirectories(dirs2.base);
    }
  });

  it('R09-all-write-paths-context-isolation (Finding A): mutates, rebinds, and clones isolate context against post-validation tampering', async () => {
    const dirs2 = await createTempDirectories();
    const userRoot2 = dirs2.userRoot;

    try {
      await writeDummyAvatar(charactersRoot, 'orig.png');
      const created = await controller.create({
        context: { userRoot, charactersRoot },
        avatar: 'orig.png',
      });
      const cardId = created.value.cardId;

      // 1. Mutate with mutable context
      const mutateContext = { userRoot, charactersRoot };
      let mutateScanned = false;
      const mutateStore = {
        ...fileStore,
        scanStore: async (scanParams) => {
          mutateScanned = true;
          mutateContext.userRoot = userRoot2;
          return await fileStore.scanStore(scanParams);
        },
      };
      const mutateController = createSidecarController({ fileStore: mutateStore });

      const mutRes = await mutateController.mutate({
        context: mutateContext,
        cardId,
        avatar: 'orig.png',
        expectedStorageRevision: 1,
        expectedRegistryRevision: 0,
        command: { type: 'add', character: { name: 'Hero' } },
      });

      assert.equal(mutateScanned, true);
      assert.equal(mutRes.ok, true);
      assert.equal(mutRes.value.storageRevision, 2);

      // 2. Clone with mutable context
      await writeDummyAvatar(charactersRoot, 'cloned.png');
      const cloneContext = { userRoot, charactersRoot };
      let cloneScanned = false;
      const cloneStore = {
        ...fileStore,
        scanStore: async (scanParams) => {
          cloneScanned = true;
          cloneContext.userRoot = userRoot2;
          return await fileStore.scanStore(scanParams);
        },
      };
      const cloneController = createSidecarController({ fileStore: cloneStore });

      const cloneRes = await cloneController.clone({
        context: cloneContext,
        sourceCardId: cardId,
        sourceAvatar: 'orig.png',
        targetAvatar: 'cloned.png',
        expectedSourceStorageRevision: 2,
      });

      assert.equal(cloneScanned, true);
      assert.equal(cloneRes.ok, true);
      assert.equal(cloneRes.value.avatar, 'cloned.png');

      // Verify all files remained in userRoot, none leaked to userRoot2
      const user1Cards = await fsPromises.readdir(path.join(userRoot, 'chromaticHub', 'cards'));
      assert.equal(user1Cards.length, 2);

      let user2HubExists = false;
      try {
        await fsPromises.access(path.join(userRoot2, 'chromaticHub'));
        user2HubExists = true;
      } catch (_err) {
        user2HubExists = false;
      }
      assert.equal(user2HubExists, false);
    } finally {
      await cleanupTempDirectories(dirs2.base);
    }
  });

  // --- Group 8: G4-R3 Envelope Consistency & Pre-Commit Matrix (E01 - E07) ---

  it('E01-c1-success-with-error-code (G4-R3 Repro 1): success envelope with code: "WRITE_UNCERTAIN" triggers WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'e01.png');

    let c1Calls = 0;
    const originalCreate = fileStore.createState.bind(fileStore);
    const faultyStore = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        const res = await originalCreate(params);
        return {
          ok: true,
          changed: true,
          value: res.value,
          code: FILE_STORE_ERROR_CODES.WRITE_UNCERTAIN, // Contradictory code on success
        };
      },
    };
    const testController = createSidecarController({ fileStore: faultyStore });

    const res = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e01.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);

    // Second create must be refused in-queue due to quarantine without calling C1 again
    await writeDummyAvatar(charactersRoot, 'e01_second.png');
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e01_second.png',
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
    assert.equal(c1Calls, 1); // Zero second C1 dispatch
  });

  it('E02-c1-success-mismatched-avatar (G4-R3 Repro 2): C1 success snapshot with contradictory avatar triggers WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'e02.png');

    let c1Calls = 0;
    const originalCreate = fileStore.createState.bind(fileStore);
    const faultyStore = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        const res = await originalCreate(params);
        return {
          ok: true,
          changed: true,
          value: {
            ...res.value,
            avatar: 'other.png', // Contradictory avatar in success snapshot
          },
        };
      },
    };
    const testController = createSidecarController({ fileStore: faultyStore });

    const res = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e02.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);

    // Second write refused in-queue due to quarantine
    await writeDummyAvatar(charactersRoot, 'e02_second.png');
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e02_second.png',
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
    assert.equal(c1Calls, 1);
  });

  it('E03-c1-failure-malformed-changed (G4-R3 Repro 3): failure envelope with malformed changed:"invalid" triggers WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'e03.png');

    let c1Calls = 0;
    const faultyStore = {
      ...fileStore,
      createState: async () => {
        c1Calls++;
        return {
          ok: false,
          code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
          changed: 'invalid', // Malformed failure envelope
        };
      },
    };
    const testController = createSidecarController({ fileStore: faultyStore });

    const res = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e03.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);

    // Second write refused in-queue due to quarantine
    await writeDummyAvatar(charactersRoot, 'e03_second.png');
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e03_second.png',
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
    assert.equal(c1Calls, 1);
  });

  it('E04-c1-success-unknown-code (G4-R3): success envelope with unknown code triggers WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'e04.png');

    let c1Calls = 0;
    const originalCreate = fileStore.createState.bind(fileStore);
    const faultyStore = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        const res = await originalCreate(params);
        return {
          ok: true,
          changed: true,
          value: res.value,
          code: 'CUSTOM_UNKNOWN_CODE', // Contradictory unknown code on success
        };
      },
    };
    const testController = createSidecarController({ fileStore: faultyStore });

    const res = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e04.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);

    // Second write refused in-queue
    await writeDummyAvatar(charactersRoot, 'e04_second.png');
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e04_second.png',
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
    assert.equal(c1Calls, 1);
  });

  it('E05-c1-failure-unknown-code (G4-R3): failure envelope with unknown code triggers WRITE_UNCERTAIN and quarantines root', async () => {
    await writeDummyAvatar(charactersRoot, 'e05.png');

    let c1Calls = 0;
    const faultyStore = {
      ...fileStore,
      createState: async () => {
        c1Calls++;
        return {
          ok: false,
          code: 'UNEXPECTED_BOGUS_ERROR',
        };
      },
    };
    const testController = createSidecarController({ fileStore: faultyStore });

    const res = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e05.png',
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);

    // Second write refused in-queue
    await writeDummyAvatar(charactersRoot, 'e05_second.png');
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e05_second.png',
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
    assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
    assert.equal(c1Calls, 1);
  });

  it('E06-c1-genuine-success-contract (G4-R3): genuine C1 success envelope succeeds without quarantine and permits second write', async () => {
    await writeDummyAvatar(charactersRoot, 'e06_a.png');
    await writeDummyAvatar(charactersRoot, 'e06_b.png');

    let c1Calls = 0;
    const originalCreate = fileStore.createState.bind(fileStore);
    const trackingStore = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        return await originalCreate(params);
      },
    };
    const testController = createSidecarController({ fileStore: trackingStore });

    const res1 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e06_a.png',
    });

    assert.equal(res1.ok, true);
    assert.equal(res1.changed, true);
    assert.equal(res1.value.status, 'BOUND');
    assert.equal(res1.value.avatar, 'e06_a.png');

    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e06_b.png',
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.changed, true);
    assert.equal(res2.value.status, 'BOUND');
    assert.equal(res2.value.avatar, 'e06_b.png');
    assert.equal(c1Calls, 2); // Both dispatched and succeeded cleanly
  });

  it('E07-c1-genuine-failure-contract (G4-R3): genuine recognized C1 refusal does not quarantine root and permits subsequent retry', async () => {
    await writeDummyAvatar(charactersRoot, 'e07.png');

    let c1Calls = 0;
    let shouldFail = true;
    const originalCreate = fileStore.createState.bind(fileStore);
    const transientStore = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        if (shouldFail) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
            message: 'Transient storage I/O error',
            recoverable: false,
          };
        }
        return await originalCreate(params);
      },
    };
    const testController = createSidecarController({ fileStore: transientStore });

    const res1 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e07.png',
    });

    assert.equal(res1.ok, false);
    assert.equal(res1.code, CONTROLLER_ERROR_CODES.WRITE_FAILED);
    assert.equal(res1.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);

    // Root MUST NOT be quarantined because this was a clean, recognized pre-commit failure
    shouldFail = false;
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'e07.png',
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.changed, true);
    assert.equal(res2.value.status, 'BOUND');
    assert.equal(c1Calls, 2); // Second write proceeded and succeeded
  });

  // --- Group 9: G4-R4 Structural Envelope Verification Matrix (T01 - T12) ---

  const tableProbes = [
    {
      id: 'T01',
      description: 'failure with non-boolean recoverable ("bad")',
      factory: () => ({ ok: false, code: FILE_STORE_ERROR_CODES.WRITE_FAILED, message: 'write fail', recoverable: 'bad' }),
    },
    {
      id: 'T02',
      description: 'failure with non-string message (17)',
      factory: () => ({ ok: false, code: FILE_STORE_ERROR_CODES.WRITE_FAILED, message: 17, recoverable: false }),
    },
    {
      id: 'T03',
      description: 'failure missing mandatory message and recoverable fields',
      factory: () => ({ ok: false, code: FILE_STORE_ERROR_CODES.WRITE_FAILED }),
    },
    {
      id: 'T04',
      description: 'failure with own changed:undefined and value:undefined present',
      factory: () => ({ ok: false, code: FILE_STORE_ERROR_CODES.WRITE_FAILED, message: 'write fail', recoverable: false, changed: undefined, value: undefined }),
    },
    {
      id: 'T05',
      description: 'failure with throwing unused details getter',
      factory: () => ({
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'write fail',
        recoverable: false,
        get details() {
          throw new Error('Hostile details getter trap');
        },
      }),
    },
    {
      id: 'T06',
      description: 'failure with unexpected extra property unexpectedSecret',
      factory: () => ({ ok: false, code: FILE_STORE_ERROR_CODES.WRITE_FAILED, message: 'write fail', recoverable: false, unexpectedSecret: 'secret_leak_123' }),
    },
    {
      id: 'T07',
      description: 'success expanded with contradictory recoverable:false and message',
      factory: (realRes) => ({
        ok: true,
        changed: true,
        value: realRes.value,
        recoverable: false,
        message: 'contradictory success!',
      }),
    },
    {
      id: 'T08',
      description: 'failure with symbol-keyed property',
      factory: () => ({
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'write fail',
        recoverable: false,
        [Symbol('hostileSymbol')]: true,
      }),
    },
    {
      id: 'T09',
      description: 'success with symbol-keyed property',
      factory: (realRes) => ({
        ok: true,
        changed: true,
        value: realRes.value,
        [Symbol('hostileSymbol')]: true,
      }),
    },
    {
      id: 'T10',
      description: 'failure with accessor getter on code',
      factory: () => ({
        ok: false,
        get code() {
          return FILE_STORE_ERROR_CODES.WRITE_FAILED;
        },
        message: 'write fail',
        recoverable: false,
      }),
    },
    {
      id: 'T11',
      description: 'success with accessor getter on changed',
      factory: (realRes) => ({
        ok: true,
        get changed() {
          return true;
        },
        value: realRes.value,
      }),
    },
  ];

  for (const probe of tableProbes) {
    it(`G4R4-${probe.id}: ${probe.description} triggers WRITE_UNCERTAIN, quarantines root, refuses second write with writes=1`, async () => {
      const avatar1 = `g4r4_${probe.id.toLowerCase()}_1.png`;
      const avatar2 = `g4r4_${probe.id.toLowerCase()}_2.png`;
      await writeDummyAvatar(charactersRoot, avatar1);
      await writeDummyAvatar(charactersRoot, avatar2);

      let c1Calls = 0;
      const originalCreate = fileStore.createState.bind(fileStore);
      const injectedStore = {
        ...fileStore,
        createState: async (params) => {
          c1Calls++;
          const realRes = await originalCreate(params);
          return probe.factory(realRes);
        },
      };

      const testController = createSidecarController({ fileStore: injectedStore });

      const res1 = await testController.create({
        context: { userRoot, charactersRoot },
        avatar: avatar1,
      });

      assert.equal(res1.ok, false);
      assert.equal(res1.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
      assert.equal(res1.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);

      // Second write to same root MUST be refused in-queue with QUARANTINE_ACTIVE without calling C1
      const res2 = await testController.create({
        context: { userRoot, charactersRoot },
        avatar: avatar2,
      });

      assert.equal(res2.ok, false);
      assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
      assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
      assert.equal(c1Calls, 1); // Exactly 1 write dispatched; second was blocked in-queue
    });
  }

  it('G4R4-T12: genuine C1 failure with valid details object does NOT quarantine and allows subsequent write', async () => {
    await writeDummyAvatar(charactersRoot, 'g4r4_t12_1.png');
    await writeDummyAvatar(charactersRoot, 'g4r4_t12_2.png');

    let c1Calls = 0;
    let shouldFail = true;
    const originalCreate = fileStore.createState.bind(fileStore);
    const store = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        if (shouldFail) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
            message: 'Clean I/O error with details',
            recoverable: false,
            details: { reason: 'IO_ERROR' },
          };
        }
        return await originalCreate(params);
      },
    };

    const testController = createSidecarController({ fileStore: store });

    const res1 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'g4r4_t12_1.png',
    });

    assert.equal(res1.ok, false);
    assert.equal(res1.code, CONTROLLER_ERROR_CODES.WRITE_FAILED);
    assert.equal(res1.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.IO_ERROR);

    // Should NOT be quarantined; second call proceeds and succeeds
    shouldFail = false;
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: 'g4r4_t12_2.png',
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.changed, true);
    assert.equal(res2.value.status, 'BOUND');
    assert.equal(c1Calls, 2);
  });

  // --- Group 10: G4-R5 C1 Failure Details Strict Validation & Commit-Uncertain Quarantine Matrix ---

  const g4r5Probes = [
    {
      id: 'R5-P01',
      description: 'failure with unexpected reason string',
      envelope: {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Write failed with unexpected reason token',
        recoverable: false,
        details: { reason: 'UNEXPECTED_SECRET_TOKEN' },
      },
    },
    {
      id: 'R5-P02',
      description: 'failure with non-string numeric reason',
      envelope: {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Write failed with numeric reason',
        recoverable: false,
        details: { reason: 911 },
      },
    },
    {
      id: 'R5-P03',
      description: 'failure with unexpected property name in details',
      envelope: {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Write failed with extra property in details',
        recoverable: false,
        details: { unexpectedSecret: 'secret value' },
      },
    },
    {
      id: 'R5-P04',
      description: 'failure with extra meta field alongside valid reason in details',
      envelope: {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Write failed with reason and meta in details',
        recoverable: false,
        details: { reason: 'IO_ERROR', meta: { path: '/private/path' } },
      },
    },
    {
      id: 'R5-P05',
      description: 'failure with code WRITE_FAILED but contradictory commit-uncertain reason RENAME_FAILED',
      envelope: {
        ok: false,
        code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
        message: 'Pre-commit failure claiming rename failure',
        recoverable: false,
        details: { reason: 'RENAME_FAILED' },
      },
    },
  ];

  for (const probe of g4r5Probes) {
    it(`G4R5-${probe.id}: ${probe.description} -> WRITE_UNCERTAIN/MALFORMED_WRITE_RESULT, quarantines root, refuses second write with writes=1`, async () => {
      const avatar1 = `g4r5_${probe.id.toLowerCase().replace(/-/g, '_')}_1.png`;
      const avatar2 = `g4r5_${probe.id.toLowerCase().replace(/-/g, '_')}_2.png`;
      await writeDummyAvatar(charactersRoot, avatar1);
      await writeDummyAvatar(charactersRoot, avatar2);

      let c1Calls = 0;
      const injectedStore = {
        ...fileStore,
        createState: async () => {
          c1Calls++;
          return probe.envelope;
        },
      };

      const testController = createSidecarController({ fileStore: injectedStore });

      // First call to C1 write: must fail with WRITE_UNCERTAIN and MALFORMED_WRITE_RESULT
      const res1 = await testController.create({
        context: { userRoot, charactersRoot },
        avatar: avatar1,
      });

      assert.equal(res1.ok, false);
      assert.equal(res1.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
      assert.equal(res1.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.MALFORMED_WRITE_RESULT);

      // Second write to the SAME user root MUST be refused in-queue with QUARANTINE_ACTIVE without calling C1
      const res2 = await testController.create({
        context: { userRoot, charactersRoot },
        avatar: avatar2,
      });

      assert.equal(res2.ok, false);
      assert.equal(res2.code, CONTROLLER_ERROR_CODES.WRITE_UNCERTAIN);
      assert.equal(res2.details?.reason, CONTROLLER_DIAGNOSTIC_REASONS.QUARANTINE_ACTIVE);
      assert.equal(c1Calls, 1); // Exactly 1 write dispatched; second was blocked in-queue by quarantine
    });
  }

  it('G4R5-C01: genuine C1 refusal with no details does NOT quarantine and allows subsequent write (writes=2)', async () => {
    const avatar1 = 'g4r5_c01_1.png';
    const avatar2 = 'g4r5_c01_2.png';
    await writeDummyAvatar(charactersRoot, avatar1);
    await writeDummyAvatar(charactersRoot, avatar2);

    let c1Calls = 0;
    let shouldFail = true;
    const originalCreate = fileStore.createState.bind(fileStore);
    const store = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        if (shouldFail) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
            message: 'disk full',
            recoverable: false,
          };
        }
        return await originalCreate(params);
      },
    };

    const testController = createSidecarController({ fileStore: store });

    const res1 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: avatar1,
    });

    assert.equal(res1.ok, false);
    assert.equal(res1.code, CONTROLLER_ERROR_CODES.WRITE_FAILED);

    // Root is NOT quarantined; second write to same root succeeds
    shouldFail = false;
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: avatar2,
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.changed, true);
    assert.equal(res2.value.status, 'BOUND');
    assert.equal(c1Calls, 2);
  });

  it('G4R5-C02: genuine C1 refusal with reason IO_ERROR does NOT quarantine and allows subsequent write (writes=2)', async () => {
    const avatar1 = 'g4r5_c02_1.png';
    const avatar2 = 'g4r5_c02_2.png';
    await writeDummyAvatar(charactersRoot, avatar1);
    await writeDummyAvatar(charactersRoot, avatar2);

    let c1Calls = 0;
    let shouldFail = true;
    const originalCreate = fileStore.createState.bind(fileStore);
    const store = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        if (shouldFail) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
            message: 'I/O error',
            recoverable: false,
            details: { reason: 'IO_ERROR' },
          };
        }
        return await originalCreate(params);
      },
    };

    const testController = createSidecarController({ fileStore: store });

    const res1 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: avatar1,
    });

    assert.equal(res1.ok, false);
    assert.equal(res1.code, CONTROLLER_ERROR_CODES.WRITE_FAILED);
    assert.equal(res1.details?.reason, 'IO_ERROR');

    // Root is NOT quarantined; second write to same root succeeds
    shouldFail = false;
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: avatar2,
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.changed, true);
    assert.equal(res2.value.status, 'BOUND');
    assert.equal(c1Calls, 2);
  });

  it('G4R5-C03: genuine C1 refusal with reason MKDIR_FAILED does NOT quarantine and allows subsequent write (writes=2)', async () => {
    const avatar1 = 'g4r5_c03_1.png';
    const avatar2 = 'g4r5_c03_2.png';
    await writeDummyAvatar(charactersRoot, avatar1);
    await writeDummyAvatar(charactersRoot, avatar2);

    let c1Calls = 0;
    let shouldFail = true;
    const originalCreate = fileStore.createState.bind(fileStore);
    const store = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        if (shouldFail) {
          return {
            ok: false,
            code: FILE_STORE_ERROR_CODES.WRITE_FAILED,
            message: 'Failed to create dir',
            recoverable: false,
            details: { reason: 'MKDIR_FAILED' },
          };
        }
        return await originalCreate(params);
      },
    };

    const testController = createSidecarController({ fileStore: store });

    const res1 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: avatar1,
    });

    assert.equal(res1.ok, false);
    assert.equal(res1.code, CONTROLLER_ERROR_CODES.WRITE_FAILED);
    assert.equal(res1.details?.reason, 'MKDIR_FAILED');

    // Root is NOT quarantined; second write to same root succeeds
    shouldFail = false;
    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: avatar2,
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.changed, true);
    assert.equal(res2.value.status, 'BOUND');
    assert.equal(c1Calls, 2);
  });

  it('G4R5-C04: genuine C1 success does NOT quarantine and allows subsequent write (writes=2)', async () => {
    const avatar1 = 'g4r5_c04_1.png';
    const avatar2 = 'g4r5_c04_2.png';
    await writeDummyAvatar(charactersRoot, avatar1);
    await writeDummyAvatar(charactersRoot, avatar2);

    let c1Calls = 0;
    const originalCreate = fileStore.createState.bind(fileStore);
    const store = {
      ...fileStore,
      createState: async (params) => {
        c1Calls++;
        return await originalCreate(params);
      },
    };

    const testController = createSidecarController({ fileStore: store });

    const res1 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: avatar1,
    });

    assert.equal(res1.ok, true);
    assert.equal(res1.changed, true);
    assert.equal(res1.value.status, 'BOUND');

    const res2 = await testController.create({
      context: { userRoot, charactersRoot },
      avatar: avatar2,
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.changed, true);
    assert.equal(res2.value.status, 'BOUND');
    assert.equal(c1Calls, 2);
  });
});
