# Robinhood Chain - Nitro chain-info JSON

A Nitro / Orbit node needs a chain-info JSON that describes the L2 (chainId 4663),
its genesis, and the L1 rollup contract addresses (Rollup, SequencerInbox, Bridge,
Inbox, Outbox). This file is Robinhood's to publish - do NOT hand-transcribe it, a
single wrong rollup address means the node validates against the wrong chain.

## Obtained (2026-07-21) - both files are now committed in this directory

Fetched verbatim from the Robinhood CDN; not hand-transcribed:

```bash
BASE=https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs
curl -sSO "$BASE/robinhood-chain-info.json"   # 1.6 KB
curl -sSO "$BASE/robinhood-genesis.json"      # 613 KB - MAINNET REQUIRES THIS
```

`robinhood-genesis.json` is the piece the first draft of this runbook missed:
the documented **mainnet** command passes `--init.genesis-json-file`, and only the
**testnet** command omits it. Both files are mounted into the node by
`docker-compose.yml`. Re-pull both if Robinhood revises them.

**Gotcha: the chain-info file is a top-level JSON ARRAY**, not an object - a list
containing one chain entry. `--chain.info-files` expects exactly that. The sketch
in the previous revision of this doc showed a bare object and would not have
loaded.

## Verified against L1 (2026-07-21)

`parent-chain-id: 1` and `parent-chain-is-arbitrum: false` in the published file
settle the recurring L2-vs-L3 question: **Robinhood Chain is an L2 settling to
Ethereum mainnet**, not an L3 on Arbitrum One. Independently confirmed by
`eth_getCode` on Ethereum mainnet - all three rollup contracts return bytecode:

| Contract | Address | L1 bytecode |
|---|---|---|
| rollup | `0x23A19d23e89166adedbDcB432518AB01e4272D94` | yes (~5.2 KB) |
| sequencer-inbox | `0xBd0D173EEb87D57A09521c24388a12789F33ba96` | yes (~2.2 KB) |
| bridge | `0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3` | yes (~2.2 KB) |

The same addresses return empty (`0x`) on Arbitrum One. `stake-token` is canonical
mainnet WETH (`0xC02aaA39...756Cc2`), and `DataAvailabilityCommittee: false`
confirms Rollup-mode blob DA (no AnyTrust/DAC) - blobs are only postable to L1,
which independently rules out an L3.

**Beware L2BEAT's "L3 Host Chain" badge** on the Robinhood page: it means other L3s
are hosted *on* Robinhood Chain, NOT that Robinhood is an L3. A separate L2BEAT
project (`lighter-robinhood`) is a genuine L3 hosted on 4663. Do not conflate them.

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
