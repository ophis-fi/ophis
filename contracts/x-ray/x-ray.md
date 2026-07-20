# X-Ray Report

> Ophis Vault Policy Module | 522 nSLOC | `f89653aae` (`feat/vault-policy-phase-c-spec`) | Foundry | 20/07/26

Analyzed branch: `feat/vault-policy-phase-c-spec` at `f89653aae`.

---

## 1. Protocol Overview

**What it does:** A Safe module that decodes a full CoW order on-chain and enforces a fixed policy — receiver pinned to the vault Safe, token allowlist, Chainlink-backed minimum-out, pinned partner-fee appData, rolling USD turnover cap, L2-sequencer-aware oracle reads — before any presignature can exist, so a compromised curator key can only ever trigger policy-valid rebalances.

- **Users**: vault Safe owners (custody), a dedicated curator key (rebalance operations), CoW solvers (fill the resulting orders)
- **Core flow**: curator calls `rebalance(order, minBuyOverride)`; the module validates, charges a turnover bucket, sets an exact relayer allowance, and presigns — all as the Safe, via `execTransactionFromModule`
- **Key mechanism**: policy-gated presign. The module holds `execTransactionFromModule` power but exposes exactly two doors, both curator-only, and no generic exec or delegatecall
- **Token model**: no protocol token. Value moves as ERC20 sell/buy legs owned and received by the Safe throughout
- **Admin model**: none on the module — every parameter is `immutable`, written once at construction, with zero setters. Safe owners retain full custody and can disable the module at will. `AllowListGuardian` (adjacent chain governance) splits the CoW solver allowlist into a 24h-timelocked additive path and an instant guardian-only eviction path

For a visual overview of the protocol's architecture, see the [architecture diagram](architecture.svg).

### Contracts in Scope

| Subsystem | Key Contracts | nSLOC | Role |
|-----------|--------------|------:|------|
| Vault policy | `OphisVaultPolicyModule`, `OphisVaultPolicyModuleFactory` | 392 | Policy gate between the curator and the Safe; factory enforces the curator-privilege invariant at deploy |
| Oracle floor | `OphisChainlinkFloor` | 43 | Fail-closed two-feed cross-rate floor with validity, round-completeness and staleness checks |
| Dependency surface | `IVaultPolicyDeps` (ISafe, IGPv2Settlement, IAggregatorV3, IERC20Metadata) | 35 | Deliberately minimal external ABI — no owner management, no delegatecall |
| Chain governance | `AllowListGuardian` | 52 | Timelocked solver adds / instant defensive eviction for the settlement authenticator |

Vendored CoW GPv2 contracts (`GPv2Settlement.sol`, `mixins/`, `libraries/GPv2Order.sol`, `libraries/GPv2Trade.sol`, `interfaces/`) are trusted third-party and out of scope.

### How It Fits Together

The core trick: the module is the *only* thing the curator can reach, and the module's only outputs are an exact allowance and a presignature for an order whose every field it just re-derived and checked itself.

### Rebalance (the whole policy surface)

```
Curator ──> OphisVaultPolicyModule.rebalance(order, minBuyOverride)
             │
             ├─ _enforcePolicy(order, minBuyOverride)              [view — reverts on ANY failure]
             │   ├─ allowlist: sellToken, buyToken, sell != buy
             │   ├─ receiver == safe, feeAmount == 0, appData == appDataHash
             │   ├─ KIND_SELL, !partiallyFillable, ERC20 balances
             │   ├─ block.timestamp < validTo <= now + maxTtl
             │   ├─ _checkSequencer()                              *gate runs BEFORE any price is trusted*
             │   ├─ OphisChainlinkFloor.read18(sell) / read18(buy) *reverts on invalid, incomplete or stale*
             │   ├─ floorBuyAmount(...)  ──> oracleFloor
             │   ├─ oracleFloor == 0 ? revert                      *fails closed regardless of minBuyOverride*
             │   └─ buyAmount >= max(oracleFloor, minBuyOverride)
             │
             ├─ _recordTurnover(orderUsd)                          *leaky bucket; reverts over cap*
             ├─ _deriveUid(order)                                  *uses the settlement's OWN lib + domainSeparator*
             │
             ├─ EFFECTS: moduleOrderSellToken / liveAllowanceUid / liveAllowanceOrderUid
             │                                                     *all four writes land before any external call*
             └─ INTERACTIONS (as the Safe):
                 ├─ setPreSignature(supersededUid, false)          *revoke predecessor FIRST*
                 ├─ approve(relayer, 0) then approve(relayer, exact)  *USDT-safe, never MaxUint*
                 └─ setPreSignature(uid, true)
```

