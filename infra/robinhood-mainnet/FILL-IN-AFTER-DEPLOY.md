# Fill-in after the Robinhood (4663) deploy ceremony

The config templates ship with `__FILL_AFTER_DEPLOY_*__` placeholders for every
address the sovereign GPv2 deploy produces. `render-configs.sh` refuses to render
while any placeholder remains, so fill them all before first start.

## Prerequisite: the deploy ceremony (next deliverable)

This scaffold is the runtime stack. The GPv2 + governance ceremony (`deploy/`, the
Ledger direct-to-Safe flow adapted from `infra/unichain-mainnet/deploy/`) is a
separate follow-up. Orbit deltas for that ceremony:

- **WETH = `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`** (NOT the OP `0x4200..0006`).
- **Gas model:** Arbitrum ArbGas + L1-calldata pricing, ~1.1B gas limits - re-check the
  `001_authenticator.ts` gas overrides (the OP-Stack "25M auth-proxy default" assumption
  does not carry over).
- **Safe:** 1.3.0/1.4.1 factories are present on 4663, so protocol-kit can create the 2-of-3
  Safe even though the hosted Safe UI likely does not index 4663 yet.
- **CREATE2 deployer present**, so deterministic GPv2 addresses work as on Unichain.

## Placeholders to replace (from the ceremony output)

| Placeholder | Files | Source |
|-------------|-------|--------|
| `__FILL_AFTER_DEPLOY_SETTLEMENT__` | orderbook, autopilot, driver, lifi | deployed `GPv2Settlement` |
| `__FILL_AFTER_DEPLOY_BALANCES__` | orderbook, autopilot, driver | deployed Balances helper |
| `__FILL_AFTER_DEPLOY_SIGNATURES__` | orderbook, autopilot, driver | deployed Signatures helper |
| `__FILL_AFTER_DEPLOY_HOOKS__` | orderbook, autopilot | deployed HooksTrampoline |
| `__FILL_AFTER_DEPLOY_SUBMITTER_EOA__` | autopilot (`[[drivers]].address`) | the Robinhood submitter EOA (a NEW per-chain Tier-1-isolated EOA, added to the Authenticator solver allowlist and funded with ~0.02 ETH on 4663) |
| `__FILL_AFTER_DEPLOY_ETHFLOW__` | autopilot `[ethflow]` (commented) | `CoWSwapEthFlow` - only when native-ETH sells are enabled (deferred day-1) |

## Not placeholders (already verified, do not change)

- WETH9 `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- USDG (canonical stable, 6 dec) `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
- LiFi 4663 router `0xB477751B76CF82d00a686A1232f5fCD772414Af3` (goes in the code allowlists, not a template)

## After filling

1. Set the ceremony Safe in `.env`: `OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET` (+ `OPHIS_SAFE_EXPECTED_OWNERS`).
2. Run `./render-configs.sh` - it fails closed if any `__FILL_AFTER_DEPLOY_*__` remains.
3. Run `./compose-up.sh`.
