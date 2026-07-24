# Robinhood Chain (4663) sovereign deploy ceremony

This is the one-time ceremony that deploys the Ophis GPv2 contracts on Robinhood
Chain and hands their authority to the 2-of-3 protocol Safe. It is the highest-risk
script in the whole port: it deploys the contracts that will custody user funds and
irreversibly transfers control of the solver allowlist. Run it deliberately, with
the Ledger, after the gates below.

## What it produces

A sovereign CoW deployment on 4663: a `GPv2Settlement` (the contract that executes
and settles trades), a `GPv2VaultRelayer` (pulls the seller's tokens), a
`GPv2AllowListAuthentication` proxy + implementation (the on-chain list of who may
submit settlements), and three helper contracts (Balances, Signatures,
HooksTrampoline). At the end, only the 2-of-3 Safe can add/remove solvers or upgrade.

## The flow (what `deploy-mainnet-all.sh` does)

1. **Preflight.** Loads `.env`, confirms the RPC is really chain 4663, and validates
   the target Safe on-chain: it must have code, a threshold of 2, exactly 3 owners,
   and (if `OPHIS_SAFE_EXPECTED_OWNERS` is set) the exact expected owner set. This is
   the guard against handing authority to a typo'd or wrong-chain address, since
   `setManager` has no zero-address check. Then it checks the Ledger deployer and the
   submitter EOA are both funded, and asks you to type "yes" to confirm the Safe.
2. **[1/4] GPv2 core** via `hardhat deploy` (Ledger-signed): Settlement, VaultRelayer,
   and the Auth proxy + implementation. Addresses are read back from the hardhat-deploy
   artifacts.
3. **[2/4] Helpers** (Balances, Signatures, HooksTrampoline) via `cast send --create`
   (Ledger). HooksTrampoline is constructor-wired to the Settlement.
4. **[2.5 GATE] Bytecode integrity.** Prints the codehashes of the immutable-free
   contracts (Auth impl, Balances, Signatures) for an exact match against the OP/Unichain
   deployed equivalents, and the wiring getters for the immutable-bearing ones
   (Settlement.authenticator / vaultRelayer / vault / domainSeparator, HooksTrampoline.settlement,
   proxy impl slot). The script auto-asserts the wiring and pauses for a ToB + Codex
   review before any solver gets authority. This is the money-path gate.
5. **[3/4] addSolver(submitter)** so the driver-submitter EOA can land settlements.
6. **[4/4] Transfer authority.** `transferOwnership(Safe)` then `setManager(Safe)`, in
   that order so an interrupted state leaves the Safe with strictly more power than the
   Ledger. Verifies owner == manager == Safe. Appends the deployed addresses to `.env`
   and prints the fill map for the config placeholders.

## Prerequisites (fill before running)

- `infra/robinhood-mainnet/.env` with:
  - `ROBINHOOD_MAINNET_RPC` (defaults to the public RPC).
  - `ROBINHOOD_SUBMITTER_ADDR` = the NEW per-chain submitter EOA address (its private
    key lives Tier-1-isolated on the stack host, never in this repo). Fund it ~0.02 ETH on 4663.
  - `OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET` = the 2-of-3 Safe on 4663. Deploy it with
    protocol-kit (the Safe 1.3.0/1.4.1 factories are present on 4663; the hosted Safe UI
    likely does not index the chain yet).
  - `OPHIS_SAFE_EXPECTED_OWNERS` (strongly recommended) = the 3 owner addresses.
  - Optionally `OPHIS_EXPECTED_CODEHASH_{AUTHIMPL,BALANCES,SIGNATURES}` to machine-assert
    the bytecode gate instead of relying on the human ToB diff.
- The Ledger (OPHIS_HW_WALLET `0xBeC5...0199`) funded ~0.02 ETH on 4663, connected, Ethereum app open, Ledger Live closed.
- The `robinhood-mainnet` hardhat network (chainId 4663) - already added to
  `contracts/hardhat-megaeth.config.ts` in this PR.

## Arbitrum Orbit deltas vs the OP-Stack (Unichain) ceremony

This is where an OP-Stack runbook would bite you:

1. **Gas.** Robinhood is Arbitrum Nitro. `eth_estimateGas` includes an L1-calldata
   component, and block gas limits are ~1.1B. The OP ceremony hardcoded `--gas-limit`
   values sized for OP's 60M blocks; those can be too LOW for a large contract deploy
   here. This script omits `--gas-limit` and lets cast/hardhat estimate. If the
   hardhat proxy deploy still hits out-of-gas, set `OPHIS_AUTH_PROXY_GAS_LIMIT` (read by
   `001_authenticator.ts`) high enough for ArbGas.
2. **Balancer V2 vault** is likely undeployed on 4663. The Settlement stores the
   canonical vault address as an immutable but never calls it unless a Balancer
   interaction runs (baseline/LiFi do not), so deploy + wiring still pass. Confirm the
   vault has code before ever adding a Balancer-routing solver.
3. **Safe hosted service** likely does not index 4663 - operate the Safe via protocol-kit / CLI.
4. **WETH** is `0x0Bd7D308...cAD73` (not the OP `0x4200..0006`); relevant for the frontend and a later EthFlow deploy, which is deferred here.

## After the ceremony

Fill the printed addresses into `configs/*.toml.tmpl` (replacing the
`__FILL_AFTER_DEPLOY_*__` placeholders), then `./render-configs.sh` and `./compose-up.sh`.

## Governance follow-up

Launched DIRECT-TO-SAFE (no Timelock). Fine for the single-lane, low-TVL Phase-0, but
before meaningful TVL or the public frontend flip, deploy the 24h TimelockController +
AllowListGuardian and migrate Auth ownership/manager to them (the OP post-launch model).
