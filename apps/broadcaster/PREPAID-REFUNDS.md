# Prepaid payments and refunds
## Public native prepayment

The current candidate uses `OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE=public-native` on Ethereum or BNB. It receives native ETH/BNB directly at the configured gas operator. No ANON private transfer, unwrap, owner collection or external POI is required for this payment. The existing viewing identity still authenticates encrypted requests; it is not the native recipient.

1. The client obtains the pinned operator and native ledger identity. It records an exact amount, public sender, nonce and opaque one-time payment commitment **before** requesting a wallet transaction. The connected ordinary public account pays this initial transaction's gas. Delegated/smart accounts and operator self-funding are rejected before the prompt.
2. After successful canonical finality, the broadcaster verifies the exact native payment and the authenticated claimant's secret payment reference. It credits the transaction once. A second mined payment with the same reference is quarantined as a liability, never revenue or a second spendable credit.
3. Before any operation signature, the ledger reserves the customer's signed maximum and proves the operator's current native balance covers **all customer liabilities plus the configured reserve**. Deposits and settlements retain canonical block anchors. A pending operator attempt blocks the next signature until final settlement.
4. Successful and reverted operations charge their actual receipt gas plus the agreed margin. Cancellation uses the same reservation and nonce; its cost is bounded before signing. No automatic public submission fallback exists.

The top-up publicly reveals its sender, operator and amount. Its opaque reference does not reveal the derived private account, but Ophis can link requests using the same credit account. This is custodial fee credit held by the online operator; reserve checks do not remove operator/key compromise or trusted-RPC risk. Never treat unexplained wallet surplus or quarantined payments as earnings.

### Native refunds and recovery

The user reviews a **public refund address**, gross reserved credit, maximum processing fee and exact net payout. The refund shares the normal signed-request journal, operator nonce and protected transport. Its signed maximum covers the payout plus bounded gas and margin. On finalized success the charge is net payout plus actual gas and margin; on revert/cancellation it is actual gas and margin only. The unused hold returns to credit. The client independently checks the finalized receipt, sender, recipient and amount before clearing its saved refund.

The initial refund quote conservatively reserves the configured maximum transaction cost. Consequently, it may leave a credit remainder, and a balance below that allowance cannot currently be refunded; it remains usable for later fees. This is not an automatic full-balance withdrawal. Refund admission requires the reviewed runtime enabled; paused read/recovery remains available.

An unknown top-up keeps its sender, nonce, amount and reference. Retry uses the same nonce, or advances only after the exact earlier transaction has finalized as failed. If the wallet sent a payment but lost its response, the user may supply that transaction hash through **Check top-up**; the client verifies it against the saved payment. Never clear a pending record to create a second payment. Unknown refund/operation outcomes use their saved request and existing recovery controls.

### Migration and activation

Keep historical private ledgers, owner-intent records and protected/request journals intact. A native ledger is a distinct scope; changing the mode against an existing private ledger fails closed. Before preparing a fresh native ledger on the same gas operator, stop the old signer and account for every retained signed operation or cancellation at or above the current operator nonce. A new starting nonce alone is not proof that old signatures cannot compete. Carry no customer balance across scopes implicitly.

Deploy the reviewed artifact and configuration with broadcasting disabled first. Preserve existing custody pins, unlock rules, spending budgets and BNB pilot restrictions. Verify exact artifact/configuration, current operator code/nonce/balance, old pending signatures and native ledger scope before owner unlock and bounded live acceptance. New frontend approvals remain expired until qualification. The local native fork tests demonstrate changed accounting with disposable keys; they do not establish mainnet protected delivery or real user swap/withdrawal acceptance.

## Historical private-credit recovery only

The following ANON procedure remains available for old private ledgers. It is **not** used by public-native payment mode and does not authorize new private-credit admission.

These commands describe the reviewed prepaid build. Deployment, production pricing and live owner acceptance remain separate release gates. The server holds only the fee wallet's viewing authority. The owner signs private payments in the existing ANON wallet; this procedure does not request its recovery phrase or spending key.

**Stock ANON compatibility is not yet accepted.** Static review of the signed ANON 0.12.4 unshield path found amount, recipient, route and fee confirmation, but no exposed exact private-input/proof/change review or unsigned private-proof export. Do not instruct the owner to use an export or proof-selection feature that this path does not provide. The commands below describe the operator journal lifecycle; they are not permission to send a production payment through an unqualified wallet route. An explicitly approved, bounded owner pilot must establish actual wallet compatibility before activation. A synthetic gateway proof does not establish that compatibility.

**Fee-credit collectability also blocks launch.** Current canonical backing checks can accept a received private transfer without its sender's external POI, while stock ANON excludes that note from spendable inputs. A sender can withhold this proof, so a successful cooperative pilot alone cannot secure admission. Before activation, close this gap in the payment implementation and qualify the selected collection route; do not spend operator gas against credit that the approved owner route cannot collect. See the [release review](../../docs/audits/2026-11-09-prepaid-release-review.md#blocking-fee-credit-collectability-defect) for evidence and the pending payment-policy decision.

