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

## 6. Owner authorization and one-shot executable (2026-10-29)

The owner **explicitly authorized B1**, restricted to **one fixture-only JSON merge and one manual native editor Save** on the disposable card, with API/offline PNG verification and no automatic retry or restore.

ChatGPT prepared the owner-run standalone Python script `chromatichub_h01b3c_b1_stale_editor.py`, as a conversation attachment **not committed to ChromaticHub source**, SHA-256:

```text
c6b333c47b5a48a5896b93b31400aa25c81901eb40d7cac3c88967c3bfb91ba9
```

**Execution still pending.** The script is pinned to `/tmp/ChromaticHub-H01B3C-P1A.mfsvd3mm` and its original PNG SHA `1c69551f1e4426c04dfed8726551d6b6df0b29a7f2e6fbd61c754fa856ea5048`. It is deliberately **one-shot**: it marks `receipts/c-p3b1-state.json` before launching the isolated server, refuses to rerun when the marker exists, and preserves separate `pre`, `post-merge`, `post-save` PNG snapshots. It inherits only the previously verified fixture configuration/dependency infrastructure, starts a fresh `--no-remote --new-instance --profile` Firefox, performs a read-only console hash probe of `#character_json_data` **before and after the merge**, and asks the owner to confirm there are no editor `/edit` network requests before merge and exactly one 200 after the single manual Save. The browser probe explicitly validates the selected avatar, form type, registry absence and full hidden-JSON SHA-256 against the original independent API readback.

The script does **not** post `/api/characters/edit`: that is the single manual UI operation. It does post `/api/characters/merge-attributes` exactly once, guarded by explicit owner confirmation and a durable attempted marker, and independently checks PNG `chara`/`ccv3` (including PNG chunk CRC), fresh card API readback and full card content. Server and browser process cleanup is bounded to directly launched, identity-checked processes/groups; port release is checked before claiming success. **On STOP no rerun, deletion or restore is authorized.**

**Synthetic verification, not native acceptance:** complete localhost integration with a mocked stale editor overwriting the registry PASS; fixture snapshots and one-shot refusal PASS; wrong browser hash STOP; duplicate merge STOP; unauthorized programmatic `/edit` STOP; script syntax/compile PASS. No real SillyTavern browser/editor was started in ChatGPT's environment.

**B1 terminal output will determine acceptance** (must include `C_P3_B1=PASS`, `B1_REGISTRY_RESULT=REGISTRY_LOST|REGISTRY_PRESERVED`, `SERVER_STOPPED=YES`, `PORT_RELEASED=YES`, `BROWSER_STOPPED=YES`). The owner's browser network observation is a separately reported manual fact, not an independently captured network trace. No B2, B3, production write activation, concurrent write safety claim or fixture restoration is authorized.

### C-P3-B1 owner-native preflight STOP and confirmed false positive (2026-10-29)

The owner ran the first B1 script and obtained:

```text
C_P3_B1_CHECK=STOP:CARD_COUNT_OR_TARGET_INVALID
BROWSER_STOPPED=YES
SERVER_STOPPED=YES
PORT_RELEASED=NOT_STARTED
C_P3_B1=STOP
```

**First invocation STOPPED before creating one-shot artifacts, launching server/Firefox, or issuing a character request.** Read-only owner investigation conclusively identified the guard error:

```text
ORIGINAL_GUARD_COUNT=2
REAL_CARD_FILES=1
REAL_CARD_PNGS=1
CACHE_CHARACTER_FILES=1
OTHER_CHARACTER_FILES=0
DATA_SYMLINKS=0
CARD_HASH_MATCH=True
BASELINE_HASH_MATCH=True
B1_STATE_EXISTS=False
B1_CONFIG_EXISTS=False
B1_LOG_EXISTS=False
B1_PRE_SNAPSHOT_EXISTS=False
```

**Root cause confirmed:** original `get_cards()` counted the genuine file in `data/default-user/characters/` and a **non-card disk-cache entry** under `data/_cache/characters/`. The cache is expected after C-P3-A readback; see the pinned [`DiskCache.DIRECTORY` and cache paths](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L24-L114). Original preflight raises before `save_state(state)`, so the existing owner B1 write authorization has **not been consumed by any observed write**. The original script must never be rerun.

