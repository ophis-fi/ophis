# Prepaid native recovery and owner cost bounds

Status: implementation and isolated validation in progress on 9 November. No production fee setting, spending limit, deployment or wallet authority was changed. Collection gas and all collection proof-shape settings default to zero, keeping execution closed until explicitly qualified.

## Repayment path

The owner retains spending control of the ANON fee wallet. The server verifies private receipts using viewing authority. An immutable owner intent is prepared after a canonical backing check and before the owner signs. It halts operator spending until the exact finalized payout is verified.

Supported collection unshields through ANON's pinned gateway directly into native ETH/BNB at the authorized gas operator. It does not require a public unwrap or transfer from that operator, which would consume a nonce outside the broadcaster's journal. The verifier checks the actual successful gateway trace branch, including the exact native value transfer. An outer status 1 does not prove success when the executor catches failures. Missing, truncated, reorged or unsupported trace evidence leaves the hold in place.

Actual fee-wallet debit is the value of exact accounted input notes minus exact owned change, verified against canonical nullifiers, original note ciphertexts and output positions. ANON's private fee is part of that debit. Collection consumes all remaining earned value, including its private fee; it cannot collect lifetime earnings again. No aggregate balance difference or owner-asserted receipt amount is accepted as proof. The initial shape permits one owned change note so a payout cannot unexpectedly fragment previously recoverable funds.

## Accounting and bounded recovery

Let:

- `L`: outstanding customer liabilities, including the full gross of pending refunds.
- `E`: settled execution charges plus completed refund retained fees, minus verified private owner costs and collected gross value.
- `A`: maximum charges of unsettled operator attempts.
- `R`: gross amounts of pending customer credit refunds.
- `B`: canonical unspent value of accounted fee notes.
- `S_1`: the largest single accounted note, independent of its Merkle tree.
- `H`: one current quoted maximum execution charge when another owner has at least that much available credit; otherwise zero.

Accounted notes are exact `(tree, position, commitment, amount, canonical origin)` records from credited deposits or verified owner change. An unclaimed incoming note is excluded even if it repeats an accounted commitment hash. Owner change cannot subsequently be claimed as another deposit.

Before operator spending, require:

```
B >= L + E
S_1 >= E + A + R + candidateMaximumCharge
```

A new refund requires `S_1 >= E + A + R + proposedGross + H` before reservation. The authenticated refund quote reports `maximumRefundGross = min(ownerAvailable, max(0, S_1 - E - A - R - H))`, or zero if that owner already has a pending refund; reservation rechecks the proof, one-pending-refund rule and current ledger atomically. One-wei deposits from another owner do not by themselves reserve execution headroom and block full exit. Large requests can be made as smaller partial refunds. Multiple ordinary deposits do not by themselves halt service: all customer liabilities remain backed, but only earned and reserved recovery must fit one accounted note. This keeps the bound valid when a payout creates its change in a new Merkle tree; summing old-tree notes would not. The verifier hard ceiling permits up to two inputs; the measured native fixture qualifies only its 1-input/3-output/1-proof shape.

Owner preparation requires no unsettled operator attempt. Its canonical preflight preserves `B >= L + E` and `S_1 >= E + R`. A refund with actual debit `D` changes recovery capacity from `E + R` to `E + R - D`: the completed refund gross leaves `R`, while its retained fee less actual private expense enters `E`. A collection debits exactly `E` and must leave every customer liability and queued refund covered. Verified one-note change preserves the bound; post-payout backing is checked as additional defense.

Unknown owner payments hold admission. A wrong candidate can be rejected with a canonical no-pool-spend receipt or a complete view-wallet proof that it spent no owned nullifier; the intent stays held. An actual owned spend outside the approved bounds cannot be dismissed. A nonempty ledger predating the owner-accounting version requires explicit historical reconciliation instead of assuming earned fees remain uncollected. Finalized owner history is rechecked before new spending, and backup restoration retains its recovery hold. No command in this build clears migration, restore or owner-history-reorg flags; that requires separately reviewed history-reconciliation tooling.

