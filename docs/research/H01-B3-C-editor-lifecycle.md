# H01-B3-C — Editor lifecycle, persistence races and certification limits

**Status:** ChatGPT-owned research draft for independent owner review (2026-10-28). **No implementation or native mutation authorized.**

**Project baseline:** ChromaticHub `efad0836e6562bc4b26f449db9afa4c2fb1ebdc5` on `main` (workflow documentation integrated).  
**SillyTavern source baseline:** [`06bde939fb1e9c4c8d8641d810f0a916b5bce127`](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127), **not yet proven to match the intended future native executable**. The H00-C native staging checkout was `4ceca42ba2bef15f7c0f9f1040368260c8588b92`. Revalidate source before any native acceptance.

## 1. Question and conclusion

Can an extension reliably **certify quiescence of the built-in SillyTavern character editor**, without modifying or instrumenting SillyTavern, so that ChromaticHub may safely send a namespaced `/api/characters/merge-attributes` update?

**Conclusion from the pinned source:** No supported, positively complete quiescence certificate has been identified. Closed/hidden editor, inactive DOM, a matching in-memory card, and a readback immediately after Hub's write are **insufficient** to exclude a previously queued/in-flight native save or another writer. This is an evidence-bound conclusion, not a universal impossibility theorem for every version and extension architecture. **H01-B3-B's adapter must remain unconditionally deny-only.**

### Primary source trace

