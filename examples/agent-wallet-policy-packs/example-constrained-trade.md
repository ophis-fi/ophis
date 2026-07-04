# End-to-end: a constrained wallet does one Ophis trade

This walks a single swap from quote to settlement using a wallet whose key is
constrained by one of the packs. The pack decides **what the key may sign**; the
Ophis MCP server (or `@ophis/sdk`) produces a **valid, bounded order to sign**.
Neither the MCP server nor Ophis ever holds the key.

Scenario: an agent wallet at `0xAGENT...` on Optimism (chain 10) sells 100 USDC
for WETH. The Turnkey or Privy pack for chain 10 is already attached, with USDC
and WETH on the token allowlist.

## 1. Build a bounded order (keyless MCP or SDK)

The MCP `build_order` tool returns an order with the `receiver` already pinned to
the owner and slippage bounded against a live quote, plus the exact EIP-712
`domain` + `types` to sign. Point any MCP client at `https://mcp.ophis.fi/mcp`.

```jsonc
// build_order request
{
  "chainId": 10,
  "owner": "0xAGENT...",
  "sellToken": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // USDC on OP
  "buyToken":  "0x4200000000000000000000000000000000000006", // WETH on OP
  "sellAmount": "100000000",   // 100 USDC (6 decimals), atoms
  "buyAmount":  "24000000000000000", // your minimum out, slippage-adjusted DOWN
  "kind": "sell",
  "slippageBips": 50
}
// -> { order, signing: { domain, types, primaryType: "Order" }, fullAppData, appDataHash, ... }
// order.receiver === "0xAGENT..." (pinned); signing.domain.verifyingContract is the OP settlement.
```

Prefer the SDK? `getOphisOrderDomain(10)` gives the same domain and
`assertReceiverIsOwner(owner, order.receiver)` re-checks the pin before signing.

## 2. One-time approval (bounded), gated by the pack

Before the first sell of a token, approve the vault relayer. This is the only
on-chain transaction. Send a bounded amount so the approval itself is not a
standing liability; the pack's approve rule requires the spender to be the
relayer and the token to be on the allowlist, so any other approve is denied.

```ts
// Optimism vault relayer (approve spender) from addresses.json
const RELAYER = "0x83847EaB41ad9ea43809ce71569eB2e9daF51830";
// approve(RELAYER, 100_000000)  // 100 USDC, not unlimited
```

## 3. Sign the order with the constrained wallet

The wallet signs the EIP-712 typed data. The pack lets this through only because
the domain, receiver, and token set all match; a tampered receiver or a
non-Ophis `verifyingContract` is denied by the policy engine, not by the agent.
The snippets below are illustrative; use each provider's current SDK method and
argument names.

### Turnkey

```ts
// Submit STRUCTURED typed data (encoding EIP712) so the policy can inspect the
// fields. A pre-hashed digest (HASH_FUNCTION_NO_OP) is denied by the pack.
const { r, s, v } = await turnkey.apiClient().signRawPayload({
  signWith: "0xAGENT...",
  payload: JSON.stringify({ domain: signing.domain, types: signing.types, primaryType: "Order", message: order }),
  encoding: "PAYLOAD_ENCODING_EIP712",
  hashFunction: "HASH_FUNCTION_NO_OP", // the EIP712 encoder hashes per the spec
});
const signature = "0x" + r + s + v;
```

### Privy

```ts
const { signature } = await privy.walletApi.ethereum.signTypedData({
  walletId: AGENT_WALLET_ID,
  typedData: { domain: signing.domain, types: signing.types, primaryType: "Order", message: order },
});
// Privy's policy inspects domain.verifyingContract, domain.chainId and message.receiver here.
```

## 4. Relay the signed order

Hand the signed order back to the orderbook. The MCP `submit_order` tool relays
it (and refuses any order whose receiver is not the owner as a second check).

```jsonc
// submit_order request
{
  "chainId": 10,
  "order": { /* the order object from step 1 */ },
  "signature": "0x...",
  "signingScheme": "eip712",
  "from": "0xAGENT...",
  "fullAppData": "{...}"   // the exact string from build_order
}
// -> orderUid. The swap settles gaslessly; WETH lands in 0xAGENT... only.
```

## What the pack guaranteed here

- The approval could only raise the relayer's allowance, only for allowlisted
  tokens, and (with the optional cap) only up to a bound you set.
- The signature could only be a `Gnosis Protocol` / `v2` order against the OP
  settlement, delivering to `0xAGENT...`, trading USDC/WETH.
- A compromised agent could not point `receiver` elsewhere, approve a different
  spender, or sign against a non-Ophis contract.

What it did **not** guarantee: that `buyAmount` was a fair price. That check
belongs in the in-code policy gate (limit versus an independent oracle, plus
per-trade and rolling notional caps) that sits between the model and the signer.
