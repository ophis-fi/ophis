# Confirmed user payment before broadcaster execution

Status: historical one-attempt proposal. The owner approved reusable confirmed fee credit on 8 November; the implementation and outstanding release gates are recorded in [the current prepaid-credit plan](2026-11-08-prepaid-credit-implementation.md). No live configuration, custody, funds or transaction changes were made. Existing release gates remain closed.

## Required property

Before the broadcaster signs an executable outer transaction, an independently confirmed user payment must cover the maximum liability authorized for that attempt, including bounded cancellation/recovery and the agreed margin. A later operation revert cannot reverse that earlier payment. A successful simulation, a valid but unmined payment proof, a pending payment or placing payment first inside the same outer transaction is insufficient.

The earlier Arbitrum fee-first prototype retains a fee through caught inner failures, but its spent-input, invalid-root and insufficient-gas counterexamples fail before payment. The actual-protocol fork evidence includes an unpaid stale-fee-proof failure. That prototype does not satisfy this stricter requirement. Evidence: `ophis-railgun-evidence/arbitrum-verification-20261105/verification-results.md` and `fee-first-prototype/test/FeeFirstPrototype.t.sol`.

## Smallest proposed flow

1. Validate and quote the requested operation before taking payment. Bind chain, operator, recipient, principal, operation authorization, expiry, exact fee and all spending caps. Obtain the user's explicit consent to the network/attempt fee even if the operation fails.
2. Prepare a separate private fee transfer to the existing owner-selected ANON fee wallet. The user funds this first transaction's native gas through their own public wallet. Ophis does not broadcast that payment at its own expense. Prepare/save payment and operation recovery records before disclosure; fee and principal proofs must not spend the same private notes. Current SDK note selection/shared proof caching need explicit validation.
3. Verify canonical finalized inclusion and receipt of the exact private payment using the existing view-only wallet. Cryptographically bind the payment commitment to the accepted quote and authenticated request owner. A public transaction hash alone cannot claim somebody else's payment. Persist a unique chain/payment identity before authorizing any spend.
4. Atomically reserve that payment for one operation attempt in the durable journal before signing. Recheck fee value, freshness, gas caps and available native liquidity. No payment may fund two requests, two chains, concurrent workers or a retry with a new nonce. If the covered budget cannot buy execution at current prices, stop without signing.
5. Submit through the existing protected route and guarded execution. The operation must not charge the old in-transaction fee again. Since the payment is in a previous transaction, the existing execution guard may still revert safely with respect to that already-confirmed payment; a new fee-first Solidity wrapper is not inherently required for this design.
6. Reconcile operation and payment separately. Success, included failure, private rejection, unknown outcome and cancellation have different states. Keep credit/reserves held while any signed transaction remains executable. Identical-byte retries are not new paid attempts. New attempts need an explicit covered reservation and user consent. Never automatically bump gas beyond secured funds.

The initial version should secure one quoted attempt rather than introduce a general-purpose custodial credit product. A prepaid balance funded during Add funds could reduce repeated setup later, but needs its own privacy, authorization and refund design; it is not assumed to exist now.

## Payment economics and custody

Prefer wrapped-native payment for the first version (WETH on Ethereum, WBNB on BNB) to avoid relying on arbitrary-token or stablecoin valuation for gas coverage. Quote collection/unshield/unwrap costs as well as execution/recovery and margin; private wrapped tokens are not immediately usable native gas. Preserve the operator's native reserve checks and owner-controlled fee collection/refill.

Reserve the maximum liability over valid nonce/replacement paths. Original and cancellation transactions competing for one nonce cannot both be canonical, but additional distinct-nonce recovery transactions create additional liability. Prove that accounting in tests; do not simply assume every recovery costs 21,000 gas. Failed top-ups are the submitting user's gas expense. Ophis never funds the bootstrap payment or an unbacked refund.

Do not add the ANON fee-wallet spending key to Baal. Unused payments, an operation that becomes unavailable before submission, and refunds require a published policy and authenticated recovery. The current view-only service cannot automatically refund private funds; owner-controlled refunds/credits must be designed without promising an automatic refund capability. Keep private principal under the user's control throughout.

## User experience and privacy boundary

This strongest form of prepayment changes the current gasless-first-use experience: the first payment needs user-funded native gas, or an already funded gas balance/independent payer. Moving the payment gas to Ophis recreates the original risk. A frontend can guide the steps in one flow, but cannot remove the extra on-chain payment and confirmation.

Self-broadcasting a private fee transaction exposes its public gas-paying address and timing. Do not publish an identifier that lets observers link that payment to the later private operation, and do not claim the resulting flow has the same metadata privacy as fully relayed first use. Integrating setup into funding needs explicit privacy review, especially for existing private funds.

RAILGUN's existing gasless mechanism permits fees in an accepted token through a broadcaster; it does not establish this independent prepayment guarantee: [account-abstraction overview](https://docs.railgun.org/developer-guide/engine-1/account-abstraction-overview), [gasless interactions](https://docs.railgun.org/wiki/learn/using-private-tokens/gasless-interactions).

## Implementation reach and acceptance

- Backend: `fees.ts`, `sdk.ts`, `transaction.ts`, `broadcaster.ts`, `storage.ts`, cancellation/recovery, reporting and backup/restore. Use a distinct authenticated request version; never accept a missing in-transaction fee without a confirmed payment reservation.
- Client: fee-only proof construction/self-submission, note reservation, quote review, `private-swap.ts`, `bound-unshield.ts`, ordinary withdrawal flow, broadcaster messaging and both recovery journals. Preserve old saved proofs; do not silently rebuild or double-charge them.
- Tests: payment failure/spent note, fake or stolen receipt, cross-chain replay, duplicate/concurrent reservation, restart at each payment/signing boundary, reorg/finality, expired quote, gas-price spike, paid operation revert, malicious-token failure, cancellation/replacement and delayed original inclusion. Verify exact user principal/fee/operator expenditure with real RAILGUN proofs on isolated Ethereum and BNB forks, then independently audit and perform bounded owner-approved live acceptance.

This is a design to prevent the identified unpaid execution and cancellation paths within authorized budgets. It is not a zero-loss guarantee against chain finality failure, host/key compromise or implementation defects. It does not itself qualify another chain's MEV delivery route. No merge, deployment, additional spend or user top-up is requested by this document.
