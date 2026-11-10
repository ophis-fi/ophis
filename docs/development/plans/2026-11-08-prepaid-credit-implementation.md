# Confirmed prepaid credit for Ethereum and BNB

Status: active implementation on local branch `feat/railgun-prepaid-credit`, based on `b85807fdc6227ec16cce61a058c6218e4adf07d6`. Not committed, pushed, merged, deployed or activated. The owner approved implementation on 8 November. Track elapsed implementation/testing and the concrete acceptance gates below; no fixed release date is justified yet.

GitHub readback on 8 November confirmed `main` remains `248e6b2c1342732aa5aa6584b866c5b972e5ed2f`, an ancestor of this branch. PR #1632 is open, unmerged and blocked. Earlier changes in that PR are not a release approval for this payment redesign.

## Requirement and boundaries

Every broadcaster signature must have sufficient separately finalized customer credit reserved before the signature is created. That credit must cover the entire permitted gas liability, collection allowance and margin, including an included revert or bounded same-nonce cancellation. A successful simulation or a fee placed first in the operation is insufficient.

Scope: Ethereum/WETH and BNB/WBNB fee credit, preserving the existing swap and withdrawal asset support and protected transports. Arbitrum and Polygon stay closed; Base requires the owner's separate go. No new production wallets, spending-key imports, paid services, native reserve transfers or production limit increases are included.

Existing custody stays authoritative:

- Gas operator, both chains: `0x001486E70A0c9291f5F55c68914eE0e4E4A604d4`.
- Private fee recipient: `0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f`.
- Treasury/refill destination: `0x58707c6C1E111c21cba4C9C8caE144175F84EceE`.
- The server keeps view-only access to private fees. Only the owner can spend or refund those private notes.

## Implemented flow

1. The client pins the approved chain, operator, wrapped token, private recipient and immutable ledger ID. The existing private wallet's derived account 0 signs an EIP-712 authorization; no new owner wallet is generated or funded.
2. The user explicitly approves a private transfer from their own private balance to fee credit and pays that transaction's native gas through their public wallet. Its encrypted memo binds the credit owner and ledger. Ophis never sponsors this bootstrap transaction.
3. The backend's view-only wallet verifies canonical finalized inclusion, exact token/recipient/amount, decrypted memo, commitment tree/position and on-chain encrypted payload. A public receipt hash alone cannot claim credit. The same leaf credits only once; separate leaves with the same commitment hash are distinct payments.
4. An authenticated quote specifies the maximum attempt charge. SQLite atomically reserves that credit and the exact unsigned operator transaction/nonce before signing. No missing-fee shortcut is available to legacy mainnet requests. The private balance must still back all outstanding customer liabilities.
5. The client creates an operation without the old embedded broadcaster fee. Existing proof, route, recipient, simulation, guard and protected-delivery checks remain. Signed bytes are durable before disclosure. Repeated authenticated requests retain the same attempt identity and cannot create another charge.
6. Finalized canonical success, revert or known cancellation settles actual gas plus the quoted collection allowance and margin, within the reserved maximum. Unused reserved credit returns to the available balance. Unknown outcomes keep their hold. Before finality, the full exposure remains accounted for even if the operator nonce has advanced.
7. The UI exposes separate available/reserved credit and saved top-up/operation recovery. Original top-up proofs are retained for exact retry; no automatic reproving or second top-up resolves uncertainty. Existing legacy journals remain intact. Disabled/expired execution admission does not erase credit or suppress authenticated recovery/refund exits for a pinned ledger.

## Economics and user-visible limits

`maximum charge = ceil((maximum gas cost + collection allowance) × rate / 10^18)`.

`rate = ceil(10^18 × (10000 + margin bps) / (10000 − current unshield fee bps))`.

Final settlement substitutes actual canonical gas cost for maximum gas cost. The collection allowance is a disclosed fixed budget, not a claim that collection has already occurred. The new `OPHIS_BROADCASTER_CREDIT_COLLECTION_GAS` defaults to zero, which prevents pricing/activation until a reviewed measurement is supplied. No live value was invented.

Private wrapped-native credit is an asset backing gas expenditure; it does not automatically replenish the public native gas wallet. Reserve, price and rolling spend caps still apply. Reporting separates earned charges and completed refund fees from unused customer credit. A fee-wallet balance includes customer liabilities and must not be collected as revenue.

First use is not fully gasless. The top-up needs user-paid native gas and finalized confirmation. Reusable credit amortizes this setup; it does not remove chain finality or RAILGUN balance synchronization. The public gas payer and top-up timing are visible, and the UI requires explicit privacy/fee consent. Do not promise instant first use or a fixed confirmation time.

## Refunds and recovery

Refund requests reserve a signed gross amount and an exact private net recipient/amount. They do not automatically transfer funds. The service verifies a finalized matching outgoing note before marking a refund paid; periodic reconciliation does not depend on the requester keeping a browser open. The hold is retained on unverified or failed payments. There is no automatic expiry/cancellation of a potentially payable refund, which could allow double spending of the reserved credit.

**Owner payout association passed both real-proof forks; bounded live owner-wallet acceptance remains.** Static review of the signed ANON 0.12.4 extension shows that its internal SDK supports encrypted transfer memos, while the popup Send form forces `memo: null`. Every refund requires the privileged local command `record-refund-payout KEY HASH`, which records an operator-approved finalized transaction for an existing refund under the stopped-service lock. It requires no key, unlock or signature and does not transfer funds. Public Waku clients cannot call it. A matching memo or sender-view annotation alone cannot authorize settlement, because those do not prove spending authority over the transaction inputs.

