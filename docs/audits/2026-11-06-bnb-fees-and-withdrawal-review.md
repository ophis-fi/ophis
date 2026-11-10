# BNB native fees, bound withdrawals and commissioning review

## Decision and scope

**Conditional development approval; live release remains blocked.** This follow-up to
`2686b8fcc33418f1a0d8ffd82846568579b2cde9` implements private WBNB fees while
preserving USDC/USDT principal. BNB ordinary signing and the client protected
operator allowlist remain closed. No merge, deployment, mainnet signed submission
or funding was performed for this work. The existing Ethereum service is unchanged.

The incremental scope is 39 application files, including 20 production TypeScript
modules, plus the commissioning plan and this report. No Solidity, SDK dependency,
lockfile or Rust changes are included. The broader PR also contains earlier
multichain/UI work; its previous review records retain their original scope.
`origin/main` at `248e6b2c1342732aa5aa6584b866c5b972e5ed2f` is contained in the branch.

| Finding severity | Corrected findings |
| --- | ---: |
| High | 2: separable fee/principal proofs; premature mixed-proof recovery deletion |
| Medium | 3: ambiguous public certificate; incomplete cleanup; recovery account ratchet |
| Low | 1: retry could select a different fee recipient |

These are scoped AI-assisted reviews and executable controls, not certification
by an audit firm. Financial and privacy changes remain high risk even when their
local tests pass. Final Codex and Claude follow-ups each report zero findings
in the corrected scope. Fresh hosted checks are recorded against the publication
revision in the PR; a prior green baseline is not release approval.

## Changes and trust boundaries

| Area | Behavior and affected callers |
| --- | --- |
| Fee oracle/admission | BNB advertises and accepts WBNB only, using 1:1 native value plus upward-rounded positive margin and a fresh trusted head. Stablecoins retain their 18-decimal principal/accounting roles. `validateFee` is called three times during admission; no bridged-USD feed establishes reimbursement. |
| Client balances/discovery | Fixed/Max swaps and withdrawals check stable principal separately from WBNB reserve. Discovery and displayed fees use WBNB. Ethereum retains its existing fee-asset policy. |
| Stable withdrawal | Both real proofs are bound to the same temporary account. Its signature covers their order, exact public transfer, action policy and execution nonce. A canonical self-transfer with `requireSuccess=true` is the sole new guarded exception. The operator rechecks the protocol fee and exact net output before signing. |
| Saved execution/recovery | Original proof bytes, broadcaster identity, authorization, gas terms, account and index persist before submission. Retry preserves them. Confirmation requires all nullifiers and the actual stablecoin transfer to the recipient. The shared reconciler has seven production call sites, including initial execution, retry, public resume and manual recovery. It advances the account index before deleting a confirmed bound record. Cancellation already follows that order. |
| Custody/commissioning | The offline helper derives a new gas signer and fee wallet, seals recovery material before SDK work, emits view-only runtime material and public metadata, and refuses existing output. Shared sealing accepts exactly one canonical public PEM block, RSA3072–8192/exponent65537. Cleanup steps run independently. No existing owner pins are installed or overwritten. |
| Guard creation | Only an unarmed chain56 owner-approved guard operation can bypass the general signing gate. Identity, canonical runtime, nonce, reserves, exact costs, journal and private delivery checks remain required. Ordinary BNB sponsorship, recovery signing and the Arbitrum/Polygon gates remain closed. |

## Findings and concrete corrections

**WITHDRAW-1, high:** the first uncommitted mixed COMMON design supplied a fee
proof and principal proof with no shared execution binding. Historical calls to
the canonical fork pool separately accepted each proof. A recipient of the request
could extract the fee without delivering the withdrawal. That design was removed.
COMMON now permits only a single WBNB withdrawal proof on BNB. Stable withdrawals
use the existing canonical signed 7702 delegate and guard, with both proofs bound
to its account; no new contract was introduced.

**RECOVERY-1, high:** clearing a mixed record when any nullifier was spent could
discard a still-executable second proof. Reconciliation now evaluates invalidation
per proof and retains unresolved records. Bound records without a confirmed public
recipient transfer stay recoverable even if inputs were consumed. Existing
single-proof Ethereum invalidation behavior is preserved.

**CERT-1, medium:** Node accepted a certificate followed by another public key
and could select the latter. The shared parser now rejects multiple blocks,
noncanonical Base64, unsupported key types/sizes and exponents. Every sealing
caller uses it, including migration. Migration validates sealing before binding
an empty journal. Synthetic tests reproduce ambiguous PEM and noncanonical pad bits;
the actual existing public certificate independently passes the production parser.

**CLEAN-1, medium:** one failed SDK/database cleanup step prevented subsequent
cleanup. Each step is now attempted independently; errors are generic and final
recovery ciphertext is retained. Fault injection covers stop/close/remove/fsync.

**RATCHET-1, medium:** a busy response or interrupted initial send could bypass
the initial account ratchet. A later confirmation deleted the record without
advancing the saved index. The common confirmation path now awaits persisted index
advancement first. Tests cover lost-response history discovery, deletion ordering
and ratchet failure retaining the exact signed request. `unusedSwapAccount` also
checks public nonces, but is no longer relied on to repair this omission.

**RETRY-1, low:** fresh discovery could choose a different operator from the
recipient already embedded in the proof. New saved requests pin the original
fee identity and filter retries accordingly.

The retired mixed-COMMON UI exit concern does not justify adding a migration UI:
that format was a local uncommitted experiment, never deployed or made available
through a BNB production signer. Existing encrypted records are nevertheless
preserved and unsafe rebroadcast is refused. This is not a claim to have inspected
every user's private browser database.

