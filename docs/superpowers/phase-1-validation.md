# Phase 1 — Validation Log

## Stage 1: Forked Gnosis (no real money)

Date: 2026-05-02
Trader: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (anvil account[0])
Pair: wxDAI → USDC (Gnosis), sell 0.1 wxDAI
Order UID: 0xc08ad5d54709a6385622861462e329a2aeafd3e91da3a1c443cebdde37fc2a76f39fd6e51aad88f6f4ce6ab8827279cfffb9226669f6873a
Settlement tx (anvil fork): N/A — order never settled
Block number (on fork): N/A
Time-to-settle (signed → on-chain): N/A
Stage 1 verdict: FAIL

## What Passed

- Stack: all 6 services healthy (chain, db, orderbook, autopilot, driver, baseline; migrations exited 0)
- Trader funded: 10000 ETH/xDAI confirmed
- wxDAI wrap: 1 wxDAI minted (1e18 wei) via `deposit()` on 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d
- Relayer approval: unlimited allowance set for GPv2VaultRelayer (0xC92E8bdf79f0507f65a392b0ab4667716BFE0110)
- Order submission: HTTP 201, order accepted into orderbook as `open` (limit order class)
- EIP-712 signature: valid, chainId=100, verifyingContract=GPv2Settlement

## What Failed

### 1. Quote endpoint: NoLiquidity for all pairs

All three pairs tried returned `{"errorType":"NoLiquidity","description":"no route found"}`:
- wxDAI → COW  (0x177127622c4A00F3d409B75571e12cB3c8973d3c)
- wxDAI → USDT (0x4ECaBa5870353805a9F068101A40E0f32ed605C6)
- wxDAI → USDC (0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83)

Order was submitted manually with conservative parameters (buyFloor=10000 USDC = 0.01 USDC for 0.1 wxDAI).

### 2. Order never picked up: missing_native_price

Autopilot log (every block, ~4 minutes total):
```
filtered orders reason=missing_native_price count=1 orders=[0xc08ad5d54709...]
skipping empty auction
```

Driver log:
```
got 0 AMMs
fetched liquidity sources liquidity={}
QuotingFailed(NoSolutions)
```

## Root Cause

**Config mismatch: `infra/local/configs/baseline.toml` is configured for Ethereum mainnet on a Gnosis fork.**

`baseline.toml` line 1: `chain-id = "1"` — should be `"100"`.

The `base-tokens` list contains Ethereum mainnet addresses (WETH, DAI, USDC, USDT, COMP, MKR, WBTC, GNO — all mainnet). The Gnosis fork has none of these Uniswap V2 pools at the mainnet addresses, so the liquidity collector finds 0 AMMs. The baseline solver returns NoSolutions, the driver cannot compute native prices, and the autopilot filters the order out of every auction.

Same issue in `infra/local/configs/driver.toml` — the `[liquidity]` base-tokens list also contains mainnet addresses.

## Config Fix Required (Task 7)

`infra/local/configs/baseline.toml`:
- `chain-id = "1"` → `chain-id = "100"`
- `base-tokens` → Gnosis mainnet addresses:
  - wxDAI: `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d`
  - USDC: `0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83`
  - USDT: `0x4ECaBa5870353805a9F068101A40E0f32ed605C6`
  - WETH on Gnosis: `0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1`
  - GNO on Gnosis: `0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb`

`infra/local/configs/driver.toml`:
- `[liquidity]` `base-tokens` → same Gnosis addresses

## Notes

- The pipeline is architecturally correct end-to-end: autopilot polls orderbook, calls driver, driver calls baseline. The failure is purely a config issue (wrong chain tokens).
- No panics or crashes in any service — all services healthy throughout.
- The OpenTelemetry DNS errors (tempo collector not running) are benign — just telemetry export failing.
- Tasks 7-10 can proceed once baseline.toml and driver.toml are updated with Gnosis token addresses.
