# Ophis broadcaster: follow the RAILGUN payment model

Status: payment UX selected by the user on 31 October 2026. The proposed separate user gas allowance is not selected. This source comparison supersedes that proposal; it does not enable mainnet, authorize funding, or establish guaranteed payment for every failed transaction.

## Verified reference and scope

The public reference is [Railgun-Community/ppoi-safe-broadcaster-example](https://github.com/Railgun-Community/ppoi-safe-broadcaster-example), package 8.0.0. A fresh GitHub API check found main at `ec49691533b4edc2dafefbd8cdb5f611290b2115`, dated 10 December 2025. All 150 cached source/README/package/lockfile blobs matched the tree of that exact public commit. This establishes the public example's identity, not the software or configuration running behind every community broadcaster.

The reverse-engineer-anything skill directs normal source analysis when a complete repository is available. The investigation followed admission, fee validation, operator sending, receipt handling and optional balance replenishment. No upstream service or live operator was run, no dependency tree was installed, and no chain transaction was submitted.

## Payment flow to preserve

1. The broadcaster advertises supported fee tokens and rates over Waku. The client estimates gas and calculates a quoted broadcaster fee.
2. The client includes a private fee output addressed to the broadcaster in its original proof/transaction. It submits the encrypted request over Waku. There is no separate customer gas-credit deposit in this reference flow.
3. The broadcaster selects a funded operator wallet, estimates execution, extracts its own first fee note, checks the token/amount against its quote and required gas, checks the gas price and validates required spendability proofs.
4. Its public wallet signs and submits the original transaction, advancing native gas. In Ophis, retain the exact user batch inside the added execution guard and use only the protected write endpoint.
5. When the private batch executes, the fee output goes to the broadcaster's private wallet. Proof-of-innocence assurance makes an actually received fee spendable; it does not create payment after a whole transaction revert.
6. Operator working gas capital must exist before this flow can start. The public example can optionally unshield earned fees, unwrap the wrapped gas token or swap other tokens to replenish native gas. That top-up feature is disabled by default; it is not a user top-up requirement.

Sources: [admission and packaged fee](https://github.com/Railgun-Community/ppoi-safe-broadcaster-example/blob/ec49691533b4edc2dafefbd8cdb5f611290b2115/src/server/transactions/process-transaction.ts), [operator submission and waiting](https://github.com/Railgun-Community/ppoi-safe-broadcaster-example/blob/ec49691533b4edc2dafefbd8cdb5f611290b2115/src/server/transactions/execute-transaction.ts), [official broadcaster UX](https://docs.railgun.org/developer-guide/wallet/broadcasters).

## Failure cases must remain distinct

| Event | Consequence |
| --- | --- |
| Estimate, fee or required proof fails before submission | Reject before sending a chain transaction; no operator execution gas is spent. |
| A swap action fails but the canonical private batch and outer execution complete | The private fee can remain paid. The canonical 7702 delegate executes the mandatory private batch before its external action multicall, whose require-success setting controls whether an action failure reverts the whole transaction. |
| The entire outer transaction reverts after inclusion | The private fee transfer is undone, while the operator still pays for consumed gas. No separate reimbursement, escrow or failed-gas claim was found in the reviewed reference path. |
| Relay/RPC response times out | Outcome is uncertain. Keep Ophis's durable exact-byte journals and nonce lock rather than assuming no transaction was accepted. |

An offline probe executed the hash-verified upstream admission and fee-validator functions with explicit stubs for network, pricing, extraction and proof dependencies. Four asserted cases passed: estimate failure, insufficient fee, invalid PPOI and accepted request. These establish admission ordering and rejection behavior under those stubs; they are not real proofs, mined transactions or deployed-operator observations.

## What following the reference does not mean

The public example implements the older static proxy/relay path, not the current canonical type-4 server flow used by Ophis. Its application logic does not implement authorization-list validation, the execution guard, a private-only write transport or a no-revert inclusion policy. Individual operators may use different implementations and private infrastructure. Do not copy its ordinary-RPC defaults, permissive variance, short in-memory duplicate cache or weaker recovery semantics into Ophis.

Its default profit markup is 15% of an adjusted gas-cost ratio. That is a configurable example setting, not a promise that the quoted fee equals exact receipt gas or an insurance mechanism. No automatic unused-fee refund or separate prepaid ledger was found in the reviewed payment path. This investigation does not change Ophis's existing 10 bp swap fee or broadcaster markup (currently zero).

## Ophis implementation and release work

Ophis already implements this packaged-private-fee model. Continue that path rather than adding a new deposit product. Preserve exact fee-note authentication, current oracle-priced maximum gas coverage, mandatory PPOIs, full private trace validation, the execution guard, private-only submission, integer budgets, one unresolved operator nonce, durable journals and bounded cancellation.

At the 31 October review checkpoint, the user's priorities remained security, avoiding Ophis losses and user payment even on failure. Following the reference selects a familiar fee UX; it does not by itself satisfy the last two priorities for every fully reverted transaction. Mainnet startup and original retries were held, with no operator gas address or capital amount selected and no frontend approval, funding or deployment.

## 1 November launch preparation

The broadcaster is now deployed, synchronized and unarmed on Baal. New gas and private fee wallets have verified encrypted off-server backups. The gas wallet remains unfunded; no guard deployment or signed mainnet transaction has occurred. Enabled mainnet mode is restricted to an explicitly selected pilot account and an operator-bound guard, with a positive fee markup and explicit gas, transaction, rolling-budget and reserve limits. General/public activation remains held, as do original mainnet retries.

Fee coverage now rounds upward in both client and server, and recovery verifies complete UTXO-tree/nullifier pairs. Separable COMMON fee proofs cannot be handed to either a private broadcaster or the public-gas resume path; old records are retained for reconciliation/manual recovery. The confirmed-previous-transport-journal crash gap and local Vite origin/JSON checks are covered by regressions. Fresh Linux checks and an independent static/source review are recorded in [broadcaster validation](../../../apps/broadcaster/VALIDATION.md).

A 15% markup and total 0.003 ETH pilot funding envelope are proposed, not approved. The remaining actions require the owner's fee choice, budget and funding source, then actual guard deployment, restricted live fee/PPOI/private-inclusion acceptance and a reviewed Ethereum frontend activation. See [operations](../../../apps/broadcaster/OPERATIONS.md). Included outer reverts and operator cancellations remain potential unreimbursed ETH costs under the selected payment model.

On 1 November, the actual fee-bearing private swap and authorization-race probe passed end to end on a disposable fork. A second run used the real protected-sender implementation, verified its durable journal before private disclosure, rejected any signed write on the read connection and found the authenticated private fee commitment in the successful receipt. Live required-list/TXID roots also passed positive/negative checks through the installed SDK. See the [validation record](../../../apps/broadcaster/VALIDATION.md).

The disk reserve was restored by removing only regeneratable caches in inactive test browser profiles. Test wallets, IndexedDB, recovery state and historical public-event caches were preserved. The fresh test wallet uses its actual creation block to avoid scanning irrelevant earlier wallet activity; the public commitment tree still synchronizes in full. The browser fixture enforces the 6 GiB reserve during execution.

Actual funded private inclusion and exact live fee assurance remain activation checks. Distinguish the observed protection against malicious user requests from assumptions about builders, disclosure and canonical-chain changes. Resolve the residual financial requirements before funded activation; do not manufacture an unconditional guarantee from passing fork tests, source similarity or an example profit margin.

Further protocol references: [EIP-140 revert semantics](https://eips.ethereum.org/EIPS/eip-140), [EIP-7702 sponsored relayer risks](https://eips.ethereum.org/EIPS/eip-7702#sponsored-transaction-relayers), [RAILGUN self-signing privacy](https://docs.railgun.org/developer-guide/wallet/transactions/ux-private-transactions).
