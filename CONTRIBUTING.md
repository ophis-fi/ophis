# Contributing to Ophis

Thanks for your interest in Ophis. This document is the **operational** contract for working in this repo — what gets reviewed, what gets shipped, and what gates exist between a branch and main.

## Repo layout TL;DR

| Path | What |
|---|---|
| `apps/backend/` | Rust services (autopilot, driver, orderbook, solvers). Fork of cowprotocol/services with Ophis additions. |
| `apps/frontend/` | TS/React frontend. Fork of cowprotocol/cowswap with Ophis additions in `apps/cowswap-frontend/src/ophis/`. |
| `contracts/` | Foundry workspace for the GPv2Settlement / Authentication / VaultRelayer fork. |
| `infra/optimism-mainnet/` | Live OP mainnet stack (docker-compose). |
| `infra/hyperevm-mainnet/` | HL contracts deployed, stack paused. |
| `infra/megaeth-mainnet/` | MegaETH contracts deployed, stack paused. |
| `infra/shared/` | Cross-stack ops (cron jobs etc.). |
| `docs/` | Architecture, audits, operations runbooks, specs, brand. |
| `packages/sdk/` | Public TypeScript SDK for partner-fee integrations. |

Don't restructure these paths without prior alignment — they're referenced by deploy scripts, runbooks, and audit docs.

## Development setup

### Backend (Rust)

```bash
cd apps/backend
cargo check                # validate workspace
cargo test -p <crate>      # run a specific crate's tests
cargo clippy --all-targets # lint
cargo audit --no-fetch     # CVE check against advisory-db
cargo deny check           # license + bans + sources
```

Workspace targets a stable Rust toolchain (see `rust-toolchain.toml` if present, otherwise latest stable).

### Frontend (TS, pnpm workspace via Nx)

```bash
cd apps/frontend
pnpm install
npx nx test cowswap-frontend                                   # all tests
npx nx test cowswap-frontend --testPathPattern="<glob>"        # subset
```

941+ tests today. Don't merge a PR that regresses below the count on main.

### Contracts (Foundry)

```bash
cd contracts
forge build
forge test
forge fmt --check
slither src/                                          # static analysis
```

Echidna properties live in `contracts/echidna/` — extend them when adding new invariants, don't write throwaway property tests.

## Branch + PR hygiene

- **Branch names**: `fix/<short-slug>`, `feat/<short-slug>`, `docs/<short-slug>`, `chore/<short-slug>`. Prefix matches the conventional-commit `type:` you'll use in the title.
- **PR titles**: conventional commits. Example: `fix(driver): close panic in settlement state-machine on recover_owner failure`.
- **PR scope**: one concern per PR. Test fixes + behavior changes go in separate PRs. Refactor + feature go in separate PRs. Mass renames go alone.
- **PR description**: include risk assessment (production / docs-only / test-only), test plan, and rollout instructions if the change touches mainnet infra.
- **PRs against mainnet code or signing paths**: see "Audit gate" below.

## Audit gate (mandatory for some changes)

Per `feedback_audit_mainnet_contract_wiring` (an internal operating rule, captured here so external contributors see it too): any PR that deploys a mainnet contract OR wires frontend signing OR changes the eRPC consensus posture OR touches the driver-submitter PK custody path REQUIRES **two independent reviewers** before merge:

1. **Codex Cyber** (gpt-5.x with trusted-cyber early-access) — invoked via `codex exec` or the second-opinion MCP tool.
2. **`sharp-edges-analyzer`** — agent that catches API-misuse / footgun patterns.

If Codex is unavailable, the rule allows **two parallel sharp-edges runs at different focus levels** as a fallback, but this MUST be disclosed in the PR description.

Reviewers' findings get applied in-PR before merge. PR #130 (OP eRPC clone) is the reference example — the two-reviewer audit caught a Cloudflare-DNS overlap and triggered an upstream swap pre-merge.

Test-only PRs, pure docs PRs, and FE polish PRs (mobile UX, error-message text, etc.) are out of scope for the audit gate — these merge on local-test green + 1 reviewer (or self-review for solo operators).

## Style + conventions

- **Commits**: conventional commits enforced by humans, not by hook. Subject ≤72 chars; body explains "why" not "what".
- **No emojis in code or commits.** Emoji-free unless explicitly requested.
- **No new markdown docs unless asked.** Don't litter the repo with READMEs.
- **Comments**: explain non-obvious WHY only. No "// loop over array" type narration.
- **Rust**: stable toolchain. No `unwrap()` outside tests and bootstrap. No `expect()` without a message that names the invariant.
- **TS/React**: `null` for "deliberately absent", `undefined` for "not yet set." TanStack Query / Jotai patterns where they already exist.
- **YAML / TOML**: comments explain operational consequences, not syntax.

## Testing expectations

- **Settlement-critical Rust paths** require integration tests under `apps/backend/crates/e2e/` that exercise the full driver→solver→settlement cycle. PRs touching `driver::infra::solver::*` or `autopilot::run_loop` without e2e coverage will be flagged.
- **Frontend partner-fee / signing code** requires unit tests that pin the partner-fee recipient literals. Three "sources of truth" exist (`feeRecipient.ts`, `partnerFeeDefault.ts`, `packages/sdk/partner-fee.ts`) and silent drift between them is a real-incident risk (see PR #120).
- **Contracts**: forge tests + at least one Echidna property when adding new state machines.

## CI

GitHub Actions runs:
- `Rust CI` — fmt + clippy + test (`apps/backend/`)
- `Frontend CI` — lint + test + build (`apps/frontend/`)
- `Contracts CI` — forge build + test + slither
- `Security CI` — cargo audit + cargo deny + slither + frontend-deps audit
- `Deploy to Cloudflare Pages` — deploys docs site preview

**Known issue (as of 2026-05-20):** the org GitHub Actions billing is currently failing → CI runners refuse to start → every PR shows red CI in 4-6 seconds. This is a billing issue, not a code issue. PRs are merging on local-test + agent-review until billing is restored.

## Security disclosure

See `SECURITY.md` for the responsible-disclosure policy. **Do not open public GitHub issues for security-impacting reports.**

## Project memory

The repo is maintained by Clement Fermaud (CMO Aleph Cloud, CEO Commit Media). Operating context, prior decisions, and roadmap live in:

- `docs/architecture/` — architecture decisions records (ADRs)
- `docs/audits/` — audit-finding synthesis docs
- `docs/operations/` — operational runbooks (PK custody, backups, DR, eRPC)
- `docs/development/` — specs + plans (some historical references stale; see PR #138 for the EOA canonicalization note)

If a runbook says something that contradicts the current code state, fix the code-state OR fix the runbook, don't ignore the contradiction.
