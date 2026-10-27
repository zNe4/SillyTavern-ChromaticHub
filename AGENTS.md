# ChromaticHub — repository instructions for coding agents

These rules apply across this repository. **The Hub must remain small:** a reusable card-scoped character identity registry and a minimal identity API, not another RP framework.

## Roles and authority

- **Project owner** decides scope, runs native acceptance, and authorizes Git publication/merges/releases.
- **ChatGPT** owns research, architecture, documentation, task decomposition, independent code review and acceptance decisions.
- **Antigravity** is the **bounded implementer**: inspect task-relevant code, submit an implementation plan, write authorized code and tests, run verification, report evidence. Do **not** delegate project research or documentation to yourself or another agent.
- If architecture, requirements, security assumptions or mission scope are ambiguous, **STOP** and report the question; do not invent a design.

## Pre-edit gate: explore -> plan -> approval

1. Read this file and [agent workflow](docs/process/ANTIGRAVITY-WORKFLOW.md). Check the accepted [H01-A contract](docs/design/H01-A-identity-contract-v0.1.md) and current [STATUS](docs/STATUS.md).
2. Before editing, report repository root, Git remote, branch, full HEAD, clean/dirty worktree, test commands already available, and any unrelated changes.
3. Use a dedicated task branch from the **mission's explicitly pinned base commit**. Never reset, clean, discard, cherry-pick, merge or rewrite unrelated worktree changes without owner approval.
4. Submit a **plan first**, including exact allowed files, tests to add, risks and stop conditions. Do not implement before plan review/authorization.
5. Treat the mission's explicit changed-file list and scope restrictions as hard boundaries. New dependencies, build tooling, manifests, settings, production runtime patches, and cross-extension integration all require separate approval.

## Implementation and verification

- Add a focused failing test or acceptance case **before** the corresponding behavior where feasible. Prefer small dependency-free JavaScript modules and Node's built-in test runner.
- Once test files exist, run the specific \`node --test <path>\` commands named by the mission. **This documentation-only repository has no existing test suite yet**; don't claim \`npm test\` works until one is actually created.
- Re-run relevant tests on the final diff. Capture exact command, exit status, test totals and any skipped/unverified checks. Never report PASS without executed evidence.
- Preserve input immutability and data validity. Do not use display names as IDs. Do not mutate SillyTavern/card/chat data unless a mission **explicitly** authorizes it.
- Never write real SillyTavern user data, invoke image generation, contact providers, or perform network mutations just to verify pure-core changes.
- Before delivery: \`git diff --check\`, inspect \`git status --short\` and \`git diff --stat\`, confirm every changed path is in scope; explain anything untested.

## Stop and handoff

After implementation and verification, **STOP before staging, committing, pushing, PR creation, merging or release** unless the particular mission and owner explicitly authorize those actions.

**Optional branch-push review handoff:** An implementation mission may explicitly authorize Antigravity to **stage only allowed files, commit and push its verified result to a dedicated task branch** as the review artifact, instead of asking the owner to upload diff files. This permission is **per mission**, not blanket permission. Verify tests and exact changed paths before the commit; report the pushed full SHA, remote branch, commit link, comparison URL and test evidence. Never push to `main`, merge, tag, force-push, or open a PR without separate explicit authorization. Do not overwrite existing remote work; if a push is rejected, stop and report it. A branch push means **available for independent review, not accepted**.

For missions **without** explicit branch-push authorization, stop with a local diff/patch report. Either way, ChatGPT performs independent review, the owner authorizes integration and release, and no agent auto-advances to another mission.

## Architecture invariants

- Canonical reusable identities live under \`data.extensions.chromaticHub\` on **each card**. Internal UUIDs are **card-local**.
- Equal names and equal copied UUIDs do **not** prove two cards contain the same globally shared character.
- SillyTavern \`characterId\` is a transient array index; avatar filenames are mutable locators, **not permanent card IDs**.
- ChromaticDialogue \`cN\`, chat-local NPCs, ChromaticMessages timelines and ChromaticImages assets remain owned by their respective scopes. No autonomous promotion or global merge.
- Writes require exact owner resolution and verifiable readback; the existing SillyTavern merge API does **not** supply cross-tab compare-and-swap. Never claim transaction safety.
- Unknown schema, ambiguous identity or uncertain writes must **fail closed** rather than reset/guess/retry.
- Keep secrets, prompts, private conversations and reference-image bytes out of ordinary logs, exported registry objects and test fixtures.

## Local working environment

The owner uses **Arch Linux** and **zsh**. Shell snippets must be compatible with that environment. Never assume user-specific absolute paths; respect the checked-out workspace.

See [workflow](docs/process/ANTIGRAVITY-WORKFLOW.md) for prompts, permissions, task checkpoints and recovery practices.
