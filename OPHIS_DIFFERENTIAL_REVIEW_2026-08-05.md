# Ophis Differential Security Review

## Executive Summary

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 3 |
| Medium | 0 |
| Low | 0 |

**Overall risk after remediation:** Low
**Recommendation:** Proceed after the documented verification gates pass.

The branch changes value-transfer accounting by adding a config-driven
price-improvement fee to three sovereign deployments. The fee math itself uses
the existing CoW protocol-fee machinery, but two Ophis-specific integrations do
not yet preserve their required invariants.

**Key metrics:** 37 changed files; 8 production code/config files reviewed as
high or medium risk; 3 release-blocking integration gaps; no removed access
control, external call, or cryptographic validation.

## What Changed

**Commit range:** `origin/main..c4d3c643`
**Commit:** `c4d3c643 feat: adopt solver-aligned sovereign pricing`
**Diff:** 392 insertions, 234 deletions across 37 files.

The sovereign path changes from a 10/5/1 bps volume schedule to a 1 bp base plus
80% of reference-quote improvement on volatile pairs (30 bps cap), or 50% on
stable pairs (10 bps cap). Hosted-chain pricing is intended to remain unchanged.

## High Findings

### RESOLVED: Retired SDK sovereign paths had no capture policy

**Files:**

- `packages/sdk/src/partner-fee.ts:90`
- retired deployment configurations

**Blast radius:** every SDK order on the retired deployments.
**Test coverage:** SDK tests assert the 1 bp behavior but do not exercise either
backend policy.

The SDK placed two inactive chains in `SOVEREIGN_CHAIN_ID_SET`, reducing their
partner appData fee from 5 bps to 1 bp. Unlike Optimism, Unichain, and Robinhood,
their autopilot `[fee-policies]` sections remain empty. These routes therefore
receive the lower base without the intended improvement capture.

**Resolution:** the inactive chains were removed from the SDK, frontend,
backend, MCP surface, deployment artifacts, and infrastructure.

### RESOLVED: Config fee broke positional partner-fee attribution

**Files:**

- `infra/optimism-mainnet/configs/autopilot.toml:121`
- `infra/unichain-mainnet/configs/autopilot.toml.tmpl:126`
- `apps/rebate-indexer/src/partnerFees/fetch.ts:54`

**Blast radius:** all partner-attributed settlements on configured sovereign
feeds (high).
**Test coverage:** no changed indexer test; existing tests encode the opposite
invariant.

The rebate indexer only considers positional attribution money-safe when
`[fee-policies]` is empty. It documents that a config-driven fee is prepended to
the executed fee array and can shift appData partner-fee slots. This branch adds
exactly that config fee but does not change the indexer or its
`CONFIG_FEE_FREE_CHAINS` assertion.

**Attack/failure scenario:**

1. A partner submits an order containing an appData volume fee.
2. Autopilot prepends the new price-improvement policy to the executed protocol
   fee list.
3. The restricted feed returns both executed fees but only appData identifies
   partner recipients.
4. Positional parsing either rejects the row or, in the documented dropped-slot
   case, attributes Ophis's improvement revenue to the partner.
5. Monthly partner liabilities and payouts become incorrect.

This can be triggered through normal public order submission; it requires no
privilege or malformed data.

**Recommendation:** extend the restricted feed with policy origin/recipient
metadata and attribute by an explicit identifier, or otherwise separate
config-derived protocol fees from appData partner fees before the indexer sees
them. Remove the `config-fee-free` assertion only after end-to-end tests cover a
config price-improvement fee plus accepted and dropped partner entries.

### RESOLVED: Stable pricing was chain-blind outside Optimism

**Files:**

- `apps/backend/crates/app-data/src/app_data.rs:205`
- `apps/backend/crates/autopilot/src/domain/fee/mod.rs:419`
- `infra/unichain-mainnet/configs/autopilot.toml.tmpl:126`
- `infra/robinhood-mainnet/configs/autopilot.toml.tmpl:71`

**Blast radius:** every stablecoin order on Unichain and Robinhood Chain (high).
**Test coverage:** no test exercises the new override through `ProtocolFees` on
any chain; existing app-data tests cover only Optimism addresses.

`is_ophis_stable_pair` checks only `OPTIMISM_STABLECOINS`, but the same binary
and policy are deployed on Unichain and Robinhood Chain. Their canonical stable
tokens use different addresses. Those pairs therefore fall through to the 80%
/ 30 bps volatile policy instead of the published 50% / 10 bps stable policy.

**Failure scenario:** a user settles a USDG/USDG-like or future stable pair on
Robinhood Chain. Both token addresses fail the Optimism-only set lookup, so the
trade is charged under volatile capture. At 20 bps improvement on $100,000,
Ophis captures $160 instead of the promised capped $100, an excess $60.

**Recommendation:** make stable classification chain-aware and sourced from
per-deployment configuration. Do not use a union of cross-chain addresses,
because the same address can represent an unrelated token on another chain.
Add config parsing and end-to-end tests for all three deployments.

## Test Coverage Analysis

Existing targeted tests cover the 1 bp appData floor and frontend/SDK emission.
The new `apply_with_override` path and its stable selection have no direct unit
test. No rebate-indexer tests were updated even though its documented invariant
changed. These gaps elevate both findings to High.

## Blast Radius Analysis

| Changed behavior | Consumers | Risk |
| --- | --- | --- |
| Config price-improvement policy | autopilot, driver, settlement math, orderbook fee persistence, rebate feed | High |
| `is_ophis_stable_pair` | every config price-improvement policy application | High |
| Sovereign 1 bp appData base | frontend, SDK, orderbook ingress, autopilot defense-in-depth | Medium |

## Historical Context

The non-zero floor was introduced in prior partner-fee work and retained here;
no security check was removed. The indexer's config-fee-free invariant predates
this branch and explicitly warns that violating it is a money-path regression.

## Recommendations

### Immediate (blocking)

- [x] Make partner-fee attribution explicit and safe with config-derived fees.
- [x] Make stable-token classification chain-aware.
- [x] Remove inactive deployments from every supported-chain surface.
- [x] Add regression tests for both accounting cases.

### Before production

- [ ] Reconcile rebates and affiliate accounting with total realized protocol
  revenue under the new model.
- [ ] Add monitoring for realized capture factor, cap hits, and fee attribution
  mismatches by chain.

## Analysis Methodology

**Strategy:** surgical differential review of a large monorepo, following Trail
of Bits' `differential-review` workflow. All changed fee code/config was reviewed;
documentation and presentation files received a consistency scan. Techniques
included baseline diffing, git-history inspection, one-hop caller tracing, test
gap analysis, blast-radius analysis, and concrete failure modeling.

**Limitations:** no live deployment or mainnet settlement was exercised; external
CoW infrastructure was treated as an existing dependency.
**Confidence:** high for the three reported integration findings; medium overall.

## Independent and Dependency Review

Codex review independently reproduced the stable-classification finding and
identified the inactive-chain policy mismatch. Pashov's Solidity auditor had
no applicable branch delta (`git diff origin/main..HEAD -- '*.sol'` is empty).

`pnpm audit --audit-level high` reported seven advisories: one high, five
moderate, and one low. The high advisory is `GHSA-3gc7-fjrx-p6mg` in
`bigint-buffer@1.1.5`, transitively introduced by Coinbase AgentKit's Solana
dependencies; the registry lists no patched version. `cargo audit` reported no
vulnerability error, with allowed warnings for `event-listener` 5.4.1
(`RUSTSEC-2026-0221`, unsound) and yanked `spin` 0.9.8/0.10.0.
