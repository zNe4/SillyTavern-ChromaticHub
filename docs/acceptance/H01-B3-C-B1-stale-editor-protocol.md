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

### B1-R1 native diagnostic — missing fixture settings confirmed (2026-10-29)

The owner inspected the **stopped** R1 fixture after Firefox displayed the settings-initialization error and reported:

```text
FIXTURE_SETTINGS_EXISTS=False
DEFAULT_SETTINGS_SOURCE_EXISTS=True
CARD_ORIGINAL_HASH_MATCH=True
BASELINE_HASH_MATCH=True
B1_STATE_EXISTS=True
STATUS=STOP
MERGE_ATTEMPTED=False
MERGE_VERIFIED=False
MANUAL_EDITOR_SAVE_CLAIMED=False
PROCESS_STOPPED=True
BROWSER_STOPPED=True
PORT_RELEASED=True
ERROR=KeyboardInterrupt
B1_SERVER_LOG_EXISTS=True
```

**Disposition: R1 STOP / no experimental card mutation.** Baseline PNG and card hashes match; the owner exited via `KeyboardInterrupt`; the fixture server and browser stopped and port was released. The **R1 one-shot marker is now spent** and must not be removed, overwritten, or manually reused.

**Confirmed prerequisite gap:** `data/default-user/settings.json` is missing, while the tracked `source/default/content/settings.json` exists. The pinned `public/script.js` emits the exact UI error on failed `POST /api/settings/get`; pinned `src/endpoints/settings.js` returns HTTP 500 when user settings cannot be read. The fixture startup deliberately sets `skipContentCheck: true`, which disables the normal default settings seed. The missing file explains this error path. **No actual per-request HTTP response from the owner was captured**, so avoid asserting a measured 500 or ruling out other bootstrap failures.

**Next step is B1-R2 design, not an immediate retry:** provision **only** fixture-local settings from the pinned committed `source/default/content/settings.json`, validated against the archive. Do not enable general default-content seeding (it could seed a second character), or copy production settings, providers, personal credentials or API keys. The committed settings contain `firstRun: true` and `main_api: koboldhorde`, so for the disposable UI experiment, a reviewed fixture-local derived file should set `firstRun: false` to skip onboarding, and select an inert, no-provider-connection UI route (candidate `main_api: kobold`; source verify before approval). Other fields must remain from committed template; record exact differences and hashes.

**R2 safety requirements:** independent B1-R2 state/config/log/browser-profile namespaces; preserve R1 STOP receipt/config/log and profile; verify original card and baseline hash, single-card inventory, inactive port and `merge_attempted=false`/`manual_editor_save_claimed=false` from R1; seed settings **only if the exact fixture target does not exist**, using exclusive create; verify JSON/HTTP settings bootstrap before opening the browser; one explicit owner-authorized merge and one manual editor Save remain the total B1 mutation budget; no automatic retries, cleanup or restore. Script review and explicit R2 execution approval are separate gates.

### Owner-directed scope pivot — test-only main SillyTavern checkout (2026-10-29)

The owner clarified that `/home/zzzne4/SillyTavern` is **exclusively a testing installation** and explicitly accepts conducting B1 without a separate isolated server. **Decision: abandon the B1-R2 fixture-settings repair and do not run R1/R2 again.** The previous isolated fixture `/tmp/ChromaticHub-H01B3C-P1A.mfsvd3mm` retains its intact original baseline and all STOP evidence; leave it alone until separate cleanup decision.

**New B1-DIRECT candidate:** work exclusively with a **new, clearly named disposable character** in the owner's regular test installation, via its normal configured server and normal Firefox session. This bypasses scripted launch, copied dependencies, stale empty settings, custom Firefox profiles and one-shot scripts. Before mutating, record current branch/HEAD, modified worktree files, active username/card directory, exact test-card filename, and a fixture-external copy + SHA-256 of that newly created card. Do **not** reset dirty `package.json`/`package-lock.json`, change server configuration, or assume original source SHA remains unchanged without rechecking.

**Exact experimental budget remains:** one `POST /api/characters/merge-attributes` with the already reviewed valid revision-1 empty registry to the **newly created test card only**, followed by one manually triggered native UI editor Save from the stale form, with zero other character `/edit` operations. Preserve before/post-merge/post-save disk PNG hashes and content, browser request observations, and independent API readback. Stop on missing baseline, pre-existing registry, unexpected other cards/saves, network error, second request, or inconclusive persistence. No provider generation, production card use, other-card mutation, automatic retries, or registry restoration. The host's other stored test materials must still be regarded as out of scope.

