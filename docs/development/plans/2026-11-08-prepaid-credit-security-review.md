# Prepaid credit differential security review

Scope: this report records the 8 November snapshots and their follow-up checks. The 9 November owner-payment journal, native ANON collection verifier and refund-capacity changes require their own exact-version validation; the earlier passing scans are not approval of those changes. See [the current recovery work](2026-11-09-prepaid-native-recovery-pricing.md).

## Executive summary

**Recommendation: REJECT production activation at this checkpoint.** The changes enforce confirmed reservation before signing. Both chains' six-proof forks, included-revert/out-of-gas settlement, owner refund association, complete-journal recovery drills and final CodeQL triage passed. Production collection bounds, exact-version release review and bounded live acceptance remain before customer deposits. No production changes or live-chain transactions were performed for this work.

Claude's initial source-only review reported the following distribution; these counts describe its reviewed snapshot, not independent certification of the final working tree:

| Initial review category | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 3 |
| Additional low-severity release gates | 2 |

One conditional medium finding was disproved against the actual protected transport. Stale-only restoration remains blocked behind mandatory restore holds. The remaining release risks are operational availability, live refund usability, collection bounds beyond the measured fork shapes and actual owner-wallet interoperability. No claim of a zero-loss system or completed firm audit is made.

## What changed and historical context

Baseline: `b85807fdc6227ec16cce61a058c6218e4adf07d6`; working branch: `feat/railgun-prepaid-credit`; no new commits or remote repository writes. GitHub main was verified as `248e6b2c1342732aa5aa6584b866c5b972e5ed2f`, already in the branch ancestry. PR #1632 remains open and blocked.

Earlier changes expanded assets (`4132ba54`), added BNB withdrawals/WBNB fees (`cbca7f61`) and bounded BNB private bundles (`01d1adfe`). Those protections are retained. The new payment model changes who has already paid before the outer operator transaction executes; it does not replace the guard or delivery route.

| Area | Changed behavior | Risk / callers |
| --- | --- | --- |
| Shared protocol and encrypted Waku | EIP-712 owner/payload/chain/ledger authorization; stable retries | High: frontend, service, recovery |
| `credit.ts`, `credit-payment.ts`, `credit-service.ts` | Finalized private deposits, atomic holds, capped actual charges/refund liabilities | High: every new operator signature |
| SDK | View-only received/sent evidence and backing checks; prepaid proof validation | High: admission and reconciliation |
| Broadcaster/transaction/recovery | Reject unpaid mainnet path; exact fee-free proof path; bounded cancellations | High: swap and withdrawal |
| Storage/backup/accounting | Retain uncertain liabilities, restore holds and separate customer credit from revenue | High: restart, restore, owner collections |
| Client and journals | User-paid top-up, pinned credit identity, maximum-charge consent, exact saved recovery | High: wallet interaction and private notes |
| UI | Compact fee-credit/recovery/refund controls | Medium: disclosure and user error |

The evidence directory contains source hashes and diff statistics, including untracked new protocol files. Existing unrelated historical plan files were preserved. No Solidity contracts, package versions or lockfiles changed in this payment diff.

## Method and scope

Used Ponytail's smallest-complete-change discipline, ETHSkills security guidance and Trail of Bits' differential-review method. Reviewed changed entry points, their callers and persisted data; checked financial invariants and old-proof compatibility. Separate agents reviewed custody, client transport and actual protected-provider behavior. Claude received source-only files with tools/MCP disabled; it did not inspect wallets, secrets, browser profiles or deployment state.

This is an engineering review using those methods, not an audit commissioned from Trail of Bits, Pashov or another firm. Final CodeQL covered 189/189 source files with local/remote threat models and custom decrypted-request/SQLite models; all 52 baseline and 46 modeled alerts were triaged with no production blocker found. Exact reports and source hashes are in `prepaid-20261108/codeql/final/`. Prior CI approvals do not cover this payment redesign. Slither/Verity do not establish correctness of these new TypeScript/SQLite paths; no Solidity changes were made here.

## Findings and dispositions

### M1 — stale restore can omit later refunds and signatures: release gate

