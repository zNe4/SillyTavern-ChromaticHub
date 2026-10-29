# H01-B3-D1 — Native lifecycle and sidecar ownership binding

**Status:** SOURCE-REVIEW COMPLETE / architectural questions still open. No runtime mutation, plugin installation, implementation assignment, or ADR ratification.  
**Date:** 2026-10-29. **Research owner:** ChatGPT. **Pinned source:** SillyTavern commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.  
**Prior evidence:** [H01-B3-C-B1 stale editor experiment](../acceptance/H01-B3-C-B1-stale-editor-protocol.md) and [H01-B3-D storage proposal](../design/H01-B3-D-external-registry-persistence-proposal.md).

## Research question

Can a private, **per-user, per-installed-card directory** carry ChromaticHub's authoritative registry without being erased by native editor saves, and can its ownership binding follow native rename / duplicate / import / delete events correctly across ordinary operation and missed events?

## A. Confirmed native behavior (pinned source)

| Operation | Browser-side event or behavior | Server endpoint and on-disk behavior | What ChromaticHub can rely on |
|---|---|---|---|
| Native character **edit/autosave** | `public/script.js` exports `saveCharacterDebounced = debounce(() => $('#create_button').trigger('click'), DEFAULT_SAVE_EDIT_TIMEOUT)`; character text `input` schedules it; submit sends form `json_data` to `/api/characters/edit`. | `src/endpoints/characters.js` `/edit` reconstructs card with `charaFormatData(request.body,...)` and overwrites the character PNG. | **Sidecar isolation:** native `/edit` does not itself address a dedicated `chromaticHub/` folder. A PNG-embedded registry remains unsafe (B1 reproduced). |
| Native **rename** | `public/script.js` `renameCharacter()` posts `avatar_url` and `new_name`. On success, it `await`s `CHARACTER_RENAMED(oldAvatar,newAvatar)` before calling `getCharacters()`. | `/api/characters/rename` writes a new PNG with updated name at new filename and then unlinks the old PNG, with optional chats folder move. | When the *same active browser* observes the event, it supplies a useful transition hint. **Not a server-wide durable event stream**, nor evidence that all tabs/clients saw it; not an installed-card identity proof by itself. |
| Native **duplicate** | `duplicateCharacter()` posts `avatar_url`, then emits `CHARACTER_DUPLICATED` with `{oldAvatar,newAvatar}` after successful response. | `/api/characters/duplicate` chooses an unused filename and `fs.copyFileSync` copies the existing PNG (including its metadata). | Treat new PNG as a new installed-card owner. Native cloned metadata (including any future embedded marker) is **not** sufficient to treat owners as one. Browser event is useful when observed, but not complete. |
| Native **delete** | `deleteCharacter()` posts `avatar_url`, then emits `CHARACTER_DELETED` with previous `id` and `character` after HTTP success. | `/api/characters/delete` unlinks PNG and optionally removes chat folder. | Sidecar must **not** be deleted on a bare frontend event: missing observation, race or reused filename must not permanently lose data. Keep recoverable orphan/tombstone state. |
| Native **import** | `importCharacter()` posts form-data; there is **no `CHARACTER_IMPORTED` event** in the pinned `public/script.js` / `public/scripts/events.js` analogous to the previous three events. It can set `preserved_name` and report `Character Replaced` when an existing filename is targeted. | `/api/characters/import` dispatches to format-specific import handlers. `preserved_name` can select an existing PNG basename, replacing its bytes. | **Silent same-name replacement is possible** without a reliable matching UI lifecycle event. A filename-to-UUID map alone cannot distinguish a legitimate existing card from a replacement after the fact. |
| Restart / multiple tabs / direct API / filesystem edits | Browser `eventSource` callbacks are per-page and not a durable stream. | Server routes can be called independently of a particular browser-side event listener. | Never infer that observing all relevant UI events is guaranteed. Unobserved lifecycle transitions require explicit reconciliation. |

**Relevant source locations:**

- `public/script.js`: `duplicateCharacter()` around L6034–6081; `renameCharacter()` around L7185–7253; `importCharacter()` around L10530–10593; `deleteCharacter()` around L10828–10910; editor autosave around L470–471, L9750–9930 and L11439–11464.
- `public/scripts/events.js`: `CHARACTER_DELETED`, `CHARACTER_DUPLICATED`, `CHARACTER_RENAMED` constants around L68–71; no `CHARACTER_IMPORTED` counterpart in that file.
- `src/endpoints/characters.js`: `/rename` around L1053–1100; `/edit` L1101–1143; `/delete` L1416–1445; `/import` L1560–1599; `/duplicate` L1601–1644.
- `src/server-main.js`: user middleware, CSRF, required login and subsequent plugin initialization, around L156–164, L168–205, L245–247 and L299–315.
- `src/users.js`: `getUserDirectories(handle)` around L679–695 resolves entries from `globalThis.DATA_ROOT` and user handle.

## B. Confirmed plugin/API boundary

SillyTavern's documented plugin loader registers plugin-created Express routes under `/api/plugins/<id>/...`; `enableServerPlugins: true` is required, default false. Plugins run with host privileges (not sandboxed). They load after the application's cookie/session, user identity, CSRF, and authentication middleware in the pinned server. Application-specific routes must still check request user scope and constrain all names/IDs; do not use user-controlled absolute paths.

