# Phase 1 Audit — Ophis HyperEVM Smart Contracts

**Date:** 2026-05-17
**Scope:** 7 contracts deployed to HyperEVM (chain 999), all under Ophis control
**Tools:** codex/codex-cyber, sharp-edges-analyzer, function-analyzer, slither, bytecode-parity via foundry/hardhat compile
**Auditor:** Claude Code (multi-agent)
**Status:** complete — no CRITICAL fund-loss bugs survived verification; HIGH items below should be addressed before scaling TVL

## Contracts in scope

| Contract | Address | Bytecode | Source |
|---|---|---|---|
| GPv2Settlement | `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce` | 16,166 B | cowprotocol/contracts @ c6b61ce |
| GPv2VaultRelayer | `0x842F655C9310C32e5932A0eBFa80c4Cd358c0205` | 4,591 B | cowprotocol/contracts @ c6b61ce |
| GPv2AllowListAuth (Proxy) | `0x9eFDcC2770Af6837B285702d386D558BD1066BA8` → impl `0xfab54856b6731bc0c32904be5297a627d9fdfa31` | 2,467 B / 3,600 B | cowprotocol/contracts @ c6b61ce |
| Balances (sim helper) | `0x764fe4aa1ff493cf39931c7923c8ff5837596504` | 3,827 B | cowprotocol/services |
| Signatures (sim helper) | `0xe4137bd2ecfdfb96d80629ec254dadec71bc498c` | 1,828 B | cowprotocol/services |
| HooksTrampoline | `0x29fcdbbdffd12fa7724b863991355b82ba8380e2` | 1,013 B | cowprotocol/hooks-trampoline |
| CoWSwapEthFlow | `0xd031Ce1C577caD1530BD8283CaA6a6a106A5b61B` | 6,178 B | cowprotocol/ethflowcontract @ 762d182 |

## Bytecode parity verdict

| Contract | Verdict | Notes |
|---|---|---|
| GPv2Settlement | ✅ MATCH | Two immutables verified: `authenticator = 0x9eFD…` and EIP-712 domainSeparator = `0x2d4dc358…` (independently recomputed for chain 999) |
| GPv2VaultRelayer | ✅ MATCH | Constructor immutable = Settlement address |
| GPv2AllowListAuth IMPL | ✅ EXACT MATCH | Byte-identical including CBOR IPFS hash — strongest possible parity |
| HooksTrampoline | ✅ MATCH | Settlement-address immutable verified |
| CoWSwapEthFlow | ✅ MATCH | WHYPE address (`0x5555…`) + domain separator immutables verified; only CBOR IPFS hash differs (benign — different build machine) |
| Balances | ⚠️ DEFERRED | Build settings not reproducible (Rust-workspace codegen); pure simulator, no security surface |
| Signatures | ⚠️ DEFERRED | Same as Balances |

**No bytecode-substitution attacks present.** All security-critical contracts compile byte-identical from upstream open source.

## Resolved during verification (NOT findings)

- **EIP-1271 cross-chain replay** — `CoWSwapEip712.domainSeparator()` reads `chainid()` via assembly at runtime (ethflowcontract/src/libraries/CoWSwapEip712.sol:34-39). Chain 999 is baked into the EthFlow domain separator. Mainnet/OP signatures cannot replay on HL.
- **Settlement domain separator** — Independently recomputed `keccak256("EIP712Domain" || "Gnosis Protocol" || "v2" || 999 || 0x0864…BFce)` = `0x2d4dc358e6dd494e8a80abd1f4c1168de87d5530f25be4d22f83a9d671fd5e7f`, present at byte 4894 of deployed bytecode. ✅
- **AllowList authenticator wiring** — `Settlement.authenticator() == 0x9eFD…BA8` (the proxy). ✅
- **Solver allowlist** — `AllowList.isSolver(0xFB30…1bB5a) == true`. ✅
- **`unwrap()` refund DoS** (initially flagged CRITICAL) — REFUTED. `_invalidateOrder` (ethflowcontract/src/CoWSwapEthFlow.sol:230-236) reads `address(this).balance` AFTER any prior unwrap, and the `if (address(this).balance < refundAmount)` branch correctly skips the withdraw step. Refund proceeds from native balance. Function-analyzer's claim was incorrect.

