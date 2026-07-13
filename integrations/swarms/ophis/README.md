# Ophis swap tool for Swarms

A [Swarms](https://github.com/kyegomez/swarms) tool that performs MEV-protected same-chain
ERC-20 swaps via [Ophis](https://ophis.fi) (CoW Protocol): gasless at settlement, surplus
returned, no sandwiching. The agent's key signs an off-chain EIP-712 GPv2 order; the Ophis
partner fee + referral ride in the order's `appData`.

## Files

| File | Purpose |
| --- | --- |
| `ophis_swap.py` | The tool: `ophis_swap(sell_token, buy_token, amount, chain, ...) -> str`. Loads the signer from env, approves the VaultRelayer, signs + submits the order. Returns a JSON string. |
| `ophis_core.py` | CoW/Ophis order primitives (orderbook endpoints, partner-fee appData, GPv2 EIP-712 typed data) + minimal JSON-RPC (decimals/allowance/nonce/gas/broadcast). No keys, no signing. |
| `test_ophis_swap.py` | Hermetic tests (real eth_account signing offline; network mocked). |

## Install (PR to `The-Swarm-Corporation/swarms-tools`)

1. Drop `ophis_swap.py` + `ophis_core.py` into `swarms_tools/finance/`.
2. Export the tool in `swarms_tools/finance/__init__.py`:
   ```python
   from swarms_tools.finance.ophis_swap import ophis_swap
   __all__ = [..., "ophis_swap"]
   ```
3. Add `eth-account` (which brings `eth-utils`/`eth-keys`) to `pyproject.toml` /
   `requirements.txt` — it is not currently a swarms-tools dependency.

## Use

```python
from swarms import Agent
from swarms_tools import ophis_swap

agent = Agent(name="trader", tools=[ophis_swap])  # schema auto-generated from the signature
```

The signer key is read from the environment — set one of `OPHIS_PRIVATE_KEY`,
`PRIVATE_KEY`, or `TRANSMITTER_PRIVATE_KEY` (swarms-tools already calls `load_dotenv()`
at import). The key is used only locally with `eth_account`; it is never logged, returned,
or transmitted.

```python
result = ophis_swap(
    sell_token="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  # USDC on Base
    buy_token="0x4200000000000000000000000000000000000006",   # WETH
    amount="100",
    chain="base",
    slippage_bps=50,
    referral_code="my-ophis-code",   # earns the rebate
)
# -> '{"ok": true, "order_uid": "0x…", "explorer_url": "…", ...}'  (or {"ok": false, "error": "…"})
```

## Supported chains

All Ophis chains: Ethereum (1), Optimism (10), BNB (56), Gnosis (100), Unichain (130),
Polygon (137), Base (8453), Arbitrum (42161), Avalanche (43114), Linea (59144), Ink (57073).
Optimism and Unichain use their Ophis-sovereign orderbook + non-canonical Settlement/VaultRelayer.

## Fund-safety notes

- The signer key never leaves the process; it is used only with `eth_account`.
- The approval targets the chain's canonical CoW VaultRelayer for **exactly** the sell
  amount (allowance-aware, USDT nonzero-approval reset), and must be **mined with status 1**
  before the order is signed or submitted.
- The signed order is bound to the request: tokens must echo the request, `sellAmount` must
  equal the requested amount, `feeAmount` must be 0 (the Ophis fee is in `appData`), the buy
  floor must be `> 0`, `validTo` is self-set (`now + 20 min`), and amounts are bounded to
  `uint256`. `receiver` is pinned to the owner (drain guard).
- The broadcast tx sets `chainId` (EIP-155 replay safety); the EIP-712 domain sets `chainId`
  (no cross-chain order replay).
- Native-token sells/buys are rejected (they require CoW eth-flow); wrap to WETH first.
- Residual (inherent to the CoW quote model, as in every CoW integration): the buy floor
  derives from the orderbook quote; there is no independent oracle cross-check.