- https://docs.sillytavern.app/for-contributors/server-plugins/
- https://docs.sillytavern.app/administration/config-yaml/
- https://docs.sillytavern.app/for-contributors/writing-extensions/

A normal browser extension cannot write arbitrary private server directories itself. The built-in `POST /api/files/upload` is a flat user uploaded-file API, not a server-side, per-card transactional registry store. Moreover, UI extensions that **require** server plugins are currently excluded from the official extension submission collection; self-hosted distribution remains possible but dependency must be documented.

## C. Design consequence: a UUID is not ownership evidence

**Certain:**
- A UUID-named private directory is a sound *local storage key*, independent of filename changes.
- It avoids the specific **PNG editor overwrite** because native character edits do not write this directory.
- The registry can retain card-local character UUID semantics and schema validation under a private per-installed-card sidecar.

**Not established:**
- A current `Narrator.png` is the **same installed card instance** as a previously bound `Narrator.png` after deletion/replacement.
- A rename transition was seen by all consumers, or was seen at all.
- A PNG embedded UUID is trustworthy: duplication copies it, and stale editor saves can drop external metadata.
- File inode/mtime/hash or card `create_date` is stable across native edits, rename rewrites, import replacement or backup restores. They cannot serve as an unconditional owner identity proof.
- A name, text, content fingerprint or copied internal ID should auto-merge two records.

**Research decision:** **Native frontend events alone are not a certifiable complete lifecycle feed.** A sidecar design can support best-effort observed transitions, but must expose a bounded **UNRESOLVED_BINDING** mode that disables automatic mutations until the owner explicitly reconciles ambiguity. Neither a directory UUID nor an avatar filename by itself resolves missed same-filename replacement. Strong guarantees across all external mutations would require a trustworthy host lifecycle interface/patch or a defined narrower supported environment.

## D. Proposed binding strategy for architecture review (not implemented)

1. **Root:** `DATA_ROOT/<authenticated-user-handle>/chromaticHub/cards/<installedCardUuid>/state.json`. No JSON record is stored in served extension assets. Folder names are UUIDs; current avatar filename and optional human label are **attributes**, not keys.
2. **Creation:** when the user first explicitly attaches a card, the plugin checks an exact currently existing avatar and no conflicting owner mapping before creating a *new* installedCardUuid record. Never create a sidecar as a side effect of merely reading a card.
3. **Ordinary edits:** registry mutates only via plugin API with expected revision/CAS and server-side atomic persistence; native editor writes neither the sidecar nor authoritative registry.
4. **Observed rename:** event is a *proposal* to migrate binding; server must independently inspect old/new presence and stored binding, apply a narrowly scoped rename transition atomically, or enter an unresolved state. Because ST may already remove old PNG before frontend event, absence of the old filename alone cannot prove continuity; the trust model for accepting the event is a **remaining design decision**.
5. **Duplicate/import:** never automatically alias source and new installed cards; clones may optionally receive an **explicit user-approved copy** of registry contents under a newly minted installedCardUuid. Import to an existing basename must not silently inherit the prior sidecar without a documented replacement/reconciliation step.
6. **Delete:** keep sidecar as recoverable orphan, subject to a later user-visible cleanup policy. Do not automatically erase contents.
7. **Missed events / restart:** reconstruct mapping cautiously; if there is no evidence sufficient to verify a historic association, mark unresolved. Do not silently auto-rebind by fuzzy name, checksum or pathname.
8. **UI:** show a clear distinction between **BOUND**, **UNRESOLVED**, **ORPHANED**, **CORRUPT** and **CONFLICT**. Writes in unresolved/corrupt/conflict states are refused without changing the disk.
9. **Export:** ordinary PNG export does **not** carry authoritative sidecar. Offer a deliberate portable bundle (registry + explicit card reference) rather than a silently divergent mirror in `data.extensions.chromaticHub`.
10. **Concurrency boundary:** target one Node/SillyTavern server process; serialize mutations across tabs on server. Concurrent external processes operating the same data root and filesystem replacements remain unsupported unless a separately reviewed lock/transaction architecture is adopted.

## E. Checkpoint assessment and next decisions

| Question | Status |
|---|---|
| Can a per-user folder isolate state from **native card autosave**? | **YES for the observed overwrite mechanism** (source + B1); still requires owner-native acceptance after implementation. |
| Do standard browser events cover rename and duplicate? | **Events exist** for those UI flows; no guaranteed cross-tab/server/restart delivery. |
| Can import silently replace an existing filename? | **YES in the pinned source** via preserved name. |
| Is there a permanent native installed-card ID supported by source? | **NOT FOUND** among the researched interfaces. No claim that none can exist in unreviewed APIs. |
| Is a filename-only binding sufficient? | **NO** for indistinguishable same-name replacement. |
| Is server-only revisioned persistence feasible? | **Design candidate YES**, not demonstrated by native execution. |
| Are plugin deployment/portability costs accepted? | Owner endorsed **per-card folder direction**; explicit plugin dependency and export policy remain to be ratified. |
| Does this authorize code or native mutation? | **NO.** Deny-only H01-B3-B remains in place. |

**Next artifact:** proposed replacement ADR for **storage authority**, documenting (i) plugin dependency; (ii) supported lifecycle/ambiguity policy; (iii) export/import contract; (iv) precise server-side file safety and concurrency contract; and (v) migration from the old embedded-registry assumption. Freeze it only after owner review. No Antigravity code mission yet.