Customer credit is a liability. Earned fees are settled execution charges plus completed refund fees, less verified owner payment costs and collections. Unclaimed deposits and apparent wallet surplus are never earnings. Every operator reservation requires canonical accounted backing for all liabilities and earnings, and enough value in one accounted note to recover earnings, outstanding execution maxima, queued refund gross amounts and the proposed charge. A refund quote advertises `maximumRefundGross`; a larger request is rejected before creating a hold. Only one refund per owner may be pending. Refunds also preserve one maximum attempt charge when another customer has enough available credit to use it; a dust-only second account does not prevent the first customer's full exit. Customers may request a smaller partial refund.

## Inspect and budget

Use the correct chain configuration and the stopped-service operator lock. The commands acquire the lock themselves.

```sh
node dist/main.mjs refunds
node dist/main.mjs report
```

The customer first signs a refund request specifying its exact private recipient and net amount. `refunds` lists the pending requests without unlocking a key. A refund to the fee wallet itself is rejected.

Review ANON's complete private WETH/WBNB quote for the payout and for later native collection. The retained refund fee is `gross − net`; it must cover both costs, the protocol unshield fee, ANON's 13 bps gateway fee on the pool-net amount and the configured margin. Pricing and owner preflight verify the pinned gateway runtime and current 13 bps fee; unsupported changes close new pricing. Keep the customer's signed net amount unchanged. The optional read-only arithmetic check is:

```sh
node dist/main.mjs owner-cost-preflight /absolute/path/refund-cost-quote.json
```

The owner-reviewed JSON file must have 0600 permissions and contain `kind: "refund"`, exact `chainId`, `ledgerId`, `operator`, wrapped `token`, saved `refundKey`, and `expiresAt` in milliseconds no more than five minutes ahead. `costs` has exactly `payout` and `collection`. A complete ANON private quote is `{ "privateFeeWei": "..." }`. An unsigned gas-budget estimate can instead use decimal-string `gasLimit` and `maxFeePerGas`; it is advisory arithmetic, not permission to use a different spending path. There are no manual unwrap/refill steps: supported collection sends native ETH/BNB directly to the authorized gas operator.

Exit 0 means the supplied budgets fit; exit 2 reports a shortfall. This command neither verifies quote provenance nor creates an owner intent. Its health balance sample is advisory. Actual canonical backing is checked by the next command.

## Prepare the owner intent before signing

Create a private 0600 operation-plan file containing `chainId`, `ledgerId`, `operator`, wrapped `token`, `expiresAt`, `kind`, `maximumPrivateFee`, `minimumNative`, `inputLimit`, `outputLimit`, `proofLimit` and `marginBps`. Quantities are decimal strings except the chain, expiry and three integer shape limits. Actual owner input/output/proof limits and margin must exactly match the explicitly qualified configuration; they default to disabled. For `kind: "refund"`, include `refundKey` and set `minimumNative: "0"`.

```sh
node dist/main.mjs prepare-owner-operation /absolute/path/owner-operation.json
```

Preparation uses the existing owner unlock and wallet synchronization procedure to read the fee wallet. It does not sign or send a payment. It verifies canonical backing before saving an immutable intent and halting new operator spending. All earlier operator attempts must already be settled. Refund preparation reserves capacity for the full pending gross amounts, including their future retained fees. Collection preparation covers the exact remaining earned amount and preserves queued refunds; it reads current pool and gateway fees and rejects a minimum native amount that the approved maximum private fee cannot leave after those deductions. A nonempty journal predating this accounting version requires explicit history reconciliation; lifetime earnings are not assumed to remain uncollected.

During an explicitly approved owner pilot, only after the command succeeds compare its exact amounts with the fields ANON actually exposes. Use private WETH/WBNB for the ANON fee. A refund must send exactly the saved `net` to its private recipient. A collection must debit exactly the intent's `debit`, including ANON's private fee, and send at least `minimum_native` directly to the authorized gas operator through the pinned ANON gateway. If the visible quote cannot establish those amount and fee terms, stop before sending. The recovery capacity is secured by one note even though the verifier's hard ceiling permits up to two inputs. The measured native fixture currently uses **1 input / 3 outputs / 1 proof**; a larger configuration is not qualified by that run. Do not manually unwrap from the gas operator or authorize an EIP-7702 delegation for that operator: its nonce belongs to the broadcaster journal.

The verifier permits one owned change note. Stock ANON's reviewed confirmation cannot establish the exact hidden shape before sending. The restricted pilot must therefore verify the resulting canonical proof shape, owned input selection, private debit and native receipt afterward; this is a compatibility test with a bounded approved cost, not a preapproval guarantee. Unsupported shapes, unclaimed inputs, costs above the saved cap or insufficient native proceeds retain the hold after a wallet fee may already have been paid. A changed quote is not permission to spend beyond the intent. Broad activation still requires acceptance of the actual owner route; no server-held fee-wallet spending key or undocumented ANON API is a substitute.