**Important scope distinction:** owner accepts writes into this *test-only SillyTavern installation*, not into production ChromaticHub runtime logic or arbitrary user directories. The pure H01-B3-B editor-safety adapter stays unconditionally deny-only and the experiment cannot certify quiescence. This direct approach is a newly selected execution route; the old B1 one-shot script markers are not recycled.

### B1-DIRECT owner-native disposable card baseline (2026-10-29)

The owner confirmed the regular test installation is at expected HEAD `4ceca42ba2bef15f7c0f9f1040368260c8588b92`, with pre-existing `package.json` and `package-lock.json` modifications untouched, and `data/default-user/settings.json` present. An initial inventory found no new card, then the owner **manually created** exactly one fixture-external test card `data/default-user/characters/CHH01B3C_StaleEditor_LocalTest.png`. The prior three unrelated test-installation cards remain out of scope.

The owner ran the standalone *read-only metadata check and backup creation* and reported:

```text
NAME=PASS
DESCRIPTION=PASS
FIRST_MESSAGE=PASS
REGISTRY_ABSENT=PASS
EVIDENCE_DIR=/home/zzzne4/ChromaticHub-B1-direct._xlayxdb
CARD_SHA256=6593f9ff1320afff74a0b434ab92b6deb8701addc32a55afff8a723ad2e92aab
BACKUP=PASS
BASELINE=PASS
```

**B1-DIRECT baseline accepted on owner evidence.** Metadata expectations: description `This is a test chat for ChromaticHub!` and first message `Hi. I'm a test character. Please tell me what I should do now.` The backup `pre-merge.png` is outside the SillyTavern checkout and read-only; keep it unchanged. No API merge or stale editor Save has occurred.

**Next read-only gate:** open the exact target card's editor without modifying fields; set Firefox Network log preservation; compare SHA-256 of the original hidden `#character_json_data` to the **ccv3** (preferred by the pinned `character-card-parser.js`) or `chara` JSON text extracted from the preserved PNG, alongside the selected `avatar_url`, action type and absent `chromaticHub`. The earlier baseline script validated `chara` but did not establish the hidden string's equality. Stop if a native `/api/characters/edit` occurs while opening the editor. **Do not submit the B1 merge until these checks pass.**

### B1-DIRECT editor snapshot checkpoint (owner-reported, 2026-10-29)

The owner extracted and parsed the preserved **ccv3** PNG metadata and compared its raw string to Firefox's current `#character_json_data`. Owner output:

```text
REFERENCE_SOURCE=ccv3
REFERENCE_JSON_SHA256=9f66a4742ccafc2342bb05d49427ffc2d19547059f102226f7473be0c377b424
REFERENCE_READY=YES
EDITOR_ACTION=editcharacter
AVATAR_MATCH=true
REGISTRY_ABSENT=true
EDITOR_JSON_SHA256=9f66a4742ccafc2342bb05d49427ffc2d19547059f102226f7473be0c377b424
```

**Decision: hidden editor JSON fingerprint accepted on owner-reported evidence.** The selected editor form is correctly targeted, the registry is absent, and the raw hidden JSON matches the accepted pre-merge PNG `ccv3` metadata byte-for-byte. **Still pending:** owner confirmation of *zero* `/api/characters/edit` requests in Firefox Network since opening; no merge may be sent until this separate check passes. **Later B1-DIRECT merge, autosave, and final readback checkpoints are recorded below.**

### B1-DIRECT — one merge submitted; independent PNG persistence verified (2026-10-29)

Owner console output from a **single attempted** merge request:

```text
B1_PREMERGE_EDITOR=PASS
B1_PREMERGE_API=PASS
B1_MERGE_ATTEMPTED=YES
B1_MERGE_HTTP=200
B1_MERGE=AWAITING_DISK_VERIFICATION
```

Then the owner independently inspected the test card's persisted PNG, validated the `chara` and `ccv3` content and CRC, checked unrelated metadata against the preserved baseline, and wrote a fixture-external `post-merge.png` snapshot:

```text
REGISTRY_REVISION_1=PASS
UNRELATED_METADATA_PRESERVED=PASS
POST_MERGE_CARD_SHA256=24313b0359c58763f1e667ef86abc73ceaf04a9a7de1ffc5340f8dbc2b6886ed
POST_MERGE_JSON_SHA256=572cfbc3c7bd7d5565fb116cea8985da56dfba6cdad62e251876bf54ae25f84e
POST_MERGE_SNAPSHOT=PASS
POST_MERGE=PASS
```