### Cancel (strictly risk-reducing)

```
Curator ──> OphisVaultPolicyModule.cancel(orderUid)
             ├─ moduleOrderSellToken[key] != 0 ? else revert       *cannot touch foreign presignatures*
             ├─ delete moduleOrderSellToken[key]                   *CEI: record cleared before interacting*
             ├─ setPreSignature(orderUid, false)
             └─ if liveAllowanceUid[sellToken] == key:             *only if THIS order still owns the allowance*
                 └─ approve(relayer, 0)
```

### Fill (no module involvement)

```
Solver ──> GPv2Settlement.settle(...)
            ├─ VaultRelayer pulls exact sellAmount from the Safe
            └─ delivers >= signed buyAmount to order.receiver == the Safe
```

The module is absent from the fill path entirely. That absence is Phase-B residual #1: the floor binds at presign time, and the order stays fillable at its signed limit until `validTo`.

### Deploy (the curator-privilege gate)

```
Deployer ──> Factory.deploy(cfg)
              ├─ safe.getOwners() — curator must not be among them
              ├─ safe.isModuleEnabled(curator) — must be false
              └─ new OphisVaultPolicyModule(cfg)
                   ├─ _requireCuratorNotPrivileged()               *re-checked; a direct deploy cannot skip it*
                   ├─ relayer + domainSeparator READ from settlement  *never accepted as params*
                   └─ per token: decimals, staleness bounds, live feed probe
```

---

## 2. Threat & Trust Model

### Protocol Threat Profile

> Protocol classified as: **Yield Aggregator / Vault** with **Governance** characteristics

Signals: Safe-custodied assets rebalanced by a delegated operator, oracle-derived minimum-out, a rate-limited operator budget, and no share accounting of its own. The governance characteristics come from the adjacent `AllowListGuardian` timelock/guardian split and from the module's deliberate absence of governance — immutability is the control.

Note the inversion from a standard vault profile: there are no depositor shares, no `totalAssets()`, and no strategy accounting, so the canonical vault adversaries (first-depositor share inflation, donation attacks, harvest sandwiching) do not apply. The entire threat model collapses onto one question — what can the curator key do.

### Actors & Adversary Model

