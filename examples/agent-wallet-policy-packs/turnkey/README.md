# Ophis policy pack: Turnkey

Constrains a Turnkey-held agent key to Ophis trades only. See the top-level
[README](../README.md) for the accurate framing (this is anti-exfiltration
pinning, not a price bound) and the address table.

- Template: [`ophis-agent-policy.template.json`](./ophis-agent-policy.template.json)
- Schema reference: https://docs.turnkey.com/concepts/policies/language
- EVM + EIP-712 examples: https://docs.turnkey.com/concepts/policies/examples/ethereum
- ABI upload (for calldata decoding): https://docs.turnkey.com/concepts/policies/smart-contract-interfaces

## Model

Turnkey is **deny-by-default**, and an `EFFECT_DENY` policy overrides an
`EFFECT_ALLOW`. Create these policies on the sub-organization that holds the
agent key, and bind the agent to a **dedicated non-root API user**. Root
credentials stay offline with your guardian, who can add a `EFFECT_DENY` or
remove the API user to revoke signing at any time.

## What each policy does

| Policy | Effect | What it pins |
| --- | --- | --- |
| approve only to relayer | ALLOW | `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` where `eth.tx.function_name == 'approve'`, `contract_call_args['spender']` equals the vault relayer, `eth.tx.to` is on your token allowlist, `eth.tx.value == 0`, and the chain id matches. Optionally cap `contract_call_args['value']`. |
| sign an Ophis order | ALLOW | `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2` with `encoding == 'PAYLOAD_ENCODING_EIP712'`, `primary_type == 'Order'`, the domain (`name`, `version`, `chain_id`, `verifying_contract`) pinned to the Ophis settlement, `message['receiver']` pinned to the agent's own address, and `message['sellToken']` / `message['buyToken']` on your allowlist. |
| deny NO_OP bypass | DENY | Blocks `HASH_FUNCTION_NO_OP` non-EIP712 raw-payload signing (a pre-hashed digest Turnkey cannot introspect). |
| deny key export | DENY | Blocks `activity.action == 'EXPORT'` by the agent user. |

## Two subtleties that matter

1. **The NO_OP deny is mandatory.** Turnkey can inspect `eth.eip_712.*` fields
   only when the caller submits structured typed data
   (`PAYLOAD_ENCODING_EIP712`). If the agent instead submits a pre-computed
   32-byte order digest with `HASH_FUNCTION_NO_OP`, Turnkey sees an opaque hash
   and the receiver/domain pins do not apply. The deny policy closes that path.
   Have the agent submit the structured order (encoding `EIP712`), not a digest.
   Reference:
   https://www.turnkey.com/blog/hyperliquid-secure-eip-712-signing

2. **Address casing is a footgun.** Turnkey compares addresses as case-sensitive
   strings. The EIP-712 docs mandate **lowercase** hex for `eth.eip_712.*`
   conditions, while the `eth.tx.*` examples use checksummed hex. The template
   uses `_LOWERCASE` placeholders in the EIP-712 policy and checksummed
   placeholders in the transaction policy for that reason. Confirm the exact
   normalization Turnkey applies to each field against a real signed payload
   before you rely on it; a casing mismatch fails closed (the action is denied),
   which is safe but will look like a broken policy.

## The `approve` arg name

`eth.tx.contract_call_args['spender']` decodes only after you upload the token's
ABI, and the key equals the **ABI parameter name**. Canonical ERC-20 is
`approve(address spender, uint256 value)` (`spender` / `value`), but some tokens
name them differently (WETH uses `guy` / `wad`). Check the ABI you upload per
token and adjust the arg key if needed.

## Apply it

Substitute the `{{PLACEHOLDER}}` values from [`../addresses.json`](../addresses.json)
for your chain, then create the policies with the Turnkey SDK/API or dashboard.
Do this per chain your agent trades on.
