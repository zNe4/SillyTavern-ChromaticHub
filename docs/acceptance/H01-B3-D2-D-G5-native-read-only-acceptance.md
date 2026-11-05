# ChromaticHub — H01-B3-D2-D G5 Native Read-Only Acceptance

**Decision:** OWNER-ACCEPTED (read-only native integration only)
**Date:** 2026-11-05
**Mission:** H01-B3-D2-D / G5-D, G5-R, G5-A, G5-F
**Authority:** Project owner performed native execution and supplied terminal receipts; ChatGPT reviewed the reported results against the prescribed acceptance gates.
**Scope:** Disposable native SillyTavern integration; no production activation or write-path authorization.

## 1. Pinned inputs

| Component | Accepted identity |
|---|---|
| ChromaticHub repository | `zNe4/SillyTavern-ChromaticHub` |
| Published ChromaticHub commit | `7c70b56ae4e6990572bf85ccb58756482ba2181b` |
| Pinned SillyTavern source | `06bde939fb1e9c4c8d8641d810f0a916b5bce127` |
| Owner’s existing SillyTavern HEAD (not altered for this mission) | `4ceca42ba2bef15f7c0f9f1040368260c8588b92` |
| Owner machine | Arch Linux, zsh / Kitty; Node.js `v24.22.1`; Git `2.56.0` |
| Disposable test root | `/tmp/chromatichub-g5.dk5vmhdl` |
| Disposable HTTP bind | `127.0.0.1:18765` |
| Native-write policy | `const writeEnabled = false` in published `index.mjs` |
| HTTP activation policy | `CHROMATIC_HUB_HTTP_ENABLED=1` only in opt-in stages |

The test source was prepared from a detached, pinned SillyTavern checkout and an archive of the published ChromaticHub commit. The active SillyTavern installation was not used as the running test instance.

## 2. Preparation receipt — PASS

- `G5-A1`: Native environment checks passed. Pinned SillyTavern checkout and ChromaticHub archive were verified. Published `index.mjs` and `src/sidecar-http-adapter.mjs` SHA-256 hashes matched their G4-reviewed values; native-write lock confirmed.
- `G5-A2`: `npm ci --no-audit --no-fund` succeeded; owner reported 829 packages installed. Separate single-user and multi-user configuration/data roots created. Two disposable 68-byte PNG fixtures were produced at `data-single/default-user/characters/G5_Disposable.png` and `data-multi/default-user/characters/G5_Disposable.png`, each SHA-256 `43739c566e26fd7cb88f69d3864ea34740372f5ee99acac169e090beffbce5c6`. No sidecar directory existed initially.

## 3. Native HTTP gate results — PASS

### G5-D — disabled-by-default

With `CHROMATIC_HUB_HTTP_ENABLED` unset, an authenticated, CSRF-valid POST to `/api/plugins/chromatic-hub/v1/resolve` returned **HTTP 503**:

```json
{"ok":false,"code":"HTTP_DISABLED","message":"ChromaticHub HTTP API is disabled","recoverable":false}
```

The checked ChromaticHub sidecar directory was absent after the request.

### G5-R — read-only enabled, native writes disabled

With `CHROMATIC_HUB_HTTP_ENABLED=1` and the hardcoded native write lock still `false`:

| POST route under `/api/plugins/chromatic-hub/v1/` | Observed HTTP | Checked response | Result |
|---|---:|---|---|
| `resolve` | 200 | `ok:true`, `UNBOUND`, disposable avatar, `recoveryAvailable:false` | PASS |
| `recovery-candidates` | 200 | `ok:true`, empty `candidates` | PASS |
| `create` | 403 | `WRITES_DISABLED`, `recoverable:false` | PASS |
| `mutate` | 403 | `WRITES_DISABLED`, `recoverable:false` | PASS |
| `rebind` | 403 | `WRITES_DISABLED`, `recoverable:false` | PASS |
| `clone` | 403 | `WRITES_DISABLED`, `recoverable:false` | PASS |

The single-user test root contained no ChromaticHub sidecar directory and the disposable PNG hash matched its initial value.

### G5-A1 — CSRF and caching

