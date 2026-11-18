# Review reports

Dated security reviews, differential reviews and release assessments for Ophis.
Each report records a particular scope and code snapshot. Findings and release
conditions describe that snapshot; use current code, CI and operational runbooks
for the present deployment state.

Reports previously stored at the repository root, `docs/audit/` and as Markdown
in `audit/` are collected here. They cover distinct changes and are retained as
historical evidence. The root [`audit/`](../../audit) directory contains
machine-readable scan baselines and verification data used by tooling.

For vulnerability disclosure, see [SECURITY.md](../../SECURITY.md).

| Date       | Report                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-17 | [Picomatch advisory review](picomatch-GHSA-fc5q-2026-11-17.md) |
| 2026-11-09 | [Public native prepayment — implementation and release review](2026-11-09-public-native-prepayment.md)                   |
| 2026-11-09 | [Ethereum and BNB prepaid broadcaster — release overview](2026-11-09-prepaid-release-review.md)                          |
| 2026-11-07 | [Owner broadcaster release review — 7 November 2026](2026-11-07-owner-broadcaster-release-review.md)                     |
| 2026-11-06 | [Private token support and native BNB withdrawal review](2026-11-06-private-token-and-native-withdrawal-review.md)       |
| 2026-11-06 | [BNB native fees, bound withdrawals and commissioning review](2026-11-06-bnb-fees-and-withdrawal-review.md)              |
| 2026-11-05 | [RAILGUN dependency gate and acceptance update](2026-11-05-railgun-gate-and-acceptance-update.md)                        |
| 2026-11-05 | [RAILGUN broadcaster and private-flow final source review](2026-11-05-railgun-final-source-review.md)                    |
| 2026-11-05 | [BNB candidate submission review and commercial constraints](2026-11-05-railgun-bnb-submission-review.md)                |
| 2026-11-03 | [Review of security PRs #1623, #1624 and #1626](OPHIS_DIFFERENTIAL_REVIEW_2026-11-03.md)                                 |
| 2026-11-03 | [Dependabot sweep: 2026-11-03](dependency-review-2026-11-03.md)                                                          |
| 2026-11-01 | [Release dependency review — 2026-11-01](dependency-review-2026-11-01.md)                                                |
| 2026-10-20 | [Direct liquidity add-ons: security review](2026-10-20-liquidity-addons-review.md)                                       |
| 2026-10-07 | [Dependency follow-up review: 2026-10-07](dependency-review-2026-10-07.md)                                               |
| 2026-10-04 | [Ophis website review — 2026-10-04](website-review-2026-10-04.md)                                                        |
| 2026-10-04 | [Dependency and review-gate assessment — 2026-10-04](dependency-review-2026-10-04.md)                                    |
| 2026-09-27 | [Public content audit — September 27, 2026](public-content-audit-2026-09-27.md)                                          |
| 2026-09-17 | [Ophis security audit — 2026-09-17](security-audit-2026-09-17.md)                                                        |
| 2026-09-09 | [Ophis mobile swap security differential review — 2026-09-09](OPHIS_MOBILE_SWAP_DIFFERENTIAL_REVIEW_2026-09-09.md)       |
| 2026-09-07 | [OTC canary preparation review — 2026-09-07](otc-canary-review-2026-09-07.md)                                            |
| 2026-09-06 | [Ophis OTC expanded security review — 2026-09-06](otc-expanded-security-review-2026-09-06.md)                            |
| 2026-09-06 | [OTC Milestone C final review — 2026-09-06](otc-milestone-c-final-review-2026-09-06.md)                                  |
| 2026-08-21 | [Ophis OTC Milestone C — Differential Security Review](OPHIS_OTC_MILESTONE_C_DIFFERENTIAL_REVIEW_2026-08-21.md)          |
| 2026-08-21 | [Ophis OTC Milestone C — Application Security Review](OPHIS_OTC_MILESTONE_C_APPSEC_REVIEW_2026-08-21.md)                 |
| 2026-08-19 | [Ophis OTC Milestones A+B — Differential Review](OPHIS_OTC_DIFFERENTIAL_REVIEW_2026-08-19.md)                            |
| 2026-08-17 | [Ophis token-policy scope and chain-selector hotfix differential review](OPHIS_HOTFIX_DIFFERENTIAL_REVIEW_2026-08-17.md) |
| 2026-08-17 | [Ophis differential security review](OPHIS_DIFFERENTIAL_REVIEW_2026-08-17.md)                                            |
| 2026-08-07 | [Ophis Ekubo + UP33 Differential Security Review](OPHIS_DIFFERENTIAL_REVIEW_2026-08-07.md)                               |
| 2026-08-06 | [Optimism Uniswap V4 Differential Security Review](2026-08-06-optimism-uniswap-v4-differential-review.md)                |
| 2026-08-06 | [Ophis WOOFi Differential Security Review](OPHIS_WOOFI_DIFFERENTIAL_REVIEW_2026-08-06.md)                                |
| 2026-08-05 | [Ophis Differential Security Review](OPHIS_DIFFERENTIAL_REVIEW_2026-08-05.md)                                            |
| 2026-08-05 | [F(x) solver differential security review](2026-08-05-fx-differential-review.md)                                         |
| 2026-08-05 | [Curve Direct Solver Differential Security Review](2026-08-05-curve-differential-review.md)                              |
| 2026-08-03 | [Ophis pons Integration — Differential Security Review](OPHIS_PONS_DIFFERENTIAL_REVIEW_2026-08-03.md)                    |
| 2026-07-27 | [Security Review](SECURITY_REVIEW.md)                                                                                    |
| 2026-05-20 | [eRPC consensus mitigation audit — deferred findings](2026-05-20-erpc-consensus-audit.md)                                |
| 2026-05-20 | [Phase 4 final audit re-sweep — 2026-05-20](2026-05-20-phase-4-final-sweep.md)                                           |
| 2026-05-20 | [CIP-75 partner-fee: accumulates in Settlement, doesn't reach Safe](2026-05-20-cip75-partner-fee-bypass.md)              |
| 2026-05-19 | [Phase 3 (frontend) + Phase 4 (OP infra) audit synthesis](2026-05-19-phase3-frontend-and-phase4-infra.md)                |
| 2026-05-18 | [Session Handoff — 2026-05-18](2026-05-18-session-handoff.md)                                                            |
| 2026-05-18 | [Phase 2 Backend Audit — 2026-05-18](2026-05-18-phase2-backend.md)                                                       |
| 2026-05-14 | [Ophis OP Mainnet Audit — 2026-05-14](audit-report-2026-05-14.md)                                                        |
| 2026-05-14 | [Frontend OP Mainnet Wiring — Security/Correctness Review](frontend-op-mainnet-review-2026-05-14.md)                     |
| 2026-05-13 | [Ophis Finance — Security Audit Report 2026-05-13](audit-report-2026-05-13.md)                                           |
| 2026-05-13 | [KyberSwap Solver — Security/Correctness Review](kyberswap-review-2026-05-13.md)                                         |
| 2026-05-13 | [Clear Signing (ERC-7730) — Ophis Integration Assessment](clear-signing-assessment-2026-05-13.md)                        |
