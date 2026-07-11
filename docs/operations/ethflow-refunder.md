# Eth-flow auto-refunder (Optimism + Unichain)

Ophis self-hosts the Optimism and Unichain stacks. CoW's hosted deployment runs
a managed refunder that automatically returns funds for expired native-ETH
(eth-flow) orders; the self-hosted stacks do not get that for free. Without a
refunder, an expired native-ETH order leaves the user's ETH locked in the
eth-flow contract until someone calls `invalidateOrder` manually.

The `refunder` service (backend `crates/refunder`, Dockerfile target `refunder`)
closes that gap. It scans the orderbook DB for expired, unfilled, unrefunded
eth-flow orders and batch-invalidates them on-chain, returning the ETH to each
order owner.

## Configuration

Per chain (env on the `refunder` compose service):

| var | Optimism | Unichain |
| --- | --- | --- |
| `CHAIN_ID` | `10` | `130` |
| `ETHFLOW_CONTRACTS` | `0x764fE4aa1FF493cf39931c7923C8ff5837596504` | `0x38C03729153BCCF6a281DaF41D7C6a14C543F1D7` |
| `NODE_URL` | internal eRPC `.../main/evm/10` | internal eRPC `.../main/evm/130` |
| `DB_URL` | `${DB_READ_URL}` | `${DB_READ_URL}` |
| `MIN_PRICE_DEVIATION_BPS` | `-1000000` | `-1000000` |

`MIN_PRICE_DEVIATION_BPS` is deliberately NEGATIVE. CoW's default (`190`) only
refunds orders placed >=1.9% off quote (assumed unfillable), which skips normal
tight-slippage orders. An expired order can never fill, so refunding every
expired order is always correct; the negative value refunds all of them.

## Refunder key (gas)

The refunder pays gas from a DEDICATED low-value EOA, NOT the settlement
submitter, to avoid nonce contention with settlement transactions. The refund
always goes to the order owner regardless of who submits, so this key never
custodies user funds.

- Address: `0x6fdc54717176C57b675C85fa08E9B92f44448Dbb`
- Private key: macOS Keychain `ophis-refunder-pk` (account `ophis`). Injected as
  `OPHIS_REFUNDER_PK` at deploy time; on the Unichain VM it lives in the
  gitignored `.env` (mode 600).
- Fund it with a small amount (~0.005 ETH is plenty for many refunds; refund txs
  are cheap on both L2s). Top up when low.

## Deploy

```
# export the key from the keychain (never printed), then:
export OPHIS_REFUNDER_PK=$(security find-generic-password -a ophis -s ophis-refunder-pk -w)
docker compose up -d refunder
```

## Manual one-off refund

If an order is stuck before the refunder is running, `invalidateOrder` on the
eth-flow contract is permissionless once the order is past its `userValidTo`.
Reconstruct the `EthFlowOrder.Data` struct from the orderbook order (the struct
`validTo` is `userValidTo`, not the `0xffffffff` UID sentinel), and send it to
the eth-flow contract with value 0. The ETH returns to the order owner.