## Associate and verify the payment

After successful finality, record the transaction under the same chain configuration:

```sh
node dist/main.mjs record-refund-payout REFUND_KEY FINALIZED_TRANSACTION_HASH
# For native fee collection:
node dist/main.mjs record-owner-payout OWNER_INTENT_KEY FINALIZED_TRANSACTION_HASH
```

These commands associate canonical evidence without unlocking a spending key, sending funds or marking the operation settled. Resume the reviewed service with its normal unlock procedure. Reconciliation verifies the exact owned input nullifiers and their credited positions, values and canonical origin ciphertexts; all owned change; and the actual private debit. Unclaimed incoming notes cannot subsidize a collection or become accounted change.

For refunds, it also verifies the exact outgoing private recipient, net amount and unused canonical commitment. For collection, it verifies the pinned ANON gateway calldata, bounded proof shape, canonical Unshield event and successful native transfer under that same successful trace branch. An outer receipt with status 1 is insufficient. Missing or truncated transaction traces fail closed. The payout must not consume the gas operator's transaction or authorization nonce. Only verified finalized evidence releases the intent and updates earned amounts; partial or duplicate collections cannot debit lifetime earnings again.

## Mistakes, unknown outcomes and recovery

Never send another payment because confirmation is slow. An owner intent has no automatic expiry or cancellation that could make a previously signed payment unsafe.

If the wrong hash was associated, the following narrow recovery is available:

```sh
node dist/main.mjs reject-owner-payout OWNER_INTENT_KEY WRONG_FINALIZED_TRANSACTION_HASH
```

That no-unlock rejection succeeds only when the unchanged finalized receipt has **no RAILGUN Nullified event**, proving it spent no pool inputs. If the mistaken hash is another user's private transaction, synchronize the existing view wallet and use:

```sh
node dist/main.mjs reject-unrelated-owner-payout OWNER_INTENT_KEY WRONG_FINALIZED_TRANSACTION_HASH
```

This second command requires complete fee-wallet history and verifies that none of the transaction's nullifiers belongs to any fee-wallet note, including unclaimed incoming funds. Missing history, any owned input, reorged receipt or stale evidence keeps the candidate held. Both procedures retain the immutable candidate/rejection and active intent; they permit associating the correct existing payment, not paying again. A transaction that spent any fee-wallet input cannot be dismissed by either command.

Unknown outcomes, reorgs, incomplete wallet scans and restored backups keep spending closed. Backups include the owner intent, candidate, both rejection journals, settlement and change journals. There is currently no command that clears a legacy-migration, restore or owner-history-reorg recovery flag: those cases require an independently reviewed canonical history reconciliation before any future recovery tooling is authorized. Likewise, an actual owner payment outside its approved shape or fee cap remains held; this build has no automatic overrun settlement. Live acceptance must confirm the actual ANON route and the configured cost/proof bounds before public release.


## Preparing an explicit prepaid pilot without resetting history

Use plain `sync` first for view-only wallet and balance inspection. It forces submission off, does not subscribe to Waku, and does not create a credit ledger or reconcile payment journals. Inspect existing historical/unclaimed fee notes before depositing new customer credit. Any owner-approved historical fee cleanup or gas-wallet transfer must finish before the new ledger anchors its initial operator nonce; do not infer permission to move funds from a positive balance.

After that inspection and any separately approved owner fund moves, run `sync --initialize-credit` under the existing operator lock and owner unlock procedure. This also forces submission off and creates or reloads the immutable ledger only once. Its `credit-ledger-ready` output contains the public `credit.ledgerId` and scope; verify the chain, operator and fee identity. First creation requires the latest, pending and finalized operator nonces to agree, so an in-flight fund move cannot anchor an obsolete nonce. Repeating this command preserves the ID, initial nonce and historical withdrawal marker. Plain `sync` never performs this initialization implicitly.

A new restricted prepaid pilot requires explicit owner approval of that inspected ledger ID and the existing private wallet's stable public credit-owner address (account zero). Set both `OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID` and `OPHIS_BROADCASTER_PREPAID_PILOT_OWNER`, alongside the separately approved current `OPHIS_BROADCASTER_PILOT_ACCOUNT` and public withdrawal recipient. The ratcheted swap account and stable credit owner can differ; obtain both public addresses from the existing wallet, without creating another wallet or asking for secret material. This opt-in is valid only for Ethereum/BNB pilot admission. It is not an activation or budget approval.

The opt-in permits one prepaid withdrawal attempt in that exact immutable ledger while retaining the historic `withdrawalPilot` marker. The new marker is reserved atomically before signing; a failed attempt, replay, restart, swap-account change or recipient change cannot reopen it. Without the explicit paired opt-in, or after the new marker is consumed, new prepaid execution quotes are closed. Authenticated credit balance, claims, refunds and saved-request recovery remain available. Never clear a marker, rotate the ledger or start an empty journal to bypass this restriction.
