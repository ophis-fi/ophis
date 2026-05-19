# Phase 3 (frontend) + Phase 4 (OP infra) audit synthesis

**Date:** 2026-05-19
**Reviewers:** `sharp-edges-analyzer` × 2 (separate L + M passes; Codex Cyber CLI was unavailable today)
**Scope:**
- **L (frontend)**: Ophis-specific additions in `apps/frontend/` — the `src/ophis/` subdir, `cow-fi/` rebrand, partner-fee SDK config. Upstream CoW FE code excluded.
- **M (infra)**: OP-mainnet operational config + secret rendering + cron. HL paused per 2026-05-19 pivot, excluded.

**TL;DR — 6 HIGH, 8 MED, 6 LOW across both audits.** One of the MED (M-1) was in the K PR I had just opened — fixed in commit `8dc3b48d0` on `feat/safe-drift-check`. Everything else needs Sprint 5/6 PR work, no automatic action taken.

---

## Phase 3 (frontend) — HIGH findings

### H1 — Partner-fee recipient drift across 3 "sources of truth"
`apps/frontend/libs/common-const/src/feeRecipient.ts:3-11` vs `apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts:26,55` vs `packages/sdk/src/partner-fee.ts:23-24`.

Three files map chainId → partner-fee recipient. They DISAGREE for MegaETH (4326) and HyperEVM (999):

| Chain | `feeRecipient.ts` | `partnerFeeDefault.ts` |
|---|---|---|
| OP (10) | `0x858f…CeF8` ✅ | `0x858f…CeF8` ✅ |
| MegaETH (4326) | `0x22af…2A76` (CoW default!) | `0x858f…CeF8` |
| HyperEVM (999) | `0xe049…01cF` (protocol Safe!) | `0x858f…CeF8` |

If MegaETH ever resumes settling, fees from the `volumeBps` path leak to `0x22af…2A76` (a CoW DAO default address), while the `priceImprovementBps` path correctly routes to `0x858f…CeF8`. HyperEVM has the same problem — and `0xe049…01cF` is the *protocol* Safe (governance), not the partner-fee recipient.

**Sprint 5 PR:** Add a jest test asserting `feeRecipient.ts` matches `partnerFeeDefault.ts` for every CoW chain. Reconcile MegaETH + HL entries. Two reviewers (Codex + sharp-edges) before merge per `feedback_audit_mainnet_contract_wiring.md`.

### H2 — Address literals not EIP-55 validated; could crash FE on init
The Ophis default constants are typed `as const`; never validated. Per `feedback_eip55_check_new_addresses.md` (2026-05-17 incident), Viem strict EIP-55 crashes the frontend at init when an address is non-canonical. Two of the three literals in `feeRecipient.ts` look non-canonical by inspection — needs `cast to-check-sum-address` round-trip.

**Sprint 5 PR:** add a jest assertion that calls Ethers `getAddress()` on every address literal at SDK build time. Fails the build on non-canonical case.

### H3 — `injectedWidgetAppDataPartnerFeeAtom` emits partner-fee on unsupported chains
`apps/frontend/apps/cowswap-frontend/src/modules/injectedWidget/state/injectedWidgetParamsAtom.ts:31-35`. Returns `OPHIS_DEFAULT_APP_DATA_PARTNER_FEE` unconditionally regardless of chain. An order signed on a non-CoW chain (e.g. a future test chain) embeds `recipient = 0x858f…CeF8` in appData. Irrelevant for settlement (no settlement on non-CoW chains) but pollutes data + risks attribution drift.

**Sprint 5 PR:** gate the atom on `COW_SUPPORTED_CHAIN_IDS.has(chainId)`; return `undefined` otherwise. Mirror the existing `ophisDefaultPartnerFee(chainId)` SDK helper logic.

## Phase 3 — MED findings (defer; document)

- **M1 (privacy)**: `useTier` hits `rebates.ophis.fi/tier/${wallet}` on every page load without opt-in.
- **M2 (silent failures)**: `useSettlementTxHash` swallows all errors → indistinguishable from "not yet settled". No Sentry breadcrumb.
- **M3 (silent failures)**: `useIntentParse` masks 401/403/500 as `UPSTREAM` because it `json()` before checking `res.status`.
- **M4 (XSS)**: `IntentInput` contenteditable sanitizes paste but not drag-and-drop.

## Phase 3 — LOW findings

- **L1**: revalidate route uses non-constant-time string compare for secret.
- **L2**: `TierChip` renders unvalidated JSON; could crash on `.toLocaleString` of `null`.
- **L3**: `OPHIS_SUPPORTED_CHAINS` in `useSettlementTxHash.ts` is hard-coded `[10]` (drift risk).

