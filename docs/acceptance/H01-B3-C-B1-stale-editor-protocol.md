# H01-B3-C — C-P3-B1 exact stale-editor experiment protocol

**Status:** ChatGPT-owned source-reviewed protocol, **NOT execution authorization** (2026-10-29). No browser launch, server restart, API mutation, UI save, restore or fixture cleanup is authorized by this document.

**Repository baseline:** ChromaticHub `main` at `efad0836e6562bc4b26f449db9afa4c2fb1ebdc5`; H01-B3-B runtime editor-safety adapter remains unconditional **deny-only**.  
**Native source:** owner checkout `4ceca42ba2bef15f7c0f9f1040368260c8588b92`, source-compatible with pinned upstream `06bde939fb1e9c4c8d8641d810f0a916b5bce127` at the six researched call-site files.  
**Fixture:** `/tmp/ChromaticHub-H01B3C-P1A.mfsvd3mm`; localhost `127.0.0.1:18283`.  
**Card:** `CHH01B3C_Disposable_Baseline.png` (exactly one fixture-owned card; NOT a production card).  
**Accepted original baseline PNG SHA-256:** `1c69551f1e4426c04dfed8726551d6b6df0b29a7f2e6fbd61c754fa856ea5048`. The saved baseline `receipts/c-p3a-baseline.png` is not to be overwritten or moved.

## 1. Question, mechanism and limits

**Question:** Can an ordinary SillyTavern character-editor save, originating from a form populated *before* a separate card metadata merge, replace the now-newer `data.extensions.chromaticHub` registry in the persisted PNG?

**Source-derived causal chain (not yet reproduced natively):**

1. [`select_selected_character` stores `characters[chid].json_data` in `#character_json_data`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L8788-L8814).
2. [`createOrEditCharacter` builds `FormData(#form_create)` and POSTS `/api/characters/edit`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L9750-L9761); [edit branch and post-save `getOneCharacter`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L9868-L9903).
3. [`/edit` reconstructs from the submitted `json_data`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L565-L624), [and writes the PNG](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1101-L1139).
4. [`getOneCharacter` refreshes the `characters[]` cache, not the already populated hidden form field](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L1223-L1246).
5. [`/merge-attributes` accepts a single-card `avatar` plus nested merge data](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1276-L1414). This endpoint reads/merges/writes without a cross-writer CAS; [`writeCharacterData` may return `false` without throwing](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L220-L265).
6. [Editor text input/favorite click can schedule a debounced native save](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L11437-L11476). **B1 targets one explicit editor save only**; queued and in-flight save experiments belong to separately reviewed B2.

A successful single case can demonstrate **loss or survival in that observed sequence**, not prove global write quiescence. The B3-B adapter remains deny-only irrespective of the result.

## 2. Fixed mutation envelope and observer boundary

Exactly **two intended character-writing HTTP requests** are permitted in the future B1 experiment, and only after separately authorized execution:

1. **One** JSON `POST http://127.0.0.1:18283/api/characters/merge-attributes`, with its own cookie session and `X-CSRF-Token` from a prior read-only `GET /csrf-token`. No bulk `avatars` field. The entire expected JSON payload is:

   ```json
   {
     "avatar": "CHH01B3C_Disposable_Baseline.png",
     "data": {
       "extensions": {
         "chromaticHub": {
           "schemaVersion": 1,
           "revision": 1,
           "characters": []
         }
       }
     }
   }
   ```

   This is the minimal **valid H01-A registry** (not a fabricated extra key, UUID, or production identity). Do **not** call the Hub production mutation controller, install the extension, or merge any other card.

2. **One** browser-triggered native editor `POST /api/characters/edit`, initiated from the **already-open editor form with unchanged `#character_json_data`** and without editing input fields. Send no separate scripted `/edit`; do not patch `fetch`, debounce, DOM, headers, or `json_data`. One literal UI Save action; if multiple edit requests occur, stop and classify as **uncontrolled**.

Allowed read-only requests in the execution plan: `GET /`, `GET /csrf-token`, `POST /api/characters/get` and incidental app/UI resource requests. Post-merge and final offline PNG reads, hashes and copy-to-receipts are fixture-local observation. Never infer persistence solely from HTTP 200.

## 3. Design checkpoints — separately authorize before execution