| Probe | Observed | Result |
|---|---|---|
| POST missing CSRF header | HTTP 403 | PASS |
| POST invalid CSRF token | HTTP 403 | PASS |
| POST with legitimate CSRF token | HTTP 200, `UNBOUND` | PASS |
| Valid response headers | `Cache-Control: no-store` | PASS |
| Sidecar absence and single-user PNG checksum | Preserved | PASS |

### G5-A2 — multi-user authentication

A separate disposable SillyTavern configuration with `enableUserAccounts: true` was started. A client holding a legitimately issued CSRF token **but no authenticated user session** received **HTTP 403** when calling `resolve`. Logging in through `/api/users/login` as the disposable `default-user` returned **HTTP 200**; a subsequent authenticated `resolve` returned **HTTP 200** with `UNBOUND` and `recoveryAvailable:false`. Sidecar absence and the multi-user PNG checksum were preserved.

**Interpretation:** The multi-user test verifies the host login boundary separately from CSRF. Single-user SillyTavern intentionally supplies its default user, so a single-user CSRF test alone would not establish unauthenticated rejection.

## 4. G5-F — final shutdown and integrity audit — PASS

After owner-initiated shutdown of the disposable multi-user server:

1. **Port released:** no listener on TCP port `18765`.
2. **Pinned checkout:** SillyTavern HEAD still `06bde939fb1e9c4c8d8641d810f0a916b5bce127`; tracked working tree and index diffs empty.
3. **Published plugin source:** all four expected hashes passed:
   - `index.mjs`: `605c596fa191a382d8ae4e59608319183bd115df3c2536942830d054d6e7c908`
   - `src/sidecar-http-adapter.mjs`: `467f938aca8a27988dfc27d2ecdaec155fdcac177d27047a87c14995cf7826cd`
   - `tests/sidecar-http-adapter.test.mjs`: `18c96bdcd0584aadf590137333ea36efcc2a93c7f5f1950a391455e50a9b7c92`
   - `tests/sidecar-server-plugin.test.mjs`: `96aa8a212d5970451f7c710977f312cb537ca9f5798b6df3f1385ba42a00b6ac`
4. **Write lock:** `index.mjs:44` still contained `const writeEnabled = false; // Strictly locked false for native deployments`.
5. **No sidecar storage:** the audit found no path named `chromaticHub` under either disposable data root.
6. **Fixture preservation:** both disposable PNG files retained SHA-256 `43739c566e26fd7cb88f69d3864ea34740372f5ee99acac169e090beffbce5c6`.

Terminal receipt ended `=== G5 FINAL AUDIT PASSED ===`.

## 5. Acceptance decision and exact limits

**ACCEPT G5 for the published D2-D read-only server-plugin integration.** Owner-native testing corroborates disabled-by-default HTTP, successful enabled read operations, denial of all four mutation routes, protection by SillyTavern's CSRF and authentication middleware, no-store responses, and the tested filesystem-preservation invariants.

This acceptance **does not** prove or authorize:

- Native sidecar create/mutate/rebind/clone persistence or crash recovery.
- Enabling `writeEnabled:true`, even in a disposable instance, without a separate G6 design and approval.
- Production activation in the owner's active SillyTavern checkout; publication as a general release.
- Exhaustive security or filesystem-write absence outside the checked sidecar paths and PNGs; ordinary SillyTavern startup created files within the disposable root.
- Direct instrumentation of the plugin exit hook, though server port release was verified after graceful shutdown was requested.
- Real-card storage, cross-user isolation with populated sidecars, malformed/large-body upstream guard behavior, or persistent state replay after restart.

The accepted version remains HTTP opt-in and **native writes hardcoded disabled**.

## 6. Next controlled mission

**G6-P — native write-path architecture and acceptance design (research and plan only).** Before changing the write lock, design disposable persistence fixtures, durable write/restart/readback tests, failure-injection and uncertainty quarantine tests, per-user/path isolation checks, concurrency boundaries, rollback criteria, data-retention policy, and explicit owner approval gates. Keep current C0/C1/C2 and D2-D acceptance intact. Implementation changes, native write activation, commits and publication require separate authorization.

**Disposition of test sandbox:** Preserve `/tmp/chromatichub-g5.dk5vmhdl` until the acceptance evidence and any relevant logs are recorded into the repository; cleanup is a separate owner decision. Do not copy cookies or CSRF values into permanent documentation.