---

## Phase 4 (OP infra) — HIGH findings

### H1 — Stale rendered `driver.toml` on `scep`'s filesystem with submitter PK
`infra/optimism-mainnet/rendered/driver.toml:35,46,57,75` — 64-hex PK literal on disk under `scep` ownership. The Tier 1 PK isolation (per `2026-05-18-submitter-pk-custody-adr.md`) was supposed to keep the rendered output under `/Users/ophis-driver/...` — half-done.

Threat model: any compromise of user `scep` (browser extension, npm postinstall, malicious VS Code extension) reads the rendered file → defeats Tier 1 isolation.

**Sprint 6 PR:** patch `render-configs.sh` to write rendered TOMLs under `/Users/ophis-driver/rendered/optimism-mainnet/`, not `./rendered/`. The script header at `render-configs.sh:7-9` already documents the intent — implementation at lines 48, 55-58 still writes to `./rendered/`. Delete the stale file after migration.

### H2 — `render-configs.sh` lacks `umask 077`; brief world-readable window
The `envsubst > out` writes the rendered file at default macOS umask 022 → 0644. The subsequent `chmod 600` tightens it, but there's a microsecond window where a process watching the dir could `open()` the file. The fix is one line — prepend `umask 077` to the script, matching the pattern already in `safe-drift-check.sh:14`.

**Sprint 6 PR:** one-line fix.

### H3 — `.env` has live OKX HMAC + CoinGecko + Postgres password in cleartext
`.env.example` claims OKX credentials live in Keychain; the live `.env` has them rendered out. Same threat model as H1. Plus `COINGECKO_API_KEY` is in `.env` but missing from `.env.example` → fresh operator won't know to set it.

**Sprint 6 PR:** decide on the OKX cred source-of-truth (Keychain OR `.env`), make it ONE story, update `.env.example` to match.

## Phase 4 — MED findings (defer; document)

- **M-1**: Safe drift check ships with placeholder addresses (`0x...ledger2`). **Fixed** in PR #117 commit `8dc3b48d0` — pre-flight guard rejects placeholders.
- **M-2**: OP has no eRPC — single-RPC dependency, no fork-poisoning resistance. Clone HL's eRPC pattern over to OP.
- **M-3**: Driver `gas-price-cap = 1000 gwei` is meaningless (OP typical is 0.01 gwei). Tighten to 5 gwei.
- **M-4**: `disable-access-list-simulation = true` ships disabled (alloy bug workaround). Re-enable once M-2 lands and the eRPC normalizes responses.
- **M-5**: Driver healthcheck is TCP-listener-only. Wire `/health` endpoint or Prom scrape.

## Phase 4 — LOW findings

- **L-1**: Cloudflared lacks `originRequest` hardening (timeouts, http2Origin).
- **L-2**: Drift-check log file inherits umask 022 → world-readable.
- **L-3**: Telegram token file lives in HL-mainnet dir (cross-stack dep); move to `infra/shared/observability-rendered/`.

---

## Suggested Sprint 5 + Sprint 6 PR sequence

### Sprint 5 (frontend) — 2 PRs

1. **PR-S5-01** — H1+H2 partner-fee invariant + EIP-55. Jest tests + reconcile MegaETH/HL entries.
2. **PR-S5-02** — H3 chain-gate the appData partnerFee atom. Playwright test.

### Sprint 6 (infra) — 3 PRs

3. **PR-S6-01** — H1 finish Tier 1 PK isolation. Move rendered TOMLs under `/Users/ophis-driver/...`.
4. **PR-S6-02** — H2+H3 `umask 077` + reconcile OKX/CoinGecko source-of-truth.
5. **PR-S6-03** — M-2 OP eRPC. Clone HL's `erpc.yaml.tmpl` pattern.

Both sprints under Codex Cyber + sharp-edges parallel review before merge, per `feedback_audit_mainnet_contract_wiring.md`. Non-negotiable for mainnet-touching changes.

## What this audit DID NOT cover

- **CoW upstream FE** — out of scope (CoW DAO audits their own code).
- **HL infra** — paused 2026-05-19; revisit if resumed.
- **MegaETH infra** — paused 2026-05-18; same.
- **Cross-chain rollover invariants** — that was the Phase 5 audit scope; HL+MegaETH being paused makes Phase 5 mostly out-of-scope. Revisit when more chains are operational.
- **Contracts** — Phase 1 audit covered HL contracts on 2026-05-17; OP contracts deployed 2026-05-13 with cast-verified bytecode parity. Not re-audited today.

## Files referenced

See L + M agent outputs above (in PR description) for the full file lists.
