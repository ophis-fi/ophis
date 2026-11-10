# ANON failure handling and the Ophis payment decision

Date: 2026-11-08. Status: reverse engineering and isolated execution checks complete; payment-flow change not approved or implemented.

## Result

ANON's shipped wallet and Ethereum executor do not establish a guarantee that every submitted attempt pays the operator. A fee already collected by a successful pool call can survive a later caught action failure. An outer revert rolls that fee back. A failed inner call containing the payment can also be caught, leaving a successful outer receipt without payment.

This is a contract-boundary finding, **not evidence that ANON's production server accepts an exploitable request**. Its server admission, simulation, submission policy and any external guarantees remain unverified. Copying its client or executor alone would not satisfy Ophis's requirement to secure payment before spending operator funds.

## Artifact identity and method

The official ANON download page links Chrome extension `gnkbgepgknkbhnnbaihklcfkjhbclajk`. Version 0.12.4 was downloaded from Google's public extension update service into a fresh analysis directory. No installed wallet profile was opened and no extension code was executed.

- CRX SHA-256: `d03d9bee1b0f8333bdd8e7463e1dc1060e78609f4b03da2207761824d6ed1154`.
- All three CRX3 signatures verified, including the developer-ID binding and Chromium's production publisher key pin. A one-bit alteration of the signed context was rejected for each proof.
- Webpack factory ranges were extracted with Acorn as inert syntax. `webpack-extraction.json` records original byte ranges and hashes. No downloaded JavaScript was evaluated.
- REA original service-manager analysis: parent evidence `ev_26160bce1170812a0e8bb2a9b5193888138a31e4ac71b7cdc3b4d9acaab5f9bf`; this broad graph hit explicit semantic limits.
- REA selected executor, withdrawal, swap and polling excerpts: parent evidence `ev_e7a6c8593459e8aff0d8c897d0d0eb04cc4d2ffc976c4ae1260b7f30df23bf4e`; six parsed files, no parse failures. Unselected dependencies and dynamic relationships remain unknown.
- Complete retained REA evidence was exported. Static graphs establish syntax and candidate relationships, not runtime execution.

Evidence root on the analysis Mac: `/Users/scep/ophis-railgun-evidence/anon-failure-20261108/`.

## Observed fee and failure paths

| Path | Shipped-code observation | Consequence |
| --- | --- | --- |
| Private-fee `PublicCalls` | Modules 1176 and 3805 build a fee-only pool transaction followed by requested actions; `requireSuccess` defaults to false. | A caught later action failure can retain the already-collected fee. |
| Private swap / gateway withdrawal | Modules 30455, 3943 and 21211 include the broadcaster fee in the proof collection passed to `gateway.unshield`; the outer multicall normally uses `requireSuccess=false`. | If the gateway call fails, its payment rolls back too. Catching that failure outside does not recreate the fee. |
| Strict operation | `requireSuccess=true` propagates an action failure out of the executor. | Payment in that same outer transaction rolls back. |
| Failure before payment / outer out-of-gas | Signature, nonce, proof/pool rejection and whole-frame failure can occur before durable payment. | Operator gas may be consumed without fee settlement if such a transaction is included. |
| Lost submission response | Module 14378 classifies an unknown dispatch as resumable and warns against submitting again. | Recover the original job; do not assume a timeout means rejection. |
| Polling failure | Modules 65409 and 14378 retain job identity, handle held status and transient errors, and resume an accepted job after an inconclusive poll. | Avoid duplicate operations; polling itself does not guarantee fee settlement. |
| Stale private fee quote | Module 51302 raises a stale-proof error instead of silently changing the committed private fee. | Rebuild and review the affected proof; do not mutate an existing authorization. |
| Receipt interpretation | Module 85858 checks expected nullifiers and shield notes, as well as `CallError` events. | Receipt status 1 alone is not proof that the requested private operation executed. |

The Ethereum quote names operator `0xC1d0dD9315D0f877cbCa9Ffa2f95e2b66f798fDa` and executor `0x05ae73c5925d843864ae6f261f3175de2ebcd963`. Readback showed the operator's EIP-7702 delegation to that executor. Verified executor source was matched to its deployed runtime. Its `execute` function calls `railgun.transact` before `_multicall`; there is no separate ERC-4337 `postOp` fee guarantee in that function. A historical public type-4 transaction corroborates the fee-first execute path.

The shipped gateway address is `0xB25058Ccb45E0CD7d588e18e23A1E02B85F59f54`. The gateway was tested using its actual deployed runtime. Verified gateway source was not found in the bounded Etherscan/Sourcify lookup; its complete implementation was not audited.

