# ChromaticHub — project status

**As of 2026-10-28.** Core and read-only adapter accepted; guarded mutation controller accepted **for synthetic testing only**. **No real-card write integration or native mutation acceptance has been authorized.**

## Accepted milestones

| Milestone | Accepted outcome | Current limitation |
| --- | --- | --- |
| **H00** | Owner-reported P0–P3-D and post-restart P4 browser acceptance: card-scoped metadata persists through relevant character operations, rename, duplication, export/import and restart | Historical offline PNG/storage and checkout-status receipts remain outstanding |
| **ADR-001 / H01-A** | Card-local identity design and scoped UUID semantics underpin the approved implementation | The original contract is labeled a proposed design; native-write and durable-locator questions remain open |
| **H01-B0** | `src/identity-registry.mjs` accepted pure parser/resolver/mutation/serialization core | Pure code; no SillyTavern writes |
| **H01-B1** | `src/sillytavern-adapter.mjs` accepted full-card, read-only adapter | No persistent mutation APIs |
| **H01-B2** | `src/card-mutation-controller.mjs` accepted guarded add/update/remove implementation after R1/R2/R3 review | Synthetic-only; lacks native editor-state safety certification |
| **OpenCode G0** | OpenCode / GLM 5.3 reported read-only verification of exact main, clean worktree and 201/201 passing native Node tests | Not yet evaluated as coding implementer; one controlled planning/implementation mission is next |

**Main integration checkpoint:** `b97b55064021f74de324eaaa9f4c27ddb3c6013e` (H01-B2-R3), verified on GitHub on 2026-10-28. Later commits require a fresh baseline check.

**G0 test breakdown (owner-provided OpenCode report):** 60 identity-core + 58 read-adapter + 83 mutation-controller = **201 passed**, 0 failed or skipped; separate commands and combined suite reported exit status 0. This does not constitute independent observation of the local Node execution or native SillyTavern verification.

## Current workflow

- **ChatGPT:** research, architecture, documentation, task decomposition and independent acceptance/review.
- **Coding agent:** trialing **OpenCode with GLM 5.3**, previously Antigravity. Restricted to approved code/tests and evidence-based handoff.
- **Project owner:** permissions, native acceptance, Git publication/merge/release.
- Read [AGENTS.md](../AGENTS.md) and [OpenCode workflow](process/OPENCODE-WORKFLOW.md); [historical Antigravity workflow](process/ANTIGRAVITY-WORKFLOW.md) is retained for reference.
- Preserve independent **G0 inspect → G1 plan → G2 implement → G3 verify → G4 review → G5 owner-native** gates. A task branch push is not integration approval.

## Next milestone: H01-B3 preparation — not yet native execution

**ChatGPT-owned research and acceptance planning**, followed by independent review. Priorities:

1. Prove or conservatively deny writes while the SillyTavern character editor is open, dirty, or has pending/debounced saves.
2. Determine safe synchronization/reload of stale in-memory `characters`/`json_data` and how a later editor save can overwrite updated card data.
3. Add/verify bounded pre-read behavior to prevent a reader that ignores abort from indefinitely holding a per-card controller queue.
4. Design disposable character/card fixtures, isolation and rollback evidence for owner-native testing. Do not touch real cards.
5. Account for no server CAS, cross-tab writers, rename/missed-locator events, ambiguous POST outcomes, ephemeral quarantine and separately authorized recovery.

**No production release, card-write activation, or H01-C chat-metadata mutation is authorized.**

## Evidence debt and boundaries

- H00 P4 offline PNG/storage validation and original checkout-status receipts were not supplied; the browser P4 result is a separate accepted observation. The separate P2-C offline parser receipt likewise remains unavailable.
- Android/Termux, actual native editor races, group mutations and multiple-tab serialization are not proven.
- Card UUIDs are **card-local**; avatar filenames are mutable locators, and SillyTavern `characterId` is ephemeral. ChromaticDialogue `cN`, ChromaticImages assets and ChromaticMessages timelines remain independently scoped.
- The merged card-update route does not offer atomic compare-and-swap. Do not claim cross-tab transaction safety, never auto-retry an uncertain write, and never silently merge identities based on name.

References: [ADR-001](decisions/ADR-001-card-scoped-identity.md) · [H00 research](research/H00-source-investigation.md) · [H00 acceptance](acceptance/H00-C-card-registry-acceptance.md) · [H01-A identity contract](design/H01-A-identity-contract-v0.1.md).
