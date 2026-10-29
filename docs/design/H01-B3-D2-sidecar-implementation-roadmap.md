# H01-B3-D2 — V1 sidecar persistence implementation roadmap

**Status:** proposed implementation *sequence*, not an active Antigravity assignment.  
**Architecture:** [ADR-002 — accepted V1 direction](../decisions/ADR-002-external-card-scoped-persistence.md) · [B1 acceptance](../acceptance/H01-B3-C-B1-stale-editor-protocol.md) · [D1 lifecycle evidence](../research/H01-B3-D1-native-lifecycle-binding.md).  
**Roles:** ChatGPT = research, contract/design/docs, task management and independent review; Antigravity = bounded implementation/tests only on a separately approved mission; owner = native acceptance and Git integration. Follow [AGENTS.md](../../AGENTS.md) G0→G5 process.

## Product goals and non-goals for first writable release

**Must do:** card-local identities saved under an authenticated user's private `chromaticHub/cards/<installedCardId>/state.json`, a companion SillyTavern server plugin, normal-restart reconnect using a unique saved avatar filename (Option A), one-card at a time, server-side serial CAS, atomic file replacement, readback, ordinary editor-autosave isolation, explicit unresolved/conflict/orphan errors, actionable backup and export warnings.

**Not first-release goals:** prove every external same-filename replacement; native SillyTavern patches; background watchers; global people identity database; ChromaticImages asset migration; group mutations; automatic legacy PNG import; bundled export/import; SQLite; multiple Node processes sharing one data directory.

## D2-A — Contract freeze (ChatGPT, research/docs only)

- Freeze `state.json` schema, strict validator, bounds, install UUID, `stateRevision` (record-wide CAS), preserved H01-A `registry.revision`, UNINITIALIZED vs materialized semantics, and identity type compatibility.
- Freeze state transitions `BOUND`, `UNRESOLVED`, `ORPHANED`, `CONFLICT`, `CORRUPT`; normal restart uniquely matching recorded filename => `BOUND` without a prompt. Unknown invisible same-filename replacement is the documented V1 trust boundary.
- Freeze API request/response shapes, error codes, expected-revision race semantics, attach action, rename-event transition, missing-card recovery, readback and `WRITE_UNCERTAIN` recovery.
- Freeze secure filesystem protocol (per-user root, path validation, symlinks/hard links, no arbitrary path, file-size caps, permissions, atomic temp/rename, fsync, cleanup, crash behavior, single-process lock).
- Define user-visible warning that native PNG/JSON exports omit Hub data and a documented manual private-data backup path. Formal portable bundles deferred.
- **Gate:** independent contract review and owner acceptance before implementation. This work is owned by ChatGPT, not Antigravity.

## D2-B — Pure sidecar state machine (Antigravity, first bounded code mission after D2-A)

- G0/G1: agent inspects exact `main` and reviewed ADR/contracts, proposes exact changed paths and node:test test matrix; **no edits before plan approval**.
- Implementation only when separately authorized: pure modules for strict state-envelope validation, binding transitions, CAS plans, conflict and revision errors. Keep H01-A identity parser/validation and card-local UUIDs; do not activate legacy PNG mutation routes.
- Tests: initial attach, missing/corrupt records, deterministic transition rules, same-name dual claims, duplicate isolation, rename transition, normal unique-filename restart, stale revision, known replacement/refusal, no silent identity inference.
- **Gate:** synthetic tests + independent code review; no filesystem, browser, native SillyTavern or provider writes.

## D2-C — Server-side storage primitive (Antigravity, separate mission)

- Depend on reviewed D2-B logic; isolated disposable temp dirs only.
- Per-authenticated-user store root supplied by trusted backend, strict descendants and regular-file checks, serialized per-owner operations, expected state revision checked within queue, atomic complete-state replacement and independent readback.
- Failure injection: partial write, process interruption points, temp collision, symlink ancestor, malformed JSON, dangling state, fsync and rename failures, uncertain post-commit result, dual-tab simultaneous mutation simulated in one Node process.
- **Gate:** all faults fail closed, no cross-user/path escape and no mutation outside fixtures; proof limited to supported local filesystems.

## D2-D — Minimal server plugin (Antigravity, separate mission)

- Installable companion server plugin in an approved location, **not enabled in real user installation** until owner-native gate.
- Authenticated + CSRF-protected API under `/api/plugins/<id>`, explicit user directory root from authenticated `request.user`; no client user-root override. First read/resolve, then attach, then serialized mutate/rebind as separate sub-gates.
- Tests for real HTTP session scoping, missing user, different users with same avatar filename, invalid UUID/filename, duplicate attach, conflicting owner, plugin disabled, and handler errors. Do not import unreviewed SillyTavern internals or bypass built-in auth middleware.
- **Gate:** independent source review plus separate explicit approval before enabling plugin in a disposable ST instance.

## D2-E — Browser extension adapter (Antigravity, separate mission)

- Replace *future runtime call path*, not the deny-only legacy adapter: browser uses sidecar plugin reads/mutations with expected `stateRevision`; never uses `/api/characters/merge-attributes` as registry authority.
- Clear missing-plugin/read-only/unresolved errors. Track native rename/delete/duplicate events only as best-effort hints, with server verification and CAS.
- No auto-migration from existing `data.extensions.chromaticHub`; no auto-attach on mere read.
- **Gate:** synthetic browser and real non-production plugin integration; two-tab conflict handled deterministically.

## D2-F — Owner-native acceptance and publication

- Disposable card + independent backup + three-state experiment: establish sidecar revision; leave editor stale; native description autosave; ensure sidecar unchanged and API readback agrees.
- Rename, duplication, restart/reconnect, missing/deleted card/orphan, observed conflict/import replacement, two tabs, disabled plugin, corrupt file and interrupted write scenarios.
- Document **accepted blind spot**: invisible same-filename replacement may retain binding by design; do not claim detection.
- Require Git commit/push/merge and any native deployment separately approved after G4 independent review + owner acceptance. No production cards mutated under this roadmap.

## Next actual task

**D2-A — contract freeze, by ChatGPT.** After its review and owner approval, issue Antigravity a **G0/G1 plan-only** prompt for the pure state-machine milestone D2-B with exact repository baseline and changed-file scope. No implementation authorization is implied by this roadmap.
