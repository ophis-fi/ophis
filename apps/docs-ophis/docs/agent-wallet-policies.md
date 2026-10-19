---
id: agent-wallet-policies
title: Agent wallet policy packs
description: Configure Turnkey policies for an agent wallet that approves tokens and signs Ophis orders.
sidebar_label: Wallet policies
sidebar_position: 3
---

# Agent wallet policy packs

Use Turnkey policies to restrict an agent's approvals, order signing, token choices and receiver address.

<Cards>
<Card icon="lock" title="Pinned spender">Approve sell tokens only for the chain's vault relayer.</Card>
<Card icon="wallet" title="Pinned receiver">Send bought tokens to the agent's own account.</Card>
<Card icon="shield-check" title="Allowed tokens">Restrict orders to your token allowlist and settlement domain.</Card>
</Cards>

## Configure Turnkey {/* #turnkey */}

The [policy packs](https://github.com/ophis-fi/ophis/tree/main/examples/agent-wallet-policy-packs) allow token approvals and EIP-712 order signing. Turnkey denies other actions by default, and `EFFECT_DENY` overrides `EFFECT_ALLOW`.

<Steps>

1. **Create a dedicated user.** Give the agent a non-root API user; keep root credentials offline with a guardian who can revoke signing.
2. **Set the policy values.** Use the chain's addresses below, your wallet as `receiver`, and your token allowlist.
3. **Upload the token ABI.** Turnkey needs it to decode `eth.tx.contract_call_args['spender']`; match argument names to the token ABI.
4. **Check address casing.** Use lowercase hex in `eth.eip_712.*` conditions and the checksummed addresses shown for `eth.tx.*`; verify against a real payload.
5. **Apply the deny guards.** Include the pre-hashed signing and key-export deny rules in the examples below.

</Steps>

| Setting | Required value |
| --- | --- |
| EIP-712 domain name | `Gnosis Protocol` |
| EIP-712 domain version | `v2` |
| Primary type | `Order` |
| `verifyingContract` | The chain's settlement address |
| `receiver` | The agent's own account |
| Approval argument names | Canonical ERC-20: `spender` / `value`; some tokens: `guy` / `wad` |

:::warning[Keep the pre-hashed signing guard]

Turnkey inspects order fields through `PAYLOAD_ENCODING_EIP712`. A pre-hashed `HASH_FUNCTION_NO_OP` digest bypasses those field checks, so keep the `NO_OP` deny rule.

:::

See Turnkey's [policy overview](https://docs.turnkey.com/concepts/policies/overview), [policy language](https://docs.turnkey.com/concepts/policies/language), [EVM examples](https://docs.turnkey.com/concepts/policies/examples/ethereum) and [EIP-712 signing guide](https://www.turnkey.com/blog/hyperliquid-secure-eip-712-signing).

## Contract addresses {/* #addresses-the-14-production-chains */}

Use these EIP-55 checksummed addresses from the pack's `addresses.json`:

| Chain | ID | Settlement (`verifyingContract`) | Vault relayer (`approve` spender) |
| --- | --- | --- | --- |
| Ethereum | 1 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Optimism *(sovereign)* | 10 | `0x310784c7FCE12d578dA6f53460777bAc9718B859` | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` |
| BNB Chain | 56 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Gnosis | 100 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Unichain *(sovereign)* | 130 | `0x108A678716e5E1776036eF044CAB7064226F714E` | `0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb` |
| Polygon | 137 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Robinhood Chain *(sovereign)* | 4663 | `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD` | `0xB52C38097c19cd38238c62DD36027a7918eFa890` |
| Arc *(sovereign)* | 5042 | `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A` | `0x895505F1FE6D762296685fF4a8201782FFdCB8E9` |
| Base | 8453 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Plasma | 9745 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Arbitrum | 42161 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Avalanche | 43114 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Ink | 57073 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Linea | 59144 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |

| Pack coverage | Networks |
| --- | --- |
| Production | The 14 networks above |
| Testnet excluded | Sepolia (11155111) |

:::info[Shared signing domains]

On the 10 CoW-hosted chains above, the domain also authorizes CoW Swap orders. Optimism, Unichain, Robinhood Chain and Arc use Ophis-deployed settlements. For Ophis-specific routing on a shared-domain chain, check the orderbook host and appData before signing.

:::

## Order type {/* #the-order-eip-712-types */}

Use `Order` as the EIP-712 primary type; `GPv2Order` is the Solidity library name.

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

## Optimism policy

Replace the token and wallet placeholders with your allowlist and agent address.

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

## Base policy

This Turnkey policy lets the agent wallet do two things on Base: approve allowlisted tokens for the CoW vault relayer, and sign Ophis orders that pay out to the agent's own wallet. It blocks the pre-hashed signing bypass and key export. Base uses the shared CoW signing domain.

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

For other chains, use the [Turnkey template](https://github.com/ophis-fi/ophis/tree/main/examples/agent-wallet-policy-packs/turnkey) with the matching row from the address table.

## Submit a trade {/* #a-working-trade-path */}

<Steps>

1. **Build the order.** Call `build_order` through the [MCP server](/ai-agents) to get a live quote, slippage bounds, owner-pinned receiver and EIP-712 `domain` and `types`.
2. **Approve the sell token.** Approve a bounded amount for the vault relayer; keep native gas for the transaction.
3. **Review and sign.** Check the sell amount and minimum buy amount, then sign with the constrained wallet.
4. **Submit the signature.** Call `submit_order`, which also checks that the receiver is the owner.

</Steps>

The [constrained trade example](https://github.com/ophis-fi/ophis/blob/main/examples/agent-wallet-policy-packs/example-constrained-trade.md) includes the Turnkey signing loop.

## Next

<Cards>
<Card icon="bot" title="Agent integration" href="/ai-agents">Connect the MCP server or a framework adapter.</Card>
<Card icon="scale" title="Order controls" href="/agent-swap-comparison">Review the limits enforced for each swap.</Card>
</Cards>
