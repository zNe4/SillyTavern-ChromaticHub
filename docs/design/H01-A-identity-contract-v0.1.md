# H01-A — ChromaticHub identity and persistence contract, v0.1

**Status:** PROPOSED / INDEPENDENT REVIEW REQUIRED. **Not a production API, not implementation authorization.**  
**Owner of design and research:** ChatGPT, subject to project-owner decision. **Implementation later:** Antigravity in bounded tasks.  
**Primary evidence:** [H00 ADR-001](../decisions/ADR-001-card-scoped-identity.md), [H00 source investigation](../research/H00-source-investigation.md), [H00-C owner-native acceptance](../acceptance/H00-C-card-registry-acceptance.md).  
**Pinned SillyTavern source:** [06bde939fb1e9c4c8d8641d810f0a916b5bce127](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127).

## 0. Design stance and scope

ChromaticHub shall provide **explicitly scoped identity**, not global character knowledge, automated identity inference or image generation. Character cards may own multiple distinct fictional people, even with identical names. Persistent identities survive switching chats made with that installed card.

The v0.1 **design** covers: schema; identity-reference semantics; read, validation and mutation behavior; lifecycle handling and intended chat-local data; observable error states; and test contracts. The **first bounded implementation** should cover pure schema utilities and then a **single-card adapter**. Chat writes, automatic promotion, group mutations, durable cross-extension references and cross-tab safety are **not authorized** just because they appear here as planned interfaces.

**Non-goals:** replacing ChromaticDialogue cN; model-generated identity authoritative decisions; a shared user-global registry; global deduplication of copied cards; automatic transfer of reference-image files; rewriting SillyTavern core; changing ChromaticImages or ChromaticMessages in H01; storyline equivalence based on card.

## 1. Authoritative stores and scoping

| Scope | Authority | Permitted identifiers |
| --- | --- | --- |
| Installed-card characters | PNG/JSON character card: **data.extensions.chromaticHub** | opaque card-local character UUIDs |
| Active installed-card locator | actual SillyTavern card, presently addressed by **avatar filename** | avatar is a mutable locator, NOT permanent ID |
| Chat-local provisional NPCs | future **chat_metadata.chromaticHub** namespace | chat-local UUIDs, not card IDs |
| Chat speaker codes and colors | ChromaticDialogue | cN, not globally stable |
| Image refs, outfit refs and generation permission | ChromaticImages | explicit card/identity association; external asset store |
| Messaging history, alternate universes, continuations | ChromaticMessages | independently declared chat/storyline identity |

Never infer identity from a display name, descriptor, message text, or cN. Never silently choose between two matching names.

**No canonical global registry.** An optional future **installation locator index** would be a technical aid for references, not a global person/identity database; it is *not part of v0.1*.

## 2. Proposed on-card schema, version 1

The entire following value is stored as **data.extensions.chromaticHub**:

~~~json
{
  "schemaVersion": 1,
  "revision": 1,
  "characters": [
    {
      "id": "4d15ae22-565c-4d19-9e6c-6d7653940cfa",
      "name": "Hina",
      "descriptor": "Knight",
      "aliases": []
    },
    {
      "id": "64be5fd4-6900-4ed7-9844-2692c684c984",
      "name": "Hina",
      "descriptor": "Merchant",
      "aliases": []
    }
  ]
}
~~~

- **schemaVersion**: exact integer **1**. Future/unknown versions are readable only as unsupported, never coerced or overwritten. No implied migration from the H00-C field **chromaticHubH00CProbe**.
- **revision**: nonnegative safe integer, increased by 1 on each accepted write. **Diagnostic only; this is NOT compare-and-swap.** Clones and imports may have identical revisions.
- **characters**: ordered array (UI order only; reorder does not change identity), at most **128** entries, no duplicate IDs.
- **id**: lowercase canonical RFC 4122 UUID v4, generated locally by trusted Hub code via secure cryptographic randomness. Immutable for a record's lifetime on that card. Imported/duplicated cards legitimately retain the IDs. No model-supplied, hash-derived, or name-derived IDs.
- **name**: trimmed nonempty display string (UTF-8 length limit **1–160 bytes**, not UTF-16 units). Not unique; uniqueness is not inferred.
- **descriptor**: trimmed optional contextual disambiguation, represented as a string (**0–512 UTF-8 bytes**). Can be empty, never used as a key.
- **aliases**: ordered array of at most **16** nonempty trimmed strings, each **1–160 UTF-8 bytes**. Alias collisions allowed. Duplicate aliases on the same record should be normalized/rejected by a tested policy.
- **total serialized registry**: at most **256 KiB UTF-8**; no external URLs, credentials, binaries, reference images, HTML, or model prompt records.
- **shape**: only the documented enumerable own fields in objects; no unknown keys in a v1 value accepted for mutation. Do not strip fields while rewriting. Reads may report unsupported shapes without modifying them.
- **no raw text injection**: all names/aliases/descriptors are treated as **untrusted plain text** for rendering and consumer prompts. Never insert into HTML through unsanitized innerHTML.

