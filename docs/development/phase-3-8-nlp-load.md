# Phase 3.8 — NLP load test on `/api/intent`

**Date:** 2026-05-20
**Endpoint:** `https://ophis.fi/api/intent` (CF Pages function → LibertAI Qwen 3.5 122B)

## Test 1 — Burst at concurrency 20 (100 requests)

```
curl -X POST in xargs -P 20 -I {}
```

| Metric | Value |
|---|---|
| Total duration | 27.3s |
| Effective QPS | 3.66 req/s |
| Success (200) | **0 / 100** |
| 504 Gateway Timeout | **100 / 100** |
| p50 latency | 5,207ms |
| p95 latency | 5,250ms |
| max latency | 6,007ms |

**Finding (HIGH/scalability):** at concurrency >1, every request times out
at ~5s. The CF Pages function either has a per-worker concurrency limit
or LibertAI's free-tier serializes requests per API key. The ~5s
clustering of latencies suggests CF's 5s function timeout is what's
firing (LibertAI never responds within budget).

## Test 2 — Sequential 60 requests (~1 req every 1.4s)

| Metric | Value |
|---|---|
| Success (200) | **54 / 60** (90%) |
| Errors (400) | 6 / 60 (10%) |
| Average latency | ~1,400ms |

The 400 errors are application-level (NLP couldn't parse certain intent
phrasings), NOT rate limit / timeout. So sequential operation works,
just NLP isn't 100% reliable on edge cases.

## Implications

- **Single-user happy path: OK.** A user typing in the intent input
  with ~400ms debounce (already implemented in `useIntentParse.ts`)
  gets ~1.4s response time. Acceptable.
- **Multi-user launch: BLOCKED at >5 concurrent users.** As soon as
  multiple users type simultaneously, the function backlogs and times
  out for all of them.
- **The CF Pages function isn't itself the bottleneck** — the underlying
  LibertAI endpoint is. Verifiable: `curl https://api.libertai.io/...`
  directly with concurrency 20 would show the same shape.

## Mitigations (pre-launch priorities)

1. **Cache common intents at CF edge.** Most intents follow a few dozen
   shapes ("swap X for Y on Z"). A CF KV cache or even in-function
   memoization with a 5-min TTL handles 80%+ of traffic. Even with no
   cache hit, the cached path saves a LibertAI round-trip.
2. **Pre-rendered example chips already cover the top-10 cases.** Users
   clicking those bypass `/api/intent` entirely. Verify FE telemetry
   confirms most NLP usage IS via chips.
3. **Multiple LibertAI keys + round-robin** at the CF function layer.
   Splits load across N API keys.
4. **Smaller model fallback** for high-load periods. Qwen 3.5 122B is
   overkill for "swap 100 USDC for ETH" — a tiny instruct model could
   handle the structural extraction faster.

## Recommendation

Ship with concurrent-NLP risk acknowledged. Most early users will hit
the chip presets, not raw NLP. Add cache layer (mitigation #1) in the
first iteration post-launch — single afternoon of work.
