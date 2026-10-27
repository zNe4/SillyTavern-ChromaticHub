# Antigravity CLI workflow — ChromaticHub

**Status:** preparatory workflow guidance, not implementation authorization.  
**Source:** [Google's Antigravity CLI best practices](https://antigravity.google/docs/cli/best-practices) and [Antigravity rules documentation](https://antigravity.google/docs/rules/).  
**Scope:** this repository only. Do not change global CLI settings or the owner's local working environment from inside a coding mission.

## Why a small setup

For a small shared identity hub, a root \`AGENTS.md\` and the instructions in this document are enough. Do **not** create extra global rules, plugins, skills, parallel subagents or CI machinery by default. Introduce them only when a measured need appears.

Antigravity automatically loads root \`AGENTS.md\`; this document is deliberately linked, not inlined into its always-on context. Project rules are constraints; mission prompts specify concrete work. The project owner and ChatGPT remain responsible for design and research.

## Standard mission sequence

| Gate | Antigravity action | Approval / evidence |
| --- | --- | --- |
| **G0 — Inspect** | Read \`AGENTS.md\`, pinned contract and mission. Check \`pwd\`, remote, branch, exact HEAD, \`git status --short\`, existing tests. | Report mismatch/untracked changes; STOP if the pinned baseline cannot be established safely. |
| **G1 — Plan only** | Explore task-relevant files without mutation. Produce file-scoped implementation plan, tests-first sequence, assumptions, boundaries and stop conditions. | Owner/ChatGPT independent plan review; do not write code yet. |
| **G2 — Tests and implementation** | After approval, work on dedicated task branch, add precise tests, implement minimal behavior; iterate with local test command. | Honor allowed changed paths; no guessed dependencies/features. |
| **G3 — Verification** | Execute targeted tests plus \`git diff --check\`; inspect exact changed files and summarize verification receipts. | Provide full results and unverified cases, never a bare PASS. |
| **G4 — Independent review** | If the mission authorizes a review-branch push, stage **only scoped files**, commit, push **only the task branch**, and report its GitHub commit/compare URL; otherwise stop with a local diff. | ChatGPT reviews the pushed branch or diff. No push to main, force push, PR, merge, tag or release without separate authorization. |
| **G5 — Owner-native acceptance** | Only for a separately approved mission, run disposable/isolated acceptance with the owner. | Owner records observations; no real card modifications or generation without explicit permission. |

**Typical read-only preflight (zsh):**

~~~zsh
pwd
git remote -v
git branch --show-current
git rev-parse HEAD
git status --short
find . -maxdepth 3 -type f | sort
~~~

This example is read-only. Its output is informational only; a task's pinned expected HEAD/branch governs whether to proceed. Avoid blind \`git checkout\`, \`git reset\`, \`git clean\`, \`git stash\`, \`git add\` or \`git push\` in preflight.

**H01-B0 expected test loop** (only once the tests exist):

~~~zsh
node --test tests/identity-registry.test.mjs
git diff --check
git status --short
git diff --stat
~~~

The test path above is a *proposed* H01-B0 target, **not** proof a file already exists. Baseline repository has documentation only; avoid inventing a passing \`npm test\` script.

## Optional GitHub branch-push handoff

The owner may authorize Antigravity **in a specific implementation mission** to commit and push the finished, verified change onto a **dedicated non-main review branch**. This is a substitute for uploading local patch files, not a bypass of ChatGPT independent review.

- Use the mission's pinned base commit and distinct task branch. Confirm the branch has no unrelated changes and its remote target does not already hold someone else's work.
- Before committing, inspect both unstaged and staged diffs, run targeted tests and `git diff --check` (including `git diff --cached --check` after staging). Stage only listed paths; never `git add -A` indiscriminately.
- After the commit, inspect `git show --check --stat HEAD` and `git diff --name-status <pinned-base>...HEAD`. Confirm tests were executed on the committed contents, and report the complete test receipts.
- Push only the explicit feature branch with a normal, non-forced push. If rejected or another writer advanced the branch, **stop**, do not force or auto-rebase.
- Report repository, branch, full base/commit SHA, committed changed paths, test commands and counts, GitHub commit and compare links, and final worktree status. ChatGPT can review repository content directly; do not require the owner to upload .diff files.
- Never push directly to `main`, open/merge a PR, tag or release without distinct owner authorization. **A successful branch push does not imply code acceptance.**

### Updating a stale local checkout

A mismatched clean checkout is a **stop condition**, not permission to downgrade the mission's baseline. After confirming with ChatGPT/owner that the remote target really is ahead and contains only expected commits, run a read-only `git fetch origin main`, verify ancestry and commit details, then perform **fast-forward only** synchronization (`git pull --ff-only origin main`) when explicitly approved. Never `reset --hard`, force checkout or silently substitute an older SHA.

## Prompts and CLI session practices

- Specify exactly targeted files and consult the current H01-A contract first; path \`@\` completion can help on a local interactive CLI.
- Ask Antigravity for an **implementation plan artifact first**. Review it with ChatGPT **before** activating edit tools.
- CLI shortcuts such as \`/plan\`, \`/diff\`, \`/statusline\`, \`/rewind\` or \`/fork\` may assist interactive work, but they do not override Git safety or the external review gates. Avoid confusing CLI conversation rewind with a reliable Git rollback.
- For a clear mistake in an active session, interrupt and re-scope immediately rather than letting a wrong implementation proceed.
- Screenshots/media attachments are for actual UI defects. H01-B0 is pure core code and needs neither browser automation nor screenshots.
- Reserve \`agy -p\` and subagents for future safe, narrow tasks. Parallel work adds coordination risk and offers little value for the current module.
- Keep CLI output for reproducible evidence, but never copy credentials, session cookies, API keys, or private character content.

## Permissions: local user setting, not a repository file

The official guide documents CLI permissions in \`~/.gemini/antigravity-cli/settings.json\`, including \`request-review\` (documented default), \`proceed-in-sandbox\` and \`strict\`.

**Recommendation for this project:** begin with **request-review**, or **strict** when the owner wants confirmations for every non-read operation. Only consider \`proceed-in-sandbox\` after the owner has separately tested containment and understands what it allows. Never auto-edit global settings, silently bypass a confirmation, or infer secure containment merely from selecting a mode.

Example for the **owner** to consider, not a command or action Antigravity should execute:

~~~json
{
  "toolPermission": "request-review"
}
~~~

For risky tasks on live SillyTavern, require a separate disposable source/data root and explicit owner-native acceptance. Permission settings supplement but do not replace mission restrictions.

## H01-B0 plan-only kickoff template

**DO NOT execute H01-B0 yet without a separate explicit approved mission.**

~~~text
Task: H01-B0 pre-implementation plan only. Do not modify any files.
Read AGENTS.md, docs/process/ANTIGRAVITY-WORKFLOW.md,
docs/design/H01-A-identity-contract-v0.1.md,
docs/design/H01-A-acceptance-and-missions.md.
Report Git root, remote, branch, full HEAD, status and existing test setup.
Propose the smallest dependency-free ES module and node:test file
that validate/parse a versioned card-local registry and perform
immutable add/update/remove with explicit errors and IDs.
List exact paths, tests-first order, and unclear contract decisions.
NO code edits, staging, commits, pushes or remote mutations.
Stop for ChatGPT independent plan review.
~~~

The independent review must resolve any contract ambiguity before authorizing implementation.
