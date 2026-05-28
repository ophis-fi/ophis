<!--
Thanks for contributing to Ophis. Before opening: please skim CONTRIBUTING.md — it's the operational contract for what gets reviewed and what gates exist between a branch and main.
-->

## Summary

<!-- 1-3 sentences: what changed and why. Link to the issue if applicable: Fixes #123 -->

## Scope

<!-- Tick all that apply -->

- [ ] Frontend (apps/frontend)
- [ ] Backend (apps/backend, Rust)
- [ ] Contracts (Solidity, on-chain)
- [ ] SDK (@ophis/sdk)
- [ ] Rebate indexer / partner-fee API
- [ ] Intent API (functions/api/intent)
- [ ] Docs (docs.ophis.fi)
- [ ] Infra / deploy
- [ ] CI / repo housekeeping

## Test plan

<!-- How you verified this works. Include commands run + their outputs, screenshots for UI, or links to test logs. -->

- [ ] Unit/integration tests added or updated where appropriate
- [ ] `pnpm typecheck` / `cargo check` / `forge build` pass locally
- [ ] Manual smoke-test against the relevant chain/runtime

## Security implications

<!-- For changes that touch contracts, signing, allowlists, partner-fee math, or anything that handles user funds: -->

- [ ] No new attacker-controlled input reaches privileged code
- [ ] No new signing/approval surface added without justification
- [ ] Partner-fee math invariants preserved (if touched)
- [ ] Audit-doc impact noted in `docs/audit/` (if material)

## Deployment notes

<!-- Anything reviewers/operators need to know post-merge: env-var changes, migration steps, contract redeploys, infra config. Leave blank if N/A. -->
