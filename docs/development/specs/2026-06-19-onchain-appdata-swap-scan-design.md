# On-chain appData Swap Scan — Design

- **Date:** 2026-06-19
- **Status:** Draft (awaiting review)
- **Author:** Ophis eng (Claude-assisted)
- **Topic:** Exhaustive, allowlist-free reporting of Ophis swaps across all chains

## 1. Problem

The rebate-indexer attributes Ophis trades by polling CoW's `GET /api/v1/trades?owner=<wallet>`
once per **tracked** wallet (the `tracked_wallets` set: rebate-program enrollees). This is correct
for rebate accounting (you only pay enrolled wallets) but **structurally blind** to any Ophis trade
by a non-enrolled wallet on a CoW-hosted chain.

Concretely: on 2026-06-18 a trader ran the same WETH/ETH→USDT swap on Optimism *and* Ethereum
mainnet, ~7 minutes apart, both carrying `appCode: "ophis"`. The OP swap was visible (sovereign
orderbook Postgres is local and complete); the mainnet swap was invisible to our tooling because
that wallet is not tracked. The protocol earned a fee on a trade it could not see.

We need an **exhaustive** way to enumerate Ophis swaps in a time window across all chains, keyed on
the `ophis` appData rather than on a wallet allowlist.

## 2. Goals / Non-goals

### Goals
- Given a time window (e.g. `--since 48h`), list **every** Ophis swap on the covered chains —
  independent of whether the trader is enrolled in rebates.
- Self-hosted chains (OP; HL/MegaETH when serving) report from the **local orderbook Postgres**
  (complete, instant, free).
- Hosted chains report via **on-chain discovery + CoW API attribution**, working from any host.
- Output to terminal, a machine-readable JSON artifact, and (optionally) a Telegram DM.
- Honest coverage: every run states which chains succeeded, which degraded, and why.

### Non-goals (v1, YAGNI)
- **Not** an always-on service. This is an on-demand CLI.
- **Does not write to the rebate DB.** Read-only report; cannot affect payouts or enroll wallets.
- **No `settle()` calldata decoding** in v1 (see §9, deferred optimization).
- **Long-tail chains** (Gnosis, BNB, Linea, Plasma, Ink) are config stubs, wired later.
- Not a replacement for the rebate-indexer's owner-scoped fetch (that remains the payout source of truth).

## 3. Approach decision

Three discovery mechanisms were considered. Two are ruled out by investigation:

| Mechanism | Verdict | Reason |
|---|---|---|
| Scan ERC-20 `Transfer` to fee recipient `0x858f…ECeF8` | ❌ Rejected | The fee is retained as **surplus inside the Settlement contract** and swept later — there is **no** per-trade transfer to the recipient. Verified on the real mainnet Ophis settlement `0x5348…a8d1e`: exactly two ERC-20 transfers (0.041 WETH in, 69.93 USDT out to the trader), none to `0x858f…`. |
| Dune query `WHERE app_code = 'ophis'` | ❌ Rejected | No Dune API key available on the operator machine. (Revisit if a key is provisioned — it would be the cheapest source.) |
| **On-chain `getLogs(Trade)` + per-order appData resolve** | ✅ **Chosen** | The only path that is exhaustive (no allowlist) and self-contained. Reuses the indexer's existing `getOrder`→`appCode` resolution verbatim. |

**Why attribution is unavoidably per-order:** the CoW `Trade` event carries `orderUid` but not
appData; the Ophis identity lives *inside* the signed appData JSON (`appCode`/`partnerFee.recipient`),
which is committed only as a hash in the order — and the appData **hash varies per order** because
CoW's smart-slippage bakes a per-quote `slippageBips` into the JSON (observed: 50 on OP, 158 on
mainnet). So there is no single constant hash to filter on and no server-side `where appCode='ophis'`.
Discovery is necessarily wide (all CoW fills) and the filter narrow (the Ophis few).

## 4. Architecture