**Empty card:** absence of data.extensions.chromaticHub means **UNINITIALIZED** and a virtual empty registry for display only. Pure reads MUST NOT create or rewrite a registry. The first explicit successful user mutation materializes it with revision 1. An existing explicit empty registry remains valid.

**Value choices still reviewable:** 128 entries, string limits, max registry bytes, strict unknown-field policy and revision field. These are conservative *proposals*, not constraints claimed to have been native-tested.

## 3. Identifier and reference contract

**Character ID alone is never enough.** The proposed v1 *operational* reference is:

~~~json
{
  "scope": "card",
  "owner": {
    "kind": "installed-card",
    "avatar": "Narrator_1.png"
  },
  "identityId": "4d15ae22-565c-4d19-9e6c-6d7653940cfa"
}
~~~

The **avatar is a current installed-card locator**, not a permanent database primary key. Consequently this is a **resolvable reference only while the locator remains current**, *not* a promise of perpetual replay across renames.

- The H01 single-card adapter resolves **exact avatar file**, never display name or fuzzy match; its full-card response must echo the expected avatar. Request scopes also bind the active SillyTavern account/session implicitly; do not cross accounts by filename.
- **SillyTavern array index / ctx.characterId is not persistent**, and no index may be cached across reload/getCharacters.
- A runtime operation captures **(avatar, expected chat/group context, expected source registry revision/hash)** and checks the target again before a write. A mismatch invalidates the operation.
- [CHARACTER_RENAMED event](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L7239-L7253) carries **oldAvatar, newAvatar**; Hub may remap only its in-memory resolved handles, after checking the new card actually exists and retains the expected person UUID. A missed rename across restarts cannot be guessed.
- Duplicate and import always create a **separate installed owner**, even with identical local IDs and registry fingerprints. Never use the copied registry checksum, source URL or UUID to infer same installed owner.
- Deleted/replaced/missing owner returns **CARD_NOT_FOUND / STALE_CARD_LOCATOR**; do not search by name and silently rebind. A user-driven **rebind** procedure is deferred to a reviewed integration mission.
- Storing cross-extension long-lived references using avatar alone is **out of scope** until a durable installed-card locator strategy is reviewed. For v0.1, callers should resolve the current card explicitly at use time. No background repair/index mutation.

### Lifecycle table

| Event | v0.1 rule |
| --- | --- |
| Switch chat on same card | Same card registry; no cN persistence or automatic storyline reuse |
| Browser/server restart | Read from disk card again, validate; don't trust caches |
| Rename | Current handles invalidated/remapped only with observed old→new event plus verified target |
| Duplicate | New installed owner; copied UUIDs; revisions start copied, not linked |
| Export/import | Preserved card metadata; new installed owner; do not rewrite copied UUIDs automatically |
| Delete | Unresolvable installed card; no recreation, orphan reference recovery deferred |
| Group chat | **Read-only** per explicitly selected member initially; group is not itself a canonical owning card; mutation deferred |
| Lazy-load/shallow card | Fetch full card **/api/characters/get**; never interpret missing extension key from a shallow list as empty |

## 4. Proposed API surface (signatures illustrative)

Pure functions (no network/DOM/data modification):
- **parseRegistry(raw)** → structured **VALID / UNINITIALIZED / INVALID_SCHEMA / UNSUPPORTED_VERSION**, with validated immutable snapshot. Never default a corrupt object to empty.
- **validateRegistry(registry)** → explicit issues with field paths; no truncation.
- **resolveIdentity(registry, identityId)** → exact UUID match or **IDENTITY_NOT_FOUND**.
- **searchIdentities(registry, query)** → ranked *suggestions*, possibly **AMBIGUOUS**; never return a silent canonical binding based on name.
- **planMutation(registry, command)** → validated cloned next value; supported commands **add, update, remove**. Generates UUID only for explicit create. No generic arbitrary property patch from a model.
- **serializeRegistry(registry)** → canonical document for testing and size checks; no persistent digest as an identity key.

