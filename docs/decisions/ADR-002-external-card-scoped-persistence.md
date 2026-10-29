# ADR-002 — External card-scoped persistence

**Status: ACCEPTED — V1 ARCHITECTURAL DIRECTION; detailed schema/API and native activation still gated.**  
**Prepared and accepted:** 2026-10-29. Project owner selected the pragmatic Option A binding policy, accepted the companion server-plugin dependency, and authorized this bounded architectural direction. ChatGPT owns research and documentation.  
**Implementation:** Antigravity only under later, bounded, reviewed assignments.  
**Pinned SillyTavern source:** [06bde939fb1e9c4c8d8641d810f0a916b5bce127](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127).  
**Basis:** [ADR-001](ADR-001-card-scoped-identity.md), [H01-A contract](../design/H01-A-identity-contract-v0.1.md), [B1 acceptance](../acceptance/H01-B3-C-B1-stale-editor-protocol.md), [D1 native lifecycle research](../research/H01-B3-D1-native-lifecycle-binding.md), [external-storage proposal](../design/H01-B3-D-external-registry-persistence-proposal.md).

## Decision summary

ChromaticHub retains a **card-scoped identity model** and changes its **authoritative installed-card identity registry** from the PNG's `data.extensions.chromaticHub` namespace to a **private per-SillyTavern-user directory**, with one subfolder per **installed card instance**. A small, separately installed and explicitly enabled **SillyTavern server plugin** would own persistence and expose a narrow authenticated API to the browser extension.

**Owner-approved V1 policies:** private per-card folders, the companion server plugin, and **Option A** (reuse a unique recorded PNG filename after ordinary restarts, without per-restart identity confirmation). Unobserved same-name replacement is explicitly outside the V1 detection guarantee. To minimize first-release scope, the bundled export/import workflow is **deferred**, with explicit UI warnings that ordinary PNG export excludes Hub data; current H01-A `registry.revision` semantics are retained alongside a separate record-wide CAS generation. The exact JSON schema and endpoints remain **unfrozen implementation-design work**, and native plugin activation or production code is not authorized by this acceptance.

This decision **supersedes ADR-001's storage authority and H01-A's embedded-storage adapter assumptions** for future implementation, but *does not* supersede their card-scoped IDs, validation boundaries, chat-local NPC separation, cross-extension ownership, or ban on identity inference from names. ADR-001 remains a historical decision. No two concurrent authorities may be enabled; the older PNG mutation path remains deny-only.

## 1. Evidence and problem

In B1, one `POST /api/characters/merge-attributes` materialized a valid `{schemaVersion:1, revision:1, characters:[]}` at `data.extensions.chromaticHub` in a disposable card. The PNG and an independent `/api/characters/get` response both confirmed persistence, while the open native editor retained its original `#character_json_data` without the registry. One ordinary description edit triggered native debounced `POST /api/characters/edit`; afterward both the PNG and API lacked the registry. The final hashes matched, establishing `REGISTRY_LOST`.

Therefore neither a successful merge response nor browser-local serialization establishes a safe writable window while SillyTavern's own editor can save stale metadata. No reliable instrumentation-free editor quiescence certificate has been found. **H01-B3-B's runtime safety adapter MUST remain unconditionally deny-only** (`safe:false`, `EDITOR_SAFETY_NOT_CERTIFIABLE`); this ADR does not enable the older PNG mutation controller.

## 2. Scope, identity, and authority

- **Authoritative storage:** one private `state.json` for each installed-card record, under the authenticated SillyTavern user's data root. The server plugin is the only writer.
- **Installed owner ID:** trusted random UUID v4 assigned at explicit initial attachment to the *installed card instance*, distinct from the card's PNG filename and the local identity IDs. This is a storage key, **not proof of physical PNG continuity**.
- **Character identity:** existing H01-A card-local UUID v4 rules, bounded record validation, and identity operations remain applicable, scoped by `(authenticated user, installedCardId, identityId)`. Names and aliases never serve as identity keys.
- **No global people registry:** enumerating a user's installed-card records is an index of *owners*, not cross-card identity merging.
- **Separate domains:** ChromaticDialogue retains chat-scoped `cN`; ChromaticImages owns image assets and generation permissions; ChromaticMessages owns message/storyline persistence. A reserved subdirectory here does not automatically transfer asset ownership.
- **Legacy embedded PNG data:** not an authoritative fallback, cache or implicit mirror. Browser reads MUST NOT silently hydrate from `data.extensions.chromaticHub` if the plugin is unavailable or the sidecar is unresolved.
- **No changes to SillyTavern core** are authorized by this ADR. A native host patch or lifecycle hooks, if eventually needed for stronger guarantees, would be a separate decision.

