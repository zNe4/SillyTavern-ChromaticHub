# H01-B3-C — Isolated native preflight and acceptance protocol (draft)

**Status:** ChatGPT-owned planning draft, not execution authorization.  
**Environment target:** Arch Linux, zsh, Kitty, Firefox; actual local state must be proven by owner.  
**Reference:** [H00-C disposable native acceptance](H00-C-card-registry-acceptance.md) and [H01-B3-C editor research](../research/H01-B3-C-editor-lifecycle.md).

## Boundary

**Current authorization: read-only research/design only.** The procedure below distinguishes future steps and their individual approval gates. Nothing in this document authorizes running a second SillyTavern server, creating/editing even a disposable card, installing dependencies, changing configuration, or accessing real production data.

## A. C-P0 — read-only owner inventory (next practical step)

The owner, not Antigravity, provides **sanitized** evidence from the intended local checkout and running server:

1. Exact repository/checkout root, `git rev-parse HEAD`, branch, `git status --short`, remote (redacted if private). Preserve local changes; no reset or cleanup.
2. Node runtime, SillyTavern startup entrypoint and launch mode (standalone/global), process command **with secrets/paths sanitized**. Never print exported tokens or the environment wholesale.
3. Actual effective `configPath`, `dataRoot`, user directories and process/listen port. Only *inspect* settings; do not copy private settings into report.
4. Existing listener collisions and browser profile/cookie separation plan. Do not treat a different port by itself as data isolation.
5. Any Git submodules, symlinks, dependency links or extensions that would escape a copied source/data root. Preserve owner checkout state.
6. Confirm the exact intended source revision against [SillyTavern pinned source](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127), and list material differences at relevant save and endpoint call sites for ChatGPT research.
7. Report only binary existence/status and high-level sanitized paths. Do not expose actual card names, chats, credentials, model settings, profile names or full command lines containing secrets.

**Read-only command suggestions** (run individually after confirming cwd; do not echo sensitive environment):

```zsh
pwd
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
node --version
git diff --name-only
```

The owner may inspect relevant socket listeners separately with `ss -ltn`; do not kill processes. If preflight conflicts with an existing session or unknown paths, **STOP**.

## B. C-P1 — isolated fixture design (future approval required)

Use what passed in H00-C as a pattern, not its old `/tmp` directory or port:

- Independent, version-pinned **source snapshot**, not the owner's mutable working tree; copy/link dependencies only after confirming symlink containment and no path into private or production data.
- Fresh separately named, owner-approved **configuration and data roots**, with proven no-overlap/no-symlink-escape relation to the production root. A new port without a new data root is insufficient.
- Distinct localhost-only server port, bound interface, fresh browser profile (no shared cookies/local storage/service workers), and no enabled network generation/provider routes. Do not disable CSRF merely for convenience.
- The pinned CLI offers `--configPath`, `--dataRoot` (standalone mode), and `--port` flags; `--dataRoot` and `--configPath` are ignored in global mode. Recheck actual target source and effective values **before constructing an executable launch command**.
- Prefer a disposable test card freshly created inside the isolated data root, with a synthetic Hub namespace and fake names/UUIDs only. No production-card copying, even for convenience.
- Produce an immutable baseline snapshot/manifest and a verified rollback route; record root/port/profile without private content.

H00-C's earlier fixture used separate source/dependency copy plus an isolated data/config root and `127.0.0.1:18180`; **reuse its isolation method, never the old directory or assume the port is free**.

## C. C-P2 — read-only instance observation (future approval required)

After owner approval of the isolation design only: inspect effective roots, server revision, data paths, UI profile separation, single-tab status, extension load set, read-only `/api/characters/get` responses, and resolved card owners. Ensure there is no hidden or production data root, symbolic link, other writer or accidental generation route. No modifications to card data, chat metadata or settings.

If any boundary fails, shut down the disposable instance through the approved procedure, retain evidence and **do not attempt native mutation**.

## D. C-P3 — mutation experiments (NOT AUTHORIZED)

Requires separate owner-approved mission with only synthetic/disposable fixture cards:

| Experimental case | Planned observation | Specific failure to detect |
| --- | --- | --- |
| Closed editor, no edit initiated | Character cache, hidden JSON fingerprint, persisted registry | Whether mere closed state excludes stale data (it does not certify quiescence by itself) |
| Dirty editor held open | Prior and subsequent registry fingerprints | Ordinary save overwrites Hub registry |
| Debounce queued, editor closed/switch | Event/submit ordering and persisted metadata | Save occurs after apparent editor closure |
| Save request in flight | Request ordering and card fingerprints | In-flight writer races with a registry update |
| `getOneCharacter()` before next save | Cache vs hidden field fingerprints | Cache refresh without hidden form reconciliation |
| Cross-tab (separate explicit scenario) | Document interleavings | No server-side CAS or shared lock |
| Simulated write failure/uncertain response | Endpoint status vs independent card readback | HTTP 200 not enough; no blind retry |

The experiment harness must not monkey-patch live SillyTavern or send mutation requests until expressly authorized. Do **not** interpret synthetic-only tests as native proof. The actual experiment scope, scripts and failure injection must be reviewed individually.

## E. C-P4 — recovery and STOP protocol

- Stop on unexpected filesystem paths, port conflicts, existing profile cookies, unknown extensions/writers, changes outside the fixture, new startup migration side effects, wrong HEAD, or a missing backup.
- After separately authorized mutation experiments, compare full-card API readback plus offline PNG `chara`/`ccv3` metadata, when supported. HTTP success is never the only evidence.
- On ambiguous POST completion, report **WRITE_UNCERTAIN** and preserve evidence; **no automatic retry**, no guessed registry restoration, no overwrite of user data.
- Abort/cleanup must target only the exact disposable processes and directories proven to be owned by this fixture. Never blanket-kill or `rm -rf` by guessed paths. Preserve or archive evidence before deleting anything.
- H00-C P4 offline acceptance evidence debt remains historical; do not confuse that with new H01-B3-C receipts.

## Decision needed after C-P0

ChatGPT compares the real target checkout with pinned 06bde93 source. Only then decide whether to authorize C-P1 setup, narrow additional source research, or maintain deny-only without native testing. **No Antigravity coding task is currently warranted.**
