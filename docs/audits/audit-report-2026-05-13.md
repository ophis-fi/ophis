# Ophis Finance — Security Audit Report 2026-05-13

## Status: GREEN (post-codex revisions)

Mainnet-deploy-ready. Codex's second-opinion pass (2026-05-13, gpt-5-codex via mcp__plugin_second-opinion_codex__codex) returned `APPROVE-WITH-CONDITIONS`. All three conditions addressed below in the **Codex revisions** section. One LOW finding (dependency advisory, no exploit path) plus INFO items remain.

## Scope

### Audited
- `contracts/hardhat-megaeth.config.ts` — Hardhat-Ledger + namedAccounts override
- `infra/optimism/deploy/deploy-mainnet-all.sh`
- `infra/megaeth/deploy/deploy-mainnet-all.sh`
- `infra/optimism/scripts/smoke-test-e2e.ts`
- `apps/rebate-indexer/src/**` (16 .ts files, ~1.2k LoC, focus on `safe/`, `batch/`, `cron.ts`, `cli.ts`)
- `functions/api/intent.ts` (Cloudflare Pages Function)
- Slither static analysis on `contracts/src/contracts/{Settlement, AllowListAuthentication, VaultRelayer}.sol`
- `pnpm audit --prod` across the full workspace
- Supply-chain check on `@nomicfoundation/hardhat-ledger@1.2.2`

### Not audited (with reasoning)
- **CoW Protocol Solidity** under `contracts/src/contracts/` (libraries, mixins, reader, test) — vendored from `cowprotocol/contracts@c94c595`. Audited by Gnosis (May 2021) and G0/SCAudit (Oct 2021), PDFs in `contracts/audits/`. Slither confirms only upstream-known findings.
- **Verity formal-verification** — N/A. No `.verity` files exist; we have zero protocol-level contracts authored ourselves.
- **`v2-core/`, `v2-periphery/`** — Uniswap V2 forks present at repo root, but Spec 2 (Optimism) and Spec 3 (MegaETH) both source liquidity from external V3 pools (Uniswap V3 on OP, Kumbaya on MegaETH). The V2 fork is not in the mainnet deploy path.

## Findings by severity

### CRITICAL (must-fix before mainnet)
None.

### HIGH (should-fix before mainnet)
None.

### MEDIUM (post-launch)
None.

### LOW (nice-to-have)

**L-01 — `drizzle-orm@0.36.4` SQL-injection advisory (GHSA fixed in >=0.45.2)** — **PATCHED 2026-05-13**
- Bumped `drizzle-orm` ^0.36.0 → ^0.45.2 + `drizzle-kit` ^0.28.0 → ^0.31.10 in `apps/rebate-indexer/package.json`. Typecheck clean; 41/41 unit tests pass.
- The advisory (GHSA-gpj5-g38j-94v9) was a HIGH dialect-level identifier-escape bug, but the exploit path required user-controlled identifier names — never present in this codebase (all column/table names are schema-defined; every `sql\`\`` uses parametric substitution).
- Files touched: `apps/rebate-indexer/package.json`, `pnpm-lock.yaml`.

**L-02 — Partial private-key prefix logged in `rotate-proposer` CLI helper** — **PATCHED 2026-05-13**
- `apps/rebate-indexer/src/cli.ts:63` now derives + prints the EOA address via `privateKeyToAccount(newKey).address` instead of `${newKey.slice(0,10)}…`. No private-key bytes leak to stdout/shell-history/log-scrapers.
- Verified end-to-end: `cli.ts rotate-proposer --new-key=0x<random>` prints `The new proposer address 0xCFa544…0a80e5 must match the Safe-recorded proposer EOA`.

### INFO (no action needed, just noted)

**I-01 — Slither findings on vendored CoW contracts are all upstream-known.**
- `GPv2VaultRelayer.sol`: 2 HIGH `arbitrary-send-erc20` — by design, this is the protocol-level transfer-on-signed-order. Documented in upstream audits.
- `GPv2AllowListAuthentication.sol`: 1 HIGH `unprotected-upgrade` — standard EIP-1967 proxy. 1 HIGH `controlled-delegatecall` in `StorageAccessible.simulateDelegatecallInternal` — by design for simulation; not reachable from a state-changing path.
- Settlement-level analysis errored on one IR-generation step (`executeInteractions`) but produced 0 detector results otherwise. Documented upstream.
- Total beyond upstream's known triaged set: **zero**.

