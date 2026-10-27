# ChromaticHub — Project status

**As of 2026-10-26/27.** Research-stage repository. **No production extension implementation.**

## H00 evidence accepted

- **H00-A:** identity-model research completed; global registry option superseded by card-first choice.
- **H00-B:** pinned SillyTavern source confirmed native namespaced card metadata.
- **H00-C:** owner reported **P0–P3-D PASS** and **P4 post-restart browser PASS**; multiple same-name identities, cross-chat persistence, server restart, rename, duplication with independent edits, PNG and JSON export/import, and add/update/delete.
- **ADR-001:** per-card storage accepted as the H01 architecture basis, not as finished extension software.

## H01-A — design draft / awaiting owner and independent review

- [Identity contract v0.1](design/H01-A-identity-contract-v0.1.md) — schema, scoped references, read/write semantics, error taxonomy, chat-local proposal, explicit limits.
- [Test and bounded-mission plan](design/H01-A-acceptance-and-missions.md) — adversarial cases, owner signoff checklist and H01-B0/B1/B2/B3/C/D breakdown.
- **H01-A is not frozen/approved solely by publication of its draft.** Critical uncertainties include dirty editor synchronization, lack of server-side CAS, rename missed-events and chat metadata durability.
- **NEXT:** independent review and owner decision on H01-A D1–D8; only then authorize H01-B0 pure contract tests.

## Remaining H00 evidence receipts

- **P4 offline PNG/storage verification and original-source-status receipt not supplied**; the successful browser P4 post-restart result is distinct.
- Separate P2-C offline parser output likewise not supplied; restart API readback passed.

## Roles and boundaries

**ChatGPT** research, architecture, reviews and documentation. **Antigravity** bounded coding/testing only after approved assignment. **Owner** native testing and commit/merge/release authorization.

Do not create global person IDs, silently merge duplicate names/cards, move cN IDs into card metadata, persist autonomous NPCs, or generate images on registry reads.

References: [ADR-001](decisions/ADR-001-card-scoped-identity.md) · [H00 source](research/H00-source-investigation.md) · [H00 acceptance](acceptance/H00-C-card-registry-acceptance.md).
