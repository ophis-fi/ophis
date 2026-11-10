# BNB broadcaster commissioning

Status: local implementation, real-proof fork tests and source-review corrections complete; final Codex/Claude follow-ups report zero findings; hosted checks are tracked in the draft PR. BNB ordinary mainnet signing remains disabled. No funding, server installation, merge or deployment is approved by this record. Base remains excluded; Ethereum identities, service and limits are preserved.

## Selected fee policy

BNB fees come from the user's private WBNB balance. WBNB reimburses native BNB at 1:1 plus the configured positive margin; the test policy uses 15%. USDC and USDT remain supported as principal, with their verified BNB precision of 18 decimals. Stablecoin fee valuation and bridge-redemption assumptions are excluded. Fixed and Max amounts track principal and fee balances separately.

WBNB withdrawals can retain a single COMMON proof containing fee and withdrawal. Stablecoin withdrawals must use the existing nonce-aware signed 7702 execution, canonical delegate and operator-bound guard. Every proof is bound to that temporary account; its signature commits to the complete ordered proof list, action data and execution nonce. An exact self-call to the canonical delegate's SafeERC20 transfer sends the post-unshield amount to the public recipient with requireSuccess=true. No new Solidity contract is required. Two unbound COMMON proofs are prohibited: actual historical fork calls proved each could execute separately.

New saved withdrawals retain the original broadcaster identity, account/index, authorization, nonce, full signed execution and gas terms. Retry uses those same bytes and original fee recipient. Partial execution or an uncertain outcome retains recovery data and blocks a second request. Older records are never silently re-priced, re-proved or relabeled.

## Validation at the prepared revision

The [incremental security report](../../audits/2026-11-06-bnb-fees-and-withdrawal-review.md) records the rejected separable-proof design, corrected signed binding, custody/recovery findings, evidence and limits. The default broadcaster suite passes501 tests; the supported BNB suite passes431; the client passes391. Both builds and TypeScript checks pass. Real USDC and USDT withdrawals pass against canonical BNB state with genuine SDK proofs, standalone-proof rejection, strict transfer rollback and independently checked receipts/fees. Fresh hosted checks remain tied to the PR publication SHA. These results do not enable mainnet signing.

## Prepared public identities

| Role | BNB value |
| --- | --- |
| Treasury/refill | 0x58707c6C1E111c21cba4C9C8caE144175F84EceE (owner's Ambire + Ledger) |
| New dedicated gas operator | 0x5C50454A635487c2ff22e9705FF3CB4C36a0F99B |
| Predicted nonce-zero guard | 0xA1FaEBE5E971f8e3a40CdA71eE770b5B03301B69 |
| Canonical delegate | 0xa2BFd382c54bb33DF6A13f21acd8770dc1e67D4D |
| Expected guard runtime Keccak256 | 0xb45a44dba264dfbd10915aa986ef7e86ec60a813f20fceea9e85565bceb2d62a |

The fresh gas/fee identities were generated offline and sealed under the existing public recovery certificate. Runtime material contains the gas key and fee viewing key; dedicated fee spending material remains in the encrypted retired archive. No recovery private key was read by the agent. These records are unfunded and uninstalled. The operator is a software signer after manual unlock; Ambire + Ledger controls treasury refills, not every automatic signature.

The helper validates exactly one canonical public PEM block, RSA3072–8192/exponent65537, and emits the actual DER-SPKI fingerprint. The existing actual public certificate was independently attested as a single RSA3072/65537 X.509 block, SPKI SHA256 `84310e92b117d943a72c9ae7d27ff49e41bab3b065ed36f9885266953a29a541`. Version1 encryption/decryption remains compatible. Owner recovery verification is still required before funding.

Candidate owner pins are chain56 only: merge that one verified entry into the existing private owner manifest while preserving chain1 and every other entry byte-for-byte; refuse to replace an existing chain56 entry. Do not copy the candidate over the existing manifest. Neither pins nor ciphertext belong in Git. Verify both runtime and retired records with the owner-held recovery key before uploading or funding.

## Installation and acceptance order

1. Finish security corrections, independent Codex/Claude review, static analysis, tests and builds at an exact source revision. Fresh PR checks apply to that revision; baseline green checks do not approve dirty code.
2. Present the final exact release diff, public identities, native exposure and unsigned acceptance packet for owner approval. This plan does not authorize spending or deployment.
3. After approval, prepare a separate unarmed Baal installation under `/home/clement/.local/share/ophis-broadcaster-56`, Compose project `ophis-broadcaster-56`, private state/secrets and its own Waku relay/cache. Use a distinct loopback Waku port. Verify chain/operator-bound journals and owner pins before manual unlock. Keep `OPHIS_BROADCASTER_ENABLED=0`.
4. Guard creation requires the separate owned chain56 approval record with gasFundingApproved=true, matching operator, nonce-zero predicted guard, delegate/runtime and approved financial limits. The proposed approval currently says false. Normal BNB sponsorship/retry/cancel remains gated. Read-only constructor estimation passed: 364662 gas, padded limit437595; at a proposed1gwei cap the maximum is0.000437595BNB, below the proposed0.0005BNB deployment ceiling. These are proposals, not approved or current quotes. Re-estimate immediately before approval/signing.
5. Qualify the no-membership, no-tip 48Club private bundle route with bounded owner-approved tests: actual type4 success; known revert exclusion; state-valid-before/state-invalid-after ordered bundle exclusion; immutable retry/expiry; deployment/cancellation and canonical receipt/nonce accounting. A bundle acknowledgment alone is not inclusion evidence. No public fallback, automatic fee increase or new subscription is authorized. Local modeled0.05gwei is not a qualified builder floor. Define the aggregate worst-case budget from the exact signed limits before requesting funds; never silently raise a cap for inclusion.
6. Verify real Waku admission, full-history fee spendability, exact receipt commitment, user swap and stable withdrawal, restart/timeout/retry/nonce recovery, backups and restore. Verify every charge against the full signed gas ceiling plus margin. Only then propose the reviewed BNB signing-gate/allowlist activation, with a review expiry and exact deployment/image hash, for owner approval.

A user fee is paid during successful execution while the operator pays native gas onchain. The native reserve is working capital. Private delivery filtering must be proven on the actual service; an included outer revert can still charge the operator without paying its private fee. No zero-loss guarantee follows from simulation, fork execution or source review.

Evidence root (off-repository): `/Users/scep/ophis-railgun-evidence/bnb-acceptance-20261105`. It contains public protocol artifacts, signed disposable fork transactions, historical standalone-proof attack controls, read-only mainnet readiness/constructor simulations and source-frozen review outputs. Production secrets and owner pins are excluded.