| Actor | Trust Level | Capabilities |
|-------|-------------|-------------|
| Safe owners | Trusted (by design — full custody) | Enable/disable the module, move funds directly, rotate the curator by redeploying. Out of scope as an adversary. |
| Curator | Bounded (policy-gated, two functions only) | `rebalance` + `cancel` only. Chooses order fields freely but every one is re-validated; can tighten the floor via `minBuyOverride`, never loosen it. No config surface at all — the module has zero setters. Bounded by the turnover cap per rolling window. |
| CoW solvers | Bounded (allowlisted by chain governance) | Fill presigned orders. Can choose *when* inside the TTL to fill, which is the intra-TTL residual. Can also call `freeFilledAmountStorage` on expired uids (relevant to Phase C's refund design). |
| Timelock (`AllowListGuardian`) | Trusted, delayed | Add solver, hand off `manager()`, rotate guardian. All `>= 24h` announced. No path to vault funds. |
| Guardian Safe | Bounded (capability-reducing only) | Instant `removeSolver`. Deliberately given no additive power — an additive escape hatch would defeat the timelock. |
| Chainlink feeds | Trusted within validity + freshness bounds | Sole price authority. Validity, round-completeness, staleness and (on L2) sequencer-uptime checks all fail closed. |

**Adversary Ranking:**

1. **Compromised curator key** — the threat this module exists to bound; a dedicated operational key is the most plausible single compromise in the system.
2. **Oracle manipulator** — the floor is the only price control, and a manipulated-but-fresh feed inside one heartbeat is the acknowledged residual.
3. **MEV searcher / opportunistic solver** — chooses the fill moment inside the TTL window against a floor struck earlier.
4. **Misconfiguring deployer** — every parameter is immutable, so a deploy-time mistake is permanent and can only be fixed by redeploying.

See [entry-points.md](entry-points.md) for the full entry point map.

### Trust Boundaries

- **Curator → Safe** — the module is the entire boundary; it holds `execTransactionFromModule` but exposes only `rebalance` and `cancel`, with no generic exec and no delegatecall (`OphisVaultPolicyModule.sol:591-599`, `operation` hardcoded to 0).

- **Curator → Safe, out-of-band** — the boundary depends on the curator holding no *other* Safe privilege; that is checked at construction and at factory deploy but never again (`:263`, `Factory:42-48`). Owner-set and module-set drift is explicitly the owners' responsibility.

- **Module → oracle** — fail-closed in every direction: invalid, incomplete-round, stale, sequencer-down and sequencer-recovering all revert (`OphisChainlinkFloor.sol:40-50`, `OphisVaultPolicyModule.sol:502-511`).

- **Module → settlement** — the relayer and domain separator are read from the settlement itself rather than supplied (`:279-280`), so the module cannot be wired against a mismatched pair. One bytecode works byte-identically against sovereign and canonical settlements.

- **Timelock → authenticator** (`AllowListGuardian`) — the 24h delay gates every additive op; the guardian's instant path is capability-reducing only. Failure mode is deliberately fail-safe: a broken timelock freezes additions permanently while eviction keeps working. *Git signal: 4 source-touching commits in 30 days, all on the vault module; the guardian itself has been stable since June.*

### Key Attack Surfaces

- **Curator-privilege drift after deploy** &nbsp;&#91;[I-15](invariants.md#i-15), [E-2](invariants.md#e-2), [X-3](invariants.md#x-3)&#93; — `OphisVaultPolicyModule.sol:263` and `Factory:42-48` check the curator is neither Safe owner nor enabled module, but only at construction; the Safe's owner and module sets are mutable afterwards and never re-read. Worth confirming that the operational monitoring for this drift exists and is as reliable as the on-chain checks it substitutes for.

- **Intra-TTL floor staleness** &nbsp;&#91;[I-4](invariants.md#i-4), [I-11](invariants.md#i-11), [E-4](invariants.md#e-4)&#93; — the floor is struck in `_enforcePolicy` (`:427-496`) and never re-evaluated; the order stays fillable at its signed limit until `validTo`. Worth tracing how `MAX_TTL_CAP` (1h, `:181`) interacts with the live deploys' configured `maxTtl` and with each chain's feed heartbeat.

- **Deploy-time feed probe skips the sequencer gate** &nbsp;&#91;[X-4](invariants.md#x-4), [I-23](invariants.md#i-23)&#93; — the constructor calls `read18` directly at `:301` while the runtime path calls `_checkSequencer()` first at `:461`; `sequencerUptimeFeed` is already assigned at `:272`, so the ordering is available but not used. Worth confirming the asymmetry is intentional and that nothing downstream treats the probe as equivalent to the runtime gate.

- **Turnover bucket accounting under supersession** &nbsp;&#91;[I-8](invariants.md#i-8), [I-9](invariants.md#i-9), [E-5](invariants.md#e-5)&#93; — `_recordTurnover` (`:519-536`) charges before the uid is derived and never refunds a superseded order revoked in the same call (`:357-366`). Worth confirming the over-count direction is the intended one and that the leak-rate integer division at `:522` cannot round to zero for any configurable cap.

- **Shared per-token relayer allowance** &nbsp;&#91;[I-14](invariants.md#i-14), [G-19](invariants.md#g-19)&#93; — `_approveAndPresign` (`:557-575`) resets the allowance on every rebalance, and `cancel` zeroes it only when the cancelled order still owns it (`:414`). Worth tracing the interaction with any concurrent venue or module holding an allowance on the same sell token — disclosed residual #2.

- **Cached token decimals vs. upgradeable tokens** &nbsp;&#91;[I-7](invariants.md#i-7), [I-17](invariants.md#i-17), [I-18](invariants.md#i-18)&#93; — `tokenDecimals` is read once at `:294` and reused in both the floor and the turnover charge; several allowlisted tokens (USDC) sit behind upgradeable proxies. Worth confirming the "immutable in practice" assumption at `IVaultPolicyDeps.sol:57-59` is the one the operator relies on.

- **Floor rounding direction** &nbsp;&#91;[I-17](invariants.md#i-17), [X-2](invariants.md#x-2)&#93; — `OphisChainlinkFloor.sol:74-77` truncates on both divisions, so the computed floor rounds down. Worth confirming the magnitude stays below one base unit of the buy token across the full allowlist and that `ZeroOracleFloor` is the only case that needs the explicit guard.

- **Event coverage vs. the effective floor** — `Rebalanced` (`:197-204`) emits `oracleFloor` but never `minBuyOverride` or the derived `requiredFloor`, and `Cancelled` (`:205`) emits only the uid. Worth confirming that off-chain floor-vs-fill monitoring can reconstruct the enforced bound from chain data alone.

### Upgrade Architecture Concerns

Not applicable to the vault module — no proxy, no `initialize()`, no upgrade path. A new policy means a new module instance the owners enable. `GPv2AllowListAuthentication` (out of scope) is proxied, and the guardian's NatSpec at `:33-35` directs its EIP-1967 admin to the same timelock; that wiring lives in the install script rather than in the contract.

### Protocol-Type Concerns

**As a Yield Aggregator / Vault:**
- No share accounting exists, so the standard inflation and donation vectors are structurally absent — but it also means the only value guarantee is the per-order floor. Worth confirming `E-3` holds: that the partner fee, riding in appData rather than `feeAmount`, is genuinely taken from surplus above the signed limit.
- `orderUsd` (`:493-495`) is the sole input to the economic bound and is denominated on the sell side only; a curator churning A→B→A pays the bucket twice, which is the conservative direction.

**As Governance:**
- `AllowListGuardian` has no escape hatch by design (`:39-49`). Worth confirming the pre-install runbook assertion — live proposer + executor, `getMinDelay() >= 24h` — is enforced somewhere other than prose.

### Temporal Risk Profile

**Deployment & Initialization:**
- Every policy parameter is immutable and validated in the constructor, so misconfiguration is permanent; the memory of the live deploys (`maxTtl` and ETH staleness fixed at values the scripts have since tightened) is the concrete instance of this risk.
- The feed liveness probe at `:301` is the one constructor check weaker than its runtime equivalent — see X-4.
- No `initialize()` and no proxy means no front-running window at deploy.

**Market Stress:**
- Per-token `maxStaleness` sized against feed heartbeats leaves thin margin on the stable legs (the Phase C spec documents ~2h of slack on OP USDC/USD and on Unichain). One late heartbeat fails closed — correct, but it converts a market-stress event into a rebalancing outage.
- The floor is a single-source Chainlink read with no deviation band or fallback; a manipulated-but-fresh price inside one heartbeat is the acknowledged residual.

### Composability & Dependency Risks

**Dependency Risk Map:**

> **Chainlink price feeds** — via `OphisChainlinkFloor.read18`
> - Assumes: `answer > 0`, complete round, age within the per-token `maxStaleness`, `decimals() <= 18` and stable since deploy
> - Validates: all of the above (G-38 … G-41); feed decimals cached at deploy after a live probe
> - Mutability: Chainlink proxies are upgradeable by Chainlink; feeds can be deprecated with notice while still publishing
> - On failure: reverts — fail-closed, no fallback oracle, no stale-price acceptance

> **Chainlink L2 sequencer uptime feed** — via `OphisVaultPolicyModule._checkSequencer`
> - Assumes: `answer == 0` means up; `startedAt` is when the current status began
> - Validates: down, uninitialized round, and post-recovery grace all rejected (G-32 … G-34). `address(0)` disables the gate entirely for chains without one
> - Mutability: Chainlink-operated
> - On failure: reverts. Not applied on the constructor probe path — see X-4

> **Safe (v1.3.0+)** — via `ISafe.execTransactionFromModuleReturnData`, `getOwners`, `isModuleEnabled`
> - Assumes: `operation = 0` is a plain CALL; return data faithfully reports the inner call's success
> - Validates: `success` checked (G-36); ERC20 approve return decoded and an explicit `false` rejected (G-37)
> - Mutability: owners can change the owner set, module set and fallback handler at any time
> - On failure: reverts. The owner/module drift case is not detected — see I-15

> **GPv2Settlement (Ophis non-canonical or canonical CoW)** — via `setPreSignature`, `vaultRelayer`, `domainSeparator`
> - Assumes: `vaultRelayer()` and `domainSeparator()` are immutable on the settlement, and the uid derived from `GPv2Order` matches what the settlement will verify
> - Validates: both are read from the settlement at deploy rather than supplied as params; the uid uses the settlement's own library
> - Mutability: the sovereign settlements are non-upgradeable; canonical CoW likewise
> - On failure: reverts via `_exec`

> **ERC20 sell tokens** — via `IERC20.approve` / `allowance` from the Safe
> - Assumes: standard transfer semantics, fixed decimals, no fee-on-transfer, no rebasing
> - Validates: USDT-style reset-to-zero handled; void-returning and bool-returning approves both accepted; decimals bounded at 36
> - Mutability: several allowlisted tokens are upgradeable proxies
> - On failure: reverts via `ApproveFailed`

**Token Assumptions** *(unvalidated only)*:
- Fee-on-transfer / rebasing: assumes none are allowlisted — the floor is computed on the gross `sellAmount`, which such tokens do not deliver in full. Enforced only by deployer discipline (disclosed residual #3).
- Fixed decimals: assumes `decimals()` never changes after deploy — impact if violated is a mispriced floor *and* a mis-charged turnover bucket, since both consume the cached value.
- Blocklistable tokens (USDC, USDT): assumes the Safe is never blocklisted; a blocked Safe fails closed on approve rather than losing funds.

**Shared State Exposure:**
- The per-token relayer allowance is shared Safe-wide. Any other venue or module holding a concurrent allowance on the same sell token can have it reset by a rebalance — disclosed residual #2, mitigated operationally by the migration ordering rule.

---

## 3. Invariants

> ### 📋 Full invariant map: **[invariants.md](invariants.md)**
>
> A dedicated reference file contains the complete invariant analysis — do not look here for the catalog.
>
> - **48 Enforced Guards** (`G-1` … `G-48`) — per-call preconditions with `Check` / `Location` / `Purpose`
> - **23 Single-Contract Invariants** (`I-1` … `I-23`) — Conservation, Bound, Ratio, StateMachine, Temporal
> - **4 Cross-Contract Invariants** (`X-1` … `X-4`) — caller/callee pairs that cross scope boundaries
> - **5 Economic Invariants** (`E-1` … `E-5`) — higher-order properties deriving from `I-N` + `X-N`
>
> Every inferred block cites a concrete Δ-pair, guard-lift + write-sites, state edge, temporal predicate, or NatSpec quote. The **On-chain=No** blocks are the high-signal ones — `I-10`, `I-15`, `X-4`, `E-2`, `E-4`. Attack-surface bullets above cross-link directly into the relevant blocks.

---

## 4. Documentation Quality

| Aspect | Status | Notes |
|--------|--------|-------|
| README | Present | `contracts/README.md`; vault specifics live in `docs/` and `apps/docs-ophis/docs/vault-managers.md` |
| NatSpec | ~274 annotation lines across 522 nSLOC in scope | Exceptionally dense — `OphisVaultPolicyModule.sol` alone carries 165 lines, including a 65-line contract-level header enumerating the threat model, the leaky-bucket guarantee, three disclosed residuals, and the operational invariant |
| Spec/Whitepaper | Present | Phase A (`2026-07-15`), Phase B (`2026-07-16`), Phase C (`2026-07-20`, 920 lines, DRAFT); plus an operations runbook and a public docs page |
| Inline Comments | Thorough | Comments consistently explain *why*, not *what* — e.g. the `cancel` allowance guard at `:404-413` documents that its `!=` branch is currently unreachable and states why the guard stays |

Documentation quality is the strongest signal in this codebase. Every residual an auditor would expect to find is already named in the source: fill-time floor (per spec + `:51-56`), shared-token allowances (`:57-62`), fee-on-transfer exclusion (`:63-65`), curator-privilege drift (`:72-74`), and the leaky-bucket burst allowance (`:24-36`). Claims tagged `(per spec)` below are spec-stated rather than code-verified.

- The Phase-C EIP-1271 lane, adapter taxonomy and timelocked allowlist are **specced only, not implemented** *(per spec)* — no Phase-C code exists on this branch.

---

## 5. Test Analysis

| Metric | Value | Source |
|--------|-------|--------|
| Test files | 123 | File scan (always reliable) |
| Test functions | 321 | File scan (always reliable) |
| Line coverage | Unavailable — `forge coverage` fails to compile | Coverage tool (requires compilation) |
| Branch coverage | Unavailable — same | Coverage tool (requires compilation) |

Coverage is unavailable for a toolchain reason, not a test-quality reason. The default profile hits `Stack too deep` (optimizer disabled for coverage), and `--ir-minimum` then hits `Unimplemented feature … Modifiers not implemented yet` in the IR codegen path over the vendored 0.7.6 tree. Test *existence* is unaffected: `forge test --no-match-path "*fork*"` passes **311/311**.

### Test Depth

| Category | Count | Contracts Covered |
|----------|-------|-------------------|
| Unit | 321 total; 45 vault-specific | `OphisVaultPolicyModule` (43), golden-uid derivation (2), `AllowListGuardian` (14), plus the vendored GPv2 suites |
| Fork | 18 across 6 files | Per-chain "Real" preflights for Ethereum, OP, Base, Arbitrum, Unichain + a generic module fork suite |
| Stateless Fuzz | 3 | Vault module |
| Stateful Fuzz (Foundry) | 3 | `invariant_turnover_never_exceeds_cap`, `invariant_no_bad_presignature_survives`, `invariant_one_live_presign_and_exact_allowance_per_sellToken` |
| Stateful Fuzz (Echidna) | 2 (vault) + 45 (`property_` guardian suite) | `echidna_turnover_within_cap`, `echidna_no_bad_presignature` on `VaultPolicyEchidna`; the 45 `property_` functions target the guardian/authenticator pair |
| Stateful Fuzz (Medusa) | 2 | Same two `echidna_`-prefixed properties on `VaultPolicyEchidna` via `test/fizz/vault/medusa.json` |
| Formal Verification (Certora / Halmos / HEVM) | 0 | none |

Today's gate results, cited from the task context: semgrep (`p/trailobits` + `p/security-audit` + `p/secrets`) → 0 findings / 0 errors; Echidna 60k iterations → both properties passing; Medusa 132k calls → 2/2 passed; `forge test` → 311/311.

### Gaps

- **`test/fizz/vault/medusa.json` pins its compilation target to an absolute path in a *different* worktree** — `"/Users/scep/greg-wt/lagoon-vaults/contracts/test/fizz/vault/VaultPolicyEchidna.sol"` (`medusa.json:16`). The file is git-tracked and not gitignored. The two copies are byte-identical today, so the cited 2/2 result is valid by coincidence, but the config is not reproducible on any other machine or in CI, and on a branch where the harness diverges Medusa would silently fuzz the other worktree's copy and report green for code that was never under test. The Echidna configs (`echidna.yaml`, `echidna/echidna.yaml`) are clean by comparison — no absolute paths.
- **No formal verification** (Certora / Halmos / HEVM = 0). For a contract whose core guarantee is a bounded-damage claim over a rate limiter and a cross-rate floor, a symbolic proof of `E-2` and `I-8` would be the natural next gate.
- **Only 2 stateful-fuzz properties on the vault**, against 3 Foundry invariants and 45 guardian properties. The floor math (`I-17`), the leak-rate rounding (`I-9`) and the supersession-supersedes-and-revokes path (`I-13`, `E-5`) are covered by unit tests but not by a fuzz property.
- **Fork suites are preflight-shaped** — 18 functions across 6 per-chain files, gated on RPC availability, so they do not run in the default CI path.

---

## 6. Developer & Git History

> Repo shape: **normal_dev** — 9 source-touching commits out of 1063 total over 79 days; the vault subsystem arrived in 4 commits over 2 days (2026-07-17 → 07-18).

### Contributors

| Author | Commits | Source Lines (+/-) | % of Source Changes |
|--------|--------:|--------------------|--------------------:|
| Clement | 281 + 3 | +1400 | 56.1% |
| San Clemente | 772 | +1097 | 43.9% |
| dependabot[bot] | 5 | — | — |
| Claude | 2 | — | — |

Two identities account for 100% of source changes. Given `San Clemente` and `Clement`/`Clement Fermaud` are the same person under different git configs, this is effectively **single-developer** authorship of the entire vault subsystem — the dominant process signal in this report.

### Review & Process Signals

| Signal | Value | Assessment |
|--------|-------|------------|
| Unique contributors | 5 (2 human identities, same person) | Single-dev |
| Merge commits | 54 of 1063 (5.1%) | PR-based workflow; every vault commit carries a `(#NNN)` PR reference |
| Repo age | 2026-05-02 → 2026-07-20 | 79 days |
| Recent source activity (30d) | 4 commits, all vault | Late burst — the entire in-scope subsystem is under 4 days old at report time |
| Test co-change rate | 88.9% | 8 of 9 source-changing commits also touched test files (co-modification, not coverage) |

### File Hotspots

| File | Modifications | Note |
|------|-------------:|------|
| `contracts/src/contracts/vault/OphisVaultPolicyModule.sol` | 4 | Highest-churn in-scope file and the highest-priority review target |
| `contracts/src/contracts/vault/interfaces/IVaultPolicyDeps.sol` | 2 | Grew `isModuleEnabled` as the curator-privilege check hardened |
| `contracts/src/contracts/vault/OphisVaultPolicyModuleFactory.sol` | 2 | Same |
| `contracts/src/contracts/vault/OphisChainlinkFloor.sol` | 2 | Round-completeness check added post-initial |
| `contracts/src/contracts/AllowListGuardian.sol` | 2 | Stable since the June timelock work |

### Security-Relevant Commits

**Score** = weighted sum of fix-like signals in a commit: message keywords, diff patterns (deletes code, changes `require`/`assert`, touches access control or accounting), and change shape. **10+ warrants a manual diff.**

| SHA | Date | Subject | Score | Key Signal |
|-----|------|---------|------:|------------|
| `f89653aae` | 2026-07-20 | docs(vault): apply mechanics + oracle verification findings (refund exploit, feed facts) | 10 | explicit security language; involves oracle/pricing |
| `6eecb3521` | 2026-07-18 | feat(contracts): Phase-B vault policy module B5 preflight + audit hardening (#837) | — | touched all 4 vault files, 106 lines, tests co-changed |
| `d4112de22` | 2026-07-17 | fix(contracts,vault): revoke a superseded same-token order's presignature (#839) | — | the supersession revoke at `:357-366`; tests co-changed |
| `38d924408` | 2026-07-17 | fix(contracts,safe-swap): Codex follow-up — Roles preset + cancel-allowance scoping (#835) | — | the `liveAllowanceUid` ownership rule at `:414`; tests co-changed |
| `ff68e1126` | 2026-07-17 | feat(contracts): Ophis vault order-policy module (Phase B, B1) (#833) | — | 704 lines, initial subsystem |

`f89653aae` is documentation-only but carries the highest score in the repo, and its subject names a refund exploit — that is the Phase-C turnover-refund finding recorded in the spec's verification log, not a live-code defect.

### Dangerous Area Evolution

All five security areas the analyzer tracks (`access_control`, `fund_flows`, `oracle_price`, `signatures`, `state_machines`) resolve to the vendored GPv2 subtree import rather than to Ophis-authored changes. For the in-scope files the meaningful evolution is the 4-commit vault sequence above: initial implementation, then two targeted fixes to the allowance/supersession bookkeeping, then audit hardening.

### Technical Debt Markers

None. `tech_debt.total_count = 0` — no TODO, FIXME, HACK or XXX markers anywhere in the source tree.

### Security Observations

- **Effectively single-developer subsystem** — two git identities are the same person; 100% of the vault code has one author.
- **Compensating review depth is unusually high** — 12-agent solidity-auditor, ToB semgrep, Echidna/Medusa, Foundry invariants and multiple Codex rounds across PRs #833/#835/#837/#839/#840/#847/#849.
- **Both post-initial fixes were bookkeeping, not policy** — #835 scoped `cancel`'s allowance zeroing (`:414`), #839 added the supersession revoke (`:357-366`); the policy checks themselves have not been amended since #833.
- **Zero technical-debt markers** across the whole source tree.
- **Test co-change rate 88.9%** — 8 of 9 source-changing commits also touched tests (file co-modification, not coverage).
- **The entire in-scope subsystem is 3 days old** and already live on 5 chains; the branch under analysis is the Phase-C design branch, not the deployed one.
- **The one durable process defect found is in a fuzz config, not in Solidity** — `medusa.json:16` hardcodes another worktree's absolute path, which no Solidity-focused gate would catch.

### Cross-Reference Synthesis

- **`OphisVaultPolicyModule.sol` is #1 in BOTH churn AND attack-surface priority** — all top-4 surfaces route through it → highest-leverage review: `_enforcePolicy:427`, `_recordTurnover:519`, the supersession block at `:338-366`, and the `cancel` allowance guard at `:414`.
- **The two shipped fixes (#835, #839) both landed on the invariant `I-14` asserts** (≤1 live presignature per sell token, allowance == that order's amount) → the Foundry invariant suite now guards exactly the property that twice needed correcting; that is the right coverage in the right place.
- **`I-15` is the only On-chain=No invariant that is load-bearing rather than analytical** — `I-10` and `E-4` are honest restatements of a rate limiter's burst allowance, `X-4` is a weaker deploy-time probe → the residual risk concentrates almost entirely on off-chain curator-privilege monitoring.
- **The Phase-C spec's own verification log found a refund exploit in its draft** (`freeFilledAmountStorage` making `filledAmount == 0` an unsound never-filled test) → the same adversarial discipline applied to Phase-B code is what produced the current clean gate results; the medusa.json path defect suggests extending it to the harness configs.

---

## Forward Look: Phase C Attack-Surface Deltas

Phase C is **specced, not built** (`docs/development/specs/2026-07-20-vault-policy-phase-c-design.md`, DRAFT). Its three lanes each shift the surface materially.

**P1 — fill-time floor via EIP-1271 + ExtensibleFallbackHandler.** Closes the largest residual: the floor is re-struck inside `isValidSignature` at every validation, so `I-11`'s TTL bound stops being the price-risk control and `E-4`'s `intra-TTL drift` term disappears. In exchange the Safe's fallback handler becomes EFH, which answers *all* 1271 requests for the Safe — a new always-on surface where none existed. New invariants demanded: a registration binding (only digests registered by `rebalance` may validate), a wiring assertion (`rebalance` must revert unless the handler is the pinned EFH and the module is the registered domain verifier), a staticcall-purity guarantee on every price read, and a `safe_ == address(safe)` pin since EFH's `domainVerifiers` is caller-scoped. The spec's C1/C2/C3/C12/C13 name all of these.

**P2 — pluggable oracle adapters.** Today `X-1` is a single, small, fully-in-scope callee. Replacing `read18` with an `IOphisPriceSource` taxonomy turns one auditable dependency into four adapter classes, and moves oracle-quality risk from "one Chainlink read" into a catalog. The invariant that must survive intact is `X-2`'s division of labour: the module's `ZeroOracleFloor` guard is a property of the *computed floor*, not of any price source, and cannot be delegated to an adapter (the spec's C11 splits exactly this). The `Erc4626RateAdapter` is the sharp edge — the spec correctly bans raw `convertToAssets` and requires bounds on *both* sides, since for a floor an inflated buy-token rate and a deflated sell-token rate are both value-destroying.

**P3 — timelocked mutable allowlist.** This is the largest change to the report's own structure: `I-22` ("no post-deploy configuration surface") stops being true. The module gains an admin surface it currently does not have, and the strongest claim in this report — that immutability *is* the access control — becomes conditional on the timelock. The spec's mitigations are the right ones (proposer is the Safe and never the curator; execute is gated to Safe-or-guardian rather than permissionless; pendings expire; delay immutable; removals instant). Two consequences worth flagging for the Phase-C audit: (1) `I-13`'s bookkeeping is sell-token-keyed, so removal must reach buy-side live orders too — the spec caught this and moved to per-sell-token slots carrying `buyToken`; (2) the spec's own reasoning that an append-only `token => uid[]` index would let a curator gas-brick the guardian's removal power is exactly the escalation class this module exists to prevent, and its C15 bound should be treated as a first-class invariant, not a performance note.

**Net.** Phase C converts one structural residual (`E-4`'s drift term) into two new bounded surfaces (EFH always-on; a real admin path). The report's `On-chain=No` set would change shape rather than shrink: `I-10` survives unchanged, `X-4` is unaffected, `I-15`/`E-2` survive unchanged and remain the load-bearing off-chain assumption, and `I-22` is retired in exchange for a new set of timelock invariants.

---

## X-Ray Verdict

**HARDENED** — unit + stateless fuzz + stateful fuzz (Foundry invariants, Echidna, Medusa) + per-chain fork preflights, dense NatSpec plus three design specs and a runbook, and an access-control model whose primary control is immutability backed by a 24h timelock on the adjacent governance path; held back from FORTIFIED by the absence of formal verification and of any emergency pause on the module itself.

**Structural facts:**
1. 522 nSLOC across 4 subsystems and 5 Ophis-authored files; 7 external entry points, of which 1 is permissionless (a stateless factory) and 6 are role-gated or admin-gated.
2. Zero setters and zero admin functions on `OphisVaultPolicyModule` — all 11 policy parameters are `immutable` with a single constructor write site, and `tokenPolicy` has exactly one write site.
3. 48 enforced guards, 32 inferred invariants, 5 of which are not enforced on-chain; 3 Foundry invariants, 2 Echidna properties and 2 Medusa properties target the vault directly.
4. 311/311 non-fork tests pass; coverage metrics are unavailable due to a solc IR-codegen limitation over the vendored 0.7.6 tree, not due to test absence.
5. Two git identities belonging to one person account for 100% of source changes; the in-scope subsystem arrived in 4 commits over 2 days and carries zero TODO/FIXME/HACK markers.
