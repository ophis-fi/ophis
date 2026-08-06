# Optimism Uniswap V4 Differential Security Review

## Executive Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

**Overall residual risk:** Low within the deliberately narrow ETH/USDC lane. The change is intrinsically high-risk because it adds value transfer, an external PoolManager callback, and a new driver authorization path.

**Recommendation:** Conditional approval. The reviewed implementation has no open findings, but merge remains conditional on the repository CI/CodeQL/Dependabot gates, independent Codex review, deterministic deployment verification, and post-deploy fork/code checks.

**Key metrics:**

- 14 implementation/config/test/deployment-artifact files reviewed against `origin/main` at `7a6feac0`.
- 100% of new authorization, callback, allowance, pool-key, and quote-error paths reviewed.
- 6 live Optimism fork tests pass, including 256 fuzz cases.
- 2 focused driver tests and the solver quote-error classification test pass.
- No security validation was removed from the baseline.

## What Changed

The Robinhood-only V4 solver was generalized to support one additional, fully pinned deployment on Optimism. A new immutable adapter serves only the canonical native ETH/USDC hookless 0.05% pool. The driver receives a selector-scoped exception tied to the fulfillment's assets and amounts. Infrastructure adds the dedicated solver service and a hash-pinned browser deployment ceremony.

| Area | Risk | Blast radius |
|---|---|---|
| `OphisHooklessUniswapV4Adapter.sol` | High | One new deterministic contract; Settlement-only caller |
| Driver custom-interaction validator | High | One new protected target in the existing validation choke point |
| Solver/config generalization | Medium | Existing Robinhood lane plus new Optimism lane |
| Compose/config/ceremony | Medium | Optimism deployment only |
| Fork/unit tests | Low | Test-only |

Historical baseline: the adapter/callback design derives from the Robinhood V4 lane introduced by `a3809851` (`feat(robinhood): add direct Uniswap V4 solver lane`). The existing Robinhood contract, artifact, address, and configuration remain unchanged.

## Critical Findings

No Critical or High findings remain.

The review did identify and close two issues before this report:

1. Chain-dependent Robinhood defaults could have been inherited accidentally by an Optimism config. All deployment and pool-key fields are now mandatory and checked against exact per-chain pins.
2. Quoter execution reverts were initially generic RPC failures. They are now `NotFound` only for execution-revert error shapes, allowing partial-fill reduction while preserving transport failures as operational errors.

## Test Coverage Analysis

Covered security properties:

- only the immutable Settlement can enter `swapExactInput`;
- direct or forged `unlockCallback` calls fail;
- callback payload is committed before PoolManager unlock and cleared after success;
- hooks are fixed to zero and fee/tick spacing are immutable;
- output always returns to Settlement;
- both WETH→USDC and USDC→WETH execute on a live Optimism fork;
- impossible output floors revert atomically without losing input;
- adapter retains no WETH, USDC, or native ETH after successful swaps;
- driver rejects wrong selectors, wrong output declarations, wrong spender/allowance, unlimited allowance, internalization, and pre/post use;
- DTO fulfillment context covers the new protected target;
- quote reverts and transport failures remain distinct.

Commands exercised:

```text
OP_MAINNET_RPC=https://mainnet.optimism.io forge test --match-path 'test/OphisHooklessUniswapV4Adapter/*.t.sol' ...
cargo test -p driver uniswap_v4_swap_is_pair_selector_and_fulfillment_scoped --lib
cargo test -p driver protected_optimism_interactions_receive_fulfillment_context --lib
cargo test -p solvers execution_reverts_are_unavailable_routes_but_transport_errors_are_not --lib
cargo check -p solvers
docker compose ... config --no-interpolate --quiet
```

The unrelated pre-existing Plasma script/test struct-constructor errors prevent an unfiltered `forge test` of the entire contracts tree. The V4 target is compiled and tested with those unrelated paths excluded.

## Blast Radius Analysis

The contract has one public value-transfer entry point and one PoolManager callback. Its external call graph is:

