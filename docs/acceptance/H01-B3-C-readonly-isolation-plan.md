# H01-B3-C — Isolated native preflight and acceptance protocol (draft)

**Status:** ChatGPT-owned planning draft, not execution authorization.  
**Environment target:** Arch Linux, zsh, Kitty, Firefox; actual local state must be proven by owner.  
**Reference:** [H00-C disposable native acceptance](H00-C-card-registry-acceptance.md) and [H01-B3-C editor research](../research/H01-B3-C-editor-lifecycle.md).

## Boundary

**Current authorization: read-only research/design only.** The procedure below distinguishes future steps and their individual approval gates. Nothing in this document authorizes running a second SillyTavern server, creating/editing even a disposable card, installing dependencies, changing configuration, or accessing real production data.

## A. C-P0 — owner source/configuration preflight (partial PASS)

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

### C-P0 owner receipts (2026-10-28)

- Git: `/home/zzzne4/SillyTavern`, branch `m03-d2b1-nanogpt-proxy`, HEAD `4ceca42ba2bef15f7c0f9f1040368260c8588b92`; only `package.json` and `package-lock.json` modified. **Do not touch those edits.**
- Node `v24.22.1`. All six pinned research source files match functionally: five Git blob IDs match exactly; `public/script.js` has only a “posible”→“possible” comment correction.
- `config.yaml` regular file and `data/` real directory within the owner checkout, with `dataRoot: ./data`, `listen: false`, `port: 8000`. These describe the **configuration file**, not the effective startup state of a running process.
- `node_modules` is a directory, not a top-level symlink. **Nested symlinks not yet audited.**
- The earlier listener filter returned only a header. No matching Node, port 8000 or port 18180 listener was reported at that instant; this is not comprehensive process assurance.

**Decision:** Enough evidence to finish the isolated-fixture **design** (C-P1-D). **Do not execute setup/startup.** Before any future C-P1-A assembly, separately confirm nested symlink safety, source/dependency compatibility and the intended launch command's non-global mode.

## B. C-P1 — isolated fixture design (future approval required)

Use what passed in H00-C as a pattern, not its old `/tmp` directory or port:

- Independent, version-pinned **source snapshot**, not the owner's mutable working tree; copy/link dependencies only after confirming symlink containment and no path into private or production data.
- Fresh separately named, owner-approved **configuration and data roots**, with proven no-overlap/no-symlink-escape relation to the production root. A new port without a new data root is insufficient.
- Distinct localhost-only server port, bound interface, fresh browser profile (no shared cookies/local storage/service workers), and no enabled network generation/provider routes. Do not disable CSRF merely for convenience.
- The pinned CLI offers `--configPath`, `--dataRoot` (standalone mode), and `--port` flags; `--dataRoot` and `--configPath` are ignored in global mode. Recheck actual target source and effective values **before constructing an executable launch command**.
- Prefer a disposable test card freshly created inside the isolated data root, with a synthetic Hub namespace and fake names/UUIDs only. No production-card copying, even for convenience.
- Produce an immutable baseline snapshot/manifest and a verified rollback route; record root/port/profile without private content.

H00-C's earlier fixture used separate source/dependency copy plus an isolated data/config root and `127.0.0.1:18180`; **reuse its isolation method, never the old directory or assume the port is free**.

### C-P1-D — concrete fixture design (approved for review, **not execution**)

**Inputs pinned for the design:** local tracked source at SillyTavern commit `4ceca42ba2bef15f7c0f9f1040368260c8588b92`, Node `v24.22.1`; configured owner defaults `./config.yaml`, `./data`, port 8000, `listen: false`. The owner has unrelated dirty package manifests; **exclude their working-tree changes from an archive of HEAD**. Note potential dependency/manifest mismatch; do not run `npm install` to resolve it implicitly.

**Proposed disposable layout (illustrative, not a path to create yet):**

```text
<new uniquely generated fixture root>/
  source/             # tracked-source snapshot of exact pinned commit, independent from owner checkout
  config/config.yaml  # newly authored minimal config; never copied from owner's config.yaml
  data/               # fresh empty test data; never copies owner data/
  browser-profile/    # fresh Firefox profile, no shared cookies or site storage
  logs/               # sanitized startup, containment, observations; no secrets
  receipts/           # manifest, hashes, executable identity, immutable baseline
```

**Assembly decisions and validation gates (each needs owner authorization before execution):**

1. **Source:** materialize a `git archive` of the exact pinned tracked commit into `source/`, not a live symlink to `/home/zzzne4/SillyTavern`. Check source tree hash/expected files and reject embedded absolute/escaping symlinks or unexpected startup mutations. Archive is based on committed files, so current dirty package manifests are excluded.
2. **Dependencies:** audit nested links and package compatibility in the owner's existing `node_modules` **without modifying it**. Copy dependencies into fixture-owned storage (no direct external symlink to owner `node_modules`); after copying, resolve every symlink transitively and reject any target outside approved fixture roots. No new network dependency installs or provider calls.
3. **Config/data:** author a **fresh** minimal standalone config, with explicit absolute `--configPath` and `--dataRoot` pointing inside the fixture. Do not copy owner `config.yaml` or `data/`. Abort if global mode is selected (those overrides are ignored), defaults resolve outside fixture, or effective user directories are unknown.
4. **Networking:** select a currently free dedicated localhost-only port **at preparation time**; do not assume prior H00 port 18180 or original 8000 is free. Ensure no public interface binding, no disabled CSRF, no unintended provider/network generation, and no browser autorun using the owner's profile.
5. **Browser:** if later authorized, use a separately provisioned Firefox profile or isolated browser session containing no owner logins, credentials, storage or provider settings. No secondary production tab.
6. **Evidence/recovery:** capture a sanitized fixture path manifest, SHA-256 of relevant tracked source, canonical resolved directories, allowed symlink target inventory, relevant listener status, and exact process ownership. Snapshot the fresh empty fixture state before any future test-card work. Define targeted shutdown, archiving and cleanup; no speculative `rm -rf` or blanket process kill.
7. **Pre-start STOP:** refuse any source HEAD mismatch, unexplained symlink escape, config/data overlap, unexpected global mode, port collision, dirty owner-data copy, provider credentials, unknown startup side effects, or missing rollback evidence.

**C-P1-D output:** a proposed fixture layout, exact ownership/containment rules, planned command review and a STOP decision. **C-P1-A physical assembly** is a separate owner-approved action. **C-P2 server startup/read-only observation** and **C-P3 disposable mutation experiments** remain distinct future gates.

### Remaining read-only checks before C-P1-A authorization

- Assess whether any *nested* `node_modules` symlink resolves beyond the intended source/dependency tree; only a summarized count/binary PASS or STOP is needed, not private paths.
- Confirm the intended standalone launch entrypoint and whether any global-mode startup is activated; the current checked `config.yaml` alone does **not** establish actual runtime options.
- Confirm that a future disposable Firefox profile is acceptable, and that no provider keys or production cards will be copied.

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

Source compatibility and basic configured paths are now verified. **C-P1-D design is ready for owner review.** Complete the remaining read-only dependency/launch inspection, then explicitly authorize or reject **C-P1-A fixture assembly**; do not infer permission to start a server, mutate even a disposable card, or create an Antigravity task. **No Antigravity coding task is currently warranted.**
