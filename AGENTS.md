# ChromaticHub — repository instructions for coding agents

These rules apply across this repository, regardless of which coding agent or model is used. **ChromaticHub must remain small:** a reusable card-scoped character identity registry and minimal identity API, not a second roleplaying framework.

## Roles and authority

- **Project owner:** decides scope, grants permissions, runs native acceptance, and authorizes Git integration and releases.
- **ChatGPT:** owns project research, architecture, documentation, task decomposition, independent code review, and acceptance decisions.
- **Coding implementer:** currently **OpenCode with GLM 5.3** on a controlled trial; earlier missions used Antigravity. Its responsibility is bounded repository inspection, implementation planning, explicitly authorized code and tests, verification, and evidence-based handoff. The agent must **not** take over project research or documentation, delegate those responsibilities to another agent, or approve its own implementation.
- If requirements, security assumptions, architecture, Git state, or scope are unclear, **STOP** and report the issue. Do not silently choose a new design.

## Pre-edit gate: inspect → plan → independent approval

1. Read this file, [the current OpenCode workflow](docs/process/OPENCODE-WORKFLOW.md), [the H01-A identity contract](docs/design/H01-A-identity-contract-v0.1.md), and [project status](docs/STATUS.md). Antigravity-specific guidance is retained separately for older missions.
2. Before any edit, report repository root, remote, branch, full HEAD, dirty/clean status, existing test commands, and unrelated changes.
3. Use a dedicated task branch from the mission's **explicitly pinned base commit**, and only once that mission authorizes branch creation. Do not reset, clean, stash, discard, cherry-pick, merge, rebase, or overwrite unrelated work without owner authorization.
4. Produce an implementation plan with exact allowed paths, tests, risk analysis, and stop conditions. **Do not implement until ChatGPT/owner review explicitly authorizes G2.** A strictly read-only mission must not create tool-generated plan files either.
5. File scope is binding. New dependencies, package manifests, build tooling, global settings, production patches, and cross-extension integration all require separate approval.

## Implementation and verification

- Add focused failing tests before implementing behavior where practical. Prefer dependency-free ES modules and Node's built-in `node:test` runner.
- Existing tests are available:
  - `node --test tests/identity-registry.test.mjs`
  - `node --test tests/sillytavern-adapter.test.mjs`
  - `node --test tests/card-mutation-controller.test.mjs`
  - `node --test`
  Baseline H01-B0/B1/B2 reported **201 passing synthetic tests** on 2026-10-28; re-execute tests on the actual target commit, never present historic results as a new run.
- Capture exact commands, exit codes, total/pass/fail/skip counts, and limitations. Never claim success without executed evidence. The coding agent's results remain subject to independent ChatGPT review.
- Preserve caller-owned inputs and validated registry shape. No name-derived identity, implicit merge, broad card updates, or autonomous NPC promotion.
- **H01-B2 is accepted as a synthetic-only controller, not approved for native writes.** No requests that mutate a real running SillyTavern installation or user card until the owner separately authorizes an isolated acceptance mission.
- Do not generate images, call paid providers, install dependencies, handle personal secrets, or invoke external services merely to test the pure core.
- Before handoff: `git diff --check`, `git status --short`, `git diff --stat`; inspect all scoped changes and relevant staged diffs. Report untested conditions.

## Publication and stop rules

- **Default: STOP** before staging, committing, pushing, opening a PR, merging, or releasing. Each action requires explicit mission-specific approval.
- An implementation assignment may separately authorize **staging only allowed files**, committing, and pushing a **dedicated review branch**. This is a handoff, **not** acceptance. No push to `main`, force push, tag, PR, merge, or release without new authorization. If a push is rejected, stop; never force or silently rebase.
- Before an authorized branch push, verify the exact staged paths, run `git diff --cached --check`, and ensure the commit contains only intended changes. Report branch, pinned base, full HEAD SHA, commit/compare URL, test receipts, and worktree status.
- After independent ChatGPT review, **the owner** authorizes final integration and any native test. Never automatically begin the next mission.

## Architecture invariants

- Authoritative reusable identities live under `data.extensions.chromaticHub` **on each installed card**. UUIDs are card-local; equal names or copied UUIDs do not prove global identity.
- SillyTavern's `characterId` is an ephemeral array index; avatar filenames are mutable locators, not globally permanent IDs.
- ChromaticDialogue `cN`, chat-local NPCs, ChromaticMessages timelines, and ChromaticImages assets retain independent ownership. Do not silently promote, infer, or merge them.
- All writes require explicit authorization, exact owner resolution, safe editor/context checks, and independent persistence readback. SillyTavern provides **no server-side compare-and-swap** on the current merge route. In-process queues do not guarantee cross-tab atomicity.
- Unknown schema, ambiguous identity, conflicting state, and uncertain writes must fail closed. Unknown post-dispatch completion means **no automatic retry** and an appropriate per-card quarantine.
- Keep credentials, private character/card contents, prompts, private conversations, and image bytes out of routine logs, review artifacts, and synthetic fixtures.

## Local environment and tool-specific rules

The owner runs **Arch Linux**, **zsh**, and **Kitty**. Use shell commands appropriate to that environment and respect the actual checked-out root; never assume another user's absolute path.

For the current trial, see [OpenCode workflow](docs/process/OPENCODE-WORKFLOW.md). The historical [Antigravity workflow](docs/process/ANTIGRAVITY-WORKFLOW.md) applies only when an Antigravity mission explicitly selects it.

OpenCode's Plan/Build modes and tool permissions **do not override** the explicit G0–G5 authorization gates. Do not read or modify the owner's provider credentials or OpenCode global settings as part of an implementation mission.