## 3. Proposed filesystem layout

Root is derived **only from the authenticated request** (`request.user.directories.root`), not an untrusted client-supplied username or arbitrary path:

```text
DATA_ROOT/<user-handle>/
  chromaticHub/
    cards/
      <installedCardId-uuid-v4>/
        state.json
      <another-installedCardId>/
        state.json
    backups/          # future bounded, non-authoritative recoverability
```

The directory is **not** named `Narrator.png`: PNG filenames can change, and duplicates or deleted/replaced cards can reuse a name. A user-facing UI may display the current filename from state. Do not write authority into `public/scripts/extensions`, `user/files`, extension settings, or the PNG itself. No shared mutable `index.json` for the initial design; build a validated in-memory locator index from per-card state files, rejecting collisions or unsupported formats instead of guessing.

**Illustrative record (shape not yet frozen):**

```json
{
  "storageSchemaVersion": 1,
  "installedCardId": "f996e7c9-3758-4ee8-9bc2-35c349a019a0",
  "stateRevision": 1,
  "binding": {
    "avatar": "Narrator.png",
    "status": "BOUND"
  },
  "registry": {
    "schemaVersion": 1,
    "revision": 1,
    "characters": []
  }
}
```

**V1 revision policy (accepted; exact mechanics to be frozen in the API spec):** `stateRevision` is the server's **compare-and-swap generation for the entire binding + registry record** and increments on any accepted record transition; `registry.revision` keeps the H01-A identity-only revision semantics and increments only on registry changes. Pure reads never create a sidecar; an explicit user-initiated create/edit may first attach an existing exact card. The attach transaction and initialization details must be fixed before implementation. The JSON above depicts a *materialized* registry, not the default after a read.

## 4. Authenticated plugin API and transaction contract (architecture accepted; endpoint names provisional)

The browser extension calls a narrow same-origin API under `/api/plugins/<plugin-id>/...`. Plugin loader middleware in the pinned ST source runs after session/user/CSRF and required-login handling, but every handler must independently enforce user scope, strict JSON shape/size, valid UUID and avatar basenames, and authorized operations.

Proposed capabilities (not final routes):

| Operation | Required input | Outcome |
|---|---|---|
| **resolve/read** | installedCardId or exact current avatar hint, authenticated user | Validated state and binding status, or explicit error; *never creates files* |
| **attach** | explicit owner action, exact current avatar, expected absence | New isolated owner UUID and initialized sidecar only after duplicate-binding and card-existence checks |
| **mutate registry** | installedCardId, validated mutation, expected `stateRevision`, expected binding | Server-serialized, atomic state replacement + verified readback; conflicting revision refused |
| **propose rename** | old/new exact avatars, installedCardId, expected revision, supported evidence | Rebind only if the native transition can be validated under an explicit trust contract; otherwise `UNRESOLVED` |
| **orphan/reconcile** | explicit user confirmation, binding evidence, expected revision | No silent mapping to another card; records preserved |
| **export/import bundle — deferred** | explicit user action, future versioned bounded payload | Future portable workflow; no bundled export/import in the first writable V1 milestone |

**Protocol obligations:**

1. **Single writer per user/owner** across browser tabs in the same Node process. Validate expected full-state revision *inside the serialized critical section*, not only before it. Use explicit `REVISION_CONFLICT` rather than last-write-wins.
2. **Atomically replace the complete record**, not several independently written authoritative files. Write a new file in the same directory, validate/flush its contents, rename to `state.json`, and verify success/readback. Crash-durability, directory fsync, backup and cleanup requirements need a separate explicit implementation protocol and fault-injection tests.
3. **No out-of-band retry** after an uncertain write. If a failure follows potential commit, return `WRITE_UNCERTAIN`; read back and reconcile before permitting further mutation. Reject corrupt/unknown schemas rather than resetting them.
4. **Filesystem safety:** make symlink/traversal, file-mode, hard-link, TOCTOU, bounded-size, new directory creation, and partial-write handling mandatory review topics. Do not mistake `path.join` or `startsWith` for complete containment. Never accept arbitrary paths or execute commands.
5. **Scope:** v1 only supports one SillyTavern Node server process owning the data root. Multiple Node processes or externally synchronized shared roots are unsupported until separately designed. A per-process queue is NOT a cross-process transaction.
6. **Logging/privacy:** do not log raw registry descriptors/aliases or exported sensitive data. No readable files under publicly served static paths; authenticated sessions remain segregated.
7. **No plugin fallback:** if the plugin is absent, disabled, version-incompatible or unreachable, the UI reports an explicit **UNAVAILABLE / READ_ONLY** posture and refuses authoritative mutations. It must not silently fall back to writing the PNG.