```
                  ┌─ self-hosted (OP) ───► local orderbook Postgres (docker exec psql)
 window --since 48h│                          join trades→orders→app_data, filter appCode ──┐
                  └─ hosted (mainnet/Base/    getLogs(Trade) @ 0x9008…ab41 ─► dedup uids    ├─► normalize ─► report
                     Arbitrum/Polygon/Avax)    ─► CoW getOrder(uid) ─► appCode∈{ophis,greg} ─┘   (terminal + JSON + Telegram)
                     via Alchemy RPC + CoW API
```

- Settlement contract address is the single constant `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`
  (same on every chain).
- `Trade` event topic0 = `0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17`
  (`Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)`).

## 5. Components

New module tree `apps/rebate-indexer/src/scan/`:

| Module | Responsibility | Depends on |
|---|---|---|
| `chains.ts` | Per-chain config: `{chainId, name, kind:'local-db'\|'rpc', rpcUrl?, dbContainer?, cowApiPath}`. Adding a chain = one entry. | env, keychain RPC |
| `window.ts` | Resolve `--since <dur>` to a UTC cutoff and, per rpc-chain, a `fromBlock` via timestamp **binary search** (viem `getBlock`). local-db chains use the timestamp directly. | viem |
| `sources/localDb.ts` | OP/self-hosted source: `docker exec <container> psql` join `trades→orders→app_data`, filter `appCode∈{ophis,greg}` and window → `Swap[]`. | docker, psql |
| `sources/onchain.ts` | Hosted source: chunked `getLogs(Trade)` (≤2k blocks/call, retry+backoff) → viem `decodeEventLog` → dedup `orderUid` → rate-limited `getOrder` resolve → keep Ophis appCodes, window-filter by `creationDate` → `Swap[]`. | viem, `cow/client.ts` |
| `enrich.ts` | Token `symbol`/`decimals` (token-list first, on-chain `erc20` fallback) + `notionalUsd` via `pricer.ts` `nativePrice`. | `pricer.ts`, `cow/client.ts` |
| `report.ts` | Terminal table, JSON artifact `scan-<iso>.json`, Telegram summary string. | `telegram/alerter.ts` |
| `cli.ts` (extend) | New subcommand: `pnpm cli scan --since 48h [--chains a,b] [--telegram] [--json <path>]`. | all of the above |
| `cache.ts` | Persistent `orderUid → appCode\|null` cache (small JSON/sqlite file) so re-runs over overlapping windows skip re-resolving. | fs |

## 6. Data model

```ts
interface Swap {
  chainId: number;
  chainName: string;
  tsUtc: string;            // ISO; order creationDate (settlement is near-instant)
  orderUid: `0x${string}`;
  txHash: `0x${string}` | null;
  owner: `0x${string}`;     // on-chain owner (eth-flow router for native-ETH sells)
  receiver: `0x${string}`;  // the actual recipient (the user, for eth-flow)
  sell: { token: `0x${string}`; symbol: string | null; decimals: number | null; amount: string };
  buy:  { token: `0x${string}`; symbol: string | null; decimals: number | null; amount: string };
  appCode: 'ophis' | 'greg';
  refCode: string | null;   // metadata.ophisReferrer.code, grammar-validated
  feeBps: number | null;    // partnerFee.volumeBps from appData
  notionalUsd: number | null;
}
```

## 7. Data flow

1. Parse `--since` → UTC cutoff `T0`.
2. For each covered chain (in parallel, isolated):
   - **local-db:** `docker exec` psql query for trades with `creation_timestamp >= T0` and Ophis appCode.
   - **rpc:** binary-search `fromBlock` at `T0`; chunked `getLogs(Trade)` `fromBlock..head`; decode;
     dedup orderUids; for each uncached uid call `getOrder`; keep Ophis appCodes; filter by `creationDate >= T0`.
