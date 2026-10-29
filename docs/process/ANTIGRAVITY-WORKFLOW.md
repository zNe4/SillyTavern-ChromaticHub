# Antigravity CLI workflow — ChromaticHub

**Status:** active coding-implementer workflow as of **2026-10-28**; guidance, not authorization for an implementation or native write.  
**Official sources:** [CLI best practices](https://antigravity.google/docs/cli/best-practices) · [Rules](https://antigravity.google/docs/rules/) · [Permissions](https://antigravity.google/docs/permissions/).  
**Authority:** repository [AGENTS.md](../../AGENTS.md) · current [STATUS.md](../STATUS.md).

## Small, focused setup

Root `AGENTS.md` holds stable constraints and is automatically loaded by Antigravity. This linked document explains the workflow; do not inline it as another always-on rule. The mission prompt identifies exact target files, pinned commit and deliverables. **ChatGPT**, not Antigravity, performs project research, documentation, architecture and independent review.

Do not add duplicate `GEMINI.md`, global rules, skills, subagents, parallel work, hooks, plugins, MCP servers or CI machinery merely to prepare a small mission. Propose them separately only if a measured need arises.

## G0–G5 authorization gates

| Gate | Coding agent's role | Stop/approval |
| --- | --- | --- |
| **G0 — Inspect** | Read root rules and mission-relevant contract/source/tests; verify repository, remote, branch, exact pinned HEAD, working-tree cleanliness and available test commands. | STOP if baseline is unproven, worktree dirty or unrelated changes appear. |
| **G1 — Plan** | Read-only explanation and small file-scoped implementation plan with tests, risks, exact paths and stop conditions. | ChatGPT/owner reviews **before** G2. No created plan artifact if the mission is strict read-only. |
| **G2 — Implement** | On a separately authorized task branch, implement only scoped code/tests; tests-first where practical. | No extra dependencies, manifests, browser integration, docs or unrelated paths. |
| **G3 — Verify** | Run focused tests while iterating, full suite before handoff, plus diff/whitespace/staged-scope checks; record exact receipts. | A test PASS is evidence, not self-acceptance. |
| **G4 — Review** | Give a bounded diff/commit and evidence. Push only the authorized review branch if explicitly permitted. | ChatGPT independent review; owner controls merge/publication. |
| **G5 — Native** | Only a distinct owner-authorized, isolated/disposable SillyTavern acceptance protocol. | No real-card writes, production data mutation or release without that explicit approval. |

**Read-only preflight (zsh):**

```zsh
pwd
git rev-parse --show-toplevel
git remote -v
git branch --show-current
git rev-parse HEAD
git status --short
```

Never interpret a mismatched checkout as permission to reset, overwrite, switch branches or substitute an older baseline. Confirm any fetch/fast-forward synchronization independently and require explicit authorization before mutation.

## Current verification loop

All accepted tests are dependency-free Node.js tests. Execute only commands appropriate for the target mission:

```zsh
node --test tests/identity-registry.test.mjs
node --test tests/sillytavern-adapter.test.mjs
node --test tests/card-mutation-controller.test.mjs
node --test tests/editor-safety.test.mjs
node --test tests/sillytavern-editor-safety-adapter.test.mjs
node --test
git diff --check
git status --short
git diff --stat
```

At integration `e3e489a4f2444b98e031021b5f0246372ac5e644`, the implementer reported **342/342 synthetic Node tests** passing; independent ChatGPT spot checks verified selected safety behavior. Those are **historical evidence**, not a new local test run. Rerun the actual checkout and report counts, exit codes, skips and untested conditions.

Focus on the relevant test file during implementation; run the complete suite before handoff. If a command is missing or fails, report it; never invent success or assume an `npm test` script exists.

## CLI prompting and session practices

- Use focused `@` references to source/test files, rather than a large dump of entire repository content. Separate inspection, plan and execution. Deliver concise G1 plans for ChatGPT approval before code changes.
- Use `/plan`, `/diff`, `/permissions`, `/fork` or `/rewind` only when useful and supported by the installed CLI version. `/rewind` is conversation control, **not** a substitute for inspecting Git state or for a Git rollback.
- Press `esc` to interrupt an incorrect direction early. Use screenshots or video only when there is a genuine visual UI issue, not for pure module tests.
- Avoid unnecessary extensive research loops, repeated full-suite runs on tiny edits or speculative edge-case expansion. ChatGPT triages **contract/safety blockers**, **ordinary defects** and **optional hardening** separately.
- Avoid background agents and `agy -p` until a narrow, reviewed use case warrants them. Never let a coding agent perform ChatGPT-owned research/documentation by delegation.

## Permissions and publication

The official guide describes `request-review` (review before writes/Bash/network), `strict` (all non-read operations require review), and `proceed-in-sandbox` with terminal sandbox containment. **Recommendation:** owner checks effective settings interactively using `/permissions`. Prefer `request-review` or `strict` until sandbox containment has been separately proven. Do not edit `~/.gemini/antigravity-cli/settings.json` within a coding mission, print credentials or bypass a denial.

The default is **STOP before staging/commit/push**. A mission may separately allow staging scoped files, a local commit, or a **normal, non-forced review-branch push**. Check `git diff --cached --check` and staged paths first. If push is denied, stop and give the commit SHA to the owner for manual publication; never alter permissions or retry with shell tricks.

No push to `main`, force-push, PR, tag, merge, release, production integration or native SillyTavern mutation without explicit owner approval. After G4 review, owner handles integration. Another mission is never automatically authorized.

## Current H01 boundary and next mission

- **Accepted:** H01-B0 pure registry; H01-B1 full-card read-only adapter; H01-B2-F1 synthetic mutation controller with bounded preliminary read; H01-B3-B synthetic evaluator and **unconditionally deny-only** runtime editor-safety adapter.
- **Next: H01-B3-C**, ChatGPT-owned source/editor lifecycle research and isolated fixture acceptance design. Do **not** ask Antigravity to perform that research or native acceptance. A separate exact-path implementation mission may follow after plan review.
- SillyTavern's pending/debounced saves and stale editor `#character_json_data` can overwrite independent card updates. The native system has no proven quiescence certificate or server CAS on `merge-attributes`. Until separately authorized, there are **no real-card writes**.

## Reusable coding-mission outline

A mission prompt should provide: ID and G-stage; explicit repository/branch/base SHA; allowed paths; contract and relevant `@` files; test/failure matrix; allowed Git operations; safety restrictions; requested handoff; and STOP condition. Do not reuse old H01-B0 startup prompts or treat past baseline test counts as current.
