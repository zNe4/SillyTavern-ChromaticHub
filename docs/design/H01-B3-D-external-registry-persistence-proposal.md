# H01-B3-D — External card-scoped registry persistence (research proposal)

**Status:** PROPOSED, **not accepted ADR**, not implementation authorization.  
**Date:** 2026-10-29. **Research / architecture:** ChatGPT; **implementation later:** Antigravity after a bounded owner-approved mission.  
**Branch:** `research/h01-b3-c-editor-isolation`; do not change ChromaticHub `main`, SillyTavern installation, or H01-B3-B deny-only adapter by virtue of this proposal.

## 1. Why revise the earlier design?

[ADR-001](../decisions/ADR-001-card-scoped-identity.md) and [H01-A identity contract](H01-A-identity-contract-v0.1.md) chose embedded `data.extensions.chromaticHub` as the *canonical* registry because this made cards portable. **H01-B3-C-B1 now falsifies the assumption that an external merge into that namespace survives ordinary native editing.** The direct native test on a disposable character yielded a verified revision-1 registry after a single `/api/characters/merge-attributes` call, while the editor's hidden `json_data` remained stale; the subsequent single native debounced `/api/characters/edit` autosave removed the registry. Offline `ccv3` PNG readback and the independent API JSON hash matched after loss. Full receipts: [B1 acceptance](../acceptance/H01-B3-C-B1-stale-editor-protocol.md).

**Design invariant:** identity remains *card-scoped* even if its **authoritative persistence** moves outside the card. A global index of installed-card locators is NOT a global person database; a local identity ID remains meaningful only with the owning installed-card instance. The change would **supersede only the storage-authority clause** of ADR-001 / H01-A and must be documented in a new reviewed ADR, not silently represented as compatible with their currently accepted authority.

## 2. Platform facts verified (pinned + current documentation)

- Per-user installation data lives in `DATA_ROOT/<user-handle>/` (not necessarily relative to CWD; `data/default-user` only in default single-user installations). Pinned `src/users.js` provides `request.user.directories.root` in authenticated requests. Official administration docs: https://docs.sillytavern.app/administration/.
- An ordinary UI extension runs in the browser, and cannot directly create arbitrary server-side private subfolders. Official UI docs: https://docs.sillytavern.app/for-contributors/writing-extensions/.
- The server-plugin feature provides Node/Express routes at `/api/plugins/<id>/...` but is disabled unless `enableServerPlugins: true` in `config.yaml`. Plugin code is **not sandboxed**; install is an explicit security decision. Official: https://docs.sillytavern.app/for-contributors/server-plugins/.
- The pinned `src/server-main.js` puts user session and CSRF middleware before `loadPlugins`; the plugin must still verify and constrain `request.user`, inputs, privileges and its filesystem root. Avoid importing unstable private SillyTavern server modules when the request's authenticated user directory suffices.
- Native `POST /api/files/upload` stores base64 data in `request.user.directories.files` using `write-file-atomic`. But it is flat uploaded-file storage, has no application-specific compare-and-swap, and user-file cleanup may delete otherwise-unreferenced uploads. This is **not suitable as an authoritative long-lived vault**. Pinned `src/endpoints/files.js`; current cleanup docs: https://docs.sillytavern.app/usage/user-settings/.
- Current official UI extension submission guidance says **extensions requiring a server plugin will not be accepted** to its official content collection. The deployment / distribution drawback is material. https://docs.sillytavern.app/for-contributors/writing-extensions/.
- Native cards are addressed in the frontend by mutable PNG `avatar` filenames; the character array index is ephemeral. No stable installed-card identity has yet been demonstrated that survives every rename, deletion/recreation, duplication, or server-offline edit.

## 3. Candidate comparison

| Candidate | Stale-editor overwrite isolation | Durable multi-tab mutation | Native export portability | Installation & complexity | Assessment |
|---|---|---|---|---|---|
| **A: per-user, per-installed-card private folders + narrow server plugin** | YES, if no automatic mirror back to PNG | Achievable with server-side serialized CAS | Requires explicit bundle/export plan | Plugin enablement and narrow privileged surface | **Preferred research direction** |
| B: plugin-backed SQLite registry + optional asset folders | YES | Strong transactional model | Requires explicit export plan | DB schema/migrations, plugin still required | Strong alternative if multi-file transactions/querying become critical |
| C: single shared JSON file | YES | Contention and careful whole-file CAS required | Requires explicit export plan | Simpler first commit, larger failure domain | Not preferred |
| D: native `/api/files/upload` JSON per avatar | YES in principle | No native CAS; cleanup risk; no straightforward subfolders | Requires explicit export plan | Plugin-free, lower installation barrier | **Do not choose as authoritative by default** |
| E: continue PNG-embedded authority and attempt editor quiescence | NO proven general safety | No native CAS | Native exports work | No plugin | **Rejected under present evidence** |
| F: `extensionSettings` / browser localStorage | Isolated from the specific PNG editor | Shared settings saves / browser-local split across tabs and devices | Not card-exported | No plugin | Appropriate for preferences, not canonical registries |