3. Enrich each `Swap`: token symbol/decimals + `notionalUsd`.
4. Merge all chains' `Swap[]`, sort by `tsUtc` desc.
5. Render: terminal table + write JSON artifact + (if `--telegram`) DM summary.
6. Print a `coverage` block: per chain `{status: ok|degraded, fills_scanned, ophis_found, unresolved, error?}`.

## 8. Error handling & coverage honesty

- **Per-chain isolation:** a chain's RPC/API failure degrades only that chain; the run still
  reports the others and flags the gap. Never a silent partial (per our "no silent caps" rule).
- `getOrder` 404 (order aged out of CoW's DB) → counted as `unresolved`, surfaced in coverage, not dropped silently.
- `nativePrice` 404 (thin token) → `notionalUsd: null`; the swap is still listed.
- `getLogs` range/size errors → halve the chunk and retry with backoff; if still failing, mark the chain degraded with the block range that failed.

## 9. Cost, scale, caching

Discovery sees **every** CoW fill, not just Ophis ones (~2,880/48h on mainnet measured). A cold 48h
mainnet run therefore issues ~3k `getOrder` calls (free CoW API) to find the Ophis subset — ~10 min
at a polite rate. Controls:
- Rate-limited concurrency on `getOrder` (reuse the client's bounded request pattern).
- Persistent `orderUid→appCode` cache: most uids are non-Ophis and never need re-resolving; re-runs
  over overlapping windows are near-free.

**Deferred v2 optimization (NOT in v1):** decode `settle()` calldata (`GPv2Trade.Data.appData`) to
read each trade's appData hash *without* an API call, resolving only unique candidate hashes. Cuts
hosted-chain API volume by ~100×. Add only if resolve-every-fill proves too slow.

## 10. Config & secrets

- RPC: Alchemy multi-chain (`https://<net>.g.alchemy.com/v2/<KEY>`) for mainnet/base/arbitrum/polygon/avalanche;
  key sourced from Keychain `alchemy-api-key` at runtime (never hardcoded, never logged).
- Telegram: reuse `telegram/alerter.ts` `notify()`; `TELEGRAM_BOT_TOKEN` from Keychain `ophis-telegram-bot`,
  `TELEGRAM_CHAT_ID=735726338` (Clement DM). Secrets are read into env at process start, never echoed.
- OP/self-hosted DB: `docker exec optimism-mainnet-db-1 psql -U ophis -d ophis` (runs on the Mac mini where docker lives).

## 11. Security considerations

- **Read-only by construction:** the scanner never writes to the rebate DB, so it can never enroll a
  wallet for payouts or alter the ledger. Report and money-movement stay separated.
- No secret ever reaches the transcript, the JSON artifact, or a command argument — keys are loaded
  from Keychain into the process environment only.
- appData is attacker-controllable: `refCode` is grammar-validated (`/^[a-z0-9_-]{3,64}$/`) exactly as
  the indexer does; `appCode` is checked against the fixed `APP_CODES` allowlist.

## 12. Testing (vitest, TDD)

- **Unit:** `--since` parsing; window→block binary search (mocked `getBlock`); `Trade` log decode
  (fixture log → fields); appCode filter; `Swap` normalization (incl. eth-flow owner≠receiver);
  USD math; report rendering; cache hit/miss.
- **Fixture-driven:** recorded `getLogs` + `getOrder` responses (incl. the real mainnet Ophis order
  `0xda3c…` and a non-Ophis CoW order) → expected `Swap[]`.
- **Coverage block:** assert degraded-chain reporting on a simulated RPC failure.

## 13. Future / complementary work

- v2 calldata decode (§9) for scale.
- Long-tail chain RPCs (Gnosis/BNB/Linea/Plasma/Ink).
- First-party order logging (frontend/SDK/widget/MCP emit `{orderUid, chain}` to a backend) as a
  cheaper, real-time complement to retroactive scanning — does not replace the scan (misses nothing
  is only guaranteed by the on-chain path).
- Optional cron wrapper to post a daily Telegram digest.
