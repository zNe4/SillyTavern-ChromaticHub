# ADR-001 — Card-scoped character identity

**Status:** ACCEPTED AS H01 DESIGN DIRECTION — **not** an implemented/frozen API.  
**Decision date:** 2026-10-26/27 (owner-native acceptance session).  
**Decision/research:** Project owner + ChatGPT. **Implementation:** Antigravity only after a bounded, reviewed assignment.  
**Evidence:** [Source research](../research/H00-source-investigation.md) · [H00-C acceptance](../acceptance/H00-C-card-registry-acceptance.md).

## Context

ChromaticDialogue's numbered speaker tags are local to a chat. ChromaticImages needs reusable visual references, including for cards containing multiple fictional people or several people with the same name. ChromaticMessages may later distinguish continuations from unrelated stories. Equating a name, a chat speaker number, an installed card and a person would make these extensions disagree.

An initial H00-A investigation considered a user-global canonical registry. The owner selected a simpler card-first model: reusing a card across chats should reuse its character definitions; changing chats should not reuse dialogue tags or implicitly inherit unrelated message histories.

## Decision

The canonical reusable registry is **embedded inside each installed SillyTavern character card**, using a namespaced entry under **data.extensions**. The tentative production key is **chromaticHub** (not the disposable research probe key).

One card may have zero, one, or many characters. Each has a stable opaque **card-local** ID; names, aliases and labels may collide and are not identity keys.

The effective address of an identity is **(owning installed card, local character ID)**. A bare local ID is insufficient. H01 must define how to identify and re-resolve the installed owner card, notably across rename, removal and group context. The current SillyTavern character-array index is NOT durable; filenames change on rename. Do not assume we already have a solved owner-card identity mechanism.

A duplicated card begins with a copy of the registry and IDs, but subsequent edits affect only its own PNG. Equal local IDs in two different cards do not imply one globally shared person. Export/import likewise copies definitions without automatic cross-card linking.

## Scope boundaries

| Data | Intended owner | Persistence |
| --- | --- | --- |
| Reusable character identities, names, aliases, descriptors | ChromaticHub, card metadata | Across chats of same card; exported with card |
| Ephemeral or story-specific NPCs | ChromaticHub, chat metadata (future H01 design) | Per chat, until explicitly promoted by user |
| ChromaticDialogue cN IDs, colors and bindings | ChromaticDialogue / chat mapping | Per chat |
| Trusted reference images, outfits and generation controls | ChromaticImages | Its own asset store, keyed through explicit card/identity context |
| Phone-message timelines, storyline continuation and branching | ChromaticMessages (future) | Explicit storyline policy, never inferred merely from card |

Do not auto-promote NPCs, auto-generate imagery, auto-merge by name, globally synchronize duplicated cards, or equate separate chats' storylines.

## Preliminary data shape (H01 still chooses exact schema)

~~~json
{
  "schemaVersion": 1,
  "characters": [
    {"id": "card-local-a", "name": "Hina", "aliases": ["Knight Hina"]},
    {"id": "card-local-b", "name": "Hina", "aliases": ["Merchant Hina"]}
  ]
}
~~~

Rules requiring H01 review: immutable unique IDs **within** the owning card; explicit schema version; unrecognized/corrupt versions fail closed (never reset a registry); strict bounded validation; no generation/model-supplied IDs accepted as authoritative; only user-directed promotion from chat metadata.

**This sample is not a shipped schema.** The owner-native tests used the separate key **chromaticHubH00CProbe**, and test items used a descriptor rather than this sample's aliases.

## SillyTavern persistence considerations

1. The native **writeExtensionField** updates the client object and posts to **/api/characters/merge-attributes**. It may log an HTTP failure without rejecting the Promise. The server's merge helper also does not check the boolean returned by the final PNG writer. **Readback / failure reporting must be designed explicitly**; HTTP 200 alone is not a durable guarantee.
2. The merge helper recursively merges objects and **replaces arrays**. Omitting a property from a nested object does not delete it; complete-array replacement can represent deletion of a registry character. Explicit unsetting has a separate native sentinel, which needs guarded handling.
3. With lazy loading enabled, shallow character data omits arbitrary extension fields. A complete card must be loaded before a registry mutation; stale UI editor data could overwrite changes.
4. Cross-tab writers lack server-side compare-and-swap or transactions. Serializing Hub writes in one extension instance does NOT solve cross-tab atomicity. H01 must state the supported concurrency model and fail safely when uncertainty is detected.
5. Group chats do not imply one owner card. Target members must be selected explicitly, and owner context must be checked before and after asynchronous work.
6. PNG and JSON export preserve the registry, potentially including sensitive aliases/notes. Reference-image files stored externally are NOT automatically included. Privacy and asset portability require separate policy.

## Decision evidence

On a disposable Arch Linux / Firefox SillyTavern server at localhost port 18180, the owner reported passing checks for: same-name distinct IDs, server readback, two-chat switching, server restart, rename, duplication, independent edits, PNG and JSON export and import, and add/update/delete with restored fingerprint. Four card registries were then verified again via browser API after a further restart.

See the [exact per-gate evidence, filenames and SHA-256 receipts](../acceptance/H00-C-card-registry-acceptance.md). These are **owner-reported test results independently assessed by ChatGPT**, not a direct ChatGPT reproduction. The final **P4 offline-disk verification output has not been provided**; do not mark that separate gate complete.

## Alternatives

- **Declined for H01:** global master identity registry, identity by name, browser-only canonical storage, shared IDs without card qualifiers, persistence of cN tags on the card.
- **Deferred:** explicit cross-card identity links; group-chat addressing policy; synchronization between independent browser sessions; automatic detection of exported sensitive fields; storyline continuation policy.

## Consequences and next action

**Card-scoped storage feasibility is accepted for H01 design.** This does **not** authorize implementation, release, or integration changes. H01-A must freeze a versioned data/API contract and testable failure behavior before Antigravity receives a coding mission.
