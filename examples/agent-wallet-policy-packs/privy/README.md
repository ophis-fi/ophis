# Ophis policy pack: Privy

Constrains a Privy server wallet or session signer to Ophis trades only. See the
top-level [README](../README.md) for the accurate framing (this is
anti-exfiltration pinning, not a price bound) and the address table.

- Template: [`ophis-agent-policy.template.json`](./ophis-agent-policy.template.json)
- Schema reference: https://docs.privy.io/controls/policies/overview
- EVM examples: https://docs.privy.io/controls/policies/example-policies/ethereum

## Model

Privy policies are **default-DENY**: any method with no matching `ALLOW` rule is
denied, and if any rule evaluates to `DENY` the request is denied even when
another rule would allow it. Conditions inside one rule are ANDed. Attach the
policy to the agent's wallet (or its session signer). Because DENY wins, **do
not** add a catch-all `{ "method": "*", "action": "DENY" }` rule; it would
evaluate on every call and override the ALLOW rules. The implicit default
already denies everything not explicitly allowed.

## What each rule does

| Rule | Action | What it pins |
| --- | --- | --- |
| approve to relayer | ALLOW | `eth_sendTransaction` where `ethereum_calldata` `function_name == 'approve'`, `approve.spender` equals the vault relayer, `ethereum_transaction.to` is on your token allowlist, `value == 0x0`, `chain_id` matches. Optional `approve.amount` cap. |
| sign an Ophis order | ALLOW | `eth_signTypedData_v4` where the `ethereum_typed_data_domain` `verifyingContract` and `chainId` are pinned to the Ophis settlement, `ethereum_typed_data_message` `receiver` is pinned to the agent's own address, and `sellToken` / `buyToken` are on your allowlist. |
| deny key export | DENY | `exportPrivateKey`. |
| deny seed export | DENY | `exportSeedPhrase`. |

Privy can introspect both the typed-data **domain** and **message** fields, so
the receiver and token pins are enforced at signing time, not merely by
allowing the method wholesale.

## Two subtleties that matter

1. **`chain_id` vs `chainId`.** The transaction source uses snake_case
   (`ethereum_transaction.chain_id`); the typed-data domain source uses
   camelCase (`ethereum_typed_data_domain.chainId`, mirroring EIP-712). Do not
   mix them.

2. **Message conditions need the typed-data schema.** An
   `ethereum_typed_data_message` condition must carry a `typed_data`
   (`types` + `primary_type`) so the engine can decode the order. The template
   references the GPv2 `Order` type set; substitute it in full (see
   `{{ORDER_TYPES_REF}}` in the template and the resolved order types in the
   docs page). The `approve.spender` calldata path and the `receiver` message
   path follow Privy's documented `transfer.amount` / `owner.wallet` patterns;
   validate both against a staging call before production, since Privy's
   examples do not show `approve()` or a bare `receiver` field verbatim.

## Apply it

Substitute the `{{PLACEHOLDER}}` values from [`../addresses.json`](../addresses.json)
and the `Order` types from the docs page, then create the policy with the Privy
API/dashboard and attach it to the agent wallet. Do this per chain your agent
trades on (or combine per-chain rules into one policy).
