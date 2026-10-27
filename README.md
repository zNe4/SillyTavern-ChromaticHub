# SillyTavern-ChromaticHub

**ChromaticHub** is a planned identity service for SillyTavern roleplay extensions. A narrator, simulator, or ordinary character card may define multiple individually addressable characters, even when they share the same display name.

**Status (2026-10-26/27): research and architecture, not a released extension.** H00 source investigation and owner-native card-storage tests support a **card-scoped registry**. H01's schema, API and safe-write contract remain to be designed; no production code or Antigravity implementation assignment is authorized by these documents.

## Core idea

- **Card-persistent:** a reusable registry in Character Card V2/V3 extension metadata, proposed namespace **data.extensions.chromaticHub**.
- **Card-local identity:** a character's local ID is meaningful only together with its installed owning card; duplicated or imported cards may copy IDs yet remain independent.
- **Chat-local:** provisional NPCs and ChromaticDialogue speaker codes such as **c1** belong to the chat, not the reusable card identity registry.
- **Other extensions retain ownership:** ChromaticImages owns trusted image assets and generation permissions; ChromaticMessages will own message history and explicitly declared story continuation.
- **No global person database or name-based identity merging** in the initial scope.

## Documentation

- [ADR-001: Card-scoped character identity](docs/decisions/ADR-001-card-scoped-identity.md) — accepted direction and implementation constraints.
- [H00 source investigation](docs/research/H00-source-investigation.md) — pinned SillyTavern source findings; older global-registry exploration and why it was superseded.
- [H00-C native acceptance record](docs/acceptance/H00-C-card-registry-acceptance.md) — test sequence, exact fingerprints, evidence level and outstanding receipts.
- [Project status](docs/STATUS.md) — gates and the next H01 design mission.

## Workflow

**ChatGPT:** research, architecture, task specification, documentation, independent review. **Antigravity:** bounded implementation and implementation tests only after an approved mission. **Project owner:** native testing and authorization of repository commits, pushes, merges and releases.

The H00 tests used an isolated localhost SillyTavern instance with disposable cards and **no provider generation**. Do not use the research probe namespace in production.

## Next milestone

**H01-A — identity schema and API design**, including explicit installed-card ownership, full-card hydration, validation, safe writes, concurrency limitations, and chat-local promotion. See [STATUS](docs/STATUS.md).