## 5. Installed-card binding state machine (V1 pragmatic policy)

The key limitation is not folder storage but **reliable association with the original installed PNG**. In the pinned ST version, browser events exist for rename, duplicate and delete, but there is no durable cross-tab/server event log; an import may replace the exact same PNG filename. A stable folder UUID, same avatar, image hash, inode, timestamp, card `create_date`, or cloned embedded UUID **alone cannot conclusively prove continuity** across all native/external operations.

| State | Meaning and permitted operations |
|---|---|
| `BOUND` | Exactly one state record names an existing exact PNG filename under the authenticated user and no detected conflict is present. Across ordinary restarts, the matching recorded avatar is enough to resume without prompting. Versioned registry reads/mutations can proceed, but this is **not proof against invisible same-name replacement**. |
| `UNRESOLVED` | Observed conflicting/missed transition, known replacement suspicion, or explicitly inconsistent binding. Reads may expose recovery diagnostics; **registry mutation and automatic owner rebind refused**. Lack of continuous event observation **alone** is not a reason to block an otherwise unique matching avatar after restart. |
| `ORPHANED` | Original card is absent or explicitly deleted; preserve data for user-driven recovery, not automatic deletion. |
| `CONFLICT` | Two records claim the same current avatar or an ownership resolution is ambiguous; refuse automatic writes to both. |
| `CORRUPT` | Invalid/unsupported JSON or filesystem state; **logical read outcome**, do not overwrite as an empty record. |

**Native event policy:**

- **Edit/autosave:** never write Hub authority; remain bound only while supported owner checks succeed.
- **Rename:** accept the observed browser `CHARACTER_RENAMED(oldAvatar,newAvatar)` transition as a V1 trusted workflow hint if the existing old binding matches, the old PNG has disappeared, the new exact PNG exists, and no other record claims the destination. Update binding by server-serialized CAS, otherwise mark unresolved. The event is not a durable cross-tab feed; missed offline renames may require user recovery.
- **Duplicate:** a new PNG is a **new owner instance**; copying its registry is a separate explicitly approved operation, not sharing the source UUID. Cloned PNG metadata is not unique ownership evidence.
- **Delete:** retain sidecar as `ORPHANED`; never purge on a bare UI event.
- **Import/replacement:** detect and quarantine any **observed** collision/replacement. If an external same-name replacement is wholly unobserved and produces no detectable conflict, V1 may reuse the recorded binding. This is a known, owner-accepted limitation of Option A, not a claim that replacement never happens.
- **Restart/offline edits:** load all sidecar records, validate exact file existence and unique avatar ownership, and automatically reconnect a unique match. Missing entries become orphaned/unresolved; duplicate claims or malformed records fail closed. **Unobserved same-filename replacement remains indistinguishable** with present host APIs and is within the accepted V1 trust assumption.

### V1 binding decision — Option A accepted

**Normal behavior:** store the last known `avatar` name in `state.json`; if a later server restart finds exactly one valid state record claiming that filename and the character PNG exists for the same authenticated user, continue in `BOUND` without requesting repeated owner confirmation. This is intentionally simpler than universal file-continuity verification.

**Stop conditions:** two records claim one avatar; path is invalid; bound PNG is absent; recorded rename conflicts with another binding; detected replacement/corruption; unrecognized storage schema; or failed record CAS. Preserve all data and require explicit owner reconciliation. **Do not** automatically attach a new PNG to an orphan using similar names, same character text, copied UUIDs, or hashes.

