# ChromaticHub — Project status

**As of 2026-10-26/27.** Research-stage repository. **No production extension implementation.**

## Completed / accepted evidence

- **H00-A — ecosystem and options investigation:** complete; the initial global-registry preference was later **superseded** by owner choice of card-first storage.
- **H00-B — per-card source feasibility:** complete. SillyTavern stores namespaced JSON in card metadata.
- **H00-C — owner-native card-storage behavior:** **P0–P3-D reported PASS**, plus **P4 post-restart browser PASS**. Two same-name identities, chat switching, restart, rename, duplication, independent edits, JSON/PNG export-import, add-update-delete all demonstrated in a disposable local instance.
- **ADR-001:** card-scoped registry **accepted for H01 design**, not a finalized API.

## Evidence not yet supplied

- **P4 offline PNG/storage verification and original-source-status receipt** from the final stop/restart script (do not conflate with successful P4 browser output).
- Separate P2-C offline script output (post-restart browser readback did pass).

These do not negate the supported storage-feasibility result; they remain open evidence-accounting items.

## H01-A — next research/design mission (ChatGPT-owned)

1. Draft and independently review a versioned card registry schema with immutable card-local IDs.
2. Define **owner-card addressing** and lifecycle behavior (rename, duplicate, import, deletion, group chats, chat switching).
3. Specify full-card hydration and readback-based writes, error statuses, validation, unsupported-schema behavior, and cross-tab/editor race limitations.
4. Define temporary chat-only characters and **explicit user promotion** to a card; plan backward-compatible ChromaticDialogue bindings without replacing cN.
5. Define security/privacy boundaries for exported aliases and non-portable image assets.
6. Set minimal acceptance tests and break H01 implementation into bounded missions. **No Antigravity research delegation.**

**Deferred:** cross-card identity linking, ChromaticMessages continuation mechanics, ChromaticImages protocol migrations, Android acceptance, multi-tab transaction claims, automatic AI decisions.

## Ownership and publication

ChatGPT: research / architecture / reviews / documentation. Antigravity: coding only under approved bounded missions. Owner: controls native testing and authorizes publication. Documentation commits do not authorize future code commits or releases.

See [ADR-001](decisions/ADR-001-card-scoped-identity.md), [research](research/H00-source-investigation.md), and [acceptance evidence](acceptance/H00-C-card-registry-acceptance.md).