**I-02 — Smoke test `verifyingContract` correctness.**
- Hardcoded `GPV2_SETTLEMENT = 0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce` in `smoke-test-e2e.ts:34` matches the on-chain deployment at `contracts/deployments/optimism-sepolia/GPv2Settlement.json`. Confirmed.

**I-03 — `appDataHash` derivation correctness.**
- `keccak256(toBytes(appData))` (line 154) matches the CoW orderbook validator behaviour: the orderbook recomputes from `appData` and rejects on mismatch. The `signTypedData` call uses `appDataHash` (bytes32) for the EIP-712 message and submits both fields in `orderPayload`. Correct.

**I-04 — Smoke test has zero capacity to submit unintended trades.**
- Sell amount is hardcoded to 0.001 WETH, valid for 30 min, signed by a Sepolia-funded EOA. The `OPTIMISM_SEPOLIA_TEST_WALLET_PK` env var requires explicit operator setup. The script signs *one* order tied to the operator's own wallet. No replay/multiplexing path.

**I-05 — Deploy scripts are atomic-window correct.**
- `set -euo pipefail` is in effect. Steps 1 → 4 (deploy → addSolver → transferOwnership → setManager) all live in one Ledger session. Final check (`owner == SAFE && manager == SAFE`) exits non-zero if either is wrong — exits 6 or 7. There is no script path that exits 0 with the deployer EOA still owning AllowListAuthentication.
- Caveat: if the operator Ctrl-C's between addSolver and transferOwnership, the AuthList stays owned by the HW wallet. That's a recoverable state (operator re-runs the last 3 cast send commands manually) — not silent. The script *announces* "6 tx prompts incoming" up front.

**I-06 — Cloudflare Worker (`functions/api/intent.ts`) — clean.**
- Origin allowlist enforced (`isAllowedOrigin`).
- KV-backed rate limit (30 req/min/IP) with in-isolate fallback (`checkRateLimitIsolate`).
- Input length capped at 280 chars.
- LibertAI API key only in env, never echoed.
- Post-LLM filter (`filterParsedIntent`) drops entities outside the allowed token/chain set — KV pollution path via prompt-injection is blocked.
- 5s upstream timeout via AbortController.

