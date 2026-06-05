# Ophis Security Hardening Roadmap

**Created:** 2026-06-04. **Owner:** Clement.
**Origin:** external security review (2026-06-04) plus the Cloudflare Security
Insights scan of the same date.
**Companion docs:** `./threat-model.md` (what a compromise can/cannot do),
`../../SECURITY.md` (disclosure), `../operations/founder-bus-factor.md` (ops).

This roadmap turns the threat model's known gaps into tracked, ordered work. It
is deliberately prioritized by **impact over effort**: P0 + P1 close the two
paths that can actually cost a user funds; P2 reduces the broad
liveness/MEV surface and adds detection.

## Sequencing rule

**P2 does not start until every P0 and P1 issue is closed and green.** The P2
issues carry the `blocked` label and reference the P0/P1 blockers
(#435 - #442). This keeps focus on the funds-theft surface before the
surface-reduction work.

## What is already in place (do not redo)

- `GPv2Settlement` and `GPv2VaultRelayer` are immutable (verified: no proxy).
  This caps the backend blast radius regardless of the items below.
- AllowList changes require the 2-of-3 hardware Safe; a rogue solver is
  evictable on-chain in one transaction.
- eRPC runs 2-of-3 consensus and fails closed.
- The driver API is loopback-only; only the orderbook is publicly reachable.
- Submitter hot-EOA carries a small float, not a treasury.
- `swap.ophis.fi` already sets HSTS via `_headers` (the CF scan flagged the
  tunnel hostnames and parked domains, not the main app).

---

## P0 - frontend / edge integrity (the one realistic user-funds-theft vector)

A compromised or supply-chain-poisoned frontend can make a user sign a
malicious order or token approval. The on-chain guarantees do not protect a
user who signs a bad authorization, so this tier is first.

| # | Action | Issue | Effort |
|---|---|---|---|
| P0.1 | Strict CSP + Subresource Integrity on all frontends | [#435](https://github.com/ophis-fi/ophis/issues/435) | low |
| P0.2 | Lock the Cloudflare Pages deploy pipeline (scoped token, protected branch, CI-only) | [#436](https://github.com/ophis-fi/ophis/issues/436) | low |
| P0.3 | Pin GitHub Actions to commit SHAs + lockfile integrity + dependency audit | [#437](https://github.com/ophis-fi/ophis/issues/437) | low |
| P0.4 | Reproducible build + published artifact hash (SLSA provenance) | [#438](https://github.com/ophis-fi/ophis/issues/438) | medium |
| P0.5 | Wallet signing-clarity review (readable EIP-712, anti blind-sign) | [#439](https://github.com/ophis-fi/ophis/issues/439) | low |
| P0.6 | Cloudflare edge: HSTS + Always Use HTTPS + Full(strict) + security.txt | [#440](https://github.com/ophis-fi/ophis/issues/440) | low |

## P1 - kill the highest-value host / governance gaps

| # | Action | Issue | Effort |
|---|---|---|---|
| P1.1 | Submitter key to remote signer / HSM with `settle()`-only policy | [#441](https://github.com/ophis-fi/ophis/issues/441) | medium |
| P1.2 | Timelock on AllowList upgrades + solver-set changes (Option A Guardian; contract + tests landed, on-chain migration pending Ledgers) | [#442](https://github.com/ophis-fi/ophis/issues/442) | medium |

## P2 - surface reduction + detection (BLOCKED until P0+P1 green)

| # | Action | Issue | Effort |
|---|---|---|---|
| P2.1 | Re-enable inter-service auth (F7) end-to-end | [#443](https://github.com/ophis-fi/ophis/issues/443) | medium |
| P2.2 | Settlement anomaly monitoring + alerting | [#444](https://github.com/ophis-fi/ophis/issues/444) | medium |
| P2.3 | Hardware-backed SSH keys + tighten Tailscale ACLs | [#445](https://github.com/ophis-fi/ophis/issues/445) | low |
| P2.4 | Cloudflare Tunnel hardening (Access/mTLS + rate-limit) + Bot Fight Mode | [#446](https://github.com/ophis-fi/ophis/issues/446) | low |
| P2.5 | eRPC consensus-failure alerting (keep fail-closed) | [#447](https://github.com/ophis-fi/ophis/issues/447) | low |

## P3 - governance and assurance (backlog)

- Upgrade the partner-fee Safe from 1-of-1 to 2-of-3 across all chains (OP,
  Gnosis, Ethereum). It is currently 1-of-1 on every chain (single signer,
  Clement's Ledger) per `../operations/founder-bus-factor.md`: the same blast
  radius as a hot wallet until the threshold is raised. Roadmap task 1.8.
- Add a second trusted operator with scoped access; run a tested cold-start
  dry-run of `founder-bus-factor.md` 7.
- External audit of the Ophis-specific diffs (two-step-manager AllowList impl,
  settlement wiring, FE `ophis/` paths) before scaling TVL, then a bug-bounty
  program (none today).

---

## Cloudflare Security Insights scan (2026-06-04)

All 40 findings were **Moderate or Low; zero High/Critical.** They are edge
configuration toggles, folded into P0.6 (HTTPS posture + security.txt) and P2.4
(Bot Fight Mode + tunnel hardening).

| Finding | Affected | Maps to |
|---|---|---|
| Missing HSTS / Always Use HTTPS / TLS Full(strict) | `ophis.fi`, `optimism-mainnet.ophis.fi`, `rebates.ophis.fi`, `mcp.ophis.fi`, `megaeth*.ophis.fi`, parked `ophis.xyz/.finance/.exchange`, plus `allo`/`crm`/`mcp-api.3615crypto.com` | P0.6 |
| `security.txt` not configured | `ophis.fi`, `ophis.xyz/.finance/.exchange`, `3615crypto.com` | P0.6 |
| Bot Fight Mode not enabled | `ophis.fi`, `ophis.xyz/.finance/.exchange`, `3615crypto.com` | P2.4 |
| DMARC record error | `3615crypto.com` | P3 (email; not Ophis-core) |
| AI Labyrinth / crawler controls | `3615crypto.com` | P2.4 |

**Dismissed as false positives:** the "missing TLS Encryption" findings on
`_dmarc.3615crypto.com` and `_domainconnect.3615crypto.com` are DNS-only TXT
records, not web hosts; the scanner probed port 80 and found no HTTPS, which is
expected. No action needed.

---

## Status tracking

Progress is tracked on the GitHub issues above and the project board. Update
this table's links if issue numbers change. When all of P0 and P1 are closed,
unblock the P2 issues (remove the `blocked` label) and begin that tier.
