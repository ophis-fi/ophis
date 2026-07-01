# Robinhood Chain - Nitro chain-info JSON

A Nitro / Orbit node needs a chain-info JSON that describes the L2 (chainId 4663),
its genesis, and the L1 rollup contract addresses (Rollup, SequencerInbox, Bridge,
Inbox, Outbox). This file is Robinhood's to publish - do NOT hand-transcribe it, a
single wrong rollup address means the node validates against the wrong chain.

## How to obtain it

1. Canonical source: Robinhood's run-a-full-node docs,
   `https://docs.robinhood.com/chain/run-a-full-node/` (the docker command there
   references the chain-info file). Download the file they publish and save it as
   `robinhood-chain-info.json` next to `docker-compose.yml` in this directory.

2. Cross-check the L1 rollup addresses against the Arbitrum chain registry / the
   Robinhood contracts page (`https://docs.robinhood.com/chain/contracts/`) and,
   where possible, against on-chain code on Ethereum L1.

3. Verify the file's `chainId` is `4663` and `parentChainId` is `1` (Ethereum
   mainnet) before first boot.

## Shape (for reference only - use the published file, not this sketch)

```json
{
  "chain-name": "robinhood-mainnet",
  "parent-chain-id": 1,
  "chain-config": { "chainId": 4663, "...": "..." },
  "rollup": {
    "bridge": "0x...",
    "inbox": "0x...",
    "sequencer-inbox": "0x...",
    "rollup": "0x...",
    "validator-utils": "0x...",
    "deployed-at": 0
  }
}
```

## Verified L2-side facts (probed 2026-07-02)

These are the values Ophis wiring depends on; they are on the L2 and independently
verified, unlike the L1 rollup addresses above:

- chainId: `4663` (`0x1237`); parent chain: Ethereum L1 (`1`); DA: EIP-4844 blobs (Rollup).
- Native gas token: ETH. Canonical WETH9: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.
- Canonical stablecoin (Paxos USDG, 6 dec): `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- Public RPC (no debug): `https://rpc.mainnet.chain.robinhood.com`
- Sequencer: `https://sequencer.mainnet.chain.robinhood.com`; feed `wss://feed.mainnet.chain.robinhood.com`
- Explorer (Blockscout): `https://robinhoodchain.blockscout.com`
- Predeploys present (verified): CREATE2 `0x4e59b44847b379578588920cA78FbF26c0B4956C`,
  Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`, Permit2
  `0x000000000022D473030F116dDEE9F6B43aC78BA3`, Safe 1.3.0 + 1.4.1 factories/singletons.
