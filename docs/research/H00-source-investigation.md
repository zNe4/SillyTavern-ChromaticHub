# H00 — SillyTavern source investigation and card-storage feasibility

**Research owner:** ChatGPT. **Date:** 2026-10-26.  
**Source baseline inspected:** SillyTavern commit **06bde939fb1e9c4c8d8641d810f0a916b5bce127**.  
**Owner-native staging checkout in later H00-C tests:** **4ceca42ba2bef15f7c0f9f1040368260c8588b92**, branch **m03-d2b1-nanogpt-proxy**.  
**Status:** source research complete; subsequent runtime outcomes recorded [separately](../acceptance/H00-C-card-registry-acceptance.md). Recheck line numbers/semantics when moving to another SillyTavern release.

## H00-A: problem and evolution of the design

Originally investigated a user-global identity index using extension settings, character-embedded IDs, a hybrid registry with card/chat hints, and browser-local databases. All were possible candidates, but global ownership, duplicates, portability and collision resolution added complexity without an immediate requirement.

**Supersession:** After reviewing intended RP use, the owner chose a registry **per card**. A card's characters and image-reference identity should persist between its chats; ChromaticDialogue cN labels should not. Storyline continuation for ChromaticMessages is a different concern and is deferred to that extension.

Core invariants:
- A name is not a person ID. Two Hina entries may coexist on one narrator/simulator card.
- A local character ID alone is not a cross-card identity.
- SillyTavern's character-array index, avatar filename and chat ID are not interchangeable with a stable fictional identity.
- Identity resolution must represent unknown and ambiguous matches explicitly, rather than guess.

## H00-B: verified source mechanisms

| Area | Pinned source | Observation / constraint |
| --- | --- | --- |
| Extension API | [extensions.js L2063–2120](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js#L2063-L2120) | writeExtensionField writes to **data.extensions[key]**, updates in-memory/json_data state and posts to server; logs HTTP failure without throwing. |
| Exposed context | [st-context.js L115–127, L203–210](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/st-context.js#L115-L127) | The context exposes characterId, characters, chatMetadata, writeExtensionField; characterId is a current array index, and group context differs. |
| Server merge and persistence | [characters.js L1266–1304](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1266-L1304), [L1328–1414](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1328-L1414) | Reads, merges, validates and writes the PNG; mergeCharacterUpdate does not inspect the PNG writer's success boolean before declaring ok. |
| PNG writer | [characters.js L211–264](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L211-L264) | Rewrites card metadata into PNG using an atomic file-write helper, returning a boolean. |
| Deep merge | [util.js L503–522](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/util.js#L503-L522) | Object keys recursively merge, arrays replace. Omitting a nested object key is not deletion. |
| Full vs shallow | [characters.js L365–425](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L365-L425), [script.js L7602–7632](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L7602-L7632) | Shallow card representations include only selected extension keys, not arbitrary Hub metadata; hydrate to full first. |
| Normal rename | [characters.js L1053–1099](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1053-L1099) | Rewrites card metadata with updated name and moves its chat directory; should preserve unrelated extension fields. |
| Duplication | [characters.js L1601–1644](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1601-L1644) | Copies original card PNG bytes to a distinct filename, including embedded IDs. |
| Export | [characters.js L1646–1680](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1646-L1680), [L495–502](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L495-L502) | Exports PNG/JSON, removes selected favorite/chat private fields but not arbitrary custom extension metadata. |
| Import | [characters.js L883–903, L968–990](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L883-L903) | V2 JSON/PNG imports preserve extension metadata; other formats and versions require their own tests. |
| Card parser | [character-card-parser.js L8–78](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/character-card-parser.js#L8-L78) | Writes **chara** and **ccv3** text chunks, reads ccv3 preferentially. H00-C checked both representations. |
| Editor save | [characters.js L1101–1139, L565–570](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1101-L1139) | Normal editor saves reconstruct from json_data and attempt to preserve foreign fields; stale editor-save interaction is not proven safe. |
| Startup isolation | [command-line.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js), [users.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/users.js) | Separate config/data paths supported; some startup migration routines may touch checkout public files. For H00-C a separate source/dependency snapshot was also created. |

Official background: [SillyTavern Writing Extensions guide](https://docs.sillytavern.app/for-contributors/writing-extensions/).

## Implications for implementation

An array of character records is a workable baseline because complete-array replacement makes removed entries disappear on the next save; the H00-C add/update/delete trial tested this. But **writeExtensionField is not a confirmed durable-success API**, and a client-side readback is not a transaction or a substitute for a cross-tab lock.

At H01 design time, explicitly specify:
- complete-card hydration, owner selection and revalidation on asynchronous operations;
- schema/type/size validation and refusal to overwrite unknown schema versions;
- error reporting with independent readback, no optimistic success;
- serialized in-process mutations, with cross-tab and editor-save race limitations documented;
- export privacy, asset portability, card rename/delete/orphans;
- chat-local NPCs and explicit, user-directed promotion.

**Not established by source review or H00-C testing:** Android/Termux runtime behavior; group-chat owner resolution; concurrent writers; lazy-load enabled live test; arbitrary imports/CharX, normal editor-save races, long-term storage limits, and reliable owner-card references across all lifecycle events.
