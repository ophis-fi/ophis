# RAILGUN broadcaster and private-flow final source review

Date: 5 November 2026. PR: [#1632](https://github.com/ophis-fi/ophis/pull/1632).
Reviewed executable source: `c2b887daeb283a277a70224fa284f4fe89e891ac`. Comparison base: `248e6b2c1342732aa5aa6584b866c5b972e5ed2f`.

## Decision

**Final source review closed with no actionable findings remaining.** Codex independently approved the full change-set baseline and both correction diffs. Claude confirmed closure of the accepted findings, including the final readiness-focus and screen-reader changes. Those source verdicts are bounded by the validation and limitations below.

**Release remains on hold. This report does not authorize merge or deployment.** The Rust dependency gate and live acceptance requirements below remain unresolved. No production unlock, signing, funding transfer, wallet reset or deployment was performed during this review. Base remains excluded.

## Scope and evidence

All 86 changed files are accounted for: broadcaster/runtime/custody/fees and their tests; protected transport and guard binding; private-client/parent-frame UI, recovery and test fixtures; canonical logos; workflows, packaging and operational documentation. Review was focused on changed runtime code and its one-hop security dependencies. Tests and documentation received risk-based inspection; assets were compared byte-for-byte with the existing Ophis assets. This is a review of this change set, not every dependency or the entire Ophis codebase.

The full 81-file state at `6d10f301` received a fresh independent Codex review, with no actionable findings, plus separate client, fee/state and protected-submission reviews. The 13-file correction at `515807c8` and the final three-file accessibility correction were reviewed separately. A source manifest records the hashes used for the review. The broadcaster, guard, owner helper and proof-policy/network metadata remain byte-identical to their previously reviewed `9a65fa01` baseline; the direct execution readiness checks are explicit new client hardening.

Methods: security-focused differential review, history/blame inspection, ethskills domain checklists for general safety, math, oracles, signatures, chain differences and access control, and Trail of Bits' secure workflow with Slither. The earlier Pashov-method guard review remains baseline evidence because guard source/artifact bytes did not change. Codex reviewed repository source; Claude reviewed supplied source without tools. Findings were independently checked against full source before being accepted or rejected. This is an automated and AI-assisted source review, not an audit or certification by those firms, and not formal verification.

## Security properties reviewed

| Boundary | Reviewed behavior |
| --- | --- |
| User payment / operator gas | Authenticated private fee-note commitments, issued-quote membership and fresh-rate coverage of the full signed gas ceiling plus margin; positive fees and upward rounding for native and 6/18-decimal assets. Admission rechecks chain state, authority, trace, balance and pricing before signing. |
| Oracles / chain state | Feed identities, positive completed rounds, freshness across asynchronous reads, depeg bounds and Arbitrum sequencer/grace checks. BNB minimum gas price and optional base fee, Polygon priority fee, and chain-specific settlement boundaries remain explicit. |
| Signing / execution | Immutable process chain, exact sender-approved bytes, chain-bound authorization, pinned canonical proxy/delegate and guard runtime, fresh-state retracing and expected execution-nonce consumption. No public write fallback was found. |
| Journals / retries | Durable signed bytes before disclosure, one unresolved outer nonce, permanent historical nonce reservations, append-only cancellation history, canonical receipt checks, retained fee-assurance holds and bounded gas exposure. Unknown outcomes do not erase saved proofs. |
| Custody / owner recovery | Owner-held ciphertext hash pins checked before decryption; private owned files/directories and socket checks; strict gas-wallet identity and view-only runtime role; separate retired fee-spending material; bounded input and buffer clearing. No real recovery key was read. |
| Browser spending / recovery | Existing encrypted storage formats remain intact. New direct execution readiness checks precede proof generation/journal/disclosure; pending recovery index follows a new saved identity and preserves later manual choices. Storage failures preserve this profile and offer reload. |
| UI / frame / delivery | Existing native selection events and disabled/busy gates, accessible fixed-size chevrons and visible picker labels, first-use and saved-wallet flows, safe error-state controls, explicit focus, frame-origin/layout handling, frozen CI installs and read-only credentials. |

Critical identifier references were traced across runtime files: `readChainState` in five, `assertSigningNetwork` in four, `bindIdentity` and `nonceBlocked` in three each, and owner-pin/unlock functions in two each. These counts include declarations and represent a bounded static reference map, not a complete dynamic call graph. Guard inheritance, function and variable-authorization outputs were generated and inspected.

## Findings and corrections

No introduced Medium-or-higher exploitable defect was established. Claude's initial candidate severities were checked against baseline history; the confirmed issues below were Low reliability, recovery-guidance or accessibility issues. Some predated this PR and were fixed while closing the review.

| Issue | Status / correction |
| --- | --- |
| Generic storage-read failure recommended another browser profile, which omits this profile's pending records | Closed: reload/retry first; explicit keep-profile/do-not-clear guidance. |
| Background synchronization overwrote transaction results | Closed: scan text and changed non-percentage screen-reader announcements use separate elements; operation results remain visible. |
| Failed saved-transaction wiring exposed incomplete controls | Closed: hide the incomplete wallet and offer a dedicated lock/reload action without deleting data or reopening an already-open SDK. |
| A later pending swap left an older recovery account index selected | Closed: update the index only on a newly observed pending identity; preserve manual selection after that. |
| Setup, review and confirmation transitions lost keyboard focus | Closed: explicit heading/input focus; readiness is applied before funding-completion focus. |
| A delayed funding event redirected from Recovery/Activity or an active operation | Closed: funding completion preserves other views and avoids navigation during a busy operation. |
| Visible labels targeted hidden native selects | Closed: labels target the real picker buttons, including after the recovery control moves. |
| Operator README described only an external Ethereum operator | Closed: describes Ophis's broadcaster, the Ethereum examples and the source-gated added chains. |
| Executor readiness relied on preparation and the normal UI gate | Hardened: both execution entry points directly reject unsynchronized history before proof, journal or disclosure work. |

The original twelve supplied-source candidates all have dispositions. Password confirmation/Enter submission, persistent onboarding after an interrupted first create, and extra busy/no-match feedback remain optional product choices; none demonstrated a security bypass. Existing quote, fee, pending-state and simulation checks remain in place. Picker refreshes now ignore unrelated input and create/restore uses new-password autocomplete.

## Validation

| Check | Result and scope |
| --- | --- |
| Broadcaster unit tests | 393 passed; four optional/chain-specific skips. Unchanged broadcaster bytes were rerun at `6d10f301`. |
| Client/operator unit tests | 349 passed; twelve optional integration skips, rerun on the final executable bytes. |
| Chain matrices | Arbitrum: 64 passed / three chain-specific skips; BNB: 67 passed; Polygon: 66 passed / one chain-specific skip. Signing, fee and settlement matrices are offline evidence. |
| Builds / types | Broadcaster build/typecheck and final mainnet private-client production build/typechecks pass. The existing large SDK chunk warning remains. |
| Guard | Artifact reproduction and ten Solidity tests pass, including 1,024 nonce fuzz cases. |
| Slither | 101 detectors; one Informational low-level-call result, no other detector findings. The call is intentional and guarded by immutable operator/delegate/code/selector and before/after nonce checks; inner failure reverts. It does not prove private-builder behavior. |
| Semgrep | 56 production/build files, 61 rules run, zero findings and zero parse errors on the final source. |
| Browser | Actual picker/layout/run DOM fixture passes at 470, 390 and 320 px. Regressions cover error/retry state callbacks, result persistence, early execution refusal, pending index, labels and keyboard/funding transitions. DOM-only fixtures do not execute real proofs. |
| Canonical assets / DOM | Seven logos match the main swapbox assets; all 84 original IDs remain, without duplicate IDs. |
| LAN preview | Desktop/mobile UI-only smoke passed; zero external or transaction requests. The preview does not load a real wallet engine. |
| CodeQL / hosted CI | At `515807c8`, broadcaster/image, private-client/build/browser and CodeQL JavaScript/TypeScript, Python and Actions jobs pass; zero open PR code-scanning alerts. The snapshot has 44 passing checks, one broader frontend check still running and the unchanged Rust gate failing. The final accessibility/report publication gets a fresh CI run; its completion is not assumed here. |

No skipped live test is counted as passing. The review did not add or weaken a dependency-policy exception.

## Unresolved release gates and residual exposure

1. The hosted `cargo deny` gate fails for unchanged Rust dependency `pin-utils 0.1.0` (RUSTSEC-2026-0441, unmaintained). The Rust lockfile and deny policy are identical to current main. Clear the gate through a separately reviewed dependency change; do not bypass it to release this PR.
2. Qualify private type-4 delivery and revert filtering on every added chain. Arbitrum and Polygon have no configured protected write route; BNB has a candidate route, and all three added-chain mainnet signing paths remain blocked in source.
3. Commission each operator/guard, trusted owner pins and native financial limits, then verify funded swap/withdrawal fee receipts and recovery. Qualify bridged-token valuation or exclude those fee tokens before activation.
4. Rerun the final combined real-wallet/WalletConnect/proof acceptance and state-preserving deployment/rollback checks before release. Historical Ethereum pilots and real-proof fork tests do not establish acceptance for this final client or for the added chains.
5. Preserve the documented trust limits: Ethereum's inherited two-confirmation settlement is not finality; added chains use finalized settlement and may delay admission. Same-UID host compromise is outside filesystem/socket pin authentication. An unlocked online gas key can lose its funded balance if the service account/host is compromised; application spending caps do not constrain use of a stolen key. Treasury and fee-spending authority remain separate. Independent SDK/protocol dependencies and provider behavior are not certified by this source review.

The operator advances native gas. The private user fee is received only on successful execution; included reverts, provider failures or explicit paid cancellations can still consume operator gas without reimbursement. Simulation, private-provider policy, margin and spending caps reduce and bound exposure but cannot guarantee zero operator loss. If zero loss is an absolute launch requirement, this architecture still needs a payment-policy decision before activation.

## Review artifact

This report is a documentation-only addition after the reviewed source commit. Executable source and test hashes were checked unchanged before publication. Detailed manifests, raw tool results, candidate triage and reviewer outputs are retained in the private local evidence directory. No secret material is included in this report.