BNB quote and code readback were read-only. They identify the advertised BNB executor, but the quoted BNB gas operator has no delegation code. Do not generalize the Ethereum operator's account state to BNB. The execution tests below are Ethereum tests.

## Isolated execution evidence

All tests used a loopback Anvil fork and fresh synthetic accounts. No mainnet transaction, owner key, owner unlock or real funds were used.

| Test | Outer status | Fee result | Local gas used |
| --- | --- | --- | --- |
| Fee leg succeeds, subsequent action reverts, catch enabled | 1 | Mock fee retained | 92,049 |
| Same action failure, strict success required | 0 | Mock fee rolled back | 73,162 |
| Fee leg rejects | 0 | No mock fee | 63,025 |
| Outer out-of-gas | 0 | Mock fee rolled back | 70,000 |
| Actual gateway rejects a tampered proof inside `multicall(false)` | 1 | No canonical pool settlement logs; `CallError` emitted | 126,840 |

The first four tests execute the exact deployed executor with a deliberately mocked pool fee counter. They prove ordering and rollback, not real SNARK acceptance or private-token payment. The fifth restores actual gateway and pool code, but intentionally uses an invalid proof. It proves the caught-failure boundary, not backend acceptance of that proof. Receipt and call-trace files preserve both distinctions.

Ophis separately has an earlier actual-protocol fork test showing that a stale fee proof can revert before collection: `ophis-railgun-evidence/arbitrum-verification-20261105/verification-results.md`. That test is not ANON backend evidence.

## Consequence for Ophis

Ophis already has protected submission, simulation, budget limits, durable pending recovery and fee assurance. These reduce or detect exposure; they do not turn an unconfirmed fee proof into confirmed payment. Keeping a fee on selected caught failures is useful, but insufficient for a blanket no-unpaid-attempt claim.

The strict alternative is to reserve previously confirmed payment or collateral before signing. The existing owner-selected fee wallet can remain view-only on Baal. No new Solidity guard is inherently necessary for a confirmed-payment design.

The smallest private-payment sequence is:

1. Bind an authenticated payment intent and show the exact fee/caps.
2. Generate, save and submit a separate private transfer to the existing Ophis fee identity; its submission gas must come from the user or an independent payer.
3. Verify finality, canonical receipt, exact received note and encrypted ownership/intent binding.
4. Refresh balances, then construct the fee-free operation using confirmed change if necessary.
5. Atomically reserve the payment before any operator signature. Preserve reservation through uncertain submission, restart, replacement and cancellation.

An already-confirmed fee credit can cover later operations without a new payment-finality wait. This requires durable credit ownership, single-use reservations, an unused-credit/refund policy and explicit fee consent. It is not currently implemented. The view-only service cannot promise automatic private refunds.

## Timing and decision

The user asked whether this would reintroduce the earlier one-hour wait. It would not re-enable PPOI: Ophis's current policy disables those requests. However, strict payment finality adds its own delay. Ethereum finality is roughly 15 minutes under normal conditions; BNB fast finality is much shorter. Proof generation, wallet scanning, inclusion and RPC availability add separate delays.

Requiring a new finalized payment for every Ethereum operation would be poor UX. A reusable fee balance would move the wait to initial funding/top-ups, with future operations drawing from already-confirmed credit. The user has asked about this tradeoff but has **not approved** the changed flow. No payment architecture was silently changed, and no merge, deployment or service activation occurred during this investigation.

Before launch: resolve that payment/UX choice, implement and test its complete client/server/recovery path, obtain the required independent reviews and CI results, and perform the outstanding owner-paid BNB swap and withdrawal acceptance. ANON reverse engineering does not replace those checks.

## Primary sources and evidence

- [ANON paymaster documentation](https://docs.anon.inc/advanced/paymaster)
- [ANON integration guide](https://docs.anon.inc/developer/dapp-integration)
- [Official extension listing](https://chromewebstore.google.com/detail/anon-wallet-private-evm-w/gnkbgepgknkbhnnbaihklcfkjhbclajk)
- [Executor verified source](https://etherscan.io/address/0x05ae73c5925d843864ae6f261f3175de2ebcd963#code)
- [Ethereum finality](https://ethereum.org/roadmap/single-slot-finality/)
- [BNB consensus/finality](https://docs.bnbchain.org/bnb-smart-chain/introduction/)
- Local `crx3-signature-verification.json`, `webpack-extraction.json`, `rea-evidence-bundle.json`, `executor-runtime-match.json`, `executor-local/results.json`, `executor-local/real-gateway-results.json`.
