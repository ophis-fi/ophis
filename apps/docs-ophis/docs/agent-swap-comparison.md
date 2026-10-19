---
id: agent-swap-comparison
title: Agent swap controls
description: Build agent swap orders with wallet signing, enforced price limits and solver-paid settlement.
sidebar_label: Agent swap controls
---

# Agent swap controls

Ophis gives your agent quotes and orders with signed limits on the tokens, amounts and receiver.

## Order controls

<Cards>
<Card icon="key-round" title="Keyless quoting">Get quotes and build orders without an API key or signup.</Card>
<Card icon="wallet" title="Your signer">Sign the returned EIP-712 order with your own wallet.</Card>
<Card icon="scale" title="Signed limits">Settlement enforces your sell amount, minimum buy amount and receiver.</Card>
<Card icon="shield-check" title="Batch settlement">Offchain orders and uniform clearing prices reduce common ordering advantages.</Card>
<Card icon="coins" title="Solver-paid settlement">Solvers pay settlement gas for standard ERC-20 orders.</Card>
</Cards>

## Build an order {/* #try-it */}

SDK v0.4.3 and hosted MCP cover 14 EVM mainnets, including Arc.

<Steps>

1. **Connect your client.** Point an MCP client at `https://mcp.ophis.fi/mcp`.
2. **Request an order.** Call `build_order` to fetch a live quote, apply your slippage bound and pin the receiver to the owner.
3. **Check the fields.** Review the tokens, sell amount, minimum received and receiver before signing.
4. **Sign and submit.** Sign the EIP-712 order with your wallet, then call `submit_order`.

</Steps>

Use [Turnkey wallet policies](/agent-wallet-policies) to restrict the signer to your token allowlist, the chain's settlement contract and your own receiver address.

## Fees and gas

`build_order` applies the chain's Ophis fee policy:

| Fee | Amount |
| --- | --- |
| Base | 1 bp |
| Volatile-pair price improvement | 80% of reference-quote improvement, capped at 99 bps |
| Stable-pair price improvement | 50% of reference-quote improvement, capped at 20 bps |

Ophis-operated backends apply the improvement policy; CoW-hosted orders encode it in CIP-75 appData.

Keep native gas for token approvals, renewed exact allowances, wrapping, native-token placement, hard cancellation and refunds.

## Next

<Cards>
<Card icon="bot" title="Agent integration" href="/ai-agents">Connect an MCP client or use a framework adapter.</Card>
<Card icon="lock" title="Wallet policies" href="/agent-wallet-policies">Configure Turnkey signing restrictions.</Card>
<Card icon="receipt" title="Fees" href="/fees">Read the fee policy for each settlement path.</Card>
</Cards>
