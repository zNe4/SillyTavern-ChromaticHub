# H00-C — Owner-native card-registry acceptance record

**Status:** **Runtime acceptance for card-storage feasibility: PASS (owner-reported).** Formal offline P4 receipt: **not supplied**.  
**Date:** 2026-10-26/27, local Arch Linux / Firefox.  
**Evidence level:** Test scripts ran under the owner's control; the structured stdout/console outputs were supplied in the project conversation and reviewed by ChatGPT. ChatGPT did not independently execute the owner's local server.  
**Scope:** Disposal-only character-card persistence and portability, not a general ChromaticHub implementation acceptance.

## Environment and isolation

- SillyTavern source-research reference: **06bde939fb1e9c4c8d8641d810f0a916b5bce127**.
- Local executable staging checkout HEAD **4ceca42ba2bef15f7c0f9f1040368260c8588b92**, branch **m03-d2b1-nanogpt-proxy**; Node **v24.22.1**.
- P0 read-only preflight reported modified package.json/package-lock.json (development-only eslint-plugin-playwright bump); those modifications were preserved, not reset.
- Independent Git-archive application snapshot plus dependency copy and symlink containment. Disposable root **/tmp/ChromaticHub-H00C-P1.QZJQAzk5**.
- HTTP service **127.0.0.1:18180** returned **200**. Effective config and data paths were under the disposable root. No model generation/provider calls.
- Test metadata was written under **data.extensions.chromaticHubH00CProbe**, not the intended production field.

## Gate-by-gate observations

| Gate | Owner result | What it establishes |
| --- | --- | --- |
| P0 | PASS | Staging identity/Node, native field APIs and unused test port verified |
| P1A | PASS | Independent disposable source/dependency snapshot; symlink containment PASS; server not yet started |
| P1B | PASS | Localhost listener, HTTP 200, isolated config and data directories |
| P2-A | PASS | Two distinct UUID IDs with equal name **Hina** stored in one card and independently reread via API |
| P2-B | PASS × 3 | Initial chat → new chat → original chat, with unchanged registry SHA-256 |
| P2-C | Post-restart API PASS | Registry fingerprint unchanged after full server restart; **separate P2-C offline script output not provided** |
| P3-A | PASS | Rename preserved registry, removed old avatar filename (404 expected) |
| P3-B2 | PASS | PNG duplication copied registry and IDs byte-equivalently at registry-JSON level |
| P3-B3 | PASS | Editing only the duplicate changed its registry, leaving original intact |
| P3-C1 | PASS | Native JSON export registry matched source; PNG response was a valid image |
| P3-C2 | OFFLINE PASS | Exported JSON, PNG chara and PNG ccv3 all contained matching registry and IDs; file hashes recorded |
| P3-C3 | PASS | JSON imported into a new installed card, without changing either source card |
| P3-C4 | PASS | PNG imported into a fourth installed card, leaving prior three unchanged |
| P3-D | PASS | Add, update, delete temporary third identity; readback at each step; final baseline restored; other cards unchanged |
| P4 | **Post-restart browser PASS** | All four registries still matched their expected fingerprints, deleted entry absent, copied IDs preserved. **P4 offline read output not provided** |

## Named disposable cards and fingerprints

| Installed card avatar filename | Expected identity count | SHA-256 of JSON.stringify(registry) |
| --- | --- | --- |
| CHH00C_Disposable_Registry_Renamed.png | 2 | **fb10320d6e410e6a1274508e027599fc48532643eb736caa763f1904a167c3c1** |
| CHH00C_Disposable_Registry_Renamed_1.png | 2 | **55a3be8bd03a21f47ad08ac779e0b69583897d23fd1ac6735b6243c803eb235b** |
| CHH00C_Disposable_Registry_Renamed1.png (JSON import) | 2 | **55a3be8bd03a21f47ad08ac779e0b69583897d23fd1ac6735b6243c803eb235b** |
| CHH00C_Disposable_Registry_Renamed2.png (PNG import) | 2 | **55a3be8bd03a21f47ad08ac779e0b69583897d23fd1ac6735b6243c803eb235b** |

The original contained **Knight** and **Merchant** descriptors; the three copies descended from a modified duplicate with **Merchant (Duplicate Test)**. Copied cards initially shared local IDs, then their persistence diverged.

**Exported files (offline P3-C2):**
- JSON file SHA-256: **9de5973e336e3032f2decc1399415b7decc837b65ae61108303443dfe11599d6**
- PNG file SHA-256: **9ed3b56d1183fa66c1efd16eee5fab23eb9da792fae3c78f5ec54e69ab45d7df**
- P3-C2 result: **JSON_REGISTRY=PASS**, **PNG_CHARA_REGISTRY=PASS**, **PNG_CCV3_REGISTRY=PASS**, **IDENTITIES_MATCH_BETWEEN_FORMATS=YES**, **FILES_MODIFIED=NO**.

**P3-D result:** **H00C_P3D_ADD=PASS**, **H00C_P3D_UPDATE=PASS**, **H00C_P3D_DELETE=PASS**; final baseline **55a3be8b...**, two entries, no temporary identity, other three cards unchanged.

**P4 post-restart result:** **H00C_P4_POSTRESTART PASS**, verifiedCardCount **4**, temporaryIdentityAbsent **true**, originalCardUnchanged **true**, copiedIdentityIdsPreserved **true**, with fingerprintMatches true on each named card.

## Acceptance interpretation and limits

**Accept:** card-embedded, chat-independent, portable, independently editable identity definitions using native SillyTavern mechanisms. The exact tested source snapshot and script outputs demonstrate this behavior in the owner's environment.

**Not claimed:** independently reproduced disk verification after P4 shutdown; native concurrency atomicity; correct failure injection/reporting; ordinary editor-save race handling; lazy-loading enabled; group-chat identity ownership; Android/Termux native behavior; large registry limits; portability of external trusted-image binaries.

**Evidence still requested for formal complete H00-C archival:** raw sanitized P4 offline script output (**P4_OFFLINE=PASS**, **P4A_DISK_GATE=PASS**, original checkout status receipt). Do not infer this output from P4 browser PASS. The separate P2-C offline receipt was also not provided.

## Next gate

H01-A: design the production schema, scoped ID/address representation, full-card resolution, safe mutation contract and chat identity promotion rules. Antigravity must not begin implementation until the reviewed contract and bounded coding assignment are explicitly authorized.
