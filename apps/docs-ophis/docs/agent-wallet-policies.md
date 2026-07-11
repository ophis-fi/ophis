---
id: agent-wallet-policies
title: Agent wallet policy packs
description: Ready-made Turnkey and Privy wallet policies that pin an agent key to Ophis trades only, so an agent policy engine can safely allow the swap.
sidebar_label: Agent wallet policies
sidebar_position: 3
---

# Agent wallet policy packs

If you run an agent that holds its own key, the question is not "should the
agent be able to swap" but "what is the worst a compromised agent can do with
the swap". These packs answer that: drop-in
[Turnkey](https://docs.turnkey.com/concepts/policies/overview) and
[Privy](https://docs.privy.io/controls/policies/overview) wallet policies that
let the key sign Ophis trades and nothing else. Ophis becomes the one swap an
agent policy engine can allow without opening a drain.

The packs live in the repo at
[`examples/agent-wallet-policy-packs`](https://github.com/ophis-fi/ophis/tree/main/examples/agent-wallet-policy-packs).

:::info[What a wallet policy can and cannot enforce]

A static wallet policy cannot read a per-order limit price, so it cannot promise
a good fill or that the wallet "cannot lose money". What it enforces is
**anti-exfiltration pinning**. The constrained key can only produce two kinds of
signature: a one-time ERC-20 `approve` whose spender is the Ophis vault relayer,
and an Ophis order that carries the correct EIP-712 domain (name
`Gnosis Protocol`, version `v2`, and the exact per-chain settlement as
`verifyingContract`), delivers proceeds to the agent's own account (`receiver`
pinned to self), and moves only tokens on your allowlist. The result is a
**bounded blast radius**: a compromised or prompt-injected agent still cannot
drain funds to a third party, approve an arbitrary spender, or sign against a
non-Ophis contract. It **can** still sign a weak price within your token set,
and CoW/Ophis guarantee only that a fill is no worse than the signed limit, not
that the limit itself is sane. This pack bounds where value can go, not the
price it trades at. To bound execution quality too, pair it with the in-code
policy gate (limit versus an independent oracle, per-trade and rolling caps)
described in [AI agent integration](./ai-agents.md).

:::

## The two actions an Ophis agent needs

1. **A one-time ERC-20 `approve`** to the per-chain vault relayer (the contract
   that pulls the sell token at settlement). Prefer a bounded amount over an
   unlimited approval. This is the only on-chain transaction.
2. **EIP-712 order signing** (off-chain, gasless). The swap settles without the
   agent paying gas.

Each pack allowlists exactly these two paths and denies everything else,
including key export and arbitrary contract calls.

:::caution[The canonical domain is shared with CoW Swap]

On the 10 non-sovereign chains, Ophis uses CoW Protocol's canonical GPv2
contracts, so the EIP-712 order domain is byte-identical to CoW Swap's. A policy
that allowlists that domain therefore authorizes CoW-native order flow on that
chain too, not Ophis exclusively. Only **Optimism (10)** and **Unichain (130)**
run an Ophis-deployed settlement, so only those two carry an Ophis-exclusive
domain. If you need Ophis-exclusive routing on a shared-domain chain, also
enforce the orderbook host and appData in your in-code policy gate.

:::

## Addresses (the 12 live chains)

The packs pin these values. They are mirrored from `addresses.json`, which CI
diffs against `@ophis/sdk` (`OPHIS_SETTLEMENT_ADDRESSES` /
`OPHIS_VAULT_RELAYER_ADDRESSES`) so the packs cannot silently drift when a chain
is added. Addresses are EIP-55 checksummed.

| Chain | ID | Settlement (`verifyingContract`) | Vault relayer (`approve` spender) |
| --- | --- | --- | --- |
| Ethereum | 1 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Optimism *(sovereign)* | 10 | `0x310784c7FCE12d578dA6f53460777bAc9718B859` | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` |
| BNB Chain | 56 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Gnosis | 100 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Unichain *(sovereign)* | 130 | `0x108A678716e5E1776036eF044CAB7064226F714E` | `0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb` |
| Polygon | 137 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Base | 8453 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Plasma | 9745 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Arbitrum | 42161 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Avalanche | 43114 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Ink | 57073 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Linea | 59144 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |

Two further chains have settlement deployed but their orderbooks are paused
(4326 and 999), and Sepolia (11155111) is a testnet, so the packs cover the 12
live chains and exclude all three.

## The order EIP-712 types

Both providers pin fields inside the CoW order struct, so both need the same
type definition. The EIP-712 primary type is `Order` (the Solidity library is
`GPv2Order`, but the type name that feeds the type hash is `Order`).

```json
{
  "Order": [
    { "name": "sellToken", "type": "address" },
    { "name": "buyToken", "type": "address" },
    { "name": "receiver", "type": "address" },
    { "name": "sellAmount", "type": "uint256" },
    { "name": "buyAmount", "type": "uint256" },
    { "name": "validTo", "type": "uint32" },
    { "name": "appData", "type": "bytes32" },
    { "name": "feeAmount", "type": "uint256" },
    { "name": "kind", "type": "string" },
    { "name": "partiallyFillable", "type": "bool" },
    { "name": "sellTokenBalance", "type": "string" },
    { "name": "buyTokenBalance", "type": "string" }
  ]
}
```

## Turnkey

Turnkey is deny-by-default and an `EFFECT_DENY` policy overrides an
`EFFECT_ALLOW`, so the pack ALLOWs exactly two paths and adds two DENY guards.
Bind the agent to a **dedicated non-root API user**; keep root credentials
offline with a guardian who can revoke signing. Schema:
[policy language](https://docs.turnkey.com/concepts/policies/language),
[EVM + EIP-712 examples](https://docs.turnkey.com/concepts/policies/examples/ethereum).

Two subtleties, both documented in the pack README:

- **The NO_OP deny is mandatory.** Turnkey can inspect `eth.eip_712.*` fields
  only when the caller submits structured typed data
  (`PAYLOAD_ENCODING_EIP712`). A pre-hashed digest (`HASH_FUNCTION_NO_OP`) is
  opaque, so the receiver/domain pins would not apply; the deny closes that
  path. Reference:
  [secure EIP-712 signing](https://www.turnkey.com/blog/hyperliquid-secure-eip-712-signing).
- **Address casing.** Turnkey compares addresses as case-sensitive strings and
  the EIP-712 docs mandate **lowercase** hex for `eth.eip_712.*` conditions,
  while `eth.tx.*` examples use checksummed hex. Verify the casing each field
  expects against a real payload; a mismatch fails closed (denied).

Also: `eth.tx.contract_call_args['spender']` decodes only after you upload the
token ABI, and the arg key equals the ABI parameter name (canonical ERC-20 is
`spender` / `value`; some tokens use `guy` / `wad`).

### Copy-paste: Optimism (10), the sovereign case

```json
{
  "policies": [
    {
      "policyName": "Ophis OP: allow approve() only to the vault relayer, allowlisted tokens",
      "effect": "EFFECT_ALLOW",
      "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 10 && eth.tx.value == 0 && eth.tx.function_name == 'approve' && eth.tx.contract_call_args['spender'] == '0x83847EaB41ad9ea43809ce71569eB2e9daF51830' && eth.tx.to in ['0xTOKEN_1', '0xTOKEN_2']"
    },
    {
      "policyName": "Ophis OP: allow signing an Ophis order only",
      "effect": "EFFECT_ALLOW",
      "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && activity.params.encoding == 'PAYLOAD_ENCODING_EIP712' && eth.eip_712.primary_type == 'Order' && eth.eip_712.domain.name == 'Gnosis Protocol' && eth.eip_712.domain.version == 'v2' && eth.eip_712.domain.chain_id == 10 && eth.eip_712.domain.verifying_contract == '0x310784c7fce12d578da6f53460777bac9718b859' && eth.eip_712.message['receiver'] == '0xagent_wallet_lowercase' && eth.eip_712.message['sellToken'] in ['0xtoken_1_lowercase', '0xtoken_2_lowercase'] && eth.eip_712.message['buyToken'] in ['0xtoken_1_lowercase', '0xtoken_2_lowercase']"
    },
    {
      "policyName": "Ophis OP: deny the pre-hashed NO_OP bypass",
      "effect": "EFFECT_DENY",
      "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && activity.params.hash_function == 'HASH_FUNCTION_NO_OP' && activity.params.encoding != 'PAYLOAD_ENCODING_EIP712'"
    },
    {
      "policyName": "Ophis OP: deny key/seed export by the agent user",
      "effect": "EFFECT_DENY",
      "condition": "activity.action == 'EXPORT'"
    }
  ]
}
```

### Copy-paste: Base (8453), the shared-domain case

Identical shape; only `chain_id` and the (canonical) `verifying_contract` +
relayer change. Note the reminder above: on Base the domain is shared with CoW
Swap.

```json
{
  "policies": [
    {
      "policyName": "Ophis Base: allow approve() only to the vault relayer, allowlisted tokens",
      "effect": "EFFECT_ALLOW",
      "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 8453 && eth.tx.value == 0 && eth.tx.function_name == 'approve' && eth.tx.contract_call_args['spender'] == '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' && eth.tx.to in ['0xTOKEN_1', '0xTOKEN_2']"
    },
    {
      "policyName": "Ophis Base: allow signing an Ophis order only",
      "effect": "EFFECT_ALLOW",
      "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && activity.params.encoding == 'PAYLOAD_ENCODING_EIP712' && eth.eip_712.primary_type == 'Order' && eth.eip_712.domain.name == 'Gnosis Protocol' && eth.eip_712.domain.version == 'v2' && eth.eip_712.domain.chain_id == 8453 && eth.eip_712.domain.verifying_contract == '0x9008d19f58aabd9ed0d60971565aa8510560ab41' && eth.eip_712.message['receiver'] == '0xagent_wallet_lowercase' && eth.eip_712.message['sellToken'] in ['0xtoken_1_lowercase'] && eth.eip_712.message['buyToken'] in ['0xtoken_1_lowercase']"
    },
    {
      "policyName": "Ophis Base: deny the pre-hashed NO_OP bypass",
      "effect": "EFFECT_DENY",
      "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && activity.params.hash_function == 'HASH_FUNCTION_NO_OP' && activity.params.encoding != 'PAYLOAD_ENCODING_EIP712'"
    },
    {
      "policyName": "Ophis Base: deny key/seed export by the agent user",
      "effect": "EFFECT_DENY",
      "condition": "activity.action == 'EXPORT'"
    }
  ]
}
```

For any other chain, take the parameterized
[`turnkey/ophis-agent-policy.template.json`](https://github.com/ophis-fi/ophis/tree/main/examples/agent-wallet-policy-packs/turnkey)
and substitute the row from the table above.

## Privy

Privy policies are default-DENY: a method with no matching `ALLOW` is denied,
and any `DENY` overrides an `ALLOW`. Conditions inside a rule are ANDed. Do not
add a catch-all `"method": "*"` DENY (it would override the allows). Privy can
inspect both the typed-data domain and message fields, so the receiver and token
pins hold at signing time. Schema:
[policies overview](https://docs.privy.io/controls/policies/overview),
[EVM examples](https://docs.privy.io/controls/policies/example-policies/ethereum).

Watch `chain_id` vs `chainId`: the transaction source uses snake_case
(`ethereum_transaction.chain_id`), the typed-data domain uses camelCase
(`ethereum_typed_data_domain.chainId`). Message-field conditions must carry the
`typed_data` schema (the `Order` types above) so the engine can decode. The
`approve.spender` and `receiver` paths follow Privy's documented
`transfer.amount` / `owner.wallet` patterns; validate both in staging, since the
Privy examples do not show `approve()` or a bare `receiver` field verbatim.

### Copy-paste: Optimism (10)

Replace `ORDER_TYPES` with the `Order` type array above, `0xAGENT` with the
agent wallet, and `0xTOKEN_1` / `0xTOKEN_2` with your token allowlist.

```json
{
  "version": "1.0",
  "name": "Ophis-only agent wallet (Optimism)",
  "chain_type": "ethereum",
  "rules": [
    {
      "name": "Allow approve() only to the vault relayer",
      "method": "eth_sendTransaction",
      "action": "ALLOW",
      "conditions": [
        { "field_source": "ethereum_transaction", "field": "chain_id", "operator": "eq", "value": "10" },
        { "field_source": "ethereum_transaction", "field": "value", "operator": "eq", "value": "0x0" },
        { "field_source": "ethereum_transaction", "field": "to", "operator": "in", "value": ["0xTOKEN_1", "0xTOKEN_2"] },
        { "field_source": "ethereum_calldata", "field": "function_name", "operator": "eq", "value": "approve",
          "abi": [{ "name": "approve", "type": "function", "stateMutability": "nonpayable",
            "inputs": [{ "name": "spender", "type": "address" }, { "name": "amount", "type": "uint256" }],
            "outputs": [{ "name": "", "type": "bool" }] }] },
        { "field_source": "ethereum_calldata", "field": "approve.spender", "operator": "eq", "value": "0x83847EaB41ad9ea43809ce71569eB2e9daF51830",
          "abi": [{ "name": "approve", "type": "function", "stateMutability": "nonpayable",
            "inputs": [{ "name": "spender", "type": "address" }, { "name": "amount", "type": "uint256" }],
            "outputs": [{ "name": "", "type": "bool" }] }] }
      ]
    },
    {
      "name": "Allow signing Ophis orders only",
      "method": "eth_signTypedData_v4",
      "action": "ALLOW",
      "conditions": [
        { "field_source": "ethereum_typed_data_domain", "field": "chainId", "operator": "eq", "value": "10" },
        { "field_source": "ethereum_typed_data_domain", "field": "verifyingContract", "operator": "eq", "value": "0x310784c7FCE12d578dA6f53460777bAc9718B859" },
        { "field_source": "ethereum_typed_data_message", "field": "receiver", "operator": "eq", "value": "0xAGENT",
          "typed_data": { "types": { "Order": "ORDER_TYPES" }, "primary_type": "Order" } },
        { "field_source": "ethereum_typed_data_message", "field": "sellToken", "operator": "in", "value": ["0xTOKEN_1", "0xTOKEN_2"],
          "typed_data": { "types": { "Order": "ORDER_TYPES" }, "primary_type": "Order" } },
        { "field_source": "ethereum_typed_data_message", "field": "buyToken", "operator": "in", "value": ["0xTOKEN_1", "0xTOKEN_2"],
          "typed_data": { "types": { "Order": "ORDER_TYPES" }, "primary_type": "Order" } }
      ]
    },
    { "name": "Never export the raw key", "method": "exportPrivateKey", "action": "DENY", "conditions": [] },
    { "name": "Never export the seed phrase", "method": "exportSeedPhrase", "action": "DENY", "conditions": [] }
  ]
}
```

For Base or any other chain, change the two `chain_id` / `chainId` values and the
`verifyingContract` + relayer to that chain's row, using the parameterized
[`privy/ophis-agent-policy.template.json`](https://github.com/ophis-fi/ophis/tree/main/examples/agent-wallet-policy-packs/privy).
On Base the `verifyingContract` is the canonical `0x9008D19f...ab41` and the
relayer is `0xC92E8bdf...0110` (shared with CoW Swap, per the caution above).

## A working trade path

The pack only says what the key may sign. To get a valid, bounded order to sign,
use the keyless [Ophis MCP server](./ai-agents.md) at
`https://mcp.ophis.fi/mcp` or the `@ophis/sdk`:

1. **`build_order`** returns a ready-to-sign order with the `receiver` already
   pinned to the owner and slippage bounded against a live quote, plus the exact
   EIP-712 `domain` + `types`.
2. **Approve** the vault relayer once per sell token (a bounded amount). The
   pack's approve rule permits only this.
3. **Sign** the typed data with the constrained wallet. The pack lets it through
   only because the domain, receiver, and token set match.
4. **`submit_order`** relays the signed order; it also refuses any non-owner
   receiver as a second check.

The full loop, with Turnkey and Privy signing snippets, is in
[`example-constrained-trade.md`](https://github.com/ophis-fi/ophis/blob/main/examples/agent-wallet-policy-packs/example-constrained-trade.md).

:::warning[Policy packs bound exfiltration, not price]

These packs are the containment layer, not the whole autonomous-trading story.
For an agent that signs without human review, also run the in-code policy gate
from [AI agent integration](./ai-agents.md): token resolution from a chain-scoped
allowlist, limit price within X% of an independent staleness-checked oracle,
per-trade and rolling notional caps, and a short `validTo`. The pack stops the
drain; the gate stops the bad price.

:::