| Stage | Boundary / expected evidence | Failure handling |
| --- | --- | --- |
| **B1-PRE** | Confirm C-P3-A baseline copy SHA, original card SHA, exactly one card, stopped old process, free port, committed source/dependencies and no escaped links; create fresh fixture-only pre-experiment snapshot, unique run marker and evidence directory | STOP; never restore automatically or reuse C-P3-A one-shot creator |
| **B1-START** | Launch only approved source and isolated config/data/Home with browser autolaunch/content checks/extensions/plugins/providers disabled, preserve process identity; verify owned `127.0.0.1:18283` listener | Targeted shutdown; reject other owners or nonloopback listener |
| **B1-OPEN** | In one fresh isolated Firefox profile/tab, open only the disposable card editor; verify `#form_create[actiontype=editcharacter]`, `#avatar_url_pole` matches exact filename, and `#character_json_data` parses to the original registry-absent state; fingerprint hidden JSON without printing it | STOP on dirty/unknown form, extra tabs/writers, unintended saves or unexpected metadata |
| **B1-MERGE** | Exactly one allowed JSON merge; independently read API and PNG `chara`/`ccv3`; require the revision-1 empty registry persisted and preserve a **post-merge** PNG/hash snapshot | STOP/WRITE_UNCERTAIN on wrong HTTP code, failed independent readback, additional file changes or unknown writer; **never retry** |
| **B1-STALE-CHECK** | With editor still open and **before clicking Save**, re-inspect the hidden field: still holds original old JSON with `chromaticHub` absent; independently persisted disk/API shows revision 1 | If field updated automatically or editor closed, classify **NOT_STALE / INCONCLUSIVE**; do not force it stale |
| **B1-SAVE** | Owner performs one manual Save action through the existing editor UI, without field edits. Observe request count, `/api/characters/edit` completion, and any incidental readbacks using browser devtools; keep all observation read-only | STOP on multiple edits, generation/provider request, lost session, error, outstanding requests or uncertain completion |
| **B1-FINAL** | Fresh independent API `/get` plus offline PNG `chara`/`ccv3`, full JSON equality checks, SHA-256, final PNG snapshot, compare registry and unrelated data against baseline + post-merge state | Label **REGISTRY_LOST**, **REGISTRY_PRESERVED**, or **INCONCLUSIVE** according to actual evidence. HTTP status is never decisive alone |
| **B1-STOP** | Terminate **only** verified fixture-owned server (and isolated browser if launched), check port release, preserve log, snapshots, hashes, event timeline and safety receipt | Do not kill original user sessions or delete fixture; mark **STOP_UNCERTAIN** if ownership/port unclear |

**Important timing:** The test is **sequential stale-form overwrite**, not an attempt to induce a simultaneous write race. Browser-network evidence must distinguish the authorized merge from the single editor save. An idle UI or passing delay is a test-control observation, **never a quiescence certificate**.

## 4. Deterministic interpretation

- **REGISTRY_LOST:** persisted post-merge `data.extensions.chromaticHub` equals revision 1; the older editor's `#character_json_data` was demonstrably still pre-merge; exactly one UI `/edit` was observed; final independent disk/API lacks the registry (or equals earlier revision), with no unexplained writer. The stale-form overwrite hypothesis is reproduced for the fixture.
- **REGISTRY_PRESERVED:** same controlled prerequisites, but both final disk/API retain exactly the revision-1 registry. This **does not** certify safety, nor disprove queued saves or concurrent writers in other sequences.
- **INCONCLUSIVE/WRITE_UNCERTAIN:** lost/changed editor state, any extra mutation, unreadable/corrupted PNG, differing `chara` and `ccv3`, network timeout, inconsistent API/disk, unknown process or port, missing logs or failed shutdown. Do not infer overwrite from an ambiguous result.

Every persisted state compared using actual card data, **not** browser `characters[]` alone. Preserve complete card hashes and only sanitized summaries outside the fixture.

## 5. Baseline preservation and recovery (no automatic restore)

- Keep immutable `receipts/c-p3a-baseline.png` with SHA `1c69551f1e4426c04dfed8726551d6b6df0b29a7f2e6fbd61c754fa856ea5048`. Reject changed or missing baseline **before startup**.
- Before any future B1 modification, copy the current original card to a **new** fixture-only receipt path (verify hash matches baseline), and snapshot the fixture's data subtree/metadata as needed. Never overwrite prior evidence.
- Preserve distinct `pre-merge`, `post-merge` and `post-save` PNGs plus JSON/PNG fingerprints under a uniquely named run directory. The recovery route must operate on exact validated fixture-owned files only.
- **Do not restore the original card automatically at the end of B1.** Restoration is a **separate future write** requiring owner approval, proof no fixture process or browser writes are active, hash check, and an offline exact-path copy. Prefer a cloned disposable fixture for future repeated scenarios rather than mutating the existing accepted baseline in place.
- Never run `rm -rf` on guessed directories, `git reset`, `npm install`, or production-side tools. Existing owner checkout `/home/zzzne4/SillyTavern` (including dirty package manifests) is outside all write scopes.

## 6. Review outcome and next authorization

**B1-D protocol review: ready for owner approval, not performed.** The above source inspection supports the candidate payload and sequence, but there is **no native browser observation yet** and no assumption that selecting the card/editor is free of automatic saves. The separately designed B1 execution tooling must validate all preconditions and fail closed if the actual UI behavior diverges. The B1 implementation/testing can be ChatGPT-owned as with C-P3-A; no Antigravity coding mission is required.

**Owner decision required before any B1 file creation, server/browser launch or write:** explicitly approve one controlled, fixture-only B1 merge + UI save experiment. The actual script/runbook will be independently checked and presented before execution. Do not treat approval of this protocol as blanket permission to retry or run B2/B3.
