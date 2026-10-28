# OpenCode workflow — ChromaticHub

**Status:** controlled OpenCode / GLM 5.3 trial adopted after G0 verification on **2026-10-28**. This document describes the tool workflow, **not permission** to begin a new implementation or write actual SillyTavern card data.

**References:** [repository rules](../../AGENTS.md) · [project status](../STATUS.md) · [OpenCode V2 agents](https://opencode.ai/v2/docs/agents) · [OpenCode V2 permissions](https://opencode.ai/v2/docs/permissions). For historical Antigravity missions, see [Antigravity workflow](ANTIGRAVITY-WORKFLOW.md).

## Responsibility and scope

ChatGPT is the architect, researcher, documentation owner, task manager, and independent reviewer. OpenCode/GLM 5.3 is a **bounded coding implementer**: inspect, propose a scoped plan, implement *only after approval*, run tests, and hand off evidence. The project owner retains integration/release decisions and runs separately authorized native acceptance.

Do not delegate research, requirements interpretation, documentation, or final review to OpenCode. A self-produced agent review is not a substitute for independent ChatGPT acceptance. Do not auto-advance after a successful test or branch push.

## G0–G5 mission gates

| Gate | OpenCode action | Required review/permission |
| --- | --- | --- |
| **G0 — Read-only verification** | Inspect `AGENTS.md`, relevant contract/source, Git remote/branch/full HEAD/status, and available tests. Execute only explicitly allowed read-only/test commands. | Report exact commands and results. No file changes, including generated plan documents, for a strict read-only mission. |
| **G1 — Plan** | Propose exact files, tests-first steps, success/failure cases, dependency constraints, and stop conditions. | ChatGPT reviews the plan; owner approves scope. **No implementation.** |
| **G2 — Implement** | After explicit approval, create/use the authorized task branch and make only the allowed code/test changes. | Do not modify docs, global configuration, or extra files unless the mission lists them. |
| **G3 — Verify** | Run targeted tests and full suite where authorized; inspect diff and changed paths; report pass/fail/skip and limitations. | Passing tests are evidence, not self-approval. |
| **G4 — Review handoff** | If explicitly authorized, stage only approved paths, commit, and push **only** the specified review branch; otherwise provide a local diff. | ChatGPT independently reviews; owner decides whether/when to integrate. |
| **G5 — Native acceptance** | Execute only the separately authorized, owner-supervised, disposable/isolated SillyTavern acceptance protocol. | Real user cards and production data remain out of scope. |

## OpenCode agents and permissions

- Use **Plan** for G0/G1 inspection and proposals. **Plan is not guaranteed zero-write**: OpenCode may allow agent plan artifacts outside the repository. A strict no-mutation mission explicitly prohibits *all* generated plan files.
- Use **Build** for G2/G3 only after mission authorization. Its ability to edit or execute is not itself permission to do so.
- Do not introduce custom agents, parallel subagents, MCP servers, plugins, or agent-generated documentation by default. Add them only after ChatGPT and owner review a concrete need.
- **Check the installed OpenCode version.** OpenCode V2 uses an ordered `permissions` array with `action`, `resource`, and `effect`; V1 documentation refers to different config names (`permission`, `bash`). Do not mix their syntax.
- Keep user-level OpenCode configuration and provider secrets private and outside the repository. Ask before edits and external-directory access. The `shell` tool runs with the invoking user's authority; permission patterns are **not** filesystem sandboxing.
- A coding agent must never change its own permissions, turn off safety gates, or use a shell workaround to bypass an explicit deny.

## Local environment and session procedure

The owner uses **Arch Linux**, **zsh**, **Kitty**, and a local `opencode-secure` wrapper to launch the CLI. Do not inspect, print, alter, or log the wrapper's API keys, SSH agent state, environment secrets, or global OpenCode config. The connected model is **GLM 5.3** for this trial; the provider/model ID is selected by the owner in OpenCode, not hardcoded in project files.

Typical read-only preflight:

```zsh
pwd
git rev-parse --show-toplevel
git remote -v
git branch --show-current
git rev-parse HEAD
git status --short
find src tests docs -maxdepth 2 -type f | sort
```

Use mission-provided pinned commit and paths, not `main` by assumption. A mismatch or dirty worktree is a stop condition. Never use `git reset --hard`, `git clean`, `git stash`, forced checkout, or force push to deal with a mismatch silently.

## Tests and evidence

Current dependency-free Node tests:

```zsh
node --test tests/identity-registry.test.mjs
node --test tests/sillytavern-adapter.test.mjs
node --test tests/card-mutation-controller.test.mjs
node --test
git diff --check
git status --short
git diff --stat
```

The **2026-10-28 G0 report** from the OpenCode/GLM 5.3 trial recorded a clean `main` at `b97b55064021f74de324eaaa9f4c27ddb3c6013e` and 201/201 passing Node tests (60 B0 + 58 B1 + 83 B2). This is **reported native local evidence**, not a promise that later revisions pass.

Before a mission-authorized branch push, inspect exact staged files, run `git diff --cached --check`, and report the commit SHA, comparison URL, full test receipts and final worktree status. Pushes to task branches are review artifacts only. Avoid `git add -A` unless every path is separately approved.

## Present project safety boundary

- H01-B0: accepted pure identity core.
- H01-B1: accepted read-only installed-card adapter.
- H01-B2: accepted **synthetic-only** guarded mutation controller.
- **H01-B3 is not yet authorized for real writes.** Its preparation requires ChatGPT-owned source research and a separately reviewed test plan addressing the editor's stale `json_data`, pending/debounced saves, card refresh/reconciliation, pre-read deadlines, concurrent writers and recovery from uncertain outcomes.
- Neither the coding agent nor the presence of a `mutateCard()` API constitutes permission to mutate a real card, chat or SillyTavern instance.

## Stop/report template

At every gate, report: mission ID; repository/branch/pinned base/full HEAD; `git status --short`; exact scope and changed files; commands with exit codes and test totals; blocked/untested conditions; whether any network mutation happened; and the explicit **STOP** condition. Submit the report for independent ChatGPT review without starting the next mission.