SillyTavern adapter (network; initial support: one explicitly selected individual card):
- **readCard(owner)** → **Result<ValidatedSnapshot>** after full /get, with avatar and expected context.
- **mutateCard(owner, command, expectedSnapshot)** → **Result<VerifiedSnapshot>** after guarded read, validation, write, independent readback; no optimistic success.
- **watchContext()** → invalidation for CHAT_CHANGED, CHARACTER_RENAMED, CHARACTER_DELETED, CHARACTER_DUPLICATED and user-selection changes; events complement but cannot replace pre-write live checks.
- Future separate adapters: **readChatLocal/chatMutation**, **promoteToCard**, **rebindOwner**, **readGroupMember** (read-only first).

Use discriminated Result values, never silent console-only failure:

~~~ts
type HubResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: HubErrorCode; message: string; recoverable: boolean; details?: unknown };
~~~

The public contract MUST identify errors at least for:
**CARD_NOT_FOUND, STALE_CARD_LOCATOR, UNSUPPORTED_CONTEXT, UNINITIALIZED, INVALID_SCHEMA, UNSUPPORTED_VERSION, INVALID_COMMAND, IDENTITY_NOT_FOUND, AMBIGUOUS_IDENTITY, READ_FAILED, CONFLICT_DETECTED, WRITE_REJECTED, WRITE_UNCERTAIN, READBACK_MISMATCH, OPERATION_CANCELLED**.

Do not surface card contents, alias lists, credentials or raw prompt text in routine diagnostic logging. Don't use a single catch-all error status.

## 5. Explicit read/write protocol and limitations

### Read

1. Snapshot active owner and group/chat context, or receive explicitly selected avatar.
2. Resolve exact avatar from current character inventory; use full **/api/characters/get** (not shallow **/all** data). Verify target avatar after read.
3. Parse registry: absent = UNINITIALIZED; malformed or newer schema = **read-only diagnostic**, with no automatic reset.
4. Deep-clone plain JSON data into the Hub domain layer; never retain a mutable pointer into ctx.characters.

### Write (single-card only, best-effort conflict avoidance)

1. Require explicit user/direct authorized action, selected target, supported card context, clean editor state (or abort if dirty state cannot be determined), and a valid previously read snapshot.
2. Serialize Hub mutations **per installed avatar within the current JS instance**. Serializing the Hub queue is **not** a general server lock.
3. Re-read complete card and compare the registry exactly to the caller's expected snapshot (revision plus canonical representation/hash). Unexpected change = **CONFLICT_DETECTED**, **no write**.
4. Build a full validated replacement for **data.extensions.chromaticHub**; bump revision (bounded; overflow rejects).
5. Immediately before POST, re-check owner, chat/group context, existence and cancellation. POST only that namespaced field through **/api/characters/merge-attributes** with headers from getRequestHeaders; **do not use writeExtensionField as success signal**, since it mutates in-memory state before checking the server and merely logs non-2xx.
6. Verify the actual POST status. **Regardless of response**, if a request may have reached the server, independently reread the complete card to classify whether a change persisted. If unable to determine, return **WRITE_UNCERTAIN**, not false success or automatic retry.
7. A successful mutation requires an independent server readback **exactly equal** to the proposed registry, plus unchanged owner binding. Otherwise return **READBACK_MISMATCH / CONFLICT_DETECTED**; report persisted state as uncertain where appropriate.
8. Reconcile SillyTavern in-memory character / editor **only through a proven safe path**, without trampling unsaved editor content. Until verified, require UI refresh or a controlled safe reload; **don't patch json_data silently**.
9. Do not write another character's fields, generate images, edit chat metadata or mutate the selected card because of a changed chat.

**Structural deletion:** under the pinned SillyTavern deepMerge, a **characters array is replaced in full**, so removal of one array member persists; removing an object key by omission does not. If the entire namespace must be deleted, use the native UNSET_VALUE sentinel only under separately tested behavior; routine deletion of one person must not delete the registry.