1. [`public/script.js:465–472`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L465-L472) declares `saveCharacterDebounced = debounce(() => $('#create_button').trigger('click'), DEFAULT_SAVE_EDIT_TIMEOUT)`.
2. [`public/script.js:11411,11437–11476`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L11411-L11476) binds form submission to `createOrEditCharacter` and edit-field input/favorite actions to the debounce. Other call sites include [`public/script.js:1410–1429`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L1410-L1429).
3. [`public/scripts/utils.js:562–584,615–624`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/utils.js#L562-L624) stores debounce timers in module-private `debounceMap`. `cancelDebounce` exists, but no documented pending-state getter or completion promise is exposed for the exported debounced save function. Cancelling an owned save would itself change SillyTavern behavior and is **not authorized**.
4. [`public/script.js:9754–9761,9868–9903`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L9754-L9903) builds `new FormData($('#form_create').get(0))`, posts `/api/characters/edit`, and then calls `getOneCharacter(avatar)`. A save may be in flight after its triggering UI event has finished. There is no general, exported live-save counter evidenced here.
5. [`public/script.js:8788–8814`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L8788-L8814) populates the editor's hidden `#character_json_data` from `characters[chid].json_data` during editor selection. [`getOneCharacter` at 1223–1246](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L1223-L1246) replaces the in-memory `characters[index]` element on a successful fetch, **without updating the hidden field**.
6. [`src/endpoints/characters.js:565–570`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L565-L570) seeds `charaFormatData` with `tryParse(data.json_data) || {}`. [The ordinary `/edit` endpoint at 1101–1139](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1101-L1139) builds from those form values: an old hidden JSON field may replace newer external extension metadata.
7. [`src/endpoints/characters.js:220–265`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L220-L265) returns `false` on caught PNG writing failures. Neither the [`/edit` route](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1101-L1139) nor [`mergeCharacterUpdate` at 1276–1304](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1276-L1304) checks this `false` before signaling success. **HTTP 200 is not durable-write proof.**
8. [`public/scripts/extensions.js:2070–2120`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js#L2070-L2120) mutates the browser's `character.data.extensions` and serialized `json_data` before its server request; it logs unsuccessful HTTP status rather than producing reliable persistence confirmation. It is not a substitute for Hub's verified readback.
9. [`src/endpoints/characters.js:1276–1304,1390–1414`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1276-L1414) applies an unrestricted read/merge/write without an atomic expected-revision parameter. Revision comparisons plus a local Hub avatar queue provide **optimistic conflict detection only**, not cross-tab serialization.

## 2. Concrete stale-form overwrite sequence

Sequence below is a possible interleaving inferred from the source, **not yet a native reproduction**:

1. SillyTavern selects card A and copies its earlier `json_data` (registry revision *r*) into the editor's hidden field.
2. Hub or another tab persists a new registry revision *r+1* through a separate card merge.
3. SillyTavern's `getOneCharacter` (if called) refreshes browser `characters[]`, but does not thereby update the hidden editor field.
4. A pending debounce or ordinary editor submission posts `FormData` containing the old `json_data`.
5. The server reconstitutes the card from that old seed and writes the PNG. The newer Hub registry may be overwritten with revision *r*.

Even a successful Hub readback at step 2 cannot exclude step 4 happening later.

## 3. Certification options and decisions

| Candidate | Establishes | Missing proof / decision |
| --- | --- | --- |
| Editor popup hidden/closed | Presentational state only | **Not a quiescence signal**; pending/in-flight save may remain |
| Compare DOM form fields with current cache | Selected field consistency at inspection instant | Cannot prove no queued save or another writer; **deny** |
| Wait longer than debounce delay | Elapsed time | New triggers/in-flight requests/cross-tab writers remain possible; **deny** |
| Use `getOneCharacter()` or reload UI | Refreshes in-memory card | Does not update existing hidden JSON field or exclude in-flight writes; **deny** |
| Monkey-patch debounce/click/fetch | May observe some local events | Not comprehensive without verified lifetime and all mutation paths; invasive; **not authorized** |
| Native editor save lifecycle API with coordinated lock | Could provide observable local quiescence | Requires separate design and version-specific native integration; not present in evidence |
| Server-side conditional update / CAS or lock | Could address writer races if complete | Not available on the pinned merge route; server change is separate architecture work |
| Fully isolated single-writer disposable instance | Controls known fixture writers | Useful for **testing only**, not general-production certification |

**Decision for H01-B3-C:** no new runtime `safe:true`, no editor save interception/cancellation, no `json_data` patching, no changes to Hub controller. Any future certifying adapter requires a separate explicit contract, instrumentation/native proof and owner authorization.

## 4. Gate design before an Antigravity coding mission

- **C-R — Source research:** complete for the pinned 06bde93 baseline; actual intended executable's HEAD remains **unverified**.
- **C-P0 — Owner read-only target preflight:** identify Git status, exact source revision, launch/global mode, effective config/data root, enabled extensions, active server ports and browser profiles; do not start a second instance yet.
- **C-P1 — Isolated setup plan:** fresh disposable source/dependency snapshot and distinct writable config/data directories with symlink and path containment checks; never point at owner production data. Preparation requires separate owner approval.
- **C-P2 — Read-only instance observation:** separately authorize starting isolated instance and reading its effective paths and a disposable card; no writes or API mutation.
- **C-P3 — Owner-native race experiments:** **DEFERRED**; requires separate written disposable-card mutation authorization, backup/recovery plan and clear experiment matrix.
- **C-P4 — Interpretation/recovery:** compare serialized persisted registry and independent offline PNG text chunks when separately authorized. Record uncertainty instead of automatic retries.

**Do not ask Antigravity to rediscover source behavior**. ChatGPT owns investigation and documentation. A future coding assignment should be small, exact-path, focused on mechanical fixture/probe code only, after a reviewed plan.

## 5. Residual questions and acceptance limitations

- What exact SillyTavern commit and launch mode will be the intended native target? H00's earlier staging checkout was not the source-research SHA.
- Which startup side effects occur outside data/config roots in the actual target? H00 used an independent archive/dependency snapshot for this reason.
- Are any other extensions/tabs/writers active in the isolated profile? Must be absent or explicitly listed.
- Can the editor submit after its UI closes, and under precisely which saved-debounce/switch conditions? Requires isolated owner-native experiments before a positive claim.
- What is the minimal safe coordination feature (if any) consistent with upstream SillyTavern's interfaces, without modifying its core? Not established.
- Cross-tab atomicity, missed avatar-rename recovery and HTTP-200-but-disk-failure remain unresolved.

**Bottom line:** source inspection supports *denial* of an unproven safe window. It does not authorize either production integration or mutation of a real character card.
