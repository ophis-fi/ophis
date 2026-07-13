# @ophis/plugin-elizaos

MEV-protected **same-chain** token swaps for [elizaOS](https://elizaos.ai) agents, routed through **Ophis** (a [CoW Protocol](https://cow.fi) intent-settlement layer).

Instead of an AMM swap that can be sandwiched, the agent's order settles in a **batch auction**: uniform clearing price, surplus (price improvement) returned to the trader, and **gasless** settlement (solvers pay the gas). The agent signs the CoW order with its **own EVM key** (EIP-712) — no managed-wallet dependency. Each order carries the Ophis partner fee in `appData`; set a referral code to earn the 8-12% rebate.

Complements bridging plugins — this is *same-chain best execution*, not cross-chain.

## Install

```bash
npm install @ophis/plugin-elizaos
```

Add it to your character:

```jsonc
{
  "plugins": ["@ophis/plugin-elizaos"],
  "settings": {
    "EVM_PRIVATE_KEY": "0x...",           // the agent's EOA key (funds the swap + one-time approval)
    "OPHIS_REFERRAL_CODE": "yourcode",    // optional — earns the rebate (mint at swap.ophis.fi/#/rewards)
    "OPHIS_FEE_CHAIN": "base"             // optional default chain
    // optional RPC overrides: "ETHEREUM_PROVIDER_BASE": "https://...", etc.
  }
}
```

## Use

> "Swap 100 USDC for WETH on Base via Ophis"
> "Sell 0.5 WETH for USDC on Unichain"

The `OPHIS_SWAP` action extracts the intent, resolves the chain + token addresses, and executes the swap through the audited `@ophis/agent-swap` core (quote → Ophis fee `appData` → approve the CoW VaultRelayer → EIP-712-sign the order → submit). It returns the order UID and an `explorer.ophis.fi` tracking link.

## Supported chains

Ethereum, Optimism, BNB, Gnosis, **Unichain**, Polygon, Base, Ink, Arbitrum, Avalanche, Linea. Optimism and Unichain are Ophis-sovereign (100% of price improvement returned). Same-chain only.

## Tokens

Common tokens (USDC, WETH, …) resolve by symbol on the major chains; for anything else, ask by **contract address** (`0x…`). Native ETH is not supported — swap WETH and unwrap. The plugin never guesses a token address.

**Trust model (autonomous NL agent).** The swap intent (chain, tokens, amount) is extracted by the model from the user's request, so it inherits the usual bounds — and hardening — of an autonomous agent:

- **Receiver is pinned to the agent's own wallet** — proceeds can never be diverted to a third party.
- **Raw `0x` token addresses are accepted only if they appear verbatim in the user's request** — a model-hallucinated-but-valid address can't route funds to the wrong token.
- **Symbols resolve only through a verified canonical map**; chains are restricted to the Ophis-supported set; extraction is anchored on the *current* request (embedded/older-message instructions are ignored); slippage is floored (no accept-any-price).
- **Residual, by design:** within those bounds the model still chooses the chain / canonical token / amount, so a misinterpretation could pick a *supported-but-unintended* one. Constrain the agent's inputs accordingly for high-value or shared-room deployments.

## Notes

- The agent's key needs the sell token plus a little native gas for the one-time ERC-20 approval; the swap settlement itself is gasless.
- Slippage defaults to 0.5% (capped at 50% by the SDK).
- Built on `@ophis/agent-swap` — the same audited path used by the Ophis Coinbase-AgentKit and GOAT integrations.
