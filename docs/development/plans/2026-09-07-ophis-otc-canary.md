# Ophis OTC — restricted ERC-20 canary preparation

Status: implementation in progress. Production writes remain disabled. The owner's instruction to continue development does not enable mainnet transactions.

Baseline: main `6b4341d1`, including the reviewed and deployed Milestone C/recovery/parser fixes and StorageEvent cleanup. No new contract, native ETH selector, or batching is needed for this slice.

## Controls being implemented

- A checked-in, initially empty wallet/pair policy with token-unit caps on both legs and an expiry. Entry limits cover approvals as well as create/fill. Admitted wallets retain cancel/revoke after the trading window closes. These are per-action UI limits, not aggregate exposure limits or restrictions on the immutable contract.
- Reuse the exact-intent preflight/simulation/submission pipeline. Check policy before preflight and immediately before the wallet call, against both current time and the verified block time. Remote read/write flags and an explicit canary build mode remain mandatory.
- Compare the wallet's current block with Ophis's independent Ethereum reader, with finite timeouts and freshness bounds. Use the independent reader for settlement reads, simulation, nonce, transaction identity and canonical receipts. Fork mode keeps stable instance IDs; mainnet uses a stable Ethereum domain so changing wallet transports cannot erase uncertainty.
- Production recovery checks a canonical receipt under the existing browser lock. An absent receipt or unresolved replacement retains the lock. Restored successful confirmations finish the current action; users reload to continue with refreshed state, including after an approval. Before signing, persist a unique attempt ID, exact requested nonce and intent fingerprint. Recover a missing hash only by verifying a supplied mined hash against that proof under the browser lock. No mainnet manual “dropped transaction” acknowledgement clears uncertainty.
- Clearly distinguish canary/fork UI, display limits, preserve exact approval/revocation and the existing accessibility behavior.

## Work and evidence

- [x] Empty-by-default policy and initial amount/account/expiry/recovery tests (19 pass).
- [x] Mainnet network/receipt adapters and negative tests.
- [x] Canary submission and restored-receipt regression tests.
- [x] Canary UI and production-disabled regression checks.
- [x] Final local verification: 49 suites / 395 tests pass, one optional network test skipped; typecheck, scoped lint and production build pass; six canary-mode browser flows pass on local Anvil. Semgrep: 125 rules / 46 files, zero findings. See `../../audit/otc-canary-review-2026-09-07.md` for findings, limitations and evidence.
- [ ] Scoped security review and fresh review of each merge slice; preserve the 400-line PR limit.
- [x] Record monitoring/rollback procedure and operator activation checklist in `../otc-canary-runbook.md`.
- [ ] Witness production flag propagation and rollback on the approved activation release.
- [x] Reconcile completed Milestone C checklist entries and close the obsolete secret-backed draft PR #1228.

## Activation remains a separate reviewed release

The checked-in policy intentionally contains no wallets or pairs and expires at zero. Before requesting production enablement, record the exact wallet addresses, approved pairs and caps, UTC expiry, final code/manifest reviews, current dependency dispositions, monitored failure thresholds and rollback evidence. Do not enable a production flag or submit a mainnet transaction during this preparation. Use only the keyless PublicNode endpoint for local fork setup; no Infura/private-provider credentials or funded mainnet wallets.