---

## Findings (severity-ranked, deduplicated)

### [HIGH-1] Single 2-of-2 Safe controls proxy admin + manager + has no recovery + no timelock

**Location:** AllowListAuth Proxy `0x9eFDcC27…6BA8` — EIP-1967 admin slot AND `manager()` both = Safe `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` (2-of-2, Safe 1.4.1).

**Risk:** Loss of either Ledger seed = governance permanently bricked (no upgrade, no addSolver, no removeSolver). Compromise of both = `upgradeTo(maliciousImpl)` drains every outstanding VaultRelayer approval in one tx. Same Safe controls upgrade AND solver allowlist — no privilege separation.

**Mitigation:**
1. Migrate to 2-of-3 Safe with third independently-stored signer (already tracked as task #104 — complete BEFORE scaling TVL).
2. Insert `TimelockController(minDelay=24h)` between Safe and proxy admin via `changeAdmin`.
3. Separate proxy admin (slow Safe) from auth manager (operational Safe).
4. Add Telegram alert on any `Upgraded(address)` proxy event.

**Confidence:** high. Cross-confirmed by sharp-edges + bytecode-parity agents.

---

### [HIGH-2] WHYPE (`0x5555…5555`) not formally verified as WETH9-clone

**Location:** Constructor `CoWSwapEthFlow.sol:46` (approves WHYPE for MAX_UINT256), `wrap()` line 62-73 (low-level call to WHYPE, **discards success**), `_invalidateOrder` line 235 (calls `withdraw(uint256)`).

**Risk:** EthFlow makes 4 strong assumptions about WHYPE:
- `approve(address,uint256)` returns true and doesn't revert.
- `deposit()` via fallback works on bare-value call.
- `withdraw(uint256)` exists and transfers HYPE back.
- Balance is at storage slot 3 (used by orderbook's Spardose balance-overrides).

If WHYPE diverges (fee-on-transfer, blacklist, paused state, slot mismatch, gas-griefing fallback), the consequences range from silent settlement failures to refund deadlock.

**Mitigation:**
1. Compare WHYPE runtime bytecode codehash against canonical WETH9 and pin the result.
2. Deploy-time integration test: deposit, transfer, withdraw 1 wei through Settlement on a forked HL state.
3. `cast storage 0x5555… 3` to confirm slot-3 balance layout.
4. Telegram alert on any `EthTransferFailed` event from EthFlow.

**Confidence:** medium-high. Cross-confirmed by sharp-edges + function-analyzer.

---

### [HIGH-3] Driver-submitter PK readable from any process running as user `scep`

**Location:** `~/greg/infra/hyperevm-mainnet/rendered/driver.toml` (chmod 600) contains the plaintext PK. Source: `.env` (chmod 600) sourced by `render-configs.sh`, with a Keychain copy at `<keychain-service>`.

**Risk:** Submitter EOA `0xFB30…1bB5a` is the SOLE allowlisted solver-submitter. Stealing it = arbitrary settle dispatch. No on-chain slashing protects against rogue settles. Any local process running as `scep` (compromised npm postinstall, browser, dormant OpenClaw remnant) can read the rendered TOML or `.env`.

**Mitigation:**
1. Move PK to AWS KMS / GCP Cloud HSM / YubiHSM and patch driver to sign via remote-signer RPC.
2. Document key-rotation runbook: `addSolver(new) → removeSolver(old)` from Safe, tested quarterly.
3. Cap submitter throughput in autopilot (max N settles/hour) to bound bleed-out window.
4. Telegram alert on any settle tx whose `tx.to ≠ 0x0864…BFce`.

**Confidence:** high.

---

### [HIGH-4] `max-settlement-transaction-wait` defaults to 60s while `submission-deadline = 60 blocks` ≈ 60s

**Location:** `infra/hyperevm-mainnet/configs/autopilot.toml.tmpl:70` (submission-deadline = 60). `apps/backend/crates/configs/src/autopilot/run_loop.rs:22-24` (max-settlement-transaction-wait defaults to 1 min, NOT overridden in TOML).

**Risk:** Submit at block N. Autopilot stops watching at N+60 (~60s). Default wait also expires at 60s. Tx landing at N+61 → autopilot recorded auction as failed, competing solver may have won next auction, late tx wastes gas and produces split state. HL's dual-block model (small 1s, big 60s) means complex settlements may hit big-block jitter > 60s.

**Mitigation:** Set explicitly `max-settlement-transaction-wait = "120s"` so it strictly exceeds `submission-deadline × block-time`. Also track p99 settle inclusion latency in Prometheus; alert if > 50s.

**Confidence:** medium-high.

---

### [HIGH-5] Single submission RPC (PurroofGroup) for ALL settlements — SPOF

**Location:** `infra/hyperevm-mainnet/configs/driver.toml.tmpl:83-93` deliberately bypasses eRPC fan-out, pins submission to one upstream.

**Risk:** PurroofGroup down/rate-limited/stale-nonce-erroring → every settlement stalls. No fallback. On a 60s submission window, a 30s upstream stall halves effective budget.

**Mitigation:** Either (a) add second `[[submission.mempool]]` upstream with stale-nonce-aware failover, OR (b) configure eRPC `sticky-by-from-address` to pin submitter EOA to one upstream while failing over on full outage. Re-verify nonce-race fix in commit 5f707d09d holds.

**Confidence:** high.

---

### [HIGH-6] Malicious solver could drain Settlement WHYPE buffer via `executeInteractions`

**Location:** GPv2Settlement.sol:446-466. Forbidden-target list contains only `vaultRelayer` — does NOT block `address(this)` (Settlement itself) or `wrappedNativeToken`.

**Risk:** A compromised allowlisted solver injects interaction `WHYPE.approve(self, MAX) + WHYPE.transferFrom(Settlement, self, balance)`. Settlement holds the wrapped-HYPE buffer between `vaultRelayer.transferFromAccounts` (L134) and `vault.transferToAccounts` (L138) for ERC20-leg trades. The malicious solver drains accumulated buffer. Mitigation upstream: solver allowlist. On HL, solver set is new and small (2 solvers) — allowlist is the only defense, and there is no slashing.

**Mitigation:** Add `wrappedNativeToken` to the forbidden-target list in a patched Settlement (requires redeploy). OR commit to never adding an unknown solver before economic-security collateral is in place. OR cap per-batch buffer accumulation in a wrapper contract.

**Confidence:** medium (contingent on solver compromise).

---

### [MEDIUM-1] `unwrap()` is permissionless — settlement-DoS griefing vector

**Location:** CoWSwapEthFlow.sol:76-78. `function unwrap(uint256 amount) external { wrappedNativeToken.withdraw(amount); }` — no access control.

**Risk:** Attacker frontruns a pending settlement with `unwrap(WHYPE.balanceOf(EthFlow))`, dropping the WHYPE balance to 0. Solver's `vaultRelayer.transferFrom(EthFlow, …, sellAmount)` reverts because WHYPE balance was drained. **Refund is NOT impacted** (refund logic correctly reads `address(this).balance` and skips withdraw when native balance is sufficient).

**Mitigation:** Solvers MUST include `wrapAll()` as a pre-interaction in their settle bundle (standard CoW solver-cookbook practice). Document this requirement in the solver onboarding doc. Alternatively: gate `unwrap` to a role-based modifier (requires redeploy of EthFlow).

**Confidence:** high.

---

### [MEDIUM-2] `wrap()` ignores call success

**Location:** CoWSwapEthFlow.sol:66-73 — `(bool success, ) = …; success;` is a no-op.

**Risk:** If WHYPE's fallback ever reverts / runs out of gas / returns false, `wrap` silently "succeeds". User's HYPE stays native, settle transferFrom reverts. Refund path still works (it reads native balance) so funds are not lost — but UX is broken silently.

**Mitigation:** Replace `success;` with `require(success, "WHYPE deposit failed")`. Requires redeploy of EthFlow.

**Confidence:** high.

---

### [MEDIUM-3] Frontend MegaETH chain ships zero-EthFlow sentinel; UX bug at signing time

**Location:** `apps/frontend/libs/common-utils/src/cowProtocolContracts.ts:25-31`. `OPHIS_MEGAETH_ETH_FLOW = 0x000…000`.

**Risk:** Native-ETH-sell UX on MegaETH appears to work in the UI, fails at signing time. Confusing for users. Also possible chain-mismatch where MetaMask presents the OP Settlement address as the target on a MegaETH session if SDK falls back.

**Mitigation:** Until MegaETH EthFlow is live, add a runtime assertion in `getQuote()` that throws early when `ETH_FLOW_ADDRESSES[chainId] === ZeroAddress` for a chain where the user is attempting native sell. Mirror the guard for chains 999 and 10 to prevent regressions.

**Confidence:** medium.

---

### [MEDIUM-4] Deploy script `gasLimit = 25M` would fail on a 3M small-block

**Location:** `contracts/src/deploy/001_authenticator.ts:18-23`. HL big-block cap = 30M, small-block = 3M.

**Risk:** If the deployer EOA ever loses big-block opt-in (e.g. HyperCore stake change), the 25M gasLimit deploy attempts a 25M tx against a 3M small-block limit → "intrinsic gas too high" → mid-deploy lockout. Not yet exploited because deploy already happened, but matters for any redeploy.

**Mitigation:** Pre-flight assertion in `deploy-mainnet-all.sh` that queries `latest.gasLimit` and refuses to proceed if < 25M on chain 999. Reduce `gasLimit` to empirical worst case (~6M for the proxy deploy) with env override.

**Confidence:** medium.

---

### [MEDIUM-5] `gas-price-cap = 10 gwei` is a static absolute, decoupled from basefee

**Location:** `infra/hyperevm-mainnet/configs/driver.toml.tmpl:74-81`.

**Risk:** HL basefee spike (airdrop claim, oracle bloat, congestion) > 10 gwei → every settle silently fails to land. Auctions stall. Mirrors the inverse of `feedback_evm_deploy_hygiene` (don't pin gas below basefee).

**Mitigation:** Switch to multiplier-of-basefee if driver supports it (e.g. `5×`); otherwise raise static cap to 100 gwei (still bounded ~$0.50/settle at HL max gas) and add Prom alert if observed basefee > 30 gwei.

**Confidence:** medium.

---

### [MEDIUM-6] `eip1271-skip-creation-validation = true` is global on orderbook

**Location:** `infra/hyperevm-mainnet/configs/orderbook.toml.tmpl:2`.

**Risk:** Skipping creation-time EIP-1271 validation against a smart-contract wallet's current state allows the SCW to mutate between order creation and settle. Settle re-validates so direct fund loss requires a separate Settlement regression, but quote staleness and surprise reverts are likely.

**Mitigation:** Set `eip1271-skip-creation-validation = false` and accept the latency hit. If perf matters, allowlist specific known-good SCW codehashes.

**Confidence:** medium.

---

### [MEDIUM-7] AllowListAuth IMPL `initializeManager` callable post-deploy

**Location:** Implementation `0xfab54856…fa31`. Slither flagged "unprotected-upgrade" pattern.

**Risk:** Anyone can call `initializeManager(self)` on the implementation directly, then call `simulateDelegatecallInternal` with SELFDESTRUCT — IF the chain is pre-Cancun. **HL is post-Cancun (EIP-6780)** → SELFDESTRUCT no longer wipes bytecode → attack neutralized. But manager state on the impl is dirty, which is unhygienic.

**Mitigation:** One-time hygiene tx: call `initializeManager(0xe049…01cF)` on the IMPL directly (cost ~30k gas). Locks the IMPL.

**Confidence:** high (impact bounded by EIP-6780).

---

### [MEDIUM-8] HooksTrampoline `revertByWastingGas()` infinite-loop pattern

**Location:** `hooks-trampoline/src/HooksTrampoline.sol:65-68, 88-90`.

**Risk:** Malicious user hook with `gasLimit > gasleft()*63/64` consumes the settle's entire gas budget, settlement reverts, solver bears the gas cost. On HL with 30M big-block cap and 3M small-block, even single malicious hooks can wipe a batch. Multi-auction griefing campaign possible against solver's HYPE balance.

**Mitigation:** Driver-side preflight: refuse hooks with declared `gasLimit > 2_500_000` on chain 999 (since `tx-gas-limit = 2_900_000`). Existing `disable-access-list-simulation = false` already partly addresses.

**Confidence:** medium.

---

### [MEDIUM-9] `submission-deadline = 60` tuned for current HL block time, no automatic adaptation

**Location:** `autopilot.toml.tmpl:60-70`.

**Risk:** HL bumps block time to 2s or drops to 500ms → 60 blocks becomes either too tight or too loose. Discovered only via 2am auction-failure logs.

**Mitigation:** Convert deadline to seconds in the runbook. Add Prom metric `chain_block_time_p50` and alert if drifts > 25%.

**Confidence:** medium.

---

### [LOW-1] HYPERSWAP_V3_SUBGRAPH_URL empty-string falls back to default

**Location:** `render-configs.sh:53` uses `:=` (substitutes on unset OR empty).

**Risk:** Operator sets `HYPERSWAP_V3_SUBGRAPH_URL=` to disable HyperSwap V3 routing during Ormi outage, gets the Ormi default re-injected, baseline returns NoSolutions, users see "no liquidity".

**Mitigation:** Add sentinel `__disabled__` that comments out the `[[liquidity.uniswap-v3]]` block, OR split into `HYPERSWAP_V3_ENABLED` + URL vars.

**Confidence:** low.

---

### [LOW-2] Deploy script lacks atomic deploy-init verification

**Location:** `infra/hyperevm/deploy/deploy-mainnet-all.sh:127-169`.

**Risk:** If proxy deploy + `initializeManager` are two separate txs and the init tx fails/drops, anyone can race-call `initializeManager(attacker)` and become manager. Currently theoretical — deploy already succeeded — but matters for any future redeploy.

**Mitigation:** Between proxy deploy and step 3, `cast call manager()` and assert it equals expected deployer; abort and redeploy otherwise. Better: factory-based atomic deploy+init.

**Confidence:** medium for future redeploys.

---

### [INFO] Settlement non-upgradeable — emergency response is `removeSolver` not `pause`

If a critical bug is ever found in CoW core Settlement logic, the only kill-switch is `Safe.removeSolver(*)` from the AllowList, which halts settlements. Users must then individually revoke VaultRelayer approvals. **Document this runbook explicitly and drill quarterly on Sepolia.**

### [INFO] solc 0.7.6 on cow-contracts

Known bugs of 0.7.6 do NOT affect this codebase. Plan migration to 0.8.30+ for any future Ophis-custom Settlement variants.

### [INFO] HL 1s block time tightens timing-edge cases

`validTo` boundary checks (`>=`) on 1s blocks have second-level resolution. Encourage frontend to default `validTo ≥ block.timestamp + 30s`.

### [INFO] EthFlow `wrap`/`wrapAll`/`unwrap` are permissionless

Composes with the MEDIUM-1 finding. Solver onboarding doc must require `wrapAll()` pre-interaction.

### [INFO] Submitter balance = 0.498 HYPE = ~1600 settlement-headroom

At HL typical 1 gwei × 300k gas. Verify against Phase 2 expected settlement volume; top up if more than ~1000 settlements anticipated.

### [INFO] AllowListAuth proxy admin == auth manager (separate finding, in HIGH-1 above)

For completeness: both EIP-1967 admin slot and `manager()` resolve to the same Safe. No privilege separation.

---

## Verdict

**No CRITICAL fund-loss bugs survived verification.** Bytecode parity confirmed for the 5 security-critical contracts (Balances/Signatures deferred but are pure simulators). All public functions reviewed; no novel logic bugs beyond CoW upstream's audited risk model.

**Top three actions before scaling TVL:**

1. Complete 2-of-3 Safe migration (task #104) and add a 24h Timelock as proxy admin.
2. Migrate driver-submitter PK to a remote signer (KMS or HSM).
3. Lock down the AllowListAuth IMPL with a one-time `initializeManager(Safe)` call.

**Three operational items to ship in the next infra PR:**

4. `max-settlement-transaction-wait = "120s"` explicit in autopilot.toml.tmpl
5. Second `[[submission.mempool]]` upstream OR sticky-eRPC routing
6. Driver-side gas-cap relative to basefee (or static raise to 100 gwei)

**One Solidity fix worth a future EthFlow redeploy:**

7. `require(success, "WHYPE deposit failed")` in `wrap()`, gate `unwrap()` to a role (or accept the MEDIUM-1 griefing surface as-is).

Phases 2-5 (backend stack, frontend, infra, Optimism + MegaETH rollover) can proceed in parallel with these.