The guard exception was explicitly re-reviewed as a commissioning operation, not
ordinary sponsorship activation. Its proposed owner record still has
`gasFundingApproved=false`.

## Executable protocol evidence

Tests used generated disposable wallets on loopback Anvil, forked from verified
BNB block131891850 (`0x5a9ffdec4a76cd1caa82414c207c1b3c89c624c4c8281985fbf93f536cb9e8b2`).
The pool, implementation and delegate runtimes were unchanged and hash checked.
Actual shield notes and independently verified canonical Merkle witnesses fed the
installed wallet11.2.0/engine9.9.1 public proof API. Dummy witnesses were confined
to the SDK gas estimator; real proofs used the normal verifier origin.

| Case | Result |
| --- | --- |
| USDC withdrawal | 1 gross USDC delivered 0.9975 USDC; gas1,553,262; actual native debit0.0000776631BNB. |
| USDT withdrawal | 1 gross USDT delivered 0.9975 USDT; gas1,607,632; actual native debit0.0000803816BNB. |
| Both fee budgets | Authenticated private0.000276WBNB; signed gas ceiling4,800,000 at0.05gwei =0.00024BNB, plus15%. This modeled price is not a builder minimum or current quote. |
| Binding controls | Both standalone proofs reject the ordinary sender. The original full historical call succeeds; a truncated batch retaining its signature rejects under the same state. |
| Failed transfer | A deliberately oversized signed safe-transfer reaches the successful pool call then reverts the whole transaction: no logs, nullifiers unspent, recipient unchanged and internal nonce unchanged. The negative-control snapshot is then reverted before the honest case. |
| Fee/receipt verification | Exact first fee commitment is SDK-decrypted and included; independent RPC review checks authorization, signed batch, trace, canonical code, gas debit, exact recipient delta, zero temporary stable balance and execution nonce0→1. |
| Stablecoin swap | The earlier real-proof USDC→WBNB guarded swap paid a separate WBNB fee, left zero public principal, and confirmed its private output. It is separate from the rejected COMMON withdrawal result. |

EIP7702 authorization effects can persist on an included outer revert: the negative
control leaves the account's authorization nonce at1 while its internal execution
nonce stays0. Retry therefore fails closed when authority changed; saved public
recovery/cancellation remains required. An included revert consumes native gas
without delivering the private fee. This evidence does **not** establish zero loss
or actual BSC builder revert exclusion.

## Tests and analysis

- Broadcaster default suite:501 passed,7 optional skips. Final supported BNB suite:
  431 passed,1 optional skip; Node22 build/typecheck passed. Four
  Ethereum-specific harness files are excluded from the global chain56 run;
  their default-chain and explicitly selected chain cases are covered separately.
- Client:391 passed,12 optional skips; browser/server typechecks and BNB mainnet
  profile Vite build passed. This is compilation, not a production browser or
  hardware-wallet acceptance claim.
- Guard artifact reproduction passed. Slither ran101 detectors on the unchanged
  guard: one informational intentional low-level call whose success and nonce
  advance are checked; no high/medium findings.
- Semgrep scanned all20 changed production TypeScript files with pinned applicable
  rules:172 applicable rules, zero parse/engine errors, two informational long
  `textContent` templates triaged as benign and zero confirmed security findings.
- Independent Codex and Claude reviewed the native-fee design and commissioning
  boundaries. Their findings above were corrected; the final account-ratchet delta
  received separate focused follow-ups with zero findings from both reviewers.
  Claude's supplied-source limitations are
  retained alongside its results.
- CodeQL is applicable to the TypeScript and runs in hosted CI; no local CodeQL
  executable is installed. The fresh publication check must be used. No fresh
  Pashov Solidity-only run is claimed because Solidity did not change. The
  Trail of Bits differential-review and ethskills security/testing workflows
  informed the review; Jev was unavailable in this environment.

No line/branch coverage percentage was collected. Full-history Waku fee assurance,
actual BSC type4 inclusion/filtering, owner recovery-key decryption, restart/live
recovery and phone/Ledger spending remain unverified. Tests initially encountered
disk exhaustion; after space was freed, SQLite cases passed. A migration fixture
also timed out under Node26 but passed in295ms under the selected Node22 runtime;
Node26 compatibility is not asserted. The existing SDK returns account index0 on
a database read error; its shared monotonic setter therefore depends on readable
SDK storage. Public nonce scanning is an additional backstop. No new claim of
crash-atomicity across separate SDK/journal databases is made.

## History, evidence and release requirements

History inspection traced custody/migration to `b2314965`, chain guards to
`f7b9ada1`, and durable private envelopes to `01d1adfe`. The general chain gate is
retained, with the explicit narrow guard-creation exception described above.
Existing encrypted-wallet formats and already saved Ethereum proofs remain
compatible; no security check was removed to make a test pass.

Evidence is retained outside Git at
`/Users/scep/ophis-railgun-evidence/bnb-acceptance-20261105`: `bound-exit/`,
`bound-usdt/`, retired-design controls under `mixed-fee/`, `commission/`,
`review/`, `semgrep-final/` and validation logs. Each corrected withdrawal has a
`root-independent-review.json`; source/review manifests bind the checked files.
No operator ciphertext, recovery key or owner pin manifest is included in Git.

Before live release, complete the [commissioning plan](../development/plans/2026-11-05-bnb-broadcaster-commissioning.md):
owner verification of encrypted recovery records; approval of the exact native
exposure and isolated installation; deployed operator-bound guard; actual private
type4 success, revert exclusion and immutable expiry/retry acceptance; Waku/full
history fee receipt and recovery; then a separately reviewed activation diff and
owner release approval. Arbitrum/Polygon remain separate follow-ups. Base waits
for the owner's go-ahead. No additional paid service is introduced.
