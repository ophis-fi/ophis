# Public native prepayment — implementation and release review

The owner selected public ETH/BNB prepayment on 9 November 2026. This replaces the new-release private fee-collection dependency; historical private credit and its recovery records remain separate. The new mode is explicit (`public-native`), uses a distinct signature domain and browser journal, and refuses to reinterpret an existing private ledger.

## Implemented behavior

- The public payer sends native currency with an opaque, one-time commitment bound to chain, operator, ledger and claimant. The payment is saved before the wallet prompt. The initial wallet transaction pays its own gas; ordinary undelegated accounts are qualified by the frontend before payment.
- A successful canonical finalized transaction is credited once. Exact retry is idempotent. A distinct transaction reusing the payment identifier is quarantined as a liability and produces an error, rather than being credited again or counted as revenue.
- Every signature requires current canonical native backing for all known customer liabilities plus the configured operator reserve. Deposit and settlement origins are retained and rechecked. Reservations, request identity and operator nonce are atomic and durable.
- Execution, revert and cancellation gas is charged from the customer's reserved maximum at the accepted margin. No included failure relies on retaining a fee from a reverted private transfer. Signing and cancellation limits, protected delivery, guards and daily budgets remain enforced.
- Native refunds use the same journal, nonce and protected transport. Success charges net payout plus actual gas and margin; revert/cancellation charges gas and margin only. The remainder of the hold becomes available credit. The client checks finalized receipt outcome, pinned nonce and actual gas pricing before clearing its saved operation.
- Startup/quote qualification samples historical operator code availability. Exact claims still require their own canonical historical state. Failure closes new admission and preserves existing records for recovery; an archive-capable trusted RPC remains an operational requirement.

## Validation completed locally

- Full backend suites: Ethereum **1,074 passed / 32 skipped**, BNB **1,105 passed / 5 skipped**, no failures. Ethereum-only historical fixtures explicitly pin their fixture chain; chain-aware BNB tests run on chain 56. Backend TypeScript check passes.
- Private client/operator suite: **625 passed / 12 skipped**, no failures. Frontend and server TypeScript checks pass. Independent changed-client regression: **102 passed**. Mobile layout checks at 390px and 320px pass without horizontal overflow.
- Independent native security checks: **79 passed per chain**, including actual transactions on fresh owned Ethereum and BNB mainnet forks. These exercise encrypted native deposit claims, pre-finality rejection, idempotence, native refunds, a real post-simulation revert and a higher-cost cancellation. Actual operator balances equal initial reserve plus deposits minus verified payouts and receipt gas. Customer liabilities decrease by the payout and gas-plus-margin charge. No owner keys or mainnet funds were used.
- Protected submission tests: **83 passed**. Domain/opaque-reference tests: **5 passed**. Native ledger tests include restart, duplicate-payment quarantine, cross-mode refusal, receipt cost bounds and reorgs during backing reads.
- Semgrep: 155 applicable rules, 32 snapshot files scanned; six reviewed false positives, one inherited external-rule parse error and two test-only partial parses. No production parser failure or timeout. This is not a zero-alert claim.
- Claude Fable 5.2 was actually used for design and source review. Its first source review identified missing refund payload metadata and recovery gaps; these were fixed and regression-tested. A final exact-source review is pending at this checkpoint. Jev was actually used for source-claim checks; probabilities are supporting signals, not security approval.
- ETHSkills financial validation and Trail of Bits differential-review methods were applied. No Solidity changed in this delta, so previous Pashov/Slither evidence remains scoped to unchanged contracts; no fresh contract audit is claimed. Fresh hosted CodeQL and the remaining exact-commit CI checks are pending.

Evidence is retained in the owner's local `ophis-railgun-evidence/native-prepayment-20261109/` directory, including source manifests, test JSON, independent reviews, Semgrep output and Claude/Jev responses. Historical private-credit fork results are not substituted for native-payment acceptance.

## Release gates and practical limits

1. Keep public frontend approvals expired and services disabled until final review, exact-commit CI and stopped-service configuration checks pass. This report does not enable production or attest hosted Codex approval.
2. Before initializing a native ledger on the existing operator, reconcile all old signed requests/cancellations and preserve both journals. A fresh ledger or current nonce alone does not exclude retained competing signatures. Stop the previous signer before preparing replacement state.
3. Complete restricted real user-funded credit, private swap, withdrawal and native refund acceptance on each chain using the reviewed artifact/configuration. Local forks do not prove mainnet protected delivery or owner wallet compatibility. Any required local unlock remains an owner action.
4. One unresolved operator attempt is allowed globally until final settlement. Ethereum finality therefore limits throughput and can delay the next user's operation. This candidate is not qualified as a high-throughput public service.
5. The initial native refund conservatively reserves the full configured maximum transaction gas cost. It can leave residual credit; balances below that allowance cannot currently be refunded and remain usable for later fees. Quarantined duplicate payments have no automated release path in this version; preserve their records and hold rather than making an unjournaled payout.
6. Public fee payments reveal sender, operator and amount; Ophis can link the credit account's requests. The online operator holds customer fee credit. Reserve checks do not eliminate key/admin compromise, incorrect trusted RPC evidence, finality failure or indefinite historical-state availability risk.

Arbitrum, Polygon and Base are outside this change. No production node, validator, owner wallet, funding or deployment action is part of the local validation above.