A stale journal can restore credit already refunded or reserved after its snapshot. Operator nonce comparison does not detect every owner refund or unmined signature. Critical snapshots now mark their copied DB for review; full archives include a restore-hold marker. Signing/cancellation/refund reservation fail closed while either is present. The original live installation is not silently marked by a successful critical backup, and full backup cleanup preserves pre-existing holds.

There is no approved automatic clearing path. Reconstruct and verify the complete later journals, including pending refunds and private owner payouts, before clearing any hold. The stale-snapshot drill now proves that a later refund changes credit without changing the operator nonce and that the restored snapshot refuses spending. Complete-journal multi-nonce recovery is implemented and tested on both chains. Neither capability makes a stale-only snapshot sufficient. Do not treat manual SQL or a nonce-only check as recovery.

### M2 — staging an original during unsigned-reservation cancellation might publish it: not reproduced

The conditional concern was checked against `ProtectedEthereumProvider`, not assumed away. `stageSigned` only validates and journals; only `sendProtected` invokes submission. Recovery persists a cancellation before staging the original, then sends the cancellation. No startup path automatically publishes the staged original. An explicit original retry still enforces its expiry. The existing actual-provider regression passed with network denied. Evidence: `independent-recovery-review.md` and `m2-stage-signed-test.log`.

A crash may still leave a signed original and a retained credit hold; it must be reconciled explicitly. This is not permission to disclose that transaction outside the reviewed transport.

### L1 — anonymous messages shared the paid admission counter: corrected

Discovery, authenticated queries and execution now use separate bounded counters. A test fills anonymous discovery and verifies that a funded execution remains admissible. This reduces the identified cheap admission lockout; it is not Sybil-resistant availability protection against flooding the shared Waku/read service.

### L2 — commitment hash alone was not a unique deposited leaf: corrected

Deposits are keyed by verified `(tree, position)` and retain commitment/receipt/owner/amount evidence. Tests cover distinct leaves with the same note hash, exact replay across restart and changed evidence. Duplicate credit and silent merging of legitimate separate leaves are rejected/prevented respectively.

### L3 — refund reservation has no expiry/cancel: intentionally retained, operational gate

Releasing a hold because the UI timed out could allow both an owner payout and reused credit. The current hold therefore survives until a verified payout; it is not an automatic refund service. A safe cancellation/owner-claim protocol is not included. Production needs an operable owner payout procedure and a clearly disclosed processing policy.

### L4 — claims accepted while pricing unavailable: recovery intentionally permitted

The client now requires `executionEnabled` plus valid reviewed policy and a usable quote before new funding/execution. Backend pricing fails with zero collection gas. A previously sent top-up may still be claimed while execution is paused, so disabling admission does not erase an already paid customer's claim. Rejecting that recovery would not return funds. The readiness gate does not prevent a person from independently sending an unsolicited on-chain transfer.

### L5 — restore hold clearing unspecified: remains blocked

No clearing tool or bypass is authorized. See M1 and `BACKUP-FORMAT.md`. The hold is deliberate protection, not completed operational recovery.

### Additional issues found and corrected during cross-review

- Backing validation now requires the wallet to remain ready after `refreshBalances`; the SDK can report an incomplete scan without throwing. The regression fails closed on that path.
- `settlementHash` identifies the actual finalized winner when an earlier cancellation beats a later replacement. The client verifies that exact finalized receipt.
- The service reconciles pending refunds in fair bounded batches without requiring the customer to poll. Owner payouts otherwise reduced the private balance while leaving global liabilities unchanged indefinitely.
- New execution may be disabled while pinned-ledger balance/claim/refund/status recovery remains available. The client supports expired-policy refund exits without reopening funding or execution admission.
- Top-up recovery retains the exact proof and public nonce. A third party paying gas to submit the exact proof cannot strand the owner's finalized credit merely by changing the outer sender.
- Accounting does not report prepaid deposits as earned fees, and prefinality inclusion does not hide maximum gas exposure. Unknown outcomes keep both credit and native exposure held.

## Checks and practical limits

