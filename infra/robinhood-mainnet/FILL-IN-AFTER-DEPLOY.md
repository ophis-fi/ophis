# Fill-in after the Robinhood (4663) deploy ceremony

The config templates ship with `__FILL_AFTER_DEPLOY_*__` placeholders for every
address the sovereign GPv2 deploy produces. `render-configs.sh` refuses to render
while any placeholder remains, so fill them all before first start.

## DEPLOYED 2026-07-25 - use these values

The ceremony ran on 2026-07-25. Protocol authority is fully held by the 2-of-3
Ophis Safe `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` (`owner()` and
`manager()` both verified on-chain); the deploying Ledger retains no authority.

| Contract | Address |
|----------|---------|
| `GPv2Settlement` | `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD` |
| `GPv2VaultRelayer` | `0xB52C38097c19cd38238c62DD36027a7918eFa890` |
| `GPv2AllowListAuthentication` (proxy) | `0x5c802B14d9E132717aE78D42B19a4c517876F2E7` |
| `GPv2AllowListAuthentication` (impl) | `0x2Ddcc99cD0F2Ba3De0cc37B28ec89921814bBe35` |
| Balances | `0x5f315a204e7971fc29a66fef3a5773f6b0202fac` |
| Signatures | `0x2fbb1e41ff4f9b707e4428eec7f5afaac5d60810` |
| HooksTrampoline | `0x68593257dfd7f392abfbb410b212be0b6242ac0e` |
| Allowlisted submitter | `0x7A956C269a12f1B897367663b536EB5dd29f3fBb` |

`domainSeparator` = `0xb6fd90ec7e83ea8ffa46bfbcd6649a2ec3e7c19027fc7e4fd412355d946cba65`
(independently recomputed from chainId 4663 + the Settlement address).

GATE result: Balances and Signatures codehashes are identical to the live OP and
Unichain deployments and to the committed artifacts under
`apps/backend/contracts/artifacts/`. AuthImpl is identical to Unichain; it differs
from OP in exactly 32 bytes inside the CBOR metadata section (the source-metadata
IPFS hash), with byte-identical executable code and the same solc 0.7.6.

WARNING - the helper addresses are NOT the same as on OP/Unichain, despite
overlapping: Robinhood's **Balances** sits at `0x5f315a20...202fac`, which is the
**Signatures** address on OP/Unichain. Plain CREATE nonce offset (the Ledger had
already spent a nonce on a Safe `execTransaction`). Always compare codehash, never
address, when checking these across chains.

### Orbit deltas that applied to the ceremony

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
