# Owner broadcaster release review — 7 November 2026

## Scope and release boundary

Incremental review of the owner-identity release against `aab11d76`, after the source reviews recorded on 5–6 November. The current `main` commit `248e6b2c1342732aa5aa6584b866c5b972e5ed2f` is contained in this branch. Solidity, protocol proofs, dependency versions, wallet encryption/storage and gateway policy are unchanged in this delta.

Four production modules change: broadcaster configuration, client fee configuration/discovery, and the shared wallet action handler. Their callers include startup, ordinary requests, recovery and guard commissioning; client discovery, preparation, retry and submission; and confirmed-swap presentation. The relevant tests and operational documentation are updated together.

Ethereum binds the owner's ANON private fee identity. Both delegated and common submissions reject the retired fee identity. Protected swap approval expires on 13 November; common withdrawals remain available with the selected identity and the existing gas caps. BNB signing is restricted to explicit pilot admission, including direct request/recovery paths; guard/account/operator pins, fee coverage, simulation, budgets and private-only transport remain mandatory. No public BNB client identity is approved. Arbitrum/Polygon signing and Base work remain closed.

The UI clears the spent input only after `executePrivateSwap` confirms and reconciles its private output. A later history-refresh error retains the confirmed transaction status. An unresolved execution retains its amount and recovery record.

## Live evidence and money

The owner-identity Ethereum swap and withdrawal are finalized and independently verified through two read RPCs. The swap paid 0.0002667069711594 WETH against 0.000098272146816379 ETH actual gas; the withdrawal paid 0.184488 USDC against 0.000056511420922335 ETH actual gas. Both authenticated fees cover their signed gas ceilings plus at least 15%, including independently reconstructed historical oracle values for USDC. The approved recipient received 0.738184 USDC. This is observed acceptance, not a zero-loss guarantee for future included reverts.

The public Ethereum service is prepared with the same ANON operator and deployed guard, 0.5 gwei maximum price, 0.0015 ETH per-transaction and rolling-day limits, 0.0015 ETH reserve and 15% minimum margin. Both retained requests are confirmed and fee-assured, and latest/pending nonce both equal 3. State and used pilot markers remain intact. Deployment and owner unlock are distinct from source approval.

BNB guard/private-builder qualification is complete, with negative cases explicitly rejected and held nonces resolved. Real user-paid swap/withdrawal acceptance remains missing. The owner has no separate BNB principal available; the existing reserve is not authorization to use it as user funds.

## Validation and review

- Client: 464 passing tests, 12 intentional skips; both TypeScript checks and mainnet build pass. Existing layout fixtures pass at 470, 390 and 320 pixels. The three new UI regressions cover confirmed completion, later refresh failure, and uncertain execution recovery.
- Backend: full default suite 542 passing, 29 skips. Selected BNB suites: 275 passing and one skip under an external-network-denied harness; its one localhost-listener case initially failed because the harness denied listening, then passed with loopback permitted. No production change or timeout increase was used to hide that harness failure. Typecheck and build pass.
- Semgrep OSS: all four changed production modules scanned with existing pinned offline rules; zero parser/engine errors. Two INFO one-liner matches are existing user-facing strings assigned to `textContent`, with no HTML/code execution. No confirmed scanner finding. Pro/interprocedural analysis was not available.
- Independent Codex differential review reports zero confirmed findings and conditionally approves Ethereum with the staged owner identity/caps. It explicitly withholds public BNB approval. Claude supplied-source review and fresh hosted results must also close before merge; exact verdicts are retained in the release evidence.
- Trail of Bits differential-review and ethskills security/QA methods apply to this delta. Previous Pashov-method/Slither guard evidence retains its original scope because contract/artifact bytes are unchanged. Jev is unavailable in this tool environment. These are AI-assisted reviews and static checks, not certification by an audit firm or formal verification.

Evidence: `ophis-railgun-evidence/launch-20261107`, plus finalized Ethereum acceptance in `ethereum-pilot-20261106` and BNB qualification in `baal-replacement-20261106/bnb-qualification`. Frozen source hashes bind reviews and compiled artifacts. Fresh hosted CI/CodeQL remain required on the final commit.

## Residual risks

Baal administrators or a compromised host can access the unlocked software gas key; the owner explicitly accepted this custody model. Private builders and trusted simulation endpoints remain trust assumptions. Included outer reverts/cancellations can consume operator gas without fee reimbursement. Collected private fees require owner-controlled withdrawal/conversion/refill and are not automatically spendable native gas. No paid service, new key, reserve repurposing, or other-chain activation is part of this release.