### C-P3-B1-R1 — corrected executable and independent synthetic tests

Replacement attachment: `chromatichub_h01b3c_b1_stale_editor_r1.py`. SHA-256:

```text
31b1b39163dff02cd26166567c37a4510d2da10920954d8b076e988e811d3c7c
```

**Exact code delta:** only `get_cards()` changed. The function now counts files from the fixture's expected `data/default-user/characters/` and skips regular cache files **only** inside the exact `data/_cache/characters/` directory. It still rejects any symlink beneath `data/`, any unexpected `characters` directory (including an empty directory for another user), any extra file in the genuine card directory, an absent/symlinked genuine card directory, and a second real card. Both preflight and all independent PNG/API readback checkpoints call this same corrected inventory.

**Verification performed in ChatGPT's isolated container, not on the owner's actual fixture:**

- Python bytecode compile: PASS.
- Diff audit: exactly one function edited; no changes to HTTP operations, editor save workflow, one-shot marker, shutdown/cleanup or production code.
- **11/11** isolated `get_cards()` test scenarios PASS: one card, real card plus cache, multiple cache entries, extra real card, non-PNG file, another user's card directory (including empty), symlinks, absent card directory and symlinked card directory.
- **3/3** full preflight smoke scenarios PASS with controlled synthetic source/receipt stubs: one real card plus cache, one card without cache, and second real card STOP. These stub portions validate preflight **control flow**, not the real archive or actual server.
- **Owner native B1-R1 execution: PENDING.** Existing C-P3-A baseline hash and evidence remain unchanged according to owner's read-only report.

**Execution decision:** the original owner authorization for exactly **one** fixture-only merge and **one** manual native editor save remains applicable to R1 after this correction; **no automatic replay or retry is permitted**. R1 requires the owner's deliberate separate command invocation and must not be run if any new fixture state divergence is found. If it reports STOP, preserve all evidence and return for independent review. No B2, concurrent writer, restoration, or production activation is authorized.

### C-P3-B1-R1 — owner-reported frontend settings initialization failure (2026-10-29)

The owner launched R1 and reported the Firefox window displaying **"Initializing… Settings could not be loaded after multiple attempts. Please try again later."** A completed B1 terminal receipt has **not yet** been supplied. No assertion about actual merge, card integrity or final process state can be made from the browser message alone; the owner was advised to **Ctrl+C once** in the B1 terminal (the script catches `KeyboardInterrupt`, executes targeted shutdown, and leaves the one-shot attempt state intact), not to merge, save, refresh or rerun.

**Source-backed probable missing precondition:** [`public/script.js` `getSettings()`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L7911-L7929) requests `POST /api/settings/get`, and issues the displayed error on a non-2xx HTTP response. [`src/endpoints/settings.js`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/settings.js#L222-L231) returns HTTP 500 if `data/default-user/settings.json` cannot be read. The B1 script's `runtime_config()` sets `skipContentCheck: true`, while [`checkForNewContent`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/content-manager.js#L218-L226) exits before default-content seeding when skip is true. The pinned [`default/content/index.json`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/default/content/index.json) includes `settings.json`, but earlier C-P2/C-P3-A API-only tests did not require an initialized frontend. **This explanation is not yet verified against the owner's on-disk settings file or HTTP status.** It remains possible that the API failed for another reason.

**Hold:** Do not manually enable content seeding (it also contains default characters and would violate the one-card fixture), copy production settings, edit baseline cards, remove the B1 state marker or repeat B1. Perform read-only settings-file existence, evidence-state, card-hash and shutdown review first. Any planned correction should seed **only** fixture-local default settings from the exact pinned `source/default/content/settings.json` after verifying origin/hash, record the new startup precondition, and issue a separately reviewed one-shot recovery procedure. Existing B1 authorization does not imply permission to rerun a script after its one-shot marker is set.

## 7. Review outcome

**B1-R1 is ready for owner-native execution, but no B1 editor-save outcome exists yet.** A STOP in the original overbroad guard is **not** evidence that the stale-editor overwrite hypothesis is false. The H01-B3-B editor-safety adapter stays unconditionally deny-only, irrespective of the R1 result.