The background view-only verifier then checks that assigned hash and exact canonical block tuple, sender-view note, private recipient, wrapped token, net amount and ciphertext. Only a matching actual note can settle the hold; an assigned hash alone cannot. Assignment history is append-only, and the same note cannot pay two refunds. Wrong candidates remain in the audit history but do not hide a later valid one. This lets the owner send normally in ANON and associate the exact payout afterward without sharing a spending key. See [the owner refund procedure](../../../apps/broadcaster/PREPAID-REFUNDS.md) and static ANON evidence in `ophis-railgun-evidence/anon-failure-20261108/refund-memo-compatibility.md`.

Critical snapshots carry `creditRecoveryRequired`; full backups carry `.prepaid-restore-review-required`. Both block prepaid signing, cancellation and new refund reservations after restore. Missing nonce history also blocks signing. A stale backup is not sufficient to recover missing refund holds, owner payouts or unmined signatures. **No automatic clearing or manual-SQL bypass is approved.** Recover the complete newer journals and prove the restored liabilities before enabling spending. The stale-refund snapshot drill and complete-journal recovery across multiple reorged nonces now pass. A stale-only restoration remains blocked.

## Evidence and remaining acceptance

Validation on 8 November:

- Final full backend: 668 passed, 30 skipped; final BNB-focused backend: 145 passed, 2 skipped. Skips include gated live/fork cases; they are not acceptance evidence. Final runner logs are preserved under `/home/clement/ophis-prepaid-proof-20261108/evidence/*final*.log`.
- Backend typecheck passed. Client baseline: 535 passed, 12 skipped; the subsequent gas-shape fix passed 14 focused regressions, both TypeScript configurations and production compilation. Mobile-width layout tests passed. Additional restore-marker regressions: 60 passed in the two affected backend files.
- Real synthetic encrypted RAILGUN note/decryption tests verify memo/ciphertext and received/sent-note behavior without using any owner wallet. These are not complete real-proof transaction roundtrips.
- Both isolated forks now pass six real SDK proofs: user-paid top-up, swap, withdrawal, an additional valid withdrawal used in two included-failure cases, memo-less owner refund with explicit association, and owner collection. The included revert and out-of-gas receipts charged actual gas plus the quoted allowance/margin from real confirmed credit, released unused reservations, preserved private principal and retained backing. Each chain signed/submitted four operator transactions; exact replay added none. Final source includes the nullifier string guard. Reports are in `ophis-railgun-evidence/prepaid-20261108/real-proof-fork/{ethereum,bnb}-included-failures/`.
- The BNB read endpoint/history and fixture initialization issues were resolved without weakening production gates. Its simulator disables Anvil's default 1 gwei priority floor and uses a 1 wei local base fee; unchanged production caps apply. Fault injection modifies only the owned fork after real validation/signing. These tests do not establish live builder inclusion, consensus or owner-wallet interoperability.
- Independent Claude source review, separate custody/client/transport reviews, ETHSkills security guidance and Trail of Bits differential-review method. These are not audits commissioned from Trail of Bits or Pashov.
- Final CodeQL completed on 189/189 source files, including local and remote threat models and custom decrypted-request/SQLite models. All 52 baseline and 46 modeled alerts were triaged with no production blocker found; reports and exact source manifests are in `ophis-railgun-evidence/prepaid-20261108/codeql/final/`. Semgrep evidence is also preserved under `prepaid-20261108/`. These results do not replace final CI or financial-invariant tests. No Solidity changed in this payment diff, so a Slither rerun would not validate the new TypeScript ledger/client paths.

Final collection consumed 1,103,367 gas on Ethereum and 1,081,915 gas on BNB, each with one input note. Final memo-less refund estimates were 1,026,929 and 1,010,633 gas respectively. These measurements qualify those fork shapes only. Fragmented collections, production pricing and a safe per-chain collection allowance still require review; no production collection setting or funding limit was changed.

Required before any customer funding or production activation:

1. Preserve both successful six-proof fork runs, the passing stale-restore/multiple-nonce drills, and the verified backup mount correction. Neither complete-journal recovery nor mount verification permits clearing a stale-only restore hold.
2. Review production collection bounds, finality and the owner payout procedure. Included reverts/out-of-gas now have real-proof/receipt evidence; restart, cancellation, price/expiry and restore behavior also have targeted regression evidence, not blanket live-consensus qualification.
3. Freeze the resulting diff, finish exact-version independent review and CI, and resolve all material findings. Preserve the completed CodeQL evidence and rerun relevant checks if the reviewed source changes. Preserve the guard/transport qualification; prepayment is not a new MEV route.
4. Prepare the exact owner-approved live test amounts, custody/runtime pins, deployment hashes and rollback plan. The owner performs wallet unlocks and signatures; no further keys are needed by the agent. Existing approvals are not permission to expand the test budget.
5. Verify actual user-paid Ethereum and BNB receipts, earned charges, retained credit and native gas expense before requesting release approval against that tested version.

This design addresses the identified unpaid execution/cancellation loss within the signed caps. It does not promise protection from finality failure, compromised hosts/keys, owner removal of customer backing or undiscovered implementation defects.
