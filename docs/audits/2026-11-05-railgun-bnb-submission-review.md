# BNB candidate submission review and commercial constraints

Date: 5 November 2026. PR: [#1632](https://github.com/ophis-fi/ophis/pull/1632).
Reviewed executable source: `01d1adfe` (seven runtime/test files, plus operator
documentation). This supplements the preceding source and acceptance reports;
it does not clear the multi-chain release gates.

## Change and review

The BNB candidate now uses the documented Puissant single-transaction bundle
API instead of raw private publication. An empty revert allowlist, `noMerge`,
fixed 20-block/30-second limits, a head at most three seconds old and the
authenticated user-fee expiration bound every new user envelope. No membership
signature, builder-tip transfer, new proof, fee bump or public fallback is added.

The exact body is committed before disclosure in the existing private SQLite
journal. Retry/restart preserves the body; legacy raw-only and expired records
stay held. Explicit cancellations have separate immutable envelopes and history.
Builder acknowledgment IDs remain separate from the signed transaction hash and
do not establish settlement. Acknowledgment-storage failures retain the original
records and report a sanitized unknown outcome.

Guard deployment persists its envelope with the signed record. Freshness is
checked before signing and the publication head is refreshed afterward. Failure
to construct a usable envelope after signing still fsyncs the raw/hash as held.
Repeating deployment cannot create another signature. Ethereum keeps its existing
Flashbots endpoint/body; chain activation and financial limits are unchanged.

Independent Codex review identified the post-signature persistence gap; it was
fixed and independently re-reviewed. Claude's supplied-source candidates were
checked against the actual callers and identity/custody model. Accepted freshness,
raw-bypass, casing and acknowledgment corrections were implemented and tested.
The final Codex correction review found no actionable remaining source defect
and verified all seven frozen file hashes. These are scoped AI-assisted source
reviews, not audit-firm certification or live-provider approval.

Two candidates did not justify a new mechanism: commissioned guard/delegate
identities remain immutable, so incompatible identity changes require restoring
the original configuration or a newly commissioned installation; redundant
same-database creation anchors do not authenticate a same-UID storage attacker.
That attacker and an unlocked-key/host compromise remain explicit trust limits.

## Validation

| Check | Result |
| --- | --- |
| Protected provider | 77 tests passed: persistence before disclosure, exact retry/restart, expiry, malformed/duplicate responses, legacy/corrupt journals, cancellation rollback, casing and immutable acknowledgment history. |
| Broadcaster/deployment/chain configuration | 83 passed, three existing conditional skips. Includes authenticated-expiry propagation and slow/stale/unavailable post-sign deployment-head cases. |
| Types | Broadcaster plus client/operator and server typechecks passed. |
| Semgrep | All four changed production TypeScript modules scanned with the security-audit rules; zero findings and zero parse errors. |
| Ethereum fork regression | Two actual protected-provider tests passed after the change on the verified loopback Anvil fork. No mainnet write. |
| Source preservation | Frozen hashes match the reviewed files. No change to non-Ethereum signing gates, financial limits, guard contract/artifact, wallet format or browser/proof code. |

The earlier full browser/proof roundtrip was at `bcde0216`; it was not rerun for
this transport change. The updated Ethereum path received the focused tests and
two fork regressions above. Hosted checks on the publication SHA are separate
evidence and are not assumed complete in this report.

## Commercial and live qualification holds

The owner requested Polygon access and received an offer requiring a paid plan
and screening integrations. That offer is excluded by the existing no-new-paid-
services requirement. The earlier assumption of an available free tier is
withdrawn. Polygon's public announcement still describes a free baseline, so a
clarification reply is prepared for the owner's existing conversation; no free
access, subscription, endpoint or eligibility is assumed.

A bounded review of MetaMask Smart Transactions found Arbitrum/Polygon support
and type-4 plumbing, but did not establish permitted no-fee use by Ophis's
independent backend or the required guard/deployment, expiry and inclusion-time
revert policies. Its wallet fallback behavior cannot be copied into Ophis's
protected-only path. FastLane's concrete public searcher route adds bonding,
transactions and dissemination semantics that do not meet the current scope.
Neither is substituted for a qualified route.

BNB's deployed type-4/no-revert enforcement, funded successful inclusion,
authenticated private fee receipt and recovery still need qualification.
Arbitrum and Polygon still have no approved write route. Operators, owner pins,
guards and explicit native budgets remain commissioning requirements. Original
mainnet retry restrictions stay in place; expired cancellation envelopes cannot
be renewed automatically and can require another approved cancellation.

No real keys, funding, mainnet gas, vendor contact/purchase, merge or deployment
were used. All three added-chain signing gates remain closed. Included reverts,
provider failure or paid cancellation can still consume operator gas. Base remains
excluded pending the owner's separate go-ahead.

Primary references: [Puissant bundle schema](https://docs.48.club/puissant-builder/send-bundle),
[Polygon announcement](https://polygon.technology/blog/polygon-launches-private-mempool-mev-protection-is-now-a-one-line-integration),
[MetaMask wallet feature](https://support.metamask.io/manage-crypto/transactions/smart-transactions/),
[current controller source](https://github.com/MetaMask/core/tree/8f159190ca50e5888777d3b9a3afa5a37084072a/packages/smart-transactions-controller).
Raw manifests, reviewer outputs, candidate dispositions and logs are retained in
the private evidence directory `ophis-railgun-evidence/unblock-20261105`.