| Check | Result |
| --- | --- |
| Full backend suite | 668 passed, 30 skipped on the final withdrawal-compatible backend |
| BNB-focused backend | 145 passed, 2 skipped in the final subset, including the SDK withdrawal regressions |
| Broadcaster TypeScript/build | Passed |
| Synthetic encrypted RAILGUN note/scan evidence | Passed on ETH and BNB configurations |
| Client transport | 15 focused tests passed; both TypeScript configurations passed |
| Client integration/layout/build | 535 passed, 12 skipped; both typechecks, mainnet build and 320/390/470-width layout passed |
| Additional restore-marker regressions | 60 passed across the two affected backend files |
| Semgrep | 0 findings across 107 files; no production parse errors, 25 test files partially parsed. Both subsequent withdrawal source deltas scanned separately with 0 findings |
| Protected-provider staging regression | Passed; network denied |
| CodeQL on this diff | Complete: 189/189 source files; official security/quality and community queries, then security-extended with custom decrypted-request/SQLite models. 52 baseline and 46 modeled alerts triaged; no production blocker found |
| Real prepaid proof roundtrips / live transactions | Both chains passed six real proofs, including top-up, swap, withdrawal, included revert/out-of-gas settlement, memo-less owner refund and collection. No live-chain transactions |

Final backend test logs are preserved under `/home/clement/ophis-prepaid-proof-20261108/evidence/*final*.log`. Final local results are `prepaid-20261108/real-proof-fork/ethereum-included-failures/result.json` and `bnb-included-failures/result.json`; both include the final nullifier string-type guard and record synthetic wallets, no live PPOI and no live private relay.

Tests validate specific invariants and fixtures; their counts are not proof of production correctness. Synthetic encrypted-note tests are stronger than mocked balances but do not execute complete private transfers against real chain state. Private backing currently depends on a completed trusted SDK scan plus finalized creation height; it does not independently attest every existing/change note against its canonical receipt.

ANON 0.12.4's public extension source supports private memos internally, but its actual popup Send paths force `memo: null`. Evidence is preserved separately in `anon-failure-20261108/refund-memo-compatibility.md`. A subsequent local-only owner association path addresses this UI incompatibility: `record-refund-payout` records a finalized hash/block tuple under the exclusive operator lock, without signing or keys. Waku cannot assign payouts. The view-only verifier still requires the exact sent note, recipient, token, net amount, canonical ciphertext and global commitment uniqueness. Every refund now requires that explicit association, including exact-memo notes.

Independent follow-up validation of the association delta and its scope/hashes is preserved in `prepaid-20261108/codeql/refund-review-manifest.json`; the later frozen-source counts are listed below. The Ethereum real-proof fork subsequently verified a memo-less refund after explicit local owner association. BNB integration and live owner-payout acceptance remain outstanding.

### Subsequent refund authenticity and candidate review

A synthetic cryptographic probe reconstructed a sender-view Transfer note with a new commitment and memo by reusing annotation/shared-key material available to a recipient of an earlier genuine transfer. It did not use the fee wallet's spending key. This proves that the SDK's SENT classification alone is insufficient evidence of spending authority; it is not an executed on-chain exploit. Evidence: `prepaid-20261108/codeql/sender-origin-probe.mjs`. The automatic exact-memo path was removed. An explicit local owner association with the actual finalized payout is mandatory, and all private-note checks still apply. Operator association is a trust boundary; operators must select their actual payout, not a transaction hash supplied by a customer.

Claude's follow-up identified candidate masking and cross-refund memo confusion. The verifier now skips commitments already used by another refund before choosing a candidate, rejects an assigned note tagged with another refund's memo, and checks credit-deposit outputs independently so one invalid sibling cannot mask a valid one. Atomic ledger uniqueness remains enforced at settlement. Focused tests before the mandatory-association tightening passed 96 with 9 chain-gated skips; final combined results are recorded separately.

After mandatory owner association, independent frozen-source review found no blocker in that refund path. Ethereum credit/note/payment/broadcaster tests passed 98 with 9 existing chain skips; BNB passed 110 with 1 skip; the actual CLI passed 11 using disposable loopback RPC. Root credit/note/backing tests passed 30 and broadcaster typecheck passed. These approvals cover the verified code path, not live owner payouts. Semgrep's subsequent 107-file scan ran 89 rules with no findings; 25 test files had partial generic-syntax parsing, while production files had no parse errors. All six new credit modules were scanned.

