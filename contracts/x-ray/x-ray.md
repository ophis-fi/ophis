# Ophis Protocol X-Ray

## Executive summary

Ophis is a CoW Protocol integration that adds three Ophis-owned control planes around a vendored settlement baseline:

1. a timelocked allowlist guardian for solver governance;
2. a fee liquidator that sweeps settlement fees to an immutable Safe and consolidates them through owner-approved venues; and
3. a Safe vault policy module that lets a non-owner curator create tightly constrained CoW orders.

The highest-value assets are tokens held by the settlement and vault Safes, settlement solver authorization, Safe-to-relayer allowances, and CoW order presignatures. The most important trust boundaries are the external authenticator, Safe, Settlement/VaultRelayer, Chainlink feeds, approved liquidation venues, and ERC-20 implementations.

The Ophis-native contracts are compact and heavily tested. The main review pressure belongs on cross-contract authority: manager initialization and transfer, exact allowance lifecycle, presignature lifecycle, oracle freshness, leaky-bucket turnover, and fee-token behavior. The CoW settlement contracts are vendored upstream and should be tracked as a separately versioned dependency.

## Scope and provenance

- 27 Solidity source files, approximately 2,009 non-comment source lines.
- 125 Solidity test files.
- 1,129 repository commits were considered for temporal and ownership context.
- Ophis-native: `AllowListGuardian`, the modified allowlist authenticator, `OphisFeeLiquidator`, and the vault policy subsystem.
- Vendored baseline: `GPv2Settlement`, `GPv2VaultRelayer`, signing, transfer, interaction, arithmetic, and storage-access helpers.

## Architecture

The timelock can add solvers, rotate the guardian, or hand authenticator management elsewhere. The guardian can only remove solvers. Authorized solvers execute user-signed orders through the Settlement and its immutable VaultRelayer.

The fee liquidator never custodies assets. Its operations cause the Settlement to transfer fees to an immutable fee Safe or, for owner-only consolidation, approve an allowlisted venue for exact input amounts and then revoke those approvals.

The vault policy module never custodies assets either. It makes a Safe grant the settlement relayer an exact sell-token allowance and presign a policy-compliant CoW order. The immutable curator can rebalance or cancel only while it remains neither a Safe owner nor an enabled Safe module.

## Threat model

### Privileged actors

- **Timelock:** may add solver capability, rotate the guardian, and transfer authenticator management.
- **Guardian:** may immediately remove solver capability.
- **Authenticator manager / proxy admin:** may change manager and add or remove solvers.
- **Authorized solver:** may execute Settlement trades and arbitrary interactions subject to signed-order and settlement constraints.
- **Fee owner:** configures liquidator, venues, output tokens, sweeps, and consolidates.
- **Fee liquidator hot key:** may only sweep to the immutable fee Safe.
- **Vault curator:** may create and cancel policy-constrained orders; cannot remain a Safe owner/module.
- **Safe owners:** retain ultimate custody and module enable/disable authority.

### External dependencies

- CoW Settlement and VaultRelayer
- Safe module execution
- Chainlink price and optional sequencer uptime feeds
- ERC-20 metadata, balances, allowances, approvals, and transfer behavior
- Owner-approved consolidation venues

### Primary attack surfaces

- Uninitialized authenticator proxy or unsafe manager handoff
- Solver compromise and arbitrary Settlement interaction composition
- Non-standard, fee-on-transfer, rebasing, reverting, or callback-capable tokens
- Venue calldata that uses exact approvals in unintended ways
- Oracle stale/future timestamps, decimal normalization, and bounds
- Presignature/allowance drift across replacement and cancellation
- Turnover-cap leakage and timestamp boundaries
- Safe role changes that alter curator trust after deployment

## Temporal and git-weighted risk

Recent Ophis development is concentrated in the vault policy module and fee liquidator. The vault subsystem has received several hardening commits, making its oracle, allowance, UID, and cancellation paths both high-value and high-churn review targets. The fee liquidator is newer and should receive deployment-specific venue/token validation. The settlement baseline has a long upstream history; local changes should be minimized and upstream advisories monitored.

## Test and assurance posture

- Foundry compilation succeeds.
- The normal suite exercises hundreds of tests, including vault invariants.
- IR-based coverage executed 356 tests successfully and exposed one deployment-parameter assertion failure specific to the altered IR bytecode shape; this needs a non-IR confirmation and should not be treated as a protocol exploit by itself.
- Existing Medusa/Echidna configuration and Fizz artifacts cover allowlist governance and vault properties.
- Static analysis produced mostly repository-policy or inert nested-workflow findings; application findings require manual gating.
- No confirmed private credential was found in tracked content or the inspected history patterns. Matches resembling private keys were hashes, bytecode, fixtures, or deployment artifacts and were not printed.

## Documentation gaps

- The root contracts README primarily documents upstream CoW contracts rather than the Ophis extensions.
- Deployment runbooks should explicitly record proxy initialization atomicity, accepted token behavior, venue calldata constraints, oracle feed semantics, and incident procedures.
- The operational relationship among timelock, guardian, manager, proxy admin, fee owner, liquidator, curator, and Safe owners should be maintained as a single role matrix.

## Audit priorities

1. Prove exact allowance and presignature lifecycle invariants for every rebalance, supersession, cancellation, and revert.
2. Test fee-on-transfer, rebasing, callback, false-return, and approval-edge tokens against sweep/consolidation.
3. Verify authenticator proxies are initialized atomically and governance cannot accidentally transfer management to zero.
4. Validate oracle behavior at stale, future, sequencer recovery, decimal, and bound edges.
5. Review every approved consolidation venue and calldata encoder as part of deployment, not only the generic liquidator.
6. Keep vendored CoW code pinned and reconcile local changes against upstream releases and advisories.
