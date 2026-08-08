# Ophis trade rewards — Robinhood Chain deployment

This directory prepares the finite Ophis trade-reward pilot. Funding and campaign
activation are never performed automatically.

## Deployment record

- Distributor: `0x398d1287E07560AAab2fdc81896beF65D8e94e5E`
- Deployment transaction: `0x6e313bc3303a332f725eb1d0b24a53c1d86ce8910d3b0c2f31fe4cc9563d4ffd`
- Deployment block: `30346712`
- Deployer: `0x143D404003556Ca6A653084F54D2bcC491C05B26`
- Runtime verification: exact local-bytecode match after normalizing the three
  Solidity immutable values; all immutable getters independently checked.
- Funding transaction: `0x16c4898d47790e133ce4d100632fb3a17f13108ff80c7d1639027dd3744808ea`
- Funding block: `30351248`
- Funding: exactly `150000000` USDG base units transferred by the rewards Safe;
  live distributor balance independently verified as `150000000`.
- Allocation commitment: `0x56238da6bbcef41c9e022dfc20dc353cc6e06687a289c360c2063f56a7d17aee`
  (seed generated once in an ignored mode-`0600` file; never publish it while
  unassigned tickets remain).

## Immutable campaign facts

- Chain: Robinhood Chain (`4663`)
- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals)
- Owner Safe: `0xB13Ab19F5FeC601813a46D877398B5Eb89eF10Da` (Safe 1.4.1, threshold 1-of-2)
- Reward signer: `0x9a9DC48DA629a1370d8c50821F65da3587739042`
- Sponsored relayer: `0x143D404003556Ca6A653084F54D2bcC491C05B26`
- Inventory: 100 × 1 USDG and 5 × 10 USDG
- Maximum lifetime payout: 150 USDG
- Claim deadline: none

## Deployment gate

Do not broadcast until the security reports are clean and the operator has
explicitly approved deployment.

Generate the allocation seed once on the production indexer host and publish only its commitment:

```sh
install -d -m 700 apps/rebate-indexer/secrets
openssl rand -hex 32 > apps/rebate-indexer/secrets/trade-rewards-allocation-seed
chmod 600 apps/rebate-indexer/secrets/trade-rewards-allocation-seed
pnpm --dir apps/rebate-indexer trade-rewards:commitment -- secrets/trade-rewards-allocation-seed
```

Never publish the seed while unassigned tickets remain. Store the printed commitment in the launch
record before enabling the worker.

```sh
cd contracts
forge test --match-contract OphisRewardsDistributorTest --skip Plasma -vv
forge script script/DeployRewardsDistributor.s.sol:DeployRewardsDistributor \
  --rpc-url "$ROBINHOOD_MAINNET_RPC" \
  --ledger \
  --sender "$DEPLOYER" \
  --broadcast
```

After deployment:

1. Independently verify the runtime bytecode and constructor arguments.
2. Record `REWARDS_DISTRIBUTOR_ADDRESS` in the backend and frontend deployment environments.
3. Transfer exactly `150000000` USDG base units from the rewards Safe to the distributor.
4. Verify `balanceOf(distributor) == 150000000` before enabling ticket assignment.
5. Load the signer and relayer keys from dedicated `0600` secret files; never place them in Git or Compose YAML.
   Mount those three files read-only in the production deployment override and set
   `TRADE_REWARDS_ALLOCATION_SEED_FILE`, `REWARDS_SIGNER_PRIVATE_KEY_FILE`, and
   `REWARDS_RELAYER_PRIVATE_KEY_FILE` to their in-container paths. The base Compose
   file deliberately has no secret mounts so disabled deployments remain unaffected.
   Start the enabled service with both Compose files so the three read-only mounts
   are mandatory only for the campaign deployment:
   `docker compose -f docker-compose.yml -f docker-compose.rewards.yml up -d --build`.
6. Configure archive-capable `WALLET_AGE_RPC_URL_<chainId>` endpoints for all twelve eligibility
   chains. A missing/unavailable chain fails eligibility closed.
   The 2026-08-07 production probe confirmed the public defaults for Optimism,
   Base, Unichain, Plasma, Ink, and Gnosis. Keyed archive endpoints are required
   for Ethereum, BNB Chain, Arbitrum, Robinhood Chain, Avalanche, and Polygon;
   do not activate until all six are present and historical-state probes pass.
7. Verify the relayer balance and alert before it drops below the operator threshold. The currently
   observed balance is `0.001039549667084219 ETH`; this is not a permanent gas budget.
8. Enable the worker only after a dry-run and `eth_call` simulation. The first canary must be a real
   eligible winner: never consume one of the fixed 105 tickets with a synthetic wallet.
9. After the first real assignment and sponsored claim, verify the recipient, signer epoch, counters,
   events, exact USDG balance delta, and relayer gas cost before continuing.

The contract contains no USDG withdrawal function. Funding is therefore a
one-way commitment to eligible winners.