Plugin-free distribution remains a valuable goal, but the authoritative persistence design must not silently sacrifice correctness just to remove the server-plugin requirement.

## 4. Proposed per-user on-disk layout

Path is a **proposal**, not an existing SillyTavern directory:

```text
DATA_ROOT/<authenticated-user-handle>/
  chromaticHub/
    cards/
      <installed-card-uuid-v4>/
        state.json              # single atomic file: owner binding + registry + revision
        assets/                 # reserved; separate ChromaticImages ownership policy applies
      <another-installed-card-uuid-v4>/
        state.json
    backups/                    # optional future bounded versioned snapshots
```

Do **not** key a permanent directory only by `Narrator.png`: native renames alter the filename; duplicates and deletion/recreation may reuse it. Generate an opaque **installed-card ID** from trusted server randomness, distinct from **each card-local character ID**. For convenience, a UI can display `Narrator.png` from `state.json`; no need to rename the directory. A `Narrator--<uuid>` initial display prefix is possible but increases normalization/privacy surface and remains permanently stale after rename, so UUID-only is the safer default.

**Example illustrative content of one `state.json` (not a frozen schema):**

```json
{
  "storageSchemaVersion": 1,
  "installedCardId": "f996e7c9-3758-4ee8-9bc2-35c349a019a0",
  "binding": {
    "avatar": "Narrator.png",
    "state": "BOUND"
  },
  "registry": {
    "schemaVersion": 1,
    "revision": 1,
    "characters": []
  }
}
```

Keep H01-A `registry` validation and card-local UUID meaning where feasible. Store binding + registry in the **same atomically replaced file** so a crash cannot commit an owner mapping without its corresponding data. Start with no shared mutable `index.json`: scan `cards/*/state.json` to build a *read-only-derived in-memory lookup*, detect duplicates/invalid state and refuse ambiguity. Add a durable index or SQLite only if measured scale demands it. Never use a metadata checksum or a name collision to auto-merge two installed cards.

## 5. Server persistence and correctness contract

1. Browser/UI talks only to a narrow authenticated, same-origin server plugin API; **no arbitrary filesystem paths, recursive delete, shell commands or raw user-handle overrides** are accepted. Resolve storage root from `request.user.directories.root`; confirm resolved descendants, use symlink-resistant file handling, and enforce bounded JSON limits.
2. **Server is the sole authoritative writer.** Mutations are serialized per installedCardId across browser tabs; require `expectedRevision` and a trusted bound owner, then validate and atomically replace a complete `state.json`, followed by durable readback/failure status. Exact write ordering, `fsync` and crash semantics need an independently reviewed implementation protocol. A successful HTTP status alone must not substitute for verifiable durability.
3. On mismatch return **REVISION_CONFLICT** or **OWNER_BINDING_UNVERIFIED**, never last-write-wins. A request's avatar is a *locator*, not an authorization to claim an unrelated UUID; require the authenticated user's binding and verified card existence.
4. Scope initial support to a **single SillyTavern Node server process** coordinating all browser clients. Two independent ST servers sharing the same on-disk data root, external editors of `state.json` and shared-network filesystems require a separate cross-process lock/transaction model; fail closed if detected or unsupported. SQLite can be reconsidered for transactional multi-process use.
5. Atomic write and versioning do not solve arbitrary system crashes, malicious plugins, or user deletion; include explicit backup, corrupt-schema refusal, no silent reset, and recovery UI.
6. Keep records private to the authenticated user, out of served extension source and publicly accessible static directories; constrain API responses, reject invalid JSON/prototype/unknown fields and avoid logging names, descriptions or sensitive aliases.

## 6. Installed-card lifecycle and unresolved owner proof