## Cost qualification

Every owner intent caps the complete private fee and minimum native proceeds. Collection's minimum is `G + ceil((G + P + F) * marginBps / 10000)`, where `G` is unrecovered operator gas, `P` is prior private fee expense and `F` is the approved maximum collection private fee. Private fees have already left earned value; the formula repays native gas and the required profit without charging those private fees twice. Actual private costs and native recovery are recorded after verification. A price or shape that exceeds its intent does not release the hold.

The actual ANON route deducts 13 bps from the amount left after the RAILGUN unshield fee. Prepaid pricing conservatively compounds both deductions: `rate = ceil(10^18 * (10000 + marginBps) * 10000 / ((10000 - poolFeeBps) * (10000 - 13)))`. Quote creation and acceptance verify the current pinned gateway runtime and fee. A changed fee or unsupported runtime closes pricing; canonical collection verification independently checks the historical and current gateway fee and exact delivered value.

The advisory `owner-cost-preflight` reads an exact saved refund and checks owner-reviewed payout and direct native-collection quotes, both compounded collection fees, configured margin, chain identity, expiry and transaction cost limits. It neither authorizes spending nor substitutes its sampled balance for canonical backing. The complete procedure is in [PREPAID-REFUNDS.md](../../../apps/broadcaster/PREPAID-REFUNDS.md).

Refund-only economics must be tested separately. A payout maximum of 1,030,000 gas plus a collection maximum of 1,110,000 gas already exceeds a 2,000,000-gas allowance at the same price, before preserving margin. The corresponding negative test has no execution fees to hide the shortfall. A 3,000,000-gas allowance fits that particular arithmetic example; it is not a production recommendation or a universal upper bound.

The earlier BNB wrapped-collection benchmark is historical. Direct native ANON gateway runs now passed on BNB snapshot **v3** and Ethereum snapshot **v4**, with six real SDK proofs each. They cover prepaid claim, successful swap and withdrawal, included revert and out-of-gas charging, memo-less owner refund, and a 1-input/3-output/1-proof native collection with a real private fee output. Canonical native trace verification, owner-journal settlement, remaining customer backing and the configured cumulative operating margin passed. The fixtures use synthetic wallets on isolated forks; they did not exercise stock ANON approval, a live builder, PPOI service or production RPC reliability. Evidence is recorded under `prepaid-release-20261109/real-proof-fork/bnb-native-v3` and `ethereum-native-v4`, with their respective source manifests.

The final **v5** source includes later recovery and availability corrections and requires its own Ethereum/BNB run results; those results were pending when this documentation was updated. Earlier v3/v4 success must not be reported as exact-version v5 coverage. Owner live acceptance remains pending regardless of isolated fork results.

Static inspection of the signed ANON 0.12.4 unshield UI found no exposed exact note/proof/change review or unsigned private-proof export in that path. The current runbook therefore requires a specifically approved owner compatibility pilot and post-receipt verification, and states the possibility of an unsupported operation remaining held after its private fee is paid. Internal SDK methods are not a documented wallet API. The public release cannot infer actual owner-wallet compatibility from a synthetic gateway transaction.

## Remaining release evidence

Before public activation: complete exact-version Ethereum/BNB native-route proofs, confirm refund-only quotes for the qualified proof shape, finish independent review/static checks, approve concrete per-chain pricing and complete owner live acceptance. Inputs, outputs and proof-count settings are explicit and default closed; setting a nonzero gas allowance alone cannot enable spending.

Local regression suites cover canonical owned-debit evidence, duplicate/unclaimed positions, claim races, three ordinary deposits, fragmented notes, queued refund capacity, partial/repeated collections, private-cost overruns, stale scans, wrong owner associations and persistent migration/recovery holds. Run results are recorded separately; these tests do not claim that unmeasured proof shapes are economical.
