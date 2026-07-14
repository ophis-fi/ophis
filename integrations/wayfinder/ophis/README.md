# Ophis swap adapter for Wayfinder Paths

MEV-protected same-chain ERC-20 swaps via [Ophis](https://ophis.fi) (CoW Protocol) for
[Wayfinder](https://wayfinder.ai) agents. A swap is settled as an off-chain, EIP-712-signed
CoW order: gasless at settlement, surplus returned to the trader, no sandwiching. The Ophis
partner fee and the integrator referral ride in the order's `appData`.

## Files

| File | Purpose |
| --- | --- |
| `adapter.py` | `OphisAdapter(BaseAdapter)` — `adapter_type = "OPHIS"`, one action: `swap_exact_in`. |
| `ophis_core.py` | CoW/Ophis order primitives: orderbook endpoints, partner-fee appData, GPv2 EIP-712 typed data, quote/put/submit REST. No signing, no web3, no keys. |
| `manifest.yaml` | Wayfinder adapter manifest (`ophis.swap.exact_in`). |
| `test_adapter.py` | Unit tests (hermetic; stubs the SDK, mocks the orderbook + signer). |

## Install

Drop the directory into the SDK as `wayfinder_paths/adapters/ophis_adapter/` (the
`manifest.yaml` `entrypoint` assumes that path), or bundle it as a component of a Path
(`wfpath.yaml`) and publish with `wayfinder path publish`.

## Wallet contract

The adapter needs two callbacks from the resolved Wayfinder wallet (see
`wayfinder_paths/core/utils/wallets.py`):

- `sign_callback(tx) -> bytes` — signs the ERC-20 approval transaction (local key or
  remote/sponsored wallet).
- `sign_typed_data(payload) -> str` — signs the EIP-712 GPv2 order. **Required.** The
  Uniswap adapter only needs `sign_callback`, so an Ophis Path must additionally wire
  `sign_typed_data` (`get_local_sign_typed_data_callback` / `get_remote_sign_typed_data_callback`).

```python
adapter = OphisAdapter(
    {"chain_id": 8453},
    sign_callback=sign_callback,
    sign_typed_data=sign_typed_data,
    wallet_address=owner,
)
ok, result = await adapter.swap_exact_in(
    sell_token="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  # USDC on Base
    buy_token="0x4200000000000000000000000000000000000006",   # WETH
    amount_in="100",
    slippage_bps=50,
    referral_code="my-ophis-code",   # earns the rebate
    # (the 1bp stable-pair tier is derived automatically from a verified stablecoin registry)
)
# ok == True -> result = {"order_uid": "0x…", "min_buy": "…", "explorer_url": "…", ...}
```

## Supported chains

Ophis chains that also exist in the Wayfinder SDK's supported set: **Ethereum (1),
BNB (56), Polygon (137), Base (8453), Arbitrum (42161), Avalanche (43114)**. Ophis also
runs on Optimism (10), Unichain (130), Gnosis (100), Linea (59144) and Ink (57073), but
Wayfinder does not support those, so they are intentionally excluded.

## Fund-safety notes

The adapter reuses Ophis's verified order construction and binds the signed order to the
request before signing or approving anything:

- ERC-20 approval goes through the SDK's audited `ensure_allowance` (allowance-aware +
  USDT nonzero-approval reset); the spender is the CoW VaultRelayer.
- `receiver` is pinned to the owner (drain guard).
- The signed order's `feeAmount` is `0` (the Ophis fee rides in `appData`); a non-zero
  quote fee is refused.
- The quote's `sellAmount` must equal the requested amount, and the buy floor must be
  `> 0`, or the swap is refused (no signing on a drifted quote).
- `validTo` is set by the adapter (`now + 20 min`), never taken from the quote.

Native-token sells/buys are rejected (they require CoW eth-flow); wrap to WETH first.