**Supported deployment assumptions:** one SillyTavern Node server process owns the writable user-data root; cards are ordinarily edited through SillyTavern; users do not intentionally delete and silently replace a card with a different one under the exact old filename outside ChromaticHub's awareness. If those assumptions are violated without an observable signal, the current API cannot guarantee correct binding, and V1 does not claim to detect it. A later native lifecycle integration may strengthen the guarantee if needed, but is not required for the first release.

**Usability priority:** avoid background filesystem watchers, always-on polling, and re-confirmation on routine restarts. Keep explicit recovery for anomalies that are *actually observed*.

## 6. Export/import and migration

**Native PNG/JSON export will no longer automatically export authoritative Hub data.** A deliberate **Export Card + ChromaticHub Data** bundle (and corresponding import) is a **later milestone**, not required before the first single-installation writable release. The V1 UI must plainly warn that standard card exports **do not** include Hub identities and provide a documented per-user data backup procedure; do not imply portability or silently embed a second authoritative registry in exported card metadata. A future bundle importer must mint a distinct installedCardId while preserving card-local identity IDs; never overwrite an existing owner's sidecar or link independent cards merely because registries match.

Existing cards with `data.extensions.chromaticHub` may carry legacy metadata. **No automatic migration.** An explicit import/migration path must:

1. Identify exactly one card; independently read and validate legacy metadata (and check for conflicting sidecar state).
2. Warn that embedded data may already be stale; never treat a missing legacy key as permission to erase sidecar.
3. Obtain user approval, create a versioned sidecar snapshot and perform server-side verified storage.
4. Preserve the original card and backup; do not automatically remove or re-merge the PNG key. Future legacy cleanup requires its own safety review.

This means the earlier H01-A on-card-only adapter, controller and synthetic tests must be **reclassified as legacy/synthetic PNG-route implementation**, not simply activated for this sidecar. Reuse pure registry parsing/validation/planMutation with a separately reviewed plugin adapter. The current deny-only editor adapter remains deny-only.

## 7. Options rejected or deferred

- **Rejected as authority:** embedded PNG registry + presumed editor quiescence (B1); `extensionSettings` or browser localStorage; user-files upload endpoint; filename-keyed folders; one globally merged identity database; automatic name/fingerprint based identity recovery.
- **Deferred:** SQLite if query complexity or multi-process transactions justify it; shared mutable locator index; cross-card linked identities; storage of trusted ChromaticImages assets; automatic PNG mirrors; background cleanup of orphaned records; support for cross-host shared filesystem.
- **Deployment:** official SillyTavern UI-extension collection currently excludes plugin-required submissions, a known cost the owner has indicated willingness to accept.

## 8. Acceptance gates before any native deployment

1. **G0 architecture review: ACCEPTED.** Owner approved the companion plugin, private per-card authority, pragmatic Option A binding and a simple first-release scope. Export/import bundles are deferred, with mandatory clear portability warning.
2. **G1 design:** freeze state schema/limits/error codes, attach/reconcile model and failure semantics; no invisible fallback.
3. **G2 synthetic implementation:** pure state machine; path validation; per-owner serialized CAS; replace/failure tests; concurrency and malicious-input tests; no native PNG mutation.
4. **G3 plugin integration tests:** actual authenticated user-root, CSRF, multi-user isolation, symlink/traversal denial, two-tab conflict, crash/fault scenarios; deny-only legacy route remains untouched.
5. **G4 owner-native disposable acceptance:** preserve control snapshots; reproduce ordinary native autosave while the sidecar remains unchanged; test restart, rename, duplicate, observed import replacement, delete/orphan, lost bindings, malformed state, and confirm first-release backup/portability warnings. Portable bundle export/re-import receives its own later acceptance gate.
6. **G5 independent review + release:** separate owner signoff for enabling production persistence and migration; update docs and reconcile older H01-A/ADR-001 wording **after** ratification, not before.

## 9. Immediate disposition

**Architectural direction accepted; implementation NOT authorized.** Do not install or enable server plugins, create directories in the owner's SillyTavern installation, modify the B1 disposable card, authorize Antigravity implementation, or merge into `main` on the basis of this ADR alone. Preserve the three B1 PNG snapshots and their SHA-256 receipts.

**Next:** ChatGPT freezes the bounded V1 state/API contract, record-generation mechanics, fault and conflict handling, and first-release backup/portability disclosure. Only then prepare a separate Antigravity G0/G1 plan-only mission with a pinned branch and exact scope. Production plugin activation, migration and distribution remain separately gated.
