# ChromaticHub — repository instructions for coding agents

These rules apply regardless of agent. **ChromaticHub remains a small card-scoped character identity registry and minimal identity API, not a second roleplaying framework.**

## Roles and decision authority

- **Project owner:** grants permissions, authorizes scope, performs native acceptance, and approves Git integration/releases.
- **ChatGPT:** owns research, architecture, documentation, mission decomposition, independent code review, and acceptance decisions.
- **Active coding implementer: Antigravity CLI.** Its job is bounded repository inspection, planning, implementation of explicitly approved code/tests, verification, and evidence-based handoff. OpenCode/GLM 5.3 was a historical trial; its workflow is not active.
- Never delegate ChatGPT-owned research or documentation to the coding agent. If an architectural, security, scope, or Git-state ambiguity arises, **STOP** rather than inventing a design.

## Before any implementation

1. Read this file, [the active Antigravity workflow](docs/process/ANTIGRAVITY-WORKFLOW.md), [H01-A identity contract](docs/design/H01-A-identity-contract-v0.1.md), [project status](docs/STATUS.md), and mission-relevant source/tests. Keep the root rules concise; do not automatically inline entire manuals.
2. Report repository root, remote, branch, full HEAD, `git status --short`, relevant existing tests and unrelated changes. Compare against the mission's **explicit pinned baseline**.
3. **G0 inspect → G1 plan → G2 implement → G3 verify → G4 independent review → G5 owner-native acceptance.** G1 is read-only unless the mission specifically allows generated artifacts. Do not edit, stage, commit, or branch until authorized.
4. After G1 approval, use only an approved dedicated task branch, exact permitted paths, and specified tests/stop conditions. Do not silently reset, clean, stash, discard, cherry-pick, merge, rebase, force-push, or resolve baseline mismatches.
5. Dependencies, manifests, build tooling, permissions, global settings, production patches and cross-extension integrations require separate authorization.

## Implementation and evidence

- Prefer small dependency-free ES modules and Node's built-in `node:test`. Add focused failing tests before code when practical.
- Current test entry points:
  - `node --test tests/identity-registry.test.mjs`
  - `node --test tests/sillytavern-adapter.test.mjs`
  - `node --test tests/card-mutation-controller.test.mjs`
  - `node --test tests/editor-safety.test.mjs`
  - `node --test tests/sillytavern-editor-safety-adapter.test.mjs`
  - `node --test`
- The last accepted H01-B3-B integration reported **342 passing synthetic tests** at main `e3e489a4f2444b98e031021b5f0246372ac5e644` (2026-10-28). This is historical reported local evidence, **not** a substitute for rerunning tests on the current checkout.
- Record exact commands, exit codes, test totals/pass/fail/skip, changed paths, test limitations and whether any network mutation occurred. Run `git diff --check`, inspect the diff and `git status --short`; if staging is authorized, also run `git diff --cached --check` and inspect staged paths.
- Never claim native acceptance based on synthetic tests. Do not use personal card contents, credentials, paid providers, external services or real images as routine fixtures. Never approve your own implementation.
- Prioritize actual contract/safety blockers during review. Distinguish them from ordinary correctness issues and optional hardening instead of expanding the mission implicitly.

## Publication and stop boundaries

- **Default STOP** before Git staging, commit, push, PR, merge, tag or release unless expressly included in the mission.
- If authorized, commit only scoped files to a dedicated review branch; push only if explicitly authorized and permitted. If a push is denied, **stop**; the owner may publish manually. No force-push or permission bypass.
- A review-branch publication is **not** integration approval. ChatGPT independently reviews; the owner approves final merge, release and native actions. Never auto-advance to another mission.

## Architecture and safety invariants

- **ADR-002 (research branch; accepted V1 direction):** reusable identity authority moves to private per-user `chromaticHub/cards/<installedCardId>/state.json` files via a companion server plugin. `data.extensions.chromaticHub` remains **legacy PNG metadata**, never an automatic fallback or second authority. Current implemented modules still target the legacy path and MUST NOT be activated; pure card-local UUID rules remain valid. Identical names/copied UUIDs never establish shared identity.
- SillyTavern's `characterId` is an ephemeral array index; avatar filenames are mutable locators, not permanent global IDs.
- ChromaticDialogue `cN`, chat-local NPCs, ChromaticMessages timelines and ChromaticImages assets retain their own ownership. No implicit promotion, name-based inference or identity merge.
- H01-B2-F1's mutation controller and H01-B3-B's editor-safety evaluator/adapter are **accepted for synthetic testing only**. The runtime editor-safety adapter is deliberately **deny-only**. No real-card mutation or production activation is authorized.
- Future **sidecar** writes require explicit owner approval, authenticated user-scoped plugin persistence, exact owner/locator checks under the documented pragmatic Option A trust model, **server-side serialized record-revision CAS**, atomic file replacement and independent persisted readback. The old SillyTavern PNG merge route has no CAS and is forbidden as registry authority; the B1 native test proved stale editor autosave erases that metadata.
- Unknown schemas, stale/ambiguous identities, uncertain writes and unobservable editor-save activity must fail closed. No automatic retry after ambiguous POST completion; quarantine unresolved card outcomes.
- Do not log, publish or include credentials, private character contents, chats, prompts or image bytes in review artifacts.

## Environment and CLI

Owner environment: **Arch Linux, zsh, Kitty**. Use the actual repository root rather than assuming a user-specific path.

Antigravity automatically reads root `AGENTS.md`. The detailed workflow is linked above. Favor exact `@` file references, focused test loops and early interruption (`esc`) when needed. Local permission presets (`request-review` or stricter) are the owner's decision; never inspect, expose or modify global credential/settings files without express authorization. CLI permissions do not supersede mission gates.
