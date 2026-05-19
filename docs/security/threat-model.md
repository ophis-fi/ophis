# Ophis threat model

**Status:** v1 (2026-05-20). Living document — update when the architecture, key custody, or attack surface changes materially.
**Authors:** ops + audit findings (cross-referenced)
**Methodology:** STRIDE per asset, with CIA × severity (Critical/High/Medium/Low/Info).

## Scope

Ophis is a fork of `cowprotocol/services` running a single live mainnet deployment on Optimism (chain 10). Frontend at https://ophis.fi. This document covers:

1. **On-chain assets**: solver-submitter EOA (`0xFB308397…bB5a` as of 2026-05-19 → mid-rotation 2026-05-20), partner-fee recipient Safe (`0x858f…CeF8`), protocol Safe (governance multisig).
2. **Off-chain assets**: rendered driver.toml with the substituted PK, Postgres orderbook state, OKX API credentials, CoinGecko API key, Cloudflare Tunnel credentials, Telegram bot token.
3. **Operating environment**: Mac mini in Clement's apartment (single host, FileVault-encrypted SSD), colima docker network, all services bound to 127.0.0.1, external access via Cloudflare Tunnel.
4. **Settlement signing path**: order → autopilot auction → solver quote → driver settle() → on-chain.
5. **eRPC consensus posture**: 3-upstream 2-of-3 consensus on critical read methods (fork-view-poisoning defense).
6. **Distribution paths**: GitHub repo, npm `packages/sdk`, https://ophis.fi.

Out of scope (handled elsewhere):
- The cowprotocol upstream code itself (treated as audited; deltas are tracked).
- Solidity contract logic of GPv2Settlement / AllowListAuthentication / VaultRelayer (audited upstream; see `docs/audits/`).

## Assets (CIA classification)

| Asset | Confidentiality | Integrity | Availability |
|---|---|---|---|
| Submitter EOA private key | **CRITICAL** | CRITICAL | High |
| Protocol Safe signers (3× Ledger) | CRITICAL | CRITICAL | High |
| Partner-fee Safe (cold) | High | CRITICAL | Medium |
| Postgres orderbook DB | Medium | High | High |
| OKX API credentials | High | Medium | Medium |
| Telegram bot token | High | Low | Low |
| Cloudflare Tunnel creds | High | High | High |
| eRPC consensus integrity | n/a | CRITICAL | High |
| Frontend signing path | n/a | CRITICAL | n/a |
| Partner-fee config (3 source-of-truth files) | n/a | CRITICAL | n/a |
| Mac mini host availability | n/a | n/a | HIGH |

"CIA": Confidentiality / Integrity / Availability. CRITICAL = direct loss-of-funds path.

## Trust boundaries

```
                       Internet
                          │
                  ┌───────┴───────┐
                  │  Cloudflare   │  ← trust: depends on CF control plane
                  │  Tunnel       │
                  └───────┬───────┘
                          │
                  ┌───────┴───────┐
                  │  Mac mini      │  ← trust: physical security of Clement's apartment
                  │  (scep user)   │       + FileVault key
                  └─┬────────────┬─┘
                    │            │
            ┌───────┴───┐    ┌───┴────────┐
            │  ophis-   │    │  colima    │  ← trust: separation between user accounts
            │  driver   │    │  (scep)    │       on the same host (Tier 1 isolation)
            │  user     │    │            │
            │ (0700)    │    │  Docker    │
            └─────┬─────┘    │  network   │
                  │          │  (internal)│
        PK file ──┘          └─┬────────┬─┘
                               │        │
                       ┌───────┴───┐ ┌──┴─────────┐
                       │ rpc-proxy │ │ driver +   │  ← trust: container-level isolation
                       │ (eRPC)    │ │ autopilot +│       (NOT a strong boundary on macOS)
                       │           │ │ orderbook  │
                       └─────┬─────┘ └────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────┴─────┐ ┌──────┴─────┐ ┌──────┴──────┐
        │publicnode │ │ tenderly   │ │ 1rpc        │  ← trust: 2-of-3 consensus
        │ (CF DNS)  │ │ (Google)   │ │ (CF DNS)    │       not poisoning, fail-closed
        └───────────┘ └────────────┘ └─────────────┘
```

