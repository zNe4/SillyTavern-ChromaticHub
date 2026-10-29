# ChromaticHub — project status

**Research-branch update (2026-10-29; not merged into main):** H01-B3-C-B1 owner-native test **reproduced `REGISTRY_LOST`** after a normal stale-editor autosave, with matching final PNG/API fingerprints and all five changed metadata field paths accounted for. The owner endorsed moving ChromaticHub's authoritative store into **per-user, per-installed-card directories** managed by an explicitly enabled companion SillyTavern server plugin. [H01-B3-D1 lifecycle research](research/H01-B3-D1-native-lifecycle-binding.md) is source-reviewed; [ADR-002 external persistence](decisions/ADR-002-external-card-scoped-persistence.md) is **PROPOSED for owner review**, *not accepted*. No native plugin installation, production data mutation, old adapter activation, or Antigravity implementation mission is authorized. Main remains unchanged by these research commits.

**As of 2026-10-28.** Last accepted code milestone (H01-B3-B) integrated at `e3e489a4f2444b98e031021b5f0246372ac5e644` on `main`. **H01-B3-B accepted for synthetic testing only. No native card-write activation is authorized.**

## Accepted milestones

| Milestone | Accepted outcome | Limitations |
| --- | --- | --- |
| **H00** | Owner-reported P0–P3-D and post-restart P4 browser acceptance of card-scoped metadata through character operations, rename, copy, import/export and restart | Historical offline PNG/storage receipts and original checkout-state evidence remain incomplete |
| **ADR-001 / H01-A** | Card-local identity/UUID design and scoped ownership contract | Native-write and durable-locator issues remain open |
| **H01-B0** | `src/identity-registry.mjs` pure versioned registry parser, resolution, mutation and serialization | No SillyTavern network access |
| **H01-B1** | `src/sillytavern-adapter.mjs` full-card read-only adapter | No persistent writes |
| **H01-B2 / H01-B2-F1** | `src/card-mutation-controller.mjs` guarded synthetic mutation controller with per-card queue, independent readback and bounded/cancellable preliminary read | No native editor-save certificate or server CAS; **synthetic-only** |
| **H01-B3-B** | Pure `src/editor-safety.mjs` and a strictly deny-only `src/sillytavern-editor-safety-adapter.mjs`, with synthetic controller-composition tests | No runtime safe:true mechanism or DOM instrumentation; **native card writes remain impossible through this adapter** |

**Integration evidence:** `main` was independently verified on GitHub at `e3e489a4f2444b98e031021b5f0246372ac5e644` after owner fast-forward merge. The H01-B3-B R4 implementation reported **342/342 Node synthetic tests passing**; ChatGPT separately reviewed the exact four-file branch scope, performed adversarial JavaScript spot checks, and approved integration. These are not a fresh native full-suite run.

## Active workflow and responsibilities

- **ChatGPT:** project research, architecture, documentation, milestone management, independent code review and acceptance decisions.
- **Antigravity CLI:** active coding implementer for explicitly scoped code/tests and verification. The OpenCode/GLM 5.3 trial is closed for new missions due to weekly token cost.
- **Owner:** grants permissions, performs native acceptance and authorizes Git publication/integration/releases.
- Active rules: [`AGENTS.md`](../AGENTS.md) · [Antigravity workflow](process/ANTIGRAVITY-WORKFLOW.md). [OpenCode trial guidance](process/OPENCODE-WORKFLOW.md) is retained as historical evidence.
- Keep G0 inspection → G1 plan → G2 implementation → G3 verification → G4 independent review → G5 owner-native acceptance. No automatic gate advancement.

## Next milestone: H01-B3-C — research and isolated native preparation

**Research and acceptance-protocol ownership: ChatGPT. Implementation/native testing are NOT yet authorized.**

1. Analyze actual SillyTavern character-editor save lifecycle: `saveCharacterDebounced`, unsaved form state, pending/in-flight saves, and stale hidden `#character_json_data`. Editor-closed or DOM-only checks cannot prove save quiescence.
2. Establish whether an instrumentation-free, **provably conservative** editor-safe window exists. If not, explicitly retain a deny-only runtime and assess options requiring separate integration approval.
3. Account for `getOneCharacter()` refreshing the JS card cache without synchronizing the hidden editor field; an ordinary `/edit` save can overwrite independently modified registry data.
4. Note that native `/edit` and `/merge-attributes` routes may return HTTP success without proving the backing PNG write succeeded. Readback remains mandatory.
5. Design owner-supervised disposable fixtures: isolated SillyTavern data root, separate server port/browser profile, explicit backups, rollback and read-only preflight. Prove the actual target version/environment before enabling any mutation.
6. Specify stop criteria for cross-tab writers, unknown post-dispatch outcomes, avatar locator changes, cleanup/recovery and per-card quarantine. The merge endpoint offers no server-side compare-and-swap.

Only after the research/plan is independently reviewed may a separately scoped Antigravity coding mission be authorized. **No user-card writes, group writes, H01-C chat writes, real integration, or native mutation acceptance are approved.**

## Evidence debt / independent boundaries

- H00 P4 offline PNG/storage validation and historic checkout-status receipts remain missing; original browser P4 acceptance is separate evidence.
- Android/Termux, actual native editor races, concurrent tabs, group writes and rename safety are unproven.
- Card UUIDs are local to each installed card. Avatar filenames can change; SillyTavern `characterId` values are ephemeral indexes. ChromaticDialogue, ChromaticImages and ChromaticMessages retain separate ownership.
- Do not infer atomicity from local queues. No silent identity merge based on names, no automatic retry of uncertain writes, and no production activation.

References: [ADR-001](decisions/ADR-001-card-scoped-identity.md) · [H00 research](research/H00-source-investigation.md) · [H00 acceptance](acceptance/H00-C-card-registry-acceptance.md) · [H01-A identity contract](design/H01-A-identity-contract-v0.1.md).