### Complete-journal recovery qualification

Recovery processes the lowest unresolved nonce first. A contiguous range of signed, uncharged prepaid holds can atomically move the protected transport pointer downward while retaining displaced originals and cancellations. Reconcile the canonical outcome before advancing to the next nonce. Retries retain exact signed bytes; expired BNB bundles are never renewed. Missing holds, changed pointers, unknown cancellation hashes and restore markers all stop recovery before signing or disclosure. Recovery/backup tests passed 81 and protected-provider tests passed 80. This includes the stale-refund snapshot drill and both chains' multi-nonce reorg cases. It does not recover lost journals or authorize clearing a restore hold.

### Real-proof SDK compatibility fixes

The Ethereum fork found two issues that mocked tests missed. Fee-free COMMON withdrawal population requires the SDK's self-signed Type2 gas shape on Ethereum; the client now supplies that shape only to population, keeping the original COMMON quote for authorization, accounting and submission. The installed SDK gas setter is exercised in the regression test; proof calldata and the price ceiling are unchanged.

A full withdrawal has one public unshield commitment and no private change ciphertext. The installed fee decoder unconditionally expects the first ciphertext. The prepaid validator now handles only the exact one-proof, one-commitment, zero-ciphertext, nonzero-nullifier COMMON or already validated bound-withdrawal shape before fee-note extraction. The active-POI rejection remains first. With no active lists, that SDK routine performs extraction and fee-note decryption, not spend-SNARK verification. Canonical parsing, signature checks, gas estimation and successful exact contract tracing still precede signing. New tests pass 12/12 on each chain; two additional prepaid regressions prove estimate/trace failure stops before SDK decoding, reservation or signature.

Final runs on both chains include the complete current SDK guard and generate six real proofs. After a valid extra wrapped-native withdrawal passes real parsing, tracing, reservation and signing, the fixture changes only its owned fork's proxy code to force an included revert and then out-of-gas. Both actual finalized status-0 receipts settle exactly once: native balance loss equals receipt gas cost; charged credit equals the integer pricing formula, exceeds gas cost, stays within the signed cap, and leaves zero reserved credit. Private principal and remaining customer backing are checked after each failure. This is deliberate settlement fault injection, not a claim that a real relay admits reverting bundles or that the production proxy can be changed this way.

Final one-input collection gas was 1,103,367 on Ethereum and 1,081,915 on BNB. Refund estimates were 1,026,929 and 1,010,633 gas. The 2,000,000-gas fixture allowance is not an approved production setting or a universal fragmented-input bound. Exact evidence is in `real-proof-fork/ethereum-included-failures/` and `real-proof-fork/bnb-included-failures/`. Final test-harness deltas were reviewed independently and scanned separately with Semgrep; production payment sources still match the final CodeQL snapshot.

### Existing PR backup mount finding — corrected

The outstanding PR #1632 review correctly identified that host-path equality did not prove the container used that directory. Backups now write a fresh exclusive 0600 challenge and verify its exact random value through the existing container mount before stopping or archiving. Running containers use a fixed Node read; stopped full backups use the existing immutable image, no pulls/network, read-only inherited mounts and dropped capabilities. Challenges are removed on success/failure. A stopped helper proves current daemon-side mount materialization, not historical inode identity after an earlier unmount.

Focused tests passed 60/60 with all Docker calls mocked and networking denied; TypeScript, `bash -n` and ShellCheck passed, with zero ShellCheck findings. Tests include matching reported paths with a different daemon-side directory, renamed live binds, failed/wrong challenges, immutable image rejection and cleanup. No real Docker daemon or owner state was used. The patch is local; GitHub's review state remains CHANGES_REQUESTED until a new reviewed revision is approved.

## Release decision

Keep production signing and fresh customer funding closed. Preserve both passing six-proof/failure runs, owner association checks, complete-journal recovery drills and final CodeQL triage. Review production collection bounds and owner payout operations, and complete exact-version review/CI. Stale-only snapshots remain blocked; there is no approved hold-clearing bypass. Then prepare bounded owner-signed live acceptance and obtain release approval for that version. No additional keys or wallet funding were requested for the implementation or synthetic fork tests.