## STRIDE per critical asset

### 1. Submitter EOA private key

| STRIDE | Threat | Likelihood | Impact | Mitigations |
|---|---|---|---|---|
| **S**poofing | Attacker generates a colliding key | Negligible | Critical | secp256k1 |
| **T**ampering | PK modified in-place by malicious scep process | Low (Tier 1 + ophis-driver isolation) | Critical | File mode 0600 owner ophis-driver; rendering reads via sudo; chmod-600 enforced at render time |
| **R**epudiation | n/a | — | — | — |
| **I**nformation disclosure | PK exfiltrated from rendered driver.toml on SSD | Medium (Tier 1) → Low (Tier 1.5 RAM-disk, PR #140) → Negligible (Tier 2 KMS, deferred) | Critical | Tier 1.5 RAM-disk write (no SSD trace); EOA rotation procedure (founder-bus-factor.md §4.2) |
| **I**nformation disclosure | PK exfiltrated from running container memory via `docker exec` or `lldb -p` | **Medium** | Critical | NOT MITIGATED by Tier 1.5. Only Tier 2 KMS closes this. The 2026-05-20 incident exploited exactly this path (`docker exec ... grep account /driver.toml`). |
| **I**nformation disclosure | PK exfiltrated from Time Machine backup of pre-Tier-1.5 state | Medium | Critical | Tier 1.5 prevents NEW persistence; old snapshots/backups require `tmutil deletelocalsnapshots` + EOA rotation. |
| **D**enial of service | PK file deleted / corrupted | Medium | High (loss of settlement capability ≠ loss of funds) | Submitter PK backup runbook (`docs/operations/submitter-pk-backup-runbook.md`); USB stick + offline retention |
| **E**levation of privilege | Compromised scep process bypasses ophis-driver isolation | Medium | Critical | Tier 1 file isolation (0700 home + 0600 file); ophis-driver has no shell (`UserShell /usr/bin/false`); sudo audit |

**Net residual:** the live-runtime exfiltration path (memory / `docker exec`) is **OPEN**. Tier 2 KMS is the only complete remediation.

### 2. Settlement signing path

| STRIDE | Threat | Likelihood | Impact | Mitigations |
|---|---|---|---|---|
| **T**ampering | Hostile RPC upstream serves forged eth_call → driver signs settlement against forged state | Medium (single CF compromise) | Critical | **eRPC 2-of-3 consensus** with `disputeBehavior: returnError` + `lowParticipantsBehavior: returnError` + no `ignoreFields`. Defeats single-upstream poisoning. |
| **T**ampering | Multi-upstream consensus collusion via shared CDN/DNS | Low → **closed** post-Codex-retro-audit 2026-05-20 (PR moved to 3-of-3 requiring the non-CF tenderly anchor to agree) | Critical | `agreementThreshold: 3` — every upstream must agree on every consensus-protected read. The non-CF tenderly anchor blocks 2-of-3 CF-collusion attacks (forces a dispute → returnError → fail-closed). Pre-fix the 2-of-3 threshold was exploitable: if 2 CF-fronted upstreams returned the same forged view, they reached quorum and the poison was authoritative. |
| **T**ampering | Submission RPC (publicnode-direct) leaks signed calldata pre-broadcast to private searcher | Medium | Medium (gas-only MEV extraction, not direct fund loss) | NOT YET MITIGATED. Roadmap: add 2nd submission mempool (Conduit private or OP Foundation) racing on broadcast. |
| **T**ampering | Submitter EOA signs a settlement that drains pre-approved VaultRelayer allowances | Low (only post-PK-compromise) | Critical | Daily fund-cap on submitter (0.02 ETH); `addSolver` allowlist controlled by 2-of-3 Safe |
| **T**ampering | Partner-fee recipient drift across 3 sources of truth | Low (with PR #120's drift-test) | Medium | 3 source-of-truth files now share a hardcoded-literal cross-file invariant via jest tests in 3 workspaces (PR #120). Not a strong drift-prevention mechanism (still relies on author updating all 3); a CI gate that scans for divergence would be stronger. |
| **R**epudiation | Solver disputes whether a settlement was authorized | n/a | n/a | Every settlement signed by `submitter EOA → on-chain Settled event`; Postgres `solver_competitions` row pins the rationale. |
| **D**enial of service | eRPC fail-closed under low-participants → no settlement broadcasting | Medium (free-tier rate-limit blips) | Medium (no on-chain loss; auction restarts cleanly) | Accepted trade-off. Alert at >50% consensus failure for 5min (PR #142). |
| **D**enial of service | Single submission RPC (publicnode) goes down | Medium | Medium | Manual config swap in `driver.toml.tmpl` `[[submission.mempool]]`; ETA ~10 min |

### 3. Partner-fee economic model (CIP-75)

| STRIDE | Threat | Likelihood | Impact | Mitigations |
|---|---|---|---|---|
| **T**ampering | Recipient address in appData diverges from the Safe — fees drain to wrong addr | Low | High (lost rebate revenue) | PR #120's drift-test across 3 source-of-truth files; literal-pinning in jest |
| **T**ampering | `priceImprovementBps` or `maxVolumeBps` set above CIP-75 limits | Low | High (regulatory/UX) | Settlement-level caps; CIP-75 spec at 2500bps / 50bps respectively |
| **T**ampering | EIP-712 appData replay across chains | Negligible | n/a | EIP-712 domain pins chainId; replay across OP↔Eth impossible |
| **D**enial of service | Partner-fee Safe loses 2/3 signers | Low | High (locked rebates) | `docs/operations/founder-bus-factor.md` §5.3 — 3 Ledger seeds, distinct storage |

### 4. Off-chain state (Postgres + secrets)

| STRIDE | Threat | Likelihood | Impact | Mitigations |
|---|---|---|---|---|
| **I**nfo disclosure | OKX API key exfiltrated from `.env` | Medium (FileVault-only protection) | Medium (caps at $150 free/mo) | `.env` chmod 600; no payment method on OKX dashboard caps financial exposure |
| **I**nfo disclosure | Postgres dump exfiltrated | Low | Low (no PII, only order metadata) | Local backups chmod 600; optional encrypted remote upload |
| **T**ampering | Postgres backup corrupted between runs (bit-rot) | Low | Medium (failed DR restore) | `pg_restore --list` post-validation (PR #141); quarterly restore-test (manual) |
| **T**ampering | OKX HMAC accidentally leaked in chat/commit | **Medium** (recent precedent — see KEY-INCIDENTS) | Medium | feedback_never_grep_pk_from_rendered_configs.md memory; render-configs.sh `set -x` refuse; chmod 600 on rendered files |
| **D**enial of service | Mac mini fails | Medium | HIGH (single SPOF) | Disaster recovery runbook (`docs/operations/disaster-recovery-runbook.md`); no live secondary today |
| **D**enial of service | CoinGecko key rate-limited | Medium | Low (autopilot falls back) | Free tier 30 req/min — well above current load |

### 5. Frontend signing path

| STRIDE | Threat | Likelihood | Impact | Mitigations |
|---|---|---|---|---|
| **T**ampering | XSS in IntentInput → injected appData | Low | Medium | onPaste sanitizer (PR's pre-existing); onDrop sanitizer added in PR #129; CSP at edge |
| **T**ampering | Compromised npm dependency in cowswap-frontend → wallet-signing hijack | Medium | Critical | `pnpm audit` + Dependabot; `cargo audit` for backend equivalent (PR #96 baseline clean) |
| **T**ampering | https://ophis.fi DNS hijack | Low | Critical | Cloudflare DNSSEC + CAA; bookmark / hardware-wallet sanity-check on settlement signatures |
| **I**nfo disclosure | useTier silently leaks every connected wallet to rebates.ophis.fi | Closed by PR #126 | n/a | Opt-in localStorage gate |

### 6. eRPC consensus posture (detailed)

| Attack | Possible? | Mitigation |
|---|---|---|
| Single hostile upstream forges `eth_call` | No (2-of-3 disputes → returnError) | strict-consensus methods list |
| 2 hostile upstreams collude | Yes if both compromised | distinct failure domains; CF control-plane = nation-state |
| All 3 upstreams down | Yes (CF outage) | lowParticipantsBehavior: returnError → driver stops, NOT poisoned |
| Network eclipse of Mac mini | Yes (LAN attacker) | TLS certificate pinning by Go stdlib in eRPC; CA compromise = nation-state |
| eRPC config tampering | Low (file mode 0600; chmod-enforced at render) | YAML on FileVault disk; same threat model as orderbook.toml |

## Key incidents & lessons

| Date | Event | Lesson | Memory file |
|---|---|---|---|
| 2026-05-17 | EIP-55 non-canonical address crashed frontend on init | Run `cast to-check-sum-address` on every new addr before commit | feedback_eip55_check_new_addresses.md |
| 2026-05-17 | OKX HMAC leaked in chat | Rotate API keys regularly; never paste creds | feedback_dont_assume_paid_subscriptions.md (related) |
| 2026-05-18 | Codex Cyber finding #1 — `ignoreFields: [timestamp]` allowed forged-timestamp consensus | Strict equality in consensus; no `ignoreFields` for security-relevant methods | (inline comment in HL erpc.yaml) |
| 2026-05-19 | Phase 3+4 audit — partner-fee recipient drift across 3 files for MegaETH+HL | Cross-file invariants need test enforcement at minimum (PR #120) | (inline in PR #120 commit) |
| **2026-05-20** | **Live driver-submitter PK literal dumped to Claude transcript via `docker exec ... grep /driver.toml`** | **Never grep / cat / docker-exec rendered files containing PK; use on-chain queries instead** | feedback_never_grep_pk_from_rendered_configs.md |

## What's broken / partially-mitigated (honest list)

1. **Tier 2 KMS not deployed** — driver PK still on local file (Tier 1.5). Live-runtime exfiltration via `docker exec` or `lldb -p` remains open. Estimate: $140/yr AWS, ~1 week implementation.
2. **No live secondary host** — Mac mini SPOF. DR runbook documents the recovery procedure but recovery time is 2-4 hours best case, 24h worst case.
3. **Single submission mempool** — driver still submits via direct publicnode. MEV leakage of in-flight signed calldata is theoretical but possible. 2nd mempool (Conduit private) or OP Foundation private mempool would close this.
4. **GitHub Actions billing block** — CI is failing in 4-6 seconds on every PR. No automated regression gate. Billing must be restored at https://github.com/organizations/ophis-fi/settings/billing.
5. **No live backup-restore drill** — Postgres backup automation shipped (PR #141) but never tested via full restore.
6. **No live disaster-recovery drill** — DR runbook exists; never executed.
7. **Codex Cyber unavailable for some PRs** — PR #130 + #142 ran sharp-edges×2 only. Codex auth/runtime stability needs verification before next audit-gated PR.

## Roadmap to close residuals (priority order)

| # | Item | Effort | Cost | Closes |
|---|---|---|---|---|
| 1 | Tier 2 AWS KMS for submitter signing | ~1 week | $140/yr | live-runtime PK exfil; Tier 1.5 residual |
| 2 | Restore CI billing + verify all PRs gate on real CI | ~30 min | depends on bill | CI gap, audit gate weakening |
| 3 | Add 2nd submission mempool (Conduit private) | ~1 day | $0 (free with Conduit OP node) | MEV pre-broadcast leakage |
| 4 | Live restore drill — restore yesterday's pg dump to scratch DB | ~30 min | $0 | unverified backup chain |
| 5 | Full DR drill — bring stack up on a 2nd Mac / cloud VPS | ~2 hours | $0 (one-time) | unverified DR runbook |
| 6 | CI lint: cross-workspace partner-fee literal invariant check | ~2 hours | $0 | recurring PR #120-style drift bugs |
| 7 | Move telegram-token to env-var-encrypted secrets manager | ~1 hour | $0 | local-disk token persistence |

## Update process

This document MUST be updated when:
- A new asset is added to scope (new chain deploy, new key custody scheme)
- An incident occurs that reveals a previously-uncatalogued attack surface
- A mitigation is added that materially closes a documented residual

Update process:
1. Open a PR titled `docs(security): threat-model — <delta>`
2. Run sharp-edges audit on the diff (the doc itself can have sharp edges)
3. Cross-reference in `SECURITY.md`'s audit-history table
4. Tag with date and PR number in the relevant section