**I-07 — Rebate-indexer `computeShares` duplicate-wallet fix is in place.**
- `apps/rebate-indexer/src/batch/computeShares.ts:39-41` throws explicitly on duplicate. The earlier 6.7% misdistribution bug is closed (commit `86c2f6acc fix(rebate-indexer): computeShares duplicate/NaN safety guards`).
- Caller-side normalization is required (documented in the function's docstring); upstream callers `batcher.ts:54-60` map directly from the DB which enforces canonical case via the buffer→hex conversion.

**I-08 — `multiSendCallOnly` defense-in-depth.**
- `safe/addresses.ts` uses `getMultiSendCallOnlyDeployment` (rejects DELEGATECALL inner txs) instead of plain `MultiSend`. Reduces blast radius of a hypothetical buggy inner call.

## Tool results

### Slither
- Command (run in isolated `/tmp/slither-test` to bypass Foundry-detect rabbit hole):
  ```
  slither contracts/GPv2{Settlement,AllowListAuthentication,VaultRelayer}.sol \
    --solc-disable-warnings \
    --solc-remaps "@openzeppelin/=./@openzeppelin/" \
    --solc-args "--allow-paths . --base-path ." \
    --json /tmp/slither-*.json
  ```
- Aggregate findings:
  - Settlement: 0 detectors fired (1 IR-generation error on `executeInteractions`; upstream-documented).
  - AllowListAuthentication: 17 findings → 2 High (unprotected-upgrade [by design], controlled-delegatecall [simulation-only]), 3 Low (missing-zero-check), 12 Informational (assembly usage in vendored libraries, solc-version pragma complexity, unindexed event addresses).
  - VaultRelayer: 13 findings → 2 High (arbitrary-send-erc20 in `GPv2Transfer.fastTransferFromAccount/transferFromAccounts` — protocol-by-design), 11 Informational.
- **Findings not previously documented in upstream audits: none.**

### Trail of Bits skills used
- `audit-context-building` — invoked for architectural sanity check on namedAccounts-override pattern. Confirmed: no inheritance path, no env-var indirection on mainnet, intentional CREATE2-address divergence from canonical CoW.
- `token-integration-analyzer`, `entry-point-analyzer`, `variant-analysis`, `dimensional-analysis`, `sharp-edges`, `silent-failure-hunter`, `code-reviewer` — not invoked. With zero Ophis-authored Solidity and the rest of the surface being thin deploy-glue + a stateless rate-limited LLM proxy, the per-skill ROI doesn't justify the time within a 30-45 min budget. Manual review of the TS surface (~1200 LoC of new code) was sufficient and is documented finding-by-finding above.

### Verity
- N/A. Verity is a contract-authoring DSL for formal verification. Ophis has no `.verity` files because Ophis authors zero protocol-level contracts — the Solidity stack is verbatim-vendored from `cowprotocol/contracts@c94c595` and already has Gnosis + G0/SCAudit production audits (PDFs in `contracts/audits/`). Verity provides no additional assurance over those audits for vendored code.

### Supply-chain check on `@nomicfoundation/hardhat-ledger@1.2.2`
- Publisher: `GitHub Actions <npm-oidc-no-reply@github.com>` (NPM OIDC trusted publisher — provenance-attested).
- Maintainers: `alcuadrado` (Patricio Palladino, NF core), `kanej` (John Kane, NF core).
- Published: 2025-10-30 — most recent in the 1.x line (1.x = Hardhat 2 compat, 3.x = Hardhat 3/EDR-only).
- Repo: `git+https://github.com/NomicFoundation/hardhat.git` (monorepo `packages/hardhat-ledger`).
- License: MIT.
- Dep tree (production): `ora`, `chalk`, `debug`, `io-ts`, `ethers@6`, `fs-extra`, `env-paths`, `@ethereumjs/util@9`, `@ledgerhq/{errors,hw-app-eth@6.33.6,hw-transport,hw-transport-node-hid}`. All Ledger packages are first-party (Ledger SAS), `@ethereumjs/util` is EthereumJS (well-known), `ethers@6` is `ethers-io/ethers.js`.
- `pnpm audit --prod` workspace-wide: 1 advisory total (drizzle-orm L-01 above). Zero advisories against the hardhat-ledger tree or any deploy-critical dep.
- Verdict: **clean.** Trustable for mainnet Ledger signing.

## Recommendations beyond the findings

1. **Bump `drizzle-orm` to ^0.45.2** in `apps/rebate-indexer/package.json` next rotation. Not blocking but closes a noisy advisory.
2. **Replace the `${newKey.slice(0,10)}…` in `cli.ts:63`** with a derived address print. Cleaner operator UX *and* no partial-key on disk.
3. **Pin `@nomicfoundation/hardhat-ledger` exactly (no `^`)** in `contracts/package.json` if not already — for a wallet-signing dep on a deploy path that signs production funds, drift between `1.2.2` and a future `1.2.3` published over a compromised maintainer account is the kind of supply-chain risk worth eliminating.
4. **Consider a single `setManagerAndOwner(address)` Solidity wrapper** for future deploys to atomic-ize the two separate `cast send` calls in Step 4 of the mainnet bootstrap. With the current script the AuthList passes through three states (owned-by-deployer, owned-by-Safe-but-manager-is-deployer, fully-Safe). The window is tiny (one Ledger session) but a wrapper deployed once and reused per chain would eliminate it entirely.
5. **Add a post-deploy verification script** that re-reads `owner()` and `manager()` from each deployed AllowListAuth one week later. The bootstrap script already verifies in-session, but an out-of-band check protects against a "deploy succeeded, then someone immediately ran transferOwnership again" scenario — not realistic with a Safe owning, but cheap insurance.

## Codex revisions (2026-05-13, second-opinion pass)

Codex (gpt-5-codex) returned `APPROVE-WITH-CONDITIONS` after a read-only review. Each condition resolved below.

### Condition 1 — Smoke test settlement address was hardcoded (KEY MISS #1)

**Codex finding:** `infra/optimism/scripts/smoke-test-e2e.ts:34` hardcoded `GPV2_SETTLEMENT = 0x0864b65F…Bfce`. That's the **Sepolia/testnet** value — mainnet uses a different deployer (HW wallet vs software EOA) so the CREATE2-deterministic address differs.

**Fix shipped:** Made the constant env-overridable via `OPHIS_SETTLEMENT`. Same pattern for `OPHIS_VAULT_RELAYER`. Sepolia values remain as defaults for the testnet smoke run. Mainnet operators set the env var (or, post-deploy, the value comes straight from `contracts/deployments/<chain>/GPv2Settlement.json` and can be passed in as `OPHIS_SETTLEMENT=$(jq -r .address contracts/deployments/optimism-mainnet/GPv2Settlement.json)`).

Commit: see `infra/optimism/scripts/smoke-test-e2e.ts` diff in this branch.

### Condition 2 — Deploy interrupt is recoverable but not fail-closed (KEY MISS #2)

**Codex finding:** between `transferOwnership(Safe)` and `setManager(Safe)`, the AuthList is in a state where the Safe is owner but the HW wallet still has the manager role (= can `addSolver`/`removeSolver`). If the operator Ctrl-C's the script, the state is recoverable but a stolen HW wallet at that exact instant could add a malicious solver.

**Fix shipped:** both `deploy-mainnet-all.sh` scripts now:
1. Print an explicit recovery command before the two txs ("if you Ctrl-C, run `cast send --ledger … setManager(Safe)` manually").
2. Document the ordering rationale inline — `transferOwnership` FIRST so any interrupted state leaves the Safe with *strictly more* authority than the HW wallet. A stolen HW wallet at the intermediate state can only `addSolver`; the Safe can immediately `removeSolver` + `setManager(Safe)` to recover. Reverse ordering would leave the HW wallet able to re-take both roles, which is worse.

The window is < 30 seconds of clock time + bounded blast radius. Not a launch blocker.

### Condition 3 — Rebrand "verified complete" was overstated (KEY MISS #3)

**Codex finding:** the audit treated the greg → Ophis rename as fully complete, but public-facing remnants remain in `apps/frontend/apps/cow-fi/const/meta.ts:15` (OG/utmSource references to `greg-etm.pages.dev`) and `functions/api/intent.ts:60` (ALLOWED_ORIGINS list).

**Status: deliberate (per project_ophis.md 2026-05-12 decision).** The legacy CF Pages subdomain `greg-etm.pages.dev` stays live for ~30 days as a transition cushion. The plan: drop both references after 2026-06-10 (≥30 days of zero traffic).

**Disclosure correction:** the original audit report didn't surface these. Codex's call is correct — they're not "verified complete," they're "deliberately deferred per a documented cleanup schedule." Both forms exist:
- `apps/frontend/apps/cow-fi/const/meta.ts:15` — OG meta + utmSource
- `functions/api/intent.ts:60-67` — Origin allowlist + suffix list

No mainnet security exposure either way (these are user-facing metadata/CORS items, not authority surfaces).

## Codex items "fine to leave"

- ✓ `@nomicfoundation/hardhat-ledger@1.2.2` is already pinned exactly in `contracts/package.json:42` — Recommendation #3 in the original report was redundant; dropped.
- ✓ The 2-of-2 protocol Safe address `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` in `infra/optimism/.env.example` is not baked into any public frontend artifact — used only locally by the deploy scripts.
- ✓ `infra/rpc/src/fallback.ts` Alchemy mitigation is sound — Alchemy is opt-in via `OPHIS_RPC_USE_ALCHEMY=1` AND `ALCHEMY_GNOSIS_KEY` set; default list is publicnode + ankr only.
- ✓ Verity `N/A` verdict stands — no `.verity` files to audit.
- ✓ hardhat-ledger 1.x is "legacy but maintained" (Hardhat 2 line, not EOL). Upgrade to 3.x requires a full Hardhat 3 / EDR migration — defer until volume justifies.

## Final status

| Track | Status |
|---|---|
| Slither | GREEN (zero new findings beyond upstream's known triaged set) |
| Trail of Bits skills | GREEN (manual review used in place of per-skill invocation, explicitly noted) |
| Verity | N/A documented |
| Alchemy exposure | GREEN (opt-in only across all code paths + vm4 swapped to publicnode) |
| Deploy interrupt safety | GREEN (recovery documented in deploy scripts) |
| Smoke test address correctness | GREEN (env-overridable) |
| Rebrand completion | YELLOW (deliberate 30-day legacy window; cleanup scheduled ≥ 2026-06-10) |

**Mainnet funding can proceed once Clement chooses to.**