```text
Settlement -> adapter.swapExactInput
  -> token.transferFrom
  -> WETH.withdraw (WETH-in only)
  -> PoolManager.unlock -> adapter.unlockCallback
       -> PoolManager.swap
       -> PoolManager.settle/take
  -> token transfer or WETH.deposit/transfer -> Settlement
```

The driver change is reached only for target `0xd882...2Ddc` on chain 10. The target is intentionally excluded from the generic address allowlist, so arbitrary pre/post calls remain rejected. The protected DTO path requires exactly one fulfillment and one protected interaction.

## Historical Context

- No prior security check was removed.
- The new contract is separate from `OphisUniswapV4Adapter`, preserving the bytecode and deterministic deployment of the live Robinhood lane.
- Existing custom-interaction hardening patterns for f(x), Curve, and WOOFi were followed: selector scoping, declared input/output equality, fulfillment bounds, exact spender/allowance, zero native value, and no internalization.

## Adversarial Analysis

**Malicious solver:** attempts to encode an arbitrary adapter call, lie about output, overstate allowance, or use the target as a pre/post interaction. The driver rejects each shape before settlement encoding.

**External caller:** calls `swapExactInput` directly to steal Settlement funds. The immutable `msg.sender == settlement` check rejects the call before token transfer.

**Forged callback caller:** calls `unlockCallback` with chosen deltas. Both PoolManager caller authentication and the active callback hash are required.

**Malicious hook/pool creator:** cannot substitute a hook or alternate pool. `hooks`, currencies, fee, and tick spacing are immutable in deployed bytecode and independently pinned in solver configuration.

**Reentrant token/callback:** the supported tokens are canonical Optimism WETH and USDC, and the callback commitment prevents nested unlock entry. The adapter has no owner/admin state to corrupt.

## Sharp-Edges Review

- Zero addresses, dynamic fees, nonpositive/out-of-range tick spacing, zero amounts, and oversized signed amounts fail closed.
- There are no security-disabling booleans or permissive chain defaults.
- The config loader rejects every contract/pool-key value except the exact reviewed deployment for its chain.
- The browser ceremony refuses wrong chain, wrong wallet, artifact/hash mismatch, occupied address, absent CREATE2 deployer, unexpected address, or anomalous gas estimate before requesting a signature.

## Verity

The repository's existing Verity/Lean `AllowListGuardian` proof suite builds successfully with no `sorry`/`admit`. Those proofs establish solver-manager access-control invariants and are unchanged by this lane. Honest limitation: the new adapter is not represented by the existing Verity model; its callback and value-flow properties are covered by code review, live fork tests, fuzzing, and the pending independent review rather than a new Lean proof.

## Recommendations

### Blocking before merge/deploy

- [ ] Independent Codex 5.6 Sol review reports no blocking finding.
- [ ] GitHub CI, CodeQL, and dependency gates are green.
- [ ] Deploy exactly the hash-pinned artifact to the predicted address.
- [ ] Verify deployed runtime code and all six immutables on Optimism.

### Post-deploy

- [ ] Start the solver only after `eth_getCode` confirms the adapter.
- [ ] Verify solver, driver, and orderbook health/restart counts.
- [ ] Observe quote/solve/rejection metrics before expanding beyond ETH/USDC.

## Analysis Methodology

**Strategy:** Surgical/high-risk differential review for a large monorepo.

Techniques applied: baseline/history comparison, complete changed-code review, one-hop call tracing, concrete attacker models, validation-pattern comparison, blast-radius assessment, live on-chain quote/liquidity checks, fork testing, fuzzing, configuration misuse probing, deterministic deployment derivation, and Verity build reproduction.

Limitations: no formal model was added for the adapter, full contracts-tree Foundry execution is blocked by unrelated pre-existing Plasma compile errors, and production behavior cannot be observed until the deterministic deployment and stack rollout occur.

**Confidence:** High for the reviewed ETH/USDC scope; no claim is made for arbitrary V4 hooks, pools, multihop routes, or tokens.