**Concurrency limitation (critical):** no atomic conditional update/CAS exists on this route. The check before POST, revision and post-write readback **cannot guarantee isolation from other tabs, editor saves or external API writers**. A concurrent writer can overwrite between any two checks or just after readback. H01 v1 will be documented as a **single-writer cooperative mode**, not as generally transaction-safe. If overlapping writers are known or suspected, abort with conflict/uncertain result. Do not claim reliable multi-tab protection without additional server support and tests.

## 6. Chat-local NPC / promotion design boundary

The intended future namespace is **chat_metadata.chromaticHub**, NOT card data. Proposal:

~~~json
{
  "schemaVersion": 1,
  "localCharacters": [
    {
      "id": "ed6cb62a-58e2-4ea2-b317-1c73fed05863",
      "name": "Guard",
      "descriptor": "Gate guard",
      "aliases": []
    }
  ],
  "promotions": []
}
~~~

- **Chat UUIDs** are scoped by explicit chat identity and owner/group context; do not equate them to card UUIDs. Two independent chats may have the same name and different people.
- Hub does **not automatically detect and save NPCs** from model output. An LLM may suggest an NPC but persistence/promotion requires a user action.
- The user must select the exact source NPC and **destination installed card**, review its attributes, and confirm promotion. Promotion creates a **new destination card-local UUID**, never blindly reuses the chat-local UUID.
- Promotion is **not atomic across chat metadata and a card PNG**. Successful card write followed by failed chat link save is a **partial operation requiring visible recovery**, never silent rollback or retry-created duplicate.
- Per-chat cN→Hub mapping is an **adapter concern for ChromaticDialogue**, with no assertion that its current on-disk representation matches this proposal. Do not rewrite cN logic in H01.
- Do not confuse **chatId alone** with a globally unique chat reference: an owner/group and chat-file context are required.

**Important pinned-source finding:** [saveMetadataDebounced](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js#L65-L92) guards groupId and characterId before delayed save, **not chatId**; [updateChatMetadata](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L8975-L8980) replaces the metadata object; [saveMetadata → saveChatConditional](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L9408-L9439) may swallow errors. Thus **chat-local writes, metadata save-success reporting and readback require a separate H01-C source/native test**. This section is a *proposal only*, not authorization to implement chat writes now.

## 7. Compatibility, privacy and authority

- Source pinned to SillyTavern 06bde93; before implementation rerun API guards against the actual intended runtime version, including Arch staging/Termux variation.
- Card exports embed the Hub registry inside JSON and PNG chara/ccv3; this is an **information disclosure surface**. Names/aliases/descriptors must be user-editable and visibly indicated as portable. No secret keys, contact info, private conversation snippets, prompt logs, image references/base64 or personally sensitive automated annotations by default.
- User owns promotion, merging, deletion and changing identity labels. Models may propose text but cannot call persistence APIs on their own.
- UI must show disambiguators when names collide; never show only a name in a destructive confirmation dialog.
- Third-party extension interoperability is by a **versioned read-only event/API adapter** in a later mission, not direct mutation of the internal JSON by consumers.
- No outside-chats autonomous operation. No background scans or API writes triggered by loading a card.

## 8. Frozen for design review vs unresolved questions

**Proposed decisions for H01 owner signoff:** exact on-card schema/limits; per-installed-avatar operational reference with fail-closed stale handling; single-writer/no-CAS policy; strict validation; readback-required success; chat-local separation, explicit promotion only; group mutations deferred.

**Blockers before any H01 card-write implementation:**
1. Confirm intended writer behavior with an open/dirty SillyTavern character editor; either prove safe synchronization or explicitly disable mutation while editing.
2. Confirm error handling for POST 200 yet PNG writer failure and network uncertainty through bounded synthetic tests; do not imply detection of all failures by readback.
3. Confirm rename event payload, full-card getter and current runtime compatibility.
4. Define how consumers recover from a missed rename: until an approved locator-index/rebind design, fail closed.
5. Confirm single-writer conditions and document unavoidable concurrent-writer races.

**Separate research before chat writes:** precise chat metadata persistence and readback, chat-switch races, group chat save path, clone/import semantics, and failure injection.

This document intentionally avoids overpromising **stable installed-card IDs, cross-tab transactions or completed promotion**.
