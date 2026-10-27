# H01-A — Test contract, review questions and proposed bounded missions

**Status:** PROPOSED (review-gate document only). Follows [identity contract v0.1](H01-A-identity-contract-v0.1.md) and [H00-C evidence](../acceptance/H00-C-card-registry-acceptance.md).  
**No implementation authorization.** H01 tasks below are potential future assignments, not active work for Antigravity.

## 1. Critical adversarial review

| ID | Scenario | Safe required outcome | Status |
| --- | --- | --- | --- |
| A01 | Empty card lacks extension field | Read returns UNINITIALIZED without writing a default registry | Proposed |
| A02 | Two Hina records with same name, different IDs | Both retained; lookup by name marked ambiguous; exact ID deterministic | Proposed |
| A03 | Duplicate/import same UUIDs across two cards | Separate owner addresses; no global matching/synchronization | H00 empirically demonstrated, adapter still unimplemented |
| A04 | Import unknown schemaVersion or malformed UTF-8-limit record | No silent reset, no write; diagnostic | Proposed |
| A05 | Unknown v1 object properties | Do not drop them silently; refuse mutation until explicit migration/policy | Proposed |
| A06 | Delete identity from characters array | Entire array replaced, only selected entry gone, rest preserved | H00 mutation PASS for simpler probe shape |
| A07 | Fault or non-2xx after request | Independent readback and WRITE_UNCERTAIN if ambiguous; never optimistic success | Proposed |
| A08 | Server reports success but PNG not persisted | Readback mismatch; no success notification | Proposed; failure injection required |
| A09 | Browser local in-memory json_data stale or editor dirty | Abort or safe proven reconciliation; never overwrite unrelated editor content | OPEN BLOCKER |
| A10 | Write while switching chats/cards | Bind target at start; abort on context change; avoid wrong-card write | Proposed |
| A11 | Rename before/during write | Event+fresh target validation; stale fails closed; no fuzzy rebind | Proposed |
| A12 | Rename while extension is unloaded; old reference used | STALE_CARD_LOCATOR, explicit repair required | Known limitation |
| A13 | Group chat selected | No implicit owner; reads need explicit member; group writes disabled initially | Proposed |
| A14 | Shallow /all entry | Full /get required; never treat missing field as empty | Source verified; native test still needed |
| A15 | Two Hub writes in same tab | Per-avatar in-process queue serializes | Proposed |
| A16 | Two tabs or ordinary ST editor concurrently editing same PNG | No global serializability claim; show conflict/uncertain where detected | Known platform limitation |
| A17 | Export/portable fields | Names/aliases clearly portable; no secrets or external image binary assumptions | Export empirically demonstrated |
| A18 | Explicit promotion partly succeeds | Visible partial-state/recovery, never automatic duplicate | Deferred, requires H01-C |
| A19 | Same chatId in distinct owners/groups | Must not alias chat-local NPCs | Deferred source/native acceptance |
| A20 | Model attempts name-based merge or unattended save | No mutation without explicitly authorized user action | Proposed |
| A21 | Browser on plain HTTP LAN without crypto.randomUUID/crypto.subtle | Generate UUID v4 from crypto.getRandomValues; compare canonical registry equality; no insecure RNG or unavailable digest dependency | Proposed; native/runtime test required |

## 2. Design review checklist / owner signoff

- [ ] **D1** Choose exact schema fields, bounds, absence/null/invalid behavior, treatment of unknown v1 fields.
- [ ] **D2** Approve operational card locator **avatar + UUID** with known rename/missed-event limitations, or require a separate locator strategy BEFORE integration.
- [ ] **D3** Approve single-writer claim with no cross-tab atomicity; determine whether concurrent edits should disable mutations entirely.
- [ ] **D4** Approve direct guarded merge route with readback instead of relying on **writeExtensionField** Promise.
- [ ] **D5** Accept no automatic NPC persistence/promotion; chat-local spec remains future research.
- [ ] **D6** Group chats initially read-only for explicit members; never implicitly assign group to one card.
- [ ] **D7** Confirm this scope excludes ChromaticImages assets/ChromaticMessages story links, and no prod SillyTavern patch.
- [ ] **D8** Record owner decision and version v0.2 if any of D1–D7 changes.

## 3. Prospective missions (STOP at independent review between each)

**H01-B0 — Pure contract validation:** code only standalone schema/parser/validator/reference helper and tests. No SillyTavern imports, I/O, DOM, network, manifests, card edits or runtime plugin initialization. Negative cases for malformed nested values, prototype keys, byte length, UUIDs, alias collision, unknown versions, immutable updates and zero-mutation-on-error.

**H01-B1 — Read-only SillyTavern adapter:** access exact owner avatar; full-card fetch; statuses; shallow, ambiguous, missing, rename and group context invalidations; tests with controlled mock fetch. NO write APIs.

**H01-B2 — Guarded single-card mutations:** initially tests only on disposable synthetic target. Explicit user operations, in-instance queue, expected snapshot, direct merge and independent readback, uncertain failure reporting. Review safe UI json_data/editor synchronization BEFORE real native card test.

**H01-B3 — Owner-native acceptance:** disposable source/data fixture as in H00-C; repeat rename/duplicate/import and fault/dirty editor scenarios; owner records results and authorizes scope progression.

**H01-C — Chat-local research and promotion architecture:** ChatGPT source analysis and owner-native disposable chat metadata tests. No chat write implementation until reviewed evidence confirms save/readback/context behavior. Design partial-success recovery for card+chat operations; specify ChromaticDialogue interoperability without rewriting it.

**H01-D — Consumer integrations and UI:** only after stable APIs accepted; distinct bounded assignments for ChromaticDialogue, ChromaticImages and future ChromaticMessages. No autoplay or automatic image generation.

## 4. Acceptance evidence and publication discipline

Before marking any gate PASS, capture pinned repo/branch/HEAD, exact changed files, test/CI outputs, owner-native evidence if relevant, and limitations. A docs-only design PR is not an implementation PR. ChatGPT performs independent review; Antigravity does not own research or architectural decisions. Owner approves merge/release separately.

**Existing evidence debt:** The H00 P4 post-restart browser verification passed for four cards, but the separate P4 offline PNG/storage script output and original checkout-status receipt have not been submitted. Do not invent them or silently upgrade the evidence label.