This is the **hardest remaining problem**, independent of the JSON-vs-SQLite choice. Native ST supplies a mutable filename locator, not a demonstrably permanent per-install primary key. A directory UUID only identifies **Hub's own sidecar record**. By itself it does **not** prove that a current `Narrator.png` is the exact same installed PNG originally bound to it.

| Event | Safe proposed rule |
|---|---|
| Edit or ordinary autosave | Never changes the Hub store or its owner binding; expected edit should not erase registry |
| Rename observed in same runtime | Update stored `binding.avatar` only through an explicitly validated old-to-new transition, atomically with state; uncertain transition -> unresolved |
| Rename while Hub offline, filename reuse, replacement | No name-based guessing; mark unresolved and request explicit user rebind after additional verification |
| Duplicate via native ST | Treat as **new installed owner ID**, never link it to the source automatically. A copied registry requires an **explicit clone/import flow** unless a trustworthy native lifecycle event and exact source were verified |
| Export/import of PNG or JSON | **Not automatically portable** once Hub store is authoritative. Offer an explicit backup/export bundle that includes registry and a new-owner import process. A future snapshot in an *export copy* of the card can assist portability but must not become a second authority |
| Delete or missing card | Keep Hub data in a recoverable orphan state initially; never purge on a missed/ambiguous event or silently attach the orphan to a new same-named PNG |
| Reopen another browser, restart | Re-read authoritative sidecar and verify binding; do not trust browser cache |
| Group chat | Read only from explicitly selected owner(s); no implicit shared group registry |

**Critical unresolved acceptance question:** distinguish a legitimately edited card from a deleted/replaced *same-named* card even when Hub was offline. Modification time, inode, content checksum, `create_date` (seen added during B1), or a cloned embedded UUID is not an intrinsic permanent owner proof. **No unconditional cross-restart automatic rebinding** until a reliable server or user-mediated association contract is proven. A dedicated follow-up research checkpoint must establish what can be guaranteed without patching native ST.

## 7. User experience and portability

- If the server plugin is absent/disabled, **fail closed on mutation** with a clear UI explanation; do not switch to unprotected PNG or settings authority. A deliberate read-only/import-only mode may be designed separately.
- The built-in ST "export card" produces a character card, not a complete ChromaticHub backup. State this in the UI. Design **Export Card + ChromaticHub Data** (and corresponding import) as a separate action or user-approved archive. Export/import IDs preserve local character IDs but **mint a new installed-card ID** at the new destination.
- No automatic image asset copying; ChromaticImages remains the owner of its assets. Any bundle references must be explicit and vetted.
- Include the directory in per-user backups and allow a manifest/inventory listing human-readable card names for recovery. Do not put authoritative data inside a Git-managed extension source checkout (which may be updated or removed).
- Installation needs **two components**: browser extension and privileged server plugin, with explicit user enablement `enableServerPlugins: true`. Official ST directory submission eligibility is a real limitation; decide if that matters before ratifying this architecture.

## 8. Scope and next reviewed steps

**No production code changes authorized.** This proposal does not activate H01-B3-B, restore lost registry, or migrate current cards. The direct test snapshots remain untouched at `/home/zzzne4/ChromaticHub-B1-direct._xlayxdb`.

Before adopting this as a new ADR, decide the product requirements for: **(a)** plugin-dependent installation versus plugin-free distribution; **(b)** user-mediated owner rebind after unsupported lifecycle events; **(c)** whether the registry must travel with ordinary PNG exports or only with an explicit ChromaticHub export.

If owner endorses A, follow with:
1. **D1 source/contract research (ChatGPT):** pin server-plugin request/user/CSRF lifecycle, account isolation, native rename/duplicate/delete events, user backup/cleanup interactions, and exact persistent file safety protocol; separate proven from assumed support.
2. **D2 design/ADR (ChatGPT):** replace embedded authority clauses, freeze `state.json` schema, mapping/binding error states, CAS semantics and export/import policy; preserve H01-A pure identity validators.
3. **D3 bounded synthetic implementation (Antigravity only after approved mission):** pure path/registry state machine and fake filesystem fault-injection tests; no real ST mutation and no privileged plugin activation until separately approved.
4. **D4 owner-native disposable acceptance:** verify old stale-editor reproduction now leaves sidecar untouched, plus rename/duplicate/restart, two tabs, failed atomic writes, corrupt state, missing plugin and backups.

**Research conclusion:** choose per-user, per-installed-card folders as the leading candidate; do not confuse that selection with solving the separate installed-owner binding and export-portability problems.