**Decision: post-merge disk persistence PASS on owner-reported native evidence.** A valid empty registry `{schemaVersion:1,revision:1,characters:[]}` is now persisted at `data.extensions.chromaticHub`. The baseline `pre-merge.png` remains hash `6593f9ff1320afff74a0b434ab92b6deb8701addc32a55afff8a723ad2e92aab`; `post-merge.png` is preserved under `/home/zzzne4/ChromaticHub-B1-direct._xlayxdb`. **At this checkpoint, no native autosave had occurred; a later section records its result.** A **fresh post-merge `/api/characters/get` readback**, current editor hidden-JSON recheck, and explicit Network-panel confirmation of no earlier `/api/characters/edit` requests are **still outstanding** before B1 Save. The pre-merge client API check did pass, but it does not substitute for post-merge independent API verification. Do not infer a browser-safe write window from this disk success.

### B1-DIRECT — decisive owner-native autosave and final independent readback (2026-10-29)

**Accepted B1 core outcome: `REGISTRY_LOST` (stale native editor overwrite reproduced).** The owner reports zero earlier `/api/characters/edit` requests, a single form-triggered native `POST /api/characters/edit` following the addition of one exclamation point in the description field, and a successful HTTP status. SillyTavern's pinned frontend source schedules this request via `saveCharacterDebounced` on input and submits the form's stale hidden `json_data`; there is no separate manual save requirement in this experiment. No additional write should be attempted.

Owner's final offline `post-autosave.png` snapshot comparison against the verified `post-merge.png`:

```text
MERGED_REGISTRY_VALID=True
ORIGINAL_DESCRIPTION=This is a test chat for ChromaticHub!
FINAL_DESCRIPTION=This is a test chat for ChromaticHub!!
FINAL_REGISTRY=null
OTHER_METADATA_UNCHANGED=False
POST_AUTOSAVE_CARD_SHA256=bdab0ff3a1709ed3f8b1ad140f113f5317fa0ffa821ebaa577372799e506913e
POST_AUTOSAVE_JSON_SHA256=b70bc2a87ede8ac0d098595c7345855de3c0923ab618cc61b711ccae959681fe
B1_DISK_OUTCOME=REGISTRY_LOST
POST_AUTOSAVE_SNAPSHOT=PASS
```

Owner's independent read-only `/api/characters/get` after autosave:

```text
API_DESCRIPTION=This is a test chat for ChromaticHub!!
API_REGISTRY=null
API_JSON_SHA256=b70bc2a87ede8ac0d098595c7345855de3c0923ab618cc61b711ccae959681fe
B1_API_READBACK=PASS
```

**Causal chain:** preserved pre-merge disk and hidden-form raw metadata hashes matched exactly and lacked the registry; one merge added `{schemaVersion:1,revision:1,characters:[]}`, validated by offline PNG and fresh API readback while the form remained stale; one normal UI input caused native autosave; the final PNG and fresh API response match, both lack the registry, and the description change persisted. This is sufficient to classify **B1 core verification as PASS, overwrite hazard reproduced**. It establishes an unsafe stale-editor interleaving in this version of SillyTavern; it is not a general concurrency proof or certification of an editor-safe write window.

**Supplemental diagnostic completed (owner-reported, read-only field-path diff):** `TOTAL_CHANGED_PATHS=5` and `EXTRA_CHANGED_PATHS=2`. The expected changed paths were `description` and `data.description` (the deliberate single-character edit) and the removed `data.extensions.chromaticHub` (the stale overwrite). The other paths were **`avatar` (CHANGED)** and **`create_date` (ADDED)**; the path-only diagnostic did not expose their before/after values. A source review of pinned SillyTavern `src/endpoints/characters.js` confirms `charaFormatData()` sets `char.avatar = 'none'` when building the edited card and the native `/edit` route assigns `char.create_date = request.body.create_date`. These source-defined transformations explain why the native save can change these fields independently of the deliberate description edit. **The B1 registry-loss verdict is unaffected; there are no remaining unidentified changed metadata paths**, though the exact extra field values were not examined.

Preserve `/home/zzzne4/ChromaticHub-B1-direct._xlayxdb/pre-merge.png`, `post-merge.png`, and `post-autosave.png`; do not restore or re-merge automatically. **Keep H01-B3-B runtime adapter unconditionally deny-only (`safe:false`, `EDITOR_SAFETY_NOT_CERTIFIABLE`).** Any recovery or new write strategy requires a separate approved design and scope.

## 7. Review outcome

**The owner elected to use the regular testing-only SillyTavern checkout for the next B1 attempt.** The original B1-R1 and planned B1-R2 fixture scripts remain retired; their evidence must be preserved. The accepted native test used one newly created disposable card, one backed-up registry merge, and one debounced native editor autosave caused by a single deliberate description input. The final disk and API readbacks independently reproduced registry loss; the supplemental diff accounted for all five changed field paths. Keep H01-B3-B deny-only pending a separate approved architecture decision.
